// Path: test/plugin.test.ts
// Tests for Payara plugin factory

import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import createPayaraPlugin from '../src/index.js';
import { PayaraManager } from '../src/payara-manager.js';
import { WarDeployer } from '../src/war-deployer.js';
import type { PayaraPluginConfig } from '../src/types.js';
import type {
  KeyRotatedEvent,
  PluginContext,
} from '@zincapp/zn-vault-agent/plugins';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};

// Mock plugin context
const mockContext = {
  logger: mockLogger,
  config: {},
  vaultUrl: 'https://vault.example.com',
  tenantId: 'test-tenant',
  getSecret: vi.fn(),
  restartChild: vi.fn(),
  emit: vi.fn(),
  on: vi.fn(),
};

// Valid plugin config
const validConfig: PayaraPluginConfig = {
  payaraHome: '/opt/payara',
  domain: 'domain1',
  user: 'payara',
  warPath: '/opt/app/Test.war',
  appName: 'TestApp',
  healthEndpoint: 'http://localhost:8080/health',
};

let mutationTokenDirectory: string;
let previousControlTokenFile: string | undefined;
const TEST_MUTATION_AUTH_TOKEN = 'test-only-mutation-token-'.repeat(2);

function noOutageFence() {
  return {
    outageFenced: false,
    preparedStopped: false,
    running: true,
    processCount: 1,
  } as const;
}

beforeAll(async () => {
  mutationTokenDirectory = await mkdtemp(join(tmpdir(), 'payara-mutation-auth-'));
  const tokenPath = join(mutationTokenDirectory, 'token');
  await writeFile(tokenPath, `${TEST_MUTATION_AUTH_TOKEN}\n`, { mode: 0o600 });
  previousControlTokenFile = process.env.ZNVAULT_CONTROL_TOKEN_FILE;
  process.env.ZNVAULT_CONTROL_TOKEN_FILE = tokenPath;
  validConfig.mutationAuthTokenFile = tokenPath;
});

afterAll(async () => {
  if (previousControlTokenFile === undefined) {
    delete process.env.ZNVAULT_CONTROL_TOKEN_FILE;
  } else {
    process.env.ZNVAULT_CONTROL_TOKEN_FILE = previousControlTokenFile;
  }
  await rm(mutationTokenDirectory, { recursive: true, force: true });
});

