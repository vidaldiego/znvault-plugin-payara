// Path: src/cli/unified-progress.ts
// Unified progress display for multi-host deployments

import { ANSI } from './constants.js';
import { formatSize, formatDuration, progressBar } from './formatters.js';

/**
 * Host deployment state
 */
export type HostState =
  | 'analyzing'
  | 'waiting'
  | 'uploading'
  | 'deploying'
  | 'deployed'
  | 'failed'
  | 'skipped';

/**
 * Per-host status tracking
 */
export interface HostStatus {
  host: string;
  state: HostState;
  /** Number of files to upload */
  filesTotal: number;
  /** Number of files uploaded so far */
  filesUploaded: number;
  /** Total bytes to upload */
  bytesTotal: number;
  /** Bytes uploaded so far */
  bytesUploaded: number;
  /** Time when deployment started */
  startedAt?: number;
  /** Time when deployment completed */
  completedAt?: number;
  /** Error message if failed */
  error?: string;
  /** Current step description */
  currentStep?: string;
}

/**
 * Analysis result for a host
 */
export interface HostAnalysis {
  host: string;
  success: boolean;
  error?: string;
  filesChanged: number;
  filesDeleted: number;
  bytesToUpload: number;
  isFullUpload: boolean;
  changedFiles?: string[];
  deletedFiles?: string[];
}

/**
 * Unified progress display options
 */
export interface UnifiedProgressOptions {
  /** Plain mode (no ANSI colors/cursor movement) */
  plain?: boolean;
  /** Show individual file names during upload */
  showFiles?: boolean;
  /** Maximum hosts to show in status display */
  maxHostsDisplay?: number;
}

/**
 * Unified progress display for multi-host deployments
 *
 * Provides a single progress bar with per-host status lines
 */
export class UnifiedProgress {
  private hosts: Map<string, HostStatus> = new Map();
  private hostOrder: string[] = [];
  private isPlain: boolean;
  private showFiles: boolean;
  private maxHostsDisplay: number;
  private lastRenderLines = 0;
  private isRendering = false;
  private totalFilesAcrossHosts = 0;
  private totalBytesAcrossHosts = 0;
  private strategyName?: string;
  private currentBatch?: { number: number; total: number };

  constructor(options: UnifiedProgressOptions = {}) {
    this.isPlain = options.plain ?? false;
    this.showFiles = options.showFiles ?? false;
    this.maxHostsDisplay = options.maxHostsDisplay ?? 10;
  }

  /**
   * Initialize hosts for tracking
   */
  initHosts(hosts: string[]): void {
    this.hostOrder = [...hosts];
    for (const host of hosts) {
      this.hosts.set(host, {
        host,
        state: 'analyzing',
        filesTotal: 0,
        filesUploaded: 0,
        bytesTotal: 0,
        bytesUploaded: 0,
      });
    }
  }

  /**
   * Set strategy name for display
   */
  setStrategy(name: string): void {
    this.strategyName = name;
  }

  /**
   * Set current batch info for canary display
   */
  setBatch(number: number, total: number): void {
    this.currentBatch = { number, total };
  }

  /**
   * Clear batch info
   */
  clearBatch(): void {
    this.currentBatch = undefined;
  }

  /**
   * Update host analysis result
   */
  setHostAnalysis(host: string, analysis: HostAnalysis): void {
    const status = this.hosts.get(host);
    if (!status) return;

    if (analysis.success) {
      status.state = 'waiting';
      status.filesTotal = analysis.filesChanged;
      status.bytesTotal = analysis.bytesToUpload;
    } else {
      status.state = 'failed';
      status.error = analysis.error;
    }
  }

  /**
   * Calculate totals after analysis
   */
  calculateTotals(): void {
    this.totalFilesAcrossHosts = 0;
    this.totalBytesAcrossHosts = 0;

    for (const status of this.hosts.values()) {
      if (status.state !== 'failed' && status.state !== 'skipped') {
        this.totalFilesAcrossHosts += status.filesTotal;
        this.totalBytesAcrossHosts += status.bytesTotal;
      }
    }
  }

  /**
   * Mark host as starting deployment
   */
  startHost(host: string): void {
    const status = this.hosts.get(host);
    if (!status) return;

    status.state = 'uploading';
    status.startedAt = Date.now();
    this.render();
  }

  /**
   * Update host upload progress
   */
  updateHostProgress(host: string, filesUploaded: number, bytesUploaded: number): void {
    const status = this.hosts.get(host);
    if (!status) return;

    status.filesUploaded = filesUploaded;
    status.bytesUploaded = bytesUploaded;
    this.render();
  }

