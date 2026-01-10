// Path: src/cli.ts
// CLI commands for Payara plugin with visual progress

import type { Command } from 'commander';
import { createHash } from 'node:crypto';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import AdmZip from 'adm-zip';
import type { WarFileHashes, ChunkedDeployResponse, DeployResult } from './types.js';

/**
 * Chunk size for batched deployments (number of files per chunk)
 * Keeping chunks small to avoid body size limits
 */
const CHUNK_SIZE = 50;

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
  /** If true, configs are synced from vault */
  vaultEnabled?: boolean;
  /** Vault secret alias for config storage */
  vaultAlias?: string;
}

// Config file path
const CONFIG_DIR = join(homedir(), '.znvault');
const CONFIG_FILE = join(CONFIG_DIR, 'deploy-configs.json');

// ANSI escape codes for colors and cursor control
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  clearLine: '\x1b[2K',
  cursorUp: '\x1b[1A',
  cursorHide: '\x1b[?25l',
  cursorShow: '\x1b[?25h',
};

/**
 * Format file size to human readable
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Format duration in ms to human readable
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Create a progress bar string
 */
function progressBar(current: number, total: number, width = 30): string {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `${ANSI.cyan}${bar}${ANSI.reset} ${percent}%`;
}

/**
 * Progress reporter for visual feedback
 */
class ProgressReporter {
  private isPlain: boolean;
  private currentHost = '';
  private lastFiles: string[] = [];
  private maxFileDisplay = 5;

  constructor(isPlain: boolean) {
    this.isPlain = isPlain;
  }

  setHost(host: string): void {
    this.currentHost = host;
    if (!this.isPlain) {
      console.log(`\n${ANSI.bold}${ANSI.blue}▶ Deploying to ${host}${ANSI.reset}`);
    }
  }

  analyzing(warPath: string): void {
    const name = basename(warPath);
    if (this.isPlain) {
      console.log(`Analyzing ${name}...`);
    } else {
      console.log(`${ANSI.dim}  Analyzing ${name}...${ANSI.reset}`);
    }
  }

  foundFiles(count: number, warSize: number): void {
    if (this.isPlain) {
      console.log(`Found ${count} files (${formatSize(warSize)})`);
    } else {
      console.log(`${ANSI.dim}  Found ${ANSI.bold}${count}${ANSI.reset}${ANSI.dim} files (${formatSize(warSize)})${ANSI.reset}`);
    }
  }

  diff(changed: number, deleted: number): void {
    if (this.isPlain) {
      console.log(`Diff: ${changed} changed, ${deleted} deleted`);
    } else {
      const changeStr = changed > 0 ? `${ANSI.green}+${changed}${ANSI.reset}` : `${ANSI.dim}+0${ANSI.reset}`;
      const deleteStr = deleted > 0 ? `${ANSI.red}-${deleted}${ANSI.reset}` : `${ANSI.dim}-0${ANSI.reset}`;
      console.log(`  ${ANSI.dim}Diff:${ANSI.reset} ${changeStr} ${deleteStr}`);
    }
  }

  uploadingFullWar(): void {
    if (this.isPlain) {
      console.log('Uploading full WAR file...');
    } else {
      console.log(`  ${ANSI.yellow}⬆ Uploading full WAR file...${ANSI.reset}`);
    }
  }

  uploadBytesProgress(uploaded: number, total: number): void {
    if (this.isPlain) {
      const pct = Math.round((uploaded / total) * 100);
      console.log(`  Uploaded ${formatSize(uploaded)}/${formatSize(total)} (${pct}%)`);
    } else {
      const pct = Math.round((uploaded / total) * 100);
      // Use carriage return to overwrite the line
      process.stdout.write(`\r  ${ANSI.yellow}⬆${ANSI.reset} Uploading: ${formatSize(uploaded)}/${formatSize(total)} (${pct}%)    `);
    }
  }

