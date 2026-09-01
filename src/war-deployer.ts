// Path: src/war-deployer.ts
// WAR file deployer with diff-based updates - uses asadmin deploy commands only

import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { linkSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { writeFile, mkdir, rm, stat, lstat, readFile, open } from 'node:fs/promises';
import { join, dirname, normalize, isAbsolute, basename } from 'node:path';
import AdmZip from 'adm-zip';
import type { Logger } from 'pino';
import type { PayaraManager } from './payara-manager.js';
import type {
  WarDeployerOptions,
  WarFileHashes,
  WarArtifactIdentity,
  WarArtifactReadback,
  DeploymentArtifactExpectation,
  FileChange,
  DeployResult,
  FullDeployResult,
  BootDeploymentStatus,
  BootRecoveryAuthorization,
  BootRecoveryResult,
  PostStartDeploymentPolicy,
  PostStartDeploymentResult,
} from './types.js';
import { DeploymentLock, type DeploymentStep } from './deployment-lock.js';
import { DeploymentJournal } from './deployment-journal.js';
import { createTempDir, cleanupTempDir, withTempDir } from './utils/temp-dir.js';
import { getErrorMessage } from './utils/error.js';
import { DeploymentStatusTracker } from './deployment-status.js';
import type { DeploymentStatus } from './deployment-status.js';
import { addDirectoryToZip } from './utils/zip.js';
import {
  calculateWarContentSha256,
  calculateWarEntryHashes,
} from './war-utils.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

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
export {
  calculateDiff,
  calculateWarContentSha256,
  calculateWarEntryHashes,
  calculateWarHashes,
  getWarEntry,
  readLocalWarArtifactSnapshot,
} from './war-utils.js';

// Re-export DeploymentStatus type for backwards compatibility
export type { DeploymentStatus } from './deployment-status.js';

interface AutoDeployResult {
  deployed: boolean;
  applications: string[];
  deploymentTime: number;
  aggressiveMode: boolean;
  artifact?: WarArtifactIdentity;
  targetContentSha256?: string;
}

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
  private readonly deploymentLockContext = new AsyncLocalStorage<symbol>();
  private activeDeploymentLockToken?: symbol;

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
    this.fileLock = new DeploymentLock(options.logger, options.deploymentLockPath);
    this.journal = new DeploymentJournal(options.logger);
    this.statusTracker = new DeploymentStatusTracker(options.logger);
    this.payara.registerApplication?.(this.appName);
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

    // Also report stale lock files. They are deliberately not auto-removed:
    // pathname-based stale reaping cannot atomically prove it is not deleting a
    // successor lock. An operator must verify the dead PID and remove it while
    // deployment entry points are quiesced.
    const { locked, data, stale } = await this.fileLock.isLocked();
    if (stale && data) {
      this.logger.error(
        { oldDeploymentId: data.deploymentId, step: data.step },
        'Found stale deployment lock; automatic takeover is disabled'
      );
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
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.warPath, 'r');
      const metadata = await handle.stat();
      return metadata.isFile() && metadata.size > 0;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private validateArtifactExpectation(
    expectation: DeploymentArtifactExpectation
  ): void {
    if (
      expectation.expectedBaseSha256 !== null
      && !SHA256_PATTERN.test(expectation.expectedBaseSha256)
    ) {
      throw new Error(
        'ARTIFACT_EXPECTATION_INVALID: expectedBaseSha256 must be a lowercase SHA-256 or null'
      );
    }
    if (!SHA256_PATTERN.test(expectation.targetContentSha256)) {
      throw new Error(
        'ARTIFACT_EXPECTATION_INVALID: targetContentSha256 must be a lowercase SHA-256'
      );
    }
  }

  /**
   * Validate the caller's exact whole-WAR base token while holding the shared
   * mutation lock, and return those same bytes as the delta extraction source.
   */
  private async readArtifactBaseForMutation(
    expectation?: DeploymentArtifactExpectation
  ): Promise<Buffer | null> {
    if (expectation) this.validateArtifactExpectation(expectation);

    // Preserve the regular, non-empty WAR preflight while the shared mutation
    // lock is held. Identity never relies on this probe: the exact bytes read
    // immediately below remain the extraction source and CAS token.
    const readableRegularWar = await this.warExists();

    let artifact: Buffer | null;
    try {
      artifact = await readFile(this.warPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      artifact = null;
    }

    if (
      expectation
      && readableRegularWar !== (artifact !== null && artifact.byteLength > 0)
    ) {
      throw new Error(
        'ARTIFACT_BASE_DRIFT: persisted WAR changed while acquiring its exact base snapshot'
      );
    }

    if (!expectation) return artifact;

    const actualSha256 = artifact
      ? createHash('sha256').update(artifact).digest('hex')
      : null;
    if (actualSha256 !== expectation.expectedBaseSha256) {
      throw new Error(
        'ARTIFACT_BASE_DRIFT: persisted WAR no longer matches the exact /hashes observation'
      );
    }
    return artifact;
  }

  /** Prove the persisted logical WAR is exactly the caller's target. */
  private async verifyTargetArtifact(
    expectation?: DeploymentArtifactExpectation
  ): Promise<WarArtifactIdentity> {
    const artifact = await this.getCurrentArtifactReadback();
    if (!artifact) {
      throw new Error('ARTIFACT_READBACK_FAILED: WAR is absent after deployment mutation');
    }
    if (
      expectation
      && artifact.contentSha256 !== expectation.targetContentSha256
    ) {
      throw new Error(
        'ARTIFACT_TARGET_MISMATCH: persisted WAR content does not match the requested target'
      );
    }
    return {
      size: artifact.size,
      sha256: artifact.sha256,
      contentSha256: artifact.contentSha256,
    };
  }

  private assertProposedTargetArtifact(
    artifact: Buffer,
    expectation?: DeploymentArtifactExpectation
  ): void {
    if (!expectation) return;
    this.validateArtifactExpectation(expectation);
    const targetContentSha256 = calculateWarContentSha256(
      calculateWarEntryHashes(artifact)
    );
    if (targetContentSha256 !== expectation.targetContentSha256) {
      throw new Error(
        'ARTIFACT_TARGET_MISMATCH: proposed WAR content does not match the requested target'
      );
    }
  }

  /**
   * Final pathname CAS immediately before the synchronous rename. The shared
   * deployment lock is the controller-to-controller exclusion primitive; this
   * non-yielding recheck additionally detects an out-of-contract writer that
   * replaced the WAR while the proposed archive was being prepared.
   */
  private assertArtifactBaseAtCommit(
    expectedBaseSha256: string | null | undefined
  ): void {
    if (expectedBaseSha256 === undefined) return;

    let actualBaseSha256: string | null;
    try {
      const artifact = readFileSync(this.warPath);
      actualBaseSha256 = createHash('sha256').update(artifact).digest('hex');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      actualBaseSha256 = null;
    }
    if (actualBaseSha256 !== expectedBaseSha256) {
      throw new Error(
        'ARTIFACT_BASE_DRIFT: persisted WAR changed before the atomic commit'
      );
    }
  }

  /** Read the exact stored WAR once and return only its bounded byte identity. */
  async getCurrentArtifactIdentity(): Promise<WarArtifactIdentity | null> {
    try {
      const artifact = await readFile(this.warPath);
      const hashes = calculateWarEntryHashes(artifact);
      return {
        size: artifact.byteLength,
        sha256: createHash('sha256').update(artifact).digest('hex'),
        contentSha256: calculateWarContentSha256(hashes),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      this.logger.error({ err, warPath: this.warPath }, 'Failed to read WAR identity');
      throw err;
    }
  }

  /**
   * Read the exact stored WAR once and return both its byte identity and entry hashes.
   *
   * A single read prevents a deployment racing the endpoint between a whole-artifact
   * digest and the per-entry digest map. The result remains observation only.
   */
  async getCurrentArtifactReadback(): Promise<WarArtifactReadback | null> {
    try {
      const artifact = await readFile(this.warPath);
      const hashes = calculateWarEntryHashes(artifact);
      return {
        size: artifact.byteLength,
        sha256: createHash('sha256').update(artifact).digest('hex'),
        contentSha256: calculateWarContentSha256(hashes),
        hashes,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      this.logger.error({ err, warPath: this.warPath }, 'Failed to read WAR file');
      throw err;
    }
  }

  /** Get SHA-256 hashes of all files in the WAR. */
  async getCurrentHashes(): Promise<WarFileHashes> {
    return (await this.getCurrentArtifactReadback())?.hashes ?? {};
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
    deletedFiles: string[],
    requestedDeploymentId?: string,
    artifactExpectation?: DeploymentArtifactExpectation
  ): Promise<DeployResult> {
    if (this.deployLock) {
      throw new Error('Deployment already in progress');
    }

    const startTime = Date.now();
    const deploymentId = requestedDeploymentId
      ?? `diff-${Date.now()}-${randomBytes(4).toString('hex')}`;
    return this.withDeploymentTracking(
      deploymentId,
      async () => {
        this.deployLock = true;
        let tempDir: string | undefined;
        let fileLockAcquired = false;
        let operationError: unknown;

        try {
          await this.fileLock.acquire(deploymentId);
          fileLockAcquired = true;
          await this.fileLock.updateStep('war-update');
          const workingDir = await createTempDir('war-deploy');
          tempDir = workingDir;
          return await this.withOwnedDeploymentLockContext(() =>
            this.withPayaraLease(`apply-changes:${this.appName}`, async () => {
            this.logger.info({
              changed: changedFiles.length,
              deleted: deletedFiles.length,
            }, 'Applying WAR changes');

            // Bind the delta to the exact /hashes observation while the
            // cross-process deployment lock is held. The returned bytes are
            // also the extraction source, so there is no check/re-open gap.
            const baseArtifact = await this.readArtifactBaseForMutation(
              artifactExpectation
            );
            if (baseArtifact) {
              const zip = new AdmZip(baseArtifact);
              zip.extractAllTo(workingDir, true);
            }

            // Apply deletions (with path traversal protection)
            for (const file of deletedFiles) {
              const fullPath = getSafePath(workingDir, file);
              await rm(fullPath, { force: true });
              this.logger.debug({ file }, 'Deleted file');
            }

            // Apply changes (with path traversal protection)
            for (const { path, content } of changedFiles) {
              const fullPath = getSafePath(workingDir, path);
              const dir = dirname(fullPath);
              await mkdir(dir, { recursive: true });
              await writeFile(fullPath, content);
              this.logger.debug({ path, size: content.length }, 'Updated file');
            }

            const newZip = new AdmZip();
            await addDirectoryToZip(newZip, workingDir, '');
            const proposedArtifact = newZip.toBuffer();
            this.assertProposedTargetArtifact(proposedArtifact, artifactExpectation);
            const artifactBootEpoch = await this.payara.assertArtifactMutationAllowed(this.appName);
            await this.replaceWarAtomically(
              tempPath => writeFile(tempPath, proposedArtifact),
              artifactBootEpoch,
              artifactExpectation
                ? { expectedBaseSha256: artifactExpectation.expectedBaseSha256 }
                : undefined
            );
            let artifact = await this.verifyTargetArtifact(artifactExpectation);

            this.logger.info({ warPath: this.warPath }, 'WAR file updated');
            await this.fileLock.updateStep('deploy');
            const deployResult = await this.deploy();
            await this.fileLock.updateStep('verify');
            artifact = await this.verifyTargetArtifact(artifactExpectation);
            const duration = Date.now() - startTime;

            return {
              success: true,
              filesChanged: changedFiles.length,
              filesDeleted: deletedFiles.length,
              message: 'Deployment successful',
              deploymentTime: duration,
              appName: this.appName,
              artifact,
              ...(artifactExpectation ? {
                targetContentSha256: artifactExpectation.targetContentSha256,
              } : {}),
              ...deployResult,
            };
            })
          );
        } catch (err) {
          operationError = err;
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
          try {
            if (tempDir) {
              await cleanupTempDir(tempDir, this.logger);
            }
            if (fileLockAcquired) {
              await this.closeDeploymentLock(operationError);
            }
          } finally {
            this.deployLock = false;
          }
        }
      },
      result => result,
      err => ({
        success: false,
        filesChanged: changedFiles.length,
        filesDeleted: deletedFiles.length,
        message: getErrorMessage(err),
        deploymentTime: Date.now() - startTime,
        appName: this.appName,
      })
    );
  }

  /**
   * Apply file changes to WAR without deploying to Payara
   * (Useful for testing or when deployment is handled separately)
   */
  async applyChangesWithoutDeploy(
    changedFiles: FileChange[],
    deletedFiles: string[],
    artifactExpectation?: DeploymentArtifactExpectation
  ): Promise<WarArtifactIdentity> {
    return this.withDeploymentLock(`war-update:${this.appName}`, 'war-update', () =>
      this.applyChangesWithoutDeployUnlocked(
        changedFiles,
        deletedFiles,
        artifactExpectation
      )
    );
  }

  private async applyChangesWithoutDeployUnlocked(
    changedFiles: FileChange[],
    deletedFiles: string[],
    artifactExpectation?: DeploymentArtifactExpectation
  ): Promise<WarArtifactIdentity> {
    return withTempDir('war-update', async (tempDir) => {
      this.logger.debug({
        changed: changedFiles.length,
        deleted: deletedFiles.length,
      }, 'Applying WAR changes (no deploy)');

      const baseArtifact = await this.readArtifactBaseForMutation(artifactExpectation);
      if (baseArtifact) {
        const zip = new AdmZip(baseArtifact);
        zip.extractAllTo(tempDir, true);
      }

      // Apply deletions (with path traversal protection)
      for (const file of deletedFiles) {
        const fullPath = getSafePath(tempDir, file);
        await rm(fullPath, { force: true });
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
      const proposedArtifact = newZip.toBuffer();
      this.assertProposedTargetArtifact(proposedArtifact, artifactExpectation);

      const warDir = dirname(this.warPath);
      await mkdir(warDir, { recursive: true });

      const artifactBootEpoch = await this.payara.assertArtifactMutationAllowed(this.appName);
      await this.replaceWarAtomically(
        tempPath => writeFile(tempPath, proposedArtifact),
        artifactBootEpoch,
        artifactExpectation
          ? { expectedBaseSha256: artifactExpectation.expectedBaseSha256 }
          : undefined
      );
      return this.verifyTargetArtifact(artifactExpectation);
    });
  }

  /**
   * Deploy WAR to Payara using asadmin deploy command
   * Uses --force flag for hot deployment/redeploy
   *
   * IMPORTANT: This does NOT use autodeploy. It uses explicit asadmin commands.
   */
  async deploy(): Promise<{ deployed: boolean; applications: string[] }> {
    return this.withDeploymentLock(
      `war-deploy:${this.appName}`,
      'deploy',
      () => this.deployUnlocked()
    );
  }

  private async deployUnlocked(): Promise<{ deployed: boolean; applications: string[] }> {
    if (!(await this.warExists())) {
      throw new Error(`WAR_NOT_FOUND: no WAR file exists at ${this.warPath}`);
    }

    this.logger.info({ warPath: this.warPath, appName: this.appName }, 'Deploying WAR via asadmin');

    // Ensure Payara is running
    const isRunning = await this.payara.isRunning();

    if (!isRunning) {
      this.logger.info('Starting Payara for deployment');
      await this.fileLock.updateStep('start');
      await this.payara.start({ waitForApplicationHealth: false });
      await this.fileLock.updateStep('deploy');
      const result = await this.deployAfterStart('require-agent-owned');
      if (result.outcome !== 'agent-deployed') {
        throw new Error('BOOT_OWNER_CONFLICT: Payara owns the post-start deployment');
      }
      return {
        deployed: result.deployed,
        applications: result.applications,
      };
    }

    // Deploy WAR with --force flag (hot deployment/redeploy)
    await this.payara.deploy(this.warPath, this.appName, this.contextRoot);

    // Verify deployment
    const applications = await this.payara.listApplications();
    const isDeployed = applications.includes(this.appName);

    if (isDeployed) {
      this.logger.info({ appName: this.appName, applications }, 'WAR deployed successfully');
    } else {
      throw new Error(
        `DEPLOYMENT_VERIFICATION_FAILED: ${this.appName} is absent from the Payara application inventory`
      );
    }

    return { deployed: isDeployed, applications };
  }

  /**
   * Reconcile the single-writer contract immediately after start-domain.
   *
   * If Payara has a persistent target reference, it owns boot deployment and
   * startup callers must leave it untouched. Agent-owned deployment is allowed
   * only after a continuous absence proof and a final fresh-deploy recheck.
   */
  async deployAfterStart(
    policy: PostStartDeploymentPolicy
  ): Promise<PostStartDeploymentResult> {
    return this.withDeploymentLock(`post-start-deploy:${this.appName}`, 'deploy', async () => {
      if (!(await this.warExists())) {
        throw new Error(`WAR_NOT_FOUND: No WAR file exists at ${this.warPath}`);
      }

      const result = await this.payara.reconcilePostStartDeployment(
        this.warPath,
        this.appName,
        this.contextRoot,
        policy
      );
      if (result.outcome === 'boot-owned-skip') {
        this.logger.warn(
          {
            appName: this.appName,
            bootEpoch: result.bootEpoch,
            deployedObserved: result.deployedObserved,
            deploymentAttempted: false,
            readiness: result.readiness,
          },
          'Skipping explicit deployment because Payara owns boot restoration'
        );
      }
      return result;
    });
  }

  /**
   * Observe startup ownership without mutating the application.
   *
   * Plugin onStart deliberately uses this read-only path even when a WAR is
   * present. A first deployment or a stuck Payara-owned boot is handled only
   * after the plugin is running, through an explicit operator request that is
   * not subject to the agent's non-cancelling onStart timeout.
   */
  async observeStartupOwnership(deadlineMs?: number): Promise<BootDeploymentStatus> {
    return this.withDeploymentLock(
      `post-start-observe:${this.appName}`,
      'verify',
      () => this.payara.observeBootOwnership(this.appName, deadlineMs)
    );
  }

  /** @deprecated Use observeStartupOwnership(); retained for source compatibility. */
  async reconcileStartupOwnershipWithoutArtifact(): Promise<BootDeploymentStatus> {
    return this.observeStartupOwnership();
  }

  /**
   * Immediately consume explicit recovery authority under the same shared file
   * lock and Payara mutation lease. This is the only supported automatic escape
   * from ref-present/app-absent Payara boot ownership.
   */
  async recoverBootDeployment(
    authorization: BootRecoveryAuthorization
  ): Promise<BootRecoveryResult> {
    return this.withDeploymentLock(
      `operator-boot-recovery:${this.appName}`,
      'deploy',
      async () => {
        if (!(await this.warExists())) {
          throw new Error(`WAR_NOT_FOUND: No readable regular WAR exists at ${this.warPath}`);
        }
        return this.payara.recoverBootDeployment(
          this.warPath,
          this.appName,
          this.contextRoot,
          authorization
        );
      }
    );
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
  async deployAuto(
    deploymentId?: string,
    artifactExpectation?: DeploymentArtifactExpectation
  ): Promise<AutoDeployResult> {
    return this.deployAutoWithPreparation(
      undefined,
      deploymentId,
      artifactExpectation
    );
  }

  /** Atomically write a complete WAR and deploy it under the same deployment lease. */
  async deployUploadedWar(
    warBuffer: Buffer,
    deploymentId?: string,
    artifactExpectation?: DeploymentArtifactExpectation
  ): Promise<AutoDeployResult> {
    const uploadedHashes = calculateWarEntryHashes(warBuffer);
    if (Object.keys(uploadedHashes).length === 0) {
      throw new Error('WAR_ARTIFACT_INVALID: uploaded WAR has no file entries');
    }
    const uploadedContentSha256 = calculateWarContentSha256(uploadedHashes);
    if (artifactExpectation) {
      this.validateArtifactExpectation(artifactExpectation);
      if (uploadedContentSha256 !== artifactExpectation.targetContentSha256) {
        throw new Error(
          'ARTIFACT_TARGET_MISMATCH: uploaded WAR does not match the requested target'
        );
      }
    }
    return this.deployAutoWithPreparation(async artifactBootEpoch => {
      await this.replaceWarAtomically(
        tempPath => writeFile(tempPath, warBuffer, { mode: 0o640 }),
        artifactBootEpoch,
        artifactExpectation
          ? { expectedBaseSha256: artifactExpectation.expectedBaseSha256 }
          : undefined
      );
      this.logger.info(
        { warPath: this.warPath, size: warBuffer.length },
        'WAR file uploaded under deployment lease'
      );
    }, deploymentId, artifactExpectation);
  }

  /**
   * Stage the first recovery WAR without deploying it or releasing the boot
   * ownership fence. This deliberately works only while the target is absent;
   * ordinary artifact replacement continues to require the normal mutation
   * preflight.
   */
  async stageMissingRecoveryArtifact(
    warBuffer: Buffer,
    expectedBootEpoch: string
  ): Promise<WarArtifactIdentity> {
    if (warBuffer.length === 0) {
      throw new Error('BOOT_RECOVERY_ARTIFACT_INVALID: staged WAR is empty');
    }
    let entryHashes: WarFileHashes;
    try {
      entryHashes = calculateWarEntryHashes(warBuffer);
    } catch (err) {
      throw new Error(
        `BOOT_RECOVERY_ARTIFACT_INVALID: staged bytes are not a readable WAR: ${getErrorMessage(err)}`
      );
    }
    if (Object.keys(entryHashes).length === 0) {
      throw new Error('BOOT_RECOVERY_ARTIFACT_INVALID: staged WAR has no file entries');
    }
    const stagedIdentity: WarArtifactIdentity = {
      size: warBuffer.byteLength,
      sha256: createHash('sha256').update(warBuffer).digest('hex'),
      contentSha256: calculateWarContentSha256(entryHashes),
    };

    if (!expectedBootEpoch) {
      throw new Error(
        'BOOT_EPOCH_MISMATCH: an explicit current bootEpoch is required for recovery staging'
      );
    }

    return this.withDeploymentLock(
      `operator-artifact-stage:${this.appName}`,
      'war-update',
      async () => {
        await this.payara.assertMissingRecoveryArtifactStageAllowed(
          this.appName,
          expectedBootEpoch
        );
        let existingPath = false;
        try {
          await lstat(this.warPath);
          existingPath = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        if (existingPath) {
          throw new Error(
            `BOOT_RECOVERY_ARTIFACT_ALREADY_PRESENT: ${this.warPath} already exists`
          );
        }
        await this.replaceWarAtomically(
          tempPath => writeFile(tempPath, warBuffer, { mode: 0o640 }),
          undefined,
          {
            noOverwrite: true,
            beforeCommit: () =>
              this.payara.assertMissingRecoveryArtifactStageAllowed(
                this.appName,
                expectedBootEpoch
              ),
          }
        );
        const identity = await this.getCurrentArtifactIdentity();
        if (
          !identity
          || identity.size !== stagedIdentity.size
          || identity.sha256 !== stagedIdentity.sha256
          || identity.contentSha256 !== stagedIdentity.contentSha256
        ) {
          throw new Error(
            'BOOT_RECOVERY_ARTIFACT_WRITE_MISMATCH: staged WAR readback failed'
          );
        }
        this.logger.warn(
          {
            warPath: this.warPath,
            size: identity.size,
            sha256: identity.sha256,
            deploymentAttempted: false,
          },
          'Staged missing recovery WAR without changing boot ownership'
        );
        return identity;
      }
    );
  }

  private async deployAutoWithPreparation(
    preparation?: (artifactBootEpoch: string) => Promise<void>,
    requestedDeploymentId?: string,
    artifactExpectation?: DeploymentArtifactExpectation
  ): Promise<AutoDeployResult> {
    if (this.deployLock) {
      throw new Error('Deployment already in progress');
    }

    const startTime = Date.now();
    const deploymentId = requestedDeploymentId
      ?? `auto-${Date.now()}-${randomBytes(4).toString('hex')}`;
    return this.withDeploymentTracking(
      deploymentId,
      async () => {
        this.deployLock = true;
        let fileLockAcquired = false;
        let operationError: unknown;

        try {
          await this.fileLock.acquire(deploymentId);
          fileLockAcquired = true;
          return await this.withOwnedDeploymentLockContext(() =>
            this.withPayaraLease(`deploy-auto:${this.appName}`, async () => {
        if (artifactExpectation) {
          await this.readArtifactBaseForMutation(artifactExpectation);
        }
        if (!preparation && !(await this.warExists())) {
          throw new Error(`WAR_NOT_FOUND: No readable regular WAR exists at ${this.warPath}`);
        }
        const artifactBootEpoch = preparation
          ? await this.payara.assertArtifactMutationAllowed(this.appName)
          : undefined;
        if (preparation && artifactBootEpoch) {
          await preparation(artifactBootEpoch);
        }
        let artifact = artifactExpectation
          ? await this.verifyTargetArtifact(artifactExpectation)
          : undefined;
        if (!(await this.warExists())) {
          throw new Error(`WAR_NOT_FOUND: No readable regular WAR exists at ${this.warPath}`);
        }
        if (this.aggressiveMode) {
          this.logger.info('Using aggressive mode for deployment');

          // Remove the persistent application ref before start-domain. Otherwise
          // Payara becomes a second writer by restoring the app during boot.
          this.setDeploymentStep('undeploying');
          await this.fileLock.updateStep('undeploy');
          await this.payara.prepareAggressiveRestart(this.appName);

          // Full restart cycle: undeploy → stop → kill → start → fresh deploy
          this.setDeploymentStep('stopping');
          await this.fileLock.updateStep('stop');
          await this.payara.aggressiveStop();

          this.setDeploymentStep('starting');
          await this.fileLock.updateStep('start');
          await this.payara.safeStart({ waitForApplicationHealth: false });

          this.setDeploymentStep('deploying');
          await this.fileLock.updateStep('deploy');
          const postStart = await this.deployAfterStart('require-agent-owned');
          if (postStart.outcome !== 'agent-deployed') {
            throw new Error('BOOT_OWNER_CONFLICT: Payara retained deployment ownership');
          }

          this.setDeploymentStep('verifying');
          await this.fileLock.updateStep('verify');
          const { applications, deployed: isDeployed } = postStart;
          if (artifactExpectation) {
            artifact = await this.verifyTargetArtifact(artifactExpectation);
          }

          const result = {
            deployed: isDeployed,
            applications,
            deploymentTime: Date.now() - startTime,
            aggressiveMode: true,
            ...(artifact ? { artifact } : {}),
            ...(artifactExpectation ? {
              targetContentSha256: artifactExpectation.targetContentSha256,
            } : {}),
          };

          return result;
        } else {
          // Normal hot deploy
          this.setDeploymentStep('deploying');
          await this.fileLock.updateStep('deploy');
          const result = await this.deploy();

          this.setDeploymentStep('verifying');
          await this.fileLock.updateStep('verify');
          if (artifactExpectation) {
            artifact = await this.verifyTargetArtifact(artifactExpectation);
          }
          const autoResult = {
            ...result,
            deploymentTime: Date.now() - startTime,
            aggressiveMode: false,
            ...(artifact ? { artifact } : {}),
            ...(artifactExpectation ? {
              targetContentSha256: artifactExpectation.targetContentSha256,
            } : {}),
          };

          return autoResult;
        }
            })
          );
        } catch (err) {
          operationError = err;
          throw err;
        } finally {
          try {
            if (fileLockAcquired) {
              await this.closeDeploymentLock(operationError);
            }
          } finally {
            this.deployLock = false;
          }
        }
      },
      result => ({
        success: result.deployed,
        filesChanged: 0,
        filesDeleted: 0,
        message: result.deployed ? 'Deployment successful' : 'Deployment failed',
        deploymentTime: result.deploymentTime,
        appName: this.appName,
        deployed: result.deployed,
        applications: result.applications,
        artifact: result.artifact,
        targetContentSha256: result.targetContentSha256,
      }),
      err => ({
        success: false,
        filesChanged: 0,
        filesDeleted: 0,
        message: getErrorMessage(err),
        deploymentTime: Date.now() - startTime,
        appName: this.appName,
        deployed: false,
      })
    );
  }

  /**
   * Check if deployment is in progress
   */
  isDeploying(): boolean {
    return this.deployLock || (this.payara.isMutationInProgress?.() ?? false);
  }

  /**
   * Hold the shared deployment lock across any WAR or Payara mutation.
   *
   * AsyncLocalStorage makes nested calls from the current operation re-entrant
   * without allowing an unrelated request in the same process to bypass the
   * lock. A second plugin process contends on the same create-exclusive path.
   */
  async withDeploymentLock<T>(
    label: string,
    step: DeploymentStep,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.withDeploymentFileLockInternal(label, step, operation, true);
  }

  /**
   * Hold only the cross-process file lock. Readiness attestation uses this
   * variant because it performs its own atomic Payara lease preflight.
   */
  async withDeploymentFileLock<T>(
    label: string,
    step: DeploymentStep,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.withDeploymentFileLockInternal(label, step, operation, false);
  }

  private async withDeploymentFileLockInternal<T>(
    label: string,
    step: DeploymentStep,
    operation: () => Promise<T>,
    acquirePayaraLease: boolean
  ): Promise<T> {
    const inheritedToken = this.deploymentLockContext.getStore();
    if (
      inheritedToken
      && inheritedToken === this.activeDeploymentLockToken
    ) {
      await this.fileLock.updateStep(step);
      return this.withCoordinatedPayaraOperation(label, acquirePayaraLease, operation);
    }

    if (this.deployLock) {
      throw new Error('Deployment already in progress');
    }
    this.deployLock = true;

    const deploymentId = `operation-${Date.now()}-${randomBytes(4).toString('hex')}`;
    let fileLockAcquired = false;
    let operationError: unknown;
    try {
      await this.fileLock.acquire(deploymentId);
      fileLockAcquired = true;
      return await this.withOwnedDeploymentLockContext(async () => {
        await this.fileLock.updateStep(step);
        return this.withCoordinatedPayaraOperation(label, acquirePayaraLease, operation);
      });
    } catch (err) {
      operationError = err;
      throw err;
    } finally {
      try {
        if (fileLockAcquired) {
          await this.closeDeploymentLock(operationError);
        }
      } finally {
        this.deployLock = false;
      }
    }
  }

  private async closeDeploymentLock(operationError?: unknown): Promise<void> {
    const errorName = operationError instanceof Error ? operationError.name : '';
    if (errorName === 'BOOT_LIFECYCLE_OUTCOME_UNKNOWN') {
      const step = this.fileLock.getCurrentStep();
      await this.fileLock.quarantine(
        `ambiguous lifecycle operation at step: ${step ?? 'unknown'}`,
        errorName
      );
      return;
    }
    await this.fileLock.release();
  }

  private async withCoordinatedPayaraOperation<T>(
    label: string,
    acquirePayaraLease: boolean,
    operation: () => Promise<T>
  ): Promise<T> {
    const run = async (): Promise<T> => {
      if (typeof this.payara.reconcileDurableMutationQuarantine !== 'function') {
        throw new Error(
          'MUTATION_QUARANTINE_COORDINATOR_REQUIRED: PayaraManager version skew is unsafe'
        );
      }
      await this.payara.reconcileDurableMutationQuarantine(this.appName);
      return operation();
    };
    return acquirePayaraLease ? this.withPayaraLease(label, run) : run();
  }

  private async withOwnedDeploymentLockContext<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const inheritedToken = this.deploymentLockContext.getStore();
    if (
      inheritedToken
      && inheritedToken === this.activeDeploymentLockToken
    ) {
      return operation();
    }
    if (this.activeDeploymentLockToken) {
      throw new Error('DEPLOYMENT_LOCK_CONTEXT_CONFLICT: another operation owns the context');
    }

    const token = Symbol('deployment-lock-owner');
    this.activeDeploymentLockToken = token;
    try {
      return await this.deploymentLockContext.run(token, operation);
    } finally {
      if (this.activeDeploymentLockToken === token) {
        this.activeDeploymentLockToken = undefined;
      }
    }
  }

  private async withPayaraLease<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (typeof this.payara.withMutationLease !== 'function') {
      throw new Error(
        'MUTATION_LEASE_REQUIRED: PayaraManager version skew would bypass the single-writer fence'
      );
    }
    return this.payara.withMutationLease(label, operation);
  }

  private async replaceWarAtomically(
    writer: (tempPath: string) => void | Promise<void>,
    artifactBootEpoch?: string,
    commitOptions?: {
      noOverwrite?: boolean;
      beforeCommit?: () => Promise<void>;
      /** Exact raw WAR identity observed before this mutation began. */
      expectedBaseSha256?: string | null;
    }
  ): Promise<void> {
    const warDir = dirname(this.warPath);
    await mkdir(warDir, { recursive: true });
    let existingMetadata: { mode: number; uid: number; gid: number } | undefined;
    try {
      const existing = await stat(this.warPath);
      existingMetadata = {
        mode: existing.mode & 0o7777,
        uid: existing.uid,
        gid: existing.gid,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    const tempPath = join(
      warDir,
      `.${basename(this.warPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    );

    try {
      await writer(tempPath);
      const tempHandle = await open(tempPath, 'r+');
      try {
        const initialTempMetadata = await tempHandle.stat();
        if (
          existingMetadata &&
          (initialTempMetadata.uid !== existingMetadata.uid ||
            initialTempMetadata.gid !== existingMetadata.gid)
        ) {
          await tempHandle.chown(existingMetadata.uid, existingMetadata.gid);
        }

        // Preserve all permission and special mode bits on replacement. A first
        // WAR is deliberately 0644 so the configured Payara user can read it
        // even when the agent and Payara do not share a group.
        const targetMode = existingMetadata?.mode ?? 0o644;
        await tempHandle.chmod(targetMode);

        const appliedMetadata = await tempHandle.stat();
        if (
          (appliedMetadata.mode & 0o7777) !== targetMode ||
          (existingMetadata &&
            (appliedMetadata.uid !== existingMetadata.uid ||
              appliedMetadata.gid !== existingMetadata.gid))
        ) {
          throw new Error('WAR_METADATA_MISMATCH: Refusing to replace WAR with changed metadata');
        }
        await tempHandle.sync();
      } finally {
        await tempHandle.close();
      }
      if (artifactBootEpoch) {
        await this.payara.assertArtifactMutationEpochCurrent(
          this.appName,
          artifactBootEpoch
        );
      }
      await commitOptions?.beforeCommit?.();
      this.assertArtifactBaseAtCommit(commitOptions?.expectedBaseSha256);
      // No await/event-loop yield between the final epoch/state/artifact CAS
      // and the synchronous filesystem commit. A hard link gives first-time
      // recovery staging create-exclusive semantics: EEXIST can never overwrite
      // a WAR that appeared while the guard was awaiting Payara inventory.
      if (commitOptions?.noOverwrite) {
        try {
          linkSync(tempPath, this.warPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(
              `BOOT_RECOVERY_ARTIFACT_ALREADY_PRESENT: ${this.warPath} already exists`
            );
          }
          throw err;
        }
        unlinkSync(tempPath);
      } else {
        renameSync(tempPath, this.warPath);
      }

      // Persist the directory entry when the platform supports directory fsync.
      try {
        const directoryHandle = await open(warDir, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!(process.platform === 'darwin' && (code === 'EINVAL' || code === 'ENOTSUP'))) {
          throw err;
        }
        this.logger.debug({ err, warDir }, 'Directory fsync not supported on this test platform');
      }
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  /**
   * Get current deployment status for polling
   * Used by CLI to check if a long-running deployment has completed
   */
  getDeploymentStatus(): DeploymentStatus {
    return this.statusTracker.getStatus(this.deployLock);
  }

  /** Read-only cross-process lock inspection for conservative status polling. */
  async getDeploymentLockStatus(): Promise<{
    locked: boolean;
    stale?: boolean;
    data?: { deploymentId: string; step: DeploymentStep };
  }> {
    const status = await this.fileLock.isLocked();
    return {
      locked: status.locked,
      ...(status.stale ? { stale: true } : {}),
      ...(status.data ? {
        data: {
          deploymentId: status.data.deploymentId,
          step: status.data.step,
        },
      } : {}),
    };
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
  private markDeploymentCompleted(deploymentId: string, result: DeployResult): void {
    this.statusTracker.markCompleted(deploymentId, result);
  }

  /**
   * Publish exactly one terminal polling result for a top-level deployment.
   * Nested lock/deploy helpers deliberately do not call this wrapper.
   */
  private async withDeploymentTracking<T>(
    deploymentId: string,
    operation: () => Promise<T>,
    receiptForResult: (result: T) => DeployResult,
    failureResult: (error: unknown) => DeployResult
  ): Promise<T> {
    this.markDeploymentStarted(deploymentId);
    try {
      const result = await operation();
      this.markDeploymentCompleted(deploymentId, receiptForResult(result));
      return result;
    } catch (err) {
      this.markDeploymentCompleted(deploymentId, failureResult(err));
      throw err;
    }
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
    if (this.deployLock) {
      throw new Error('Deployment already in progress');
    }
    this.deployLock = true;
    const deploymentId = `undeploy-${Date.now()}-${randomBytes(4).toString('hex')}`;
    let fileLockAcquired = false;
    try {
      await this.fileLock.acquire(deploymentId);
      fileLockAcquired = true;
      await this.fileLock.updateStep('undeploy');
      await this.withPayaraLease(`war-undeploy:${this.appName}`, () =>
        this.payara.undeploy(this.appName)
      );
    } finally {
      try {
        if (fileLockAcquired) {
          await this.fileLock.release();
        }
      } finally {
        this.deployLock = false;
      }
    }
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
    deletedFiles: string[],
    requestedDeploymentId?: string,
    artifactExpectation?: DeploymentArtifactExpectation
  ): Promise<FullDeployResult> {
    // Check in-memory lock first (quick check for same-process concurrency)
    if (this.deployLock) {
      throw new Error('Deployment already in progress');
    }
    const startTime = Date.now();
    const deploymentId = requestedDeploymentId
      ?? `deploy-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const timings: FullDeployResult['timings'] = {};
    return this.withDeploymentTracking(
      deploymentId,
      async () => {
      this.deployLock = true;
      let fileLockAcquired = false;
      let operationError: unknown;

      try {
      // Acquire the cross-process lock after the synchronous in-memory claim.
      // This closes the same-process race between two requests entering before
      // either asynchronous file-lock check completes.
      await this.fileLock.acquire(deploymentId);
      fileLockAcquired = true;
      return await this.withOwnedDeploymentLockContext(() =>
        this.withPayaraLease(`full-restart-deploy:${this.appName}`, async () => {

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
      let artifact: WarArtifactIdentity | undefined = await this.applyChangesWithoutDeploy(
        changedFiles,
        deletedFiles,
        artifactExpectation
      );
      timings.warUpdate = Date.now() - warUpdateStart;
      this.logger.info({ duration: timings.warUpdate }, 'WAR file updated');

      // ======================================================================
      // STEP 2: Undeploy current application (if deployed)
      // ======================================================================
      await this.fileLock.updateStep('undeploy');
      await this.journal.updateStep('undeploy');

      const undeployStart = Date.now();
      const undeployed = await this.payara.prepareAggressiveRestart(this.appName);
      this.logger.info(
        { appName: this.appName, undeployed },
        undeployed ? 'Application undeployed' : 'Application not deployed, skipping undeploy'
      );
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
      await this.payara.safeStart({ waitForApplicationHealth: false });
      timings.start = Date.now() - startPayaraStart;
      this.logger.info({ duration: timings.start }, 'Payara started fresh');

      // ======================================================================
      // STEP 6: Deploy WAR file
      // ======================================================================
      await this.fileLock.updateStep('deploy');
      await this.journal.updateStep('deploy');

      const deployStart = Date.now();
      const postStart = await this.deployAfterStart('require-agent-owned');
      if (postStart.outcome !== 'agent-deployed') {
        throw new Error('BOOT_OWNER_CONFLICT: Payara retained deployment ownership');
      }
      timings.deploy = Date.now() - deployStart;

      // ======================================================================
      // STEP 7: Verify deployment
      // ======================================================================
      await this.fileLock.updateStep('verify');
      await this.journal.updateStep('verify');

      const { applications, deployed: isDeployed } = postStart;
      if (artifactExpectation) {
        artifact = await this.verifyTargetArtifact(artifactExpectation);
      }

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
        ...(artifact ? { artifact } : {}),
        ...(artifactExpectation ? {
          targetContentSha256: artifactExpectation.targetContentSha256,
        } : {}),
        timings,
        aggressiveMode: true,
      };
        })
      );

      } catch (err) {
      operationError = err;
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
        try {
          if (fileLockAcquired) {
            await this.closeDeploymentLock(operationError);
          }
        } finally {
          this.deployLock = false;
        }
      }
      },
      result => result,
      err => ({
        success: false,
        filesChanged: changedFiles.length,
        filesDeleted: deletedFiles.length,
        message: getErrorMessage(err),
        deploymentTime: Date.now() - startTime,
        appName: this.appName,
        deployed: false,
        timings,
        aggressiveMode: true,
      })
    );
  }

  /**
   * Apply changes and deploy - uses aggressive mode if configured
   */
  async applyChangesAuto(
    changedFiles: FileChange[],
    deletedFiles: string[],
    deploymentId?: string,
    artifactExpectation?: DeploymentArtifactExpectation
  ): Promise<DeployResult | FullDeployResult> {
    if (this.aggressiveMode) {
      return this.deployWithFullRestart(
        changedFiles,
        deletedFiles,
        deploymentId,
        artifactExpectation
      );
    }
    return this.applyChanges(
      changedFiles,
      deletedFiles,
      deploymentId,
      artifactExpectation
    );
  }
}
