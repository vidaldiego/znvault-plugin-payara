// Path: src/cli/listr-deploy.ts
// Listr2-based deployment executor for clean concurrent progress display

import { Listr, ListrTask, PRESET_TIMER } from 'listr2';
import type { WarFileHashes } from '../types.js';
import type { CLIPluginContext, DeploymentStrategy, DeployToHostResult } from './types.js';
import type { HostAnalysis } from './unified-progress.js';
import { deployToHost } from './commands/deploy.js';
import { ProgressReporter } from './progress.js';
import { formatSize, formatDuration } from './formatters.js';

/**
 * Context passed through Listr tasks
 */
export interface DeployContext {
  /** Results per host */
  results: Map<string, DeployToHostResult>;
  /** Whether deployment was aborted (canary failure) */
  aborted: boolean;
  /** Failed batch number if aborted */
  failedBatch?: number;
  /** Number of skipped hosts */
  skipped: number;
  /** Successful count */
  successful: number;
  /** Failed count */
  failed: number;
}

/**
 * Options for Listr deployment
 */
export interface ListrDeployOptions {
  ctx: CLIPluginContext;
  warPath: string;
  localHashes: WarFileHashes;
  port: number;
  force: boolean;
  analysisMap: Map<string, HostAnalysis>;
}

/**
 * Create a deployment task for a single host
 */
function createHostTask(
  host: string,
  options: ListrDeployOptions
): ListrTask<DeployContext> {
  const analysis = options.analysisMap.get(host);
  const filesInfo = analysis
    ? `+${analysis.filesChanged} -${analysis.filesDeleted} (${formatSize(analysis.bytesToUpload)})`
    : '';

  return {
    title: `${host} ${filesInfo}`,
    task: async (ctx, task) => {
      const startTime = Date.now();

      // Skip hosts with no changes
      if (analysis && analysis.filesChanged === 0 && analysis.filesDeleted === 0) {
        task.title = `${host} - no changes`;
        ctx.results.set(host, {
          success: true,
          result: {
            success: true,
            filesChanged: 0,
            filesDeleted: 0,
            message: 'No changes',
            deploymentTime: 0,
            appName: '',
          },
        });
        ctx.successful++;
        return;
      }

      // Create a silent progress reporter for this host
      const progress = new ProgressReporter(options.ctx.isPlainMode());
      progress.setSilent(true);
      progress.setHost(host);

      // Update task output as deployment progresses
      let lastProgress = '';
      progress.setOnProgress((_host, filesUploaded, _bytes) => {
        const total = analysis?.filesChanged ?? 0;
        const pct = total > 0 ? Math.round((filesUploaded / total) * 100) : 0;
        lastProgress = `Uploading ${filesUploaded}/${total} files (${pct}%)`;
        task.output = lastProgress;
      });

      progress.setOnDeploying(() => {
        task.output = 'Deploying via asadmin...';
      });

      task.output = 'Starting deployment...';

      const result = await deployToHost(
        options.ctx,
        host,
        options.port,
        options.warPath,
        options.localHashes,
        options.force,
        progress
      );

      const elapsed = formatDuration(Date.now() - startTime);
      ctx.results.set(host, result);

      if (result.success) {
        ctx.successful++;
        task.title = `${host} - deployed (${elapsed})`;
      } else {
        ctx.failed++;
        const errorMsg = result.error?.substring(0, 50) ?? 'Unknown error';
        task.title = `${host} - FAILED: ${errorMsg}`;
        throw new Error(result.error ?? 'Deployment failed');
      }
    },
    rendererOptions: {
      persistentOutput: false,
      outputBar: 1,
    },
  };
}

/**
 * Execute deployment using Listr2 for proper concurrent progress display
 */
