// Path: src/secrets-handler.ts
// Secret handling utilities for Payara plugin

import type { Logger } from 'pino';
import type { PluginContext } from '@zincapp/zn-vault-agent/plugins';
import { access, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { basename, dirname } from 'node:path';
import path from 'node:path';
import { getErrorMessage } from './utils/error.js';
import { isSafeUnixAccountName } from './plugin-config.js';

export const DEFAULT_FILE_SOURCE_ROOT = '/etc/zn-agent/node/';
const execFileAsync = promisify(execFile);
const IDENTITY_LOOKUP_TIMEOUT_MS = 10_000;
const MAX_LOCAL_SECRET_BYTES = 64 * 1024;
const API_KEY_DIRECTORY_MODE = 0o2750;
const API_KEY_FILE_MODE = 0o640;

export class OperationDeadlineExceededError extends Error {
  override readonly name = 'PAYARA_OPERATION_DEADLINE_EXCEEDED';
}

/** Throw before starting another operation after an absolute monotonic deadline. */
export function assertOperationDeadline(
  deadlineMs: number | undefined,
  operation: string
): void {
  if (deadlineMs !== undefined && performance.now() >= deadlineMs) {
    throw new OperationDeadlineExceededError(`${operation} exceeded its deadline`);
  }
}

function remainingOperationTime(
  deadlineMs: number | undefined,
  operation: string,
  maximumMs: number
): number {
  assertOperationDeadline(deadlineMs, operation);
  if (deadlineMs === undefined) {
    return maximumMs;
  }
  return Math.max(1, Math.min(maximumMs, Math.ceil(deadlineMs - performance.now())));
}

async function readFileWithDeadline(
  filePath: string,
  deadlineMs: number | undefined,
  operation: string
): Promise<string> {
  if (deadlineMs === undefined) {
    return readFile(filePath, 'utf8');
  }

  const controller = new AbortController();
  let deadlineExpired = false;
  const timeout = setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
  }, remainingOperationTime(deadlineMs, operation, Number.MAX_SAFE_INTEGER));
  timeout.unref?.();

  try {
    return await readFile(filePath, { encoding: 'utf8', signal: controller.signal });
  } catch (err) {
    if (deadlineExpired) {
      throw new OperationDeadlineExceededError(`${operation} exceeded its deadline`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function readLocalSecretFile(
  filePath: string,
  root: string,
  deadlineMs: number | undefined,
  operation: string
): Promise<string> {
  assertOperationDeadline(deadlineMs, operation);
  const canonicalRoot = await realpath(root);
  assertOperationDeadline(deadlineMs, operation);

  // O_NONBLOCK makes opening a FIFO return immediately; fstat below then
  // rejects it before any read. O_NOFOLLOW closes the final-component symlink
  // race. The canonical fd/path check also rejects intermediate symlink escape.
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonBlock = fsConstants.O_NONBLOCK ?? 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow | nonBlock);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile()
      || stats.nlink !== 1
      || stats.size > MAX_LOCAL_SECRET_BYTES
    ) {
      throw new Error('Local secret source must be one bounded regular file');
    }

    let canonicalTarget: string;
    try {
      canonicalTarget = process.platform === 'linux'
        ? await realpath(`/proc/self/fd/${handle.fd}`)
        : await realpath(filePath);
    } catch {
      // Non-Linux test hosts may not expose a resolvable fd path. The opened
      // final component is still O_NOFOLLOW; this fallback validates all
      // intermediate components against the canonical allowlist root.
      canonicalTarget = await realpath(filePath);
    }
    const rootPrefix = canonicalRoot.endsWith(path.sep)
      ? canonicalRoot
      : canonicalRoot + path.sep;
    if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(rootPrefix)) {
      throw new Error('Local secret source resolves outside fileSourceRoot');
    }

    const controller = new AbortController();
    let deadlineExpired = false;
    const timeoutMs = remainingOperationTime(
      deadlineMs,
      operation,
      Number.MAX_SAFE_INTEGER
    );
    const timeout = deadlineMs === undefined
      ? undefined
      : setTimeout(() => {
          deadlineExpired = true;
          controller.abort();
        }, timeoutMs);
    timeout?.unref?.();
    try {
      const contents = await handle.readFile({ encoding: 'utf8', signal: controller.signal });
      const finalStats = await handle.stat();
      if (
        !finalStats.isFile()
        || finalStats.nlink !== 1
        || finalStats.size > MAX_LOCAL_SECRET_BYTES
        || Buffer.byteLength(contents) > MAX_LOCAL_SECRET_BYTES
      ) {
        throw new Error('Local secret source changed or exceeded its size bound during read');
      }
      return contents;
    } catch (err) {
      if (deadlineExpired) {
        throw new OperationDeadlineExceededError(`${operation} exceeded its deadline`);
      }
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    await handle.close();
  }
}

