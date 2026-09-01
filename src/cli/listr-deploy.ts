// Path: src/cli/listr-deploy.ts
// Listr2-based deployment executor for clean concurrent progress display

import { Listr, ListrTask, PRESET_TIMER } from 'listr2';
import type { LocalWarArtifactSnapshot, WarFileHashes } from '../types.js';
import type { CLIPluginContext, DeploymentStrategy, DeployToHostResult, HealthCheckConfig, HAProxyConfig, QuiesceConfig } from './types.js';
import { deployToHost } from './commands/deploy.js';
import { ProgressReporter } from './progress.js';
import type {
  HostAnalysis,
  ConnectionInfo,
} from '@zincapp/znvault-deploy-core';
import {
  performHealthCheck,
  formatSize,
  formatDuration,
  formatTime,
  getTLSIndicator,
  drainServer,
  readyServer,
  quiesceScheduler,
  pollUntilDrained,
  resumeScheduler,
  type AgentRequestAuth,
} from '@zincapp/znvault-deploy-core';
import { getErrorMessage } from '../utils/error.js';

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
  /** Failed count for serving nodes. */
  failed: number;
  /** Health check failures */
  healthCheckFailed: number;
  /**
   * Worker-node deploy failures (hosts NOT in haproxy.serverMap).
   * Tracked separately from `failed` because a worker failure does not abort the
   * serving roll. It still blocks post-deploy migration and the final command
   * exits non-zero until every selected worker has a verified receipt.
   */
  workerFailed: number;
}

/**
 * Options for Listr deployment
 */
export interface ListrDeployOptions {
  ctx: CLIPluginContext;
  warPath: string;
  localHashes: WarFileHashes;
  /** Immutable local bytes captured before preflight/migrations. */
  artifactSnapshot?: LocalWarArtifactSnapshot;
  port: number;
  force: boolean;
  analysisMap: Map<string, HostAnalysis>;
  /** Optional health check configuration */
  healthCheck?: HealthCheckConfig;
  /** Whether to use HTTPS for agent connections */
  useTLS?: boolean;
  /** Dedicated per-host credentials for the protected Payara namespace. */
  mutationAuthTokens: ReadonlyMap<string, string>;
  /** Connection info per host (for TLS auto-detection) */
  connectionMap?: Map<string, ConnectionInfo>;
  /** HAProxy drain/ready configuration */
  haproxy?: HAProxyConfig;
  /**
   * Scheduler quiesce configuration (Part 5a).
   * When absent or enabled is false, deployment is byte-identical to today.
   */
  quiesce?: QuiesceConfig;
  /**
   * Per-host configuration overrides (Part 5a).
   */
  hostConfigs?: Record<string, {
    quiesceTimeoutMs?: number;
  }>;
  /**
   * When true, suppress the "config mixes serving and worker nodes" warning.
   * Set by the multi-class orchestrator: it drives ONE node class per run, so
   * the in-class partition is expected to be homogeneous and the warning is noise.
   */
  suppressMixedClassWarning?: boolean;
}

/**
 * A host contributes to rollout coverage only after the CLI has received the
 * server's terminal, inventory-verified deployment receipt. The outer success
 * bit alone is not sufficient: it can only describe the transport helper.
 */
export function hasVerifiedDeploymentReceipt(
  result: DeployToHostResult | undefined
): boolean {
  return result?.success === true
    && result.result?.success === true
    && result.result.deployed === true;
}

/** Return the exact expected hosts that do not have a verified receipt. */
export function missingVerifiedDeploymentReceipts(
  ctx: Pick<DeployContext, 'results'>,
  expectedHosts: readonly string[]
): string[] {
  return expectedHosts.filter(host => !hasVerifiedDeploymentReceipt(ctx.results.get(host)));
}

