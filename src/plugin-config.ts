// Path: src/plugin-config.ts
// Plugin configuration validation

import type { PayaraPluginConfig } from './types.js';

/**
 * Validation result for plugin configuration
 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate required plugin configuration fields
 */
export function validatePluginConfig(config: PayaraPluginConfig): ConfigValidationResult {
  const errors: string[] = [];

  if (!config.payaraHome) {
    errors.push('Payara plugin: payaraHome is required');
  }
  if (!config.domain) {
    errors.push('Payara plugin: domain is required');
  }
  if (!config.user) {
    errors.push('Payara plugin: user is required');
  }
  if (!config.warPath) {
    errors.push('Payara plugin: warPath is required');
  }
  if (!config.appName) {
    errors.push('Payara plugin: appName is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Throw an error if config is invalid
 */
export function assertValidConfig(config: PayaraPluginConfig): void {
  const result = validatePluginConfig(config);
  if (!result.valid) {
    throw new Error(result.errors[0]);
  }
}

/**
 * Check if config has secrets defined
 */
export function hasSecrets(config: PayaraPluginConfig): boolean {
  return Boolean(config.secrets && Object.keys(config.secrets).length > 0);
}

/**
 * Check if config has API key secrets
 */
export function hasApiKeySecrets(config: PayaraPluginConfig): boolean {
  return Boolean(
    config.secrets &&
    Object.values(config.secrets).some(s => s.startsWith('api-key:'))
  );
}

/**
 * Check if lifecycle management is enabled
 */
export function isLifecycleManaged(config: PayaraPluginConfig): boolean {
  return config.manageLifecycle !== false;
}

/**
 * Get startup mode based on config
 */
export type StartupMode = 'exec' | 'aggressive' | 'normal';

export function getStartupMode(config: PayaraPluginConfig): StartupMode {
  if (!isLifecycleManaged(config)) {
    return 'exec';
  }
  if (config.aggressiveMode) {
    return 'aggressive';
  }
  return 'normal';
}
