import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { PayaraManager } from '../src/payara-manager.js';
import {
  handleAggressiveModeStartup,
  handleNormalModeStartup,
} from '../src/plugin-startup.js';
import { WarDeployer } from '../src/war-deployer.js';

const logger = pino({ level: 'silent' });

describe('first-deployment readiness', () => {
  it('starts the domain for deployment without waiting on application health', async () => {
    const manager = new PayaraManager({
      payaraHome: '/tmp/payara',
      domain: 'zincapi',
      user: process.env.USER ?? 'test',
      healthEndpoint: 'http://127.0.0.1:1/service-status',
      operationTimeout: 135000,
      runtimeIdentityProvider: async () => 1000,
      logger,
    });
    const internals = manager as unknown as {
      writeSetenvConfInternal: () => Promise<void>;
      asadminCommand: (args: string[]) => Promise<string>;
      getPayaraProcessPidsStrict: () => Promise<number[]>;
      monotonicNowMs: () => number;
      waitForHealthy: (timeoutMs: number) => Promise<void>;
      waitForRunning: (timeoutMs: number) => Promise<void>;
    };

    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    vi.spyOn(internals, 'writeSetenvConfInternal').mockResolvedValue();
    vi.spyOn(internals, 'getPayaraProcessPidsStrict').mockResolvedValue([]);
    vi.spyOn(internals, 'monotonicNowMs').mockReturnValue(1000);
    vi.spyOn(internals, 'asadminCommand').mockImplementation(async args =>
      args[0] === 'list-domains' ? 'zincapi not running\n' : 'started'
    );
    const health = vi.spyOn(internals, 'waitForHealthy').mockResolvedValue();
    const running = vi.spyOn(internals, 'waitForRunning').mockResolvedValue();

    await manager.start({ waitForApplicationHealth: false });

    expect(running).toHaveBeenCalledWith(135000);
    expect(health).not.toHaveBeenCalled();
  });

  it('uses the configured lifecycle timeout while waiting for application health', async () => {
    const manager = new PayaraManager({
      payaraHome: '/tmp/payara',
      domain: 'zincapi',
      user: process.env.USER ?? 'test',
      healthEndpoint: 'http://127.0.0.1:1/service-status',
      operationTimeout: 145000,
      runtimeIdentityProvider: async () => 1000,
      logger,
    });
    const internals = manager as unknown as {
      writeSetenvConfInternal: () => Promise<void>;
      asadminCommand: (args: string[]) => Promise<string>;
      getPayaraProcessPidsStrict: () => Promise<number[]>;
      monotonicNowMs: () => number;
      waitForHealthy: (timeoutMs: number) => Promise<void>;
      waitForRunning: (timeoutMs: number) => Promise<void>;
    };

    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    vi.spyOn(internals, 'writeSetenvConfInternal').mockResolvedValue();
    vi.spyOn(internals, 'getPayaraProcessPidsStrict').mockResolvedValue([]);
    vi.spyOn(internals, 'monotonicNowMs').mockReturnValue(1000);
    vi.spyOn(internals, 'asadminCommand').mockImplementation(async args =>
      args[0] === 'list-domains' ? 'zincapi not running\n' : 'started'
    );
    const health = vi.spyOn(internals, 'waitForHealthy').mockResolvedValue();
    vi.spyOn(internals, 'waitForRunning').mockResolvedValue();

    await manager.start();

    expect(health).toHaveBeenCalledWith(145000);
  });

  it('converts a dispatched start command timeout into lifecycle UNKNOWN', async () => {
    const manager = new PayaraManager({
      payaraHome: '/tmp/payara',
      domain: 'zincapi',
      user: process.env.USER ?? 'test',
      operationTimeout: 145000,
      runtimeIdentityProvider: async () => undefined,
      logger,
    });
    const internals = manager as unknown as {
      writeSetenvConfInternal: () => Promise<void>;
      asadminCommand: (args: string[]) => Promise<string>;
      getPayaraProcessPidsStrict: () => Promise<number[]>;
      monotonicNowMs: () => number;
    };
    const commandTimeout = Object.assign(
      new Error('COMMAND_TIMEOUT: start-domain exceeded its deadline'),
      { name: 'COMMAND_TIMEOUT', code: 'ETIMEDOUT' }
    );

    vi.spyOn(internals, 'writeSetenvConfInternal').mockResolvedValue();
    vi.spyOn(internals, 'getPayaraProcessPidsStrict').mockResolvedValue([]);
    vi.spyOn(internals, 'monotonicNowMs').mockReturnValue(1000);
    vi.spyOn(internals, 'asadminCommand').mockImplementation(async args => {
      if (args[0] === 'list-domains') return 'zincapi not running\n';
      throw commandTimeout;
    });

    await expect(manager.start({ waitForApplicationHealth: false }))
      .rejects.toMatchObject({
        name: 'BOOT_LIFECYCLE_OUTCOME_UNKNOWN',
        cause: commandTimeout,
      });
  });

  it('uses domain readiness when WarDeployer starts an empty domain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'payara-first-deploy-'));
    const warPath = join(dir, 'zincapi.war');
    writeFileSync(warPath, 'war');
    const payara = {
      registerApplication: vi.fn(),
      withMutationLease: vi.fn(
        async (_label: string, operation: () => Promise<unknown>) => operation()
      ),
      reconcileDurableMutationQuarantine: vi.fn(async () => undefined),
      isRunning: vi.fn(async () => false),
      start: vi.fn(async () => undefined),
      reconcilePostStartDeployment: vi.fn(async () => ({
        outcome: 'agent-deployed' as const,
        bootEpoch: 'test-epoch',
        deploymentAttempted: true as const,
        deployed: true,
        applications: ['zincapi'],
      })),
    } as unknown as PayaraManager;

    try {
      const deployer = new WarDeployer({
        warPath,
        appName: 'zincapi',
        payara,
        logger,
        deploymentLockPath: join(dir, 'deploy.lock'),
      });

      await expect(deployer.deploy()).resolves.toMatchObject({ deployed: true });
      expect(payara.start).toHaveBeenCalledWith({ waitForApplicationHealth: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains an implicit cold-start quarantine with lock step=start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'payara-implicit-start-quarantine-'));
    const warPath = join(dir, 'zincapi.war');
    const lockPath = join(dir, 'deploy.lock');
    writeFileSync(warPath, 'war');
    const commandTimeout = Object.assign(
      new Error('COMMAND_TIMEOUT: start-domain exceeded its deadline'),
      { name: 'COMMAND_TIMEOUT', code: 'ETIMEDOUT' }
    );
    const startError = Object.assign(new Error('start response lost'), {
      cause: commandTimeout,
    });
    startError.name = 'BOOT_LIFECYCLE_OUTCOME_UNKNOWN';
    const payara = {
      registerApplication: vi.fn(),
      withMutationLease: vi.fn(
        async (_label: string, operation: () => Promise<unknown>) => operation()
      ),
      reconcileDurableMutationQuarantine: vi.fn(async () => undefined),
      isRunning: vi.fn(async () => false),
      start: vi.fn(async () => {
        throw startError;
      }),
    } as unknown as PayaraManager;

    try {
      const deployer = new WarDeployer({
        warPath,
        appName: 'zincapi',
        payara,
        logger,
        deploymentLockPath: lockPath,
      });

      await expect(deployer.deploy()).rejects.toThrow('start response lost');
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
        step: 'start',
        quarantined: true,
        errorName: 'BOOT_LIFECYCLE_OUTCOME_UNKNOWN',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normal plugin startup observes ownership and never deploys the WAR', async () => {
    const payara = {
      isRunningStrict: vi.fn(async () => false),
      start: vi.fn(async () => undefined),
    } as unknown as PayaraManager;
    const deployer = {
      observeStartupOwnership: vi.fn(async () => undefined),
    } as unknown as WarDeployer;

    await handleNormalModeStartup({ payara, deployer, logger, postStartDelay: 0 });

    expect(payara.start).toHaveBeenCalledWith({
      waitForApplicationHealth: false,
      timeoutMs: 35000,
    });
    expect(deployer.observeStartupOwnership).toHaveBeenCalledOnce();
  });

  it('aggressive plugin startup is observation-only for the application', async () => {
    const payara = {
      isRunningStrict: vi.fn(async () => false),
      start: vi.fn(async () => undefined),
    } as unknown as PayaraManager;
    const deployer = {
      observeStartupOwnership: vi.fn(async () => undefined),
    } as unknown as WarDeployer;

    await handleAggressiveModeStartup({ payara, deployer, logger, postStartDelay: 0 });

    expect(payara.start).toHaveBeenCalledWith({
      waitForApplicationHealth: false,
      timeoutMs: 35000,
    });
    expect(deployer.observeStartupOwnership).toHaveBeenCalledOnce();
  });

  it('prepares an aggressive restart without undeploying an already stopped domain', async () => {
    const manager = new PayaraManager({
      payaraHome: '/tmp/payara',
      domain: 'zincapi',
      user: process.env.USER ?? 'test',
      runtimeIdentityProvider: async () => undefined,
      mutationQuarantinePath: false,
      logger,
    });
    const internals = manager as unknown as {
      isRunningStrict: () => Promise<boolean>;
      getPayaraProcessPidsStrict: () => Promise<number[]>;
      undeployIfPresentStrictUnlocked: (appName: string) => Promise<boolean>;
    };
    vi.spyOn(internals, 'isRunningStrict').mockResolvedValue(false);
    vi.spyOn(internals, 'getPayaraProcessPidsStrict').mockResolvedValue([]);
    const undeploy = vi.spyOn(internals, 'undeployIfPresentStrictUnlocked');

    await expect(manager.prepareAggressiveRestart('zincapi')).resolves.toBe(false);
    expect(undeploy).not.toHaveBeenCalled();
  });

  it('refuses start-domain when an external DAS appears during setenv replacement', async () => {
    const manager = new PayaraManager({
      payaraHome: '/tmp/payara',
      domain: 'zincapi',
      user: process.env.USER ?? 'test',
      runtimeIdentityProvider: async () => undefined,
      mutationQuarantinePath: false,
      logger,
    });
    const internals = manager as unknown as {
      isRunningStrict: () => Promise<boolean>;
      getPayaraProcessPidsStrict: () => Promise<number[]>;
      writeSetenvConfInternal: () => Promise<void>;
      asadminCommand: (args: string[], timeoutMs?: number) => Promise<string>;
    };
    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    vi.spyOn(internals, 'isRunningStrict')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.spyOn(internals, 'getPayaraProcessPidsStrict').mockResolvedValue([]);
    vi.spyOn(internals, 'writeSetenvConfInternal').mockResolvedValue();
    const command = vi.spyOn(internals, 'asadminCommand').mockResolvedValue('started');

    await expect(manager.start({ waitForApplicationHealth: false }))
      .rejects.toThrow('BOOT_STOPPED_RECOVERY_UNSAFE');
    expect(command.mock.calls.some(([args]) => args[0] === 'start-domain')).toBe(false);
  });

  it('aggressive startup with no local WAR never restarts a running DAS on app 503', async () => {
    const payara = {
      isRunningStrict: vi.fn(async () => true),
      isHealthy: vi.fn(async () => false),
      safeStart: vi.fn(async () => undefined),
    } as unknown as PayaraManager;
    const deployer = {
      warExists: vi.fn(async () => false),
      observeStartupOwnership: vi.fn(async () => ({
        appName: 'zincapi',
        bootEpoch: 'no-war-payara-owned',
        phase: 'ready' as const,
        readiness: 'health-verified' as const,
        owner: 'payara' as const,
        runtimeListed: true,
        mutationOutcomeUnknown: false,
        startupActive: false,
        startedAt: '2026-08-31T00:00:00.000Z',
      })),
    } as unknown as WarDeployer;

    await handleAggressiveModeStartup({ payara, deployer, logger, postStartDelay: 0 });

    expect(payara.isRunningStrict).toHaveBeenCalledOnce();
    expect(payara.isHealthy).not.toHaveBeenCalled();
    expect(payara.safeStart).not.toHaveBeenCalled();
    expect(deployer.observeStartupOwnership).toHaveBeenCalledOnce();
  });
});