  /**
   * Mark host as deploying (asadmin phase)
   */
  setHostDeploying(host: string, step?: string): void {
    const status = this.hosts.get(host);
    if (!status) return;

    status.state = 'deploying';
    status.currentStep = step;
    // Mark all files as uploaded when we reach deploy phase
    status.filesUploaded = status.filesTotal;
    status.bytesUploaded = status.bytesTotal;
    this.render();
  }

  /**
   * Mark host as deployed successfully
   */
  setHostDeployed(host: string): void {
    const status = this.hosts.get(host);
    if (!status) return;

    status.state = 'deployed';
    status.completedAt = Date.now();
    this.render();
  }

  /**
   * Mark host as failed
   */
  setHostFailed(host: string, error: string): void {
    const status = this.hosts.get(host);
    if (!status) return;

    status.state = 'failed';
    status.error = error;
    status.completedAt = Date.now();
    this.render();
  }

  /**
   * Mark host as skipped
   */
  setHostSkipped(host: string): void {
    const status = this.hosts.get(host);
    if (!status) return;

    status.state = 'skipped';
    this.render();
  }

  /**
   * Get total progress across all hosts
   */
  private getTotalProgress(): { files: number; totalFiles: number; bytes: number; totalBytes: number } {
    let files = 0;
    let bytes = 0;

    for (const status of this.hosts.values()) {
      if (status.state !== 'failed' && status.state !== 'skipped' && status.state !== 'analyzing') {
        files += status.filesUploaded;
        bytes += status.bytesUploaded;
      }
    }

    return {
      files,
      totalFiles: this.totalFilesAcrossHosts,
      bytes,
      totalBytes: this.totalBytesAcrossHosts,
    };
  }

  /**
   * Get state icon
   */
  private getStateIcon(state: HostState): string {
    if (this.isPlain) {
      switch (state) {
        case 'analyzing': return '[...]';
        case 'waiting': return '[   ]';
        case 'uploading': return '[>>>]';
        case 'deploying': return '[~~~]';
        case 'deployed': return '[ OK]';
        case 'failed': return '[ERR]';
        case 'skipped': return '[SKP]';
      }
    }

    switch (state) {
      case 'analyzing': return `${ANSI.dim}◌${ANSI.reset}`;
      case 'waiting': return `${ANSI.dim}◌${ANSI.reset}`;
      case 'uploading': return `${ANSI.cyan}⬆${ANSI.reset}`;
      case 'deploying': return `${ANSI.yellow}⏳${ANSI.reset}`;
      case 'deployed': return `${ANSI.green}✓${ANSI.reset}`;
      case 'failed': return `${ANSI.red}✗${ANSI.reset}`;
      case 'skipped': return `${ANSI.yellow}○${ANSI.reset}`;
    }
  }

  /**
   * Format host status line
   */
  private formatHostLine(status: HostStatus): string {
    const icon = this.getStateIcon(status.state);
    const elapsed = status.startedAt
      ? formatDuration(Date.now() - status.startedAt)
      : '';

    if (this.isPlain) {
      switch (status.state) {
        case 'analyzing':
          return `${icon} ${status.host}: analyzing...`;
        case 'waiting':
          return `${icon} ${status.host}: waiting (+${status.filesTotal} files)`;
        case 'uploading':
          return `${icon} ${status.host}: uploading ${status.filesUploaded}/${status.filesTotal} files`;
        case 'deploying':
          return `${icon} ${status.host}: deploying... ${elapsed}`;
        case 'deployed':
          return `${icon} ${status.host}: deployed (${elapsed})`;
        case 'failed':
          return `${icon} ${status.host}: FAILED - ${status.error}`;
        case 'skipped':
          return `${icon} ${status.host}: skipped`;
      }
    }

    // Colored output
    const hostPadded = status.host.padEnd(20);

    switch (status.state) {
      case 'analyzing':
        return `  ${icon} ${ANSI.dim}${hostPadded}${ANSI.reset} analyzing...`;
      case 'waiting':
        return `  ${icon} ${ANSI.dim}${hostPadded}${ANSI.reset} ${ANSI.dim}waiting${ANSI.reset}`;
      case 'uploading': {
        const pct = status.filesTotal > 0
          ? Math.round((status.filesUploaded / status.filesTotal) * 100)
          : 0;
        return `  ${icon} ${hostPadded} ${ANSI.cyan}uploading${ANSI.reset} ${pct}%`;
      }
      case 'deploying':
        return `  ${icon} ${hostPadded} ${ANSI.yellow}deploying...${ANSI.reset} ${ANSI.dim}${elapsed}${ANSI.reset}`;
      case 'deployed':
        return `  ${icon} ${hostPadded} ${ANSI.green}deployed${ANSI.reset} ${ANSI.dim}(${elapsed})${ANSI.reset}`;
      case 'failed':
        return `  ${icon} ${hostPadded} ${ANSI.red}failed${ANSI.reset} ${ANSI.dim}${status.error?.substring(0, 30)}${ANSI.reset}`;
      case 'skipped':
        return `  ${icon} ${ANSI.dim}${hostPadded} skipped${ANSI.reset}`;
    }
  }

