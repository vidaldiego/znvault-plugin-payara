// Path: test/integration/payara-manager.test.ts
// PayaraManager integration tests with mock Payara

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { PayaraManager } from '../../src/payara-manager.js';
import { createMockPayara, MockPayara } from '../helpers/mock-payara.js';
import { createTestWar, createTempDir, cleanupTempDir } from '../helpers/war-utils.js';
import pino from 'pino';

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
      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        logger,
      });

      const running = await manager.isRunning();
      expect(running).toBe(false);
    });

    it('PM-02: should return true when domain is running', async () => {
      mockPayara.simulateStart();

      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        logger,
      });

      const running = await manager.isRunning();
      expect(running).toBe(true);
    });
  });

  describe('Health Checking', () => {
    it('PM-03: should report healthy when health endpoint responds with 200', async () => {
      const healthPort = await mockPayara.startHealthServer();
      mockPayara.simulateStart();

      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        healthEndpoint: `http://localhost:${healthPort}/health`,
        logger,
      });

      const healthy = await manager.isHealthy();
      expect(healthy).toBe(true);
    });

    it('PM-04: should report unhealthy when domain is stopped', async () => {
      const healthPort = await mockPayara.startHealthServer();
      // Don't start domain - health endpoint returns 503

      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        healthEndpoint: `http://localhost:${healthPort}/health`,
        logger,
      });

      const healthy = await manager.isHealthy();
      expect(healthy).toBe(false);
    });

    it('PM-05: should report unhealthy when health endpoint unreachable', async () => {
      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        healthEndpoint: 'http://localhost:59999/health',
        healthCheckTimeout: 1000,
        logger,
      });

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
      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        logger,
      });

      // stop()'s guard checks isRunning() once (true → proceed to stop), then
      // the post-stop wait sees the admin port already down (false).
      const isRunningSpy = vi.spyOn(manager, 'isRunning')
        .mockResolvedValueOnce(true)      // guard: domain is running → proceed
        .mockResolvedValue(false);        // wait: admin port closed by stop-domain
      // asadmin stop-domain succeeds (no-op for the test).
      vi.spyOn(manager as unknown as { asadminCommand: () => Promise<string> }, 'asadminCommand')
        .mockResolvedValue('');

      // ...but the JVM lingers for a few polls before its heap is released.
      let pollCount = 0;
      const pidSpy = vi.spyOn(manager, 'getPayaraProcessPids').mockImplementation(async () => {
        pollCount += 1;
        return pollCount < 3 ? [4242] : []; // resident for 2 polls, then gone
      });

      await manager.stop();

      // stop() must have polled getPayaraProcessPids until it drained to empty.
      expect(pidSpy).toHaveBeenCalled();
      expect(pollCount).toBeGreaterThanOrEqual(3);
      isRunningSpy.mockRestore();
      pidSpy.mockRestore();
    });
  });

  describe('listApplications', () => {
    it('PM-09: should return array of applications', async () => {
      mockPayara.simulateStart();

      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        logger,
      });

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

      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        logger,
      });

      // Deploy should not throw with mock
      await expect(manager.deploy(warPath, 'TestApp')).resolves.not.toThrow();
    });

    it('PM-11: should call undeploy command', async () => {
      mockPayara.simulateStart();

      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        logger,
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

      const manager = new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        logger,
      });

      await expect(manager.deploy(warPath, 'TestApp')).rejects.toThrow();
    });
  });

  describe('waitForBootDeploySettled', () => {
    function makeManager(): PayaraManager {
      return new PayaraManager({
        payaraHome: mockPayara.payaraHome,
        domain: mockPayara.domain,
        user: process.env.USER || 'test',
        logger,
      });
    }

    it('PM-13: should settle once the app appears in two consecutive stable polls', async () => {
      const manager = makeManager();

      // Simulate boot auto-deploy: app not visible yet, then appears and stays.
      const listSpy = vi
        .spyOn(manager, 'listApplications')
        .mockResolvedValueOnce([]) // boot deploy still exploding the WAR
        .mockResolvedValueOnce(['ZincAPI']) // app now visible
        .mockResolvedValue(['ZincAPI']); // stable from here on

      await expect(
        manager.waitForBootDeploySettled('ZincAPI', 1000, 10)
      ).resolves.toBeUndefined();

      // Must have polled (at least: empty, app, app-again to confirm stability).
      expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('PM-14: should return (settled-empty) when no app ever appears, without hanging', async () => {
      const manager = makeManager();

      // Genuinely-empty domain (no <application-ref> registered): list stays empty.
      const listSpy = vi.spyOn(manager, 'listApplications').mockResolvedValue([]);

      // With a small timeout, the empty-grace is short, so this resolves quickly.
      await expect(
        manager.waitForBootDeploySettled('ZincAPI', 200, 10)
      ).resolves.toBeUndefined();

      expect(listSpy).toHaveBeenCalled();
    });

    it('PM-15: should time out gracefully (warn + return) when the list never stabilizes', async () => {
      const manager = makeManager();

      // Never-stable: the set keeps changing on every poll (mid-flight forever).
      let flip = false;
      const listSpy = vi.spyOn(manager, 'listApplications').mockImplementation(async () => {
        flip = !flip;
        return flip ? ['ZincAPI'] : ['ZincAPI', 'Other'];
      });

      const warnSpy = vi.spyOn(logger, 'warn');

      await expect(
        manager.waitForBootDeploySettled('ZincAPI', 100, 10)
      ).resolves.toBeUndefined();

      expect(listSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('PM-16: a transient empty-list window must not prematurely settle-empty before the app appears', async () => {
      const manager = makeManager();

      // Simulate a transient list-applications failure during boot: listApplications()
      // swallows errors and returns [] on failure. The first few polls come back empty
      // (transient), THEN the app surfaces and the list stabilizes. With pollInterval=10ms
      // the empty window (~30ms) is far shorter than the empty-grace (min(20000, 2000)=2000ms),
      // so the method must NOT return settled-empty during the transient window — it must
      // keep polling until the app is present and the list is stable.
      const listSpy = vi
        .spyOn(manager, 'listApplications')
        .mockResolvedValueOnce([]) // transient list-applications failure
        .mockResolvedValueOnce([]) // transient list-applications failure
        .mockResolvedValueOnce([]) // transient list-applications failure
        .mockResolvedValue(['ZincAPI']); // app now visible and stable from here on

      // Large enough timeout that the grace isn't hit during the transient empty window.
      await expect(
        manager.waitForBootDeploySettled('ZincAPI', 2000, 10)
      ).resolves.toBeUndefined();

      // Must have polled past the transient empties (3) plus at least two stable
      // non-empty snapshots to confirm settle WITH the app present.
      expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(5);

      // The last observed snapshot used to confirm settle must contain the app —
      // i.e. it settled settled-with-app, NOT settled-empty.
      const lastResult = await listSpy.mock.results[listSpy.mock.results.length - 1].value;
      expect(lastResult).toContain('ZincAPI');
    });
  });
});
