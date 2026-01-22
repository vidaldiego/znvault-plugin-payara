// Path: src/routes/lifecycle.ts
// Lifecycle routes - server start/stop/restart operations

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.js';
import { getErrorMessage } from '../utils/error.js';

/**
 * Register lifecycle routes
 *
 * Routes:
 * - POST /restart - Restart Payara domain
 * - POST /start - Start Payara domain
 * - POST /stop - Stop Payara domain
 * - POST /undeploy - Undeploy the application
 */
export async function registerLifecycleRoutes(
  fastify: FastifyInstance,
  ctx: RouteContext
): Promise<void> {
  const { payara, deployer, logger } = ctx;

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
        message: getErrorMessage(err),
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
        message: getErrorMessage(err),
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
        message: getErrorMessage(err),
      });
    }
  });

  /**
   * POST /undeploy
   * Undeploy the application
   */
  fastify.post('/undeploy', async (request, reply) => {
    try {
      logger.info({ appName: deployer.getAppName() }, 'Undeploying application');
      await deployer.undeploy();
      return {
        status: 'undeployed',
        message: 'Application undeployed successfully',
        appName: deployer.getAppName(),
      };
    } catch (err) {
      logger.error({ err }, 'Undeploy failed');
      return reply.code(500).send({
        error: 'Undeploy failed',
        message: getErrorMessage(err),
      });
    }
  });
}
