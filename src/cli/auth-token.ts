// Path: src/cli/auth-token.ts
// Resolve and validate the local Payara namespace credential file.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { loadMutationAuthTokenFile } from '../mutation-auth.js';

function expandHome(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return join(homedir(), filePath.slice(2));
  return filePath;
}

export function resolveMutationAuthTokenFile(
  filePath: string,
  rootDir?: string
): string {
  const expanded = expandHome(filePath);
  if (isAbsolute(expanded)) return expanded;
  const base = rootDir ? expandHome(rootDir) : process.cwd();
  return resolve(base, expanded);
}

export function loadCliMutationAuthToken(
  filePath: string | undefined,
  rootDir?: string
): string {
  if (!filePath?.trim()) {
    throw new Error(
      'Payara credential file is required; set mutationAuthTokenFile in the ' +
      'deploy config or pass --mutation-auth-token-file <path>'
    );
  }
  return loadMutationAuthTokenFile(
    resolveMutationAuthTokenFile(filePath.trim(), rootDir)
  );
}

export interface HostMutationAuthConfig {
  rootDir?: string;
  mutationAuthTokenFile?: string;
  mutationAuthTokenFiles?: Record<string, string>;
}

/**
 * Load every selected host credential before contacting the protected Payara
 * namespace. Per-host paths are the normal setup (tokens are independently
 * generated); the singular path is an explicit fleet-shared fallback.
 */
export function loadHostMutationAuthTokens(
  config: HostMutationAuthConfig,
  hosts: readonly string[],
  overrideFilePath?: string
): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  const tokensByPath = new Map<string, string>();
  for (const host of hosts) {
    const configuredPath = overrideFilePath
      ?? config.mutationAuthTokenFiles?.[host]
      ?? config.mutationAuthTokenFile;
    if (!configuredPath?.trim()) {
      throw new Error(
        `Payara credential file is required for host '${host}'; configure ` +
        `mutationAuthTokenFiles.${host} or pass --mutation-auth-token-file <path>`
      );
    }
    const resolvedPath = resolveMutationAuthTokenFile(
      configuredPath.trim(),
      overrideFilePath ? undefined : config.rootDir
    );
    let token = tokensByPath.get(resolvedPath);
    if (!token) {
      token = loadMutationAuthTokenFile(resolvedPath);
      tokensByPath.set(resolvedPath, token);
    }
    tokens.set(host, token);
  }
  return tokens;
}