  /**
   * Render the progress display
   */
  render(): void {
    if (this.isRendering) return;
    this.isRendering = true;

    try {
      const lines: string[] = [];
      const progress = this.getTotalProgress();

      // Clear previous render
      if (!this.isPlain && this.lastRenderLines > 0) {
        process.stdout.write(`\x1b[${this.lastRenderLines}A`);
        for (let i = 0; i < this.lastRenderLines; i++) {
          process.stdout.write(`${ANSI.clearLine}\n`);
        }
        process.stdout.write(`\x1b[${this.lastRenderLines}A`);
      }

      // Batch header for canary
      if (this.currentBatch) {
        if (this.isPlain) {
          lines.push(`\nBatch ${this.currentBatch.number}/${this.currentBatch.total}`);
        } else {
          lines.push(`\n${ANSI.bold}${ANSI.blue}━━━ Batch ${this.currentBatch.number}/${this.currentBatch.total}${ANSI.reset}`);
        }
      }

      // Progress bar (only if we have work to do)
      if (progress.totalFiles > 0) {
        const pct = Math.round((progress.files / progress.totalFiles) * 100);
        if (this.isPlain) {
          lines.push(`Progress: ${progress.files}/${progress.totalFiles} files (${pct}%)`);
        } else {
          const bar = progressBar(progress.files, progress.totalFiles, 30);
          lines.push('');
          lines.push(`  ${bar} ${pct}% ${ANSI.dim}(${progress.files}/${progress.totalFiles} files)${ANSI.reset}`);
          lines.push('');
        }
      }

      // Host status lines
      const hostsToShow = this.hostOrder.slice(0, this.maxHostsDisplay);
      for (const host of hostsToShow) {
        const status = this.hosts.get(host);
        if (status) {
          lines.push(this.formatHostLine(status));
        }
      }

      // Show count if more hosts than display limit
      if (this.hostOrder.length > this.maxHostsDisplay) {
        const remaining = this.hostOrder.length - this.maxHostsDisplay;
        lines.push(this.isPlain
          ? `  ... and ${remaining} more hosts`
          : `  ${ANSI.dim}... and ${remaining} more hosts${ANSI.reset}`);
      }

      // Output
      const output = lines.join('\n');
      if (this.isPlain) {
        // In plain mode, just print without cursor manipulation
        console.log(output);
      } else {
        process.stdout.write(output + '\n');
        this.lastRenderLines = lines.length;
      }
    } finally {
      this.isRendering = false;
    }
  }

  /**
   * Show analysis header
   */
  showAnalysisHeader(): void {
    if (this.isPlain) {
      console.log(`\nAnalyzing ${this.hostOrder.length} hosts...`);
    } else {
      console.log(`\n${ANSI.dim}Analyzing ${this.hostOrder.length} hosts...${ANSI.reset}`);
    }
  }

  /**
   * Show analysis result for a host
   */
  showAnalysisResult(analysis: HostAnalysis): void {
    if (this.isPlain) {
      if (analysis.success) {
        const files = analysis.filesChanged + analysis.filesDeleted;
        const mode = analysis.isFullUpload ? 'full' : 'diff';
        console.log(`  ${analysis.host}: +${analysis.filesChanged} -${analysis.filesDeleted} (${formatSize(analysis.bytesToUpload)}, ${mode})`);
      } else {
        console.log(`  ${analysis.host}: ERROR - ${analysis.error}`);
      }
    } else {
      if (analysis.success) {
        const changeStr = analysis.filesChanged > 0
          ? `${ANSI.green}+${analysis.filesChanged}${ANSI.reset}`
          : `${ANSI.dim}+0${ANSI.reset}`;
        const deleteStr = analysis.filesDeleted > 0
          ? `${ANSI.red}-${analysis.filesDeleted}${ANSI.reset}`
          : `${ANSI.dim}-0${ANSI.reset}`;
        const mode = analysis.isFullUpload
          ? `${ANSI.yellow}full${ANSI.reset}`
          : `${ANSI.dim}diff${ANSI.reset}`;
        console.log(`  ${ANSI.green}✓${ANSI.reset} ${analysis.host}: ${changeStr} ${deleteStr} ${ANSI.dim}(${formatSize(analysis.bytesToUpload)}, ${mode})${ANSI.reset}`);
      } else {
        console.log(`  ${ANSI.red}✗${ANSI.reset} ${analysis.host}: ${ANSI.red}${analysis.error}${ANSI.reset}`);
      }
    }
  }

