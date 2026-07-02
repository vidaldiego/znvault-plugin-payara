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
  registerTLSCommands,
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
      // Top-level per-deployer group (v2.0.0). Future deployers register their own
      // top-level group as peers of `payara`.
      const payara = program
        .command('payara')
        .description('Payara application-server deployment & management');

      // ── deploy verb group: run / to / war ──
      const deploy = payara
        .command('deploy')
        .description('Deploy WAR files to Payara servers');
      registerDeployRunCommand(deploy, ctx);   // run <cfg> (+ 'to' alias)
      registerDeployWarCommand(deploy, ctx);   // war <file>

      // ── config management (peer) ──
      const configCmd = payara
        .command('config')
        .description('Manage deployment configurations');
      registerConfigCommands(configCmd, ctx);

      // ── lifecycle (peers): restart / status / applications ──
      registerLifecycleCommands(payara, ctx);

      // ── tls (peer) ──
      registerTLSCommands(payara, ctx);
    },
  };
}

// Default export for CLI plugin
export default createPayaraCLIPlugin;
