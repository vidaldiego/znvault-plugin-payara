// Path: src/routes/status.ts
// Status routes - health, hashes, applications, and file access

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.js';
import { CONTENT_TYPES } from './types.js';
import { getErrorMessage } from '../utils/error.js';

/**
 * Register status routes
 *
 * Routes:
 * - GET /status - Get current Payara status
 * - GET /hashes - Get WAR file hashes for diff deployment
 * - GET /applications - List deployed applications
 * - GET /file/* - Get a specific file from the WAR
 */
export async function registerStatusRoutes(
  fastify: FastifyInstance,
  ctx: RouteContext
): Promise<void> {
  const { payara, deployer, logger } = ctx;

  /**
   * GET /hashes
   * Returns SHA-256 hashes of all files in the current WAR
   * Used by CLI to calculate diff for incremental deployment
   *
   * Response includes status field for better error handling:
   * - status: 'ok' - WAR exists, hashes returned
   * - status: 'no_war' - No WAR file deployed yet
   * - status: 'error' - Failed to read hashes
   */
  fastify.get('/hashes', async (request, reply) => {
    try {
      // Check if WAR exists first
      if (!(await deployer.warExists())) {
        return {
          hashes: {},
          status: 'no_war',
          message: 'No WAR file deployed yet',
        };
      }

      const hashes = await deployer.getCurrentHashes();

      return {
        hashes,
        status: 'ok',
        fileCount: Object.keys(hashes).length,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to get WAR hashes');
      return reply.code(500).send({
        error: 'Failed to get WAR hashes',
        message: getErrorMessage(err),
        status: 'error',
      });
    }
  });

  /**
   * GET /status
   * Get current Payara status including deployment status
   */
  fastify.get('/status', async (request, reply) => {
    try {
      const status = await payara.getStatus();

      // Also check if app is deployed
      const appDeployed = await deployer.isAppDeployed();

      // Explicitly list all properties to avoid spread issues
      return {
        healthy: status.healthy,
        running: status.running,
        domain: status.domain,
        processCount: status.processCount,
        processPids: status.processPids,
        appDeployed,
        appName: deployer.getAppName(),
        warPath: deployer.getWarPath(),
      };
    } catch (err) {
      logger.error({ err }, 'Failed to get status');
      return reply.code(500).send({
        error: 'Failed to get status',
        message: getErrorMessage(err),
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
        message: getErrorMessage(err),
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
      reply.type(CONTENT_TYPES[ext ?? ''] ?? 'application/octet-stream');
      return content;
    } catch (err) {
      logger.error({ err, filePath }, 'Failed to get file');
      return reply.code(500).send({
        error: 'Failed to get file',
        message: getErrorMessage(err),
      });
    }
  });
}
