// Path: src/cli/progress.ts
// Progress reporter for visual feedback

import { basename } from 'node:path';
import type { DeployResult } from '../types.js';
import { ANSI, MAX_RETRIES } from './constants.js';
import type { ProgressCallback } from './http-client.js';
import type {
  PluginVersionInfo,
  PluginVersionsResponse,
  PluginVersionCheckResult,
  TriggerUpdateResult,
} from './types.js';
import {
  formatSize,
  formatDuration,
  formatDate,
  formatTime,
  progressBar,
} from './formatters.js';
import type { WarInfo } from './war-info.js';

/**
 * Pre-flight check result for a host
 */
export interface PreflightResult {
  host: string;
  reachable: boolean;
  agentVersion?: string;
  pluginVersion?: string;
  payaraRunning?: boolean;
  error?: string;
}

// Re-export types from types.ts for backwards compatibility
export type { PluginVersionInfo, PluginVersionsResponse, PluginVersionCheckResult, TriggerUpdateResult };

// Re-export formatters for backwards compatibility
export { formatSize, formatDuration, formatDate, progressBar } from './formatters.js';

// Re-export WAR info utilities for backwards compatibility
export { getWarInfo } from './war-info.js';
export type { WarInfo } from './war-info.js';

/**
 * Progress reporter for visual feedback
 * Implements ProgressCallback for use with pollDeploymentStatus
 */
/**
 * Callback for forwarding progress updates to UnifiedProgress
 */
export type OnProgressCallback = (host: string, filesUploaded: number, bytesUploaded: number) => void;

/**
 * Callback for forwarding deploy phase to UnifiedProgress
 */
export type OnDeployingCallback = (host: string) => void;

export class ProgressReporter implements ProgressCallback {
  private isPlain: boolean;
  private currentHost = '';
  private lastFiles: string[] = [];
  private maxFileDisplay = 5;
  /** When true, suppress per-host output (UnifiedProgress handles display) */
  private silent = false;
  /** Callback to forward progress to UnifiedProgress */
  private onProgress?: OnProgressCallback;
  /** Callback to forward deploying state to UnifiedProgress */
  private onDeploying?: OnDeployingCallback;

  constructor(isPlain: boolean) {
    this.isPlain = isPlain;
  }

  /**
   * Set callback for forwarding progress to UnifiedProgress
   */
  setOnProgress(callback: OnProgressCallback): void {
    this.onProgress = callback;
  }

  /**
   * Set callback for forwarding deploy phase to UnifiedProgress
   */
  setOnDeploying(callback: OnDeployingCallback): void {
    this.onDeploying = callback;
  }

  /**
   * Enable silent mode - suppresses per-host output for multi-host deployments
   * where UnifiedProgress handles the display
   */
  setSilent(silent: boolean): void {
    this.silent = silent;
  }