describe('createPayaraPlugin', () => {
  it('should create a plugin with correct metadata', () => {
    const plugin = createPayaraPlugin(validConfig);

    expect(plugin.name).toBe('payara');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/); // Valid semver
    expect(plugin.description).toContain('Payara');
  });

  it('should have all required lifecycle methods', () => {
    const plugin = createPayaraPlugin(validConfig);

    expect(plugin.onInit).toBeDefined();
    expect(plugin.onStart).toBeDefined();
    expect(plugin.onStop).toBeDefined();
    expect(plugin.routes).toBeDefined();
    expect(plugin.healthCheck).toBeDefined();
    expect(plugin.onCertificateDeployed).toBeDefined();
    expect(plugin.onChildProcessEvent).toBeDefined();
  });

  describe('onInit', () => {
    it('should throw if payaraHome is missing', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        payaraHome: '',
      } as PayaraPluginConfig);

      await expect(plugin.onInit?.(mockContext as any)).rejects.toThrow('payaraHome is required');
    });

    it('should throw if domain is missing', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        domain: '',
      } as PayaraPluginConfig);

      await expect(plugin.onInit?.(mockContext as any)).rejects.toThrow('domain is required');
    });

    it('should throw if user is missing', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        user: '',
      } as PayaraPluginConfig);

      await expect(plugin.onInit?.(mockContext as any)).rejects.toThrow('user is required');
    });

    it('should throw if warPath is missing', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        warPath: '',
      } as PayaraPluginConfig);

      await expect(plugin.onInit?.(mockContext as any)).rejects.toThrow('warPath is required');
    });

    it('should throw if appName is missing', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        appName: '',
      } as PayaraPluginConfig);

      await expect(plugin.onInit?.(mockContext as any)).rejects.toThrow('appName is required');
    });

    it('should initialize successfully with valid config', async () => {
      const plugin = createPayaraPlugin(validConfig);

      await expect(plugin.onInit?.(mockContext as any)).resolves.not.toThrow();
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('does not fetch or materialize secrets before the startup lock', async () => {
      const getSecret = vi.fn();
      const context = {
        ...mockContext,
        getSecret,
      };
      const plugin = createPayaraPlugin({
        ...validConfig,
        secrets: { DATABASE_PASSWORD: 'alias:example/database-password' },
      });

      await expect(plugin.onInit?.(context as unknown as PluginContext))
        .resolves.toBeUndefined();
      expect(getSecret).not.toHaveBeenCalled();
    });

    it('should reject exec lifecycle mode until the agent exposes DAS-bound events', async () => {
      const plugin = createPayaraPlugin({ ...validConfig, manageLifecycle: false });
      await expect(plugin.onInit?.(mockContext as unknown as PluginContext))
        .rejects.toThrow('manageLifecycle=false is unsupported');
    });

    it('should reject a competing agent exec that starts the same domain', async () => {
      const plugin = createPayaraPlugin(validConfig);
      const competingContext = {
        ...mockContext,
        config: {
          exec: {
            command: ['/opt/payara/bin/asadmin', 'start-domain', 'domain1'],
            secrets: [],
          },
        },
      };
      await expect(plugin.onInit?.(competingContext as unknown as PluginContext))
        .rejects.toThrow('agent exec must be disabled');
    });

    it.each([
      ['/usr/local/bin/start-payara-wrapper'],
      ['/usr/bin/systemctl', 'start', 'unrelated-worker'],
    ])('should reject every non-empty agent exec command: %j', async (...command) => {
      const plugin = createPayaraPlugin(validConfig);
      const competingContext = {
        ...mockContext,
        config: { exec: { command } },
      };

      await expect(plugin.onInit?.(competingContext as unknown as PluginContext))
        .rejects.toThrow('agent exec must be disabled');
    });

    it.each([
      [{ globalReloadCmd: '/usr/bin/systemctl restart payara' }],
      [{ targets: [{ reloadCmd: '/usr/local/bin/reload-payara' }] }],
      [{ secretTargets: [{ reloadCmd: '/usr/bin/systemctl restart payara' }] }],
    ])('should reject every agent reload command outside the deployment lock: %j', async extraConfig => {
      const plugin = createPayaraPlugin(validConfig);
      const competingContext = {
        ...mockContext,
        config: extraConfig,
      };

      await expect(plugin.onInit?.(competingContext as unknown as PluginContext))
        .rejects.toThrow('reloadCmd must all be disabled');
    });

    it('should reject certificate-triggered lifecycle restarts', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        restartOnCertChange: true,
      });

      await expect(plugin.onInit?.(mockContext as unknown as PluginContext))
        .rejects.toThrow('restartOnCertChange=true is unsupported');
    });

    it('should reject key-rotation lifecycle restarts', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        restartOnKeyRotation: true,
      });

      await expect(plugin.onInit?.(mockContext as unknown as PluginContext))
        .rejects.toThrow('restartOnKeyRotation=true is unsupported');
    });

    it('should reject watched-secret event mutation', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        watchSecrets: ['application/config'],
      });

      await expect(plugin.onInit?.(mockContext as unknown as PluginContext))
        .rejects.toThrow('watchSecrets is unsupported');
    });

    it('should require file mode for managed API key secrets', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        secrets: { ZINC_CONFIG_VAULT_API_KEY: 'api-key:managed-key' },
      });

      await expect(plugin.onInit?.(mockContext as unknown as PluginContext))
        .rejects.toThrow('apiKeyFilePath is required');
    });

    it('should reject unsafe Unix account names before constructing Payara', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        user: 'payara;touch-pwned',
      });

      await expect(plugin.onInit?.(mockContext as unknown as PluginContext))
        .rejects.toThrow('valid lowercase Unix account name');
    });
  });

  describe('onStart', () => {
    it.each([
      {
        receiptPhase: 'stopped' as const,
        preparedStopped: true,
        running: false,
        processCount: 0,
        schedulerDeploymentHold: true,
      },
      {
        receiptPhase: 'releasing' as const,
        preparedStopped: false,
        running: true,
        processCount: 1,
        schedulerDeploymentHold: false,
      },
    ])(
      'rehydrates secrets in memory after a fenced $receiptPhase restart without rewriting setenv.conf',
      async outageRuntime => {
        const payaraHome = await mkdtemp(join(tmpdir(), 'payara-fenced-restart-'));
        const configDirectory = join(
          payaraHome,
          'glassfish',
          'domains',
          validConfig.domain,
          'config',
        );
        const setenvPath = join(configDirectory, 'setenv.conf');
        const persistedSetenv = "export DATABASE_PASSWORD='persisted-before-restart'\n";
        await mkdir(configDirectory, { recursive: true });
        await writeFile(setenvPath, persistedSetenv);
        const preparedStop = vi.spyOn(WarDeployer.prototype, 'getPreparedStopStatus')
          .mockResolvedValue({
            outageFenced: true,
            ...outageRuntime,
            receiptId: '11111111-1111-4111-8111-111111111111',
            outageOwnerId: '22222222-2222-4222-8222-222222222222',
            targetContentSha256: 'a'.repeat(64),
            artifact: {
              size: 1,
              sha256: 'b'.repeat(64),
              contentSha256: 'c'.repeat(64),
            },
            ...(outageRuntime.receiptPhase === 'releasing'
              ? {
                  deployedArtifact: {
                    size: 1,
                    sha256: 'd'.repeat(64),
                    contentSha256: 'a'.repeat(64),
                  },
                  applicationDeployed: true,
                }
              : {}),
          });
        const startupLock = vi.spyOn(WarDeployer.prototype, 'withDeploymentLock');
        const startPayara = vi.spyOn(PayaraManager.prototype, 'start');
        const setEnvironment = vi.spyOn(PayaraManager.prototype, 'setEnvironment');
        const updateEnvironment = vi.spyOn(PayaraManager.prototype, 'updateEnvironment');
        const getSecret = vi.fn().mockResolvedValue({
          data: { value: 'preserved-after-agent-restart' },
        });
        const context = {
          ...mockContext,
          getSecret,
        } as unknown as PluginContext;
        const plugin = createPayaraPlugin({
          ...validConfig,
          payaraHome,
          secrets: { DATABASE_PASSWORD: 'alias:database-password' },
        });

        try {
          await plugin.onInit?.(context);
          await expect(plugin.onStart?.(context))
            .resolves.toBeUndefined();

          expect(preparedStop).toHaveBeenCalledOnce();
          expect(getSecret).toHaveBeenCalledOnce();
          expect(getSecret).toHaveBeenCalledWith('alias:database-password');
          expect(startupLock).not.toHaveBeenCalled();
          expect(startPayara).not.toHaveBeenCalled();
          expect(setEnvironment).toHaveBeenCalledWith({
            DATABASE_PASSWORD: 'preserved-after-agent-restart',
          });
          expect(updateEnvironment).not.toHaveBeenCalled();
          expect(await readFile(setenvPath, 'utf8')).toBe(persistedSetenv);
        } finally {
          preparedStop.mockRestore();
          startupLock.mockRestore();
          startPayara.mockRestore();
          setEnvironment.mockRestore();
          updateEnvironment.mockRestore();
          await rm(payaraHome, { recursive: true, force: true });
        }
      },
    );

    it('keeps only explicit outage recovery routes reachable after an orphaned hold on startup', async () => {
      const preparedStop = vi.spyOn(WarDeployer.prototype, 'getPreparedStopStatus')
        .mockRejectedValue(new Error(
          'SCHEDULER_DEPLOYMENT_HOLD_ORPHANED: boot hold exists without its mutation receipt',
        ));
      const recover = vi.spyOn(WarDeployer.prototype, 'recoverOutageFence')
        .mockResolvedValue({ recovered: true });
      const plugin = createPayaraPlugin(validConfig);
      const fastify = Fastify({ logger: false });

      try {
        await plugin.onInit?.(mockContext as unknown as PluginContext);
        await expect(plugin.onStart?.(mockContext as unknown as PluginContext))
          .resolves.toBeUndefined();
        await fastify.register(async scoped => {
          await plugin.routes?.(scoped, mockContext as unknown as PluginContext);
        }, { prefix: '/plugins/payara' });
        await fastify.ready();

        const blocked = await fastify.inject({
          method: 'GET',
          url: '/plugins/payara/status',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
        });
        expect(blocked.statusCode).toBe(503);
        expect(blocked.json()).toMatchObject({
          error: 'STARTUP_RECONCILIATION_NOT_COMPLETE',
          startupReconciliation: 'recovery_only',
        });

        const recovered = await fastify.inject({
          method: 'POST',
          url: '/plugins/payara/stop-for-deployment/recover',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
          payload: {
            outageOwnerId: '22222222-2222-4222-8222-222222222222',
            reason: 'Operator verified the orphaned deployment hold.',
          },
        });
        expect(recovered.statusCode, recovered.body).toBe(200);
        expect(recover).toHaveBeenCalledOnce();

        const stillBlocked = await fastify.inject({
          method: 'GET',
          url: '/plugins/payara/status',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
        });
        expect(stillBlocked.statusCode).toBe(503);
      } finally {
        await fastify.close();
        preparedStop.mockRestore();
        recover.mockRestore();
      }
    });

    it('keeps a stale exact outage lock in recovery-only mode while exposing its re-entrant stop rail', async () => {
      const outageOwnerId = '22222222-2222-4222-8222-222222222222';
      const targetContentSha256 = 'a'.repeat(64);
      const outageCapability = Buffer.alloc(32, 7).toString('base64url');
      const artifact = {
        size: 1,
        sha256: 'b'.repeat(64),
        contentSha256: 'c'.repeat(64),
      };
      const preparedStop = vi.spyOn(WarDeployer.prototype, 'getPreparedStopStatus')
        .mockResolvedValue({
          outageFenced: true,
          preparedStopped: false,
          running: true,
          processCount: 1,
          receiptPhase: 'arming',
          receiptId: '11111111-1111-4111-8111-111111111111',
          outageOwnerId,
          targetContentSha256,
          capabilityBound: true,
          schedulerDeploymentHold: false,
          artifact,
          currentArtifact: artifact,
          mutationLockStale: true,
          mutationLockOwnerKind: 'payara-outage',
        });
      const stopForDeployment = vi.spyOn(WarDeployer.prototype, 'stopForDeployment')
        .mockResolvedValue({
          outageFenced: true,
          preparedStopped: true,
          running: false,
          processCount: 0,
          receiptPhase: 'stopped',
          receiptId: '11111111-1111-4111-8111-111111111111',
          outageOwnerId,
          targetContentSha256,
          artifact,
        });
      const plugin = createPayaraPlugin(validConfig);
      const fastify = Fastify({ logger: false });

      try {
        await plugin.onInit?.(mockContext as unknown as PluginContext);
        await expect(plugin.onStart?.(mockContext as unknown as PluginContext))
          .resolves.toBeUndefined();
        await plugin.routes?.(fastify, mockContext as unknown as PluginContext);
        await fastify.ready();

        const normalRoute = await fastify.inject({
          method: 'GET',
          url: '/status',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
        });
        expect(normalRoute.statusCode).toBe(503);
        expect(normalRoute.json()).toMatchObject({
          startupReconciliation: 'recovery_only',
        });

        const recoveryStatus = await fastify.inject({
          method: 'GET',
          url: '/stop-for-deployment/status',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
        });
        expect(recoveryStatus.statusCode, recoveryStatus.body).toBe(200);
        expect(recoveryStatus.json()).toMatchObject({
          outageFenced: true,
          receiptPhase: 'arming',
          mutationLockStale: true,
        });

        const resumedStop = await fastify.inject({
          method: 'POST',
          url: '/stop-for-deployment',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
          payload: { outageOwnerId, targetContentSha256, outageCapability },
        });
        expect(resumedStop.statusCode, resumedStop.body).toBe(200);
        expect(stopForDeployment).toHaveBeenCalledWith(
          outageOwnerId,
          targetContentSha256,
          outageCapability,
        );
      } finally {
        await fastify.close();
        preparedStop.mockRestore();
        stopForDeployment.mockRestore();
      }
    });

    it('closes the recovery-only deploy rail after explicit recovery clears the outage fence', async () => {
      const outageOwnerId = '22222222-2222-4222-8222-222222222222';
      const targetContentSha256 = 'a'.repeat(64);
      const outageCapability = Buffer.alloc(32, 9).toString('base64url');
      const artifact = { size: 1, sha256: 'b'.repeat(64), contentSha256: 'c'.repeat(64) };
      let recovered = false;
      const preparedStop = vi.spyOn(WarDeployer.prototype, 'getPreparedStopStatus')
        .mockImplementation(async () => recovered ? noOutageFence() : {
          outageFenced: true,
          preparedStopped: false,
          running: true,
          processCount: 1,
          receiptPhase: 'arming',
          receiptId: '11111111-1111-4111-8111-111111111111',
          outageOwnerId,
          targetContentSha256,
          capabilityBound: true,
          schedulerDeploymentHold: false,
          artifact,
          currentArtifact: artifact,
          mutationLockStale: true,
          mutationLockOwnerKind: 'payara-outage',
        });
      const recover = vi.spyOn(WarDeployer.prototype, 'recoverOutageFence')
        .mockImplementation(async () => {
          recovered = true;
          return { recovered: true };
        });
      const deployAuto = vi.spyOn(WarDeployer.prototype, 'deployAuto');
      const startPayara = vi.spyOn(PayaraManager.prototype, 'start');
      const plugin = createPayaraPlugin(validConfig);
      const fastify = Fastify({ logger: false });

      try {
        await plugin.onInit?.(mockContext as unknown as PluginContext);
        await expect(plugin.onStart?.(mockContext as unknown as PluginContext))
          .resolves.toBeUndefined();
        await plugin.routes?.(fastify, mockContext as unknown as PluginContext);
        await fastify.ready();

        const blockedWhileFenced = await fastify.inject({
          method: 'POST',
          url: '/deploy/full',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
          payload: {},
        });
        expect(blockedWhileFenced.statusCode, blockedWhileFenced.body).toBe(503);
        expect(deployAuto).not.toHaveBeenCalled();

        const recovery = await fastify.inject({
          method: 'POST',
          url: '/stop-for-deployment/recover',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
          payload: {
            outageOwnerId,
            targetContentSha256,
            outageCapability,
            reason: 'Operator reconciled the stale outage lock.',
          },
        });
        expect(recovery.statusCode, recovery.body).toBe(200);

        const blockedDeploy = await fastify.inject({
          method: 'POST',
          url: '/deploy/full',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
          payload: {},
        });
        expect(blockedDeploy.statusCode, blockedDeploy.body).toBe(503);
        expect(blockedDeploy.json()).toMatchObject({
          error: 'STARTUP_RECONCILIATION_NOT_COMPLETE',
          startupReconciliation: 'recovery_only',
        });
        expect(recover).toHaveBeenCalledOnce();
        expect(deployAuto).not.toHaveBeenCalled();
        expect(startPayara).not.toHaveBeenCalled();
      } finally {
        await fastify.close();
        preparedStop.mockRestore();
        recover.mockRestore();
        deployAuto.mockRestore();
        startPayara.mockRestore();
      }
    });

    it('does not let a temporary Vault failure deadlock a running outage release', async () => {
      const preparedStop = vi.spyOn(WarDeployer.prototype, 'getPreparedStopStatus')
        .mockResolvedValue({
          outageFenced: true,
          preparedStopped: false,
          running: true,
          processCount: 1,
          receiptPhase: 'releasing',
          receiptId: '11111111-1111-4111-8111-111111111111',
          outageOwnerId: '22222222-2222-4222-8222-222222222222',
          targetContentSha256: 'a'.repeat(64),
          artifact: { size: 1, sha256: 'b'.repeat(64), contentSha256: 'c'.repeat(64) },
          deployedArtifact: { size: 1, sha256: 'd'.repeat(64), contentSha256: 'a'.repeat(64) },
          schedulerDeploymentHold: false,
          applicationDeployed: true,
        });
      const recover = vi.spyOn(WarDeployer.prototype, 'recoverOutageFence')
        .mockResolvedValue({ recovered: true });
      const failingContext = {
        ...mockContext,
        getSecret: vi.fn().mockRejectedValue(new Error('temporary Vault outage')),
      } as unknown as PluginContext;
      const plugin = createPayaraPlugin({
        ...validConfig,
        secrets: { DATABASE_PASSWORD: 'alias:database-password' },
      });
      const fastify = Fastify({ logger: false });

      try {
        await plugin.onInit?.(failingContext);
        await expect(plugin.onStart?.(failingContext)).resolves.toBeUndefined();
        await plugin.routes?.(fastify, failingContext);
        await fastify.ready();

        const recovered = await fastify.inject({
          method: 'POST',
          url: '/stop-for-deployment/recover',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
          payload: {
            outageOwnerId: '22222222-2222-4222-8222-222222222222',
            reason: 'Operator reconciled the running outage after Vault failed.',
          },
        });
        expect(recovered.statusCode, recovered.body).toBe(200);
        expect(recover).toHaveBeenCalledOnce();
      } finally {
        await fastify.close();
        preparedStop.mockRestore();
        recover.mockRestore();
      }
    });

    it('blocks runtime mutation when an outage fence survives but Vault cannot rehydrate secrets', async () => {
      const outageOwnerId = '22222222-2222-4222-8222-222222222222';
      const targetContentSha256 = 'a'.repeat(64);
      const preparedStop = vi.spyOn(WarDeployer.prototype, 'getPreparedStopStatus')
        .mockResolvedValue({
          outageFenced: true,
          preparedStopped: true,
          running: false,
          processCount: 0,
          receiptPhase: 'stopped',
          receiptId: '11111111-1111-4111-8111-111111111111',
          outageOwnerId,
          targetContentSha256,
          artifact: { size: 1, sha256: 'b'.repeat(64), contentSha256: 'c'.repeat(64) },
        });
      const startPayara = vi.spyOn(PayaraManager.prototype, 'start');
      const updateEnvironment = vi.spyOn(PayaraManager.prototype, 'updateEnvironment');
      const deployAuto = vi.spyOn(WarDeployer.prototype, 'deployAuto');
      const failingContext = {
        ...mockContext,
        getSecret: vi.fn().mockRejectedValue(new Error('temporary Vault outage')),
      } as unknown as PluginContext;
      const plugin = createPayaraPlugin({
        ...validConfig,
        secrets: { DATABASE_PASSWORD: 'alias:database-password' },
      });
      const fastify = Fastify({ logger: false });

      try {
        await plugin.onInit?.(failingContext);
        await expect(plugin.onStart?.(failingContext)).resolves.toBeUndefined();
        await fastify.register(async scoped => {
          await plugin.routes?.(scoped, failingContext);
        }, { prefix: '/plugins/payara' });
        await fastify.ready();

        const status = await fastify.inject({
          method: 'GET',
          url: '/plugins/payara/stop-for-deployment/status',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
        });
        expect(status.statusCode, status.body).toBe(200);

        const blockedDeploy = await fastify.inject({
          method: 'POST',
          url: '/plugins/payara/deploy/full',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
          payload: {},
        });
        expect(blockedDeploy.statusCode, blockedDeploy.body).toBe(503);
        expect(blockedDeploy.json()).toMatchObject({
          error: 'STARTUP_RECONCILIATION_NOT_COMPLETE',
          startupReconciliation: 'recovery_only',
        });
        expect(startPayara).not.toHaveBeenCalled();
        expect(updateEnvironment).not.toHaveBeenCalled();
        expect(deployAuto).not.toHaveBeenCalled();
      } finally {
        await fastify.close();
        preparedStop.mockRestore();
        startPayara.mockRestore();
        updateEnvironment.mockRestore();
        deployAuto.mockRestore();
      }
    });

    it('does not settle until startup reconciliation releases the file lock', async () => {
      let release!: () => void;
      const pending = new Promise<void>(resolve => {
        release = resolve;
      });
      const startupLock = vi.spyOn(WarDeployer.prototype, 'withDeploymentLock')
        .mockImplementation(async () => pending);
      const preparedStop = vi.spyOn(WarDeployer.prototype, 'getPreparedStopStatus')
        .mockResolvedValue(noOutageFence());
      const plugin = createPayaraPlugin(validConfig);

      try {
        await plugin.onInit?.(mockContext as unknown as PluginContext);
        let settled = false;
        const start = plugin.onStart?.(mockContext as unknown as PluginContext)
          .then(() => {
            settled = true;
          });
        await vi.waitFor(() => expect(startupLock).toHaveBeenCalled());
        expect(settled).toBe(false);
        expect(startupLock).toHaveBeenCalledWith(
          'plugin-startup:TestApp',
          'start',
          expect.any(Function)
        );
        release();
        await expect(start).resolves.toBeUndefined();
        expect(settled).toBe(true);
      } finally {
        release();
        startupLock.mockRestore();
        preparedStop.mockRestore();
      }
    });

    it('fences health readbacks before and during startup without interfering with startup', async () => {
      let release!: () => void;
      const pending = new Promise<void>(resolve => {
        release = resolve;
      });
      const startupLock = vi.spyOn(WarDeployer.prototype, 'withDeploymentLock')
        .mockImplementation(async () => pending);
      const preparedStop = vi.spyOn(WarDeployer.prototype, 'getPreparedStopStatus')
        .mockResolvedValue(noOutageFence());
      const fileLock = vi.spyOn(WarDeployer.prototype, 'withDeploymentFileLock');
      const getStatus = vi.spyOn(PayaraManager.prototype, 'getStatus');
      const plugin = createPayaraPlugin(validConfig);

      try {
        await plugin.onInit?.(mockContext as unknown as PluginContext);

        const before = await plugin.healthCheck?.(mockContext as unknown as PluginContext);
        expect(before?.status).toBe('unhealthy');
        expect(before?.details?.startupReconciliation).toBe('not_started');
        expect(fileLock).not.toHaveBeenCalled();
        expect(getStatus).not.toHaveBeenCalled();

        const start = plugin.onStart?.(mockContext as unknown as PluginContext);
        await vi.waitFor(() => expect(startupLock).toHaveBeenCalled());

        const during = await plugin.healthCheck?.(mockContext as unknown as PluginContext);
        expect(during?.status).toBe('unhealthy');
        expect(during?.details?.startupReconciliation).toBe('in_progress');
        expect(fileLock).not.toHaveBeenCalled();
        expect(getStatus).not.toHaveBeenCalled();

        release();
        await expect(start).resolves.toBeUndefined();
      } finally {
        release();
        startupLock.mockRestore();
        preparedStop.mockRestore();
        fileLock.mockRestore();
        getStatus.mockRestore();
      }
    });

    it('fences every HTTP route until startup reconciliation completes', async () => {
      const getStatus = vi.spyOn(PayaraManager.prototype, 'getStatus');
      const plugin = createPayaraPlugin(validConfig);
      const fastify = Fastify({ logger: false });

      try {
        await plugin.onInit?.(mockContext as unknown as PluginContext);
        await plugin.routes?.(fastify, mockContext as unknown as PluginContext);
        await fastify.ready();

        const response = await fastify.inject({
          method: 'GET',
          url: '/status',
          headers: { authorization: `Bearer ${TEST_MUTATION_AUTH_TOKEN}` },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
          error: 'STARTUP_RECONCILIATION_NOT_COMPLETE',
          startupReconciliation: 'not_started',
        });
        expect(getStatus).not.toHaveBeenCalled();
      } finally {
        await fastify.close();
        getStatus.mockRestore();
      }
    });

    it('reports failed startup without attempting health readbacks', async () => {
      const failure = new Error('startup exploded');
      const startupLock = vi.spyOn(WarDeployer.prototype, 'withDeploymentLock')
        .mockRejectedValue(failure);
      const preparedStop = vi.spyOn(WarDeployer.prototype, 'getPreparedStopStatus')
        .mockResolvedValue(noOutageFence());
      const fileLock = vi.spyOn(WarDeployer.prototype, 'withDeploymentFileLock');
      const plugin = createPayaraPlugin(validConfig);

      try {
        await plugin.onInit?.(mockContext as unknown as PluginContext);
        await expect(plugin.onStart?.(mockContext as unknown as PluginContext))
          .rejects.toThrow('startup exploded');

        const status = await plugin.healthCheck?.(mockContext as unknown as PluginContext);
        expect(status?.status).toBe('unhealthy');
        expect(status?.details).toMatchObject({
          startupReconciliation: 'failed',
          startupReconciliationError: 'startup exploded',
        });
        expect(fileLock).not.toHaveBeenCalled();
      } finally {
        startupLock.mockRestore();
        preparedStop.mockRestore();
        fileLock.mockRestore();
      }
    });
  });

  describe('onChildProcessEvent', () => {
    it('should ignore global exec events when this plugin manages Payara', async () => {
      const fence = vi.spyOn(PayaraManager.prototype, 'fenceExternalRuntimeChange');
      const plugin = createPayaraPlugin(validConfig);

      try {
        await plugin.onInit?.(mockContext as unknown as PluginContext);
        await plugin.onChildProcessEvent?.(
          { type: 'restarting', reason: 'unrelated exec child restart' },
          mockContext as unknown as PluginContext
        );
        expect(fence).not.toHaveBeenCalled();
      } finally {
        fence.mockRestore();
      }
    });

  });

  describe('onKeyRotated', () => {
    it('updates standalone apiKeyFilePath only for its configured managed key', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'payara-key-standalone-'));
      const keyPath = join(directory, 'api-key.txt');
      const plugin = createPayaraPlugin({
        ...validConfig,
        user: userInfo().username,
        apiKeyFilePath: keyPath,
      });
      const context = {
        ...mockContext,
        config: {
          auth: { apiKey: 'standalone-rotated-key' },
          managedKey: { name: 'managed-key' },
        },
      } as unknown as PluginContext;

      try {
        await plugin.onInit?.(context);
        await plugin.onKeyRotated?.({
          keyName: 'unrelated-key',
          newPrefix: 'unrelated...',
          rotationMode: 'scheduled',
        }, context);
        await expect(readFile(keyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

        await plugin.onKeyRotated?.({
          keyName: 'managed-key',
          newPrefix: 'standalone...',
          rotationMode: 'scheduled',
        }, context);

        expect(await readFile(keyPath, 'utf8')).toBe('standalone-rotated-key');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('only replaces the managed key file and never restarts Payara', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'payara-key-event-'));
      const keyPath = join(directory, 'api-key.txt');
      const deploymentLock = vi.spyOn(WarDeployer.prototype, 'withDeploymentLock');
      const updateEnvironment = vi.spyOn(PayaraManager.prototype, 'updateEnvironment')
        .mockResolvedValue();
      const restart = vi.spyOn(PayaraManager.prototype, 'restart').mockResolvedValue();
      const aggressiveRestart = vi.spyOn(PayaraManager.prototype, 'aggressiveRestart')
        .mockResolvedValue();
      const plugin = createPayaraPlugin({
        ...validConfig,
        user: userInfo().username,
        secrets: { ZINC_CONFIG_VAULT_API_KEY: 'api-key:managed-key' },
        apiKeyFilePath: keyPath,
      });
      const context = {
        ...mockContext,
        config: {
          auth: { apiKey: 'rotated-managed-key' },
          managedKey: { name: 'managed-key' },
        },
      };
      const event: KeyRotatedEvent = {
        keyName: 'managed-key',
        newPrefix: 'rotated...',
        rotationMode: 'scheduled',
      };

      try {
        await plugin.onInit?.(context as unknown as PluginContext);
        await plugin.onKeyRotated?.(event, context as unknown as PluginContext);

        expect(await readFile(keyPath, 'utf8')).toBe('rotated-managed-key');
        expect(deploymentLock).not.toHaveBeenCalled();
        expect(updateEnvironment).not.toHaveBeenCalled();
        expect(restart).not.toHaveBeenCalled();
        expect(aggressiveRestart).not.toHaveBeenCalled();
      } finally {
        deploymentLock.mockRestore();
        updateEnvironment.mockRestore();
        restart.mockRestore();
        aggressiveRestart.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('coalesces concurrent rotations independently of a busy deployment lock', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'payara-key-generation-'));
      const keyPath = join(directory, 'api-key.txt');
      const deploymentLock = vi.spyOn(WarDeployer.prototype, 'withDeploymentLock')
        .mockRejectedValue(new Error('deployment remains busy beyond retry horizon'));
      const plugin = createPayaraPlugin({
        ...validConfig,
        user: userInfo().username,
        secrets: { ZINC_CONFIG_VAULT_API_KEY: 'api-key:managed-key' },
        apiKeyFilePath: keyPath,
      });
      const contextFor = (apiKey: string) => ({
        ...mockContext,
        config: {
          auth: { apiKey },
          managedKey: { name: 'managed-key' },
        },
      }) as unknown as PluginContext;
      const firstContext = contextFor('first-generation');
      const secondContext = contextFor('second-generation');

      try {
        await plugin.onInit?.(firstContext);
        const first = plugin.onKeyRotated?.({
          keyName: 'managed-key',
          newPrefix: 'first...',
          rotationMode: 'scheduled',
        }, firstContext);
        const second = plugin.onKeyRotated?.({
          keyName: 'managed-key',
          newPrefix: 'second...',
          rotationMode: 'scheduled',
        }, secondContext);
        await Promise.all([first, second]);

        expect(await readFile(keyPath, 'utf8')).toBe('second-generation');
        expect(deploymentLock).not.toHaveBeenCalled();
      } finally {
        deploymentLock.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

  describe('healthCheck', () => {
    it('single-flights and caches a read-only health snapshot without reconciliation', async () => {
      const startupLock = vi.spyOn(WarDeployer.prototype, 'withDeploymentLock')
        .mockResolvedValue(undefined);
      const preparedStop = vi.spyOn(WarDeployer.prototype, 'getPreparedStopStatus')
        .mockResolvedValue(noOutageFence());
      const fileLock = vi.spyOn(WarDeployer.prototype, 'withDeploymentFileLock');
      const readBootStatus = vi.spyOn(PayaraManager.prototype, 'readBootDeploymentStatus');
      const getBootStatus = vi.spyOn(PayaraManager.prototype, 'getBootDeploymentStatus')
        .mockReturnValue({
          appName: 'TestApp',
          bootEpoch: 'snapshot-epoch',
          phase: 'ready',
          readiness: 'health-verified',
          owner: 'payara',
          runtimeListed: true,
          mutationOutcomeUnknown: false,
          startupActive: false,
          startedAt: new Date(0).toISOString(),
        });
      const getStatus = vi.spyOn(PayaraManager.prototype, 'getStatus')
        .mockResolvedValue({
          domain: 'domain1',
          running: true,
          healthy: true,
          processCount: 1,
          processPids: [1234],
        });
      const isAppDeployed = vi.spyOn(WarDeployer.prototype, 'isAppDeployed')
        .mockResolvedValue(true);
      const plugin = createPayaraPlugin(validConfig);

      try {
        await plugin.onInit?.(mockContext as unknown as PluginContext);
        await plugin.onStart?.(mockContext as unknown as PluginContext);

        const statuses = await Promise.all(
          Array.from({ length: 20 }, () => plugin.healthCheck?.(
            mockContext as unknown as PluginContext
          ))
        );
        const cached = await plugin.healthCheck?.(
          mockContext as unknown as PluginContext
        );

        expect(statuses.every(status => status?.status === 'healthy')).toBe(true);
        expect(cached?.details?.bootDeployment).toMatchObject({
          bootEpoch: 'snapshot-epoch',
          phase: 'ready',
        });
        expect(getStatus).toHaveBeenCalledOnce();
        expect(getStatus).toHaveBeenCalledWith();
        expect(isAppDeployed).toHaveBeenCalledOnce();
        expect(getBootStatus).toHaveBeenCalledOnce();
        expect(getBootStatus).toHaveBeenCalledWith('TestApp');
        expect(fileLock).not.toHaveBeenCalled();
        expect(readBootStatus).not.toHaveBeenCalled();
      } finally {
        startupLock.mockRestore();
        preparedStop.mockRestore();
        fileLock.mockRestore();
        readBootStatus.mockRestore();
        getBootStatus.mockRestore();
        getStatus.mockRestore();
        isAppDeployed.mockRestore();
      }
    });

    it('should return unhealthy status on error', async () => {
      const plugin = createPayaraPlugin(validConfig);
      await plugin.onInit?.(mockContext as any);

      // Health check will fail because we're not actually running Payara
      const status = await plugin.healthCheck?.(mockContext as any);

      expect(status?.name).toBe('payara');
      expect(status?.status).toBe('unhealthy');
      expect(status?.details).toBeDefined();
      expect(status?.details?.domain).toBe('domain1');
    });
  });
});

describe('Plugin exports', () => {
  it('should keep PayaraManager internal so callers cannot bypass the file lock', async () => {
    const entrypoint = await import('../src/index.js');
    expect('PayaraManager' in entrypoint).toBe(false);
  });

  it('should keep the mutation construction path internal', async () => {
    const entrypoint = await import('../src/index.js');
    expect('WarDeployer' in entrypoint).toBe(false);
    expect('registerRoutes' in entrypoint).toBe(false);
  });

  it('should export calculateDiff', async () => {
    const { calculateDiff } = await import('../src/index.js');
    expect(calculateDiff).toBeDefined();
    expect(typeof calculateDiff).toBe('function');
  });

  it('should export createPayaraCLIPlugin', async () => {
    const { createPayaraCLIPlugin } = await import('../src/index.js');
    expect(createPayaraCLIPlugin).toBeDefined();
    expect(typeof createPayaraCLIPlugin).toBe('function');
  });
});
