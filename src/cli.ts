// Path: src/cli.ts
// CLI commands for Payara plugin

import type { Command } from 'commander';
import { createHash } from 'node:crypto';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import AdmZip from 'adm-zip';
import type { WarFileHashes } from './types.js';

/**
 * CLI Plugin context interface
 * Matches the CLIPluginContext from znvault-cli
 */
interface CLIPluginContext {
  client: {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body: unknown): Promise<T>;
  };
  output: {
    success(message: string): void;
    error(message: string): void;
    warn(message: string): void;
    info(message: string): void;
    table(headers: string[], rows: unknown[][]): void;
    keyValue(data: Record<string, unknown>): void;
  };
  getConfig(): { url: string };
  isPlainMode(): boolean;
}

/**
 * CLI Plugin interface
 */
export interface CLIPlugin {
  name: string;
  version: string;
  description?: string;
  registerCommands(program: Command, ctx: CLIPluginContext): void;
}

/**
 * Deployment configuration
 */
interface DeployConfig {
  name: string;
  hosts: string[];
  warPath: string;
  port: number;
  parallel: boolean;
  description?: string;
}

interface DeployConfigStore {
  configs: Record<string, DeployConfig>;
}

// Config file path
const CONFIG_DIR = join(homedir(), '.znvault');
const CONFIG_FILE = join(CONFIG_DIR, 'deploy-configs.json');

/**
 * Load deployment configs
 */
async function loadDeployConfigs(): Promise<DeployConfigStore> {
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
 * Save deployment configs
 */
async function saveDeployConfigs(store: DeployConfigStore): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
  await writeFile(CONFIG_FILE, JSON.stringify(store, null, 2));
}

/**
 * Deploy to a single host
 */
