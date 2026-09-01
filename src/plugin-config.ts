// Path: src/plugin-config.ts
// Plugin configuration validation

import type { PayaraPluginConfig } from './types.js';
import { isAbsolute } from 'node:path';
import {
  hasControlCharacters,
  SAFE_PAYARA_IDENTIFIER_PATTERN,
  validatePayaraIdentifier,
} from './payara-env.js';

/**
 * Validation result for plugin configuration
 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
}

/** Linux account names accepted for sudo/chown boundaries. */
export function isSafeUnixAccountName(value: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,30}\$?$/.test(value);
}

/**
 * Validate required plugin configuration fields
 */
export function validatePluginConfig(config: PayaraPluginConfig): ConfigValidationResult {
  const errors: string[] = [];

  if (!config.payaraHome) {
    errors.push('Payara plugin: payaraHome is required');
  } else if (!isAbsolute(config.payaraHome) || hasControlCharacters(config.payaraHome)) {
    errors.push('Payara plugin: payaraHome must be an absolute filesystem path');
  }
  if (!config.domain) {
    errors.push('Payara plugin: domain is required');
  } else if (!SAFE_PAYARA_IDENTIFIER_PATTERN.test(config.domain)) {
    errors.push(
      `Payara plugin: domain must match ${SAFE_PAYARA_IDENTIFIER_PATTERN.source}`
    );
  }
  if (!config.user) {
    errors.push('Payara plugin: user is required');
  } else if (!isSafeUnixAccountName(config.user)) {
    errors.push(
      'Payara plugin: user must be a valid lowercase Unix account name'
    );
  }
  if (!config.warPath) {
    errors.push('Payara plugin: warPath is required');
  } else if (!isAbsolute(config.warPath) || hasControlCharacters(config.warPath)) {
    errors.push('Payara plugin: warPath must be an absolute filesystem path');
  }
  if (!config.appName) {
    errors.push('Payara plugin: appName is required');
  } else {
    try {
      validatePayaraIdentifier(config.appName, 'Payara plugin: appName');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (
    config.contextRoot !== undefined
    && (
      !config.contextRoot.startsWith('/')
      || /\s/u.test(config.contextRoot)
      || hasControlCharacters(config.contextRoot)
    )
  ) {
    errors.push(
      'Payara plugin: contextRoot must start with / and contain no whitespace or control characters'
    );
  }
  if (
    config.passwordFile !== undefined
    && (
      !config.passwordFile
      || !isAbsolute(config.passwordFile)
      || hasControlCharacters(config.passwordFile)
    )
  ) {
    errors.push('Payara plugin: passwordFile must be an absolute filesystem path');
  }
  if (
    config.mutationAuthTokenFile !== undefined
    && (
      !config.mutationAuthTokenFile.trim()
      || !isAbsolute(config.mutationAuthTokenFile)
    )
  ) {
    errors.push(
      'Payara plugin: mutationAuthTokenFile must be an absolute filesystem path'
    );
  }
  if (config.manageLifecycle === false) {
    errors.push(
      'Payara plugin: manageLifecycle=false is unsupported because agent exec ' +
      'events do not identify the detached Payara DAS safely'
    );
  }
  if (config.restartOnCertChange === true) {
    errors.push(
      'Payara plugin: restartOnCertChange=true is unsupported because agent event hooks ' +
      'cannot safely await or cancel a Payara restart'
    );
  }
  if (config.restartOnKeyRotation === true) {
    errors.push(
      'Payara plugin: restartOnKeyRotation=true is unsupported; managed keys ' +
      'must use apiKeyFilePath for atomic zero-restart rotation'
    );
  }
  if (config.watchSecrets && config.watchSecrets.length > 0) {
    errors.push(
      'Payara plugin: watchSecrets is unsupported because event hooks cannot safely ' +
      'apply setenv changes to an already-running Payara JVM'
    );
  }
  if (hasApiKeySecrets(config) && !config.apiKeyFilePath) {
    errors.push(
      'Payara plugin: apiKeyFilePath is required when using api-key secrets; ' +
      'event-driven Payara restarts are unsupported'
    );
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

/** Reject any competing agent exec supervisor while this plugin owns Payara. */
export function assertNoCompetingPayaraExec(
  _config: PayaraPluginConfig,
  command: readonly string[] | undefined,
  reloadCommands: readonly (string | undefined)[] = []
): void {
  if (command && command.length > 0) {
    throw new Error(
      'Payara plugin: agent exec must be disabled while the Payara plugin is enabled; ' +
      'only one process and lifecycle controller is allowed'
    );
  }
  if (reloadCommands.some(commandValue => Boolean(commandValue?.trim()))) {
    throw new Error(
      'Payara plugin: agent global, certificate-target, and secret-target reloadCmd ' +
      'must all be disabled; reload hooks run outside the Payara deployment lock'
    );
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
