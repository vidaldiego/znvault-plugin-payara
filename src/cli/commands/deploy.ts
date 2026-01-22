// Path: src/cli/commands/deploy.ts
// Deployment helper functions for CLI commands

import { readFile } from 'node:fs/promises';
import AdmZip from 'adm-zip';
import type { WarFileHashes, ChunkedDeployResponse } from '../../types.js';
import { calculateWarHashes, calculateDiff } from '../../war-deployer.js';
import type { CLIPluginContext, DeployOperationResult } from '../types.js';
import { ProgressReporter, progressBar } from '../progress.js';
import type { HostAnalysis } from '../unified-progress.js';
import {
  CHUNK_SIZE,
  MAX_RETRIES,
  DEPLOYMENT_TIMEOUT_MS,
  ANSI,
  getRetryDelay,
} from '../constants.js';
import {
  agentGet,
  agentPost,
  agentPostWithStatus,
  pollDeploymentStatus,
  buildPluginUrl,
} from '../http-client.js';
import { getErrorMessage } from '../../utils/error.js';
import { formatSize } from '../formatters.js';

// Re-export type for backwards compatibility
export type { DeployOperationResult } from '../types.js';

/**
 * Analyze a host to determine what needs to be deployed
 * Does NOT perform actual deployment - just fetches remote hashes and calculates diff
 *
 * @param host Host address
 * @param port Agent port
 * @param localHashes Pre-calculated local WAR hashes
 * @param force If true, treat as full upload (skip remote hash fetch)
 * @returns Analysis result with file counts and sizes
 */
export async function analyzeHost(
  host: string,
  port: number,
  localHashes: WarFileHashes,
  force: boolean
): Promise<HostAnalysis> {
  try {
    const pluginUrl = buildPluginUrl(host, port);

    // If force mode, everything is a change
    if (force) {
      const files = Object.keys(localHashes);
      const totalSize = files.reduce((sum, path) => sum + (localHashes[path]?.length ?? 100), 0);
      return {
        host,
        success: true,
        filesChanged: files.length,
        filesDeleted: 0,
        bytesToUpload: totalSize,
        isFullUpload: true,
        changedFiles: files,
        deletedFiles: [],
      };
    }

    // Fetch remote hashes
    let remoteHashes: WarFileHashes = {};
    let isFullUpload = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await agentGet<{ hashes: WarFileHashes; status?: string }>(
          `${pluginUrl}/hashes`
        );
        remoteHashes = response.hashes ?? {};

        // Check if remote has no WAR
        if (Object.keys(remoteHashes).length === 0 && response.status === 'no_war') {
          isFullUpload = true;
        }
        break;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, getRetryDelay(attempt)));
          continue;
        }
        // All retries failed - treat as full upload
        isFullUpload = true;
      }
    }

    // Calculate diff
    if (isFullUpload) {
      const files = Object.keys(localHashes);
      const totalSize = files.reduce((sum, path) => sum + (localHashes[path]?.length ?? 100), 0);
      return {
        host,
        success: true,
        filesChanged: files.length,
        filesDeleted: 0,
        bytesToUpload: totalSize,
        isFullUpload: true,
        changedFiles: files,
        deletedFiles: [],
      };
    }

    const { changed, deleted } = calculateDiff(localHashes, remoteHashes);
    const totalSize = changed.reduce((sum, path) => sum + (localHashes[path]?.length ?? 100), 0);

    return {
      host,
      success: true,
      filesChanged: changed.length,
      filesDeleted: deleted.length,
      bytesToUpload: totalSize,
      isFullUpload: false,
      changedFiles: changed,
      deletedFiles: deleted,
    };
  } catch (err) {
    return {
      host,
      success: false,
      error: getErrorMessage(err),
      filesChanged: 0,
      filesDeleted: 0,
      bytesToUpload: 0,
      isFullUpload: false,
    };
  }
}

/**
 * Upload full WAR file to server with progress tracking and polling
 *
 * If the upload times out or receives 409 "Deployment in progress",
 * polls the deployment status endpoint until completion.
 */