async function deployToHost(
  ctx: CLIPluginContext,
  host: string,
  port: number,
  warPath: string,
  localHashes: WarFileHashes,
  force: boolean
): Promise<{ success: boolean; error?: string; filesChanged?: number; filesDeleted?: number }> {
  try {
    const baseUrl = host.replace(/\/$/, '');
    // Add protocol if missing
    const fullUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
    const pluginUrl = `${fullUrl}:${port}/plugins/payara`;

    // Get remote hashes
    let remoteHashes: WarFileHashes = {};
    if (!force) {
      try {
        const response = await ctx.client.get<{ hashes: WarFileHashes }>(
          `${pluginUrl}/hashes`
        );
        remoteHashes = response.hashes;
      } catch {
        // Full deployment if can't get hashes
      }
    }

    // Calculate diff
    const { changed, deleted } = calculateDiff(localHashes, remoteHashes);

    if (changed.length === 0 && deleted.length === 0) {
      return { success: true, filesChanged: 0, filesDeleted: 0 };
    }

    // Prepare files for upload
    const zip = new AdmZip(warPath);
    const files = changed.map(path => {
      const entry = zip.getEntry(path);
      if (!entry) {
        throw new Error(`Entry not found in WAR: ${path}`);
      }
      return {
        path,
        content: entry.getData().toString('base64'),
      };
    });

    // Deploy
    const deployResponse = await ctx.client.post<{
      status: string;
      filesChanged: number;
      filesDeleted: number;
      message?: string;
    }>(`${pluginUrl}/deploy`, {
      files,
      deletions: deleted,
    });

    if (deployResponse.status === 'deployed') {
      return {
        success: true,
        filesChanged: deployResponse.filesChanged,
        filesDeleted: deployResponse.filesDeleted,
      };
    } else {
      return { success: false, error: deployResponse.message };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Payara CLI plugin
 *
 * Adds deploy commands to znvault CLI
 */
export function createPayaraCLIPlugin(): CLIPlugin {
  return {
    name: 'payara',
    version: '1.1.0',
    description: 'Payara WAR deployment commands',

    registerCommands(program: Command, ctx: CLIPluginContext): void {
      // Create deploy command group
      const deploy = program
        .command('deploy')
        .description('Deploy WAR files to remote Payara servers');

      // ========================================================================
      // deploy <config-name> - Deploy using saved configuration
      // ========================================================================
      deploy
        .command('run <configName>')
        .alias('to')
        .description('Deploy WAR to all hosts in a saved configuration')
        .option('-f, --force', 'Force full deployment (no diff)')
        .option('--dry-run', 'Show what would be deployed without deploying')
        .option('--sequential', 'Deploy to hosts one at a time (override parallel setting)')
        .action(async (configName: string, options: {
          force?: boolean;
          dryRun?: boolean;
          sequential?: boolean;
        }) => {
          try {
            const store = await loadDeployConfigs();
            const config = store.configs[configName];

            if (!config) {
              ctx.output.error(`Deployment config '${configName}' not found`);
              ctx.output.info('Use "znvault deploy config list" to see available configs');
              process.exit(1);
            }

            if (config.hosts.length === 0) {
              ctx.output.error('No hosts configured for this deployment');
              ctx.output.info(`Use "znvault deploy config add-host ${configName} <host>" to add hosts`);
              process.exit(1);
            }

            // Resolve WAR path
            const warPath = resolve(config.warPath);
            try {
              await stat(warPath);
            } catch {
              ctx.output.error(`WAR file not found: ${warPath}`);
              process.exit(1);
            }

            ctx.output.info(`Deploying ${configName}`);
            ctx.output.info(`  WAR: ${warPath}`);
            ctx.output.info(`  Hosts: ${config.hosts.length}`);
            ctx.output.info(`  Mode: ${options.sequential || !config.parallel ? 'sequential' : 'parallel'}`);
            console.log();

            // Calculate local hashes once
            ctx.output.info('Analyzing WAR file...');
            const localHashes = await calculateWarHashes(warPath);
            ctx.output.info(`Found ${Object.keys(localHashes).length} files`);
            console.log();

            if (options.dryRun) {
              ctx.output.info('Dry run - checking each host:');
              for (const host of config.hosts) {
                console.log(`  - ${host}`);
              }
              return;
            }

            const results: Array<{ host: string; success: boolean; error?: string; changed?: number; deleted?: number }> = [];

            const deployToHostWrapper = async (host: string) => {
              ctx.output.info(`Deploying to ${host}...`);
              const result = await deployToHost(
                ctx,
                host,
                config.port,
                warPath,
                localHashes,
                options.force ?? false
              );
              results.push({
                host,
                success: result.success,
                error: result.error,
                changed: result.filesChanged,
                deleted: result.filesDeleted,
              });
              if (result.success) {
                ctx.output.success(`  ✓ ${host}: ${result.filesChanged} changed, ${result.filesDeleted} deleted`);
              } else {
                ctx.output.error(`  ✗ ${host}: ${result.error}`);
              }
            };

            if (options.sequential || !config.parallel) {
              // Sequential deployment
              for (const host of config.hosts) {
                await deployToHostWrapper(host);
              }
            } else {
              // Parallel deployment
              await Promise.all(config.hosts.map(deployToHostWrapper));
            }

            console.log();
            const successful = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;

            if (failed === 0) {
              ctx.output.success(`Deployment complete: ${successful}/${config.hosts.length} hosts successful`);
            } else {
              ctx.output.warn(`Deployment complete: ${successful}/${config.hosts.length} hosts successful, ${failed} failed`);
              process.exit(1);
            }
          } catch (err) {
            ctx.output.error(`Deployment failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // ========================================================================
      // deploy config - Manage deployment configurations
      // ========================================================================
      const configCmd = deploy
        .command('config')
        .description('Manage deployment configurations');

      // deploy config create <name>
      configCmd
        .command('create <name>')
        .description('Create a new deployment configuration')
        .option('-w, --war <path>', 'Path to WAR file')
        .option('-H, --host <host>', 'Add a host (can be used multiple times)', (val, arr: string[]) => [...arr, val], [])
        .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
        .option('--parallel', 'Deploy to all hosts in parallel (default)')
        .option('--sequential', 'Deploy to hosts one at a time')
        .option('-d, --description <text>', 'Description for this config')
        .action(async (name: string, options: {
          war?: string;
          host: string[];
          port: string;
          parallel?: boolean;
          sequential?: boolean;
          description?: string;
        }) => {
          try {
            const store = await loadDeployConfigs();

            if (store.configs[name]) {
              ctx.output.error(`Config '${name}' already exists. Use "znvault deploy config delete ${name}" first.`);
              process.exit(1);
            }

            const config: DeployConfig = {
              name,
              hosts: options.host,
              warPath: options.war ?? '',
              port: parseInt(options.port, 10),
              parallel: !options.sequential,
              description: options.description,
            };

            store.configs[name] = config;
            await saveDeployConfigs(store);

            ctx.output.success(`Created deployment config: ${name}`);

            if (config.hosts.length === 0) {
              ctx.output.info(`Add hosts with: znvault deploy config add-host ${name} <host>`);
            }
            if (!config.warPath) {
              ctx.output.info(`Set WAR path with: znvault deploy config set ${name} war /path/to/app.war`);
            }
          } catch (err) {
            ctx.output.error(`Failed to create config: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // deploy config list
      configCmd
        .command('list')
        .alias('ls')
        .description('List all deployment configurations')
        .option('--json', 'Output as JSON')
        .action(async (options: { json?: boolean }) => {
          try {
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

            console.log('Deployment Configurations:\n');
            for (const config of configs) {
              console.log(`  ${config.name}`);
              if (config.description) {
                console.log(`    ${config.description}`);
              }
              console.log(`    Hosts: ${config.hosts.length > 0 ? config.hosts.join(', ') : '(none)'}`);
              console.log(`    WAR:   ${config.warPath || '(not set)'}`);
              console.log(`    Mode:  ${config.parallel ? 'parallel' : 'sequential'}`);
              console.log();
            }
          } catch (err) {
            ctx.output.error(`Failed to list configs: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // deploy config show <name>
      configCmd
        .command('show <name>')
        .description('Show deployment configuration details')
        .option('--json', 'Output as JSON')
        .action(async (name: string, options: { json?: boolean }) => {
          try {
            const store = await loadDeployConfigs();
            const config = store.configs[name];

            if (!config) {
              ctx.output.error(`Config '${name}' not found`);
              process.exit(1);
            }

            if (options.json) {
              console.log(JSON.stringify(config, null, 2));
              return;
            }

            console.log(`\nDeployment Config: ${config.name}\n`);
            if (config.description) {
              console.log(`  Description: ${config.description}`);
            }
            console.log(`  WAR Path:    ${config.warPath || '(not set)'}`);
            console.log(`  Port:        ${config.port}`);
            console.log(`  Mode:        ${config.parallel ? 'parallel' : 'sequential'}`);
            console.log(`\n  Hosts (${config.hosts.length}):`);
            if (config.hosts.length === 0) {
              console.log('    (none)');
            } else {
              for (const host of config.hosts) {
                console.log(`    - ${host}`);
              }
            }
            console.log();
          } catch (err) {
            ctx.output.error(`Failed to show config: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // deploy config delete <name>
      configCmd
        .command('delete <name>')
        .alias('rm')
        .description('Delete a deployment configuration')
        .option('-y, --yes', 'Skip confirmation')
        .action(async (name: string, options: { yes?: boolean }) => {
          try {
            const store = await loadDeployConfigs();

            if (!store.configs[name]) {
              ctx.output.error(`Config '${name}' not found`);
              process.exit(1);
            }

            if (!options.yes) {
              // Dynamic import of inquirer (available from znvault-cli context)
              const inquirerModule = await import('inquirer');
              const inquirer = inquirerModule.default;
              const answers = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: `Delete deployment config '${name}'?`,
                default: false,
              }]) as { confirm: boolean };
              if (!answers.confirm) {
                ctx.output.info('Cancelled');
                return;
              }
            }

            delete store.configs[name];
            await saveDeployConfigs(store);

            ctx.output.success(`Deleted config: ${name}`);
          } catch (err) {
            ctx.output.error(`Failed to delete config: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // deploy config add-host <name> <host>
      configCmd
        .command('add-host <name> <host>')
        .description('Add a host to deployment configuration')
        .action(async (name: string, host: string) => {
          try {
            const store = await loadDeployConfigs();
            const config = store.configs[name];

            if (!config) {
              ctx.output.error(`Config '${name}' not found`);
              process.exit(1);
            }

            if (config.hosts.includes(host)) {
              ctx.output.warn(`Host '${host}' already in config`);
              return;
            }

            config.hosts.push(host);
            await saveDeployConfigs(store);

            ctx.output.success(`Added host: ${host}`);
            ctx.output.info(`Config '${name}' now has ${config.hosts.length} host(s)`);
          } catch (err) {
            ctx.output.error(`Failed to add host: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // deploy config remove-host <name> <host>
      configCmd
        .command('remove-host <name> <host>')
        .description('Remove a host from deployment configuration')
        .action(async (name: string, host: string) => {
          try {
            const store = await loadDeployConfigs();
            const config = store.configs[name];

            if (!config) {
              ctx.output.error(`Config '${name}' not found`);
              process.exit(1);
            }

            const index = config.hosts.indexOf(host);
            if (index === -1) {
              ctx.output.error(`Host '${host}' not found in config`);
              process.exit(1);
            }

            config.hosts.splice(index, 1);
            await saveDeployConfigs(store);

            ctx.output.success(`Removed host: ${host}`);
            ctx.output.info(`Config '${name}' now has ${config.hosts.length} host(s)`);
          } catch (err) {
            ctx.output.error(`Failed to remove host: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // deploy config set <name> <key> <value>
      configCmd
        .command('set <name> <key> <value>')
        .description('Set a configuration value (war, port, parallel, description)')
        .action(async (name: string, key: string, value: string) => {
          try {
            const store = await loadDeployConfigs();
            const config = store.configs[name];

            if (!config) {
              ctx.output.error(`Config '${name}' not found`);
              process.exit(1);
            }

            switch (key.toLowerCase()) {
              case 'war':
              case 'warpath':
                config.warPath = value;
                break;
              case 'port':
                config.port = parseInt(value, 10);
                if (isNaN(config.port)) {
                  ctx.output.error('Port must be a number');
                  process.exit(1);
                }
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
                ctx.output.info('Valid keys: war, port, parallel, description');
                process.exit(1);
            }

            await saveDeployConfigs(store);
            ctx.output.success(`Set ${key} = ${value}`);
          } catch (err) {
            ctx.output.error(`Failed to set config: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // ========================================================================
      // deploy war <file> - Original single-host deployment
      // ========================================================================
      deploy
        .command('war <warFile>')
        .description('Deploy WAR file using diff transfer (single host)')
        .option('-t, --target <host>', 'Target server URL (default: from profile)')
        .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
        .option('-f, --force', 'Force full deployment (no diff)')
        .option('--dry-run', 'Show what would be deployed without deploying')
        .action(async (warFile: string, options: {
          target?: string;
          port: string;
          force?: boolean;
          dryRun?: boolean;
        }) => {
          try {
            // Verify WAR file exists
            try {
              await stat(warFile);
            } catch {
              ctx.output.error(`WAR file not found: ${warFile}`);
              process.exit(1);
            }

            ctx.output.info(`Analyzing WAR file: ${warFile}`);

            // Calculate local hashes
            const localHashes = await calculateWarHashes(warFile);
            const fileCount = Object.keys(localHashes).length;
            ctx.output.info(`Found ${fileCount} files in WAR`);

            // Build target URL
            const target = options.target ?? ctx.getConfig().url;
            const baseUrl = target.replace(/\/$/, '');
            const pluginUrl = `${baseUrl}:${options.port}/plugins/payara`;

            // Get remote hashes
            let remoteHashes: WarFileHashes = {};
            if (!options.force) {
              try {
                const response = await ctx.client.get<{ hashes: WarFileHashes }>(
                  `${pluginUrl}/hashes`
                );
                remoteHashes = response.hashes;
              } catch {
                ctx.output.warn('Could not fetch remote hashes, doing full deployment');
              }
            }

            // Calculate diff
            const { changed, deleted } = calculateDiff(localHashes, remoteHashes);

            ctx.output.info(`Diff: ${changed.length} changed, ${deleted.length} deleted`);

            // Dry run - just show diff
            if (options.dryRun) {
              if (changed.length > 0) {
                ctx.output.info('\nFiles to update:');
                for (const file of changed.slice(0, 20)) {
                  console.log(`  + ${file}`);
                }
                if (changed.length > 20) {
                  console.log(`  ... and ${changed.length - 20} more`);
                }
              }

              if (deleted.length > 0) {
                ctx.output.info('\nFiles to delete:');
                for (const file of deleted.slice(0, 20)) {
                  console.log(`  - ${file}`);
                }
                if (deleted.length > 20) {
                  console.log(`  ... and ${deleted.length - 20} more`);
                }
              }

              if (changed.length === 0 && deleted.length === 0) {
                ctx.output.success('No changes to deploy');
              }
              return;
            }

            // No changes
            if (changed.length === 0 && deleted.length === 0) {
              ctx.output.success('No changes to deploy');
              return;
            }

            // Prepare files for upload
            ctx.output.info('Preparing files for deployment...');
            const zip = new AdmZip(warFile);
            const files = changed.map(path => {
              const entry = zip.getEntry(path);
              if (!entry) {
                throw new Error(`Entry not found in WAR: ${path}`);
              }
              return {
                path,
                content: entry.getData().toString('base64'),
              };
            });

            // Deploy
            ctx.output.info('Deploying changes...');
            const deployResponse = await ctx.client.post<{
              status: string;
              filesChanged: number;
              filesDeleted: number;
              message?: string;
            }>(`${pluginUrl}/deploy`, {
              files,
              deletions: deleted,
            });

            if (deployResponse.status === 'deployed') {
              ctx.output.success(
                `Deployed: ${deployResponse.filesChanged} files changed, ${deployResponse.filesDeleted} deleted`
              );
            } else {
              ctx.output.error(`Deployment failed: ${deployResponse.message}`);
              process.exit(1);
            }
          } catch (err) {
            ctx.output.error(`Deployment failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // ========================================================================
      // deploy restart
      // ========================================================================
      deploy
        .command('restart [configName]')
        .description('Restart Payara on remote server(s)')
        .option('-t, --target <host>', 'Target server URL (single host mode)')
        .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
        .action(async (configName: string | undefined, options: { target?: string; port: string }) => {
          try {
            if (configName) {
              // Multi-host restart using config
              const store = await loadDeployConfigs();
              const config = store.configs[configName];

              if (!config) {
                ctx.output.error(`Config '${configName}' not found`);
                process.exit(1);
              }

              ctx.output.info(`Restarting Payara on ${config.hosts.length} host(s)...`);

              for (const host of config.hosts) {
                const baseUrl = host.startsWith('http') ? host : `https://${host}`;
                const pluginUrl = `${baseUrl}:${config.port}/plugins/payara`;
                try {
                  await ctx.client.post(`${pluginUrl}/restart`, {});
                  ctx.output.success(`  ✓ ${host} restarted`);
                } catch (err) {
                  ctx.output.error(`  ✗ ${host}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            } else {
              // Single host restart
              const target = options.target ?? ctx.getConfig().url;
              const baseUrl = target.replace(/\/$/, '');
              const pluginUrl = `${baseUrl}:${options.port}/plugins/payara`;

              ctx.output.info('Restarting Payara...');
              await ctx.client.post(`${pluginUrl}/restart`, {});
              ctx.output.success('Payara restarted');
            }
          } catch (err) {
            ctx.output.error(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // ========================================================================
      // deploy status
      // ========================================================================
      deploy
        .command('status [configName]')
        .description('Get Payara status from remote server(s)')
        .option('-t, --target <host>', 'Target server URL (single host mode)')
        .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
        .action(async (configName: string | undefined, options: { target?: string; port: string }) => {
          try {
            if (configName) {
              // Multi-host status using config
              const store = await loadDeployConfigs();
              const config = store.configs[configName];

              if (!config) {
                ctx.output.error(`Config '${configName}' not found`);
                process.exit(1);
              }

              console.log(`\nStatus for ${configName}:\n`);

              for (const host of config.hosts) {
                const baseUrl = host.startsWith('http') ? host : `https://${host}`;
                const pluginUrl = `${baseUrl}:${config.port}/plugins/payara`;
                try {
                  const status = await ctx.client.get<{
                    healthy: boolean;
                    running: boolean;
                    domain: string;
                  }>(`${pluginUrl}/status`);
                  const icon = status.healthy ? '✓' : status.running ? '!' : '✗';
                  const state = status.healthy ? 'healthy' : status.running ? 'degraded' : 'down';
                  console.log(`  ${icon} ${host}: ${state} (${status.domain})`);
                } catch (err) {
                  console.log(`  ✗ ${host}: unreachable`);
                }
              }
              console.log();
            } else {
              // Single host status
              const target = options.target ?? ctx.getConfig().url;
              const baseUrl = target.replace(/\/$/, '');
              const pluginUrl = `${baseUrl}:${options.port}/plugins/payara`;

              const status = await ctx.client.get<{
                healthy: boolean;
                running: boolean;
                domain: string;
                pid?: number;
              }>(`${pluginUrl}/status`);

              ctx.output.keyValue({
                'Domain': status.domain,
                'Running': status.running,
                'Healthy': status.healthy,
                'PID': status.pid ?? 'N/A',
              });
            }
          } catch (err) {
            ctx.output.error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // ========================================================================
      // deploy applications
      // ========================================================================
      deploy
        .command('applications')
        .alias('apps')
        .description('List deployed applications')
        .option('-t, --target <host>', 'Target server URL')
        .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
        .action(async (options: { target?: string; port: string }) => {
          try {
            const target = options.target ?? ctx.getConfig().url;
            const baseUrl = target.replace(/\/$/, '');
            const pluginUrl = `${baseUrl}:${options.port}/plugins/payara`;

            const response = await ctx.client.get<{ applications: string[] }>(
              `${pluginUrl}/applications`
            );

            if (response.applications.length === 0) {
              ctx.output.info('No applications deployed');
              return;
            }

            ctx.output.info(`Deployed applications (${response.applications.length}):`);
            for (const app of response.applications) {
              console.log(`  - ${app}`);
            }
          } catch (err) {
            ctx.output.error(`Failed to list applications: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });
    },
  };
}

/**
 * Calculate SHA-256 hashes for all files in a WAR
 */
async function calculateWarHashes(warPath: string): Promise<WarFileHashes> {
  const hashes: WarFileHashes = {};
  const zip = new AdmZip(warPath);

  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) {
      const content = entry.getData();
      const hash = createHash('sha256').update(content).digest('hex');
      hashes[entry.entryName] = hash;
    }
  }

  return hashes;
}

/**
 * Calculate diff between local and remote hashes
 */
function calculateDiff(
  localHashes: WarFileHashes,
  remoteHashes: WarFileHashes
): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];

  // Find changed/new files
  for (const [path, hash] of Object.entries(localHashes)) {
    if (!remoteHashes[path] || remoteHashes[path] !== hash) {
      changed.push(path);
    }
  }

  // Find deleted files
  for (const path of Object.keys(remoteHashes)) {
    if (!localHashes[path]) {
      deleted.push(path);
    }
  }

  return { changed, deleted };
}

// Default export for CLI plugin
export default createPayaraCLIPlugin;
