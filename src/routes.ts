// Path: src/routes.ts
// HTTP routes for Payara plugin

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { PayaraManager } from './payara-manager.js';
import type { WarDeployer } from './war-deployer.js';
import type { DeployRequest, ChunkedDeployRequest, ChunkedDeploySession, ChunkedDeployResponse } from './types.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Session storage for chunked deployments
 * In-memory storage with cleanup after 30 minutes
 */
const chunkSessions = new Map<string, ChunkedDeploySession>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Clean up expired sessions
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of chunkSessions.entries()) {
    if (now - session.createdAt > SESSION_TIMEOUT_MS) {
      chunkSessions.delete(id);
    }
  }
}

/**
 * Register Payara plugin HTTP routes
 *
 * Routes are registered under /plugins/payara/ prefix by the agent
 */
export async function registerRoutes(
  fastify: FastifyInstance,
  payara: PayaraManager,
  deployer: WarDeployer,
  logger: Logger
): Promise<void> {

  // Add content type parser for binary WAR uploads (max 500MB)
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 500 * 1024 * 1024 },
    (request, payload, done) => {
      done(null, payload);
    }
  );

  /**
   * GET /hashes
   * Returns SHA-256 hashes of all files in the current WAR
   * Used by CLI to calculate diff for incremental deployment
   */
  fastify.get('/hashes', async (request, reply) => {
    try {
      const hashes = await deployer.getCurrentHashes();
      return { hashes };
    } catch (err) {
      logger.error({ err }, 'Failed to get WAR hashes');
      return reply.code(500).send({
        error: 'Failed to get WAR hashes',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * POST /deploy
   * Applies file changes and deploys WAR
   * Receives base64-encoded file contents for changed files
   */
  fastify.post<{ Body: DeployRequest }>('/deploy', async (request, reply) => {
    const { files, deletions } = request.body;

    // Validate request
    if (!Array.isArray(files)) {
      return reply.code(400).send({
        error: 'Invalid request',
        message: 'files must be an array',
      });
    }

    if (!Array.isArray(deletions)) {
      return reply.code(400).send({
        error: 'Invalid request',
        message: 'deletions must be an array',
      });
    }

    // Check if deployment is already in progress
    if (deployer.isDeploying()) {
      return reply.code(409).send({
        error: 'Deployment in progress',
        message: 'Another deployment is already in progress. Please wait.',
      });
    }

    try {
      // Decode base64 file contents
      const changedFiles = files.map(f => ({
        path: f.path,
        content: Buffer.from(f.content, 'base64'),
      }));

      logger.info({
        filesChanged: changedFiles.length,
        filesDeleted: deletions.length,
      }, 'Starting deployment');

      await deployer.applyChanges(changedFiles, deletions);

      return {
        status: 'deployed',
        filesChanged: changedFiles.length,
        filesDeleted: deletions.length,
        message: 'Deployment successful',
      };
    } catch (err) {
      logger.error({ err }, 'Deployment failed');
      return reply.code(500).send({
        error: 'Deployment failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * POST /deploy/full
   * Triggers a full WAR deployment (no diff)
   */
  fastify.post('/deploy/full', async (request, reply) => {
    if (deployer.isDeploying()) {
      return reply.code(409).send({
        error: 'Deployment in progress',
        message: 'Another deployment is already in progress',
      });
    }

    try {
      await deployer.deploy();
      return {
        status: 'deployed',
        message: 'Full deployment successful',
      };
    } catch (err) {
      logger.error({ err }, 'Full deployment failed');
      return reply.code(500).send({
        error: 'Deployment failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * POST /deploy/upload
   * Upload a complete WAR file for initial deployment
   * Used when server has no existing WAR to diff against
   *
   * Expects raw binary WAR file in request body
   * Content-Type: application/octet-stream
   */
  fastify.post<{ Body: Buffer }>('/deploy/upload', async (request, reply) => {
    if (deployer.isDeploying()) {
      return reply.code(409).send({
        error: 'Deployment in progress',
        message: 'Another deployment is already in progress',
      });
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

      logger.info({ warPath, size: warBuffer.length }, 'WAR file uploaded, deploying...');

      // Deploy the WAR
      await deployer.deploy();

      return {
        status: 'deployed',
        message: 'WAR uploaded and deployed successfully',
        size: warBuffer.length,
      };
    } catch (err) {
      logger.error({ err }, 'WAR upload failed');
      return reply.code(500).send({
        error: 'WAR upload failed',
        message: err instanceof Error ? err.message : String(err),
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

    // Clean up expired sessions periodically
    cleanupExpiredSessions();

    let session: ChunkedDeploySession;

    if (sessionId) {
      // Continue existing session
      const existing = chunkSessions.get(sessionId);
      if (!existing) {
        return reply.code(404).send({
          error: 'Session not found',
          message: `Session ${sessionId} not found or expired`,
        });
      }
      session = existing;
    } else {
      // Create new session
      const newId = randomUUID();
      session = {
        id: newId,
        createdAt: Date.now(),
        files: [],
        deletions: deletions ?? [],
        expectedFiles,
      };
      chunkSessions.set(newId, session);
      logger.info({ sessionId: newId, expectedFiles }, 'Started chunked deployment session');
    }

    // Add files from this chunk
    session.files.push(...files);

    const response: ChunkedDeployResponse = {
      sessionId: session.id,
      filesReceived: session.files.length,
      committed: false,
    };

    // If commit requested, apply all changes
    if (commit) {
      // Check if deployment is already in progress
      if (deployer.isDeploying()) {
        return reply.code(409).send({
          error: 'Deployment in progress',
          message: 'Another deployment is already in progress. Please wait.',
        });
      }

      try {
        // Decode all base64 file contents
        const changedFiles = session.files.map(f => ({
          path: f.path,
          content: Buffer.from(f.content, 'base64'),
        }));

        logger.info({
          sessionId: session.id,
          filesChanged: changedFiles.length,
          filesDeleted: session.deletions.length,
        }, 'Committing chunked deployment');

        await deployer.applyChanges(changedFiles, session.deletions);

        // Clean up session
        chunkSessions.delete(session.id);

        response.committed = true;
        response.result = {
          filesChanged: changedFiles.length,
          filesDeleted: session.deletions.length,
          message: 'Deployment successful',
        };
      } catch (err) {
        // Clean up session on error
        chunkSessions.delete(session.id);

        logger.error({ err, sessionId: session.id }, 'Chunked deployment failed');
        return reply.code(500).send({
          error: 'Deployment failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return response;
  });

  /**
   * DELETE /deploy/chunk/:sessionId
   * Cancel a chunked deployment session
   */
  fastify.delete<{ Params: { sessionId: string } }>('/deploy/chunk/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;

    if (chunkSessions.has(sessionId)) {
      chunkSessions.delete(sessionId);
      logger.info({ sessionId }, 'Chunked deployment session cancelled');
      return { status: 'cancelled', sessionId };
    }

    return reply.code(404).send({
      error: 'Session not found',
      message: `Session ${sessionId} not found`,
    });
  });

  /**
   * POST /restart
   * Restart Payara domain
   */
  fastify.post('/restart', async (request, reply) => {
    try {
      logger.info('Restarting Payara');
      await payara.restart();
      return {
        status: 'restarted',
        message: 'Payara restarted successfully',
      };
    } catch (err) {
      logger.error({ err }, 'Restart failed');
      return reply.code(500).send({
        error: 'Restart failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * POST /start
   * Start Payara domain
   */
  fastify.post('/start', async (request, reply) => {
    try {
      logger.info('Starting Payara');
      await payara.start();
      return {
        status: 'started',
        message: 'Payara started successfully',
      };
    } catch (err) {
      logger.error({ err }, 'Start failed');
      return reply.code(500).send({
        error: 'Start failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * POST /stop
   * Stop Payara domain
   */
  fastify.post('/stop', async (request, reply) => {
    try {
      logger.info('Stopping Payara');
      await payara.stop();
      return {
        status: 'stopped',
        message: 'Payara stopped successfully',
      };
    } catch (err) {
      logger.error({ err }, 'Stop failed');
      return reply.code(500).send({
        error: 'Stop failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /status
   * Get current Payara status
   */
  fastify.get('/status', async (request, reply) => {
    try {
      const status = await payara.getStatus();
      return status;
    } catch (err) {
      logger.error({ err }, 'Failed to get status');
      return reply.code(500).send({
        error: 'Failed to get status',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /applications
   * List deployed applications
   */
  fastify.get('/applications', async (request, reply) => {
    try {
      const applications = await payara.listApplications();
      return { applications };
    } catch (err) {
      logger.error({ err }, 'Failed to list applications');
      return reply.code(500).send({
        error: 'Failed to list applications',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /file/:path
   * Get a specific file from the WAR
   */
  fastify.get<{ Params: { '*': string } }>('/file/*', async (request, reply) => {
    const filePath = (request.params as { '*': string })['*'];

    if (!filePath) {
      return reply.code(400).send({
        error: 'Invalid request',
        message: 'File path is required',
      });
    }

    try {
      const content = await deployer.getFile(filePath);

      if (!content) {
        return reply.code(404).send({
          error: 'Not found',
          message: `File not found: ${filePath}`,
        });
      }

      // Determine content type based on extension
      const ext = filePath.split('.').pop()?.toLowerCase();
      const contentTypes: Record<string, string> = {
        'xml': 'application/xml',
        'html': 'text/html',
        'css': 'text/css',
        'js': 'application/javascript',
        'json': 'application/json',
        'properties': 'text/plain',
        'txt': 'text/plain',
        'class': 'application/java-vm',
        'jar': 'application/java-archive',
      };

      reply.type(contentTypes[ext ?? ''] ?? 'application/octet-stream');
      return content;
    } catch (err) {
      logger.error({ err, filePath }, 'Failed to get file');
      return reply.code(500).send({
        error: 'Failed to get file',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