async function getSecretWithDeadline(
  ctx: PluginContext,
  reference: string,
  deadlineMs: number | undefined
): ReturnType<PluginContext['getSecret']> {
  if (deadlineMs === undefined) {
    return ctx.getSecret(reference);
  }

  const operation = `Secret read for ${reference}`;
  const remainingMs = remainingOperationTime(
    deadlineMs,
    operation,
    Number.MAX_SAFE_INTEGER
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new OperationDeadlineExceededError(`${operation} exceeded its deadline`));
    }, remainingMs);
    timeout.unref?.();

    void ctx.getSecret(reference).then(
      value => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        }
      },
      err => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      }
    );
  });
}

export interface PosixIdentity {
  uid: number;
  primaryGid: number;
  gids: readonly number[];
}

export interface PosixInodePermissions {
  uid: number;
  gid: number;
  mode: number;
}

/**
 * Deterministic two-identity model for the Agent writer and Payara reader.
 * The directory is setgid but not group-writable; the key is owner-writable
 * and group-readable. Any mismatch is a startup/event failure, never a warning.
 */
export function assertApiKeyPermissionContract(
  directory: PosixInodePermissions,
  file: PosixInodePermissions,
  writer: PosixIdentity,
  payara: PosixIdentity
): void {
  const violations: string[] = [];
  const directoryMode = directory.mode & 0o7777;
  const fileMode = file.mode & 0o7777;

  if (writer.uid !== 0 && directory.uid !== writer.uid) {
    violations.push('API key directory is not owned by the Agent writer');
  }
  if (directory.gid !== payara.primaryGid) {
    violations.push('API key directory group is not Payara primary group');
  }
  if (directoryMode !== API_KEY_DIRECTORY_MODE) {
    violations.push('API key directory mode must be exactly 2750');
  }
  if (writer.uid !== 0 && !writer.gids.includes(payara.primaryGid)) {
    violations.push('Agent process is not a member of the Payara primary group');
  }
  if (!payara.gids.includes(directory.gid)) {
    violations.push('Payara identity cannot traverse the API key directory group');
  }
  if (file.uid !== writer.uid) {
    violations.push('API key file is not owned by the Agent writer');
  }
  if (file.gid !== payara.primaryGid || file.gid !== directory.gid) {
    violations.push('API key file did not inherit the Payara directory group');
  }
  if (fileMode !== API_KEY_FILE_MODE) {
    violations.push('API key file mode must be exactly 0640');
  }
  if (!payara.gids.includes(file.gid)) {
    violations.push('Payara identity cannot read the API key file group');
  }

  if (violations.length > 0) {
    throw new Error(`PAYARA_API_KEY_PERMISSION_CONTRACT: ${violations.join('; ')}`);
  }
}

