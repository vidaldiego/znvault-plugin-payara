// Path: test/war-deployer-aggressive.test.ts
// Unit test for deployAuto() aggressive-mode call ordering.
//
// Regression guard for the boot-auto-deploy race: in aggressive mode, start-domain
// auto-deploys the app registered in domain.xml, so the redeploy must wait for that
// boot deploy to settle BEFORE running undeploy/deploy --force. This test pins the
// order safeStart -> waitForBootDeploySettled -> deploy.

import { describe, it, expect, vi } from 'vitest';
import { WarDeployer } from '../src/war-deployer.js';
import type { PayaraManager } from '../src/payara-manager.js';
import pino from 'pino';

describe('WarDeployer.deployAuto (aggressive mode)', () => {
  const logger = pino({ level: 'silent' });

  /**
   * Build a mocked PayaraManager that records the order in which its
   * lifecycle methods are invoked.
   */
  function makeMockPayara(calls: string[]): PayaraManager {
    const record = (name: string) =>
      vi.fn(async () => {
        calls.push(name);
      });

    const mock = {
      aggressiveStop: record('aggressiveStop'),
      safeStart: record('safeStart'),
      waitForBootDeploySettled: vi.fn(async (_appName: string) => {
        calls.push('waitForBootDeploySettled');
      }),
      deploy: vi.fn(async () => {
        calls.push('deploy');
      }),
      listApplications: vi.fn(async () => {
        calls.push('listApplications');
        return ['TestApp'];
      }),
    };

    return mock as unknown as PayaraManager;
  }

  it('WD-AGG-01: waits for boot auto-deploy to settle between safeStart and deploy', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);

    const deployer = new WarDeployer({
      warPath: '/tmp/does-not-matter.war',
      appName: 'TestApp',
      payara,
      logger,
      aggressiveMode: true,
    });

    const result = await deployer.deployAuto();

    expect(result.deployed).toBe(true);
    expect(result.aggressiveMode).toBe(true);

    // waitForBootDeploySettled must run AFTER safeStart and BEFORE deploy.
    expect(payara.waitForBootDeploySettled).toHaveBeenCalledWith('TestApp');

    const safeStartIdx = calls.indexOf('safeStart');
    const settleIdx = calls.indexOf('waitForBootDeploySettled');
    const deployIdx = calls.indexOf('deploy');

    expect(safeStartIdx).toBeGreaterThanOrEqual(0);
    expect(settleIdx).toBeGreaterThan(safeStartIdx);
    expect(deployIdx).toBeGreaterThan(settleIdx);
  });

  it('WD-AGG-02: full aggressive order is stop -> start -> settle -> deploy', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);

    const deployer = new WarDeployer({
      warPath: '/tmp/does-not-matter.war',
      appName: 'TestApp',
      payara,
      logger,
      aggressiveMode: true,
    });

    await deployer.deployAuto();

    // The lifecycle methods must appear in this relative order.
    const order = calls.filter(c =>
      ['aggressiveStop', 'safeStart', 'waitForBootDeploySettled', 'deploy'].includes(c)
    );
    expect(order).toEqual([
      'aggressiveStop',
      'safeStart',
      'waitForBootDeploySettled',
      'deploy',
    ]);
  });
});

describe('WarDeployer.deployWithFullRestart (aggressive diff path)', () => {
  const logger = pino({ level: 'silent' });

  /**
   * Mocked PayaraManager for the diff path. Same call-order-recording harness
   * as the deployAuto tests, but also records the diff-path-only methods
   * (undeploy) so we can assert their relative position.
   */
  function makeMockPayara(calls: string[]): PayaraManager {
    const record = (name: string) =>
      vi.fn(async () => {
        calls.push(name);
      });

    const mock = {
      undeploy: record('undeploy'),
      aggressiveStop: record('aggressiveStop'),
      safeStart: record('safeStart'),
      waitForBootDeploySettled: vi.fn(async (_appName: string) => {
        calls.push('waitForBootDeploySettled');
      }),
      deploy: vi.fn(async () => {
        calls.push('deploy');
      }),
      listApplications: vi.fn(async () => {
        // Reports the app as already deployed so STEP 2 actually undeploys,
        // and as deployed again so STEP 7 verification passes.
        return ['TestApp'];
      }),
    };

    return mock as unknown as PayaraManager;
  }

  /**
   * Build a WarDeployer in aggressive mode with its filesystem-touching
   * collaborators (file lock, journal) and the real WAR-update step stubbed
   * out, so deployWithFullRestart runs purely through its lifecycle calls.
   */
  function makeDeployer(payara: PayaraManager): WarDeployer {
    const deployer = new WarDeployer({
      warPath: '/tmp/does-not-matter.war',
      appName: 'TestApp',
      payara,
      logger,
      aggressiveMode: true,
    });

    // Stub the DeploymentLock (writes to /var/lib/...) and DeploymentJournal so
    // the method doesn't touch the real filesystem lock/journal paths.
    const noop = vi.fn(async () => {});
    (deployer as unknown as { fileLock: unknown }).fileLock = {
      acquire: noop,
      updateStep: noop,
      release: noop,
    };
    (deployer as unknown as { journal: unknown }).journal = {
      start: noop,
      updateStep: noop,
      complete: noop,
    };

    // Stub the WAR-repackaging step (STEP 1) so no real WAR file is required.
    (deployer as unknown as { applyChangesWithoutDeploy: unknown }).applyChangesWithoutDeploy =
      vi.fn(async () => {});

    return deployer;
  }

  it('WD-AGG-03: waits for boot auto-deploy to settle between safeStart and deploy', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);
    const deployer = makeDeployer(payara);

    const result = await deployer.deployWithFullRestart(
      [{ path: 'index.html', content: Buffer.from('hi') }],
      []
    );

    expect(result.success).toBe(true);
    expect(result.deployed).toBe(true);

    expect(payara.waitForBootDeploySettled).toHaveBeenCalledWith('TestApp');

    const safeStartIdx = calls.indexOf('safeStart');
    const settleIdx = calls.indexOf('waitForBootDeploySettled');
    const deployIdx = calls.indexOf('deploy');

    expect(safeStartIdx).toBeGreaterThanOrEqual(0);
    expect(settleIdx).toBeGreaterThan(safeStartIdx);
    expect(deployIdx).toBeGreaterThan(settleIdx);
  });

  it('WD-AGG-04: full diff-path order is undeploy -> stop -> start -> settle -> deploy', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);
    const deployer = makeDeployer(payara);

    await deployer.deployWithFullRestart(
      [{ path: 'index.html', content: Buffer.from('hi') }],
      []
    );

    // The lifecycle methods must appear in this relative order. The settle-wait
    // must run after the undeploy/aggressiveStop/safeStart steps and before deploy.
    const order = calls.filter(c =>
      ['undeploy', 'aggressiveStop', 'safeStart', 'waitForBootDeploySettled', 'deploy'].includes(c)
    );
    expect(order).toEqual([
      'undeploy',
      'aggressiveStop',
      'safeStart',
      'waitForBootDeploySettled',
      'deploy',
    ]);
  });
});
