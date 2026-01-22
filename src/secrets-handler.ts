// Path: src/secrets-handler.ts
// Secret handling utilities for Payara plugin

import type { Logger } from 'pino';
import type { PluginContext } from '@zincapp/zn-vault-agent/plugins';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { getErrorMessage } from './utils/error.js';

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
  logger: Logger
): Promise<{ valid: boolean; fileKey?: string; error?: string }> {
  try {
    const fileContent = await readFile(filePath, 'utf-8');
    const fileKey = fileContent.trim();

    if (fileKey === expectedKey) {
      return { valid: true, fileKey };
    } else {
      logger.error({
        path: filePath,
        expectedPrefix: expectedKey.substring(0, 20),
        filePrefix: fileKey.substring(0, 20),
      }, 'CRITICAL: API key file MISMATCH - file contains different key than agent');
      return { valid: false, fileKey, error: 'Key mismatch' };
    }
  } catch (err) {
    const error = getErrorMessage(err);
    logger.error({ path: filePath, err }, 'Failed to read API key file for verification');
    return { valid: false, error };
  }
}

/**
 * Write API key to a file (for file-based API key mode)
 * File is owned by root but readable by the payara group.
 * CRITICAL: Includes read-back verification to ensure write succeeded.
 */
export async function writeApiKeyToFile(
  filePath: string,
  apiKey: string,
  logger: Logger,
  payaraUser?: string
): Promise<void> {
  const { chmod } = await import('node:fs/promises');

  try {
    // Ensure directory exists with group-accessible permissions
    await mkdir(dirname(filePath), { recursive: true, mode: 0o750 });
    // Write key
    await writeFile(filePath, apiKey);
    // Explicitly set permissions (writeFile mode option is affected by umask)
    await chmod(filePath, 0o640);

    // Change ownership so payara group can read the file
    if (process.getuid?.() === 0 && payaraUser) {
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);
      try {
        // Set group ownership to payara user's group
        await execAsync(`chown root:${payaraUser} "${dirname(filePath)}"`);
        await execAsync(`chown root:${payaraUser} "${filePath}"`);
        logger.debug({ path: filePath, group: payaraUser }, 'Set file group ownership');
      } catch (chownErr) {
        logger.warn({ path: filePath, err: chownErr }, 'Failed to chown API key file');
      }
    }

    // CRITICAL: Verify the write succeeded by reading back
    const verification = await verifyApiKeyFile(filePath, apiKey, logger);
    if (!verification.valid) {
      throw new Error(`Write verification failed: ${verification.error}`);
    }

    logger.info({ path: filePath }, 'API key written and verified');
  } catch (err) {
    logger.error({ path: filePath, err }, 'Failed to write API key to file');
    throw new Error(`Failed to write API key to ${filePath}: ${getErrorMessage(err)}`);
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
  payaraUser?: string
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const [envVar, source] of Object.entries(secretsConfig)) {
    try {
      let value: string;

      if (source.startsWith('literal:')) {
        // Literal value (not recommended for secrets)
        value = source.substring('literal:'.length);
      } else if (source.startsWith('api-key:')) {
        // Fetch managed API key value from agent config
        // The managed key is bound by the agent and stored in ctx.config.auth.apiKey
        const keyName = source.substring('api-key:'.length);
        const configuredKeyName = ctx.config.managedKey?.name;

        if (configuredKeyName && configuredKeyName === keyName) {
          // Use the current API key from auth config (managed key value)
          if (!ctx.config.auth?.apiKey) {
            throw new Error(`Managed API key '${keyName}' not yet bound`);
          }
          value = ctx.config.auth.apiKey;
          logger.debug({ keyName }, 'Using managed API key from agent config');

          // If file-based API key is enabled, write to file instead of env var
          if (apiKeyFilePath) {
            await writeApiKeyToFile(apiKeyFilePath, value, logger, payaraUser);
            // Don't add to env - Payara reads from the file via ZINC_CONFIG_VAULT_API_KEY_FILE
            logger.debug({ envVar, filePath: apiKeyFilePath }, 'API key written to file instead of env var');
            continue; // Skip adding to env
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

        const secretValue = await ctx.getSecret(`alias:${basePath}`);
        value = extractSecretValue(secretValue.data, field);
      } else {
        // Default: treat as alias
        const secretValue = await ctx.getSecret(`alias:${source}`);
        value = extractSecretValue(secretValue.data);
      }

      env[envVar] = value;
      logger.debug({ envVar, source: source.replace(/:.+/, ':***') }, 'Secret loaded');
    } catch (err) {
      logger.error({ envVar, source: source.replace(/:.+/, ':***'), err }, 'Failed to fetch secret');
      throw new Error(`Failed to fetch secret for ${envVar}: ${getErrorMessage(err)}`);
    }
  }

  return env;
}