/**
 * Partition hosts into node classes by HAProxy serverMap membership.
 *
 * - **serving**: host IS in `haproxy.serverMap` — routed, user traffic, needs
 *   drain, canary-meaningful. The operator's strategy applies to these only.
 * - **workers**: host is NOT in `haproxy.serverMap` — unrouted, no drain,
 *   canary-meaningless. These deploy in a separate, final, non-blocking batch.
 *
 * Guard: with no serverMap (no HAProxy config, or an empty map) there is no
 * class distinction — ALL hosts are treated as serving (one class), preserving
 * the pre-node-class behavior for non-HAProxy and worker-only configs.
 *
 * This is the single source of truth for the split, shared by the deployer and
 * the `--dry-run` plan so they can never diverge.
 */
export function partitionHostsByClass(
  hosts: string[],
  haproxy: HAProxyConfig | undefined
): { serving: string[]; workers: string[] } {
  const serverMap = haproxy?.serverMap;
  const hasServerMap = !!serverMap && Object.keys(serverMap).length > 0;
  if (!hasServerMap) {
    return { serving: [...hosts], workers: [] };
  }
  return {
    serving: hosts.filter(h => serverMap![h]),
    workers: hosts.filter(h => !serverMap![h]),
  };
}

/**
 * Create a deployment task for a single host.
 *
 * @param isWorker When true, the host is a worker node (not in
 *   haproxy.serverMap). Its deploy is NON-BLOCKING: a failure is recorded in
 *   `ctx.workerFailed` (not `ctx.failed`) and is NOT rethrown, so it does not
 *   abort the serving roll. The command-level gate still blocks post-deploy
 *   migration and exits non-zero for this incomplete selected rollout.
 */
