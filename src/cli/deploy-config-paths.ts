// Path: src/cli/deploy-config-paths.ts
// Pure resolution of a DeployConfig's LOCAL filesystem paths to absolute,
// against an optional config-level rootDir, with leading-~ expansion.
//
// Anchors ONLY: warPath (top-level + per-class), migration/postMigration
// migrationsDir + scaffoldingFile. NEVER touches healthCheck.path or
// haproxy.socketPath (remote/URL paths). See the rootDir design spec.

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { DeployConfig } from './types.js';

/** Expand a leading `~/` (or a bare `~`) to the home directory. Mid-path `~` is left alone. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + p.slice(1); // keep the '/'
  return p;
}

/**
 * Resolve one local path field to absolute:
 *  1. tilde-expand the value;
 *  2. if now absolute → use as-is (rootDir ignored);
 *  3. if relative → resolve against the tilde-expanded rootDir when set;
 *     if no rootDir, return the value as-is (validation is the gate that
 *     rejects a relative local path with no rootDir).
 * `undefined` value → `undefined` (absent optional field passthrough).
 */
export function resolveConfigPath(
  value: string | undefined,
  rootDir: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const v = expandTilde(value);
  if (isAbsolute(v)) return v;
  if (rootDir !== undefined && rootDir !== '') {
    return resolve(expandTilde(rootDir), v);
  }
  return v; // relative, no root — left as-is; validation rejects this upstream
}

/**
 * Return a NEW config with the 5 local path fields resolved to absolute.
 * Does not mutate the input. Non-local fields are shallow-copied through.
 *
 * `rootDir` is read defensively (not yet on the `DeployConfig` type — added in
 * Task 2) so this module compiles standalone ahead of that change.
 */
export function resolveConfigPaths(config: DeployConfig): DeployConfig {
  const root = (config as { rootDir?: string }).rootDir;
  const out: DeployConfig = { ...config };

  const war = resolveConfigPath(config.warPath, root);
  if (war !== undefined) out.warPath = war;

  if (config.migration) {
    out.migration = {
      ...config.migration,
      migrationsDir: resolveConfigPath(config.migration.migrationsDir, root)!,
    };
    const sf = resolveConfigPath(config.migration.scaffoldingFile, root);
    if (sf !== undefined) out.migration.scaffoldingFile = sf;
  }

  if (config.postMigration) {
    out.postMigration = {
      ...config.postMigration,
      migrationsDir: resolveConfigPath(config.postMigration.migrationsDir, root)!,
    };
    const sf = resolveConfigPath(config.postMigration.scaffoldingFile, root);
    if (sf !== undefined) out.postMigration.scaffoldingFile = sf;
  }

  if (Array.isArray(config.classes)) {
    out.classes = config.classes.map((c) => {
      const cw = resolveConfigPath(c.warPath, root);
      return cw !== undefined ? { ...c, warPath: cw } : { ...c };
    });
  }

  return out;
}