  /**
   * Check if silent mode is enabled
   */
  isSilent(): boolean {
    return this.silent;
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

  showVersionCheckResult(host: string, result: PluginVersionCheckResult): void {
    if (this.isPlain) {
      if (!result.success) {
        console.log(`  ${host}: version check failed - ${result.error}`);
      } else if (result.response?.hasUpdates) {
        const updates = result.response.versions.filter(v => v.updateAvailable);
        for (const u of updates) {
          console.log(`  ${host}: ${u.package} ${u.current} -> ${u.latest}`);
        }
      } else {
        console.log(`  ${host}: up to date`);
      }
    } else {
      if (!result.success) {
        console.log(`  ${ANSI.yellow}⚠ ${host}: ${result.error}${ANSI.reset}`);
      } else if (result.response?.hasUpdates) {
        const updates = result.response.versions.filter(v => v.updateAvailable);
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

  showVersionUpdateResult(host: string, result: TriggerUpdateResult): void {
    if (this.isPlain) {
      if (!result.success) {
        console.log(`  ${host}: update failed - ${result.error}`);
      } else if (result.response && result.response.updated > 0) {
        console.log(`  ${host}: ${result.response.updated} plugin(s) updated`);
        if (result.response.willRestart) {
          console.log(`  ${host}: agent will restart`);
        }
      } else {
        console.log(`  ${host}: no updates applied`);
      }
    } else {
      // Clear the "Updating..." line
      process.stdout.write(`${ANSI.clearLine}\r`);
      if (!result.success) {
        console.log(`  ${ANSI.red}✗ ${host}: ${result.error}${ANSI.reset}`);
      } else if (result.response && result.response.updated > 0) {
        console.log(`  ${ANSI.green}✓ ${host}: ${result.response.updated} plugin(s) updated${ANSI.reset}`);
        if (result.response.willRestart) {
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
    if (this.silent) return;
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

  diff(changed: number, deleted: number, changedFiles?: string[], deletedFiles?: string[]): void {
    if (this.silent) return;
    if (this.isPlain) {
      console.log(`Diff: ${changed} changed, ${deleted} deleted`);
      if (changedFiles && changedFiles.length > 0) {
        for (const f of changedFiles.slice(0, 10)) {
          console.log(`  + ${f}`);
        }
        if (changedFiles.length > 10) {
          console.log(`  ... and ${changedFiles.length - 10} more`);
        }
      }
    } else {
      const changeStr = changed > 0 ? `${ANSI.green}+${changed}${ANSI.reset}` : `${ANSI.dim}+0${ANSI.reset}`;
      const deleteStr = deleted > 0 ? `${ANSI.red}-${deleted}${ANSI.reset}` : `${ANSI.dim}-0${ANSI.reset}`;
      console.log(`  ${ANSI.dim}Diff:${ANSI.reset} ${changeStr} ${deleteStr}`);

      // Show changed files (up to 15 for visual display)
      if (changedFiles && changedFiles.length > 0) {
        const maxShow = 15;
        console.log(`${ANSI.dim}  Changed files:${ANSI.reset}`);
        for (const f of changedFiles.slice(0, maxShow)) {
          const shortFile = f.length > 65 ? '...' + f.slice(-62) : f;
          console.log(`    ${ANSI.green}+${ANSI.reset} ${ANSI.dim}${shortFile}${ANSI.reset}`);
        }
        if (changedFiles.length > maxShow) {
          console.log(`    ${ANSI.dim}... and ${changedFiles.length - maxShow} more${ANSI.reset}`);
        }
      }

      // Show deleted files
      if (deletedFiles && deletedFiles.length > 0) {
        const maxShow = 5;
        console.log(`${ANSI.dim}  Deleted files:${ANSI.reset}`);
        for (const f of deletedFiles.slice(0, maxShow)) {
          const shortFile = f.length > 65 ? '...' + f.slice(-62) : f;
          console.log(`    ${ANSI.red}-${ANSI.reset} ${ANSI.dim}${shortFile}${ANSI.reset}`);
        }
        if (deletedFiles.length > maxShow) {
          console.log(`    ${ANSI.dim}... and ${deletedFiles.length - maxShow} more${ANSI.reset}`);
        }
      }
    }
  }

  uploadingFullWar(): void {
    if (this.silent) return;
    if (this.isPlain) {
      console.log('Uploading full WAR file...');
    } else {
      console.log(`  ${ANSI.yellow}⬆ Uploading full WAR file...${ANSI.reset}`);
    }
  }

  uploadBytesProgress(uploaded: number, total: number): void {
    if (this.silent) return;
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
    if (this.silent) return;
    if (!this.isPlain) {
      // Move to next line after progress
      process.stdout.write('\n');
    }
  }

  uploadProgress(sent: number, total: number, currentFiles?: string[]): void {
    // Always call callback (for UnifiedProgress), even in silent mode
    if (this.onProgress && this.currentHost) {
      // Estimate bytes from file count (rough approximation)
      this.onProgress(this.currentHost, sent, 0);
    }

    if (this.silent) return;
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
    // Always call callback (for UnifiedProgress), even in silent mode
    if (this.onDeploying && this.currentHost) {
      this.onDeploying(this.currentHost);
    }

    if (this.silent) return;
    if (this.isPlain) {
      console.log('Deploying via asadmin...');
    } else {
      console.log(`  ${ANSI.yellow}⏳ Deploying via asadmin...${ANSI.reset}`);
    }
  }

  deployed(result: DeployResult): void {
    if (this.silent) return;
    const timeStr = result.completedAt ? ` - completed at ${formatTime(result.completedAt)}` : '';
    if (this.isPlain) {
      console.log(`Deployed: ${result.filesChanged} changed, ${result.filesDeleted} deleted (${formatDuration(result.deploymentTime)})${timeStr}`);
    } else {
      console.log(`  ${ANSI.green}✓ Deployed${ANSI.reset} ${result.filesChanged} changed, ${result.filesDeleted} deleted ${ANSI.dim}(${formatDuration(result.deploymentTime)})${timeStr}${ANSI.reset}`);
      if (result.applications && result.applications.length > 0) {
        console.log(`  ${ANSI.dim}  Applications: ${result.applications.join(', ')}${ANSI.reset}`);
      }
    }
  }

  noChanges(): void {
    if (this.silent) return;
    if (this.isPlain) {
      console.log('No changes to deploy');
    } else {
      console.log(`  ${ANSI.green}✓ No changes${ANSI.reset}`);
    }
  }

  hashFetchFailed(reason: string, retriesUsed: number): void {
    if (this.silent) return;
    if (this.isPlain) {
      console.log(`WARNING: Hash fetch failed after ${retriesUsed} retries: ${reason}`);
      console.log('Falling back to full WAR upload');
    } else {
      console.log(`  ${ANSI.yellow}⚠ Hash fetch failed after ${retriesUsed} retries: ${reason}${ANSI.reset}`);
      console.log(`  ${ANSI.yellow}  Falling back to full WAR upload${ANSI.reset}`);
    }
  }

  remoteHasNoWar(): void {
    if (this.silent) return;
    if (this.isPlain) {
      console.log('Remote has no WAR file (first deployment)');
    } else {
      console.log(`  ${ANSI.dim}Remote has no WAR file (first deployment)${ANSI.reset}`);
    }
  }

  failed(error: string): void {
    if (this.silent) return;
    if (this.isPlain) {
      console.log(`Failed: ${error}`);
    } else {
      console.log(`  ${ANSI.red}✗ Failed: ${error}${ANSI.reset}`);
    }
  }

  retrying(attempt: number, maxAttempts: number, delayMs: number, lastError?: string): void {
    if (this.silent) return;
    const delaySec = Math.round(delayMs / 1000);
    if (this.isPlain) {
      console.log(`Retry ${attempt}/${maxAttempts} in ${delaySec}s${lastError ? `: ${lastError}` : ''}`);
    } else {
      console.log(`  ${ANSI.yellow}↻ Retry ${attempt}/${maxAttempts} in ${delaySec}s${lastError ? ` (${lastError})` : ''}${ANSI.reset}`);
    }
  }

  /**
   * Show that we're waiting for a long-running deployment to complete
   * Part of ProgressCallback interface
   */
  waitingForDeployment(elapsedSeconds: number, currentStep?: string): void {
    if (this.silent) return;
    const stepInfo = currentStep ? ` (${currentStep})` : '';
    if (this.isPlain) {
      console.log(`  Waiting for deployment... ${elapsedSeconds}s${stepInfo}`);
    } else {
      // Use carriage return to update in place
      process.stdout.write(`\r${ANSI.clearLine}  ${ANSI.cyan}⏳${ANSI.reset} Deploying... ${elapsedSeconds}s${ANSI.dim}${stepInfo}${ANSI.reset}    `);
    }
  }

  /**
   * Show that the request timed out but deployment may still be running
   */
  deploymentTimedOut(): void {
    if (this.silent) return;
    if (this.isPlain) {
      console.log('  Request timed out, checking deployment status...');
    } else {
      console.log(`\n  ${ANSI.yellow}⚠ Request timed out, checking deployment status...${ANSI.reset}`);
    }
  }

  /**
   * Show that deployment is already in progress (409 response)
   */
  deploymentInProgress(): void {
    if (this.silent) return;
    if (this.isPlain) {
      console.log('  Deployment already in progress, waiting for completion...');
    } else {
      console.log(`  ${ANSI.yellow}⏳ Deployment in progress, waiting for completion...${ANSI.reset}`);
    }
  }

  /**
   * Clear the waiting line and move to next line
   */
  clearWaitingLine(): void {
    if (this.silent) return;
    if (!this.isPlain) {
      process.stdout.write(`\r${ANSI.clearLine}`);
    }
  }

  /**
   * Show verification step
   */
  verifyingDeployment(): void {
    if (this.isPlain) {
      console.log('  Verifying deployment completed...');
    } else {
      console.log(`  ${ANSI.cyan}🔍${ANSI.reset} Verifying deployment completed...`);
    }
  }

  summary(successful: number, total: number, failed: number, skipped?: number): void {
    console.log('');
    const skippedText = skipped && skipped > 0 ? `, ${skipped} skipped` : '';
    if (this.isPlain) {
      console.log(`Deployment complete: ${successful}/${total} hosts successful${failed > 0 ? `, ${failed} failed` : ''}${skippedText}`);
    } else {
      if (failed === 0 && (!skipped || skipped === 0)) {
        console.log(`${ANSI.bold}${ANSI.green}✓ Deployment complete${ANSI.reset}: ${successful}/${total} hosts successful`);
      } else {
        const failedPart = failed > 0 ? `, ${ANSI.red}${failed} failed${ANSI.reset}` : '';
        const skippedPart = skipped && skipped > 0 ? `, ${ANSI.yellow}${skipped} skipped${ANSI.reset}` : '';
        console.log(`${ANSI.bold}${ANSI.yellow}⚠ Deployment complete${ANSI.reset}: ${successful}/${total} hosts successful${failedPart}${skippedPart}`);
      }
    }
  }

  // ===== Canary/Batch Deployment Methods =====

  /**
   * Show the strategy being used
   */
  showStrategy(strategyName: string, isCanary: boolean): void {
    if (this.isPlain) {
      console.log(`  Strategy: ${strategyName}`);
    } else {
      const strategyLabel = isCanary
        ? `${ANSI.cyan}canary${ANSI.reset} (${strategyName})`
        : strategyName;
      console.log(`${ANSI.dim}  Strategy: ${ANSI.reset}${strategyLabel}`);
    }
  }

  /**
   * Show batch header for canary deployments
   */
  showBatchHeader(batchNumber: number, totalBatches: number, hostCount: number, batchLabel: string): void {
    const batchName = batchLabel === 'rest' ? 'remaining' : batchLabel;
    const hostsWord = hostCount === 1 ? 'host' : 'hosts';

    if (this.isPlain) {
      console.log(`\nBatch ${batchNumber}/${totalBatches}: deploying to ${hostCount} ${hostsWord} (${batchName})`);
    } else {
      console.log(`\n${ANSI.bold}${ANSI.blue}━━━ Batch ${batchNumber}/${totalBatches}${ANSI.reset} ${ANSI.dim}(${hostCount} ${hostsWord}${batchLabel === 'rest' ? ' - remaining' : ''})${ANSI.reset}`);
    }
  }

  /**
   * Show batch completion result
   */
  showBatchResult(batchNumber: number, successes: number, failures: number): void {
    if (this.isPlain) {
      console.log(`Batch ${batchNumber}: ${successes} succeeded, ${failures} failed`);
    } else {
      if (failures === 0) {
        console.log(`${ANSI.dim}  Batch ${batchNumber}:${ANSI.reset} ${ANSI.green}✓ ${successes} succeeded${ANSI.reset}`);
      } else {
        console.log(`${ANSI.dim}  Batch ${batchNumber}:${ANSI.reset} ${ANSI.green}${successes} succeeded${ANSI.reset}, ${ANSI.red}${failures} failed${ANSI.reset}`);
      }
    }
  }

  /**
   * Show canary abort message when a batch fails
   */
  showCanaryAbort(failedBatch: number, skippedHosts: number): void {
    const hostsWord = skippedHosts === 1 ? 'host' : 'hosts';
    if (this.isPlain) {
      console.log(`\nCanary failed at batch ${failedBatch}. Aborting deployment.`);
      console.log(`Skipped ${skippedHosts} remaining ${hostsWord}.`);
    } else {
      console.log(`\n${ANSI.red}${ANSI.bold}✗ Canary failed${ANSI.reset} at batch ${failedBatch}. ${ANSI.yellow}Skipping ${skippedHosts} remaining ${hostsWord}.${ANSI.reset}`);
    }
  }

  /**
   * Show canary success message before proceeding to next batch
   */
  showCanaryProceeding(nextBatch: number, totalBatches: number): void {
    if (!this.isPlain) {
      console.log(`${ANSI.dim}  Proceeding to batch ${nextBatch}/${totalBatches}...${ANSI.reset}`);
    }
  }
}
