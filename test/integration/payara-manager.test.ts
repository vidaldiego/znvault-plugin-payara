// Path: test/integration/payara-manager.test.ts
// PayaraManager integration tests with mock Payara

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { PayaraManager } from '../../src/payara-manager.js';
import { createMockPayara, MockPayara } from '../helpers/mock-payara.js';
import { createTestWar, createTempDir, cleanupTempDir } from '../helpers/war-utils.js';
import pino from 'pino';

function allowShortOwnershipTiming(manager: PayaraManager): PayaraManager {
  vi.spyOn(
    manager as unknown as { minimumBootOwnershipAbsenceGraceMs: () => number },
    'minimumBootOwnershipAbsenceGraceMs'
  ).mockReturnValue(0);
  return manager;
}

describe('PayaraManager Integration', () => {
  let mockPayara: MockPayara;
  let tempDir: string;
  let logger: pino.Logger;

  beforeAll(async () => {
    logger = pino({ level: 'silent' });
  });

  beforeEach(async () => {
    tempDir = createTempDir('payara-manager-test');
    mockPayara = await createMockPayara({ baseDir: `${tempDir}/payara` });
  });

  afterEach(async () => {
    await mockPayara.cleanup();
    cleanupTempDir(tempDir);
  });

  describe('isRunning', () => {
    it('PM-01: should return false when domain is not running', async () => {
      const manager = allowShortOwnershipTiming(new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        runtimeIdentityProvider: async () => 1000,
        mutationQuarantinePath: false,
        logger,
      }));

      const running = await manager.isRunning();
      expect(running).toBe(false);
    });

    it('PM-02: should return true when domain is running', async () => {
      mockPayara.simulateStart();

      const manager = allowShortOwnershipTiming(new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        runtimeIdentityProvider: async () => 1000,
        mutationQuarantinePath: false,
        logger,
      }));

      const running = await manager.isRunning();
      expect(running).toBe(true);
    });
  });

  describe('Health Checking', () => {
    it('PM-03: should report healthy when health endpoint responds with 200', async () => {
      const healthPort = await mockPayara.startHealthServer();
      mockPayara.simulateStart();

      const manager = allowShortOwnershipTiming(new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        healthEndpoint: `http://localhost:${healthPort}/health`,
        logger,
      }));

      const healthy = await manager.isHealthy();
      expect(healthy).toBe(true);
    });

    it('PM-04: should report unhealthy when domain is stopped', async () => {
      const healthPort = await mockPayara.startHealthServer();
      // Don't start domain - health endpoint returns 503

      const manager = allowShortOwnershipTiming(new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        healthEndpoint: `http://localhost:${healthPort}/health`,
        logger,
      }));

      const healthy = await manager.isHealthy();
      expect(healthy).toBe(false);
    });

    it('PM-05: should report unhealthy when health endpoint unreachable', async () => {
      const manager = allowShortOwnershipTiming(new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        healthEndpoint: 'http://localhost:59999/health',
        healthCheckTimeout: 1000,
        logger,
      }));

      const healthy = await manager.isHealthy();
      expect(healthy).toBe(false);
    });

    it('PM-06: should fallback to isRunning when no health endpoint', async () => {
      mockPayara.simulateStart();

      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        // No healthEndpoint
        logger,
      });

      const healthy = await manager.isHealthy();
      expect(healthy).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('PM-07: should return complete status object', async () => {
      const healthPort = await mockPayara.startHealthServer();
      mockPayara.simulateStart();

      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        healthEndpoint: `http://localhost:${healthPort}/health`,
        logger,
      });

      const status = await manager.getStatus();

      expect(status.domain).toBe(mockPayara.domain);
      expect(status.running).toBe(true);
      expect(status.healthy).toBe(true);
    });

    it('PM-08: should report not running when stopped', async () => {
      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        logger,
      });

      const status = await manager.getStatus();

      expect(status.running).toBe(false);
      expect(status.healthy).toBe(false);
    });
  });

  describe('stop — waits for JVM process to drain (memory-overlap race)', () => {
    it('PM-08b: stop() does not return until the Payara JVM PIDs are gone, even after admin port is down', async () => {
      const manager = allowShortOwnershipTiming(new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        runtimeIdentityProvider: async () => 1000,
        mutationQuarantinePath: false,
        logger,
      }));

      // stop()'s guard checks isRunning() once (true → proceed to stop), then
      // the post-stop wait sees the admin port already down (false).
      const isRunningSpy = vi.spyOn(
        manager as unknown as { isRunningStrict: () => Promise<boolean> },
        'isRunningStrict'
      )
        .mockResolvedValueOnce(true)      // guard: domain is running → proceed
        .mockResolvedValue(false);        // wait: admin port closed by stop-domain
      // asadmin stop-domain succeeds (no-op for the test).
      vi.spyOn(
        manager as unknown as { asadminCommand: (args: string[]) => Promise<string> },
        'asadminCommand'
      ).mockImplementation(async args =>
        args[0] === 'list-domains' ? `${mockPayara.domain} not running\n` : ''
      );

      // ...but the JVM lingers for a few polls before its heap is released.
      let pollCount = 0;
      const pidSpy = vi.spyOn(
        manager as unknown as { getPayaraProcessPidsStrict: () => Promise<number[]> },
        'getPayaraProcessPidsStrict'
      ).mockImplementation(async () => {
          pollCount += 1;
          return pollCount < 3 ? [4242] : []; // resident for 2 polls, then gone
        });

      await manager.classifyBootOwnership('TestApp', {
        timeoutMs: 10,
        pollIntervalMs: 1,
        absenceGraceMs: 1,
      });

      await manager.stop();

      // stop() must use the strict PID probe until the JVM drains to empty.
      expect(pidSpy).toHaveBeenCalled();
      expect(pollCount).toBeGreaterThanOrEqual(3);
      isRunningSpy.mockRestore();
      pidSpy.mockRestore();
    });
  });

  describe('listApplications', () => {
    it('PM-09: should return array of applications', async () => {
      mockPayara.simulateStart();

      const manager = allowShortOwnershipTiming(new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        logger,
      }));

      const apps = await manager.listApplications();
      expect(Array.isArray(apps)).toBe(true);
    });
  });

  describe('asadmin commands', () => {
    it('PM-10: should call deploy command', async () => {
      mockPayara.simulateStart();

      const warPath = createTestWar({
        path: `${tempDir}/TestApp.war`,
        appName: 'TestApp',
      });

      const manager = allowShortOwnershipTiming(new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        runtimeIdentityProvider: async () => 1000,
        mutationQuarantinePath: false,
        logger,
      }));
      vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
      vi.spyOn(manager, 'listApplications').mockResolvedValue([]);

      await manager.classifyBootOwnership('TestApp', {
        timeoutMs: 10,
        pollIntervalMs: 1,
        absenceGraceMs: 1,
      });

      // Deploy should not throw with mock
      await expect(manager.deploy(warPath, 'TestApp')).resolves.not.toThrow();
    });

    it('PM-11: should call undeploy command', async () => {
      mockPayara.simulateStart();

      const manager = allowShortOwnershipTiming(new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        runtimeIdentityProvider: async () => 1000,
        mutationQuarantinePath: false,
        logger,
      }));
      vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
      vi.spyOn(manager, 'listApplications').mockResolvedValue([]);

      await manager.classifyBootOwnership('TestApp', {
        timeoutMs: 10,
        pollIntervalMs: 1,
        absenceGraceMs: 1,
      });

      // Undeploy should not throw with mock
      await expect(manager.undeploy('TestApp')).resolves.not.toThrow();
    });

    it('PM-12: should handle deploy failure', async () => {
      mockPayara.setFailure('deploy', true);
      mockPayara.simulateStart();

      const warPath = createTestWar({
        path: `${tempDir}/TestApp.war`,
        appName: 'TestApp',
      });

      const manager = allowShortOwnershipTiming(new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        runtimeIdentityProvider: async () => 1000,
        mutationQuarantinePath: false,
        logger,
      }));
      vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
      vi.spyOn(manager, 'listApplications').mockResolvedValue([]);

      await manager.classifyBootOwnership('TestApp', {
        timeoutMs: 10,
        pollIntervalMs: 1,
        absenceGraceMs: 1,
      });

      await expect(manager.deploy(warPath, 'TestApp')).rejects.toThrow();
    });
  });

  describe('strict application inventory and boot ownership', () => {
    function makeManager(): PayaraManager {
      return allowShortOwnershipTiming(new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        runtimeIdentityProvider: async () => 1000,
        mutationQuarantinePath: false,
        logger,
      }));
    }

    function getInternals(manager: PayaraManager): {
      asadminCommand: (args: string[], timeoutMs?: number) => Promise<string>;
    } {
      return manager as unknown as {
        asadminCommand: (args: string[], timeoutMs?: number) => Promise<string>;
      };
    }

    it('PM-13: parses terse application rows without accepting the success footer', async () => {
      const manager = makeManager();
      const command = vi.spyOn(getInternals(manager), 'asadminCommand').mockResolvedValue(
        'ZincAPI  <ejb, health, metrics, openapi, webservices, web>\n'
      );

      await expect(manager.listApplications()).resolves.toEqual(['ZincAPI']);
      expect(command).toHaveBeenCalledWith(['--terse=true', 'list-applications'], 10000);
    });

    it('PM-14: propagates list-applications command failure instead of inventing []', async () => {
      const manager = makeManager();
      vi.spyOn(getInternals(manager), 'asadminCommand').mockRejectedValue(
        new Error('asadmin unavailable')
      );

      await expect(manager.listApplications()).rejects.toThrow('asadmin unavailable');
    });

    it('PM-15: rejects unparseable list-applications diagnostics', async () => {
      const manager = makeManager();
      vi.spyOn(getInternals(manager), 'asadminCommand').mockResolvedValue(
        'Cannot contact the admin listener\n'
      );

      await expect(manager.listApplications()).rejects.toThrow('BOOT_INVENTORY_UNPARSEABLE');
    });

    it('PM-16: parses persistent server application references strictly', async () => {
      const manager = makeManager();
      const command = vi.spyOn(getInternals(manager), 'asadminCommand').mockResolvedValue(
        'ZincAPI\n'
      );

      await expect(manager.listApplicationRefs()).resolves.toEqual(['ZincAPI']);
      expect(command).toHaveBeenCalledWith(
        ['--terse=true', 'list-application-refs', 'server'],
        10000
      );
    });

    it('PM-17: classifies a persistent target ref as Payara-owned before runtime visibility', async () => {
      const manager = makeManager();
      vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
      vi.spyOn(manager, 'listApplications').mockResolvedValue([]);

      const ownership = await manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 50,
        pollIntervalMs: 5,
        absenceGraceMs: 20,
      });

      expect(ownership).toMatchObject({
        owner: 'payara',
        runtimeListed: false,
        readiness: 'unverified',
      });
      expect(ownership.bootEpoch).toBe(manager.getBootDeploymentStatus('ZincAPI').bootEpoch);
    });

    it('PM-18: rejects runtime presence without a persistent target ref', async () => {
      const manager = makeManager();
      vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
      vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);

      await expect(manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 50,
        pollIntervalMs: 5,
        absenceGraceMs: 20,
      })).rejects.toThrow('BOOT_STATE_CONTRADICTORY');
    });

    it('PM-19: grants agent ownership only after continuous successful absence', async () => {
      const manager = makeManager();
      const refs = vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
      const apps = vi.spyOn(manager, 'listApplications').mockResolvedValue([]);

      const ownership = await manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 100,
        pollIntervalMs: 5,
        absenceGraceMs: 20,
      });

      expect(ownership).toMatchObject({
        owner: 'agent',
        runtimeListed: false,
        readiness: 'not_applicable',
      });
      expect(ownership.bootEpoch).toBe(manager.getBootDeploymentStatus('ZincAPI').bootEpoch);

      expect(refs.mock.calls.length).toBeGreaterThan(1);
      expect(apps.mock.calls.length).toBeGreaterThan(1);
    });

    it('PM-20: sustained inventory errors fail closed instead of counting as absence', async () => {
      const manager = makeManager();
      vi.spyOn(manager, 'listApplicationRefs').mockRejectedValue(new Error('transient failure'));
      const apps = vi.spyOn(manager, 'listApplications');

      await expect(manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 25,
        pollIntervalMs: 5,
        absenceGraceMs: 10,
      })).rejects.toThrow('BOOT_OWNERSHIP_UNKNOWN');

      expect(apps).not.toHaveBeenCalled();
    });

    it('PM-21: the legacy settle helper rejects a Payara-owned target', async () => {
      const manager = makeManager();
      vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
      vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);

      await expect(
        manager.waitForBootDeploySettled('ZincAPI', 20_000, 5)
      ).rejects.toThrow('BOOT_OWNER_CONFLICT');
    });

    it('PM-22: deployFresh aborts before mutation if a target ref already exists', async () => {
      const manager = makeManager();
      vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
      vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
      const command = vi.spyOn(getInternals(manager), 'asadminCommand');

      await expect(
        manager.deployFresh('/tmp/ZincAPI.war', 'ZincAPI')
      ).rejects.toThrow('BOOT_READINESS_ATTESTATION_REQUIRED');

      expect(command).not.toHaveBeenCalled();
    });

    it('PM-23: strict pre-restart undeploy propagates failure', async () => {
      const manager = makeManager();
      mockPayara.setFailure('undeploy', true);
      vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
      vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);

      await expect(manager.undeployIfPresentStrict('ZincAPI')).rejects.toThrow();
    });

    it('PM-24: an intermediate inventory error restarts the continuous-absence window', async () => {
      const manager = makeManager();
      let clockMs = 1000;
      const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
      const sleep = vi.spyOn(
        manager as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep'
      ).mockImplementation(async ms => {
        clockMs += ms;
      });
      const monotonic = vi.spyOn(
        manager as unknown as { monotonicNowMs: () => number },
        'monotonicNowMs'
      ).mockImplementation(() => Date.now());
      const refs = vi.spyOn(manager, 'listApplicationRefs')
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('one transient read failure'))
        .mockResolvedValue([]);
      const apps = vi.spyOn(manager, 'listApplications').mockResolvedValue([]);

      try {
        const ownership = await manager.classifyBootOwnership('ZincAPI', {
          timeoutMs: 70,
          pollIntervalMs: 10,
          absenceGraceMs: 20,
        });

        expect(ownership.owner).toBe('agent');
        // The first 20 ms do not count: the failed third read resets the proof.
        expect(clockMs).toBeGreaterThanOrEqual(1050);
        expect(refs).toHaveBeenCalledTimes(6);
        expect(apps).toHaveBeenCalledTimes(5);
      } finally {
        sleep.mockRestore();
        monotonic.mockRestore();
        dateNow.mockRestore();
      }
    });

    it('PM-25: strict undeploy fails when either postcondition still reports the target', async () => {
      const manager = makeManager();
      vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
      vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
      const ownership = await manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 1,
      });
      await manager.attestBootReady('ZincAPI', {
        bootEpoch: ownership.bootEpoch,
        reason: 'Test establishes a stable precondition before undeploy',
        source: 'PM-25',
      });
      const command = vi.spyOn(getInternals(manager), 'asadminCommand').mockResolvedValue('');

      await expect(manager.undeployIfPresentStrict('ZincAPI'))
        .rejects.toThrow('UNDEPLOY_NOT_CONFIRMED');

      expect(command).toHaveBeenCalledWith(['undeploy', 'ZincAPI']);
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        phase: 'blocked',
        readiness: 'unverified',
        evidenceSource: 'agent-undeploy-outcome-unknown',
      });
    });

    it('PM-26: an application mutation invalidates a cached pre-deploy health result', async () => {
      const manager = makeManager();
      const managerInternals = manager as unknown as {
        isRunningStrict: () => Promise<boolean>;
        withDurableApplicationMutation: <T>(
          appName: string,
          expectedBootEpoch: string,
          operation: string,
          evidenceSource: string,
          mutate: () => Promise<T>
        ) => Promise<T>;
      };
      vi.spyOn(managerInternals, 'isRunningStrict').mockResolvedValue(true);
      const health = vi.spyOn(manager, 'isHealthy')
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      vi.spyOn(manager, 'getPayaraProcessPids').mockResolvedValue([5700]);

      await expect(manager.getStatus()).resolves.toMatchObject({ healthy: true });
      await managerInternals.withDurableApplicationMutation(
        'ZincAPI',
        'cache-test-epoch',
        'deploy-replace',
        'cache-test-unknown',
        async () => undefined
      );
      await expect(manager.getStatus()).resolves.toMatchObject({ healthy: false });
      expect(health).toHaveBeenCalledTimes(2);
    });
  });
});
