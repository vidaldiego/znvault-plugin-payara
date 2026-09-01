// Path: src/cli/commands/deploy.ts
// Deployment helper functions for CLI commands

import AdmZip from 'adm-zip';
import type {
  WarFileHashes,
  WarArtifactIdentity,
  LocalWarArtifactSnapshot,
  DeploymentArtifactExpectation,
  ChunkedDeployResponse,
} from '../../types.js';
import {
  calculateDiff,
  calculateWarContentSha256,
  readLocalWarArtifactSnapshot,
} from '../../war-deployer.js';
import type { CLIPluginContext, DeployOperationResult } from '../types.js';
import { ProgressReporter, progressBar } from '../progress.js';
import type { HostAnalysis } from '@zincapp/znvault-deploy-core';
import {
  CHUNK_SIZE,
  MAX_RETRIES,
  DEPLOYMENT_TIMEOUT_MS,
  ANSI,
  getRetryDelay,
} from '../constants.js';
import {
  agentGet,
  agentFetch,
  agentPost,
  agentPostWithStatus,
  pollDeploymentStatus,
  createDeploymentId,
  DEPLOYMENT_ID_HEADER,
  buildPluginUrl,
  type AgentRequestAuth,
} from '@zincapp/znvault-deploy-core';
import { getErrorMessage } from '../../utils/error.js';

const EXPECTED_BASE_SHA256_HEADER = 'x-znvault-expected-base-sha256';
const TARGET_CONTENT_SHA256_HEADER = 'x-znvault-target-content-sha256';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function payaraRequestAuth(mutationAuthToken: string): AgentRequestAuth {
  return { bearerToken: mutationAuthToken };
}

function isVerifiedDeploymentResult(
  result: {
    success?: boolean;
    deployed?: boolean;
    artifact?: {
      size?: number;
      sha256?: string;
      contentSha256?: string;
    };
    targetContentSha256?: string;
  } | undefined,
  targetContentSha256: string,
  exactBinaryTarget?: { sha256: string; size: number }
): boolean {
  return result?.success === true
    && result.deployed === true
    && Number.isSafeInteger(result.artifact?.size)
    && result.artifact!.size! > 0
    && typeof result.artifact?.sha256 === 'string'
    && SHA256_PATTERN.test(result.artifact.sha256)
    && result.artifact?.contentSha256 === targetContentSha256
    && result.targetContentSha256 === targetContentSha256
    && (
      exactBinaryTarget === undefined
      || (
        result.artifact.sha256 === exactBinaryTarget.sha256
        && result.artifact.size === exactBinaryTarget.size
      )
    );
}

function hasExpectedDeploymentId(
  response: { deploymentId?: string } | undefined,
  deploymentId: string
): boolean {
  return response?.deploymentId === deploymentId;
}

async function isSameDeploymentConflict(
  response: Response,
  deploymentId: string
): Promise<boolean> {
  try {
    const body = await response.json() as { deploymentId?: unknown };
    return body.deploymentId === deploymentId;
  } catch {
    return false;
  }
}

interface WarHashesResponse {
  hashes?: WarFileHashes;
  artifact?: WarArtifactIdentity | null;
  status?: string;
}

interface RemoteWarSnapshot {
  hashes: WarFileHashes;
  artifact: WarArtifactIdentity | null;
}

function parseRemoteWarSnapshot(response: WarHashesResponse): RemoteWarSnapshot {
  const hashes = response.hashes ?? {};
  if (response.status === 'no_war') {
    if (response.artifact !== null || Object.keys(hashes).length !== 0) {
      throw new Error('ARTIFACT_READBACK_INVALID: no_war response carried artifact data');
    }
    return { hashes: {}, artifact: null };
  }
  const artifact = response.artifact;
  if (
    response.status !== 'ok'
    || !artifact
    || !SHA256_PATTERN.test(artifact.sha256)
    || !SHA256_PATTERN.test(artifact.contentSha256)
    || !Number.isSafeInteger(artifact.size)
    || artifact.size <= 0
  ) {
    throw new Error('ARTIFACT_READBACK_INVALID: /hashes omitted a valid whole-WAR identity');
  }
  if (calculateWarContentSha256(hashes) !== artifact.contentSha256) {
    throw new Error('ARTIFACT_READBACK_INVALID: entry hashes do not match artifact content identity');
  }
  return { hashes, artifact };
}

function artifactExpectation(
  remote: RemoteWarSnapshot,
  local: LocalWarArtifactSnapshot
): DeploymentArtifactExpectation {
  return {
    expectedBaseSha256: remote.artifact?.sha256 ?? null,
    targetContentSha256: local.contentSha256,
  };
}