export async function uploadFullWar(
  ctx: CLIPluginContext,
  pluginUrl: string,
  warPath: string,
  progress: ProgressReporter
): Promise<DeployOperationResult> {
  const requestStartTime = Date.now();

  try {
    progress.uploadingFullWar();

    // Read WAR file
    const warBuffer = await readFile(warPath);
    const totalSize = warBuffer.length;

    // Report initial progress
    progress.uploadBytesProgress(0, totalSize);

    // Upload using raw POST with long timeout
    let response: Response;

    try {
      response = await fetch(`${pluginUrl}/deploy/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': totalSize.toString(),
        },
        body: warBuffer,
        signal: AbortSignal.timeout(DEPLOYMENT_TIMEOUT_MS),
      });
    } catch (err) {
      // Check if it's a timeout - if so, poll for deployment status
      const message = getErrorMessage(err);
      if (message.includes('timeout') || message.includes('aborted')) {
        progress.uploadComplete();
        progress.deploymentTimedOut();

        // Poll for deployment status
        const pollResult = await pollDeploymentStatus(pluginUrl, requestStartTime, progress);
        progress.clearWaitingLine();

        if (pollResult.success) {
          return {
            success: true,
            result: pollResult.result ?? {
              success: true,
              filesChanged: Object.keys(await calculateWarHashes(warPath)).length,
              filesDeleted: 0,
              message: 'Deployment successful',
              deploymentTime: Date.now() - requestStartTime,
              appName: '',
            },
          };
        }
        return { success: false, error: pollResult.error };
      }
      throw err;
    }

    // Report completion
    progress.uploadBytesProgress(totalSize, totalSize);
    progress.uploadComplete();

    // Handle 409 "Deployment in progress"
    if (response.status === 409) {
      progress.deploymentInProgress();

      // Poll for deployment status
      const pollResult = await pollDeploymentStatus(pluginUrl, requestStartTime, progress);
      progress.clearWaitingLine();

      if (pollResult.success) {
        return {
          success: true,
          result: pollResult.result ?? {
            success: true,
            filesChanged: Object.keys(await calculateWarHashes(warPath)).length,
            filesDeleted: 0,
            message: 'Deployment successful',
            deploymentTime: Date.now() - requestStartTime,
            appName: '',
          },
        };
      }
      return { success: false, error: pollResult.error };
    }

    const data = await response.json() as {
      status?: string;
      error?: string;
      message?: string;
      deployed?: boolean;
      deploymentTime?: number;
      applications?: string[];
      appName?: string;
      size?: number;
    };

    if (!response.ok) {
      return { success: false, error: data.message ?? data.error ?? 'Upload failed' };
    }

    return {
      success: true,
      result: {
        success: true,
        filesChanged: Object.keys(await calculateWarHashes(warPath)).length,
        filesDeleted: 0,
        message: data.message ?? 'Deployment successful',
        deploymentTime: data.deploymentTime ?? 0,
        appName: data.appName ?? '',
        deployed: data.deployed,
        applications: data.applications,
      },
    };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

/**
 * Deploy files using chunked upload with progress
 *
 * The final chunk triggers the actual deployment, which may take several minutes.
 * If timeout or 409 occurs, polls the deployment status endpoint.
 */
export async function deployChunked(
  ctx: CLIPluginContext,
  pluginUrl: string,
  zip: AdmZip,
  changed: string[],
  deleted: string[],
  progress: ProgressReporter
): Promise<DeployOperationResult> {
  const requestStartTime = Date.now();

  try {
    let sessionId: string | undefined;
    const totalFiles = changed.length;

    // Initialize progress display
    if (!ctx.isPlainMode()) {
      // Print placeholder lines for progress display
      console.log(`  ${progressBar(0, totalFiles)} 0/${totalFiles} files`);
      console.log(`${ANSI.dim}  Recent files:${ANSI.reset}`);
      for (let i = 0; i < 5; i++) {
        console.log('');
      }
    }

    // Send files in chunks
    for (let i = 0; i < changed.length; i += CHUNK_SIZE) {
      const chunkPaths = changed.slice(i, i + CHUNK_SIZE);
      const isLastChunk = i + CHUNK_SIZE >= changed.length;

      // Prepare chunk files
      const files = chunkPaths.map(path => {
        const entry = zip.getEntry(path);
        if (!entry) {
          throw new Error(`Entry not found in WAR: ${path}`);
        }
        return {
          path,
          content: entry.getData().toString('base64'),
        };
      });

      // Build chunk request
      const chunkRequest: {
        sessionId?: string;
        files: Array<{ path: string; content: string }>;
        deletions?: string[];
        expectedFiles?: number;
        commit?: boolean;
      } = {
        files,
        commit: isLastChunk,
      };

      if (sessionId) {
        chunkRequest.sessionId = sessionId;
      } else {
        // First chunk - include deletions and expected file count
        chunkRequest.deletions = deleted;
        chunkRequest.expectedFiles = totalFiles;
      }

      // For the commit chunk, use longer timeout and handle 409
      if (isLastChunk) {
        progress.deploying();

        const result = await agentPostWithStatus<ChunkedDeployResponse>(
          `${pluginUrl}/deploy/chunk`,
          chunkRequest
        );

        if (result.ok) {
          const response = result.data;
          if (response.committed && response.result) {
            return {
              success: response.result.success,
              result: response.result,
            };
          }
          return { success: false, error: 'Chunked deployment did not complete' };
        }

        // Handle timeout or 409 by polling
        if (result.inProgress) {
          if (result.status === 409) {
            progress.deploymentInProgress();
          } else {
            progress.deploymentTimedOut();
          }

          const pollResult = await pollDeploymentStatus(pluginUrl, requestStartTime, progress);
          progress.clearWaitingLine();

          if (pollResult.success) {
            return {
              success: true,
              result: pollResult.result ?? {
                success: true,
                filesChanged: changed.length,
                filesDeleted: deleted.length,
                message: 'Deployment successful',
                deploymentTime: Date.now() - requestStartTime,
                appName: '',
              },
            };
          }
          return { success: false, error: pollResult.error };
        }

        return { success: false, error: result.error };
      }

      // For non-commit chunks, use regular POST
      const response = await agentPost<ChunkedDeployResponse>(
        `${pluginUrl}/deploy/chunk`,
        chunkRequest
      );

      sessionId = response.sessionId;

      // Report progress
      progress.uploadProgress(response.filesReceived, totalFiles, chunkPaths);
    }

    // Should not reach here if commit was sent
    return { success: false, error: 'Chunked deployment did not complete' };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

/**
 * Deploy to a single host with progress reporting
 */
export async function deployToHost(
  ctx: CLIPluginContext,
  host: string,
  port: number,
  warPath: string,
  localHashes: WarFileHashes,
  force: boolean,
  progress: ProgressReporter
): Promise<DeployOperationResult> {
  try {
    const pluginUrl = buildPluginUrl(host, port);

    // Get remote hashes with retry logic
    let remoteHashes: WarFileHashes = {};
    let remoteIsEmpty = false;

    if (!force) {
      let lastError = '';
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await agentGet<{ hashes: WarFileHashes; status?: string }>(
            `${pluginUrl}/hashes`
          );
          remoteHashes = response.hashes ?? {};
          remoteIsEmpty = Object.keys(remoteHashes).length === 0;

          // Log if remote has no WAR (first deployment)
          if (remoteIsEmpty && response.status === 'no_war') {
            progress.remoteHasNoWar();
          }
          break; // Success - exit retry loop
        } catch (err) {
          lastError = getErrorMessage(err);
          if (attempt < MAX_RETRIES) {
            // Wait before retry with exponential backoff
            await new Promise(r => setTimeout(r, getRetryDelay(attempt)));
            continue;
          }
          // All retries failed - log WHY we're doing full upload
          progress.hashFetchFailed(lastError, MAX_RETRIES);
          remoteIsEmpty = true;
        }
      }
    } else {
      // Force mode - treat as if remote is empty to do full upload
      remoteIsEmpty = true;
    }

    // If remote has no WAR or hash fetch failed, upload the full WAR file
    // Note: uploadFullWar now handles timeout/409 via polling, so no retry loop needed
    if (remoteIsEmpty) {
      return uploadFullWar(ctx, pluginUrl, warPath, progress);
    }

    // Calculate diff
    const { changed, deleted } = calculateDiff(localHashes, remoteHashes);
    progress.diff(changed.length, deleted.length, changed, deleted);

    if (changed.length === 0 && deleted.length === 0) {
      progress.noChanges();
      return {
        success: true,
        result: {
          success: true,
          filesChanged: 0,
          filesDeleted: 0,
          message: 'No changes',
          deploymentTime: 0,
          appName: '',
        },
      };
    }

    const zip = new AdmZip(warPath);

    // Use chunked deployment if there are many files
    if (changed.length > CHUNK_SIZE) {
      return deployChunked(ctx, pluginUrl, zip, changed, deleted, progress);
    }

    // Small deployment - use single request
    const files = changed.map(path => {
      const entry = zip.getEntry(path);
      if (!entry) {
        throw new Error(`Entry not found in WAR: ${path}`);
      }
      return {
        path,
        content: entry.getData().toString('base64'),
      };
    });

    progress.deploying();

    // Deploy with proper timeout and 409 handling
    const requestStartTime = Date.now();

    const result = await agentPostWithStatus<{
      status: string;
      filesChanged: number;
      filesDeleted: number;
      message?: string;
      deploymentTime?: number;
      deployed?: boolean;
      applications?: string[];
      appName?: string;
    }>(`${pluginUrl}/deploy`, {
      files,
      deletions: deleted,
    });

    if (result.ok) {
      const deployResponse = result.data;
      if (deployResponse.status === 'deployed') {
        return {
          success: true,
          result: {
            success: true,
            filesChanged: deployResponse.filesChanged,
            filesDeleted: deployResponse.filesDeleted,
            message: deployResponse.message ?? 'Deployment successful',
            deploymentTime: deployResponse.deploymentTime ?? 0,
            appName: deployResponse.appName ?? '',
            deployed: deployResponse.deployed,
            applications: deployResponse.applications,
          },
        };
      } else {
        return { success: false, error: deployResponse.message ?? 'Deployment failed' };
      }
    }

    // Handle timeout or 409 "Deployment in progress" by polling
    if (result.inProgress) {
      if (result.status === 409) {
        progress.deploymentInProgress();
      } else {
        progress.deploymentTimedOut();
      }

      // Poll for deployment status
      const pollResult = await pollDeploymentStatus(pluginUrl, requestStartTime, progress);
      progress.clearWaitingLine();

      if (pollResult.success) {
        return {
          success: true,
          result: pollResult.result ?? {
            success: true,
            filesChanged: changed.length,
            filesDeleted: deleted.length,
            message: 'Deployment successful',
            deploymentTime: Date.now() - requestStartTime,
            appName: '',
          },
        };
      }
      return { success: false, error: pollResult.error };
    }

    // Other errors - no retry, just report the error
    return { success: false, error: result.error };
  } catch (err) {
    return {
      success: false,
      error: getErrorMessage(err),
    };
  }
}
