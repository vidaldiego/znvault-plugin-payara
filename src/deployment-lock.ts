// Path: src/deployment-lock.ts
// File-based deployment lock with SIGTERM deferral

import { writeFile, readFile, rm, stat } from 'node:fs/promises';
import type { Logger } from 'pino';

export interface LockData {
  pid: number;
  started: number;
  deploymentId: string;
  step: DeploymentStep;
}

export type DeploymentStep =
  | 'init'
  | 'war-update'
  | 'undeploy'
  | 'stop'
  | 'kill'
  | 'start'
  | 'deploy'
  | 'verify'
  | 'complete';

/**
 * File-based deployment lock with SIGTERM deferral.
 *
 * This class provides:
 * 1. A persistent lock file at /var/lib/zn-vault-agent/znvault-deploy.lock
 * 2. SIGTERM deferral during active deployments
 * 3. Lock file contains PID, timestamp, deployment ID, and current step
 *
 * Usage:
 * ```typescript
 * const lock = new DeploymentLock(logger);
 * try {
 *   await lock.acquire('deployment-123');
 *   await lock.updateStep('undeploy');
 *   // ... deployment work ...
 * } finally {
 *   await lock.release();
 * }
 * ```
 */
export class DeploymentLock {
  private readonly lockPath: string;
  private readonly logger: Logger;
  private pendingShutdown = false;
  /** Store ALL original SIGTERM handlers, not just one */
  private originalSigtermHandlers: NodeJS.SignalsListener[] = [];
  private acquired = false;
  private currentDeploymentId: string | null = null;

  constructor(logger: Logger, lockPath = '/var/lib/zn-vault-agent/znvault-deploy.lock') {
    this.lockPath = lockPath;
    this.logger = logger;
  }

  /**
   * Check if a lock file exists and is valid (not stale).
   * Lock is considered stale if older than maxAgeSeconds (default: 10 minutes).
   */
  async isLocked(maxAgeSeconds = 600): Promise<{ locked: boolean; data?: LockData; stale?: boolean }> {
    try {
      const content = await readFile(this.lockPath, 'utf-8');
      const data = JSON.parse(content) as LockData;

      // Check if lock is stale
      const ageSeconds = (Date.now() - data.started) / 1000;
      if (ageSeconds > maxAgeSeconds) {
        return { locked: false, data, stale: true };
      }

      // Check if the process is still running
      try {
        process.kill(data.pid, 0); // Signal 0 = check if process exists
        return { locked: true, data };
      } catch {
        // Process doesn't exist - lock is orphaned
        return { locked: false, data, stale: true };
      }
    } catch {
      // Lock file doesn't exist or is invalid
      return { locked: false };
    }
  }

  /**
   * Get the age of the current lock file in seconds.
   * Returns null if no lock file exists.
   */
  async getLockAge(): Promise<number | null> {
    try {
      const stats = await stat(this.lockPath);
      return (Date.now() - stats.mtimeMs) / 1000;
    } catch {
      return null;
    }
  }

  /**
   * Acquire the deployment lock.
   * Throws if another deployment is in progress.
   */
  async acquire(deploymentId: string): Promise<void> {
    // Check if already locked
    const { locked, data, stale } = await this.isLocked();

    if (locked && data) {
      throw new Error(
        `Deployment already in progress: ${data.deploymentId} ` +
        `(started ${Math.round((Date.now() - data.started) / 1000)}s ago, step: ${data.step})`
      );
    }

    // Clean up stale lock if found
    if (stale && data) {
      this.logger.warn(
        { oldDeploymentId: data.deploymentId, oldPid: data.pid },
        'Removing stale deployment lock'
      );
      await this.forceRemove();
    }

    // Create lock file
    const lockData: LockData = {
      pid: process.pid,
      started: Date.now(),
      deploymentId,
      step: 'init',
    };

    await writeFile(this.lockPath, JSON.stringify(lockData, null, 2), { mode: 0o644 });

    this.acquired = true;
    this.currentDeploymentId = deploymentId;

    // Register SIGTERM handler that defers shutdown
    this.registerSignalHandler();

    this.logger.info({ deploymentId, lockPath: this.lockPath }, 'Deployment lock acquired');
  }

