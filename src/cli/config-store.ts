// Path: src/cli/config-store.ts
// Deployment configuration storage

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { DeployConfig, DeployConfigStore } from './types.js';
import { CONFIG_DIR, CONFIG_FILE } from './constants.js';

/**
 * Load deployment configs from file
 */
export async function loadDeployConfigs(): Promise<DeployConfigStore> {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = await readFile(CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Ignore parse errors
  }
  return { configs: {} };
}

/**
 * Save deployment configs to file
 */
export async function saveDeployConfigs(store: DeployConfigStore): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
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
