// Path: src/cli.ts
// CLI commands for Payara plugin

import type { Command } from 'commander';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
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
 * Payara CLI plugin
 *
 * Adds deploy commands to znvault CLI
 */
export function createPayaraCLIPlugin(): CLIPlugin {
  return {
    name: 'payara',
    version: '1.0.0',
    description: 'Payara WAR deployment commands',

    registerCommands(program: Command, ctx: CLIPluginContext): void {
      // Create deploy command group
      const deploy = program
        .command('deploy')
        .description('Deploy WAR files to remote Payara servers');

      // deploy war <file>
      deploy
        .command('war <warFile>')
        .description('Deploy WAR file using diff transfer')
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

      // deploy restart
      deploy
        .command('restart')
        .description('Restart Payara on remote server')
        .option('-t, --target <host>', 'Target server URL')
        .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
        .action(async (options: { target?: string; port: string }) => {
          try {
            const target = options.target ?? ctx.getConfig().url;
            const baseUrl = target.replace(/\/$/, '');
            const pluginUrl = `${baseUrl}:${options.port}/plugins/payara`;

            ctx.output.info('Restarting Payara...');
            await ctx.client.post(`${pluginUrl}/restart`, {});
            ctx.output.success('Payara restarted');
          } catch (err) {
            ctx.output.error(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // deploy status
      deploy
        .command('status')
        .description('Get Payara status from remote server')
        .option('-t, --target <host>', 'Target server URL')
        .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
        .action(async (options: { target?: string; port: string }) => {
          try {
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
          } catch (err) {
            ctx.output.error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        });

      // deploy applications
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
