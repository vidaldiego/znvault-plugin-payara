// Path: src/index.ts
// Payara plugin for zn-vault-agent

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { PayaraManager } from './payara-manager.js';
import { WarDeployer } from './war-deployer.js';
import { registerRoutes } from './routes.js';
import type { PayaraPluginConfig } from './types.js';

/**
 * Agent plugin interface
 * Matches the AgentPlugin interface from zn-vault-agent
 */
export interface AgentPlugin {
  name: string;
  version: string;
  description?: string;
  onInit?(ctx: PluginContext): Promise<void>;
  onStart?(ctx: PluginContext): Promise<void>;
  onStop?(ctx: PluginContext): Promise<void>;
  routes?(fastify: FastifyInstance, ctx: PluginContext): Promise<void>;
  onCertificateDeployed?(event: CertificateDeployedEvent, ctx: PluginContext): Promise<void>;
  healthCheck?(ctx: PluginContext): Promise<PluginHealthStatus>;
}

/**
 * Plugin context provided by the agent
 */
export interface PluginContext {
  logger: Logger;
  config: unknown;
  vaultUrl: string;
  tenantId: string;
  getSecret(aliasOrId: string): Promise<string>;
  restartChild(reason: string): Promise<void>;
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): void;
}

/**
 * Certificate deployed event
 */
export interface CertificateDeployedEvent {
  certId: string;
  name: string;
  paths: { cert?: string; key?: string; combined?: string };
  expiresAt: string;
}

/**
 * Plugin health status
 */
export interface PluginHealthStatus {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Create Payara agent plugin
 *
 * @param config - Plugin configuration
 * @returns Agent plugin instance
 *
 * @example
 * ```json
 * {
 *   "plugins": [{
 *     "package": "@zincapp/znvault-plugin-payara",
 *     "config": {
 *       "payaraHome": "/opt/payara",
 *       "domain": "domain1",
 *       "user": "payara",
 *       "warPath": "/opt/app/MyApp.war",
 *       "appName": "MyApp",
 *       "healthEndpoint": "http://localhost:8080/health"
 *     }
 *   }]
 * }
 * ```
 */
export default function createPayaraPlugin(config: PayaraPluginConfig): AgentPlugin {
  let payara: PayaraManager;
  let deployer: WarDeployer;
  let pluginLogger: Logger;

  return {
    name: 'payara',
    version: '1.0.0',
    description: 'Payara application server management with WAR diff deployment',

    async onInit(ctx: PluginContext): Promise<void> {
      pluginLogger = ctx.logger.child({ plugin: 'payara' });
      pluginLogger.info({ config }, 'Initializing Payara plugin');

      // Validate required config
      if (!config.payaraHome) {
        throw new Error('Payara plugin: payaraHome is required');
      }
      if (!config.domain) {
        throw new Error('Payara plugin: domain is required');
      }
      if (!config.user) {
        throw new Error('Payara plugin: user is required');
      }
      if (!config.warPath) {
        throw new Error('Payara plugin: warPath is required');
      }
      if (!config.appName) {
        throw new Error('Payara plugin: appName is required');
      }

      // Create Payara manager
      payara = new PayaraManager({
        payaraHome: config.payaraHome,
        domain: config.domain,
        user: config.user,
        healthEndpoint: config.healthEndpoint,
        healthCheckTimeout: config.healthCheckTimeout,
        operationTimeout: config.operationTimeout,
        logger: pluginLogger,
      });

      // Create WAR deployer
      deployer = new WarDeployer({
        warPath: config.warPath,
        appName: config.appName,
        contextRoot: config.contextRoot,
        payara,
        logger: pluginLogger,
      });

      pluginLogger.info('Payara plugin initialized');
    },

    async onStart(_ctx: PluginContext): Promise<void> {
      pluginLogger.info('Starting Payara plugin');

      // Check if Payara is already healthy
      if (await payara.isHealthy()) {
        pluginLogger.info('Payara already running and healthy');
      } else {
        pluginLogger.info('Starting Payara...');
        await payara.start();

        // Deploy WAR if it exists
        if (await deployer.warExists()) {
          await deployer.deploy();
        }
      }

      pluginLogger.info('Payara plugin started');
    },

    async onStop(_ctx: PluginContext): Promise<void> {
      // Don't stop Payara when agent stops - it runs independently
      pluginLogger.info('Payara plugin stopping (Payara will continue running)');
    },

    async routes(fastify: FastifyInstance, _ctx: PluginContext): Promise<void> {
      await registerRoutes(fastify, payara, deployer, pluginLogger);
      pluginLogger.info('Payara routes registered');
    },

    async onCertificateDeployed(event: CertificateDeployedEvent, _ctx: PluginContext): Promise<void> {
      if (config.restartOnCertChange) {
        pluginLogger.info({ certId: event.certId, name: event.name }, 'Certificate changed, restarting Payara');
        await payara.restart();
      }
    },

    async healthCheck(_ctx: PluginContext): Promise<PluginHealthStatus> {
      try {
        const status = await payara.getStatus();

        return {
          name: 'payara',
          status: status.healthy ? 'healthy' : status.running ? 'degraded' : 'unhealthy',
          details: {
            domain: config.domain,
            running: status.running,
            healthy: status.healthy,
            warPath: config.warPath,
            appName: config.appName,
          },
        };
      } catch (err) {
        return {
          name: 'payara',
          status: 'unhealthy',
          message: err instanceof Error ? err.message : String(err),
          details: {
            domain: config.domain,
            warPath: config.warPath,
          },
        };
      }
    },
  };
}

// Re-export types and utilities
export { PayaraManager } from './payara-manager.js';
export { WarDeployer, calculateDiff, calculateWarHashes, getWarEntry } from './war-deployer.js';
export { registerRoutes } from './routes.js';
export { createPayaraCLIPlugin } from './cli.js';
export type {
  PayaraPluginConfig,
  PayaraManagerOptions,
  WarDeployerOptions,
  WarFileHashes,
  FileChange,
  DeployRequest,
  DeployResponse,
  PayaraStatus,
} from './types.js';