async function readIdentityNumber(
  flag: '-u' | '-g',
  payaraUser: string,
  deadlineMs: number | undefined
): Promise<number> {
  const operation = `Unix identity lookup for ${payaraUser}`;
  const timeout = remainingOperationTime(
    deadlineMs,
    operation,
    IDENTITY_LOOKUP_TIMEOUT_MS
  );
  const { stdout } = await execFileAsync('id', [flag, payaraUser], {
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
  });
  assertOperationDeadline(deadlineMs, operation);
  const value = Number.parseInt(stdout.trim(), 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Could not resolve Unix identity for ${payaraUser}`);
  }
  return value;
}

async function resolveUnixIdentity(
  payaraUser: string,
  deadlineMs: number | undefined
): Promise<PosixIdentity> {
  const uid = await readIdentityNumber('-u', payaraUser, deadlineMs);
  const primaryGid = await readIdentityNumber('-g', payaraUser, deadlineMs);
  const operation = `Unix group lookup for ${payaraUser}`;
  const timeout = remainingOperationTime(
    deadlineMs,
    operation,
    IDENTITY_LOOKUP_TIMEOUT_MS
  );
  const { stdout } = await execFileAsync('id', ['-G', payaraUser], {
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
  });
  assertOperationDeadline(deadlineMs, operation);
  const gids = stdout.trim().split(/\s+/).filter(Boolean).map(value =>
    Number.parseInt(value, 10)
  );
  if (
    gids.length === 0
    || gids.some(gid => !Number.isSafeInteger(gid) || gid < 0)
    || !gids.includes(primaryGid)
  ) {
    throw new Error(`Could not resolve Unix groups for ${payaraUser}`);
  }
  return { uid, primaryGid, gids };
}

function currentProcessIdentity(): PosixIdentity {
  const uid = process.getuid?.();
  const primaryGid = process.getgid?.();
  const processGroups = process.getgroups?.();
  if (uid === undefined || primaryGid === undefined || processGroups === undefined) {
    throw new Error('PAYARA_API_KEY_PERMISSION_CONTRACT: POSIX identities are required');
  }
  return {
    uid,
    primaryGid,
    gids: [...new Set([primaryGid, ...processGroups])],
  };
}

function identityCanExecute(
  inode: PosixInodePermissions,
  identity: PosixIdentity
): boolean {
  if (identity.uid === 0) return true;
  if (identity.uid === inode.uid) return (inode.mode & 0o100) !== 0;
  if (identity.gids.includes(inode.gid)) return (inode.mode & 0o010) !== 0;
  return (inode.mode & 0o001) !== 0;
}

async function assertDirectoryTraversal(
  directory: string,
  payara: PosixIdentity,
  deadlineMs: number | undefined
): Promise<void> {
  let current = path.resolve(directory);
  while (true) {
    assertOperationDeadline(deadlineMs, `Payara path traversal check for ${directory}`);
    const state = await stat(current);
    if (!state.isDirectory() || !identityCanExecute(state, payara)) {
      throw new Error(
        `PAYARA_API_KEY_PERMISSION_CONTRACT: Payara cannot traverse ${current}`
      );
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertReadableAsPayara(
  filePath: string,
  payaraUser: string,
  writer: PosixIdentity,
  payara: PosixIdentity,
  deadlineMs: number | undefined
): Promise<void> {
  const operation = `Payara API key readability check for ${filePath}`;
  if (writer.uid === payara.uid) {
    await access(filePath, fsConstants.R_OK);
    assertOperationDeadline(deadlineMs, operation);
    return;
  }

  const timeout = remainingOperationTime(
    deadlineMs,
    operation,
    IDENTITY_LOOKUP_TIMEOUT_MS
  );
  try {
    // The shell program is fixed and receives the pathname as a positional
    // argument. No key bytes enter argv, stdout, stderr, or the environment.
    await execFileAsync(
      'sudo',
      [
        '-n',
        '-u',
        payaraUser,
        '/usr/bin/bash',
        '-c',
        'test -r "$1"',
        'znvault-payara-key-readability',
        filePath,
      ],
      { timeout, killSignal: 'SIGKILL' }
    );
    assertOperationDeadline(deadlineMs, operation);
  } catch (err) {
    throw new Error(
      `PAYARA_API_KEY_PERMISSION_CONTRACT: Payara cannot read the prepared key inode: ` +
      getErrorMessage(err)
    );
  }
}

/**
 * Resolve `raw` to an absolute path that is guaranteed to live under `root`.
 * Returns null if the resolved path escapes the root (via `..`, absolute path,
 * or normalization). This is the security boundary for the `file:` secret source:
 * a compromised shared host-template cannot point `file:` at an arbitrary node file.
 */
export function resolveUnderRoot(raw: string, root: string): string | null {
  const normalizedRoot = path.resolve(root);
  const candidate = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(normalizedRoot, raw);
  // Must equal the root or sit beneath it (with a separator boundary).
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  if (candidate === normalizedRoot || candidate.startsWith(rootWithSep)) {
    return candidate;
  }
  return null;
}

/**
 * Extract string value from SecretValue data
 * Handles field extraction for paths like "alias:db/creds.password"
 *
 * IMPORTANT: Never returns the literal string "undefined" - throws if value is missing
 */
export function extractSecretValue(
  data: Record<string, unknown>,
  field?: string
): string {
  if (field) {
    // Extract specific field from data
    const fieldValue = data[field];
    if (fieldValue === undefined || fieldValue === null) {
      throw new Error(`Field '${field}' not found in secret data (available fields: ${Object.keys(data).join(', ')})`);
    }
    const strValue = String(fieldValue);
    if (strValue === 'undefined' || strValue === 'null') {
      throw new Error(`Field '${field}' has invalid value: ${strValue}`);
    }
    return strValue;
  }

  // No field specified - try common patterns
  // 1. If data has a 'value' field, use it (common for simple secrets and API keys)
  if ('value' in data && data.value !== undefined && data.value !== null) {
    const strValue = String(data.value);
    if (strValue === 'undefined' || strValue === 'null') {
      throw new Error(`Secret 'value' field has invalid value: ${strValue}`);
    }
    return strValue;
  }

  // 2. If data has only one key, use that value
  const keys = Object.keys(data);
  if (keys.length === 1) {
    const key = keys[0]!;
    const value = data[key];
    if (value === undefined || value === null) {
      throw new Error(`Secret field '${key}' is undefined or null`);
    }
    const strValue = String(value);
    if (strValue === 'undefined' || strValue === 'null') {
      throw new Error(`Secret field '${key}' has invalid value: ${strValue}`);
    }
    return strValue;
  }

  // 3. Otherwise, stringify the whole object
  return JSON.stringify(data);
}

/**
 * Verify the API key file contains the expected key.
 * Returns true if file exists and matches, false otherwise.
 */
export async function verifyApiKeyFile(
  filePath: string,
  expectedKey: string,
  logger: Logger,
  deadlineMs?: number
): Promise<{ valid: boolean; fileKey?: string; error?: string }> {
  try {
    const fileContent = await readFileWithDeadline(
      filePath,
      deadlineMs,
      `API key verification for ${filePath}`
    );
    const fileKey = fileContent.trim();

    if (fileKey === expectedKey) {
      return { valid: true, fileKey };
    } else {
      // Log only lengths. Even an API-key prefix is credential material.
      logger.error({
        path: filePath,
        expectedLength: expectedKey.length,
        fileLength: fileKey.length,
      }, 'CRITICAL: API key file MISMATCH - file contains different key than agent');
      return { valid: false, fileKey, error: 'Key mismatch' };
    }
  } catch (err) {
    if (err instanceof OperationDeadlineExceededError) {
      throw err;
    }
    const error = getErrorMessage(err);
    logger.error({ path: filePath, err }, 'Failed to read API key file for verification');
    return { valid: false, error };
  }
}

/**
 * Write API key to a file (for file-based API key mode).
 *
 * Contract: Agent owns the directory/file; Payara's primary group owns the
 * group slot. The setgid 2750 directory makes every atomic replacement inherit
 * that group, while 0640 leaves Payara read-only. Setup adds the Agent to the
 * Payara group and the systemd drop-in supplies it to the running service.
 * CRITICAL: Includes read-back verification to ensure write succeeded.
 */
export async function writeApiKeyToFile(
  filePath: string,
  apiKey: string,
  logger: Logger,
  payaraUser?: string,
  deadlineMs?: number
): Promise<void> {
  if (!payaraUser) {
    throw new Error(
      'PAYARA_API_KEY_PERMISSION_CONTRACT: Payara Unix account is required'
    );
  }
  if (!isSafeUnixAccountName(payaraUser)) {
    throw new Error('Invalid Payara Unix account name for API key ownership');
  }

  const writerIdentity = currentProcessIdentity();
  let payaraIdentity: PosixIdentity;
  try {
    payaraIdentity = await resolveUnixIdentity(payaraUser, deadlineMs);
  } catch (err) {
    if (err instanceof OperationDeadlineExceededError) throw err;
    throw new Error(
      `PAYARA_API_KEY_PERMISSION_CONTRACT: cannot resolve Payara Unix account ${payaraUser}: ` +
      getErrorMessage(err)
    );
  }

  const directory = dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;

  try {
    assertOperationDeadline(deadlineMs, `API key replacement for ${filePath}`);
    // Ensure the leaf exists, then operate on a no-follow directory descriptor.
    // Intermediate parents are validated separately for Payara traversal.
    await mkdir(directory, { recursive: true, mode: API_KEY_DIRECTORY_MODE });
    assertOperationDeadline(deadlineMs, `API key directory creation for ${filePath}`);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const directoryOnly = fsConstants.O_DIRECTORY ?? 0;
    const directoryHandle = await open(
      directory,
      fsConstants.O_RDONLY | noFollow | directoryOnly
    );
    let directoryPermissions: PosixInodePermissions;
    try {
      const initialDirectoryState = await directoryHandle.stat();
      if (!initialDirectoryState.isDirectory()) {
        throw new Error('PAYARA_API_KEY_PERMISSION_CONTRACT: target parent is not a directory');
      }
      if (
        writerIdentity.uid !== 0
        && initialDirectoryState.uid !== writerIdentity.uid
      ) {
        throw new Error(
          'PAYARA_API_KEY_PERMISSION_CONTRACT: API key directory must be owned by the Agent'
        );
      }
      if (
        writerIdentity.uid !== 0
        && !writerIdentity.gids.includes(payaraIdentity.primaryGid)
      ) {
        throw new Error(
          'PAYARA_API_KEY_PERMISSION_CONTRACT: Agent process is not in the Payara primary group; ' +
          'rerun zn-vault-agent setup and restart the Agent service'
        );
      }
      if (initialDirectoryState.gid !== payaraIdentity.primaryGid) {
        await directoryHandle.chown(
          initialDirectoryState.uid,
          payaraIdentity.primaryGid
        );
      }
      await directoryHandle.chmod(API_KEY_DIRECTORY_MODE);
      const finalDirectoryState = await directoryHandle.stat();
      directoryPermissions = finalDirectoryState;
      await assertDirectoryTraversal(directory, payaraIdentity, deadlineMs);

      // Prepare the complete replacement inode before it becomes visible.
      assertOperationDeadline(deadlineMs, `API key temporary file creation for ${filePath}`);
      temporaryHandle = await open(temporaryPath, 'wx', 0o600);
      await temporaryHandle.writeFile(apiKey, { encoding: 'utf8' });
      assertOperationDeadline(deadlineMs, `API key temporary write for ${filePath}`);
      const initialFileState = await temporaryHandle.stat();
      if (!initialFileState.isFile() || initialFileState.nlink !== 1) {
        throw new Error(
          'PAYARA_API_KEY_PERMISSION_CONTRACT: temporary key is not one regular inode'
        );
      }
      if (initialFileState.gid !== payaraIdentity.primaryGid) {
        await temporaryHandle.chown(initialFileState.uid, payaraIdentity.primaryGid);
      }
      await temporaryHandle.chmod(API_KEY_FILE_MODE);
      const finalTemporaryState = await temporaryHandle.stat();
      assertApiKeyPermissionContract(
        directoryPermissions,
        finalTemporaryState,
        writerIdentity,
        payaraIdentity
      );
      await temporaryHandle.sync();
      assertOperationDeadline(deadlineMs, `API key temporary fsync for ${filePath}`);
      await assertReadableAsPayara(
        temporaryPath,
        payaraUser,
        writerIdentity,
        payaraIdentity,
        deadlineMs
      );
      await temporaryHandle.close();
      temporaryHandle = undefined;

      // Same-directory rename is atomic: readers see either the old complete key
      // or the new complete key, never a partially written value.
      assertOperationDeadline(deadlineMs, `API key atomic rename for ${filePath}`);
      await rename(temporaryPath, filePath);
      renamed = true;
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }

    const finalHandle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    try {
      const finalState = await finalHandle.stat();
      if (!finalState.isFile() || finalState.nlink !== 1) {
        throw new Error(
          'PAYARA_API_KEY_PERMISSION_CONTRACT: final key is not one regular inode'
        );
      }
      assertApiKeyPermissionContract(
        directoryPermissions,
        finalState,
        writerIdentity,
        payaraIdentity
      );
      assertOperationDeadline(deadlineMs, `API key read-back for ${filePath}`);
      const writtenKey = await finalHandle.readFile({ encoding: 'utf8' });
      assertOperationDeadline(deadlineMs, `API key read-back for ${filePath}`);
      if (writtenKey !== apiKey) {
        throw new Error('Write verification failed: API key content mismatch');
      }
    } finally {
      await finalHandle.close();
    }
    assertOperationDeadline(deadlineMs, `API key directory fsync for ${filePath}`);

    logger.info({ path: filePath }, 'API key written and verified');
  } catch (err) {
    logger.error({ path: filePath, err }, 'Failed to write API key to file');
    if (err instanceof OperationDeadlineExceededError) {
      throw err;
    }
    throw new Error(`Failed to write API key to ${filePath}: ${getErrorMessage(err)}`);
  } finally {
    if (temporaryHandle) {
      await temporaryHandle.close().catch(() => undefined);
    }
    if (!renamed) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Fetch secrets from vault and return as environment variables
 * When apiKeyFilePath is set, API keys are written to that file instead of
 * being included in the returned env vars.
 */
export async function fetchSecrets(
  ctx: PluginContext,
  secretsConfig: Record<string, string>,
  logger: Logger,
  apiKeyFilePath?: string,
  payaraUser?: string,
  fileSourceRoot?: string,
  deadlineMs?: number
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  let apiKeyToWrite: string | undefined;

  for (const [envVar, source] of Object.entries(secretsConfig)) {
    try {
      assertOperationDeadline(deadlineMs, `Secret resolution for ${envVar}`);
      let value: string;

      if (source.startsWith('literal:')) {
        // Literal value (not recommended for secrets)
        value = source.substring('literal:'.length);
      } else if (source.startsWith('api-key:')) {
        // Fetch managed API key value from agent config
        // The managed key is bound by the agent and stored in ctx.config.auth.apiKey
        const keyName = source.substring('api-key:'.length);
        // Support both local config (managedKey.name) and config-from-vault (managedKeyName)
        const configuredKeyName = ctx.config.managedKey?.name ?? (ctx.config as { managedKeyName?: string }).managedKeyName;

        if (configuredKeyName && configuredKeyName === keyName) {
          // Use the current API key from auth config (managed key value)
          if (!ctx.config.auth?.apiKey) {
            throw new Error(`Managed API key '${keyName}' not yet bound`);
          }
          value = ctx.config.auth.apiKey;
          logger.debug({ keyName }, 'Using managed API key from agent config');

          // If file-based API key is enabled, write to file instead of env var
          if (apiKeyFilePath) {
            if (apiKeyToWrite !== undefined && apiKeyToWrite !== value) {
              throw new Error('Configured managed API key sources resolved to different values');
            }
            apiKeyToWrite = value;
            // Defer the only write until every secret read has succeeded. A
            // later Vault timeout therefore cannot leave a partially refreshed
            // environment or key file.
            logger.debug(
              { envVar, filePath: apiKeyFilePath },
              'API key resolved for deferred atomic file update'
            );
            continue;
          }
        } else {
          throw new Error(`API key '${keyName}' not configured as managed key (expected: ${configuredKeyName || 'none'})`);
        }
      } else if (source.startsWith('alias:')) {
        // Fetch secret by alias (may include .field for JSON extraction)
        // Parse "alias:path/to/secret.field" format
        const aliasPath = source.substring('alias:'.length);
        const dotIndex = aliasPath.lastIndexOf('.');

        // Check if there's a field extraction (but not for paths like "api.staging.db")
        // A field must be at the end and the base must exist
        let basePath = aliasPath;
        let field: string | undefined;

        if (dotIndex > 0) {
          const potentialField = aliasPath.substring(dotIndex + 1);
          // Only treat as field if it doesn't contain slashes (not a path component)
          if (!potentialField.includes('/')) {
            basePath = aliasPath.substring(0, dotIndex);
            field = potentialField;
          }
        }

        const secretValue = await getSecretWithDeadline(
          ctx,
          `alias:${basePath}`,
          deadlineMs
        );
        value = extractSecretValue(secretValue.data, field);
      } else if (source.startsWith('file:')) {
        // Read a local node file; omit the env var on any failure so the app
        // can fall back to its own default (missing/unreadable/empty/outside-root).
        const raw = source.substring('file:'.length);
        const root = fileSourceRoot ?? DEFAULT_FILE_SOURCE_ROOT;
        const resolved = resolveUnderRoot(raw, root);
        if (resolved === null) {
          logger.warn(`file: source '${raw}' is outside fileSourceRoot — omitting ${envVar}`);
          continue; // OMIT (outside allowlist root)
        }
        let fileContents: string;
        try {
          fileContents = (await readLocalSecretFile(
            resolved,
            root,
            deadlineMs,
            `Local secret read for ${envVar}`
          )).trim();
        } catch (err) {
          if (err instanceof OperationDeadlineExceededError) {
            throw err;
          }
          logger.info(`file: source '${resolved}' not readable — omitting ${envVar} (app default applies)`);
          continue; // OMIT (missing/unreadable)
        }
        if (fileContents === '') {
          continue; // OMIT (empty ≠ a meaningful value)
        }
        value = fileContents;
      } else {
        // Default: treat as alias
        const secretValue = await getSecretWithDeadline(
          ctx,
          `alias:${source}`,
          deadlineMs
        );
        value = extractSecretValue(secretValue.data);
      }

      env[envVar] = value;
      logger.debug({ envVar, source: source.replace(/:.+/, ':***') }, 'Secret loaded');
    } catch (err) {
      logger.error({ envVar, source: source.replace(/:.+/, ':***'), err }, 'Failed to fetch secret');
      if (err instanceof OperationDeadlineExceededError) {
        throw err;
      }
      throw new Error(`Failed to fetch secret for ${envVar}: ${getErrorMessage(err)}`);
    }
  }

  if (apiKeyToWrite !== undefined && apiKeyFilePath) {
    await writeApiKeyToFile(
      apiKeyFilePath,
      apiKeyToWrite,
      logger,
      payaraUser,
      deadlineMs
    );
  }

  return env;
}
