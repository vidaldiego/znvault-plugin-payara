// Path: src/routes/deploy.ts
// Deployment routes - handles WAR file deployment via asadmin

import type { FastifyInstance } from 'fastify';
import type {
  DeployRequest,
  ChunkedDeployRequest,
  ChunkedDeployResponse,
} from '../types.js';
import type { RouteContext } from './types.js';
import { getErrorMessage } from '../utils/error.js';
import {
  checkDeploymentInProgress,
  DEPLOYMENT_ID_HEADER,
  EXPECTED_BASE_SHA256_HEADER,
  TARGET_CONTENT_SHA256_HEADER,
  resolveDeploymentId,
  resolveArtifactExpectation,
  resolveBinaryArtifactExpectation,
  validateDeployRequest,
  decodeFileContents,
} from './helpers.js';

/**
 * Register deployment routes
 *
 * Routes:
 * - POST /deploy - Apply file changes and deploy
 * - POST /deploy/full - Full WAR deployment (no diff)
 * - POST /deploy/upload - Upload complete WAR file
 * - POST /deploy/chunk - Chunked file upload
 * - GET /deploy/status - Check deployment status
 * - DELETE /deploy/chunk/:sessionId - Cancel chunked session
 */
export async function registerDeployRoutes(
  fastify: FastifyInstance,
  ctx: RouteContext
): Promise<void> {
  const { deployer, sessionStore, logger } = ctx;

  /**
   * POST /deploy
   * Applies file changes and deploys WAR using asadmin deploy
   * Receives base64-encoded file contents for changed files
   */
  fastify.post<{ Body: DeployRequest }>('/deploy', async (request, reply) => {
    const {
      deploymentId: requestedDeploymentId,
      artifact: requestedArtifact,
      files,
      deletions,
    } = request.body;
    const deploymentId = resolveDeploymentId(
      requestedDeploymentId,
      reply,
      request.headers[DEPLOYMENT_ID_HEADER]
    );
    if (!deploymentId) return;

    // Validate request
    if (validateDeployRequest(request.body, reply)) {
      return;
    }
    const artifact = resolveArtifactExpectation(requestedArtifact, reply);
    if (!artifact) return;

    // Check if deployment is already in progress
    if (checkDeploymentInProgress(deployer, deploymentId, reply)) {
      return;
    }

    try {
      // Decode base64 file contents
      const changedFiles = decodeFileContents(files);

      logger.info({
        filesChanged: changedFiles.length,
        filesDeleted: deletions.length,
      }, 'Starting deployment via asadmin');

      // Deploy using asadmin deploy command (uses aggressive mode if configured)
      const result = await deployer.applyChangesAuto(
        changedFiles,
        deletions,
        deploymentId,
        artifact
      );

      const completedAt = Date.now();

      if (result.success && result.deployed === true) {
        return {
          status: 'deployed',
          deploymentId,
          completedAt,
          ...result,
        };
      } else {
        return reply.code(500).send({
          status: 'failed',
          deploymentId,
          error: 'Deployment failed',
          completedAt,
          ...result,
        });
      }
    } catch (err) {
      logger.error({ err }, 'Deployment failed');
      return reply.code(500).send({
        error: 'Deployment failed',
        message: getErrorMessage(err),
        deploymentId,
      });
    }
  });

  /**
   * POST /deploy/full
   * Triggers a full WAR deployment using asadmin deploy (no diff)
   * In aggressive mode: undeploy → stop → kill → start → deploy
   */
  fastify.post<{
    Body?: { deploymentId?: string; artifact?: unknown };
  }>('/deploy/full', async (request, reply) => {
    const deploymentId = resolveDeploymentId(
      request.body?.deploymentId,
      reply,
      request.headers[DEPLOYMENT_ID_HEADER]
    );
    if (!deploymentId) return;
    const artifact = resolveArtifactExpectation(request.body?.artifact, reply);
    if (!artifact) return;

    if (checkDeploymentInProgress(deployer, deploymentId, reply)) {
      return;
    }

    try {
      logger.info('Starting full deployment via asadmin');

      // Use deployAuto which respects aggressive mode
      const result = await deployer.deployAuto(deploymentId, artifact);
      const completedAt = Date.now();

      const response = {
        status: result.deployed ? 'deployed' : 'failed',
        deploymentId,
        message: result.deployed ? 'Full deployment successful' : 'Deployment failed',
        completedAt,
        deploymentTime: result.deploymentTime,
        deployed: result.deployed,
        applications: result.applications,
        appName: deployer.getAppName(),
        aggressiveMode: result.aggressiveMode,
        artifact: result.artifact,
        targetContentSha256: result.targetContentSha256,
      };
      return result.deployed
        ? response
        : reply.code(500).send(response);
    } catch (err) {
      logger.error({ err }, 'Full deployment failed');
      return reply.code(500).send({
        error: 'Deployment failed',
        message: getErrorMessage(err),
        deploymentId,
        completedAt: Date.now(),
      });
    }
  });

  /**
   * POST /deploy/upload
   * Upload a complete WAR file for deployment
   * Used when server has no existing WAR to diff against
   *
   * Expects raw binary WAR file in request body
   * Content-Type: application/octet-stream
   */
  fastify.post<{ Body: Buffer }>('/deploy/upload', async (request, reply) => {
    const deploymentId = resolveDeploymentId(
      request.headers[DEPLOYMENT_ID_HEADER],
      reply
    );
    if (!deploymentId) return;
    const artifact = resolveBinaryArtifactExpectation(
      request.headers[EXPECTED_BASE_SHA256_HEADER],
      request.headers[TARGET_CONTENT_SHA256_HEADER],
      reply
    );
    if (!artifact) return;

    if (checkDeploymentInProgress(deployer, deploymentId, reply)) {
      return;
    }

    try {
      // Get the uploaded WAR buffer
      const warBuffer = request.body;

      if (!warBuffer || warBuffer.length === 0) {
        return reply.code(400).send({
          error: 'Invalid request',
          message: 'No WAR file data received',
          deploymentId,
        });
      }

      // Write and deploy under one lease so concurrent uploads cannot replace
      // the artifact while asadmin is reading it.
      const result = await deployer.deployUploadedWar(
        warBuffer,
        deploymentId,
        artifact
      );
      const completedAt = Date.now();

      if (result.deployed) {
        return {
          status: 'deployed',
          deploymentId,
          message: 'WAR uploaded and deployed successfully via asadmin',
          completedAt,
          size: warBuffer.length,
          deploymentTime: result.deploymentTime,
          deployed: true,
          applications: result.applications,
          appName: deployer.getAppName(),
          aggressiveMode: result.aggressiveMode,
          artifact: result.artifact,
          targetContentSha256: result.targetContentSha256,
        };
      } else {
        return reply.code(500).send({
          status: 'failed',
          deploymentId,
          error: 'Deployment failed',
          message: 'WAR uploaded but deployment via asadmin failed',
          completedAt,
          size: warBuffer.length,
          deploymentTime: result.deploymentTime,
          deployed: false,
          applications: result.applications,
        });
      }
    } catch (err) {
      logger.error({ err }, 'WAR upload failed');
      return reply.code(500).send({
        error: 'WAR upload failed',
        message: getErrorMessage(err),
        deploymentId,
        completedAt: Date.now(),
      });
    }
  });

  /**
   * POST /deploy/chunk
   * Upload files in chunks for large deployments
   *
   * For first chunk: omit sessionId, include deletions and caller deploymentId
   * For subsequent chunks: include sessionId and repeat deploymentId exactly
   * For final chunk: set commit: true to apply all changes
   */
  fastify.post<{ Body: ChunkedDeployRequest }>('/deploy/chunk', async (request, reply) => {
    const {
      deploymentId: requestedDeploymentId,
      sessionId,
      files,
      deletions,
      expectedFiles,
      commit,
      artifact: requestedArtifact,
    } = request.body;

    // Validate caller ownership before decoding files, creating a session, or
    // attempting a deployment lock. Major 3 has no server-generated fallback.
    const deploymentId = resolveDeploymentId(
      requestedDeploymentId,
      reply,
      request.headers[DEPLOYMENT_ID_HEADER]
    );
    if (!deploymentId) return;

    // Validate request
    if (!Array.isArray(files)) {
      return reply.code(400).send({
        error: 'Invalid request',
        message: 'files must be an array',
      });
    }

    // Get or create session
    let session;
    if (sessionId) {
      // Continue existing session
      session = sessionStore.get(sessionId);
      if (!session) {
        return reply.code(404).send({
          error: 'Session not found',
          message: `Session ${sessionId} not found or expired`,
        });
      }
      if (deploymentId !== session.deploymentId) {
        return reply.code(409).send({
          error: 'Chunk deployment identity mismatch',
          message: 'The chunk session belongs to a different deployment operation.',
          deploymentId: session.deploymentId,
          requestedDeploymentId: deploymentId,
          sameOperation: false,
        });
      }
      if (requestedArtifact !== undefined) {
        const artifact = resolveArtifactExpectation(requestedArtifact, reply);
        if (!artifact) return;
        if (
          artifact.expectedBaseSha256 !== session.artifact.expectedBaseSha256
          || artifact.targetContentSha256 !== session.artifact.targetContentSha256
        ) {
          return reply.code(409).send({
            error: 'Chunk artifact identity mismatch',
            message: 'The chunk session is bound to a different artifact operation.',
            deploymentId: session.deploymentId,
            sameOperation: false,
          });
        }
      }
      // Add files to existing session
      sessionStore.addFiles(sessionId, files);
    } else {
      const artifact = resolveArtifactExpectation(requestedArtifact, reply);
      if (!artifact) return;
      // Create new session (automatically cleans up old sessions)
      session = sessionStore.create(
        deletions ?? [],
        expectedFiles,
        deploymentId,
        artifact
      );
      // Add initial files
      sessionStore.addFiles(session.id, files);
    }

    // Re-fetch session to get updated file count
    session = sessionStore.get(session.id)!;

    const response: ChunkedDeployResponse = {
      deploymentId,
      sessionId: session.id,
      filesReceived: session.files.length,
      committed: false,
    };

    // If commit requested, apply all changes using asadmin deploy
    if (commit) {
      // Check if deployment is already in progress
      if (checkDeploymentInProgress(deployer, deploymentId, reply)) {
        return;
      }

      try {
        // Decode all base64 file contents
        const changedFiles = decodeFileContents(session.files);

        logger.info({
          sessionId: session.id,
          filesChanged: changedFiles.length,
          filesDeleted: session.deletions.length,
        }, 'Committing chunked deployment via asadmin');

        // Deploy using asadmin deploy command (uses aggressive mode if configured)
        const result = await deployer.applyChangesAuto(
          changedFiles,
          session.deletions,
          deploymentId,
          session.artifact
        );
        const completedAt = Date.now();

        // Clean up session
        sessionStore.delete(session.id);

        response.committed = true;
        response.completedAt = completedAt;
        response.result = result;
      } catch (err) {
        // Clean up session on error
        sessionStore.delete(session.id);

        logger.error({ err, sessionId: session.id }, 'Chunked deployment failed');
        return reply.code(500).send({
          error: 'Deployment failed',
          message: getErrorMessage(err),
          deploymentId,
          completedAt: Date.now(),
        });
      }
    }

    return response;
  });

  /**
   * GET /deploy/status
   * Check current deployment status - used for polling long-running deployments
   */
  fastify.get('/deploy/status', async (request, reply) => {
    const appName = deployer.getAppName();
    const busyResponse = (
      lock: Awaited<ReturnType<typeof deployer.getDeploymentLockStatus>>
    ) => {
      const deployStatus = deployer.getDeploymentStatus();
      return {
        deploying: true,
        deploymentId: deployStatus.deploymentId ?? lock.data?.deploymentId,
        startedAt: deployStatus.startedAt,
        currentStep: deployStatus.currentStep ?? lock.data?.step,
        elapsedMs: deployStatus.startedAt ? Date.now() - deployStatus.startedAt : undefined,
        lastResult: deployStatus.lastResult,
        lastDeploymentId: deployStatus.lastDeploymentId,
        lastCompletedAt: deployStatus.lastCompletedAt,
        appDeployed: false,
        appName,
        healthy: false,
        running: false,
        bootDeployment: ctx.payara.getBootDeploymentStatus(appName),
        deploymentLock: {
          locked: lock.locked,
          stale: lock.stale ?? false,
          deploymentId: lock.data?.deploymentId,
          step: lock.data?.step,
        },
      };
    };

    try {
      const initialLock = await deployer.getDeploymentLockStatus();
      if (initialLock.locked || initialLock.stale) {
        return busyResponse(initialLock);
      }
      const stableDeployStatus = deployer.getDeploymentStatus();

      try {
        return await deployer.withDeploymentFileLock(
          `deploy-status:${appName}`,
          'verify',
          async () => {
            const deployStatus = stableDeployStatus;
            const appDeployed = await deployer.isAppDeployed();
            const payaraStatus = await ctx.payara.getStatus(true);
            await ctx.payara.readBootDeploymentStatus(appName);
            const bootDeployment = ctx.payara.getBootDeploymentStatus(appName);
            const fenceHealthy =
              bootDeployment.phase === 'ready'
              && !bootDeployment.mutationOutcomeUnknown;

            return {
              deploying: deployStatus.deploying,
              deploymentId: deployStatus.deploymentId,
              startedAt: deployStatus.startedAt,
              currentStep: deployStatus.currentStep,
              elapsedMs: deployStatus.startedAt
                ? Date.now() - deployStatus.startedAt
                : undefined,
              lastResult: deployStatus.lastResult,
              lastDeploymentId: deployStatus.lastDeploymentId,
              lastCompletedAt: deployStatus.lastCompletedAt,
              appDeployed,
              appName,
              healthy:
                !deployStatus.deploying
                && !ctx.payara.isMutationInProgress()
                && payaraStatus.healthy
                && payaraStatus.running
                && appDeployed
                && fenceHealthy,
              running: payaraStatus.running,
              bootDeployment,
              deploymentLock: { locked: false, stale: false },
            };
          }
        );
      } catch (err) {
        const racedLock = await deployer.getDeploymentLockStatus();
        const message = getErrorMessage(err);
        if (
          racedLock.locked
          || racedLock.stale
          || message.includes('Deployment already in progress')
          || message.includes('Unable to acquire deployment lock')
        ) {
          return busyResponse(racedLock.locked || racedLock.stale
            ? racedLock
            : { locked: true });
        }
        throw err;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to get deployment status');
      return reply.code(500).send({
        error: 'Failed to get deployment status',
        message: getErrorMessage(err),
      });
    }
  });

  /**
   * DELETE /deploy/chunk/:sessionId
   * Cancel a chunked deployment session
   */
  fastify.delete<{ Params: { sessionId: string } }>('/deploy/chunk/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;

    if (sessionStore.delete(sessionId)) {
      logger.info({ sessionId }, 'Chunked deployment session cancelled');
      return { status: 'cancelled', sessionId };
    }

    return reply.code(404).send({
      error: 'Session not found',
      message: `Session ${sessionId} not found`,
    });
  });
}