interface DeploymentReadinessStatus {
  healthy?: boolean;
  running?: boolean;
  appDeployed?: boolean;
  bootDeployment?: {
    phase?: string;
    mutationOutcomeUnknown?: boolean;
  };
}

export interface DeploymentReadiness {
  ready: boolean;
  reasons: string[];
}

/**
 * Read the authenticated runtime fence used to decide whether an identical WAR
 * is a genuine no-op. Reachability and matching on-disk hashes are not enough:
 * an absent application or an uncertain boot mutation requires a repair deploy.
 */
export async function readDeploymentReadiness(
  host: string,
  port: number,
  mutationAuthToken: string,
  useTLS = false
): Promise<DeploymentReadiness> {
  const pluginUrl = buildPluginUrl(host, port, useTLS);
  const status = await agentGet<DeploymentReadinessStatus>(
    `${pluginUrl}/status`,
    undefined,
    payaraRequestAuth(mutationAuthToken)
  );
  const reasons: string[] = [];
  if (status.healthy !== true) reasons.push('plugin health is not healthy');
  if (status.running !== true) reasons.push('Payara is not running');
  if (status.appDeployed !== true) reasons.push('application is not deployed');
  if (status.bootDeployment?.phase !== 'ready') reasons.push('boot deployment fence is not ready');
  if (status.bootDeployment?.mutationOutcomeUnknown !== false) {
    reasons.push('deployment mutation outcome is unknown');
  }
  return { ready: reasons.length === 0, reasons };
}

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
 * @param useTLS If true, use HTTPS for agent connection
 * @returns Analysis result with file counts and sizes
 */
export async function analyzeHost(
  host: string,
  port: number,
  localHashes: WarFileHashes,
  force: boolean,
  mutationAuthToken: string,
  useTLS = false
): Promise<HostAnalysis> {
  try {
    const pluginUrl = buildPluginUrl(host, port, useTLS);

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

    const readiness = await readDeploymentReadiness(
      host,
      port,
      mutationAuthToken,
      useTLS
    );
    if (!readiness.ready) {
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
        const response = await agentGet<WarHashesResponse>(
          `${pluginUrl}/hashes`,
          undefined,
          payaraRequestAuth(mutationAuthToken)
        );
        const remote = parseRemoteWarSnapshot(response);
        remoteHashes = remote.hashes;

        // Check if remote has no WAR
        if (!remote.artifact) {
          isFullUpload = true;
        }
        break;
      } catch {
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, getRetryDelay(attempt)));
          continue;
        }
        throw new Error(
          'ARTIFACT_IDENTITY_UNVERIFIED: failed to obtain a coherent /hashes readback'
        );
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
 * A timed-out upload is polled only by its exact caller-generated identity.
 * A 409 for another operation is a conflict, never polling evidence.
 */
