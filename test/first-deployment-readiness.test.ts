import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      logger,
    });
    const internals = manager as unknown as {
      writeSetenvConfInternal: () => Promise<void>;
      asadminCommand: (args: string[]) => Promise<string>;
      waitForHealthy: (timeoutMs: number) => Promise<void>;
      waitForRunning: (timeoutMs: number) => Promise<void>;
    };

    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    vi.spyOn(internals, 'writeSetenvConfInternal').mockResolvedValue();
    vi.spyOn(internals, 'asadminCommand').mockResolvedValue('started');
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
      logger,
    });
    const internals = manager as unknown as {
      writeSetenvConfInternal: () => Promise<void>;
      asadminCommand: (args: string[]) => Promise<string>;
      waitForHealthy: (timeoutMs: number) => Promise<void>;
    };

    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    vi.spyOn(internals, 'writeSetenvConfInternal').mockResolvedValue();
    vi.spyOn(internals, 'asadminCommand').mockResolvedValue('started');
    const health = vi.spyOn(internals, 'waitForHealthy').mockResolvedValue();

    await manager.start();

    expect(health).toHaveBeenCalledWith(145000);
  });

  it('uses domain readiness when WarDeployer starts an empty domain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'payara-first-deploy-'));
    const warPath = join(dir, 'zincapi.war');
    writeFileSync(warPath, 'war');
    const payara = {
      isRunning: vi.fn(async () => false),
      start: vi.fn(async () => undefined),
      deploy: vi.fn(async () => undefined),
      listApplications: vi.fn(async () => ['zincapi']),
    } as unknown as PayaraManager;

    try {
      const deployer = new WarDeployer({
        warPath,
        appName: 'zincapi',
        payara,
        logger,
      });

      await expect(deployer.deploy()).resolves.toMatchObject({ deployed: true });
      expect(payara.start).toHaveBeenCalledWith({ waitForApplicationHealth: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normal plugin startup does not require app health before deploying the WAR', async () => {
    const payara = {
      isHealthy: vi.fn(async () => false),
      start: vi.fn(async () => undefined),
    } as unknown as PayaraManager;
    const deployer = {
      warExists: vi.fn(async () => true),
      deploy: vi.fn(async () => ({ deployed: true, applications: ['zincapi'] })),
    } as unknown as WarDeployer;

    await handleNormalModeStartup({ payara, deployer, logger, postStartDelay: 0 });

    expect(payara.start).toHaveBeenCalledWith({ waitForApplicationHealth: false });
    expect(deployer.deploy).toHaveBeenCalledOnce();
  });

  it('aggressive plugin startup also defers app health until after deployment', async () => {
    const payara = {
      isHealthy: vi.fn(async () => false),
      ensureNoJavaRunning: vi.fn(async () => undefined),
      safeStart: vi.fn(async () => undefined),
    } as unknown as PayaraManager;
    const deployer = {
      warExists: vi.fn(async () => true),
      deploy: vi.fn(async () => ({ deployed: true, applications: ['zincapi'] })),
    } as unknown as WarDeployer;

    await handleAggressiveModeStartup({ payara, deployer, logger, postStartDelay: 0 });

    expect(payara.safeStart).toHaveBeenCalledWith({ waitForApplicationHealth: false });
    expect(deployer.deploy).toHaveBeenCalledOnce();
  });
});
