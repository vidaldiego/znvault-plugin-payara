import pino from 'pino';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { PayaraManager } from '../src/payara-manager.js';
import {
  handleAggressiveModeStartup,
  handleExecModeStartup,
  handleNormalModeStartup,
} from '../src/plugin-startup.js';
import type { WarDeployer } from '../src/war-deployer.js';

const logger = pino({ level: 'silent' });
describe('plugin startup deployment ownership', () => {
  it('PS-BOOT-01: aggressive cold start observes ownership without deploying', async () => {
    const calls: string[] = [];
    const payara = {
      isRunningStrict: vi.fn(async () => false),
      start: vi.fn(async () => {
        calls.push('start');
      }),
    } as unknown as PayaraManager;
    const deployer = {
      observeStartupOwnership: vi.fn(async () => {
        calls.push('observeStartupOwnership');
      }),
    } as unknown as WarDeployer;

    await handleAggressiveModeStartup({ payara, deployer, logger, postStartDelay: 0 });

    expect(calls).toEqual(['start', 'observeStartupOwnership']);
    expect(payara.start).toHaveBeenCalledWith({
      waitForApplicationHealth: false,
      timeoutMs: 35000,
    });
    expect(deployer.observeStartupOwnership).toHaveBeenCalledOnce();
  });

  it('PS-BOOT-02: aggressive hot recovery uses the same ownership fence', async () => {
    const payara = {
      isRunningStrict: vi.fn(async () => true),
    } as unknown as PayaraManager;
    const deployer = {
      observeStartupOwnership: vi.fn(async () => undefined),
    } as unknown as WarDeployer;

    await handleAggressiveModeStartup({ payara, deployer, logger, postStartDelay: 0 });

    expect(deployer.observeStartupOwnership).toHaveBeenCalledOnce();
  });

  it('PS-BOOT-03: ownership failure aborts startup without a fallback deploy', async () => {
    const payara = {
      isRunningStrict: vi.fn(async () => false),
      start: vi.fn(async () => undefined),
    } as unknown as PayaraManager;
    const deployer = {
      observeStartupOwnership: vi.fn(async () => {
        throw new Error('BOOT_OWNERSHIP_UNKNOWN');
      }),
    } as unknown as WarDeployer;

    await expect(
      handleAggressiveModeStartup({ payara, deployer, logger, postStartDelay: 0 })
    ).rejects.toThrow('BOOT_OWNERSHIP_UNKNOWN');
    expect(deployer.observeStartupOwnership).toHaveBeenCalledOnce();
  });

  it('PS-BOOT-04: normal startup uses skip-if-boot-owned reconciliation', async () => {
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

  it('PS-BOOT-05: exec lifecycle fails closed before any runtime action', async () => {
    await expect(handleExecModeStartup({
      payara: {} as PayaraManager,
      deployer: {} as WarDeployer,
      logger,
      postStartDelay: 0,
    })).rejects.toThrow('EXEC_LIFECYCLE_UNSUPPORTED');
  });

  it('PS-BOOT-06: UNKNOWN no-WAR runtime state aborts without start or cleanup', async () => {
    const payara = {
      isRunningStrict: vi.fn(async () => {
        throw new Error('PAYARA_RUNNING_PROBE_UNKNOWN');
      }),
      start: vi.fn(async () => undefined),
      safeStart: vi.fn(async () => undefined),
      killPayaraProcesses: vi.fn(async () => undefined),
    } as unknown as PayaraManager;
    const deployer = {
      observeStartupOwnership: vi.fn(async () => undefined),
    } as unknown as WarDeployer;

    await expect(
      handleAggressiveModeStartup({ payara, deployer, logger, postStartDelay: 0 })
    ).rejects.toThrow('PAYARA_RUNNING_PROBE_UNKNOWN');

    expect(payara.start).not.toHaveBeenCalled();
    expect(payara.safeStart).not.toHaveBeenCalled();
    expect(payara.killPayaraProcesses).not.toHaveBeenCalled();
    expect(deployer.observeStartupOwnership).not.toHaveBeenCalled();
  });

  it('PS-BOOT-07: a stopped no-WAR startup is non-destructive even in aggressive mode', async () => {
    const calls: string[] = [];
    const payara = {
      isRunningStrict: vi.fn(async () => false),
      start: vi.fn(async () => {
        calls.push('start');
      }),
      safeStart: vi.fn(async () => {
        calls.push('safeStart');
      }),
      killPayaraProcesses: vi.fn(async () => {
        calls.push('kill');
      }),
    } as unknown as PayaraManager;
    const deployer = {
      observeStartupOwnership: vi.fn(async () => {
        calls.push('observe');
      }),
    } as unknown as WarDeployer;

    await handleAggressiveModeStartup({ payara, deployer, logger, postStartDelay: 0 });

    expect(calls).toEqual(['start', 'observe']);
    expect(payara.start).toHaveBeenCalledWith({
      waitForApplicationHealth: false,
      timeoutMs: 35000,
    });
    expect(payara.safeStart).not.toHaveBeenCalled();
    expect(payara.killPayaraProcesses).not.toHaveBeenCalled();
  });

  it('PS-BOOT-08: insufficient terminal budget dispatches no start-domain', async () => {
    const payara = {
      isRunningStrict: vi.fn(async () => false),
      start: vi.fn(async () => undefined),
    } as unknown as PayaraManager;
    const deployer = {
      observeStartupOwnership: vi.fn(async () => undefined),
    } as unknown as WarDeployer;

    await expect(handleNormalModeStartup({
      payara,
      deployer,
      logger,
      deadlineMs: performance.now() + 34_000,
    })).rejects.toThrow('PLUGIN_STARTUP_DEADLINE_EXCEEDED');

    expect(payara.start).not.toHaveBeenCalled();
    expect(deployer.observeStartupOwnership).not.toHaveBeenCalled();
  });
});
