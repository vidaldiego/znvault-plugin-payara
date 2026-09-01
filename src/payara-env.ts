// Path: src/payara-env.ts
// Payara environment configuration utilities

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);
const SETENV_TERMINATION_GRACE_MS = 250;
const SETENV_STDERR_LIMIT_BYTES = 64 * 1024;

const ATOMIC_SETENV_AS_USER_SCRIPT = [
  'set -euo pipefail',
  'umask 027',
  'temp_path="$1"',
  'target_path="$2"',
  'config_dir="$3"',
  'trap \'/usr/bin/rm -f -- "$temp_path"\' EXIT',
  '/usr/bin/tee "$temp_path" >/dev/null',
  '/usr/bin/chmod 640 "$temp_path"',
  '/usr/bin/sync -f "$temp_path"',
  '/usr/bin/mv -f -- "$temp_path" "$target_path"',
  '/usr/bin/sync -f "$config_dir"',
  'trap - EXIT',
].join('; ');

/**
 * Execute a command with stdin input using spawn.
 * Safer than shell interpolation for passing content.
 */
async function execWithStdin(
  command: string,
  args: string[],
  stdin: string,
  deadlineMs?: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutMs = remainingDeadlineMs(deadlineMs, 'setenv helper process');
    const proc = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stderr = '';
    let stderrBytes = 0;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      if (proc.pid && process.platform !== 'win32') {
        try {
          process.kill(-proc.pid, signal);
          return;
        } catch {
          // Fall back to the direct child when a process group disappeared.
        }
      }
      proc.kill(signal);
    };
    const terminationGraceMs = timeoutMs === undefined
      ? 0
      : Math.min(SETENV_TERMINATION_GRACE_MS, Math.max(0, timeoutMs - 1));
    const runBudgetMs = timeoutMs === undefined
      ? undefined
      : Math.max(1, timeoutMs - terminationGraceMs);
    const timeout = runBudgetMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          terminate('SIGTERM');
          killTimer = setTimeout(
            () => terminate('SIGKILL'),
            terminationGraceMs
          );
        }, runBudgetMs);
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    };
    proc.stderr.on('data', (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= SETENV_STDERR_LIMIT_BYTES) {
        stderr += chunk.toString();
      }
    });

    proc.on('error', error => {
      cleanup();
      reject(error);
    });
    proc.on('close', (code) => {
      cleanup();
      if (timedOut) {
        reject(new Error('PLUGIN_OPERATION_DEADLINE_EXCEEDED: setenv helper process'));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });

    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

/** Pattern for a safe account name or explicit numeric UID. */
export const SAFE_USERNAME_PATTERN = /^(?:[a-zA-Z_][a-zA-Z0-9_-]*|[1-9][0-9]{0,9})$/;

/** Payara domain/application identifiers accepted at process boundaries. */
export const SAFE_PAYARA_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Pattern for environment variable names accepted by POSIX shells */
export const SAFE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate that a username is safe for shell commands.
 * @returns true if valid, false otherwise
 */
export function isValidUsername(username: string): boolean {
  return SAFE_USERNAME_PATTERN.test(username);
}

/** True for bytes that can forge logs or cannot be represented by execve. */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate an opaque filesystem argument. Shell metacharacters and spaces are
 * intentionally allowed because every caller passes the pathname as one argv
 * entry; only values Node cannot represent safely are rejected.
 */
export function validatePathArgument(value: string, context: string): void {
  if (!isAbsolute(value)) {
    throw new Error(`${context} must be an absolute path`);
  }
  if (hasControlCharacters(value)) {
    throw new Error(`${context} cannot contain control characters`);
  }
}

/** Validate a Payara identifier before it reaches filesystem or asadmin state. */
export function validatePayaraIdentifier(value: string, context: string): void {
  if (!SAFE_PAYARA_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `${context} must match ${SAFE_PAYARA_IDENTIFIER_PATTERN.source}`
    );
  }
}

/** Serialize a value as a shell literal without allowing expansion on source. */
function quoteShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Options for setenv.conf writer
 */
export interface SetenvWriterOptions {
  payaraHome: string;
  domain: string;
  user?: string;
  logger: Logger;
  /** Absolute performance.now()-based deadline for startup/event writes. */
  deadlineMs?: number;
}

function remainingDeadlineMs(
  deadlineMs: number | undefined,
  stage: string
): number | undefined {
  if (deadlineMs === undefined) return undefined;
  const remainingMs = Math.floor(deadlineMs - performance.now());
  if (remainingMs <= 0) {
    throw new Error(`PLUGIN_OPERATION_DEADLINE_EXCEEDED: before ${stage}`);
  }
  return remainingMs;
}

/**
 * Build the environment for a directly spawned Payara command.
 *
 * SECURITY: This method ONLY includes non-sensitive env vars (JAVA_HOME).
 * Secrets are written to setenv.conf file which Payara reads on JVM startup.
 * This prevents secrets from appearing in `ps aux`, logs, and error messages.
 *
 * Values are never converted to shell syntax. Metacharacters therefore remain
 * literal environment bytes, while NUL (which execve cannot represent) fails
 * before process creation.
 */
