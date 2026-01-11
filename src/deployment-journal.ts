// Path: src/deployment-journal.ts
// Deployment journal for crash recovery and resume capability

import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';

export type JournalStep =
  | 'init'
  | 'war-update'
  | 'undeploy'
  | 'stop'
  | 'kill'
  | 'start'
  | 'deploy'
  | 'verify'
  | 'complete';

export interface DeploymentCheckpoint {
  deploymentId: string;
  started: number;
  lastUpdated: number;
  step: JournalStep;
  warPath: string;
  appName: string;
  contextRoot?: string;
  changedFiles: string[];
  deletedFiles: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Deployment journal for crash recovery.
 *
 * Records deployment progress to allow:
 * 1. Detection of incomplete deployments on restart
 * 2. Resume from last known step (future enhancement)
 * 3. Debugging failed deployments
 *
 * Journal is stored at /var/lib/zn-vault-agent/deployment-journal.json
 */
export class DeploymentJournal {
  private readonly journalPath: string;
  private readonly logger: Logger;
  private currentCheckpoint: DeploymentCheckpoint | null = null;

  constructor(
    logger: Logger,
    journalPath = '/var/lib/zn-vault-agent/deployment-journal.json'
  ) {
    this.journalPath = journalPath;
    this.logger = logger;
  }

  /**
   * Start a new deployment journal entry.
   */
  async start(options: {
    deploymentId: string;
    warPath: string;
    appName: string;
    contextRoot?: string;
    changedFiles?: string[];
    deletedFiles?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const checkpoint: DeploymentCheckpoint = {
      deploymentId: options.deploymentId,
      started: Date.now(),
      lastUpdated: Date.now(),
      step: 'init',
      warPath: options.warPath,
      appName: options.appName,
      contextRoot: options.contextRoot,
      changedFiles: options.changedFiles ?? [],
      deletedFiles: options.deletedFiles ?? [],
      metadata: options.metadata,
    };

    this.currentCheckpoint = checkpoint;
    await this.persist();

    this.logger.debug(
      { deploymentId: options.deploymentId, journalPath: this.journalPath },
      'Deployment journal started'
    );
  }

  /**
   * Update the current deployment step.
   */
  async updateStep(step: JournalStep, metadata?: Record<string, unknown>): Promise<void> {
    if (!this.currentCheckpoint) {
      throw new Error('No active deployment journal');
    }

    this.currentCheckpoint.step = step;
    this.currentCheckpoint.lastUpdated = Date.now();
    if (metadata) {
      this.currentCheckpoint.metadata = {
        ...this.currentCheckpoint.metadata,
        ...metadata,
      };
    }

    await this.persist();

    this.logger.debug(
      { step, deploymentId: this.currentCheckpoint.deploymentId },
      'Deployment journal step updated'
    );
  }

  /**
   * Mark deployment as complete and clear the journal.
   */
  async complete(): Promise<void> {
    if (!this.currentCheckpoint) {
      return;
    }

    const deploymentId = this.currentCheckpoint.deploymentId;
    const duration = Date.now() - this.currentCheckpoint.started;

    this.logger.info(
      { deploymentId, durationMs: duration },
      'Deployment completed successfully'
    );

    this.currentCheckpoint = null;
    await this.clear();
  }

  /**
   * Clear the journal file.
   */
  async clear(): Promise<void> {
    try {
      await rm(this.journalPath, { force: true });
    } catch {
      // Ignore errors
    }
  }

  /**
   * Load an existing journal entry (for crash recovery).
   */
  async load(): Promise<DeploymentCheckpoint | null> {
    try {
      const content = await readFile(this.journalPath, 'utf-8');
      const checkpoint = JSON.parse(content) as DeploymentCheckpoint;
      this.currentCheckpoint = checkpoint;
      return checkpoint;
    } catch {
      return null;
    }
  }

  /**
   * Check if there's an incomplete deployment from a previous run.
   * Returns the checkpoint if found, null otherwise.
   */
  async getIncomplete(): Promise<DeploymentCheckpoint | null> {
    const checkpoint = await this.load();

    if (!checkpoint) {
      return null;
    }

    // If step is 'complete', the journal wasn't cleaned up properly but deployment finished
    if (checkpoint.step === 'complete') {
      await this.clear();
      return null;
    }

    return checkpoint;
  }

  /**
   * Check if deployment can be safely resumed from a checkpoint.
   * Currently, we don't support automatic resume - this is for future enhancement.
   */
  canResume(checkpoint: DeploymentCheckpoint): boolean {
    // For now, we only support resume from early steps
    // where we haven't made destructive changes yet
    const safeToResumeSteps: JournalStep[] = ['init', 'war-update'];
    return safeToResumeSteps.includes(checkpoint.step);
  }

  /**
   * Get diagnostic information about an incomplete deployment.
   */
  getDiagnostics(checkpoint: DeploymentCheckpoint): string {
    const age = Date.now() - checkpoint.started;
    const ageMinutes = Math.round(age / 60000);

    return [
      `Incomplete deployment detected:`,
      `  Deployment ID: ${checkpoint.deploymentId}`,
      `  Started: ${ageMinutes} minutes ago`,
      `  Last step: ${checkpoint.step}`,
      `  App: ${checkpoint.appName}`,
      `  WAR: ${checkpoint.warPath}`,
      `  Changed files: ${checkpoint.changedFiles.length}`,
      `  Deleted files: ${checkpoint.deletedFiles.length}`,
    ].join('\n');
  }

  /**
   * Persist the current checkpoint to disk.
   */
  private async persist(): Promise<void> {
    if (!this.currentCheckpoint) {
      return;
    }

    try {
      // Ensure directory exists
      await mkdir(dirname(this.journalPath), { recursive: true });
      await writeFile(
        this.journalPath,
        JSON.stringify(this.currentCheckpoint, null, 2),
        { mode: 0o600 }
      );
    } catch (err) {
      this.logger.warn({ err }, 'Failed to persist deployment journal');
    }
  }
}
