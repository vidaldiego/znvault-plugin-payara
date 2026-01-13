// Path: src/cli.ts
// CLI commands for Payara plugin with visual progress

import type { Command } from 'commander';
import { createHash } from 'node:crypto';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import type { WarFileHashes, ChunkedDeployResponse, DeployResult } from './types.js';

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

/**
 * Chunk size for batched deployments (number of files per chunk)
 * Keeping chunks small to avoid body size limits
 */
const CHUNK_SIZE = 50;

/**
 * Retry configuration for transient failures
 * Uses exponential backoff: 3s, 6s, 12s (~21s total)
 * This covers typical agent restart time (~10-15s)
 */
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 3000;

function getRetryDelay(attempt: number): number {
  // Exponential backoff: 3s, 6s, 12s
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

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
 * Direct HTTP client for agent communication
 * Uses raw fetch() instead of ctx.client to avoid vault authentication interference
 * Includes 60s timeout to handle large responses (e.g., WAR file hashes)
 */
const AGENT_TIMEOUT_MS = 60000;

async function agentGet<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent request failed: ${response.status} ${text}`);
  }
  return response.json() as Promise<T>;
}

async function agentPost<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent request failed: ${response.status} ${text}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Build plugin URL from host and port, handling cases where:
 * 1. Host already includes protocol and port (e.g., http://host:9100)
 * 2. Host includes protocol but no port (e.g., http://host)
 * 3. Host is just hostname/IP (e.g., 172.16.220.55)
 */
function buildPluginUrl(host: string, defaultPort: number): string {
  const trimmed = host.replace(/\/$/, '');

  // Parse the URL to check for existing port
  try {
    // Add protocol if missing for URL parsing
    const urlString = trimmed.startsWith('http') ? trimmed : `http://${trimmed}`;
    const url = new URL(urlString);

    // If URL has a port explicitly set, use it; otherwise use defaultPort
    const effectivePort = url.port || String(defaultPort);
    return `${url.protocol}//${url.hostname}:${effectivePort}/plugins/payara`;
  } catch {
    // Fallback for invalid URLs - just append port
    const withProtocol = trimmed.startsWith('http') ? trimmed : `http://${trimmed}`;
    return `${withProtocol}:${defaultPort}/plugins/payara`;
  }
}

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
 * Format date to relative time or absolute
 */
function formatDate(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * WAR file information
 */
interface WarInfo {
  path: string;
  name: string;
  size: number;
  modifiedAt: Date;
  version?: string;
  buildTime?: string;
  fileCount: number;
}

/**
 * Extract WAR info including version from manifest
 */
async function getWarInfo(warPath: string): Promise<WarInfo> {
  const warStats = await stat(warPath);
  const zip = new AdmZip(warPath);

  let version: string | undefined;
  let buildTime: string | undefined;

  // Try to read version from MANIFEST.MF
  const manifestEntry = zip.getEntry('META-INF/MANIFEST.MF');
  if (manifestEntry) {
    const manifest = manifestEntry.getData().toString('utf-8');

    // Look for Implementation-Version or Bundle-Version
    const versionMatch = manifest.match(/Implementation-Version:\s*(.+)/i)
      || manifest.match(/Bundle-Version:\s*(.+)/i)
      || manifest.match(/Specification-Version:\s*(.+)/i);
    if (versionMatch?.[1]) {
      version = versionMatch[1].trim();
    }

    // Look for Build-Time or Build-Timestamp
    const buildMatch = manifest.match(/Build-Time:\s*(.+)/i)
      || manifest.match(/Build-Timestamp:\s*(.+)/i)
      || manifest.match(/Built-At:\s*(.+)/i);
    if (buildMatch?.[1]) {
      buildTime = buildMatch[1].trim();
    }
  }

  // Count files
  const fileCount = zip.getEntries().filter(e => !e.isDirectory).length;

  return {
    path: warPath,
    name: basename(warPath),
    size: warStats.size,
    modifiedAt: warStats.mtime,
    version,
    buildTime,
    fileCount,
  };
}

/**
 * Pre-flight check result for a host
 */
interface PreflightResult {
  host: string;
  reachable: boolean;
  agentVersion?: string;
  pluginVersion?: string;
  payaraRunning?: boolean;
  error?: string;
}

/**
 * Plugin version info from agent endpoint
 */
interface PluginVersionInfo {
  package: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
}

/**
 * Plugin versions response from agent
 */
interface PluginVersionsResponse {
  hasUpdates: boolean;
  versions: PluginVersionInfo[];
  timestamp: string;
}

/**
 * Plugin update result
 */
interface PluginUpdateResult {
  package: string;
  previousVersion: string;
  newVersion: string;
  success: boolean;
  error?: string;
}

/**
 * Plugin update response from agent
 */
interface PluginUpdateResponse {
  updated: number;
  results: PluginUpdateResult[];
  willRestart: boolean;
  message: string;
  timestamp: string;
}

/**
 * Check plugin versions on a host
 */
async function checkPluginVersions(host: string, port: number): Promise<PluginVersionsResponse | null> {
  const pluginUrl = buildPluginUrl(host, port);
  const versionsUrl = pluginUrl.replace('/plugins/payara', '/plugins/versions');

  try {
    const response = await fetch(versionsUrl, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return null;
    }

    return await response.json() as PluginVersionsResponse;
  } catch {
    return null;
  }
}

/**
 * Trigger plugin update on a host
 */
async function triggerPluginUpdate(host: string, port: number): Promise<PluginUpdateResponse | null> {
  const pluginUrl = buildPluginUrl(host, port);
  const updateUrl = pluginUrl.replace('/plugins/payara', '/plugins/update');

  try {
    const response = await fetch(updateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(180000), // 3 minute timeout for npm install
    });

    if (!response.ok) {
      return null;
    }

    return await response.json() as PluginUpdateResponse;
  } catch {
    return null;
  }
}

