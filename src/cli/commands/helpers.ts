// Path: src/cli/commands/helpers.ts
// Common utilities for CLI commands

import type { CLIPluginContext, DeployConfig, DeployConfigStore } from '../types.js';
import { loadDeployConfigs, saveDeployConfigs } from '../config-store.js';
import { getErrorMessage } from '../../utils/error.js';

/**
 * Exit with an error message
 */
export function exitWithError(ctx: CLIPluginContext, message: string, code = 1): never {
  ctx.output.error(message);
  process.exit(code);
}

/**
 * Load config store and get a specific config, exiting if not found
 */
export async function getConfigOrExit(
  ctx: CLIPluginContext,
  name: string
): Promise<{ store: DeployConfigStore; config: DeployConfig }> {
  const store = await loadDeployConfigs();
  const config = store.configs[name];

  if (!config) {
    ctx.output.error(`Config '${name}' not found`);
    ctx.output.info('Use "znvault deploy config list" to see available configs');
    process.exit(1);
  }

  return { store, config };
}

/**
 * Execute an async operation with standardized error handling
 */
export async function withErrorHandling<T>(
  ctx: CLIPluginContext,
  operation: () => Promise<T>,
  errorPrefix: string
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    ctx.output.error(`${errorPrefix}: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

/**
 * Load inquirer dynamically (it's a peer dependency from znvault-cli)
 */
export async function loadInquirer(): Promise<typeof import('inquirer').default> {
  const m = await import('inquirer');
  return m.default;
}

/**
 * Prompt for confirmation
 */
export async function confirmPrompt(message: string, defaultValue = false): Promise<boolean> {
  const inquirer = await loadInquirer();
  const answers = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message,
    default: defaultValue,
  }]) as { confirm: boolean };
  return answers.confirm;
}

/**
 * Save config store with error handling
 */
export async function saveConfigsOrExit(
  ctx: CLIPluginContext,
  store: DeployConfigStore,
  errorPrefix = 'Failed to save config'
): Promise<void> {
  return withErrorHandling(ctx, () => saveDeployConfigs(store), errorPrefix);
}