export async function uploadFullWar(
  ctx: CLIPluginContext,
  pluginUrl: string,
  warPath: string,
  progress: ProgressReporter,
  mutationAuthToken: string,
  artifact: DeploymentArtifactExpectation,
  suppliedSnapshot?: LocalWarArtifactSnapshot
): Promise<DeployOperationResult> {
  const deploymentId = createDeploymentId();

  try {
    progress.uploadingFullWar();

    const snapshot = suppliedSnapshot
      ?? await readLocalWarArtifactSnapshot(warPath);
    if (snapshot.contentSha256 !== artifact.targetContentSha256) {
      throw new Error(
        'LOCAL_ARTIFACT_DRIFT: local WAR snapshot does not match the requested target'
      );
    }
    const warBuffer = snapshot.getBytes();
    const totalSize = warBuffer.length;

    // Report initial progress
    progress.uploadBytesProgress(0, totalSize);

    // Upload using raw POST with long timeout
    let response: Response;

    try {
      response = await agentFetch(`${pluginUrl}/deploy/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': totalSize.toString(),
          [DEPLOYMENT_ID_HEADER]: deploymentId,
          [EXPECTED_BASE_SHA256_HEADER]: artifact.expectedBaseSha256 ?? 'none',
          [TARGET_CONTENT_SHA256_HEADER]: artifact.targetContentSha256,
        },
        body: warBuffer,
        signal: AbortSignal.timeout(DEPLOYMENT_TIMEOUT_MS),
      }, payaraRequestAuth(mutationAuthToken));
    } catch (err) {
      // Check if it's a timeout - if so, poll for deployment status
      const message = getErrorMessage(err);
      if (message.includes('timeout') || message.includes('aborted')) {
        progress.uploadComplete();
        progress.deploymentTimedOut();

        // Poll for deployment status
        const pollResult = await pollDeploymentStatus(
          pluginUrl,
          deploymentId,
          progress,
          undefined,
          payaraRequestAuth(mutationAuthToken)
        );
        progress.clearWaitingLine();

        if (
          pollResult.success
          && isVerifiedDeploymentResult(
            pollResult.result,
            artifact.targetContentSha256,
            { sha256: snapshot.sha256, size: snapshot.size }
          )
        ) {
          return {
            success: true,
            result: pollResult.result,
          };
        }
        return {
          success: false,
          error: pollResult.error ?? 'Deployment completion was not verified',
        };
      }
      throw err;
    }

    // Report completion
    progress.uploadBytesProgress(totalSize, totalSize);
    progress.uploadComplete();

    // Handle 409 "Deployment in progress"
    if (response.status === 409) {
      if (!(await isSameDeploymentConflict(response, deploymentId))) {
        return {
          success: false,
          error: 'Another deployment is already in progress',
        };
      }
      progress.deploymentInProgress();

      // Poll for deployment status
      const pollResult = await pollDeploymentStatus(
        pluginUrl,
        deploymentId,
        progress,
        undefined,
        payaraRequestAuth(mutationAuthToken)
      );
      progress.clearWaitingLine();

      if (
        pollResult.success
        && isVerifiedDeploymentResult(
          pollResult.result,
          artifact.targetContentSha256,
          { sha256: snapshot.sha256, size: snapshot.size }
        )
      ) {
        return {
          success: true,
          result: pollResult.result,
        };
      }
      return {
        success: false,
        error: pollResult.error ?? 'Deployment completion was not verified',
      };
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
      deploymentId?: string;
      artifact?: WarArtifactIdentity;
      targetContentSha256?: string;
    };

    if (!response.ok) {
      return { success: false, error: data.message ?? data.error ?? 'Upload failed' };
    }

    if (
      data.status !== 'deployed'
      || !hasExpectedDeploymentId(data, deploymentId)
      || !isVerifiedDeploymentResult(
        {
          success: true,
          deployed: data.deployed,
          artifact: data.artifact,
          targetContentSha256: data.targetContentSha256,
        },
        artifact.targetContentSha256,
        { sha256: snapshot.sha256, size: snapshot.size }
      )
    ) {
      return {
        success: false,
        error: data.message ?? 'Deployment completion was not verified',
      };
    }

    return {
      success: true,
      result: {
        success: true,
        filesChanged: Object.keys(snapshot.hashes).length,
        filesDeleted: 0,
        message: data.message ?? 'Deployment successful',
        deploymentTime: data.deploymentTime ?? 0,
        appName: data.appName ?? '',
        deployed: data.deployed,
        applications: data.applications,
        artifact: data.artifact,
        targetContentSha256: data.targetContentSha256,
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
 * If timeout occurs, polls only the exact deployment identity. A 409 for a
 * different identity fails immediately.
 */
export async function deployChunked(
  ctx: CLIPluginContext,
  pluginUrl: string,
  zip: AdmZip,
  changed: string[],
  deleted: string[],
  progress: ProgressReporter,
  mutationAuthToken: string,
  artifact: DeploymentArtifactExpectation
): Promise<DeployOperationResult> {
  const deploymentId = createDeploymentId();

  try {
    let sessionId: string | undefined;
    const totalFiles = changed.length;

    // Initialize progress display (only for single-host mode, not when UnifiedProgress handles display)
    if (!ctx.isPlainMode() && !progress.isSilent()) {
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
        deploymentId: string;
        sessionId?: string;
        files: Array<{ path: string; content: string }>;
        deletions?: string[];
        expectedFiles?: number;
        commit?: boolean;
        artifact: DeploymentArtifactExpectation;
      } = {
        deploymentId,
        files,
        commit: isLastChunk,
        artifact,
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
          chunkRequest,
          undefined,
          payaraRequestAuth(mutationAuthToken),
          deploymentId
        );

        if (result.ok) {
          const response = result.data;
          if (
            response.committed
            && hasExpectedDeploymentId(response, deploymentId)
            && isVerifiedDeploymentResult(
              response.result,
              artifact.targetContentSha256
            )
          ) {
            return {
              success: true,
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

          const pollResult = await pollDeploymentStatus(
            pluginUrl,
            deploymentId,
            progress,
            undefined,
            payaraRequestAuth(mutationAuthToken)
          );
          progress.clearWaitingLine();

          if (
            pollResult.success
            && isVerifiedDeploymentResult(
              pollResult.result,
              artifact.targetContentSha256
            )
          ) {
            return {
              success: true,
              result: pollResult.result,
            };
          }
          return {
            success: false,
            error: pollResult.error ?? 'Deployment completion was not verified',
          };
        }

        return { success: false, error: result.error };
      }

      // For non-commit chunks, use regular POST
      const response = await agentPost<ChunkedDeployResponse>(
        `${pluginUrl}/deploy/chunk`,
        chunkRequest,
        undefined,
        payaraRequestAuth(mutationAuthToken)
      );

      sessionId = response.sessionId;
      if (!hasExpectedDeploymentId(response, deploymentId)) {
        return {
          success: false,
          error: 'Chunk session deployment identity did not match the request',
        };
      }

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
  progress: ProgressReporter,
  mutationAuthToken: string,
  useTLS = false,
  suppliedSnapshot?: LocalWarArtifactSnapshot
): Promise<DeployOperationResult> {
  try {
    const pluginUrl = buildPluginUrl(host, port, useTLS);
    const snapshot = suppliedSnapshot
      ?? await readLocalWarArtifactSnapshot(warPath);
    if (calculateWarContentSha256(localHashes) !== snapshot.contentSha256) {
      throw new Error(
        'LOCAL_ARTIFACT_DRIFT: WAR changed after preflight; refusing deployment'
      );
    }

    let recoveryRequired = false;
    if (!force) {
      const readiness = await readDeploymentReadiness(
        host,
        port,
        mutationAuthToken,
        useTLS
      );
      recoveryRequired = !readiness.ready;
    }

    // Even force/recovery uploads must bind to an exact base. A failed identity
    // readback is not evidence that the remote WAR is absent.
    let remote: RemoteWarSnapshot | undefined;
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await agentGet<WarHashesResponse>(
          `${pluginUrl}/hashes`,
          undefined,
          payaraRequestAuth(mutationAuthToken)
        );
        remote = parseRemoteWarSnapshot(response);
        break;
      } catch (err) {
        lastError = getErrorMessage(err);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, getRetryDelay(attempt)));
        }
      }
    }
    if (!remote) {
      progress.hashFetchFailed(lastError, MAX_RETRIES);
      return {
        success: false,
        error: `Artifact identity readback failed: ${lastError}`,
      };
    }

    const expectedArtifact = artifactExpectation(remote, snapshot);
    const remoteIsEmpty = remote.artifact === null;
    if (remoteIsEmpty) progress.remoteHasNoWar();

    if (remoteIsEmpty || force || recoveryRequired) {
      return uploadFullWar(
        ctx,
        pluginUrl,
        warPath,
        progress,
        mutationAuthToken,
        expectedArtifact,
        snapshot
      );
    }

    // Calculate diff
    const { changed, deleted } = calculateDiff(snapshot.hashes, remote.hashes);
    progress.diff(changed.length, deleted.length, changed, deleted);

    // Never convert equal on-disk hashes into a deployment receipt. A prior
    // attempt may have replaced the WAR and failed before Payara dispatched
    // it. Sending an empty diff re-deploys and verifies the existing artifact.

    const zip = new AdmZip(snapshot.getBytes());

    // Use chunked deployment if there are many files
    if (changed.length > CHUNK_SIZE) {
      return deployChunked(
        ctx,
        pluginUrl,
        zip,
        changed,
        deleted,
        progress,
        mutationAuthToken,
        expectedArtifact
      );
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
    const deploymentId = createDeploymentId();

    const result = await agentPostWithStatus<{
      status: string;
      filesChanged: number;
      filesDeleted: number;
      message?: string;
      deploymentTime?: number;
      deployed?: boolean;
      applications?: string[];
      appName?: string;
      deploymentId?: string;
      artifact?: WarArtifactIdentity;
      targetContentSha256?: string;
    }>(
      `${pluginUrl}/deploy`,
      { deploymentId, artifact: expectedArtifact, files, deletions: deleted },
      undefined,
      payaraRequestAuth(mutationAuthToken),
      deploymentId
    );

    if (result.ok) {
      const deployResponse = result.data;
      if (
        deployResponse.status === 'deployed'
        && hasExpectedDeploymentId(deployResponse, deploymentId)
        && isVerifiedDeploymentResult(
          {
            success: true,
            deployed: deployResponse.deployed,
            artifact: deployResponse.artifact,
            targetContentSha256: deployResponse.targetContentSha256,
          },
          snapshot.contentSha256
        )
      ) {
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
            artifact: deployResponse.artifact,
            targetContentSha256: deployResponse.targetContentSha256,
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
      const pollResult = await pollDeploymentStatus(
        pluginUrl,
        deploymentId,
        progress,
        undefined,
        payaraRequestAuth(mutationAuthToken)
      );
      progress.clearWaitingLine();

      if (
        pollResult.success
        && isVerifiedDeploymentResult(pollResult.result, snapshot.contentSha256)
      ) {
        return {
          success: true,
          result: pollResult.result,
        };
      }
      return {
        success: false,
        error: pollResult.error ?? 'Deployment completion was not verified',
      };
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
