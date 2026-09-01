// Path: src/index.ts
// Payara plugin for zn-vault-agent

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type {
  AgentPlugin,
  PluginContext,
  CertificateDeployedEvent,
  KeyRotatedEvent,
  SecretChangedEvent,
  ChildProcessEvent,
  PluginHealthStatus,
} from '@zincapp/zn-vault-agent/plugins';
import { PayaraManager } from './payara-manager.js';
import { WarDeployer } from './war-deployer.js';
import { registerRoutes } from './routes.js';
import type { PayaraPluginConfig } from './types.js';
import { getErrorMessage } from './utils/error.js';
import {
  assertOperationDeadline,
  fetchSecrets,
  verifyApiKeyFile,
  writeApiKeyToFile,
} from './secrets-handler.js';
import {
  assertValidConfig,
  assertNoCompetingPayaraExec,
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
import {
  DEFAULT_MUTATION_AUTH_TOKEN_FILE,
  loadMutationAuthTokenFile,
} from './mutation-auth.js';

const STARTUP_DEADLINE_MS = 105_000;
const EVENT_HANDLER_DEADLINE_MS = 25_000;
const PUBLIC_HEALTH_SNAPSHOT_TTL_MS = 5_000;

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
  ChildProcessEvent,
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
  let startupReconciliationState: 'not_started' | 'in_progress' | 'complete' | 'failed' = 'not_started';
  let startupReconciliationError: string | undefined;
  let keyRotationTail: Promise<void> = Promise.resolve();
  let mutationAuthToken: string | undefined;
  let healthSnapshotGeneration = 0;
  let cachedHealthSnapshot: {
    generation: number;
    refreshedAtMs: number;
    status: PluginHealthStatus;
  } | undefined;
  let healthSnapshotInFlight: {
    generation: number;
    promise: Promise<PluginHealthStatus>;
  } | undefined;

  const invalidatePublicHealthSnapshot = (): void => {
    healthSnapshotGeneration += 1;
    cachedHealthSnapshot = undefined;
  };

  const getPublicHealthSnapshot = async (
    ctx: PluginContext
  ): Promise<PluginHealthStatus> => {
    const generation = healthSnapshotGeneration;
    const now = Date.now();
    if (
      cachedHealthSnapshot?.generation === generation
      && now - cachedHealthSnapshot.refreshedAtMs < PUBLIC_HEALTH_SNAPSHOT_TTL_MS
    ) {
      return cachedHealthSnapshot.status;
    }
    if (healthSnapshotInFlight?.generation === generation) {
      return healthSnapshotInFlight.promise;
    }

    const promise = (async (): Promise<PluginHealthStatus> => {
      try {
        // Never force a refresh from an unauthenticated probe. PayaraManager's
        // own TTL may provide a process snapshot, while this outer cache also
        // coalesces list-applications and key-file verification.
        const status = await payara.getStatus();
        const appDeployed = await deployer.isAppDeployed();
        const evaluation = await evaluateHealth({
          config,
          status,
          appDeployed,
          apiKey: ctx.config.auth?.apiKey,
          logger: pluginLogger,
        });
        const bootDeployment = payara.getBootDeploymentStatus(config.appName);
        const health = buildHealthStatus(
          config,
          status,
          appDeployed,
          bootDeployment,
          evaluation
        );
        return {
          ...health,
          details: {
            ...health.details,
            startupReconciliation: startupReconciliationState,
          },
        };
      } catch (err) {
        const status = buildErrorHealthStatus(
          config,
          startupReconciliationError ?? getErrorMessage(err)
        );
        return {
          ...status,
          details: {
            ...status.details,
            startupReconciliation: startupReconciliationState,
            ...(startupReconciliationError
              ? { startupReconciliationError }
              : {}),
          },
        };
      }
    })();
    healthSnapshotInFlight = { generation, promise };
    try {
      const status = await promise;
      // A protected operator request or event may have invalidated the state
      // while this refresh was running. Never cache that older generation.
      if (healthSnapshotGeneration === generation) {
        cachedHealthSnapshot = {
          generation,
          refreshedAtMs: Date.now(),
          status,
        };
      }
      return status;
    } finally {
      if (healthSnapshotInFlight?.promise === promise) {
        healthSnapshotInFlight = undefined;
      }
    }
  };

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
      const agentControlTokenPath = process.env.ZNVAULT_CONTROL_TOKEN_FILE
        ?? DEFAULT_MUTATION_AUTH_TOKEN_FILE;
      if (
        config.mutationAuthTokenFile
        && config.mutationAuthTokenFile !== agentControlTokenPath
      ) {
        throw new Error(
          'PAYARA_MUTATION_AUTH_INVALID: mutationAuthTokenFile must match ' +
          'ZNVAULT_CONTROL_TOKEN_FILE so the Agent and plugin gates use one credential'
        );
      }
      const mutationAuthTokenPath = config.mutationAuthTokenFile
        ?? agentControlTokenPath;
      if (!isAbsolute(mutationAuthTokenPath)) {
        throw new Error(
          'PAYARA_MUTATION_AUTH_INVALID: mutation credential path must be absolute'
        );
      }
      mutationAuthToken = loadMutationAuthTokenFile(mutationAuthTokenPath);
      assertNoCompetingPayaraExec(
        config,
        ctx.config.exec?.command,
        [
          ctx.config.globalReloadCmd,
          ...(ctx.config.targets ?? []).map(target => target.reloadCmd),
          ...(ctx.config.secretTargets ?? []).map(target => target.reloadCmd),
        ]
      );

      payara = new PayaraManager({
        payaraHome: config.payaraHome,
        domain: config.domain,
        user: config.user,
        healthEndpoint: config.healthEndpoint,
        healthCheckTimeout: config.healthCheckTimeout,
        operationTimeout: config.operationTimeout,
        deployTimeout: config.deployTimeout,
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
      const deadlineMs = performance.now() + STARTUP_DEADLINE_MS;
      const manageLifecycle = isLifecycleManaged(config);
      const startupMode = getStartupMode(config);

      pluginLogger.info({
        aggressiveMode: config.aggressiveMode ?? false,
        manageLifecycle,
        startupMode,
      }, 'Starting Payara plugin');

      if (startupReconciliationState === 'in_progress') {
        throw new Error('Payara plugin startup reconciliation is already running');
      }
      startupReconciliationError = undefined;
      startupReconciliationState = 'in_progress';

      try {
        await deployer.withDeploymentLock(
          `plugin-startup:${config.appName}`,
          'start',
          () => payara.withStartupFence(config.appName, async () => {
            assertOperationDeadline(deadlineMs, 'Payara startup reconciliation');
            if (manageLifecycle) {
              await ensureSinglePayaraProcess(payara, pluginLogger, deadlineMs);
            }

            if (config.aggressiveMode && !manageLifecycle) {
              pluginLogger.warn(
                'aggressiveMode is enabled but manageLifecycle is false - ' +
                'aggressive mode features will be ignored since lifecycle is managed externally'
              );
            }

            if (hasSecrets(config)) {
              pluginLogger.debug('Refreshing secrets before Payara start');
              secretsEnv = await fetchSecrets(
                ctx,
                config.secrets!,
                pluginLogger,
                config.apiKeyFilePath,
                config.user,
                config.fileSourceRoot,
                deadlineMs
              );
              await payara.updateEnvironment(secretsEnv, deadlineMs);
            }

            // Managed api-key sources are written atomically by fetchSecrets,
            // after every Vault read has succeeded. Preserve the standalone
            // apiKeyFilePath mode without performing an early partial refresh.
            if (
              config.apiKeyFilePath
              && ctx.config.auth?.apiKey
              && !hasApiKeySecrets(config)
            ) {
              pluginLogger.info(
                { filePath: config.apiKeyFilePath },
                'Verifying API key file sync on startup'
              );
              const keyVerification = await verifyApiKeyFile(
                config.apiKeyFilePath,
                ctx.config.auth.apiKey,
                pluginLogger,
                deadlineMs
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
                  config.user,
                  deadlineMs
                );
                pluginLogger.info(
                  { filePath: config.apiKeyFilePath },
                  'API key file auto-fixed on startup'
                );
              } else {
                pluginLogger.info(
                  { filePath: config.apiKeyFilePath },
                  'API key file verified - in sync'
                );
              }
            }

            const startupCtx = {
              payara,
              deployer,
              logger: pluginLogger,
              postStartDelay: config.postStartDelay,
              deadlineMs,
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
            assertOperationDeadline(deadlineMs, 'Payara startup reconciliation');
          })
        );
        startupReconciliationState = 'complete';
        invalidatePublicHealthSnapshot();
        pluginLogger.info('Payara plugin startup reconciliation completed');
        pluginLogger.info('Payara plugin started');
      } catch (err) {
        startupReconciliationState = 'failed';
        startupReconciliationError = getErrorMessage(err);
        const errorName = err instanceof Error ? err.name : '';
        if (
          errorName === 'BOOT_MUTATION_OUTCOME_UNKNOWN'
          || errorName.startsWith('BOOT_QUARANTINE_')
        ) {
          pluginLogger.error(
            { err, appName: config.appName },
            'Payara plugin started in mutation quarantine; lifecycle and deployment remain fenced'
          );
        } else {
          pluginLogger.error(
            { err, appName: config.appName },
            'Payara plugin startup reconciliation failed; lifecycle remains fenced'
          );
        }
        throw err;
      }
    },

    async onStop(_ctx: PluginContext): Promise<void> {
      invalidatePublicHealthSnapshot();
      pluginLogger.info(
        { startupReconciliation: startupReconciliationState },
        'Payara plugin stopping (Payara will continue running)'
      );
    },

    async routes(fastify: FastifyInstance, _ctx: PluginContext): Promise<void> {
      if (!mutationAuthToken) {
        throw new Error(
          'PAYARA_MUTATION_AUTH_INVALID: mutation credential was not initialized'
        );
      }
      fastify.addHook('preHandler', async (_request, reply) => {
        if (startupReconciliationState !== 'complete') {
          return reply.code(503).send({
            error: 'STARTUP_RECONCILIATION_NOT_COMPLETE',
            startupReconciliation: startupReconciliationState,
            ...(startupReconciliationError
              ? { startupReconciliationError }
              : {}),
          });
        }
      });
      await registerRoutes(
        fastify,
        payara,
        deployer,
        pluginLogger,
        mutationAuthToken,
        invalidatePublicHealthSnapshot,
        pluginVersion
      );
      pluginLogger.info('Payara routes registered');
    },

    async onCertificateDeployed(event: CertificateDeployedEvent, _ctx: PluginContext): Promise<void> {
      if (config.restartOnCertChange) {
        throw new Error(
          'Payara plugin: certificate-triggered restarts are unsupported by this agent host'
        );
      }
      pluginLogger.debug({ certId: event.certId }, 'Certificate changed (no restart configured)');
    },

    async onKeyRotated(event: KeyRotatedEvent, ctx: PluginContext): Promise<void> {
      const apiKeySecretsConfigured = hasApiKeySecrets(config);
      const apiKeyFilePath = config.apiKeyFilePath;
      if (!apiKeySecretsConfigured && !apiKeyFilePath) {
        pluginLogger.debug({ keyName: event.keyName }, 'Key rotated but no api-key secrets configured, ignoring');
        return;
      }
      if (!apiKeyFilePath) {
        throw new Error(
          'Payara plugin: apiKeyFilePath is required for managed API key rotation'
        );
      }
      const configuredKeyName = ctx.config.managedKey?.name
        ?? (ctx.config as { managedKeyName?: string }).managedKeyName;
      if (!configuredKeyName) {
        if (apiKeySecretsConfigured) {
          throw new Error('Payara plugin: managed API key is not configured in the agent');
        }
        pluginLogger.debug(
          { keyName: event.keyName },
          'Key rotated but no managed key is configured, ignoring'
        );
        return;
      }
      if (event.keyName !== configuredKeyName) {
        pluginLogger.debug(
          { keyName: event.keyName, configuredKeyName },
          'Key rotation is for a different managed key, ignoring'
        );
        return;
      }
      // The key file is consumed directly by the application and is replaced
      // atomically. It must not contend with the Payara/WAR lock: a deployment
      // may legitimately exceed the agent's entire rotation retry horizon.
      // Serialize only key generations so concurrent events leave the last
      // observed managed key on disk.
      const priorRotation = keyRotationTail.catch(() => undefined);
      const rotation = priorRotation.then(async () => {
        const deadlineMs = performance.now() + EVENT_HANDLER_DEADLINE_MS;
        pluginLogger.info({
          keyName: event.keyName,
          rotationMode: event.rotationMode,
          nextRotationAt: event.nextRotationAt,
        }, 'Managed API key rotated, updating key file');

        if (apiKeySecretsConfigured) {
          await fetchSecrets(
            ctx,
            Object.fromEntries(
              Object.entries(config.secrets!).filter(([, source]) =>
                source.startsWith('api-key:')
              )
            ),
            pluginLogger,
            apiKeyFilePath,
            config.user,
            config.fileSourceRoot,
            deadlineMs
          );
        } else {
          const apiKey = ctx.config.auth?.apiKey;
          if (!apiKey) {
            throw new Error(`Managed API key '${configuredKeyName}' not yet bound`);
          }
          await writeApiKeyToFile(
            apiKeyFilePath,
            apiKey,
            pluginLogger,
            config.user,
            deadlineMs
          );
        }

        pluginLogger.info(
          { filePath: apiKeyFilePath },
          'API key file updated, app will pick up new key automatically'
        );
        invalidatePublicHealthSnapshot();
      });
      keyRotationTail = rotation;
      await rotation;
    },

    async onSecretChanged(event: SecretChangedEvent, _ctx: PluginContext): Promise<void> {
      if (config.watchSecrets && config.watchSecrets.length > 0) {
        throw new Error(
          'Payara plugin: watchSecrets events are unsupported by this agent host'
        );
      }
      pluginLogger.debug(
        { alias: event.alias },
        'Secret changed but watchSecrets is disabled, ignoring'
      );
    },

    async onChildProcessEvent(_event: ChildProcessEvent, _ctx: PluginContext): Promise<void> {
      // Agent exec supervision is rejected during config validation because
      // its child identity is not the detached Payara DAS identity.
    },

    async healthCheck(ctx: PluginContext): Promise<PluginHealthStatus> {
      if (startupReconciliationState !== 'complete') {
        const status = buildErrorHealthStatus(
          config,
          startupReconciliationError
            ?? `Payara startup reconciliation is ${startupReconciliationState}`
        );
        return {
          ...status,
          details: {
            ...status.details,
            startupReconciliation: startupReconciliationState,
            ...(startupReconciliationError
              ? { startupReconciliationError }
              : {}),
          },
        };
      }

      // Agent /health and /ready are intentionally public probes. This cached,
      // single-flight readback is observational: it never acquires the deploy
      // lock, synchronizes the runtime epoch, or promotes readiness.
      return getPublicHealthSnapshot(ctx);
    },
  };
}

// Re-export only the supported factory and read-only utilities. PayaraManager,
// WarDeployer, and registerRoutes are deliberately internal: exposing any part
// of that construction path lets callers assemble lifecycle mutations outside
// the plugin's cross-process deployment fence.
export { calculateDiff, calculateWarHashes, getWarEntry } from './war-deployer.js';
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
  payaraGet,
  payaraPost,
  payaraPostWithStatus,
  loadCliMutationAuthToken,
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
  BootDeploymentOwnership,
  BootDeploymentPhase,
  BootDeploymentReadiness,
  BootDeploymentStatus,
  BootStartupReceipt,
  BootReadinessAttestation,
  BootRecoveryAuthorization,
  BootRecoveryResult,
  PostStartDeploymentPolicy,
  PostStartDeploymentResult,
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
