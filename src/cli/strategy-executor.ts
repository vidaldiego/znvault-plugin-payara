// Path: src/cli/strategy-executor.ts
// Deployment strategy executor for canary/rolling deployments

import type { DeploymentStrategy, DeployToHostResult } from './types.js';
import type { ProgressReporter } from './progress.js';

/**
 * Result of executing a deployment strategy
 */
export interface StrategyExecutionResult {
  /** Total hosts processed */
  total: number;
  /** Successful deployments */
  successful: number;
  /** Failed deployments */
  failed: number;
  /** Hosts that were skipped (due to earlier batch failure in canary mode) */
  skipped: number;
  /** Results per host */
  results: Map<string, DeployToHostResult>;
  /** Whether the deployment was aborted due to canary failure */
  aborted: boolean;
  /** The batch that failed (if aborted) */
  failedBatch?: number;
}

/**
 * Options for strategy execution
 */
export interface StrategyExecutorOptions {
  /** Abort on first failure in canary mode */
  abortOnFailure?: boolean;
  /** Progress reporter for visual feedback */
  progress?: ProgressReporter;
}

/**
 * Execute a deployment strategy across multiple hosts
 *
 * @param strategy Parsed deployment strategy
 * @param hosts List of host addresses to deploy to
 * @param deployFn Function to deploy to a single host (returns promise)
 * @param options Execution options
 * @returns Execution result with success/failure counts
 *
 * @example
 * // Canary deployment: 1 host first, then rest
 * const strategy = parseDeploymentStrategy('1+R');
 * const result = await executeStrategy(strategy, hosts, deployToHost, {
 *   abortOnFailure: true,
 *   progress: reporter,
 * });
 */
export async function executeStrategy(
  strategy: DeploymentStrategy,
  hosts: string[],
  deployFn: (host: string) => Promise<DeployToHostResult>,
  options: StrategyExecutorOptions = {}
): Promise<StrategyExecutionResult> {
  const { abortOnFailure = true, progress } = options;

  const results = new Map<string, DeployToHostResult>();
  let successful = 0;
  let failed = 0;
  let skipped = 0;
  let aborted = false;
  let failedBatch: number | undefined;

  // Track which hosts we've processed
  let hostIndex = 0;
  let batchIndex = 0;

  // Process batches until all hosts are done
  // For non-canary strategies (sequential/parallel), we may need to repeat the batch pattern
  while (hostIndex < hosts.length) {
    // Get current batch (cycle through batches for non-canary strategies)
    const effectiveBatchIndex = strategy.isCanary
      ? batchIndex
      : batchIndex % strategy.batches.length;

    const batch = strategy.batches[effectiveBatchIndex];

    // If we've run out of batches in canary mode, stop
    if (!batch) {
      break;
    }

    // Determine how many hosts in this batch
    const batchSize = batch.count === 'rest'
      ? hosts.length - hostIndex
      : Math.min(batch.count, hosts.length - hostIndex);

    if (batchSize <= 0) {
      // No more hosts to process
      break;
    }

    // Get hosts for this batch
    const batchHosts = hosts.slice(hostIndex, hostIndex + batchSize);
    hostIndex += batchSize;

    // Show batch header for canary strategies
    if (strategy.isCanary && progress) {
      progress.showBatchHeader(batchIndex + 1, strategy.batches.length, batchHosts.length, batch.label);
    }

    // Deploy to all hosts in this batch (in parallel within batch)
    const batchPromises = batchHosts.map(async (host) => {
      const result = await deployFn(host);
      results.set(host, result);
      return { host, result };
    });

    const batchResults = await Promise.all(batchPromises);

    // Count successes and failures in this batch
    let batchSuccesses = 0;
    let batchFailures = 0;

    for (const { result } of batchResults) {
      if (result.success) {
        successful++;
        batchSuccesses++;
      } else {
        failed++;
        batchFailures++;
      }
    }

    // Show batch summary for canary strategies
    if (strategy.isCanary && progress) {
      progress.showBatchResult(batchIndex + 1, batchSuccesses, batchFailures);
    }

    // Check if we should abort (canary failure)
    if (abortOnFailure && batchFailures > 0 && hostIndex < hosts.length) {
      aborted = true;
      failedBatch = batchIndex + 1;

      // Mark remaining hosts as skipped
      const remainingHosts = hosts.slice(hostIndex);
      skipped = remainingHosts.length;

      if (progress) {
        progress.showCanaryAbort(failedBatch, skipped);
      }

      break;
    }

    batchIndex++;
  }

  return {
    total: hosts.length,
    successful,
    failed,
    skipped,
    results,
    aborted,
    failedBatch,
  };
}

/**
 * Resolve effective strategy from config and CLI options
 *
 * Priority:
 * 1. Explicit --strategy flag
 * 2. --sequential flag (maps to "sequential")
 * 3. config.strategy field
 * 4. config.parallel field (legacy: true → "parallel", false → "sequential")
 * 5. Default: "sequential"
 */
export function resolveStrategy(options: {
  strategy?: string;
  sequential?: boolean;
  configStrategy?: string;
  configParallel?: boolean;
}): string {
  // 1. Explicit --strategy flag takes precedence
  if (options.strategy) {
    return options.strategy;
  }

  // 2. --sequential flag overrides everything
  if (options.sequential) {
    return 'sequential';
  }

  // 3. Config strategy field
  if (options.configStrategy) {
    return options.configStrategy;
  }

  // 4. Legacy parallel field
  if (options.configParallel !== undefined) {
    return options.configParallel ? 'parallel' : 'sequential';
  }

  // 5. Default
  return 'sequential';
}
