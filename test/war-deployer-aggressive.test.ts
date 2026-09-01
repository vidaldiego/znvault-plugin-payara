// Path: test/war-deployer-aggressive.test.ts
// Unit test for deployAuto() aggressive-mode call ordering.
//
// Regression guard for the boot-auto-deploy race: aggressive deployment must
// remove the persistent ref before stop, then prove agent ownership before a
// fresh deploy. Payara and the agent must never write the same app concurrently.

import { describe, it, expect, vi } from 'vitest';
import { WarDeployer } from '../src/war-deployer.js';
import type { PayaraManager } from '../src/payara-manager.js';
import pino from 'pino';

describe('WarDeployer.deployAuto (aggressive mode)', () => {
  const logger = pino({ level: 'silent' });

  function stubFileLock(deployer: WarDeployer): void {
    const noop = vi.fn(async () => {});
    (deployer as unknown as { fileLock: unknown }).fileLock = {
      acquire: noop,
      updateStep: noop,
      release: noop,
      getCurrentStep: vi.fn(() => 'deploy'),
      quarantine: noop,
    };
  }

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
      withMutationLease: vi.fn(
        async (_label: string, operation: () => Promise<unknown>) => operation()
      ),
      reconcileDurableMutationQuarantine: vi.fn(async () => undefined),
      prepareAggressiveRestart: vi.fn(async () => {
        calls.push('prepareAggressiveRestart');
        return true;
      }),
      aggressiveStop: record('aggressiveStop'),
      safeStart: record('safeStart'),
      reconcilePostStartDeployment: vi.fn(async () => {
        calls.push('reconcilePostStartDeployment');
        return {
          outcome: 'agent-deployed' as const,
          bootEpoch: 'boot-epoch-aggressive',
          deploymentAttempted: true as const,
          deployed: true,
          applications: ['TestApp'],
        };
      }),
    };

    return mock as unknown as PayaraManager;
  }

  it('WD-AGG-01: proves agent ownership between safeStart and fresh deploy', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);

    const deployer = new WarDeployer({
      warPath: '/tmp/does-not-matter.war',
      appName: 'TestApp',
      payara,
      logger,
      aggressiveMode: true,
    });
    stubFileLock(deployer);
    vi.spyOn(deployer, 'warExists').mockResolvedValue(true);

    const result = await deployer.deployAuto();

    expect(result.deployed).toBe(true);
    expect(result.aggressiveMode).toBe(true);

    const safeStartIdx = calls.indexOf('safeStart');
    const reconcileIdx = calls.indexOf('reconcilePostStartDeployment');

    expect(safeStartIdx).toBeGreaterThanOrEqual(0);
    expect(reconcileIdx).toBeGreaterThan(safeStartIdx);
  });

  it('WD-AGG-02: full aggressive order is undeploy -> stop -> start -> own -> deploy', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);

    const deployer = new WarDeployer({
      warPath: '/tmp/does-not-matter.war',
      appName: 'TestApp',
      payara,
      logger,
      aggressiveMode: true,
    });
    stubFileLock(deployer);
    vi.spyOn(deployer, 'warExists').mockResolvedValue(true);

    await deployer.deployAuto();

    // The lifecycle methods must appear in this relative order.
    const order = calls.filter(c =>
      [
        'prepareAggressiveRestart',
        'aggressiveStop',
        'safeStart',
        'reconcilePostStartDeployment',
      ].includes(c)
    );
    expect(order).toEqual([
      'prepareAggressiveRestart',
      'aggressiveStop',
      'safeStart',
      'reconcilePostStartDeployment',
    ]);
  });

  it('WD-AGG-03: undeploy failure aborts before stop, start, or deploy', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);
    vi.mocked(payara.prepareAggressiveRestart).mockRejectedValue(new Error('undeploy failed'));
    const deployer = new WarDeployer({
      warPath: '/tmp/does-not-matter.war',
      appName: 'TestApp',
      payara,
      logger,
      aggressiveMode: true,
    });
    stubFileLock(deployer);
    vi.spyOn(deployer, 'warExists').mockResolvedValue(true);

    await expect(deployer.deployAuto()).rejects.toThrow('undeploy failed');
    expect(payara.aggressiveStop).not.toHaveBeenCalled();
    expect(payara.safeStart).not.toHaveBeenCalled();
    expect(payara.reconcilePostStartDeployment).not.toHaveBeenCalled();
  });

  it('WD-AGG-04: surviving boot ownership aborts before fresh deploy', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);
    vi.mocked(payara.reconcilePostStartDeployment).mockRejectedValue(
      new Error('BOOT_OWNER_CONFLICT: Payara owns boot epoch boot-epoch-surviving')
    );
    const deployer = new WarDeployer({
      warPath: '/tmp/does-not-matter.war',
      appName: 'TestApp',
      payara,
      logger,
      aggressiveMode: true,
    });
    stubFileLock(deployer);
    vi.spyOn(deployer, 'warExists').mockResolvedValue(true);

    await expect(deployer.deployAuto()).rejects.toThrow('BOOT_OWNER_CONFLICT');
    expect(payara.reconcilePostStartDeployment).toHaveBeenCalledWith(
      '/tmp/does-not-matter.war',
      'TestApp',
      undefined,
      'require-agent-owned'
    );
  });

  it('WD-AGG-04b: a missing WAR aborts before every lifecycle mutation', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);
    const deployer = new WarDeployer({
      warPath: '/tmp/definitely-missing-payara-test.war',
      appName: 'TestApp',
      payara,
      logger,
      aggressiveMode: true,
    });
    stubFileLock(deployer);
    vi.spyOn(deployer, 'warExists').mockResolvedValue(false);

    await expect(deployer.deployAuto()).rejects.toThrow('WAR_NOT_FOUND');
    expect(payara.prepareAggressiveRestart).not.toHaveBeenCalled();
    expect(payara.aggressiveStop).not.toHaveBeenCalled();
    expect(payara.safeStart).not.toHaveBeenCalled();
    expect(payara.reconcilePostStartDeployment).not.toHaveBeenCalled();
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
      withMutationLease: vi.fn(
        async (_label: string, operation: () => Promise<unknown>) => operation()
      ),
      reconcileDurableMutationQuarantine: vi.fn(async () => undefined),
      prepareAggressiveRestart: vi.fn(async () => {
        calls.push('prepareAggressiveRestart');
        return true;
      }),
      aggressiveStop: record('aggressiveStop'),
      safeStart: record('safeStart'),
      reconcilePostStartDeployment: vi.fn(async () => {
        calls.push('reconcilePostStartDeployment');
        return {
          outcome: 'agent-deployed' as const,
          bootEpoch: 'boot-epoch-diff',
          deploymentAttempted: true as const,
          deployed: true,
          applications: ['TestApp'],
        };
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
      getCurrentStep: vi.fn(() => 'deploy'),
      quarantine: noop,
    };
    (deployer as unknown as { journal: unknown }).journal = {
      start: noop,
      updateStep: noop,
      complete: noop,
    };

    // Stub the WAR-repackaging step (STEP 1) so no real WAR file is required.
    (deployer as unknown as { applyChangesWithoutDeploy: unknown }).applyChangesWithoutDeploy =
      vi.fn(async () => {});
    vi.spyOn(deployer, 'warExists').mockResolvedValue(true);

    return deployer;
  }

  it('WD-AGG-05: proves agent ownership between safeStart and fresh deploy', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);
    const deployer = makeDeployer(payara);

    const result = await deployer.deployWithFullRestart(
      [{ path: 'index.html', content: Buffer.from('hi') }],
      []
    );

    expect(result.success).toBe(true);
    expect(result.deployed).toBe(true);

    const safeStartIdx = calls.indexOf('safeStart');
    const reconcileIdx = calls.indexOf('reconcilePostStartDeployment');

    expect(safeStartIdx).toBeGreaterThanOrEqual(0);
    expect(reconcileIdx).toBeGreaterThan(safeStartIdx);
  });

  it('WD-AGG-06: full diff order is undeploy -> stop -> start -> own -> deploy', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);
    const deployer = makeDeployer(payara);

    await deployer.deployWithFullRestart(
      [{ path: 'index.html', content: Buffer.from('hi') }],
      []
    );

    // Ownership must be proven after start and before the fresh deployment.
    const order = calls.filter(c =>
      [
        'prepareAggressiveRestart',
        'aggressiveStop',
        'safeStart',
        'reconcilePostStartDeployment',
      ].includes(c)
    );
    expect(order).toEqual([
      'prepareAggressiveRestart',
      'aggressiveStop',
      'safeStart',
      'reconcilePostStartDeployment',
    ]);
  });

  it('WD-AGG-07: diff undeploy failure aborts before stop, start, or deploy', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);
    vi.mocked(payara.prepareAggressiveRestart).mockRejectedValue(new Error('undeploy failed'));
    const deployer = makeDeployer(payara);

    const result = await deployer.deployWithFullRestart(
      [{ path: 'index.html', content: Buffer.from('hi') }],
      []
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('undeploy failed');
    expect(payara.aggressiveStop).not.toHaveBeenCalled();
    expect(payara.safeStart).not.toHaveBeenCalled();
    expect(payara.reconcilePostStartDeployment).not.toHaveBeenCalled();
  });

  it('WD-AGG-08: WAR deletion failure aborts before every lifecycle mutation', async () => {
    const calls: string[] = [];
    const payara = makeMockPayara(calls);
    const deployer = makeDeployer(payara);
    vi.mocked(deployer.applyChangesWithoutDeploy).mockRejectedValue(
      new Error('DELETE_FAILED: stale class remains')
    );

    const result = await deployer.deployWithFullRestart([], ['WEB-INF/classes/Stale.class']);

    expect(result.success).toBe(false);
    expect(result.message).toContain('DELETE_FAILED');
    expect(payara.prepareAggressiveRestart).not.toHaveBeenCalled();
    expect(payara.aggressiveStop).not.toHaveBeenCalled();
    expect(payara.safeStart).not.toHaveBeenCalled();
    expect(payara.reconcilePostStartDeployment).not.toHaveBeenCalled();
  });
});