  /**
   * Show analysis summary
   */
  showAnalysisSummary(): { totalFiles: number; totalBytes: number } {
    this.calculateTotals();

    const activeHosts = Array.from(this.hosts.values()).filter(
      h => h.state !== 'failed' && h.state !== 'skipped'
    ).length;

    if (this.isPlain) {
      console.log(`\nReady to deploy: ${this.totalFilesAcrossHosts} files (${formatSize(this.totalBytesAcrossHosts)}) to ${activeHosts} hosts`);
    } else {
      console.log(`\n${ANSI.dim}Ready: ${this.totalFilesAcrossHosts} files (${formatSize(this.totalBytesAcrossHosts)}) → ${activeHosts} hosts${ANSI.reset}`);
    }

    return {
      totalFiles: this.totalFilesAcrossHosts,
      totalBytes: this.totalBytesAcrossHosts,
    };
  }

  /**
   * Show no changes message
   */
  showNoChanges(host: string): void {
    const status = this.hosts.get(host);
    if (status) {
      status.state = 'deployed';
      status.completedAt = Date.now();
    }

    if (this.isPlain) {
      console.log(`  ${host}: no changes`);
    } else {
      console.log(`  ${ANSI.green}✓${ANSI.reset} ${host}: ${ANSI.dim}no changes${ANSI.reset}`);
    }
  }

  /**
   * Show final summary
   */
  showSummary(): { successful: number; failed: number; skipped: number } {
    let successful = 0;
    let failed = 0;
    let skipped = 0;

    for (const status of this.hosts.values()) {
      switch (status.state) {
        case 'deployed':
          successful++;
          break;
        case 'failed':
          failed++;
          break;
        case 'skipped':
          skipped++;
          break;
      }
    }

    const total = this.hostOrder.length;
    const skippedText = skipped > 0 ? `, ${skipped} skipped` : '';

    console.log('');
    if (this.isPlain) {
      console.log(`Deployment complete: ${successful}/${total} hosts successful${failed > 0 ? `, ${failed} failed` : ''}${skippedText}`);
    } else {
      if (failed === 0 && skipped === 0) {
        console.log(`${ANSI.bold}${ANSI.green}✓ Deployment complete${ANSI.reset}: ${successful}/${total} hosts successful`);
      } else {
        const failedPart = failed > 0 ? `, ${ANSI.red}${failed} failed${ANSI.reset}` : '';
        const skippedPart = skipped > 0 ? `, ${ANSI.yellow}${skipped} skipped${ANSI.reset}` : '';
        console.log(`${ANSI.bold}${ANSI.yellow}⚠ Deployment complete${ANSI.reset}: ${successful}/${total} hosts successful${failedPart}${skippedPart}`);
      }
    }

    return { successful, failed, skipped };
  }

  /**
   * Show canary abort message
   */
  showCanaryAbort(batchNumber: number, skippedCount: number): void {
    // Mark remaining hosts as skipped
    for (const status of this.hosts.values()) {
      if (status.state === 'waiting') {
        status.state = 'skipped';
      }
    }

    const hostsWord = skippedCount === 1 ? 'host' : 'hosts';
    if (this.isPlain) {
      console.log(`\nCanary failed at batch ${batchNumber}. Skipping ${skippedCount} remaining ${hostsWord}.`);
    } else {
      console.log(`\n${ANSI.red}${ANSI.bold}✗ Canary failed${ANSI.reset} at batch ${batchNumber}. ${ANSI.yellow}Skipping ${skippedCount} remaining ${hostsWord}.${ANSI.reset}`);
    }
  }

  /**
   * Finalize display (move cursor below status area)
   */
  finalize(): void {
    if (!this.isPlain) {
      // Ensure we're on a new line
      console.log('');
    }
  }

  /**
   * Get host status
   */
  getHostStatus(host: string): HostStatus | undefined {
    return this.hosts.get(host);
  }

  /**
   * Get all hosts with their states
   */
  getAllStatuses(): HostStatus[] {
    return this.hostOrder.map(h => this.hosts.get(h)!);
  }
}
