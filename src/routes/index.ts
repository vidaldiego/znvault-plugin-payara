// Path: src/routes/index.ts
// HTTP routes module entry point

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { PayaraManager } from '../payara-manager.js';
import type { WarDeployer } from '../war-deployer.js';
import { SessionStore } from '../session-store.js';
import type { RouteContext } from './types.js';
import { registerDeployRoutes } from './deploy.js';
import { registerLifecycleRoutes } from './lifecycle.js';
import { registerStatusRoutes } from './status.js';
import { isMutationAuthorized } from '../mutation-auth.js';

/**
 * Register all Payara plugin HTTP routes
 *
 * Routes are registered under /plugins/payara/ prefix by the agent
 *
 * IMPORTANT: All deployment uses asadmin deploy commands.
 * The autodeploy directory is NOT used.
 */
export async function registerRoutes(
  fastify: FastifyInstance,
  payara: PayaraManager,
  deployer: WarDeployer,
  logger: Logger,
  mutationAuthToken: string,
  onAuthorizedRequest?: () => void,
  pluginVersion = '0.0.0'
): Promise<void> {
  if (!mutationAuthToken) {
    throw new Error(
      'PAYARA_MUTATION_AUTH_INVALID: mutation credential was not initialized'
    );
  }

  // onRequest runs before body parsing. Protect the complete Payara namespace:
  // even nominal readbacks can expose WAR content or advance runtime/lock
  // observations. OPTIONS is the sole non-resource exception.
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') {
      return;
    }
    if (!isMutationAuthorized(request.headers.authorization, mutationAuthToken)) {
      return reply
        .header('WWW-Authenticate', 'Bearer realm="payara-mutations"')
        .code(401)
        .send({ error: 'Unauthorized' });
    }
    onAuthorizedRequest?.();
  });

  // Create session store for chunked deployments
  const sessionStore = new SessionStore(logger, {
    maxSessions: 10,
    timeoutMs: 30 * 60 * 1000, // 30 minutes
  });

  // Add content type parser for binary WAR uploads (max 500MB)
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 500 * 1024 * 1024 },
    (request, payload, done) => {
      done(null, payload);
    }
  );

  // Create shared route context
  const ctx: RouteContext = {
    payara,
    deployer,
    sessionStore,
    logger,
    pluginVersion,
  };

  // Register route modules
  await registerDeployRoutes(fastify, ctx);
  await registerLifecycleRoutes(fastify, ctx);
  await registerStatusRoutes(fastify, ctx);
}

// Re-export types
export type { RouteContext } from './types.js';