  uploadComplete(): void {
    if (!this.isPlain) {
      // Move to next line after progress
      process.stdout.write('\n');
    }
  }

  uploadProgress(sent: number, total: number, currentFiles?: string[]): void {
    if (this.isPlain) {
      console.log(`  Sent ${sent}/${total} files`);
      return;
    }

    // Store last files for display
    if (currentFiles) {
      this.lastFiles = currentFiles.slice(-this.maxFileDisplay);
    }

    // Clear previous lines and redraw
    const lines = this.maxFileDisplay + 2; // progress bar + files
    process.stdout.write(`${ANSI.cursorUp.repeat(lines)}${ANSI.clearLine}`);

    // Progress bar
    console.log(`  ${progressBar(sent, total)} ${sent}/${total} files`);

    // File list
    console.log(`${ANSI.dim}  Recent files:${ANSI.reset}`);
    for (const file of this.lastFiles) {
      const shortFile = file.length > 60 ? '...' + file.slice(-57) : file;
      console.log(`${ANSI.dim}    ${shortFile}${ANSI.reset}`);
    }
    // Pad empty lines
    for (let i = this.lastFiles.length; i < this.maxFileDisplay; i++) {
      console.log('');
    }
  }

  deploying(): void {
    if (this.isPlain) {
      console.log('Deploying via asadmin...');
    } else {
      console.log(`  ${ANSI.yellow}⏳ Deploying via asadmin...${ANSI.reset}`);
    }
  }

  deployed(result: DeployResult): void {
    if (this.isPlain) {
      console.log(`Deployed: ${result.filesChanged} changed, ${result.filesDeleted} deleted (${formatDuration(result.deploymentTime)})`);
    } else {
      console.log(`  ${ANSI.green}✓ Deployed${ANSI.reset} ${result.filesChanged} changed, ${result.filesDeleted} deleted ${ANSI.dim}(${formatDuration(result.deploymentTime)})${ANSI.reset}`);
      if (result.applications && result.applications.length > 0) {
        console.log(`  ${ANSI.dim}  Applications: ${result.applications.join(', ')}${ANSI.reset}`);
      }
    }
  }

  noChanges(): void {
    if (this.isPlain) {
      console.log('No changes to deploy');
    } else {
      console.log(`  ${ANSI.green}✓ No changes${ANSI.reset}`);
    }
  }

  failed(error: string): void {
    if (this.isPlain) {
      console.log(`Failed: ${error}`);
    } else {
      console.log(`  ${ANSI.red}✗ Failed: ${error}${ANSI.reset}`);
    }
  }

  summary(successful: number, total: number, failed: number): void {
    console.log('');
    if (this.isPlain) {
      console.log(`Deployment complete: ${successful}/${total} hosts successful${failed > 0 ? `, ${failed} failed` : ''}`);
    } else {
      if (failed === 0) {
        console.log(`${ANSI.bold}${ANSI.green}✓ Deployment complete${ANSI.reset}: ${successful}/${total} hosts successful`);
      } else {
        console.log(`${ANSI.bold}${ANSI.yellow}⚠ Deployment complete${ANSI.reset}: ${successful}/${total} hosts successful, ${ANSI.red}${failed} failed${ANSI.reset}`);
      }
    }
  }
}

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
 * Upload full WAR file to server with progress tracking
 */
