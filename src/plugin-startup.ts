// Path: src/plugin-startup.ts
// Plugin startup mode handlers

import type { Logger } from 'pino';
import type { PayaraManager } from './payara-manager.js';
import type { WarDeployer } from './war-deployer.js';
import { waitForWithResult } from './utils/polling.js';

/**
 * Default delay after starting Payara before deploying (milliseconds)
 * This allows Payara's env var substitution to fully initialize
 */
export const DEFAULT_POST_START_DELAY_MS = 5000;

/**
 * Context for startup operations
 */
export interface StartupContext {
  payara: PayaraManager;
  deployer: WarDeployer;
  logger: Logger;
  /** Delay after domain start before deploying (ms) */
  postStartDelay?: number;
}

/**
 * Handle exec mode startup (lifecycle managed externally)
 *
 * In this mode, we don't start Payara ourselves - we wait for it
 * to be started by an external process (e.g., systemd exec command)
 */
export async function handleExecModeStartup(ctx: StartupContext): Promise<void> {
  const { payara, deployer, logger } = ctx;

  logger.info('Lifecycle managed externally (exec mode), waiting for Payara to be ready...');

  // Wait for Payara to become healthy (started by exec command)
  const maxWait = 120000; // 2 minutes
  const payaraReady = await waitForWithResult(
    () => payara.isRunning(),
    maxWait,
    { intervalMs: 2000 }
  );

  if (payaraReady) {
    logger.info('Payara is running');
  } else {
    logger.warn(
      `Timeout waiting for Payara to start (${maxWait / 1000}s). ` +
      'Plugin will continue but Payara may not be available. ' +
      'Check exec command configuration.'
    );
  }

  // Deploy WAR if it exists and Payara is running
  if (payaraReady && await deployer.warExists()) {
    // Wait for env var substitution to initialize (prevents @DataSourceDefinition failures)
    await applyPostStartDelay(ctx, 'after Payara became ready');
    await deployer.deploy();
  }
}

/**
 * Handle aggressive mode startup
 *
 * In aggressive mode, we ensure a clean slate but skip restart
 * if Payara is already healthy (allows agent restarts without disruption)
 */
export async function handleAggressiveModeStartup(ctx: StartupContext): Promise<void> {
  const { payara, deployer, logger } = ctx;

  if (await payara.isHealthy()) {
    logger.info('Aggressive mode: Payara already running and healthy, skipping restart');

    // Just ensure app is deployed
    if (await deployer.warExists() && !(await deployer.isAppDeployed())) {
      logger.info('WAR exists but app not deployed, deploying...');
      await deployer.deploy();
    }
  } else {
    logger.info('Aggressive mode: Payara not healthy, ensuring clean state');

    // Kill any existing Java processes (clean slate)
    await payara.ensureNoJavaRunning(true);

    // Start Payara fresh
    await payara.safeStart();

    // Wait for env var substitution to initialize (prevents @DataSourceDefinition failures)
    await applyPostStartDelay(ctx, 'after fresh start');

    // Deploy WAR if it exists
    if (await deployer.warExists()) {
      await deployer.deploy();
    }
  }
}

/**
 * Handle normal mode startup
 *
 * In normal mode, we start Payara only if it's not already running
 */
export async function handleNormalModeStartup(ctx: StartupContext): Promise<void> {
  const { payara, deployer, logger } = ctx;

  if (await payara.isHealthy()) {
    logger.info('Payara already running and healthy');
  } else {
    logger.info('Starting Payara...');
    await payara.start();

    // Wait for env var substitution to initialize (prevents @DataSourceDefinition failures)
    await applyPostStartDelay(ctx, 'after starting domain');

    // Deploy WAR if it exists
    if (await deployer.warExists()) {
      await deployer.deploy();
    }
  }
}

/**
 * Check for duplicate processes and fix if needed
 * Returns true if processes were fixed
 */
export async function ensureSinglePayaraProcess(
  payara: PayaraManager,
  logger: Logger
): Promise<boolean> {
  const singleProcessCheck = await payara.ensureSingleProcess();

  if (singleProcessCheck.fixed) {
    logger.warn({
      previousCount: singleProcessCheck.previousCount,
    }, 'Fixed duplicate Payara processes on startup');
    return true;
  } else if (singleProcessCheck.previousCount > 1 && !singleProcessCheck.ok) {
    logger.error({
      previousCount: singleProcessCheck.previousCount,
    }, 'CRITICAL: Could not fix duplicate Payara processes - manual intervention required');
  }

  return false;
}

/**
 * Wait for a specified delay, used to allow Payara to initialize env var substitution
 */
async function applyPostStartDelay(
  ctx: StartupContext,
  reason: string
): Promise<void> {
  const delay = ctx.postStartDelay ?? DEFAULT_POST_START_DELAY_MS;
  if (delay > 0) {
    ctx.logger.info(
      { delayMs: delay },
      `Waiting ${delay}ms ${reason} before deploying (postStartDelay)`
    );
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
