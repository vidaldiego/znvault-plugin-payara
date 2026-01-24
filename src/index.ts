// Path: src/index.ts
// Payara plugin for zn-vault-agent

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type {
  AgentPlugin,
  PluginContext,
  CertificateDeployedEvent,
  KeyRotatedEvent,
  SecretChangedEvent,
  PluginHealthStatus,
} from '@zincapp/zn-vault-agent/plugins';
import { PayaraManager } from './payara-manager.js';
import { WarDeployer } from './war-deployer.js';
import { registerRoutes } from './routes.js';
import type { PayaraPluginConfig } from './types.js';
import { getErrorMessage } from './utils/error.js';
import { fetchSecrets, verifyApiKeyFile, writeApiKeyToFile } from './secrets-handler.js';
import {
  assertValidConfig,
  hasSecrets,
  hasApiKeySecrets,
  isLifecycleManaged,
  getStartupMode,
} from './plugin-config.js';
import {
  handleExecModeStartup,
  handleAggressiveModeStartup,
  handleNormalModeStartup,
  ensureSinglePayaraProcess,
} from './plugin-startup.js';
import {
  evaluateHealth,
  buildHealthStatus,
  buildErrorHealthStatus,
} from './plugin-health.js';

// Read version from package.json at module load time
let pluginVersion = '0.0.0';
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pluginVersion = pkg.version || '0.0.0';
} catch {
  // Fallback version if package.json cannot be read
  pluginVersion = '0.0.0';
}

// Re-export types from agent for consumers that don't have agent installed
export type {
  AgentPlugin,
  PluginContext,
  CertificateDeployedEvent,
  KeyRotatedEvent,
  SecretChangedEvent,
  PluginHealthStatus,
} from '@zincapp/zn-vault-agent/plugins';

/**
 * Create Payara agent plugin
 */
