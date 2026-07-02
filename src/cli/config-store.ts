// Path: src/cli/config-store.ts
// Deployment configuration storage

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { DeployConfig, DeployConfigStore } from './types.js';
import { PAYARA_CONFIG_DIR, CONFIG_FILE, LEGACY_CONFIG_FILE } from './constants.js';

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
