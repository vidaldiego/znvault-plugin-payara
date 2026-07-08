// Path: src/cli/config-store.ts
// Deployment configuration storage — payara-specific shim over
// @zincapp/znvault-deploy-core's target-agnostic config-store.
//
// Why this stays a local reimplementation rather than a pure delegation:
// deploy-core's `loadDeployConfigs`/`saveDeployConfigs` work with a FLAT
// `Record<string, DeployConfig>` file body (`JSON.parse(content)` as-is —
// no wrapper). Payara's real on-disk `configs.json` (hand-edited by
// operators — see README "Authoring multi-class configs") has ALWAYS been
// the WRAPPED `DeployConfigStore` shape: `{ "configs": { name: {...} } }`,
// optionally with `vaultEnabled`/`vaultAlias` alongside `configs`. Pointing
// deploy-core's file reader directly at that file would parse `"configs"`
// as if it were itself a config NAME — silently corrupting every existing
// prod config file. So the wrapper-aware file I/O below is kept local
// (byte-identical to the pre-Task-5 implementation); only the exported
// function SIGNATURES match payara's original zero-arg, throw-on-miss API
// so the ~70 existing call sites are untouched. `getConfig`/`configExists`/
// `listConfigNames` are composed from `loadDeployConfigs()` exactly as
// before (deploy-core's versions of those three take the same flat-file
// assumption as its `loadDeployConfigs` and so have the same incompatibility
// with payara's wrapped file).
//
// `@zincapp/znvault-deploy-core`'s `ConfigStoreLocation` type is imported
// for documentation/consistency even though its I/O functions aren't used
// here directly.

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { DeployConfig, DeployConfigStore } from './types.js';
import { PAYARA_CONFIG_DIR, CONFIG_FILE, LEGACY_CONFIG_FILE } from './constants.js';
import type { ConfigStoreLocation } from '@zincapp/znvault-deploy-core';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertLocationShapeCompatible = ConfigStoreLocation extends {
  configFile: string;
  legacyConfigFile?: string;
  configDir: string;
} ? true : never;

/**
 * One-time, non-destructive migration from the pre-v2 shared config location
 * (~/.znvault/deploy-configs.json) to the per-deployer file
 * (~/.znvault/payara/configs.json). Runs only when the new file is absent and the
 * legacy file exists. The legacy file is left intact as a backup. Never throws —
 * a migration failure must not make an existing config unusable.
 */
async function migrateLegacyConfigIfNeeded(): Promise<void> {
  if (existsSync(CONFIG_FILE) || !existsSync(LEGACY_CONFIG_FILE)) return;
  try {
    await mkdir(PAYARA_CONFIG_DIR, { recursive: true });
    await copyFile(LEGACY_CONFIG_FILE, CONFIG_FILE);
    // Notice to stderr, not stdout — keep machine-readable output clean.
    console.error(`[payara] Migrated deploy configs to ${CONFIG_FILE} (legacy ${LEGACY_CONFIG_FILE} kept as backup).`);
  } catch (err) {
    console.error(`[payara] Warning: could not migrate legacy config (${(err as Error).message}); using legacy location.`);
  }
}

/**
 * Load deployment configs from file. Reads the new path; on first run migrates
 * the legacy file into place. Falls back to the legacy file if migration failed.
 */
export async function loadDeployConfigs(): Promise<DeployConfigStore> {
  await migrateLegacyConfigIfNeeded();
  // Prefer the new path; if migration failed and it's still absent, read legacy.
  const source = existsSync(CONFIG_FILE) ? CONFIG_FILE : LEGACY_CONFIG_FILE;
  try {
    if (existsSync(source)) {
      const content = await readFile(source, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Ignore parse errors
  }
  return { configs: {} };
}

/**
 * Save deployment configs to the new per-deployer path.
 */
export async function saveDeployConfigs(store: DeployConfigStore): Promise<void> {
  if (!existsSync(PAYARA_CONFIG_DIR)) {
    await mkdir(PAYARA_CONFIG_DIR, { recursive: true });
  }
  await writeFile(CONFIG_FILE, JSON.stringify(store, null, 2));
}

/**
 * Get a config by name, or throw if not found
 */
export async function getConfig(name: string): Promise<DeployConfig> {
  const store = await loadDeployConfigs();
  const config = store.configs[name];
  if (!config) {
    throw new Error(`Config '${name}' not found`);
  }
  return config;
}

/**
 * Check if a config exists
 */
export async function configExists(name: string): Promise<boolean> {
  const store = await loadDeployConfigs();
  return name in store.configs;
}

/**
 * List all config names
 */
export async function listConfigNames(): Promise<string[]> {
  const store = await loadDeployConfigs();
  return Object.keys(store.configs);
}
