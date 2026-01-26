// Path: src/war-deployer.ts
// WAR file deployer with diff-based updates - uses asadmin deploy commands only

import { createHash, randomBytes } from 'node:crypto';
import { writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { join, dirname, normalize, isAbsolute } from 'node:path';
import AdmZip from 'adm-zip';
import type { Logger } from 'pino';
import type { PayaraManager } from './payara-manager.js';
import type { WarDeployerOptions, WarFileHashes, FileChange, DeployResult, FullDeployResult } from './types.js';
import { DeploymentLock } from './deployment-lock.js';
import { DeploymentJournal } from './deployment-journal.js';
import { createTempDir, cleanupTempDir, withTempDir } from './utils/temp-dir.js';
import { getErrorMessage } from './utils/error.js';
import { DeploymentStatusTracker } from './deployment-status.js';
import type { DeploymentStatus } from './deployment-status.js';
import { addDirectoryToZip } from './utils/zip.js';

/**
 * Validate and sanitize a file path to prevent directory traversal attacks.
 * Ensures the path stays within the specified base directory.
 *
 * @param basePath - The base directory that files must stay within
 * @param filePath - The relative file path to validate
 * @returns The safe, absolute path within basePath
 * @throws Error if path would escape basePath
 */
export function getSafePath(basePath: string, filePath: string): string {
  // Normalize the path to resolve . and .. components
  const normalizedPath = normalize(filePath);

  // Reject absolute paths
  if (isAbsolute(normalizedPath)) {
    throw new Error(`Path traversal attempt: absolute path not allowed: ${filePath}`);
  }

  // Reject paths that start with ..
  if (normalizedPath.startsWith('..')) {
    throw new Error(`Path traversal attempt: path escapes base directory: ${filePath}`);
  }

  // Join with base and normalize again
  const fullPath = normalize(join(basePath, normalizedPath));

  // Verify the resolved path is still within basePath
  // This catches cases like "foo/../../bar" that normalize to "../bar"
  if (!fullPath.startsWith(basePath)) {
    throw new Error(`Path traversal attempt: resolved path escapes base: ${filePath}`);
  }

  return fullPath;
}

// Re-export WAR utilities for backwards compatibility
export { calculateDiff, calculateWarHashes, getWarEntry } from './war-utils.js';

// Re-export DeploymentStatus type for backwards compatibility
export type { DeploymentStatus } from './deployment-status.js';

/**
 * WAR file deployer with diff-based updates
 *
 * IMPORTANT: This deployer uses asadmin deploy commands ONLY.
 * It does NOT use the autodeploy directory.
 *
 * Supports:
 * - Full WAR deployment via asadmin deploy --force
 * - Diff-based updates (only changed files)
 * - Hash calculation for change detection
 * - Proper deployment status reporting
 */

export class WarDeployer {
  private readonly warPath: string;
  private readonly appName: string;
  private readonly contextRoot?: string;
  private readonly payara: PayaraManager;
  private readonly logger: Logger;
  private readonly aggressiveMode: boolean;

  // Lock to prevent concurrent deployments (in-memory)
  private deployLock = false;

  // File-based deployment lock for SIGTERM deferral
  private readonly fileLock: DeploymentLock;

  // Deployment journal for crash recovery
  private readonly journal: DeploymentJournal;

  // Deployment status tracking for long-running deployments
  private readonly statusTracker: DeploymentStatusTracker;

  constructor(options: WarDeployerOptions) {
    this.warPath = options.warPath;
    this.appName = options.appName;
    this.contextRoot = options.contextRoot;
    this.payara = options.payara;
    this.logger = options.logger;
    this.aggressiveMode = options.aggressiveMode ?? false;

    // Initialize file-based lock, journal, and status tracker
    this.fileLock = new DeploymentLock(options.logger);
    this.journal = new DeploymentJournal(options.logger);
    this.statusTracker = new DeploymentStatusTracker(options.logger);
  }

  /**
   * Check for incomplete deployment from a previous run.
   * Call this during plugin initialization.
   */
  async checkIncompleteDeployment(): Promise<void> {
    const incomplete = await this.journal.getIncomplete();
    if (incomplete) {
      this.logger.warn(
        { checkpoint: incomplete },
        this.journal.getDiagnostics(incomplete)
      );

      // For now, just log and clear - future enhancement: auto-resume
      if (!this.journal.canResume(incomplete)) {
        this.logger.warn('Cannot auto-resume - deployment may need manual intervention');
      }
      await this.journal.clear();
    }

    // Also check for stale lock files
    const { locked, data, stale } = await this.fileLock.isLocked();
    if (stale && data) {
      this.logger.warn(
        { oldDeploymentId: data.deploymentId, step: data.step },
        'Found stale deployment lock - cleaning up'
      );
      await this.fileLock.forceRemove();
    } else if (locked && data) {
      this.logger.warn(
        { deploymentId: data.deploymentId, step: data.step },
        'Another deployment is in progress'
      );
    }
  }

  /**
   * Check if WAR file exists
   */
  async warExists(): Promise<boolean> {
    try {
      await stat(this.warPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get SHA-256 hashes of all files in the WAR
   */
  async getCurrentHashes(): Promise<WarFileHashes> {
    if (!(await this.warExists())) {
      return {};
    }

    const hashes: WarFileHashes = {};

    try {
      const zip = new AdmZip(this.warPath);

      for (const entry of zip.getEntries()) {
        if (!entry.isDirectory) {
          const content = entry.getData();
          const hash = createHash('sha256').update(content).digest('hex');
          hashes[entry.entryName] = hash;
        }
      }
    } catch (err) {
      this.logger.error({ err, warPath: this.warPath }, 'Failed to read WAR file');
      throw err;
    }

    return hashes;
  }

  /**
   * Apply file changes to WAR and deploy using asadmin
   *
   * This method:
   * 1. Extracts the current WAR to a temp directory
   * 2. Applies file changes and deletions
   * 3. Repackages the WAR
   * 4. Deploys to Payara using asadmin deploy --force
   *
   * @returns Deploy result with status and details
   */
  async applyChanges(
    changedFiles: FileChange[],
    deletedFiles: string[]
  ): Promise<DeployResult> {
    if (this.deployLock) {
      throw new Error('Deployment already in progress');
    }

    this.deployLock = true;
    const tempDir = await createTempDir('war-deploy');
    const startTime = Date.now();

    try {
      this.logger.info({
        changed: changedFiles.length,
        deleted: deletedFiles.length,
      }, 'Applying WAR changes');

      // Extract current WAR if it exists
      if (await this.warExists()) {
        const zip = new AdmZip(this.warPath);
        zip.extractAllTo(tempDir, true);
      }

      // Apply deletions (with path traversal protection)
      for (const file of deletedFiles) {
        try {
          const fullPath = getSafePath(tempDir, file);
          await rm(fullPath, { force: true });
          this.logger.debug({ file }, 'Deleted file');
        } catch (err) {
          this.logger.warn({ err, file }, 'Failed to delete file');
        }
      }

      // Apply changes (with path traversal protection)
      for (const { path, content } of changedFiles) {
        const fullPath = getSafePath(tempDir, path);
        const dir = dirname(fullPath);

        // Ensure parent directory exists
        await mkdir(dir, { recursive: true });

        // Write file
        await writeFile(fullPath, content);
        this.logger.debug({ path, size: content.length }, 'Updated file');
      }

      // Repackage WAR
      const newZip = new AdmZip();
      await addDirectoryToZip(newZip, tempDir, '');

      // Ensure WAR directory exists
      const warDir = dirname(this.warPath);
      await mkdir(warDir, { recursive: true });

      // Write WAR file
      newZip.writeZip(this.warPath);

      this.logger.info({ warPath: this.warPath }, 'WAR file updated');

      // Deploy to Payara using asadmin deploy
      const deployResult = await this.deploy();

      const duration = Date.now() - startTime;

      return {
        success: true,
        filesChanged: changedFiles.length,
        filesDeleted: deletedFiles.length,
        message: 'Deployment successful',
        deploymentTime: duration,
        appName: this.appName,
        ...deployResult,
      };

    } catch (err) {
      const duration = Date.now() - startTime;
      this.logger.error({ err, duration }, 'Deployment failed');

      return {
        success: false,
        filesChanged: changedFiles.length,
        filesDeleted: deletedFiles.length,
        message: getErrorMessage(err),
        deploymentTime: duration,
        appName: this.appName,
      };

    } finally {
      await cleanupTempDir(tempDir, this.logger);
      this.deployLock = false;
    }
  }

  /**
   * Apply file changes to WAR without deploying to Payara
   * (Useful for testing or when deployment is handled separately)
   */
  async applyChangesWithoutDeploy(
    changedFiles: FileChange[],
    deletedFiles: string[]
  ): Promise<void> {
    await withTempDir('war-update', async (tempDir) => {
      this.logger.debug({
        changed: changedFiles.length,
        deleted: deletedFiles.length,
      }, 'Applying WAR changes (no deploy)');

      // Extract current WAR if it exists
      if (await this.warExists()) {
        const zip = new AdmZip(this.warPath);
        zip.extractAllTo(tempDir, true);
      }

      // Apply deletions (with path traversal protection)
      for (const file of deletedFiles) {
        try {
          const fullPath = getSafePath(tempDir, file);
          await rm(fullPath, { force: true });
        } catch {
          // Ignore deletion errors (including path traversal rejections)
        }
      }

      // Apply changes (with path traversal protection)
      for (const { path, content } of changedFiles) {
        const fullPath = getSafePath(tempDir, path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content);
      }

      // Repackage WAR
      const newZip = new AdmZip();
      await addDirectoryToZip(newZip, tempDir, '');

      const warDir = dirname(this.warPath);
      await mkdir(warDir, { recursive: true });

      newZip.writeZip(this.warPath);
    });
  }

  /**
   * Deploy WAR to Payara using asadmin deploy command
   * Uses --force flag for hot deployment/redeploy
   *
   * IMPORTANT: This does NOT use autodeploy. It uses explicit asadmin commands.
   */
  async deploy(): Promise<{ deployed: boolean; applications: string[] }> {
    if (!(await this.warExists())) {
      this.logger.info({ warPath: this.warPath }, 'No WAR file to deploy');
      return { deployed: false, applications: [] };
    }

    this.logger.info({ warPath: this.warPath, appName: this.appName }, 'Deploying WAR via asadmin');

    // Ensure Payara is running
    const isRunning = await this.payara.isRunning();

    if (!isRunning) {
      this.logger.info('Starting Payara for deployment');
      await this.payara.start();
    }

    // Deploy WAR with --force flag (hot deployment/redeploy)
    await this.payara.deploy(this.warPath, this.appName, this.contextRoot);

    // Verify deployment
    const applications = await this.payara.listApplications();
    const isDeployed = applications.includes(this.appName);

    if (isDeployed) {
      this.logger.info({ appName: this.appName, applications }, 'WAR deployed successfully');
    } else {
      this.logger.warn({ appName: this.appName, applications }, 'WAR deployment may have failed - app not in list');
    }

    return { deployed: isDeployed, applications };
  }

  /**
   * Deploy if WAR exists (for startup)
   */
  async deployIfExists(): Promise<boolean> {
    if (await this.warExists()) {
      const result = await this.deploy();
      return result.deployed;
    }
    return false;
  }

  /**
   * Deploy WAR with auto mode selection.
   * In aggressive mode: full restart cycle (stop → kill → start → deploy)
   * In normal mode: hot deploy via asadmin deploy --force
   */
  async deployAuto(): Promise<{
    deployed: boolean;
    applications: string[];
    deploymentTime: number;
    aggressiveMode: boolean;
  }> {
    const startTime = Date.now();
    const deploymentId = `auto-${Date.now()}`;

    // Mark deployment started for status tracking
    this.markDeploymentStarted(deploymentId);

    try {
      if (this.aggressiveMode) {
        this.logger.info('Using aggressive mode for deployment');

        // Full restart cycle: stop → kill → start → deploy
        this.setDeploymentStep('stopping');
        await this.payara.aggressiveStop();

        this.setDeploymentStep('starting');
        await this.payara.safeStart();

        this.setDeploymentStep('deploying');
        await this.payara.deploy(this.warPath, this.appName, this.contextRoot);

        this.setDeploymentStep('verifying');
        const applications = await this.payara.listApplications();
        const isDeployed = applications.includes(this.appName);

        const result = {
          deployed: isDeployed,
          applications,
          deploymentTime: Date.now() - startTime,
          aggressiveMode: true,
        };

        // Mark completed
        this.markDeploymentCompleted({
          success: isDeployed,
          filesChanged: 0,
          filesDeleted: 0,
          message: isDeployed ? 'Deployment successful' : 'Deployment failed',
          deploymentTime: result.deploymentTime,
          appName: this.appName,
          deployed: isDeployed,
          applications,
        });

        return result;
      } else {
        // Normal hot deploy
        this.setDeploymentStep('deploying');
        const result = await this.deploy();

        const autoResult = {
          ...result,
          deploymentTime: Date.now() - startTime,
          aggressiveMode: false,
        };

        // Mark completed
        this.markDeploymentCompleted({
          success: result.deployed,
          filesChanged: 0,
          filesDeleted: 0,
          message: result.deployed ? 'Deployment successful' : 'Deployment failed',
          deploymentTime: autoResult.deploymentTime,
          appName: this.appName,
          deployed: result.deployed,
          applications: result.applications,
        });

        return autoResult;
      }
    } catch (err) {
      // Mark failed
      this.markDeploymentCompleted({
        success: false,
        filesChanged: 0,
        filesDeleted: 0,
        message: getErrorMessage(err),
        deploymentTime: Date.now() - startTime,
        appName: this.appName,
      });
      throw err;
    }
  }

  /**
   * Check if deployment is in progress
   */
  isDeploying(): boolean {
    return this.deployLock;
  }

  /**
   * Get current deployment status for polling
   * Used by CLI to check if a long-running deployment has completed
   */
  getDeploymentStatus(): DeploymentStatus {
    return this.statusTracker.getStatus(this.deployLock);
  }

  /**
   * Update current deployment step (for status tracking)
   */
  private setDeploymentStep(step: string): void {
    this.statusTracker.setStep(step);
  }

  /**
   * Mark deployment as started (for status tracking)
   */
  private markDeploymentStarted(deploymentId: string): void {
    this.statusTracker.markStarted(deploymentId);
  }

  /**
   * Mark deployment as completed (for status tracking)
   */
  private markDeploymentCompleted(result: DeployResult): void {
    this.statusTracker.markCompleted(result);
  }

  /**
   * Get the WAR file path
   */
  getWarPath(): string {
    return this.warPath;
  }

  /**
   * Get application name
   */
  getAppName(): string {
    return this.appName;
  }

  /**
   * Get a specific file from the WAR
   */
  async getFile(path: string): Promise<Buffer | null> {
    if (!(await this.warExists())) {
      return null;
    }

    try {
      const zip = new AdmZip(this.warPath);
      const entry = zip.getEntry(path);

      if (!entry || entry.isDirectory) {
        return null;
      }

      return entry.getData();
    } catch (err) {
      this.logger.error({ err, path }, 'Failed to read file from WAR');
      return null;
    }
  }

  /**
   * Check if application is currently deployed
   */
  async isAppDeployed(): Promise<boolean> {
    const applications = await this.payara.listApplications();
    return applications.includes(this.appName);
  }

  /**
   * Undeploy the application
   */
  async undeploy(): Promise<void> {
    await this.payara.undeploy(this.appName);
  }

  // ============================================================================
  // FULL DEPLOYMENT WITH RESTART (Aggressive Mode)
  // User-requested flow: undeploy → stop → kill → start → deploy
  // ============================================================================

  /**
   * Full deployment with complete Payara restart (aggressive mode).
   *
   * This method follows the exact sequence requested:
   * 1. Apply changes to WAR file (while Payara still running)
   * 2. Undeploy current application
   * 3. Stop Payara domain gracefully
   * 4. Kill Payara Java processes (filtered by cmdline)
   * 5. Start Payara fresh
   * 6. Deploy WAR file
   *
   * This ensures:
   * - Only ONE Java process runs at a time
   * - Clean deployment without conflicts
   * - No orphan processes
   * - SIGTERM is deferred during deployment
   * - Deployment progress is journaled for crash recovery
   *
   * @param changedFiles - Files to add/update in WAR
   * @param deletedFiles - Files to remove from WAR
   * @returns Full deployment result with timing details
   */
  async deployWithFullRestart(
    changedFiles: FileChange[],
    deletedFiles: string[]
  ): Promise<FullDeployResult> {
    // Check in-memory lock first (quick check for same-process concurrency)
    if (this.deployLock) {
      throw new Error('Deployment already in progress');
    }

    const startTime = Date.now();
    const deploymentId = `deploy-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const timings: FullDeployResult['timings'] = {};

    // Acquire file-based lock FIRST (handles cross-process concurrency + SIGTERM deferral)
    // This also checks for stale locks and cleans them up
    // If this throws, we don't set in-memory lock (desired behavior)
    await this.fileLock.acquire(deploymentId);

    // Only set in-memory lock after file lock is successfully acquired
    this.deployLock = true;

    try {

      // Start deployment journal
      await this.journal.start({
        deploymentId,
        warPath: this.warPath,
        appName: this.appName,
        contextRoot: this.contextRoot,
        changedFiles: changedFiles.map(f => f.path),
        deletedFiles,
      });

      this.logger.info({
        deploymentId,
        changed: changedFiles.length,
        deleted: deletedFiles.length,
        aggressiveMode: true,
      }, 'Starting full deployment with restart');

      // ======================================================================
      // STEP 1: Apply changes to WAR file (while Payara still running)
      // ======================================================================
      await this.fileLock.updateStep('war-update');
      await this.journal.updateStep('war-update');

      const warUpdateStart = Date.now();
      await this.applyChangesWithoutDeploy(changedFiles, deletedFiles);
      timings.warUpdate = Date.now() - warUpdateStart;
      this.logger.info({ duration: timings.warUpdate }, 'WAR file updated');

      // ======================================================================
      // STEP 2: Undeploy current application (if deployed)
      // ======================================================================
      await this.fileLock.updateStep('undeploy');
      await this.journal.updateStep('undeploy');

      const undeployStart = Date.now();
      try {
        const isDeployed = await this.isAppDeployed();
        if (isDeployed) {
          await this.payara.undeploy(this.appName);
          this.logger.info({ appName: this.appName }, 'Application undeployed');
        } else {
          this.logger.debug({ appName: this.appName }, 'Application not deployed, skipping undeploy');
        }
      } catch (err) {
        this.logger.warn({ err }, 'Undeploy failed (continuing with restart)');
      }
      timings.undeploy = Date.now() - undeployStart;

      // ======================================================================
      // STEP 3: Stop Payara domain gracefully
      // ======================================================================
      await this.fileLock.updateStep('stop');
      await this.journal.updateStep('stop');

      const stopStart = Date.now();

      // ======================================================================
      // STEP 4: Kill Payara Java processes (filtered by cmdline)
      // ======================================================================
      await this.fileLock.updateStep('kill');
      await this.journal.updateStep('kill');

      await this.payara.aggressiveStop();
      timings.stop = Date.now() - stopStart;
      this.logger.info({ duration: timings.stop }, 'Payara stopped and Payara Java processes killed');

      // ======================================================================
      // STEP 5: Start Payara fresh (verifies no Java running first)
      // ======================================================================
      await this.fileLock.updateStep('start');
      await this.journal.updateStep('start');

      const startPayaraStart = Date.now();
      await this.payara.safeStart();
      timings.start = Date.now() - startPayaraStart;
      this.logger.info({ duration: timings.start }, 'Payara started fresh');

      // ======================================================================
      // STEP 6: Deploy WAR file
      // ======================================================================
      await this.fileLock.updateStep('deploy');
      await this.journal.updateStep('deploy');

      const deployStart = Date.now();
      await this.payara.deploy(this.warPath, this.appName, this.contextRoot);
      timings.deploy = Date.now() - deployStart;

      // ======================================================================
      // STEP 7: Verify deployment
      // ======================================================================
      await this.fileLock.updateStep('verify');
      await this.journal.updateStep('verify');

      const applications = await this.payara.listApplications();
      const isDeployed = applications.includes(this.appName);

      if (!isDeployed) {
        throw new Error(`Deployment verification failed: ${this.appName} not in application list`);
      }

      const totalDuration = Date.now() - startTime;

      // Mark as complete
      await this.journal.complete();

      this.logger.info({
        deploymentId,
        appName: this.appName,
        deployed: true,
        duration: totalDuration,
        timings,
      }, 'Full deployment with restart completed successfully');

      return {
        success: true,
        filesChanged: changedFiles.length,
        filesDeleted: deletedFiles.length,
        message: 'Deployment with full restart completed successfully',
        deploymentTime: totalDuration,
        appName: this.appName,
        deployed: true,
        applications,
        timings,
        aggressiveMode: true,
      };

    } catch (err) {
      const totalDuration = Date.now() - startTime;
      this.logger.error({ err, deploymentId, duration: totalDuration, timings }, 'Full deployment failed');

      // Don't clear journal on failure - useful for debugging

      return {
        success: false,
        filesChanged: changedFiles.length,
        filesDeleted: deletedFiles.length,
        message: getErrorMessage(err),
        deploymentTime: totalDuration,
        appName: this.appName,
        deployed: false,
        timings,
        aggressiveMode: true,
      };

    } finally {
      this.deployLock = false;
      // Release file-based lock (may trigger deferred SIGTERM)
      await this.fileLock.release();
    }
  }

  /**
   * Apply changes and deploy - uses aggressive mode if configured
   */
  async applyChangesAuto(
    changedFiles: FileChange[],
    deletedFiles: string[]
  ): Promise<DeployResult | FullDeployResult> {
    if (this.aggressiveMode) {
      return this.deployWithFullRestart(changedFiles, deletedFiles);
    }
    return this.applyChanges(changedFiles, deletedFiles);
  }
}