/**
 * Check if a host is reachable and get basic info
 * Uses same retry logic as deployment for consistency
 */
async function checkHostReachable(
  host: string,
  port: number,
  onRetry?: (attempt: number, delay: number, error: string) => void
): Promise<PreflightResult> {
  const pluginUrl = buildPluginUrl(host, port);
  const healthUrl = pluginUrl.replace('/plugins/payara', '/health');

  let lastError = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt);
          onRetry?.(attempt, delay, lastError);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return { host, reachable: false, error: lastError };
      }

      const health = await response.json() as {
        version?: string;
        plugins?: Array<{ name: string; version?: string; details?: { running?: boolean } }>;
      };

      const payaraPlugin = health.plugins?.find(p => p.name === 'payara');

      return {
        host,
        reachable: true,
        agentVersion: health.version,
        pluginVersion: payaraPlugin?.version,
        payaraRunning: payaraPlugin?.details?.running,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt);
        onRetry?.(attempt, delay, lastError);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
    }
  }

  return {
    host,
    reachable: false,
    error: lastError,
  };
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

  showWarInfo(info: WarInfo): void {
    if (this.isPlain) {
      console.log(`WAR: ${info.path}`);
      console.log(`  Size: ${formatSize(info.size)} (${info.fileCount} files)`);
      console.log(`  Modified: ${info.modifiedAt.toISOString()}`);
      if (info.version) console.log(`  Version: ${info.version}`);
      if (info.buildTime) console.log(`  Built: ${info.buildTime}`);
    } else {
      console.log(`${ANSI.dim}  WAR:      ${ANSI.reset}${info.name}`);
      console.log(`${ANSI.dim}  Path:     ${info.path}${ANSI.reset}`);
      console.log(`${ANSI.dim}  Size:     ${ANSI.reset}${formatSize(info.size)} ${ANSI.dim}(${info.fileCount} files)${ANSI.reset}`);
      console.log(`${ANSI.dim}  Modified: ${ANSI.reset}${formatDate(info.modifiedAt)}`);
      if (info.version) {
        console.log(`${ANSI.dim}  Version:  ${ANSI.reset}${ANSI.cyan}${info.version}${ANSI.reset}`);
      }
      if (info.buildTime) {
        console.log(`${ANSI.dim}  Built:    ${ANSI.reset}${info.buildTime}`);
      }
    }
  }

  showPreflightHeader(hostCount: number): void {
    if (this.isPlain) {
      console.log(`\nPre-flight checks (${hostCount} hosts)...`);
    } else {
      console.log(`\n${ANSI.dim}  Pre-flight checks...${ANSI.reset}`);
    }
  }

  showPreflightChecking(host: string): void {
    if (!this.isPlain) {
      process.stdout.write(`  ${ANSI.dim}◌ ${host}...${ANSI.reset}`);
    }
  }

  showPreflightRetry(host: string, attempt: number, delay: number, error: string): void {
    const delaySec = Math.round(delay / 1000);
    if (this.isPlain) {
      console.log(`  ${host}: retry ${attempt}/${MAX_RETRIES} in ${delaySec}s (${error})`);
    } else {
      process.stdout.write(`\r${ANSI.clearLine}  ${ANSI.yellow}↻ ${host} retry ${attempt}/${MAX_RETRIES} in ${delaySec}s${ANSI.reset}`);
    }
  }

  showPreflightResult(result: PreflightResult, index: number, total: number): void {
    const status = result.reachable
      ? `${ANSI.green}✓${ANSI.reset}`
      : `${ANSI.red}✗${ANSI.reset}`;

    if (this.isPlain) {
      const info = result.reachable
        ? `agent ${result.agentVersion || '?'}, plugin ${result.pluginVersion || '?'}, payara ${result.payaraRunning ? 'running' : 'stopped'}`
        : result.error || 'unreachable';
      console.log(`  [${index + 1}/${total}] ${result.host}: ${result.reachable ? 'OK' : 'FAIL'} - ${info}`);
    } else {
      // Clear the "checking" line and show result
      process.stdout.write(`\r${ANSI.clearLine}`);
      if (result.reachable) {
        const payaraStatus = result.payaraRunning
          ? `${ANSI.green}running${ANSI.reset}`
          : `${ANSI.yellow}stopped${ANSI.reset}`;
        console.log(`  ${status} ${result.host} ${ANSI.dim}(agent ${result.agentVersion || '?'}, payara ${payaraStatus}${ANSI.dim})${ANSI.reset}`);
      } else {
        console.log(`  ${status} ${result.host} ${ANSI.red}(${result.error || 'unreachable'})${ANSI.reset}`);
      }
    }
  }

  showPreflightSummary(results: PreflightResult[]): boolean {
    const reachable = results.filter(r => r.reachable).length;
    const unreachable = results.filter(r => !r.reachable);

    if (unreachable.length === 0) {
      if (!this.isPlain) {
        console.log(`${ANSI.dim}  All ${reachable} hosts reachable${ANSI.reset}`);
      }
      return true;
    }

    if (this.isPlain) {
      console.log(`WARNING: ${unreachable.length} host(s) unreachable`);
    } else {
      console.log(`\n  ${ANSI.yellow}⚠ ${unreachable.length} host(s) unreachable${ANSI.reset}`);
    }
    return false;
  }

  showVersionCheckHeader(): void {
    if (this.isPlain) {
      console.log('\nChecking plugin versions...');
    } else {
      console.log(`\n${ANSI.dim}  Checking plugin versions...${ANSI.reset}`);
    }
  }

  showVersionCheckResult(host: string, response: PluginVersionsResponse | null): void {
    if (this.isPlain) {
      if (!response) {
        console.log(`  ${host}: version check unavailable`);
      } else if (response.hasUpdates) {
        const updates = response.versions.filter(v => v.updateAvailable);
        for (const u of updates) {
          console.log(`  ${host}: ${u.package} ${u.current} -> ${u.latest}`);
        }
      } else {
        console.log(`  ${host}: up to date`);
      }
    } else {
      if (!response) {
        console.log(`  ${ANSI.dim}◌ ${host}: version check unavailable${ANSI.reset}`);
      } else if (response.hasUpdates) {
        const updates = response.versions.filter(v => v.updateAvailable);
        for (const u of updates) {
          console.log(`  ${ANSI.yellow}↑ ${host}: ${u.package} ${u.current} → ${u.latest}${ANSI.reset}`);
        }
      } else {
        console.log(`  ${ANSI.green}✓ ${host}: plugins up to date${ANSI.reset}`);
      }
    }
  }

  showVersionUpdateHeader(host: string): void {
    if (this.isPlain) {
      console.log(`Updating plugins on ${host}...`);
    } else {
      process.stdout.write(`  ${ANSI.cyan}⟳ Updating plugins on ${host}...${ANSI.reset}`);
    }
  }

  showVersionUpdateResult(host: string, response: PluginUpdateResponse | null): void {
    if (this.isPlain) {
      if (!response) {
        console.log(`  ${host}: update failed`);
      } else if (response.updated > 0) {
        console.log(`  ${host}: ${response.updated} plugin(s) updated`);
        if (response.willRestart) {
          console.log(`  ${host}: agent will restart`);
        }
      } else {
        console.log(`  ${host}: no updates applied`);
      }
    } else {
      // Clear the "Updating..." line
      process.stdout.write(`${ANSI.clearLine}\r`);
      if (!response) {
        console.log(`  ${ANSI.red}✗ ${host}: update failed${ANSI.reset}`);
      } else if (response.updated > 0) {
        console.log(`  ${ANSI.green}✓ ${host}: ${response.updated} plugin(s) updated${ANSI.reset}`);
        if (response.willRestart) {
          console.log(`    ${ANSI.dim}Agent will restart in 2s${ANSI.reset}`);
        }
      } else {
        console.log(`  ${ANSI.dim}◌ ${host}: no updates applied${ANSI.reset}`);
      }
    }
  }

  showVersionSummary(hostsWithUpdates: number, totalHosts: number): boolean {
    if (hostsWithUpdates === 0) {
      if (!this.isPlain) {
        console.log(`${ANSI.dim}  All plugins up to date${ANSI.reset}`);
      }
      return false;
    }

    if (this.isPlain) {
      console.log(`${hostsWithUpdates}/${totalHosts} hosts have plugin updates available`);
    } else {
      console.log(`  ${ANSI.yellow}↑ ${hostsWithUpdates}/${totalHosts} hosts have plugin updates available${ANSI.reset}`);
    }
    return true;
  }

  showAgentRestartWaiting(seconds: number): void {
    if (this.isPlain) {
      console.log(`Waiting ${seconds}s for agents to restart...`);
    } else {
      process.stdout.write(`  ${ANSI.dim}Waiting for agents to restart... ${seconds}s${ANSI.reset}\r`);
    }
  }

  showAgentRestartComplete(): void {
    if (!this.isPlain) {
      process.stdout.write(`${ANSI.clearLine}\r`);
      console.log(`  ${ANSI.green}✓ Agents restarted${ANSI.reset}`);
    } else {
      console.log('Agents restarted');
    }
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

  retrying(attempt: number, maxAttempts: number, delayMs: number, lastError?: string): void {
    const delaySec = Math.round(delayMs / 1000);
    if (this.isPlain) {
      console.log(`Retry ${attempt}/${maxAttempts} in ${delaySec}s${lastError ? `: ${lastError}` : ''}`);
    } else {
      console.log(`  ${ANSI.yellow}↻ Retry ${attempt}/${maxAttempts} in ${delaySec}s${lastError ? ` (${lastError})` : ''}${ANSI.reset}`);
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
      const response = await agentPost<ChunkedDeployResponse>(
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
    const pluginUrl = buildPluginUrl(host, port);

    // Get remote hashes with retry logic
    let remoteHashes: WarFileHashes = {};
    let remoteIsEmpty = false;

    if (!force) {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await agentGet<{ hashes: WarFileHashes; status?: string }>(
            `${pluginUrl}/hashes`
          );
          remoteHashes = response.hashes ?? {};
          remoteIsEmpty = Object.keys(remoteHashes).length === 0;
          break; // Success - exit retry loop
        } catch (err) {
          if (attempt < MAX_RETRIES) {
            // Wait before retry with exponential backoff
            await new Promise(r => setTimeout(r, getRetryDelay(attempt)));
            continue;
          }
          // All retries failed - will need full upload
          remoteIsEmpty = true;
        }
      }
    } else {
      // Force mode - treat as if remote is empty to do full upload
      remoteIsEmpty = true;
    }

    // If remote has no WAR or hash fetch failed, upload the full WAR file with retries
    if (remoteIsEmpty) {
      let lastError: string | undefined;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const result = await uploadFullWar(ctx, pluginUrl, warPath, progress);
        if (result.success) {
          return result;
        }
        lastError = result.error;
        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt);
          progress.retrying(attempt, MAX_RETRIES, delay, lastError);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      return { success: false, error: `Failed after ${MAX_RETRIES} attempts: ${lastError}` };
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

    // Deploy with retry logic
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const deployResponse = await agentPost<{
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
          lastError = deployResponse.message;
          // Non-transient error (e.g., deployment conflict), don't retry
          if (deployResponse.status === 'conflict') {
            break;
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt);
          progress.retrying(attempt, MAX_RETRIES, delay, lastError);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
    }
    return { success: false, error: lastError ?? 'Deployment failed' };
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
    version: pluginVersion,
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
        .option('--skip-preflight', 'Skip pre-flight checks')
        .option('--skip-version-check', 'Skip plugin version check')
        .option('--update-plugins', 'Update plugins if updates are available')
        .option('-y, --yes', 'Skip confirmation prompts')
        .action(async (configName: string, options: {
          force?: boolean;
          dryRun?: boolean;
          sequential?: boolean;
          skipPreflight?: boolean;
          skipVersionCheck?: boolean;
          updatePlugins?: boolean;
          yes?: boolean;
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

            // Resolve WAR path and get detailed info
            const warPath = resolve(config.warPath);
            let warInfo: WarInfo;
            try {
              warInfo = await getWarInfo(warPath);
            } catch {
              ctx.output.error(`WAR file not found: ${warPath}`);
              process.exit(1);
            }

            // Header with detailed WAR info
            if (!ctx.isPlainMode()) {
              console.log(`\n${ANSI.bold}Deploying ${ANSI.cyan}${configName}${ANSI.reset}`);
            } else {
              ctx.output.info(`Deploying ${configName}`);
            }
            progress.showWarInfo(warInfo);

            if (!ctx.isPlainMode()) {
              console.log(`${ANSI.dim}  Hosts:    ${ANSI.reset}${config.hosts.length}`);
              console.log(`${ANSI.dim}  Mode:     ${ANSI.reset}${options.sequential || !config.parallel ? 'sequential' : 'parallel'}`);
            } else {
              ctx.output.info(`  Hosts: ${config.hosts.length}`);
              ctx.output.info(`  Mode: ${options.sequential || !config.parallel ? 'sequential' : 'parallel'}`);
            }

            // Pre-flight checks
            if (!options.skipPreflight) {
              progress.showPreflightHeader(config.hosts.length);

              const preflightResults: PreflightResult[] = [];
              for (const [i, host] of config.hosts.entries()) {
                progress.showPreflightChecking(host);
                const result = await checkHostReachable(host, config.port, (attempt, delay, error) => {
                  progress.showPreflightRetry(host, attempt, delay, error);
                });
                preflightResults.push(result);
                progress.showPreflightResult(result, i, config.hosts.length);
              }

              const allReachable = progress.showPreflightSummary(preflightResults);

              if (!allReachable && !options.yes) {
                // Ask user if they want to continue
                const unreachableHosts = preflightResults.filter(r => !r.reachable).map(r => r.host);
                console.log('');
                ctx.output.warn(`Unreachable hosts will be skipped: ${unreachableHosts.join(', ')}`);

                // Dynamic import of inquirer
                const inquirerModule = await import('inquirer');
                const inquirer = inquirerModule.default;
                const answers = await inquirer.prompt([{
                  type: 'confirm',
                  name: 'continue',
                  message: 'Continue with deployment to reachable hosts?',
                  default: true,
                }]) as { continue: boolean };

                if (!answers.continue) {
                  ctx.output.info('Deployment cancelled');
                  return;
                }

                // Filter to only reachable hosts
                config.hosts = config.hosts.filter(h =>
                  preflightResults.find(r => r.host === h)?.reachable
                );
              }
            }

            // Plugin version check (after preflight so we know hosts are reachable)
            if (!options.skipVersionCheck && !options.skipPreflight) {
              progress.showVersionCheckHeader();

              const versionResults: Array<{ host: string; response: PluginVersionsResponse | null }> = [];
              for (const host of config.hosts) {
                const response = await checkPluginVersions(host, config.port);
                versionResults.push({ host, response });
                progress.showVersionCheckResult(host, response);
              }

              const hostsWithUpdates = versionResults.filter(r => r.response?.hasUpdates).length;
              const hasUpdates = progress.showVersionSummary(hostsWithUpdates, config.hosts.length);

              if (hasUpdates) {
                if (options.updatePlugins) {
                  // Auto-update plugins
                  console.log('');
                  let hostsRestarting = 0;

                  for (const { host, response } of versionResults) {
                    if (!response?.hasUpdates) continue;

                    progress.showVersionUpdateHeader(host);
                    const updateResponse = await triggerPluginUpdate(host, config.port);
                    progress.showVersionUpdateResult(host, updateResponse);

                    if (updateResponse?.willRestart) {
                      hostsRestarting++;
                    }
                  }

                  // If any agents are restarting, wait for them
                  if (hostsRestarting > 0) {
                    console.log('');
                    // Wait 25 seconds total for agents to restart (2s delay + 15s restart + buffer)
                    const RESTART_WAIT_TIME = 25;
                    for (let i = RESTART_WAIT_TIME; i > 0; i--) {
                      progress.showAgentRestartWaiting(i);
                      await new Promise(r => setTimeout(r, 1000));
                    }
                    progress.showAgentRestartComplete();
                  }
                } else if (!options.yes) {
                  // Ask user if they want to update
                  console.log('');
                  const inquirerModule = await import('inquirer');
                  const inquirer = inquirerModule.default;
                  const answers = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'update',
                    message: 'Update plugins before deploying?',
                    default: false,
                  }]) as { update: boolean };

                  if (answers.update) {
                    let hostsRestarting = 0;

                    for (const { host, response } of versionResults) {
                      if (!response?.hasUpdates) continue;

                      progress.showVersionUpdateHeader(host);
                      const updateResponse = await triggerPluginUpdate(host, config.port);
                      progress.showVersionUpdateResult(host, updateResponse);

                      if (updateResponse?.willRestart) {
                        hostsRestarting++;
                      }
                    }

                    // If any agents are restarting, wait for them
                    if (hostsRestarting > 0) {
                      console.log('');
                      const RESTART_WAIT_TIME = 25;
                      for (let i = RESTART_WAIT_TIME; i > 0; i--) {
                        progress.showAgentRestartWaiting(i);
                        await new Promise(r => setTimeout(r, 1000));
                      }
                      progress.showAgentRestartComplete();
                    }
                  }
                }
              }
            }

            // Calculate local hashes once
            if (!ctx.isPlainMode()) {
              console.log('');
            }
            const localHashes = await calculateWarHashes(warPath);

            if (options.dryRun) {
              ctx.output.info(`Dry run - would deploy ${warInfo.fileCount} files to ${config.hosts.length} host(s)`);
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
            const pluginUrl = buildPluginUrl(target, parseInt(options.port, 10));

            // Get remote hashes (for dry-run we need to fetch them separately)
            let remoteHashes: WarFileHashes = {};
            let remoteIsEmpty = false;
            if (!options.force) {
              try {
                const response = await agentGet<{ hashes: WarFileHashes }>(
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
                const pluginUrl = buildPluginUrl(host, config.port);
                try {
                  await agentPost(`${pluginUrl}/restart`, {});
                  console.log(`  ${ANSI.green}✓${ANSI.reset} ${host} restarted`);
                } catch (err) {
                  console.log(`  ${ANSI.red}✗${ANSI.reset} ${host}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            } else {
              // Single host restart
              const target = options.target ?? ctx.getConfig().url;
              const pluginUrl = buildPluginUrl(target, parseInt(options.port, 10));

              ctx.output.info('Restarting Payara...');
              await agentPost(`${pluginUrl}/restart`, {});
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
                const pluginUrl = buildPluginUrl(host, config.port);
                try {
                  const status = await agentGet<{
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
              const pluginUrl = buildPluginUrl(target, parseInt(options.port, 10));

              const status = await agentGet<{
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
            const pluginUrl = buildPluginUrl(target, parseInt(options.port, 10));

            const response = await agentGet<{ applications: string[] }>(
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