export async function executeListrDeployment(
  strategy: DeploymentStrategy,
  hosts: string[],
  options: ListrDeployOptions
): Promise<DeployContext> {
  const isPlain = options.ctx.isPlainMode();

  // Initialize context
  const ctx: DeployContext = {
    results: new Map(),
    aborted: false,
    skipped: 0,
    successful: 0,
    failed: 0,
  };

  // Build tasks based on strategy
  const tasks: ListrTask<DeployContext>[] = [];
  let hostIndex = 0;

  for (let batchIndex = 0; batchIndex < strategy.batches.length && hostIndex < hosts.length; batchIndex++) {
    const batch = strategy.batches[batchIndex]!;
    const batchSize = batch.count === 'rest'
      ? hosts.length - hostIndex
      : Math.min(batch.count, hosts.length - hostIndex);

    if (batchSize <= 0) break;

    const batchHosts = hosts.slice(hostIndex, hostIndex + batchSize);
    hostIndex += batchSize;

    // Create batch task with subtasks for each host
    const batchLabel = batch.label ?? `Batch ${batchIndex + 1}`;
    const batchTitle = strategy.isCanary
      ? `${batchLabel} (${batchHosts.length} host${batchHosts.length > 1 ? 's' : ''})`
      : undefined;

    const hostTasks = batchHosts.map(host => createHostTask(host, options));

    if (strategy.isCanary) {
      // Canary: show batch grouping
      tasks.push({
        title: batchTitle,
        task: (ctx, task) => {
          return task.newListr(hostTasks, {
            concurrent: batchHosts.length > 1,
            exitOnError: true,
            rendererOptions: {
              collapseSubtasks: false,
            },
          });
        },
        exitOnError: true,
      });
    } else if (strategy.batches[0]?.count === 'rest' || strategy.batches.length === 1) {
      // Parallel or sequential: flat list
      tasks.push(...hostTasks);
    } else {
      // Multi-batch non-canary
      tasks.push({
        title: batchTitle,
        task: (ctx, task) => {
          return task.newListr(hostTasks, {
            concurrent: batchHosts.length > 1,
            exitOnError: false,
          });
        },
      });
    }
  }

  // Determine concurrency based on strategy
  const isConcurrent = !strategy.isCanary && strategy.batches[0]?.count === 'rest';

  // Create and run Listr
  // Use type assertion for renderer since TypeScript has trouble with union inference
  const listrOptions = {
    concurrent: isConcurrent,
    exitOnError: strategy.isCanary,
    collectErrors: 'minimal' as const,
    rendererOptions: {
      collapseSubtasks: false,
      collapseErrors: false,
      timer: PRESET_TIMER,
    },
    ctx,
  };

  const listr = isPlain
    ? new Listr<DeployContext, 'simple'>(tasks, { ...listrOptions, renderer: 'simple' })
    : new Listr<DeployContext, 'default'>(tasks, { ...listrOptions, renderer: 'default' });

  try {
    await listr.run();
  } catch (err) {
    // Canary failure - mark remaining hosts as skipped
    if (strategy.isCanary) {
      ctx.aborted = true;
      // Find which batch failed
      for (let i = 0; i < strategy.batches.length; i++) {
        let batchStart = 0;
        for (let j = 0; j < i; j++) {
          const b = strategy.batches[j]!;
          batchStart += b.count === 'rest' ? hosts.length : b.count;
        }
        const batch = strategy.batches[i]!;
        const batchSize = batch.count === 'rest' ? hosts.length - batchStart : batch.count;
        const batchHosts = hosts.slice(batchStart, batchStart + batchSize);

        // Check if any host in this batch failed
        for (const h of batchHosts) {
          const result = ctx.results.get(h);
          if (result && !result.success) {
            ctx.failedBatch = i + 1;
            break;
          }
        }
        if (ctx.failedBatch) break;
      }

      // Count skipped hosts
      ctx.skipped = hosts.filter(h => !ctx.results.has(h)).length;
    }
  }

  return ctx;
}

/**
 * Print deployment summary
 */
export function printDeploymentSummary(
  ctx: DeployContext,
  totalHosts: number,
  isPlain: boolean
): void {
  console.log('');

  if (ctx.aborted) {
    if (isPlain) {
      console.log(`Canary failed at batch ${ctx.failedBatch}. Skipped ${ctx.skipped} remaining host(s).`);
    } else {
      console.log(`\x1b[31m\x1b[1mCanary failed\x1b[0m at batch ${ctx.failedBatch}. \x1b[33mSkipped ${ctx.skipped} remaining host(s).\x1b[0m`);
    }
  }

  const skippedText = ctx.skipped > 0 ? `, ${ctx.skipped} skipped` : '';
  const failedText = ctx.failed > 0 ? `, ${ctx.failed} failed` : '';

  if (isPlain) {
    console.log(`Deployment complete: ${ctx.successful}/${totalHosts} hosts successful${failedText}${skippedText}`);
  } else {
    if (ctx.failed === 0 && ctx.skipped === 0) {
      console.log(`\x1b[32m\x1b[1m✓ Deployment complete\x1b[0m: ${ctx.successful}/${totalHosts} hosts successful`);
    } else {
      console.log(`\x1b[33m\x1b[1m⚠ Deployment complete\x1b[0m: ${ctx.successful}/${totalHosts} hosts successful${failedText}${skippedText}`);
    }
  }
}
