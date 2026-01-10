// Path: src/index.ts
// Payara plugin for zn-vault-agent

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
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

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
/**
 * Extract string value from SecretValue data
 * Handles field extraction for paths like "alias:db/creds.password"
 */
function extractSecretValue(
  data: Record<string, unknown>,
  field?: string
): string {
  if (field) {
    // Extract specific field from data
    const fieldValue = data[field];
    if (fieldValue === undefined) {
      throw new Error(`Field '${field}' not found in secret data`);
    }
    return String(fieldValue);
  }

  // No field specified - try common patterns
  // 1. If data has a 'value' field, use it (common for simple secrets and API keys)
  if ('value' in data && data.value !== undefined) {
    return String(data.value);
  }

  // 2. If data has only one key, use that value
  const keys = Object.keys(data);
  if (keys.length === 1 && keys[0] !== undefined) {
    return String(data[keys[0]]);
  }

  // 3. Otherwise, stringify the whole object
  return JSON.stringify(data);
}

/**
 * Write API key to a file (for file-based API key mode)
 * File is owned by root but readable by the payara group
 */
async function writeApiKeyToFile(
  filePath: string,
  apiKey: string,
  logger: Logger,
  payaraUser?: string
): Promise<void> {
  const { chmod } = await import('node:fs/promises');

  try {
    // Ensure directory exists with group-accessible permissions
    await mkdir(dirname(filePath), { recursive: true, mode: 0o750 });
    // Write key
    await writeFile(filePath, apiKey);
    // Explicitly set permissions (writeFile mode option is affected by umask)
    await chmod(filePath, 0o640);

    // Change ownership so payara group can read the file
    if (process.getuid?.() === 0 && payaraUser) {
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);
      try {
        // Set group ownership to payara user's group
        await execAsync(`chown root:${payaraUser} "${dirname(filePath)}"`);
        await execAsync(`chown root:${payaraUser} "${filePath}"`);
        logger.debug({ path: filePath, group: payaraUser }, 'Set file group ownership');
      } catch (chownErr) {
        logger.warn({ path: filePath, err: chownErr }, 'Failed to chown API key file');
      }
    }

    logger.info({ path: filePath }, 'API key written to file');
  } catch (err) {
    logger.error({ path: filePath, err }, 'Failed to write API key to file');
    throw new Error(`Failed to write API key to ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Fetch secrets from vault and return as environment variables
 * When apiKeyFilePath is set, API keys are written to that file instead of
 * being included in the returned env vars.
 */
async function fetchSecrets(
  ctx: PluginContext,
  secretsConfig: Record<string, string>,
  logger: Logger,
  apiKeyFilePath?: string,
  payaraUser?: string
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const [envVar, source] of Object.entries(secretsConfig)) {
    try {
      let value: string;

      if (source.startsWith('literal:')) {
        // Literal value (not recommended for secrets)
        value = source.substring('literal:'.length);
      } else if (source.startsWith('api-key:')) {
        // Fetch managed API key value from agent config
        // The managed key is bound by the agent and stored in ctx.config.auth.apiKey
        const keyName = source.substring('api-key:'.length);
        const configuredKeyName = ctx.config.managedKey?.name;

        if (configuredKeyName && configuredKeyName === keyName) {
          // Use the current API key from auth config (managed key value)
          if (!ctx.config.auth?.apiKey) {
            throw new Error(`Managed API key '${keyName}' not yet bound`);
          }
          value = ctx.config.auth.apiKey;
          logger.debug({ keyName }, 'Using managed API key from agent config');

          // If file-based API key is enabled, write to file instead of env var
          if (apiKeyFilePath) {
            await writeApiKeyToFile(apiKeyFilePath, value, logger, payaraUser);
            // Don't add to env - Payara reads from the file via ZINC_CONFIG_VAULT_API_KEY_FILE
            logger.debug({ envVar, filePath: apiKeyFilePath }, 'API key written to file instead of env var');
            continue; // Skip adding to env
          }
        } else {
          throw new Error(`API key '${keyName}' not configured as managed key (expected: ${configuredKeyName || 'none'})`);
        }
      } else if (source.startsWith('alias:')) {
        // Fetch secret by alias (may include .field for JSON extraction)
        // Parse "alias:path/to/secret.field" format
        const aliasPath = source.substring('alias:'.length);
        const dotIndex = aliasPath.lastIndexOf('.');

        // Check if there's a field extraction (but not for paths like "api.staging.db")
        // A field must be at the end and the base must exist
        let basePath = aliasPath;
        let field: string | undefined;

        if (dotIndex > 0) {
          const potentialField = aliasPath.substring(dotIndex + 1);
          // Only treat as field if it doesn't contain slashes (not a path component)
          if (!potentialField.includes('/')) {
            basePath = aliasPath.substring(0, dotIndex);
            field = potentialField;
          }
        }

        const secretValue = await ctx.getSecret(`alias:${basePath}`);
        value = extractSecretValue(secretValue.data, field);
      } else {
        // Default: treat as alias
        const secretValue = await ctx.getSecret(`alias:${source}`);
        value = extractSecretValue(secretValue.data);
      }

      env[envVar] = value;
      logger.debug({ envVar, source: source.replace(/:.+/, ':***') }, 'Secret loaded');
    } catch (err) {
      logger.error({ envVar, source: source.replace(/:.+/, ':***'), err }, 'Failed to fetch secret');
      throw new Error(`Failed to fetch secret for ${envVar}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return env;
}

export default function createPayaraPlugin(config: PayaraPluginConfig): AgentPlugin {
  let payara: PayaraManager;
  let deployer: WarDeployer;
  let pluginLogger: Logger;
  let secretsEnv: Record<string, string> = {};

  return {
    name: 'payara',
    version: '1.6.1',
    description: 'Payara application server management with WAR diff deployment, secret injection, and aggressive mode',

    async onInit(ctx: PluginContext): Promise<void> {
      pluginLogger = ctx.logger.child({ plugin: 'payara' });
      pluginLogger.info({
        payaraHome: config.payaraHome,
        domain: config.domain,
        warPath: config.warPath,
        appName: config.appName,
        secretsCount: config.secrets ? Object.keys(config.secrets).length : 0,
      }, 'Initializing Payara plugin');

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

      // Fetch secrets if configured
      if (config.secrets && Object.keys(config.secrets).length > 0) {
        pluginLogger.info({
          count: Object.keys(config.secrets).length,
          apiKeyFilePath: config.apiKeyFilePath,
        }, 'Fetching secrets for Payara environment');
        secretsEnv = await fetchSecrets(ctx, config.secrets, pluginLogger, config.apiKeyFilePath, config.user);
        pluginLogger.info({ count: Object.keys(secretsEnv).length }, 'Secrets loaded successfully');
      }

      // Create Payara manager with secrets as environment
      payara = new PayaraManager({
        payaraHome: config.payaraHome,
        domain: config.domain,
        user: config.user,
        healthEndpoint: config.healthEndpoint,
        healthCheckTimeout: config.healthCheckTimeout,
        operationTimeout: config.operationTimeout,
        logger: pluginLogger,
        environment: secretsEnv,
      });

      // Validate asadmin binary exists (early failure detection)
      // Skip in test environments or when explicitly disabled
      if (process.env.NODE_ENV !== 'test' && config.validateAsadmin !== false) {
        await payara.validateAsadmin();
      }

      // Create WAR deployer
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
      const manageLifecycle = config.manageLifecycle !== false; // default: true

      pluginLogger.info({
        aggressiveMode: config.aggressiveMode ?? false,
        manageLifecycle,
      }, 'Starting Payara plugin');

      // Warn about conflicting config options
      if (config.aggressiveMode && !manageLifecycle) {
        pluginLogger.warn(
          'aggressiveMode is enabled but manageLifecycle is false - ' +
          'aggressive mode features will be ignored since lifecycle is managed externally'
        );
      }

      // Refresh secrets before starting (in case they changed)
      if (config.secrets && Object.keys(config.secrets).length > 0) {
        pluginLogger.debug('Refreshing secrets before Payara start');
        secretsEnv = await fetchSecrets(ctx, config.secrets, pluginLogger, config.apiKeyFilePath, config.user);
        payara.setEnvironment(secretsEnv);
      }

      if (!manageLifecycle) {
        // EXEC MODE: Don't start Payara, wait for it to be ready (started by exec)
        pluginLogger.info('Lifecycle managed externally (exec mode), waiting for Payara to be ready...');

        // Wait for Payara to become healthy (started by exec command)
        const maxWait = 120000; // 2 minutes
        const startTime = Date.now();
        let payaraReady = false;

        while (Date.now() - startTime < maxWait) {
          if (await payara.isRunning()) {
            pluginLogger.info('Payara is running');
            payaraReady = true;
            break;
          }
          await new Promise(r => setTimeout(r, 2000));
        }

        if (!payaraReady) {
          pluginLogger.warn(
            `Timeout waiting for Payara to start (${maxWait / 1000}s). ` +
            'Plugin will continue but Payara may not be available. ' +
            'Check exec command configuration.'
          );
        }

        // Deploy WAR if it exists and Payara is running
        if (payaraReady && await deployer.warExists()) {
          await deployer.deploy();
        }
      } else if (config.aggressiveMode) {
        // AGGRESSIVE MODE: Ensure clean slate, but skip restart if already healthy
        // This allows agent restarts (e.g., plugin updates) without disrupting Payara
        if (await payara.isHealthy()) {
          pluginLogger.info('Aggressive mode: Payara already running and healthy, skipping restart');

          // Just ensure app is deployed
          if (await deployer.warExists() && !(await deployer.isAppDeployed())) {
            pluginLogger.info('WAR exists but app not deployed, deploying...');
            await deployer.deploy();
          }
        } else {
          pluginLogger.info('Aggressive mode: Payara not healthy, ensuring clean state');

          // Kill any existing Java processes (clean slate)
          await payara.ensureNoJavaRunning(true);

          // Start Payara fresh
          await payara.safeStart();

          // Deploy WAR if it exists
          if (await deployer.warExists()) {
            await deployer.deploy();
          }
        }
      } else {
        // NORMAL MODE: Start only if not already running
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
      const manageLifecycle = config.manageLifecycle !== false;

      if (config.restartOnCertChange && manageLifecycle) {
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
      // Only react if this is for our managed key and secrets include an api-key reference
      const hasApiKeySecret = config.secrets && Object.values(config.secrets).some(s => s.startsWith('api-key:'));
      if (!hasApiKeySecret) {
        pluginLogger.debug({ keyName: event.keyName }, 'Key rotated but no api-key secrets configured, ignoring');
        return;
      }

      pluginLogger.info({
        keyName: event.keyName,
        newPrefix: event.newPrefix,
        rotationMode: event.rotationMode,
        nextRotationAt: event.nextRotationAt,
      }, 'Managed API key rotated, updating key file');

      // Refresh secrets to update the API key file
      // When apiKeyFilePath is set, the key is written to file and the app
      // reads it on each request - NO restart needed
      secretsEnv = await fetchSecrets(ctx, config.secrets!, pluginLogger, config.apiKeyFilePath, config.user);
      payara.setEnvironment(secretsEnv);

      if (config.apiKeyFilePath) {
        // File-based mode: NO restart needed, app reads key from file dynamically
        pluginLogger.info({ filePath: config.apiKeyFilePath }, 'API key file updated, app will pick up new key automatically');
        // Note: No restart - the app reads from file on each request
      } else {
        // Legacy inline mode: env vars in setenv.conf won't be picked up without restart
        // But if manageLifecycle is false, we can't restart
        const manageLifecycle = config.manageLifecycle !== false;
        const shouldRestart = config.restartOnKeyRotation !== false && manageLifecycle;

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
      // Only react if we're watching this secret
      if (!config.watchSecrets || config.watchSecrets.length === 0) {
        pluginLogger.debug({ alias: event.alias }, 'Secret changed but no watchSecrets configured, ignoring');
        return;
      }

      // Check if the changed secret matches any of our watched patterns
      const isWatched = config.watchSecrets.some(pattern => {
        // Support exact match or prefix match
        return event.alias === pattern || event.alias.startsWith(pattern + '/');
      });

      if (!isWatched) {
        pluginLogger.debug({ alias: event.alias, watchSecrets: config.watchSecrets }, 'Secret changed but not in watchSecrets, ignoring');
        return;
      }

      pluginLogger.info({
        alias: event.alias,
        secretId: event.secretId,
        version: event.version,
      }, 'Watched secret changed, refreshing secrets');

      // Refresh secrets to pick up new values (updates files and setenv.conf)
      if (config.secrets && Object.keys(config.secrets).length > 0) {
        secretsEnv = await fetchSecrets(ctx, config.secrets, pluginLogger, config.apiKeyFilePath, config.user);
        payara.setEnvironment(secretsEnv);
      }

      // NOTE: We do NOT restart Payara on secret changes by default
      // - File-based secrets: App reads from file dynamically
      // - setenv.conf secrets: Would need restart, but that's disruptive
      //
      // If restart is needed, user should configure restartOnSecretChange: true
      // or trigger a deployment which does a full restart in aggressive mode
      pluginLogger.info({ alias: event.alias }, 'Secrets refreshed (no restart - app reads from files dynamically)');
    },

    async healthCheck(_ctx: PluginContext): Promise<PluginHealthStatus> {
      try {
        const status = await payara.getStatus();
        const appDeployed = await deployer.isAppDeployed();

        // Healthy = domain running + app deployed + health endpoint responding (if configured)
        // Degraded = domain running but app not deployed or health check failing
        // Unhealthy = domain not running
        let healthStatus: 'healthy' | 'degraded' | 'unhealthy';
        if (status.running && appDeployed && status.healthy) {
          healthStatus = 'healthy';
        } else if (status.running) {
          healthStatus = 'degraded';
        } else {
          healthStatus = 'unhealthy';
        }

        return {
          name: 'payara',
          status: healthStatus,
          details: {
            domain: config.domain,
            running: status.running,
            healthy: status.healthy,
            appDeployed,
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
  DeployResult,
  FullDeployResult,
  PayaraStatus,
  ChunkedDeployRequest,
  ChunkedDeployResponse,
  ChunkedDeploySession,
} from './types.js';
