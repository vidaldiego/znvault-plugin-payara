// Path: src/cli/commands/deploy-config.ts
// Deploy config management commands

import type { Command } from 'commander';
import type { CLIPluginContext, DeployConfig } from '../types.js';
import { loadDeployConfigs, saveDeployConfigs } from '../config-store.js';
import { ANSI, parsePort } from '../constants.js';
import { getConfigOrExit, confirmPrompt, withErrorHandling } from './helpers.js';

/**
 * Register deploy config commands
 */
export function registerConfigCommands(
  configCmd: Command,
  ctx: CLIPluginContext
): void {
  // deploy config create <name>
  configCmd
    .command('create <name>')
    .description('Create a new deployment configuration')
    .option('-w, --war <path>', 'Path to WAR file')
    .option('-h, --hosts <hosts>', 'Comma-separated list of hosts')
    .option('-p, --port <port>', 'Agent port (default: 9100)', '9100')
    .option('--parallel', 'Deploy to hosts in parallel')
    .option('-d, --description <desc>', 'Configuration description')
    .action(async (name: string, options: {
      war?: string;
      hosts?: string;
      port: string;
      parallel?: boolean;
      description?: string;
    }) => {
      await withErrorHandling(ctx, async () => {
        const store = await loadDeployConfigs();

        if (store.configs[name]) {
          ctx.output.error(`Config '${name}' already exists`);
          process.exit(1);
        }

        const config: DeployConfig = {
          name,
          hosts: options.hosts ? options.hosts.split(',').map(h => h.trim()) : [],
          warPath: options.war ?? '',
          port: parsePort(options.port),
          parallel: options.parallel ?? false,
          description: options.description,
        };

        store.configs[name] = config;
        await saveDeployConfigs(store);

        ctx.output.success(`Created deployment config: ${name}`);
        if (config.hosts.length > 0) {
          ctx.output.info(`  Hosts: ${config.hosts.join(', ')}`);
        }
        if (config.warPath) {
          ctx.output.info(`  WAR: ${config.warPath}`);
        }
      }, 'Failed to create config');
    });

  // deploy config list
  configCmd
    .command('list')
    .alias('ls')
    .description('List all deployment configurations')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      await withErrorHandling(ctx, async () => {
        const store = await loadDeployConfigs();
        const configs = Object.values(store.configs);

        if (configs.length === 0) {
          if (options.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            ctx.output.info('No deployment configurations found.');
            ctx.output.info('Create one with: znvault deploy config create <name>');
          }
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(configs, null, 2));
          return;
        }

        console.log('\nDeployment Configurations:\n');
        for (const config of configs) {
          console.log(`  ${ANSI.bold}${config.name}${ANSI.reset}`);
          if (config.description) {
            console.log(`    ${ANSI.dim}${config.description}${ANSI.reset}`);
          }
          console.log(`    Hosts: ${config.hosts.length > 0 ? config.hosts.join(', ') : ANSI.dim + '(none)' + ANSI.reset}`);
          console.log(`    WAR:   ${config.warPath || ANSI.dim + '(not set)' + ANSI.reset}`);
          const displayStrategy = config.strategy ?? (config.parallel ? 'parallel' : 'sequential');
          console.log(`    Strategy: ${displayStrategy}`);
          console.log();
        }
      }, 'Failed to list configs');
    });

  // deploy config show <name>
  configCmd
    .command('show <name>')
    .description('Show deployment configuration details')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      await withErrorHandling(ctx, async () => {
        const { config } = await getConfigOrExit(ctx, name);

        if (options.json) {
          console.log(JSON.stringify(config, null, 2));
          return;
        }

        console.log(`\n${ANSI.bold}Deployment Config: ${config.name}${ANSI.reset}\n`);
        if (config.description) {
          console.log(`  Description: ${config.description}`);
        }
        console.log(`  WAR Path:    ${config.warPath || ANSI.dim + '(not set)' + ANSI.reset}`);
        console.log(`  Port:        ${config.port}`);
        // Display strategy (prefer explicit strategy over legacy parallel flag)
        const displayStrategy = config.strategy ?? (config.parallel ? 'parallel' : 'sequential');
        console.log(`  Strategy:    ${displayStrategy}`);
        console.log(`\n  Hosts (${config.hosts.length}):`);
        if (config.hosts.length === 0) {
          console.log(`    ${ANSI.dim}(none)${ANSI.reset}`);
        } else {
          for (const host of config.hosts) {
            console.log(`    - ${host}`);
          }
        }
        console.log();
      }, 'Failed to show config');
    });

  // deploy config delete <name>
  configCmd
    .command('delete <name>')
    .alias('rm')
    .description('Delete a deployment configuration')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (name: string, options: { yes?: boolean }) => {
      await withErrorHandling(ctx, async () => {
        const store = await loadDeployConfigs();

        if (!store.configs[name]) {
          ctx.output.error(`Config '${name}' not found`);
          process.exit(1);
        }

        if (!options.yes) {
          const confirmed = await confirmPrompt(`Delete deployment config '${name}'?`, false);
          if (!confirmed) {
            ctx.output.info('Cancelled');
            return;
          }
        }

        delete store.configs[name];
        await saveDeployConfigs(store);

        ctx.output.success(`Deleted config: ${name}`);
      }, 'Failed to delete config');
    });

  // deploy config add-host <name> <host>
  configCmd
    .command('add-host <name> <host>')
    .description('Add a host to deployment configuration')
    .action(async (name: string, host: string) => {
      await withErrorHandling(ctx, async () => {
        const { store, config } = await getConfigOrExit(ctx, name);

        if (config.hosts.includes(host)) {
          ctx.output.warn(`Host '${host}' already in config`);
          return;
        }

        config.hosts.push(host);
        await saveDeployConfigs(store);

        ctx.output.success(`Added host: ${host}`);
        ctx.output.info(`Config '${name}' now has ${config.hosts.length} host(s)`);
      }, 'Failed to add host');
    });

  // deploy config remove-host <name> <host>
  configCmd
    .command('remove-host <name> <host>')
    .description('Remove a host from deployment configuration')
    .action(async (name: string, host: string) => {
      await withErrorHandling(ctx, async () => {
        const { store, config } = await getConfigOrExit(ctx, name);

        const index = config.hosts.indexOf(host);
        if (index === -1) {
          ctx.output.error(`Host '${host}' not found in config`);
          process.exit(1);
        }

        config.hosts.splice(index, 1);
        await saveDeployConfigs(store);

        ctx.output.success(`Removed host: ${host}`);
        ctx.output.info(`Config '${name}' now has ${config.hosts.length} host(s)`);
      }, 'Failed to remove host');
    });

  // deploy config set <name> <key> <value>
  configCmd
    .command('set <name> <key> <value>')
    .description('Set a configuration value (war, port, strategy, parallel, description)')
    .action(async (name: string, key: string, value: string) => {
      await withErrorHandling(ctx, async () => {
        const { store, config } = await getConfigOrExit(ctx, name);

        switch (key.toLowerCase()) {
          case 'war':
          case 'warpath':
            config.warPath = value;
            break;
          case 'port':
            config.port = parsePort(value);
            break;
          case 'strategy':
            // Validate strategy format
            if (!['sequential', 'parallel'].includes(value.toLowerCase()) && !value.includes('+')) {
              ctx.output.error(`Invalid strategy: ${value}`);
              ctx.output.info('Use: sequential, parallel, or canary format (1+R, 1+2, 2+3+R)');
              process.exit(1);
            }
            config.strategy = value;
            break;
          case 'parallel':
            config.parallel = value.toLowerCase() === 'true' || value === '1';
            break;
          case 'description':
          case 'desc':
            config.description = value;
            break;
          default:
            ctx.output.error(`Unknown config key: ${key}`);
            ctx.output.info('Valid keys: war, port, strategy, parallel, description');
            process.exit(1);
        }

        await saveDeployConfigs(store);
        ctx.output.success(`Set ${key} = ${value}`);
      }, 'Failed to set config');
    });
}