async function uploadFullWar(
  ctx: CLIPluginContext,
  pluginUrl: string,
  warPath: string,
  progress: ProgressReporter
): Promise<{ success: boolean; error?: string; result?: DeployResult }> {
  try {
    progress.uploadingFullWar();

    // Read WAR file
    const warBuffer = await readFile(warPath);
    const totalSize = warBuffer.length;

    // Report initial progress
    progress.uploadBytesProgress(0, totalSize);

    // Upload using raw POST
    const response = await fetch(`${pluginUrl}/deploy/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': totalSize.toString(),
      },
      body: warBuffer,
    });

    // Report completion
    progress.uploadBytesProgress(totalSize, totalSize);
    progress.uploadComplete();

    const data = await response.json() as {
      status?: string;
      error?: string;
      message?: string;
      deployed?: boolean;
      deploymentTime?: number;
      applications?: string[];
      appName?: string;
      size?: number;
    };

    if (!response.ok) {
      return { success: false, error: data.message ?? data.error ?? 'Upload failed' };
    }

    return {
      success: true,
      result: {
        success: true,
        filesChanged: Object.keys(await calculateWarHashes(warPath)).length,
        filesDeleted: 0,
        message: data.message ?? 'Deployment successful',
        deploymentTime: data.deploymentTime ?? 0,
        appName: data.appName ?? '',
        deployed: data.deployed,
        applications: data.applications,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Deploy files using chunked upload with progress
 */
async function deployChunked(
  ctx: CLIPluginContext,
  pluginUrl: string,
  zip: AdmZip,
  changed: string[],
  deleted: string[],
  progress: ProgressReporter
): Promise<{ success: boolean; error?: string; result?: DeployResult }> {
  try {
    let sessionId: string | undefined;
    const totalFiles = changed.length;

    // Initialize progress display
    if (!ctx.isPlainMode()) {
      // Print placeholder lines for progress display
      console.log(`  ${progressBar(0, totalFiles)} 0/${totalFiles} files`);
      console.log(`${ANSI.dim}  Recent files:${ANSI.reset}`);
      for (let i = 0; i < 5; i++) {
        console.log('');
      }
    }

    // Send files in chunks
    for (let i = 0; i < changed.length; i += CHUNK_SIZE) {
      const chunkPaths = changed.slice(i, i + CHUNK_SIZE);
      const isLastChunk = i + CHUNK_SIZE >= changed.length;

      // Prepare chunk files
      const files = chunkPaths.map(path => {
        const entry = zip.getEntry(path);
        if (!entry) {
          throw new Error(`Entry not found in WAR: ${path}`);
        }
        return {
          path,
          content: entry.getData().toString('base64'),
        };
      });

      // Build chunk request
      const chunkRequest: {
        sessionId?: string;
        files: Array<{ path: string; content: string }>;
        deletions?: string[];
        expectedFiles?: number;
        commit?: boolean;
      } = {
        files,
        commit: isLastChunk,
      };

      if (sessionId) {
        chunkRequest.sessionId = sessionId;
      } else {
        // First chunk - include deletions and expected file count
        chunkRequest.deletions = deleted;
        chunkRequest.expectedFiles = totalFiles;
      }

      // Send chunk
      const response = await ctx.client.post<ChunkedDeployResponse>(
        `${pluginUrl}/deploy/chunk`,
        chunkRequest
      );

      sessionId = response.sessionId;

      // Report progress
      progress.uploadProgress(response.filesReceived, totalFiles, chunkPaths);

      // Check if committed (final chunk)
      if (response.committed && response.result) {
        return {
          success: response.result.success,
          result: response.result,
        };
      }
    }

    // Should not reach here if commit was sent
    return { success: false, error: 'Chunked deployment did not complete' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Deploy to a single host with progress reporting
 */
async function deployToHost(
  ctx: CLIPluginContext,
  host: string,
  port: number,
  warPath: string,
  localHashes: WarFileHashes,
  force: boolean,
  progress: ProgressReporter
): Promise<{ success: boolean; error?: string; result?: DeployResult }> {
  try {
    const baseUrl = host.replace(/\/$/, '');
    // Add protocol if missing (default to HTTP for local agent communication)
    const fullUrl = baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`;
    const pluginUrl = `${fullUrl}:${port}/plugins/payara`;

    // Get remote hashes with retry logic
    let remoteHashes: WarFileHashes = {};
    let remoteIsEmpty = false;

    if (!force) {
      const MAX_HASH_RETRIES = 2;
      for (let attempt = 1; attempt <= MAX_HASH_RETRIES; attempt++) {
        try {
          const response = await ctx.client.get<{ hashes: WarFileHashes; status?: string }>(
            `${pluginUrl}/hashes`
          );
          remoteHashes = response.hashes ?? {};
          remoteIsEmpty = Object.keys(remoteHashes).length === 0;
          break; // Success - exit retry loop
        } catch (err) {
          if (attempt < MAX_HASH_RETRIES) {
            // Wait before retry
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          // All retries failed - assume empty/needs full upload
          remoteIsEmpty = true;
        }
      }
    } else {
      // Force mode - treat as if remote is empty to do full upload
      remoteIsEmpty = true;
    }

    // If remote has no WAR, upload the full WAR file
    if (remoteIsEmpty) {
      return uploadFullWar(ctx, pluginUrl, warPath, progress);
    }

    // Calculate diff
    const { changed, deleted } = calculateDiff(localHashes, remoteHashes);
    progress.diff(changed.length, deleted.length);

    if (changed.length === 0 && deleted.length === 0) {
      progress.noChanges();
      return {
        success: true,
        result: {
          success: true,
          filesChanged: 0,
          filesDeleted: 0,
          message: 'No changes',
          deploymentTime: 0,
          appName: '',
        },
      };
    }

    const zip = new AdmZip(warPath);

    // Use chunked deployment if there are many files
    if (changed.length > CHUNK_SIZE) {
      return deployChunked(ctx, pluginUrl, zip, changed, deleted, progress);
    }

    // Small deployment - use single request
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

    progress.deploying();

    // Deploy
    const deployResponse = await ctx.client.post<{
      status: string;
      filesChanged: number;
      filesDeleted: number;
      message?: string;
      deploymentTime?: number;
      deployed?: boolean;
      applications?: string[];
      appName?: string;
    }>(`${pluginUrl}/deploy`, {
      files,
      deletions: deleted,
    });

    if (deployResponse.status === 'deployed') {
      return {
        success: true,
        result: {
          success: true,
          filesChanged: deployResponse.filesChanged,
          filesDeleted: deployResponse.filesDeleted,
          message: deployResponse.message ?? 'Deployment successful',
          deploymentTime: deployResponse.deploymentTime ?? 0,
          appName: deployResponse.appName ?? '',
          deployed: deployResponse.deployed,
          applications: deployResponse.applications,
        },
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
    version: '1.7.0',
    description: 'Payara WAR deployment commands with visual progress',

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
          const progress = new ProgressReporter(ctx.isPlainMode());

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
            let warStats;
            try {
              warStats = await stat(warPath);
            } catch {
              ctx.output.error(`WAR file not found: ${warPath}`);
              process.exit(1);
            }

            // Header
            if (!ctx.isPlainMode()) {
              console.log(`\n${ANSI.bold}Deploying ${ANSI.cyan}${configName}${ANSI.reset}`);
              console.log(`${ANSI.dim}  WAR: ${basename(warPath)}${ANSI.reset}`);
              console.log(`${ANSI.dim}  Hosts: ${config.hosts.length}${ANSI.reset}`);
              console.log(`${ANSI.dim}  Mode: ${options.sequential || !config.parallel ? 'sequential' : 'parallel'}${ANSI.reset}`);
            } else {
              ctx.output.info(`Deploying ${configName}`);
              ctx.output.info(`  WAR: ${warPath}`);
              ctx.output.info(`  Hosts: ${config.hosts.length}`);
              ctx.output.info(`  Mode: ${options.sequential || !config.parallel ? 'sequential' : 'parallel'}`);
            }

            // Calculate local hashes once
            progress.analyzing(warPath);
            const localHashes = await calculateWarHashes(warPath);
            progress.foundFiles(Object.keys(localHashes).length, warStats.size);

            if (options.dryRun) {
              ctx.output.info('Dry run - checking each host:');
              for (const host of config.hosts) {
                console.log(`  - ${host}`);
              }
              return;
            }

            const results: Array<{
              host: string;
              success: boolean;
              error?: string;
              result?: DeployResult;
            }> = [];

            const deployToHostWrapper = async (host: string) => {
              progress.setHost(host);
              const result = await deployToHost(
                ctx,
                host,
                config.port,
                warPath,
                localHashes,
                options.force ?? false,
                progress
              );
              results.push({
                host,
                success: result.success,
                error: result.error,
                result: result.result,
              });
              if (result.success && result.result) {
                progress.deployed(result.result);
              } else {
                progress.failed(result.error ?? 'Unknown error');
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

            const successful = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;
            progress.summary(successful, config.hosts.length, failed);

            if (failed > 0) {
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

            console.log('\nDeployment Configurations:\n');
            for (const config of configs) {
              console.log(`  ${ANSI.bold}${config.name}${ANSI.reset}`);
              if (config.description) {
                console.log(`    ${ANSI.dim}${config.description}${ANSI.reset}`);
              }
              console.log(`    Hosts: ${config.hosts.length > 0 ? config.hosts.join(', ') : ANSI.dim + '(none)' + ANSI.reset}`);
              console.log(`    WAR:   ${config.warPath || ANSI.dim + '(not set)' + ANSI.reset}`);
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

            console.log(`\n${ANSI.bold}Deployment Config: ${config.name}${ANSI.reset}\n`);
            if (config.description) {
              console.log(`  Description: ${config.description}`);
            }
            console.log(`  WAR Path:    ${config.warPath || ANSI.dim + '(not set)' + ANSI.reset}`);
            console.log(`  Port:        ${config.port}`);
            console.log(`  Mode:        ${config.parallel ? 'parallel' : 'sequential'}`);
            console.log(`\n  Hosts (${config.hosts.length}):`);
            if (config.hosts.length === 0) {
              console.log(`    ${ANSI.dim}(none)${ANSI.reset}`);
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
          const progress = new ProgressReporter(ctx.isPlainMode());

          try {
            // Verify WAR file exists
            let warStats;
            try {
              warStats = await stat(warFile);
            } catch {
              ctx.output.error(`WAR file not found: ${warFile}`);
              process.exit(1);
            }

            progress.analyzing(warFile);

            // Calculate local hashes
            const localHashes = await calculateWarHashes(warFile);
            progress.foundFiles(Object.keys(localHashes).length, warStats.size);

            // Build target URL
            const target = options.target ?? ctx.getConfig().url;
            const baseUrl = target.replace(/\/$/, '');
            const fullUrl = baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`;
            const pluginUrl = `${fullUrl}:${options.port}/plugins/payara`;

            // Get remote hashes (for dry-run we need to fetch them separately)
            let remoteHashes: WarFileHashes = {};
            let remoteIsEmpty = false;
            if (!options.force) {
              try {
                const response = await ctx.client.get<{ hashes: WarFileHashes }>(
                  `${pluginUrl}/hashes`
                );
                remoteHashes = response.hashes ?? {};
                remoteIsEmpty = Object.keys(remoteHashes).length === 0;
              } catch (err) {
                ctx.output.warn(`Could not fetch remote hashes: ${err instanceof Error ? err.message : String(err)}`);
                ctx.output.warn('Will do full deployment');
                remoteIsEmpty = true;
              }
            } else {
              remoteIsEmpty = true;
            }

            // Calculate diff
            const { changed, deleted } = calculateDiff(localHashes, remoteHashes);

            if (remoteIsEmpty) {
              ctx.output.info('Remote has no WAR, will upload full WAR file');
            } else {
              progress.diff(changed.length, deleted.length);
            }

            // Dry run - just show what would be deployed
            if (options.dryRun) {
              if (remoteIsEmpty) {
                ctx.output.info(`Would upload full WAR (${Object.keys(localHashes).length} files)`);
                return;
              }

              if (changed.length > 0) {
                ctx.output.info('\nFiles to update:');
                for (const file of changed.slice(0, 20)) {
                  console.log(`  ${ANSI.green}+${ANSI.reset} ${file}`);
                }
                if (changed.length > 20) {
                  console.log(`  ${ANSI.dim}... and ${changed.length - 20} more${ANSI.reset}`);
                }
              }

              if (deleted.length > 0) {
                ctx.output.info('\nFiles to delete:');
                for (const file of deleted.slice(0, 20)) {
                  console.log(`  ${ANSI.red}-${ANSI.reset} ${file}`);
                }
                if (deleted.length > 20) {
                  console.log(`  ${ANSI.dim}... and ${deleted.length - 20} more${ANSI.reset}`);
                }
              }

              if (changed.length === 0 && deleted.length === 0) {
                progress.noChanges();
              }
              return;
            }

            // Deploy using deployToHost
            progress.setHost(target);
            const result = await deployToHost(
              ctx,
              target,
              parseInt(options.port, 10),
              warFile,
              localHashes,
              options.force ?? false,
              progress
            );

            if (result.success && result.result) {
              progress.deployed(result.result);
            } else {
              progress.failed(result.error ?? 'Unknown error');
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
                const baseUrl = host.startsWith('http') ? host : `http://${host}`;
                const pluginUrl = `${baseUrl}:${config.port}/plugins/payara`;
                try {
                  await ctx.client.post(`${pluginUrl}/restart`, {});
                  console.log(`  ${ANSI.green}✓${ANSI.reset} ${host} restarted`);
                } catch (err) {
                  console.log(`  ${ANSI.red}✗${ANSI.reset} ${host}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            } else {
              // Single host restart
              const target = options.target ?? ctx.getConfig().url;
              const baseUrl = target.replace(/\/$/, '');
              const fullUrl = baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`;
              const pluginUrl = `${fullUrl}:${options.port}/plugins/payara`;

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

              console.log(`\n${ANSI.bold}Status for ${configName}:${ANSI.reset}\n`);

              for (const host of config.hosts) {
                const baseUrl = host.startsWith('http') ? host : `http://${host}`;
                const pluginUrl = `${baseUrl}:${config.port}/plugins/payara`;
                try {
                  const status = await ctx.client.get<{
                    healthy: boolean;
                    running: boolean;
                    domain: string;
                    appDeployed?: boolean;
                    appName?: string;
                  }>(`${pluginUrl}/status`);
                  const icon = status.healthy && status.appDeployed ? ANSI.green + '✓' : status.running ? ANSI.yellow + '!' : ANSI.red + '✗';
                  const state = status.healthy && status.appDeployed ? 'healthy' : status.running ? 'degraded' : 'down';
                  const appInfo = status.appDeployed ? `${status.appName || 'app'} deployed` : 'no app';
                  console.log(`  ${icon}${ANSI.reset} ${host}: ${state} (${status.domain}, ${appInfo})`);
                } catch {
                  console.log(`  ${ANSI.red}✗${ANSI.reset} ${host}: unreachable`);
                }
              }
              console.log();
            } else {
              // Single host status
              const target = options.target ?? ctx.getConfig().url;
              const baseUrl = target.replace(/\/$/, '');
              const fullUrl = baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`;
              const pluginUrl = `${fullUrl}:${options.port}/plugins/payara`;

              const status = await ctx.client.get<{
                healthy: boolean;
                running: boolean;
                domain: string;
                appDeployed?: boolean;
                appName?: string;
                warPath?: string;
                pid?: number;
              }>(`${pluginUrl}/status`);

              ctx.output.keyValue({
                'Domain': status.domain,
                'Running': status.running,
                'Healthy': status.healthy,
                'App Deployed': status.appDeployed ?? false,
                'App Name': status.appName ?? 'N/A',
                'WAR Path': status.warPath ?? 'N/A',
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
            const fullUrl = baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`;
            const pluginUrl = `${fullUrl}:${options.port}/plugins/payara`;

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
