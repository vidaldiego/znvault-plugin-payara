// Path: src/plugin-startup.ts
// Plugin startup mode handlers

import type { Logger } from 'pino';
import { performance } from 'node:perf_hooks';
import type { PayaraManager } from './payara-manager.js';
import type { WarDeployer } from './war-deployer.js';

/**
 * Default delay after starting Payara before deploying (milliseconds)
 * This allows Payara's env var substitution to fully initialize
 */
export const DEFAULT_POST_START_DELAY_MS = 5000;
/**
 * Shared command + runtime-probe budget inside the agent 2.x 120s onStart
 * limit. onStart never deploys an application, so this is the only potentially
 * long mutation it may dispatch.
 */
export const STARTUP_LIFECYCLE_BUDGET_MS = 35000;
export const STARTUP_OBSERVATION_BUDGET_MS = 25000;

/**
 * Context for startup operations
 */
export interface StartupContext {
  payara: PayaraManager;
  deployer: WarDeployer;
  logger: Logger;
  /** Delay after domain start before deploying (ms) */
  postStartDelay?: number;
  /** Absolute monotonic deadline inherited from the agent onStart hook. */
  deadlineMs?: number;
}

/**
 * Handle exec mode startup (lifecycle managed externally)
 *
 * In this mode, we don't start Payara ourselves - we wait for it
 * to be started by an external process (e.g., systemd exec command)
 */
export async function handleExecModeStartup(_ctx: StartupContext): Promise<void> {
  const error = new Error(
    'EXEC_LIFECYCLE_UNSUPPORTED: agent exec events cannot safely identify the detached Payara DAS'
  );
  error.name = 'EXEC_LIFECYCLE_UNSUPPORTED';
  throw error;
}

/**
 * Handle aggressive mode startup
 *
 * In aggressive mode, we ensure a clean slate but skip restart
 * if Payara is already healthy (allows agent restarts without disruption)
 */
export async function handleAggressiveModeStartup(ctx: StartupContext): Promise<void> {
  const { payara, deployer, logger } = ctx;

  // Lifecycle routing is correctness-bearing. An UNKNOWN list-domains result
  // must abort rather than collapse to "stopped" and select a start/kill path.
  const alreadyRunning = await payara.isRunningStrict(
    remainingStartupBudget(ctx, 'aggressive running-state probe', 10000)
  );
  if (alreadyRunning) {
    logger.info('Aggressive mode: Payara already running, skipping restart');

    // Startup is observation-only for the application. The agent loader's
    // onStart timeout is not cancellable, so a WAR deploy must never continue
    // after the host has marked this plugin failed.
    logger.info('Observing startup deployment ownership for the existing domain');
    await deployer.observeStartupOwnership(ctx.deadlineMs);
  } else {
    logger.info('Aggressive mode: Payara is strictly stopped');
    // Startup never performs orphan cleanup. A residual or ambiguous DAS is an
    // operator condition; destructive aggressive recovery is available only
    // after the plugin is running and outside the host onStart timeout.
    await payara.start({
      waitForApplicationHealth: false,
      timeoutMs: reserveTerminalStartupBudget(
        ctx,
        'aggressive start-domain',
        STARTUP_LIFECYCLE_BUDGET_MS
      ),
      ...(ctx.deadlineMs === undefined ? {} : { deadlineMs: ctx.deadlineMs }),
    });

    await deployer.observeStartupOwnership(ctx.deadlineMs);
  }
}

/**
 * Handle normal mode startup
 *
 * In normal mode, we start Payara only if it's not already running
 */
export async function handleNormalModeStartup(ctx: StartupContext): Promise<void> {
  const { payara, deployer, logger } = ctx;

  const alreadyRunning = await payara.isRunningStrict(
    remainingStartupBudget(ctx, 'normal running-state probe', 10000)
  );
  if (alreadyRunning) {
    logger.info('Payara already running');
    await deployer.observeStartupOwnership(ctx.deadlineMs);
  } else {
    logger.info('Starting Payara...');
    await payara.start({
      waitForApplicationHealth: false,
      timeoutMs: reserveTerminalStartupBudget(
        ctx,
        'normal start-domain',
        STARTUP_LIFECYCLE_BUDGET_MS
      ),
      ...(ctx.deadlineMs === undefined ? {} : { deadlineMs: ctx.deadlineMs }),
    });

    await deployer.observeStartupOwnership(ctx.deadlineMs);
  }
}

/**
 * Check for duplicate processes and fix if needed
 * Returns true if processes were fixed
 */
export async function ensureSinglePayaraProcess(
  payara: PayaraManager,
  logger: Logger,
  deadlineMs?: number
): Promise<boolean> {
  const singleProcessCheck = await payara.ensureSingleProcess(deadlineMs);

  if (singleProcessCheck.fixed) {
    logger.warn({
      previousCount: singleProcessCheck.previousCount,
    }, 'Fixed duplicate Payara processes on startup');
    return true;
  } else if (singleProcessCheck.previousCount > 1 && !singleProcessCheck.ok) {
    logger.error({
      previousCount: singleProcessCheck.previousCount,
    }, 'CRITICAL: Could not fix duplicate Payara processes - manual intervention required');
    const error = new Error(
      `BOOT_MULTIPLE_DAS_PROCESSES: observed ${singleProcessCheck.previousCount} Payara JVMs`
    );
    error.name = 'BOOT_MULTIPLE_DAS_PROCESSES';
    throw error;
  }

  return false;
}

function remainingStartupBudget(
  ctx: StartupContext,
  stage: string,
  capMs: number
): number {
  if (ctx.deadlineMs === undefined) return capMs;
  const remainingMs = Math.floor(ctx.deadlineMs - performance.now());
  if (remainingMs <= 0) {
    throw new Error(`PLUGIN_STARTUP_DEADLINE_EXCEEDED: before ${stage}`);
  }
  return Math.min(capMs, remainingMs);
}

function reserveTerminalStartupBudget(
  ctx: StartupContext,
  stage: string,
  lifecycleMs: number
): number {
  if (ctx.deadlineMs === undefined) return lifecycleMs;
  const requiredMs = lifecycleMs + STARTUP_OBSERVATION_BUDGET_MS;
  const remainingMs = Math.floor(ctx.deadlineMs - performance.now());
  if (remainingMs < requiredMs) {
    throw new Error(
      `PLUGIN_STARTUP_DEADLINE_EXCEEDED: ${remainingMs}ms remain before ${stage}; ` +
      `${requiredMs}ms required`
    );
  }
  return lifecycleMs;
}
