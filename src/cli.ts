// Path: src/cli.ts
// CLI commands for Payara plugin with visual progress

import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CLIPluginContext, CLIPlugin } from './cli/types.js';
import {
  registerConfigCommands,
  registerLifecycleCommands,
  registerDeployRunCommand,
  registerDeployWarCommand,
} from './cli/commands/index.js';

// Read version from package.json at module load time
let pluginVersion = '0.0.0';
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Navigate up from dist/ to find package.json
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pluginVersion = pkg.version || '0.0.0';
} catch {
  // Fallback - this shouldn't happen in normal operation
  pluginVersion = '0.0.0';
}

// Re-export CLIPlugin for consumers
export type { CLIPlugin } from './cli/types.js';

/**
 * Payara CLI plugin
 *
 * Adds deploy commands to znvault CLI
 */
export function createPayaraCLIPlugin(): CLIPlugin {
  return {
    name: 'payara',
    version: pluginVersion,
    description: 'Payara WAR deployment commands with visual progress',

    registerCommands(program: Command, ctx: CLIPluginContext): void {
      // Create deploy command group
      const deploy = program
        .command('deploy')
        .description('Deploy WAR files to remote Payara servers');

      // deploy run <configName> - Multi-host deployment using saved configurations
      registerDeployRunCommand(deploy, ctx);

      // deploy config - Manage deployment configurations
      const configCmd = deploy
        .command('config')
        .description('Manage deployment configurations');
      registerConfigCommands(configCmd, ctx);

      // deploy war <file> - Single-host deployment
      registerDeployWarCommand(deploy, ctx);

      // deploy restart, status, applications
      registerLifecycleCommands(deploy, ctx);
    },
  };
}

// Default export for CLI plugin
export default createPayaraCLIPlugin;