export function createHostTask(
  host: string,
  options: ListrDeployOptions,
  isWorker = false
): ListrTask<DeployContext> {
  const analysis = options.analysisMap.get(host);
  const connInfo = options.connectionMap?.get(host);
  const isPlain = options.ctx.isPlainMode();

  const filesInfo = analysis
    ? `+${analysis.filesChanged} -${analysis.filesDeleted} (${formatSize(analysis.bytesToUpload)})`
    : '';

  // Add TLS indicator to title if connection info available
  const tlsIndicator = connInfo ? ` ${getTLSIndicator(connInfo, isPlain)}` : '';

  return {
    title: `${host}${tlsIndicator} ${filesInfo}`,
    task: async (ctx, task) => {
      const startTime = Date.now();
      const useTLS = connInfo?.tls ?? options.useTLS ?? false;
      const port = connInfo?.port ?? options.port;
      const forceRecovery = analysis?.isFullUpload === true;

      // HAProxy drain/ready wrapping
      const shouldDrain = options.haproxy && options.haproxy.serverMap[host];
      let drained = false;
      // quiesced must be declared BEFORE the try so the finally can always see it.
      let quiesced = false;
      // Tunnel-resolved connection params declared before the try so both the
      // quiesce step and the finally (resume) share the ONE authoritative source.
      // (const inside a try block is not visible in its finally block.)
      let requestAuth: AgentRequestAuth | undefined;
      let failureRecorded = false;
      let successRecorded = false;
      try {
        const mutationAuthToken = options.mutationAuthTokens.get(host);
        if (!mutationAuthToken) {
          throw new Error(`Payara credential was not loaded for host '${host}'`);
        }
        requestAuth = { bearerToken: mutationAuthToken };

        // --- Drain from HAProxy ---
        if (shouldDrain) {
          task.output = 'Draining from HAProxy...';
          const drainResult = await drainServer(options.haproxy!, host);
          // drainServer fans out to every configured HAProxy. A mixed result
          // means this server is already drained on at least one load balancer,
          // so the failure path must compensate with readyServer in finally.
          drained = drainResult.success || drainResult.results.some(result => result.success);
          if (!drainResult.success) {
            const failedHosts = drainResult.results.filter(r => !r.success).map(r => `${r.host}: ${r.error}`);
            throw new Error(`HAProxy drain failed: ${failedHosts.join('; ')}`);
          }
          const waitSec = options.haproxy!.drainWaitSeconds ?? 5;
          task.output = `Drain wait (${waitSec}s)...`;
          await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
        }

        // --- Quiesce scheduler (runs for every host when enabled) ---
        if (options.quiesce?.enabled) {
          try {
            task.output = 'Quiescing scheduler...';
            const q = await quiesceScheduler(host, port, useTLS, requestAuth);
            if (q.available) {
              quiesced = true;
              const timeoutMs = options.hostConfigs?.[host]?.quiesceTimeoutMs ?? options.quiesce.drainTimeoutMs;
              const pollMs = options.quiesce.pollMs;
              if (q.inFlightUnits > 0) {
                task.output = `Draining ${q.inFlightUnits} in-flight unit(s)...`;
                const poll = await pollUntilDrained(
                  host,
                  port,
                  { pollMs, timeoutMs },
                  useTLS,
                  requestAuth
                );
                if (poll.timedOut) {
                  task.output = `Scheduler drain timed out — proceeding`;
                }
              }
              // poll.available === false (mid-poll unavailable) → proceed silently
            } else {
              // Old znapi or agent error — proceed without quiescing (no resume needed)
              task.output = `Scheduler quiesce unavailable (${q.reason ?? 'n/a'}) — proceeding`;
            }
          } catch {
            // Defensive: quiesce* should never throw, but guard anyway so a bug
            // here can NEVER fail a deploy. Degrades to today's behaviour.
            task.output = 'Scheduler quiesce error — proceeding';
          }
        }

        // --- Deploy ---
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

        const result = options.artifactSnapshot
          ? await deployToHost(
              options.ctx,
              host,
              port,
              options.warPath,
              options.localHashes,
              options.force || forceRecovery,
              progress,
              mutationAuthToken,
              useTLS,
              options.artifactSnapshot
            )
          : await deployToHost(
              options.ctx,
              host,
              port,
              options.warPath,
              options.localHashes,
              options.force || forceRecovery,
              progress,
              mutationAuthToken,
              useTLS
            );

        ctx.results.set(host, result);

        if (!hasVerifiedDeploymentReceipt(result)) {
          const errorMsg = (
            result.error ?? 'Deployment completion was not verified'
          ).substring(0, 50);
          if (isWorker) {
            // Worker failure is non-blocking: record + surface, never abort.
            ctx.workerFailed++;
            failureRecorded = true;
            task.title = `${host}${tlsIndicator} - worker FAILED (non-blocking): ${errorMsg}`;
            return;
          }
          ctx.failed++;
          failureRecorded = true;
          task.title = `${host}${tlsIndicator} - FAILED: ${errorMsg}`;
          throw new Error(result.error ?? 'Deployment completion was not verified');
        }

        // --- Health check ---
        if (options.healthCheck) {
          task.output = 'Running health check...';

          const healthResult = await performHealthCheck(
            host,
            options.healthCheck,
            (attempt, maxAttempts, status, error) => {
              if (error) {
                task.output = `Health check attempt ${attempt}/${maxAttempts}: ${error}`;
              } else if (status !== undefined) {
                task.output = `Health check attempt ${attempt}/${maxAttempts}: HTTP ${status}`;
              } else {
                task.output = `Health check attempt ${attempt}/${maxAttempts}...`;
              }
            }
          );

          const elapsed = formatDuration(Date.now() - startTime);
          const completedAt = result.result?.completedAt;
          const timeStr = completedAt ? ` @ ${formatTime(completedAt)}` : '';

          if (healthResult.success) {
            ctx.successful++;
            successRecorded = true;
            task.title = `${host}${tlsIndicator} - deployed + healthy (${elapsed})${timeStr}`;
          } else {
            const errorMsg = healthResult.error ?? `HTTP ${healthResult.status}`;
            if (isWorker) {
              // Worker health failure is non-blocking: record + surface, never abort.
              ctx.workerFailed++;
              failureRecorded = true;
              task.title = `${host}${tlsIndicator} - worker UNHEALTHY (non-blocking): ${errorMsg}`;
              return;
            }
            ctx.healthCheckFailed++;
            failureRecorded = true;
            task.title = `${host}${tlsIndicator} - deployed but UNHEALTHY: ${errorMsg}`;
            // In canary mode, health check failure should stop deployment
            throw new Error(`Health check failed: ${errorMsg}`);
          }
        } else {
          // No health check configured
          const elapsed = formatDuration(Date.now() - startTime);
          const completedAt = result.result?.completedAt;
          const timeStr = completedAt ? ` @ ${formatTime(completedAt)}` : '';
          ctx.successful++;
          successRecorded = true;
          task.title = `${host}${tlsIndicator} - deployed (${elapsed})${timeStr}`;
        }

        // --- Set ready in HAProxy after successful deploy + health check ---
        if (drained) {
          task.output = 'Setting ready in HAProxy...';
          const readyResult = await readyServer(options.haproxy!, host);
          if (!readyResult.success) {
            const failures = readyResult.results
              .filter(result => !result.success)
              .map(result => `${result.host}: ${result.error ?? 'ready command failed'}`);
            throw new Error(`HAProxy ready failed: ${failures.join('; ')}`);
          }
          drained = false; // Prevent finally from double-restoring
        }
      } catch (err) {
        if (!failureRecorded) {
          const errorMessage = getErrorMessage(err);
          if (!ctx.results.has(host)) {
            ctx.results.set(host, { success: false, error: errorMessage });
          }
          if (successRecorded) {
            ctx.successful = Math.max(0, ctx.successful - 1);
            successRecorded = false;
          }
          if (isWorker) {
            ctx.workerFailed++;
            task.title = `${host}${tlsIndicator} - worker FAILED (non-blocking): ${errorMessage.substring(0, 50)}`;
            return;
          }
          ctx.failed++;
          task.title = `${host}${tlsIndicator} - FAILED: ${errorMessage.substring(0, 50)}`;
        }
        throw err;
      } finally {
        // ALWAYS restore server to ready if we drained it, even on failure
        if (drained && options.haproxy) {
          try { await readyServer(options.haproxy, host); } catch { /* don't mask original error */ }
        }
        // ALWAYS resume the scheduler if we quiesced it, even on deploy failure.
        // resumeScheduler is best-effort (swallows internally); the quiesceTtl
        // auto-resume is the backstop if this call fails.
        if (quiesced && requestAuth) {
          try {
            await resumeScheduler(host, port, useTLS, requestAuth);
          } catch { /* best-effort; auto-resume backstop */ }
        }
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
    healthCheckFailed: 0,
    workerFailed: 0,
  };

  // --- Partition hosts by node class (serving vs worker) ---
  // The operator's strategy applies to serving nodes only; workers deploy in a
  // separate, final, non-blocking batch. See partitionHostsByClass for the rule.
  const { serving, workers } = partitionHostsByClass(hosts, options.haproxy);

  // A finite canary plan without a final R/rest batch must name enough capacity
  // for every serving host. Refuse it before the first drain/deploy rather than
  // silently treating the unmentioned tail as a successful rollout.
  if (strategy.isCanary && !strategy.batches.some(batch => batch.count === 'rest')) {
    const finiteCapacity = strategy.batches.reduce(
      (total, batch) => total + (typeof batch.count === 'number' ? batch.count : 0),
      0
    );
    if (finiteCapacity < serving.length) {
      throw new Error(
        `Deployment strategy '${strategy.name}' covers ${finiteCapacity} of ` +
        `${serving.length} serving hosts; append +R to cover the remainder`
      );
    }
  }

  // Warn on a mixed config: the strategy governs serving nodes only; workers
  // deploy last (parallel, non-blocking).
  if (serving.length > 0 && workers.length > 0 && !options.suppressMixedClassWarning) {
    options.ctx.output.warn(
      `[znvault-deploy] config mixes serving (${serving.join(', ')}) and ` +
      `worker (${workers.join(', ')}) nodes; the strategy applies to serving ` +
      `nodes only — workers deploy last (parallel, non-blocking). Consider a ` +
      `separate config / 'payara deploy war --target' for workers.`
    );
  }

  // Build tasks based on strategy, over SERVING nodes only.
  const tasks: ListrTask<DeployContext>[] = [];
  let hostIndex = 0;

  let batchIndex = 0;
  while (hostIndex < serving.length) {
    // Non-canary strategies are reusable patterns. In particular, sequential
    // is represented as one {count: 1} batch and must repeat until every host
    // has a task. Canary batches are consumed exactly once.
    const strategyBatchIndex = strategy.isCanary
      ? batchIndex
      : batchIndex % strategy.batches.length;
    const batch = strategy.batches[strategyBatchIndex];
    if (!batch) break;
    const batchSize = batch.count === 'rest'
      ? serving.length - hostIndex
      : Math.min(batch.count, serving.length - hostIndex);

    if (batchSize <= 0) break;

    const batchHosts = serving.slice(hostIndex, hostIndex + batchSize);
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
        task: (ctx, task) => task.newListr(hostTasks, {
          concurrent: batchHosts.length > 1,
          exitOnError: true,
          rendererOptions: {
            collapseSubtasks: false,
          },
        }),
        exitOnError: true,
      });
    } else if (strategy.batches[0]?.count === 'rest' || strategy.batches.length === 1) {
      // Parallel or sequential: flat list
      tasks.push(...hostTasks);
    } else {
      // Multi-batch non-canary
      tasks.push({
        title: batchTitle,
        task: (ctx, task) => task.newListr(hostTasks, {
          concurrent: batchHosts.length > 1,
          exitOnError: false,
        }),
      });
    }
    batchIndex++;
  }

  // Determine concurrency based on strategy
  const isConcurrent = !strategy.isCanary && strategy.batches[0]?.count === 'rest';

  // Warn once if quiesce is enabled with a concurrent (parallel) strategy.
  // All nodes will be quiesced at once, fully pausing the scheduler cluster-wide.
  if (options.quiesce?.enabled && isConcurrent) {
    options.ctx.output.warn(
      '[znvault-deploy] quiesce + concurrent strategy: all nodes quiesced at once — ' +
      'scheduler fully paused during deploy'
    );
  }

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

  let servingAborted = false;
  try {
    await listr.run();
  } catch {
    // Canary failure - mark remaining SERVING hosts as skipped.
    // (The strategy/canary applies to serving nodes only, so batch offsets and
    // skipped counts are computed against `serving`, not all hosts.)
    if (strategy.isCanary) {
      ctx.aborted = true;
      servingAborted = true;
      // Find which batch failed
      for (let i = 0; i < strategy.batches.length; i++) {
        let batchStart = 0;
        for (let j = 0; j < i; j++) {
          const b = strategy.batches[j]!;
          batchStart += b.count === 'rest' ? serving.length : b.count;
        }
        const batch = strategy.batches[i]!;
        const batchSize = batch.count === 'rest' ? serving.length - batchStart : batch.count;
        const batchHosts = serving.slice(batchStart, batchStart + batchSize);

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

      // Count skipped serving hosts
      ctx.skipped = serving.filter(h => !ctx.results.has(h)).length;
    }
  }

  // --- Worker batch (final, parallel, no drain, NON-BLOCKING) ---
  // Workers deploy LAST, only if the serving roll did not abort. A worker
  // failure is recorded in ctx.workerFailed (not ctx.failed) and never aborts
  // serving deployment. The command-level receipt gate still exits non-zero.
  // Don't touch workers if serving is broken (servingAborted short-circuits).
  if (workers.length > 0 && !servingAborted) {
    const workerTasks = workers.map(host => createHostTask(host, options, /* isWorker */ true));
    const workerListrOptions = {
      concurrent: workers.length > 1,
      // Non-blocking for serving rollout: never throw out of the worker batch. createHostTask also
      // swallows worker failures (records to workerFailed + returns), so this is
      // belt-and-suspenders.
      exitOnError: false,
      collectErrors: 'minimal' as const,
      rendererOptions: {
        collapseSubtasks: false,
        collapseErrors: false,
        timer: PRESET_TIMER,
      },
      ctx,
    };
    const workerListr = isPlain
      ? new Listr<DeployContext, 'simple'>(workerTasks, { ...workerListrOptions, renderer: 'simple' })
      : new Listr<DeployContext, 'default'>(workerTasks, { ...workerListrOptions, renderer: 'default' });
    try {
      await workerListr.run();
    } catch {
      // Defensive: finish observing the worker batch. A worker failure must not
      // abort the already-successful serving deploy; the final command gate
      // still reports the incomplete rollout as non-zero.
    }
  }

  return ctx;
}