export default function createPayaraPlugin(config: PayaraPluginConfig): AgentPlugin {
  let payara: PayaraManager;
  let deployer: WarDeployer;
  let pluginLogger: Logger;
  let secretsEnv: Record<string, string> = {};

  return {
    name: 'payara',
    version: pluginVersion,
    description: 'Payara application server management with WAR diff deployment, secret injection, and aggressive mode',

    async onInit(ctx: PluginContext): Promise<void> {
      pluginLogger = ctx.logger.child({ plugin: 'payara' });
      pluginLogger.info({
        payaraHome: config.payaraHome,
        domain: config.domain,
        warPath: config.warPath,
        appName: config.appName,
        secretsCount: hasSecrets(config) ? Object.keys(config.secrets!).length : 0,
      }, 'Initializing Payara plugin');

      assertValidConfig(config);

      if (hasSecrets(config)) {
        pluginLogger.info({
          count: Object.keys(config.secrets!).length,
          apiKeyFilePath: config.apiKeyFilePath,
        }, 'Fetching secrets for Payara environment');
        secretsEnv = await fetchSecrets(ctx, config.secrets!, pluginLogger, config.apiKeyFilePath, config.user);
        pluginLogger.info({ count: Object.keys(secretsEnv).length }, 'Secrets loaded successfully');
      }

      payara = new PayaraManager({
        payaraHome: config.payaraHome,
        domain: config.domain,
        user: config.user,
        healthEndpoint: config.healthEndpoint,
        healthCheckTimeout: config.healthCheckTimeout,
        operationTimeout: config.operationTimeout,
        logger: pluginLogger,
        environment: secretsEnv,
        passwordFile: config.passwordFile,
      });

      if (process.env.NODE_ENV !== 'test' && config.validateAsadmin !== false) {
        await payara.validateAsadmin();
      }

      deployer = new WarDeployer({
        warPath: config.warPath,
        appName: config.appName,
        contextRoot: config.contextRoot,
        payara,
        logger: pluginLogger,
        aggressiveMode: config.aggressiveMode ?? false,
      });

      pluginLogger.info('Payara plugin initialized');
    },

    async onStart(ctx: PluginContext): Promise<void> {
      const manageLifecycle = isLifecycleManaged(config);
      const startupMode = getStartupMode(config);

      pluginLogger.info({
        aggressiveMode: config.aggressiveMode ?? false,
        manageLifecycle,
        startupMode,
      }, 'Starting Payara plugin');

      if (manageLifecycle) {
        await ensureSinglePayaraProcess(payara, pluginLogger);
      }

      if (config.apiKeyFilePath && ctx.config.auth?.apiKey) {
        pluginLogger.info({ filePath: config.apiKeyFilePath }, 'Verifying API key file sync on startup');
        const keyVerification = await verifyApiKeyFile(
          config.apiKeyFilePath,
          ctx.config.auth.apiKey,
          pluginLogger
        );

        if (!keyVerification.valid) {
          pluginLogger.warn({
            filePath: config.apiKeyFilePath,
            error: keyVerification.error,
          }, 'API key file out of sync on startup - AUTO-FIXING NOW');

          await writeApiKeyToFile(
            config.apiKeyFilePath,
            ctx.config.auth.apiKey,
            pluginLogger,
            config.user
          );
          pluginLogger.info({ filePath: config.apiKeyFilePath }, 'API key file auto-fixed on startup');
        } else {
          pluginLogger.info({ filePath: config.apiKeyFilePath }, 'API key file verified - in sync');
        }
      }

      if (config.aggressiveMode && !manageLifecycle) {
        pluginLogger.warn(
          'aggressiveMode is enabled but manageLifecycle is false - ' +
          'aggressive mode features will be ignored since lifecycle is managed externally'
        );
      }

      if (hasSecrets(config)) {
        pluginLogger.debug('Refreshing secrets before Payara start');
        secretsEnv = await fetchSecrets(ctx, config.secrets!, pluginLogger, config.apiKeyFilePath, config.user);
        await payara.updateEnvironment(secretsEnv);
      }

      const startupCtx = {
        payara,
        deployer,
        logger: pluginLogger,
        postStartDelay: config.postStartDelay,
      };

      switch (startupMode) {
        case 'exec':
          await handleExecModeStartup(startupCtx);
          break;
        case 'aggressive':
          await handleAggressiveModeStartup(startupCtx);
          break;
        case 'normal':
          await handleNormalModeStartup(startupCtx);
          break;
      }

      pluginLogger.info('Payara plugin started');
    },

    async onStop(_ctx: PluginContext): Promise<void> {
      pluginLogger.info('Payara plugin stopping (Payara will continue running)');
    },

    async routes(fastify: FastifyInstance, _ctx: PluginContext): Promise<void> {
      await registerRoutes(fastify, payara, deployer, pluginLogger);
      pluginLogger.info('Payara routes registered');
    },

    async onCertificateDeployed(event: CertificateDeployedEvent, _ctx: PluginContext): Promise<void> {
      if (config.restartOnCertChange && isLifecycleManaged(config)) {
        pluginLogger.info({ certId: event.certId, name: event.name }, 'Certificate changed, restarting Payara');
        if (config.aggressiveMode) {
          await payara.aggressiveRestart();
        } else {
          await payara.restart();
        }
      } else {
        pluginLogger.debug({ certId: event.certId }, 'Certificate changed (no restart configured)');
      }
    },

    async onKeyRotated(event: KeyRotatedEvent, ctx: PluginContext): Promise<void> {
      if (!hasApiKeySecrets(config)) {
        pluginLogger.debug({ keyName: event.keyName }, 'Key rotated but no api-key secrets configured, ignoring');
        return;
      }

      pluginLogger.info({
        keyName: event.keyName,
        newPrefix: event.newPrefix,
        rotationMode: event.rotationMode,
        nextRotationAt: event.nextRotationAt,
      }, 'Managed API key rotated, updating key file');

      secretsEnv = await fetchSecrets(ctx, config.secrets!, pluginLogger, config.apiKeyFilePath, config.user);
      await payara.updateEnvironment(secretsEnv);

      if (config.apiKeyFilePath) {
        pluginLogger.info({ filePath: config.apiKeyFilePath }, 'API key file updated, app will pick up new key automatically');
      } else {
        const shouldRestart = config.restartOnKeyRotation !== false && isLifecycleManaged(config);

        if (shouldRestart) {
          pluginLogger.info('Restarting Payara with new API key (inline mode)...');
          if (config.aggressiveMode) {
            await payara.aggressiveRestart();
          } else {
            await payara.restart();
          }
          pluginLogger.info('Payara restarted successfully with rotated API key');
        } else {
          pluginLogger.warn('API key updated in setenv.conf but restart disabled - app may use stale key until manual restart');
        }
      }
    },

    async onSecretChanged(event: SecretChangedEvent, ctx: PluginContext): Promise<void> {
      if (!config.watchSecrets || config.watchSecrets.length === 0) {
        pluginLogger.debug({ alias: event.alias }, 'Secret changed but no watchSecrets configured, ignoring');
        return;
      }

      const isWatched = config.watchSecrets.some(pattern =>
        event.alias === pattern || event.alias.startsWith(pattern + '/')
      );

      if (!isWatched) {
        pluginLogger.debug({ alias: event.alias, watchSecrets: config.watchSecrets }, 'Secret changed but not in watchSecrets, ignoring');
        return;
      }

      pluginLogger.info({
        alias: event.alias,
        secretId: event.secretId,
        version: event.version,
      }, 'Watched secret changed, refreshing secrets');

      if (hasSecrets(config)) {
        secretsEnv = await fetchSecrets(ctx, config.secrets!, pluginLogger, config.apiKeyFilePath, config.user);
        await payara.updateEnvironment(secretsEnv);
      }

      pluginLogger.info({ alias: event.alias }, 'Secrets refreshed (no restart - app reads from files dynamically)');
    },

    async healthCheck(ctx: PluginContext): Promise<PluginHealthStatus> {
      try {
        const status = await payara.getStatus();
        const appDeployed = await deployer.isAppDeployed();

        const evaluation = await evaluateHealth({
          config,
          status,
          appDeployed,
          apiKey: ctx.config.auth?.apiKey,
          logger: pluginLogger,
        });

        return buildHealthStatus(config, status, appDeployed, evaluation);
      } catch (err) {
        return buildErrorHealthStatus(config, getErrorMessage(err));
      }
    },
  };
}

// Re-export types and utilities
export { PayaraManager } from './payara-manager.js';
export { WarDeployer, calculateDiff, calculateWarHashes, getWarEntry } from './war-deployer.js';
export { registerRoutes } from './routes.js';
export { createPayaraCLIPlugin } from './cli.js';
export { SessionStore } from './session-store.js';
export type { SessionStoreConfig } from './session-store.js';

// Re-export CLI utilities
export {
  CHUNK_SIZE,
  AGENT_TIMEOUT_MS,
  DEPLOYMENT_TIMEOUT_MS,
  ANSI,
  parsePort,
  agentGet,
  agentPost,
  buildPluginUrl,
  ProgressReporter,
  getWarInfo,
  formatSize,
  formatDuration,
  loadDeployConfigs,
  saveDeployConfigs,
} from './cli/index.js';

export type {
  PayaraPluginConfig,
  PayaraManagerOptions,
  WarDeployerOptions,
  WarFileHashes,
  FileChange,
  DeployRequest,
  DeployResponse,
  DeployResult,
  FullDeployResult,
  PayaraStatus,
  ChunkedDeployRequest,
  ChunkedDeployResponse,
  ChunkedDeploySession,
} from './types.js';
