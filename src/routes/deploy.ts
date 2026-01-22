// Path: src/routes/deploy.ts
// Deployment routes - handles WAR file deployment via asadmin

import type { FastifyInstance } from 'fastify';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  DeployRequest,
  ChunkedDeployRequest,
  ChunkedDeployResponse,
} from '../types.js';
import type { RouteContext } from './types.js';
import { getErrorMessage } from '../utils/error.js';
import {
  checkDeploymentInProgress,
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
    const { files, deletions } = request.body;

    // Validate request
    if (validateDeployRequest(request.body, reply)) {
      return;
    }

    // Check if deployment is already in progress
    if (checkDeploymentInProgress(deployer, reply)) {
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
      const result = await deployer.applyChangesAuto(changedFiles, deletions);

      if (result.success) {
        return {
          status: 'deployed',
          ...result,
        };
      } else {
        return reply.code(500).send({
          status: 'failed',
          error: 'Deployment failed',
          ...result,
        });
      }
    } catch (err) {
      logger.error({ err }, 'Deployment failed');
      return reply.code(500).send({
        error: 'Deployment failed',
        message: getErrorMessage(err),
      });
    }
  });

  /**
   * POST /deploy/full
   * Triggers a full WAR deployment using asadmin deploy (no diff)
   * In aggressive mode: undeploy → stop → kill → start → deploy
   */
  fastify.post('/deploy/full', async (request, reply) => {
    if (checkDeploymentInProgress(deployer, reply)) {
      return;
    }

    try {
      logger.info('Starting full deployment via asadmin');

      // Use deployAuto which respects aggressive mode
      const result = await deployer.deployAuto();

      return {
        status: result.deployed ? 'deployed' : 'failed',
        message: result.deployed ? 'Full deployment successful' : 'Deployment failed',
        deploymentTime: result.deploymentTime,
        deployed: result.deployed,
        applications: result.applications,
        appName: deployer.getAppName(),
        aggressiveMode: result.aggressiveMode,
      };
    } catch (err) {
      logger.error({ err }, 'Full deployment failed');
      return reply.code(500).send({
        error: 'Deployment failed',
        message: getErrorMessage(err),
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
    if (checkDeploymentInProgress(deployer, reply)) {
      return;
    }

    try {
      // Get the uploaded WAR buffer
      const warBuffer = request.body;

      if (!warBuffer || warBuffer.length === 0) {
        return reply.code(400).send({
          error: 'Invalid request',
          message: 'No WAR file data received',
        });
      }

      // Get WAR path from deployer
      const warPath = deployer.getWarPath();

      // Ensure directory exists
      await mkdir(dirname(warPath), { recursive: true });

      // Write buffer to WAR path
      await writeFile(warPath, warBuffer);

      logger.info({ warPath, size: warBuffer.length }, 'WAR file uploaded, deploying via asadmin...');

      // Deploy the WAR using asadmin deploy (respects aggressive mode)
      const result = await deployer.deployAuto();

      if (result.deployed) {
        return {
          status: 'deployed',
          message: 'WAR uploaded and deployed successfully via asadmin',
          size: warBuffer.length,
          deploymentTime: result.deploymentTime,
          deployed: true,
          applications: result.applications,
          appName: deployer.getAppName(),
          aggressiveMode: result.aggressiveMode,
        };
      } else {
        return reply.code(500).send({
          status: 'failed',
          error: 'Deployment failed',
          message: 'WAR uploaded but deployment via asadmin failed',
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
      });
    }
  });

  /**
   * POST /deploy/chunk
   * Upload files in chunks for large deployments
   *
   * For first chunk: omit sessionId, include deletions
   * For subsequent chunks: include sessionId from previous response
   * For final chunk: set commit: true to apply all changes
   */
  fastify.post<{ Body: ChunkedDeployRequest }>('/deploy/chunk', async (request, reply) => {
    const { sessionId, files, deletions, expectedFiles, commit } = request.body;

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
      // Add files to existing session
      sessionStore.addFiles(sessionId, files);
    } else {
      // Create new session (automatically cleans up old sessions)
      session = sessionStore.create(deletions ?? [], expectedFiles);
      // Add initial files
      sessionStore.addFiles(session.id, files);
    }

    // Re-fetch session to get updated file count
    session = sessionStore.get(session.id)!;

    const response: ChunkedDeployResponse = {
      sessionId: session.id,
      filesReceived: session.files.length,
      committed: false,
    };

    // If commit requested, apply all changes using asadmin deploy
    if (commit) {
      // Check if deployment is already in progress
      if (checkDeploymentInProgress(deployer, reply)) {
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
        const result = await deployer.applyChangesAuto(changedFiles, session.deletions);

        // Clean up session
        sessionStore.delete(session.id);

        response.committed = true;
        response.result = result;
      } catch (err) {
        // Clean up session on error
        sessionStore.delete(session.id);

        logger.error({ err, sessionId: session.id }, 'Chunked deployment failed');
        return reply.code(500).send({
          error: 'Deployment failed',
          message: getErrorMessage(err),
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
    try {
      const deployStatus = deployer.getDeploymentStatus();
      const appDeployed = await deployer.isAppDeployed();
      const payaraStatus = await ctx.payara.getStatus();

      return {
        // Current deployment status
        deploying: deployStatus.deploying,
        deploymentId: deployStatus.deploymentId,
        startedAt: deployStatus.startedAt,
        currentStep: deployStatus.currentStep,
        elapsedMs: deployStatus.startedAt ? Date.now() - deployStatus.startedAt : undefined,

        // Last deployment result (for checking if deployment completed)
        lastResult: deployStatus.lastResult,
        lastCompletedAt: deployStatus.lastCompletedAt,

        // Current state
        appDeployed,
        appName: deployer.getAppName(),
        healthy: payaraStatus.healthy,
        running: payaraStatus.running,
      };
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