  /**
   * Update the current deployment step.
   * This helps with debugging and allows systemd to see progress.
   */
  async updateStep(step: DeploymentStep): Promise<void> {
    if (!this.acquired) {
      throw new Error('Cannot update step: lock not acquired');
    }

    try {
      const content = await readFile(this.lockPath, 'utf-8');
      const data = JSON.parse(content) as LockData;
      data.step = step;
      await writeFile(this.lockPath, JSON.stringify(data, null, 2), { mode: 0o644 });
      this.logger.debug({ step, deploymentId: this.currentDeploymentId }, 'Deployment step updated');
    } catch (err) {
      this.logger.warn({ err, step }, 'Failed to update deployment step');
    }
  }

  /**
   * Release the deployment lock.
   * If a SIGTERM was deferred, it will be re-sent after release.
   */
  async release(): Promise<void> {
    if (!this.acquired) {
      return;
    }

    // Remove lock file
    try {
      await rm(this.lockPath, { force: true });
      this.logger.info({ deploymentId: this.currentDeploymentId }, 'Deployment lock released');
    } catch (err) {
      this.logger.warn({ err }, 'Failed to remove lock file');
    }

    this.acquired = false;
    this.currentDeploymentId = null;

    // Restore original SIGTERM handler
    this.restoreSignalHandler();

    // If shutdown was pending, trigger it now
    if (this.pendingShutdown) {
      this.logger.info('Deployment complete, processing deferred SIGTERM');
      // Small delay to allow cleanup
      setTimeout(() => {
        process.kill(process.pid, 'SIGTERM');
      }, 100);
    }
  }

  /**
   * Force remove the lock file (for cleanup of stale locks).
   */
  async forceRemove(): Promise<void> {
    try {
      await rm(this.lockPath, { force: true });
    } catch {
      // Ignore errors
    }
  }

  /**
   * Check if this instance holds the lock.
   */
  isAcquired(): boolean {
    return this.acquired;
  }

  /**
   * Check if a SIGTERM is pending.
   */
  isPendingShutdown(): boolean {
    return this.pendingShutdown;
  }

  /**
   * Register SIGTERM handler that defers shutdown during deployment.
   *
   * IMPORTANT: Store ALL existing handlers so they can be restored.
   * Previously this only stored the last one, causing other handlers
   * (agent graceful shutdown, other plugins) to be permanently lost.
   */
  private registerSignalHandler(): void {
    // Store ALL existing handlers
    this.originalSigtermHandlers = process.listeners('SIGTERM') as NodeJS.SignalsListener[];

    // Remove all existing handlers temporarily
    process.removeAllListeners('SIGTERM');

    // Add our deferral handler
    process.on('SIGTERM', () => {
      if (this.acquired) {
        this.logger.warn(
          { deploymentId: this.currentDeploymentId },
          'SIGTERM received during deployment - deferring until complete'
        );
        this.pendingShutdown = true;
      } else {
        // Not acquired, call all original handlers
        for (const handler of this.originalSigtermHandlers) {
          try {
            handler('SIGTERM');
          } catch (err) {
            this.logger.error({ err }, 'Error in SIGTERM handler');
          }
        }
        // If no handlers were registered, exit gracefully
        if (this.originalSigtermHandlers.length === 0) {
          process.exit(0);
        }
      }
    });
  }

  /**
   * Restore ALL original SIGTERM handlers.
   */
  private restoreSignalHandler(): void {
    process.removeAllListeners('SIGTERM');

    // Restore ALL original handlers in their original order
    for (const handler of this.originalSigtermHandlers) {
      process.on('SIGTERM', handler);
    }

    this.originalSigtermHandlers = [];
  }
}
