// Path: src/war-deployer.ts
// WAR file deployer with diff-based updates - uses asadmin deploy commands only

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, stat, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import AdmZip from 'adm-zip';
import type { Logger } from 'pino';
import type { PayaraManager } from './payara-manager.js';
import type { WarDeployerOptions, WarFileHashes, FileChange, DeployResult } from './types.js';

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

  // Lock to prevent concurrent deployments
  private deployLock = false;

  constructor(options: WarDeployerOptions) {
    this.warPath = options.warPath;
    this.appName = options.appName;
    this.contextRoot = options.contextRoot;
    this.payara = options.payara;
    this.logger = options.logger;
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
    const tempDir = `/tmp/war-deploy-${Date.now()}`;
    const startTime = Date.now();

    try {
      this.logger.info({
        changed: changedFiles.length,
        deleted: deletedFiles.length,
      }, 'Applying WAR changes');

      // Create temp directory
      await mkdir(tempDir, { recursive: true });

      // Extract current WAR if it exists
      if (await this.warExists()) {
        const zip = new AdmZip(this.warPath);
        zip.extractAllTo(tempDir, true);
      }

      // Apply deletions
      for (const file of deletedFiles) {
        const fullPath = join(tempDir, file);
        try {
          await rm(fullPath, { force: true });
          this.logger.debug({ file }, 'Deleted file');
        } catch (err) {
          this.logger.warn({ err, file }, 'Failed to delete file');
        }
      }

      // Apply changes
      for (const { path, content } of changedFiles) {
        const fullPath = join(tempDir, path);
        const dir = dirname(fullPath);

        // Ensure parent directory exists
        await mkdir(dir, { recursive: true });

        // Write file
        await writeFile(fullPath, content);
        this.logger.debug({ path, size: content.length }, 'Updated file');
      }

      // Repackage WAR
      const newZip = new AdmZip();
      await this.addDirectoryToZip(newZip, tempDir, '');

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
        message: err instanceof Error ? err.message : String(err),
        deploymentTime: duration,
        appName: this.appName,
      };

    } finally {
      // Cleanup temp directory
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        this.logger.warn({ err, tempDir }, 'Failed to cleanup temp directory');
      }

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
    const tempDir = `/tmp/war-update-${Date.now()}`;

    try {
      this.logger.debug({
        changed: changedFiles.length,
        deleted: deletedFiles.length,
      }, 'Applying WAR changes (no deploy)');

      await mkdir(tempDir, { recursive: true });

      // Extract current WAR if it exists
      if (await this.warExists()) {
        const zip = new AdmZip(this.warPath);
        zip.extractAllTo(tempDir, true);
      }

      // Apply deletions
      for (const file of deletedFiles) {
        const fullPath = join(tempDir, file);
        try {
          await rm(fullPath, { force: true });
        } catch {
          // Ignore deletion errors
        }
      }

      // Apply changes
      for (const { path, content } of changedFiles) {
        const fullPath = join(tempDir, path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content);
      }

      // Repackage WAR
      const newZip = new AdmZip();
      await this.addDirectoryToZip(newZip, tempDir, '');

      const warDir = dirname(this.warPath);
      await mkdir(warDir, { recursive: true });

      newZip.writeZip(this.warPath);

    } finally {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
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
   * Check if deployment is in progress
   */
  isDeploying(): boolean {
    return this.deployLock;
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

  /**
   * Recursively add directory contents to ZIP
   */
  private async addDirectoryToZip(
    zip: AdmZip,
    dirPath: string,
    zipPath: string
  ): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await this.addDirectoryToZip(zip, fullPath, entryZipPath);
      } else {
        const content = await readFile(fullPath);
        zip.addFile(entryZipPath, content);
      }
    }
  }
}

/**
 * Calculate diff between local and remote hashes
 */
export function calculateDiff(
  localHashes: WarFileHashes,
  remoteHashes: WarFileHashes
): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];

  // Find changed/new files
  for (const [path, hash] of Object.entries(localHashes)) {
    if (!remoteHashes[path] || remoteHashes[path] !== hash) {
      changed.push(path);
    }
  }

  // Find deleted files
  for (const path of Object.keys(remoteHashes)) {
    if (!localHashes[path]) {
      deleted.push(path);
    }
  }

  return { changed, deleted };
}

/**
 * Calculate hashes for a local WAR file
 */
export async function calculateWarHashes(warPath: string): Promise<WarFileHashes> {
  const hashes: WarFileHashes = {};
  const zip = new AdmZip(warPath);

  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) {
      const content = entry.getData();
      const hash = createHash('sha256').update(content).digest('hex');
      hashes[entry.entryName] = hash;
    }
  }

  return hashes;
}

/**
 * Get file content from a WAR file
 */
export function getWarEntry(warPath: string, path: string): Buffer {
  const zip = new AdmZip(warPath);
  const entry = zip.getEntry(path);

  if (!entry || entry.isDirectory) {
    throw new Error(`Entry not found in WAR: ${path}`);
  }

  return entry.getData();
}