/**
 * Print connection summary header before deployment
 */
export function printConnectionSummary(
  connectionMap: Map<string, ConnectionInfo>,
  isPlain: boolean
): void {
  const connections = Array.from(connectionMap.values());
  const tlsCount = connections.filter(c => c.tls).length;
  const httpCount = connections.filter(c => !c.tls).length;
  const verifiedCount = connections.filter(c => c.tls && c.verified).length;

  if (isPlain) {
    if (tlsCount > 0 && httpCount > 0) {
      console.log(`Connection: ${tlsCount} HTTPS, ${httpCount} HTTP`);
    } else if (tlsCount > 0) {
      const verifyText = verifiedCount === tlsCount
        ? 'verified'
        : verifiedCount > 0
          ? `${verifiedCount} verified`
          : 'unverified';
      console.log(`Connection: HTTPS (${verifyText})`);
    } else {
      console.log('Connection: HTTP (unencrypted)');
    }
  } else {
    if (tlsCount > 0 && httpCount > 0) {
      console.log(`\x1b[36m🔐 Mixed:\x1b[0m ${tlsCount} \x1b[32mHTTPS\x1b[0m, ${httpCount} \x1b[33mHTTP\x1b[0m`);
    } else if (tlsCount > 0) {
      const icon = verifiedCount === tlsCount ? '🔒' : '🔐';
      const verifyText = verifiedCount === tlsCount
        ? '\x1b[32mverified\x1b[0m'
        : verifiedCount > 0
          ? `\x1b[36m${verifiedCount} verified\x1b[0m`
          : '\x1b[36munverified\x1b[0m';
      console.log(`\x1b[32m${icon} HTTPS\x1b[0m (${verifyText})`);
    } else {
      console.log('\x1b[33m🔓 HTTP\x1b[0m (unencrypted)');
    }
  }
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
  const unhealthyText = ctx.healthCheckFailed > 0 ? `, ${ctx.healthCheckFailed} unhealthy` : '';
  // Worker failures are non-blocking: surfaced here but excluded from the
  // success/exit logic below (they never make the deploy "fail").
  const workerText = ctx.workerFailed > 0 ? `, ${ctx.workerFailed} worker(s) failed (non-blocking)` : '';

  if (isPlain) {
    console.log(`Deployment complete: ${ctx.successful}/${totalHosts} hosts successful${failedText}${unhealthyText}${skippedText}${workerText}`);
  } else {
    if (ctx.failed === 0 && ctx.skipped === 0 && ctx.healthCheckFailed === 0 && ctx.workerFailed === 0) {
      console.log(`\x1b[32m\x1b[1m✓ Deployment complete\x1b[0m: ${ctx.successful}/${totalHosts} hosts successful`);
    } else {
      console.log(`\x1b[33m\x1b[1m⚠ Deployment complete\x1b[0m: ${ctx.successful}/${totalHosts} hosts successful${failedText}${unhealthyText}${skippedText}${workerText}`);
    }
  }
}