export function buildPayaraProcessEnv(): NodeJS.ProcessEnv {
  const javaHome = process.env.JAVA_HOME ?? '/usr/lib/jvm/java-21-openjdk-amd64';
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    JAVA_HOME: javaHome,
  };

  const effectiveJavaHome = environment.JAVA_HOME;
  if (!effectiveJavaHome || !isAbsolute(effectiveJavaHome)) {
    throw new Error('JAVA_HOME must be an absolute path');
  }
  if (
    effectiveJavaHome.includes('\0')
    || effectiveJavaHome.includes('\r')
    || effectiveJavaHome.includes('\n')
  ) {
    throw new Error('JAVA_HOME cannot contain NUL or newline characters');
  }

  return environment;
}

/**
 * Sanitize a string for logging by redacting potential secret values.
 * Redacts any quoted string longer than 8 characters.
 *
 * @param str - String to sanitize
 * @returns Sanitized string with secrets redacted
 */
export function sanitizeForLogging(str: string): string {
  return str.replace(/('|")[^'"]{8,}('|")/g, '"[REDACTED]"');
}

/**
 * Write environment variables to domain's setenv.conf.
 * This ensures the Payara JVM receives the env vars on startup.
 *
 * @param environment - Key-value pairs of environment variables
 * @param options - Writer options including paths and user
 */
export async function writeSetenvConf(
  environment: Record<string, string>,
  options: SetenvWriterOptions
): Promise<void> {
  const { payaraHome, domain, user, logger, deadlineMs } = options;

  validatePathArgument(payaraHome, 'payaraHome');
  validatePayaraIdentifier(domain, 'Payara domain');

  if (Object.keys(environment).length === 0) {
    logger.debug('No environment variables to write');
    return;
  }

  const configDir = join(payaraHome, 'glassfish', 'domains', domain, 'config');
  const setenvPath = join(configDir, 'setenv.conf');
  const tempPath = join(
    configDir,
    `.setenv.conf.${process.pid}.${randomUUID()}.tmp`
  );

  // Build setenv.conf content. Single-quoted shell literals preserve every
  // character when sourced; embedded single quotes use the standard '\''
  // sequence (end quote, escaped quote, resume quote).
  const lines: string[] = [
    '# Auto-generated by znvault-plugin-payara',
    '# DO NOT EDIT - this file is overwritten on agent restart',
    '',
  ];

  for (const [key, value] of Object.entries(environment)) {
    if (!SAFE_ENV_NAME_PATTERN.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    lines.push(`export ${key}=${quoteShellLiteral(value)}`);
  }

  const content = lines.join('\n') + '\n';

  logger.info({ path: setenvPath, count: Object.keys(environment).length }, 'Writing setenv.conf');

  const isRoot = process.getuid?.() === 0;

  if (isRoot) {
    try {
      remainingDeadlineMs(deadlineMs, 'setenv temporary write');
      await writeFile(tempPath, content, { mode: 0o640 });

      if (user) {
        if (!SAFE_USERNAME_PATTERN.test(user)) {
          throw new Error(`Invalid username format: ${user}`);
        }
        await execFileAsync(
          'chown',
          [`${user}:${user}`, tempPath],
          { timeout: remainingDeadlineMs(deadlineMs, 'setenv chown') }
        );
      }

      remainingDeadlineMs(deadlineMs, 'setenv fsync');
      const tempHandle = await open(tempPath, 'r');
      try {
        await tempHandle.sync();
      } finally {
        await tempHandle.close();
      }

      remainingDeadlineMs(deadlineMs, 'setenv rename');
      await rename(tempPath, setenvPath);
      const directoryHandle = await open(configDir, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await rm(tempPath, { force: true });
    }
  } else {
    // Production grants the agent a shell as the Payara user, not arbitrary
    // root mv/rm. Create, fsync, and rename in one fixed shell program while
    // keeping the file contents on stdin (and therefore out of argv/logs).
    try {
      validatePathArgument(setenvPath, 'setenv path');
      validatePathArgument(tempPath, 'temporary setenv path');
      validatePathArgument(configDir, 'domain config path');

      if (!user || !SAFE_USERNAME_PATTERN.test(user)) {
        throw new Error('A valid Payara user is required for atomic setenv.conf replacement');
      }

      await execWithStdin(
        'sudo',
        [
          '-u',
          user,
          '/usr/bin/bash',
          '-c',
          ATOMIC_SETENV_AS_USER_SCRIPT,
          'znvault-setenv',
          tempPath,
          setenvPath,
          configDir,
        ],
        content,
        deadlineMs
      );
    } catch (err) {
      logger.error({ err }, 'Failed to write setenv.conf with sudo');
      throw err;
    }
  }
}

/**
 * Get the path to the setenv.conf file for a domain
 *
 * @param payaraHome - Payara installation directory
 * @param domain - Domain name
 * @returns Full path to setenv.conf
 */
export function getSetenvPath(payaraHome: string, domain: string): string {
  return join(payaraHome, 'glassfish', 'domains', domain, 'config', 'setenv.conf');
}
