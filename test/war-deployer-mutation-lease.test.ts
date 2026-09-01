import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { PayaraManager } from '../src/payara-manager.js';
import { WarDeployer } from '../src/war-deployer.js';
import {
  cleanupTempDir,
  createTempDir,
  createTestWar,
  getWarFile,
} from './helpers/war-utils.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

interface LeaseHarness {
  payara: PayaraManager;
  events: string[];
  activeLabel: () => string | undefined;
}

/**
 * Minimal re-entrant FIFO lease with the Payara methods used by WarDeployer.
 * AsyncLocalStorage is important here: a nested deploy from the current owner
 * is re-entrant, while an unrelated lifecycle request must remain queued.
 */
function createLeaseHarness(): LeaseHarness {
  const events: string[] = [];
  const context = new AsyncLocalStorage<symbol>();
  let activeToken: symbol | undefined;
  let currentLabel: string | undefined;
  let tail = Promise.resolve();

  const withMutationLease = async <T>(
    label: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    const inheritedToken = context.getStore();
    if (inheritedToken && inheritedToken === activeToken) {
      events.push(`lease-reenter:${label}`);
      return operation();
    }

    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>(done => {
      release = done;
    });
    await previous;

    const token = Symbol(label);
    activeToken = token;
    currentLabel = label;
    events.push(`lease-enter:${label}`);
    try {
      return await context.run(token, operation);
    } finally {
      events.push(`lease-exit:${label}`);
      activeToken = undefined;
      currentLabel = undefined;
      release();
    }
  };

  const payara = {
    registerApplication: vi.fn(),
    withMutationLease,
    reconcileDurableMutationQuarantine: vi.fn(async () => undefined),
    isMutationInProgress: () => currentLabel !== undefined,
    assertArtifactMutationAllowed: vi.fn(async () => 'test-boot-epoch'),
    assertArtifactMutationEpochCurrent: vi.fn(async () => undefined),
    restart: () => withMutationLease('restart-domain', async () => {
      events.push('restart-entered');
    }),
    isRunning: vi.fn(async () => true),
    deploy: vi.fn(async () => {
      events.push(`payara-deploy:${currentLabel ?? 'no-lease'}`);
    }),
    listApplications: vi.fn(async () => ['TestApp']),
  } as unknown as PayaraManager;

  return {
    payara,
    events,
    activeLabel: () => currentLabel,
  };
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('WarDeployer Payara mutation lease coverage', () => {
  const logger = pino({ level: 'silent' });

  it('WD-LEASE-01: applyChanges holds one lease across WAR read, rewrite, and deploy', async () => {
    const tempDir = createTempDir('war-deployer-lease');
    const warPath = createTestWar({
      path: `${tempDir}/TestApp.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'before' }],
    });
    const harness = createLeaseHarness();
    const deployer = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: harness.payara,
      logger,
      deploymentLockPath: `${tempDir}/deploy.lock`,
    });
    const readReached = deferred();
    const allowRead = deferred();
    vi.spyOn(deployer, 'warExists')
      .mockImplementationOnce(async () => {
        harness.events.push('war-read-reached');
        readReached.resolve();
        await allowRead.promise;
        return true;
      })
      .mockResolvedValue(true);

    try {
      const applyPromise = deployer.applyChanges(
        [{ path: 'version.txt', content: Buffer.from('after') }],
        []
      );
      await readReached.promise;

      const leaseAtRead = harness.activeLabel();
      const restartPromise = harness.payara.restart();
      await nextEventLoopTurn();
      const restartEnteredBeforeRelease = harness.events.includes('restart-entered');

      allowRead.resolve();
      const [result] = await Promise.all([applyPromise, restartPromise]);

      expect(leaseAtRead).toBeDefined();
      expect(restartEnteredBeforeRelease).toBe(false);
      expect(result.success).toBe(true);
      expect(getWarFile(warPath, 'version.txt')?.toString()).toBe('after');

      const deployIndex = harness.events.findIndex(event => event.startsWith('payara-deploy:'));
      const restartIndex = harness.events.indexOf('restart-entered');
      expect(deployIndex).toBeGreaterThan(harness.events.indexOf('war-read-reached'));
      expect(restartIndex).toBeGreaterThan(deployIndex);
      expect(harness.events[deployIndex]).toBe(`payara-deploy:${leaseAtRead}`);
    } finally {
      allowRead.resolve();
      cleanupTempDir(tempDir);
    }
  });

  it('WD-LEASE-02: public applyChangesWithoutDeploy also excludes lifecycle mutations', async () => {
    const tempDir = createTempDir('war-update-lease');
    const warPath = createTestWar({
      path: `${tempDir}/TestApp.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'before' }],
    });
    const harness = createLeaseHarness();
    const deployer = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: harness.payara,
      logger,
      deploymentLockPath: `${tempDir}/deploy.lock`,
    });
    const readReached = deferred();
    const allowRead = deferred();
    vi.spyOn(deployer, 'warExists').mockImplementationOnce(async () => {
      harness.events.push('war-read-reached');
      readReached.resolve();
      await allowRead.promise;
      return true;
    });

    try {
      const updatePromise = deployer.applyChangesWithoutDeploy(
        [{ path: 'version.txt', content: Buffer.from('after') }],
        []
      );
      await readReached.promise;

      const leaseAtRead = harness.activeLabel();
      const restartPromise = harness.payara.restart();
      await nextEventLoopTurn();
      const restartEnteredBeforeRelease = harness.events.includes('restart-entered');

      allowRead.resolve();
      await Promise.all([updatePromise, restartPromise]);

      expect(leaseAtRead).toBeDefined();
      expect(restartEnteredBeforeRelease).toBe(false);
      expect(getWarFile(warPath, 'version.txt')?.toString()).toBe('after');
      expect(harness.events.indexOf('restart-entered')).toBeGreaterThan(
        harness.events.findIndex(event => event === `lease-exit:${leaseAtRead}`)
      );
      expect(harness.payara.deploy).not.toHaveBeenCalled();
    } finally {
      allowRead.resolve();
      cleanupTempDir(tempDir);
    }
  });

  it('WD-LEASE-03: two plugin processes cannot rewrite the same WAR concurrently', async () => {
    const tempDir = createTempDir('war-deployer-cross-process-lock');
    const warPath = createTestWar({
      path: `${tempDir}/TestApp.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'before' }],
    });
    const lockPath = `${tempDir}/deploy.lock`;
    const firstHarness = createLeaseHarness();
    const secondHarness = createLeaseHarness();
    const first = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: firstHarness.payara,
      logger,
      deploymentLockPath: lockPath,
    });
    const second = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: secondHarness.payara,
      logger,
      deploymentLockPath: lockPath,
    });
    const firstReadReached = deferred();
    const allowFirstRead = deferred();
    vi.spyOn(first, 'warExists')
      .mockImplementationOnce(async () => {
        firstReadReached.resolve();
        await allowFirstRead.promise;
        return true;
      })
      .mockResolvedValue(true);

    try {
      const firstResultPromise = first.applyChanges(
        [{ path: 'version.txt', content: Buffer.from('first') }],
        []
      );
      await firstReadReached.promise;

      const secondResult = await second.applyChanges(
        [{ path: 'version.txt', content: Buffer.from('second') }],
        []
      );
      expect(secondResult).toMatchObject({
        success: false,
        message: expect.stringContaining('Deployment already in progress'),
      });
      expect(secondHarness.payara.deploy).not.toHaveBeenCalled();

      allowFirstRead.resolve();
      const firstResult = await firstResultPromise;
      expect(firstResult.success).toBe(true);
      expect(getWarFile(warPath, 'version.txt')?.toString()).toBe('first');
      expect(firstHarness.payara.deploy).toHaveBeenCalledOnce();
    } finally {
      allowFirstRead.resolve();
      cleanupTempDir(tempDir);
    }
  });

  it('WD-LEASE-04: an ambiguous lifecycle failure retains the lock even under an outer deploy step', async () => {
    const tempDir = createTempDir('war-deployer-lifecycle-quarantine');
    const warPath = createTestWar({
      path: `${tempDir}/TestApp.war`,
      appName: 'TestApp',
    });
    const lockPath = `${tempDir}/deploy.lock`;
    const first = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: createLeaseHarness().payara,
      logger,
      deploymentLockPath: lockPath,
    });
    const second = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: createLeaseHarness().payara,
      logger,
      deploymentLockPath: lockPath,
    });

    try {
      const ambiguousLifecycleError = new Error('remote start outcome unknown');
      ambiguousLifecycleError.name = 'BOOT_LIFECYCLE_OUTCOME_UNKNOWN';
      await expect(first.withDeploymentLock('deploy-triggered-start', 'deploy', async () => {
        throw ambiguousLifecycleError;
      })).rejects.toThrow('remote start outcome unknown');

      await expect(second.withDeploymentLock('second-start', 'start', async () => undefined))
        .rejects.toThrow(/Deployment already in progress|remained contended/);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('WD-LEASE-05: a generic preflight failure releases the cross-process lock', async () => {
    const tempDir = createTempDir('war-deployer-preflight-release');
    const warPath = createTestWar({
      path: `${tempDir}/TestApp.war`,
      appName: 'TestApp',
    });
    const lockPath = `${tempDir}/deploy.lock`;
    const first = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: createLeaseHarness().payara,
      logger,
      deploymentLockPath: lockPath,
    });
    const second = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: createLeaseHarness().payara,
      logger,
      deploymentLockPath: lockPath,
    });

    try {
      await expect(first.withDeploymentLock('blocked-preflight', 'start', async () => {
        const error = new Error('lifecycle preflight denied');
        error.name = 'BOOT_LIFECYCLE_FENCED';
        throw error;
      })).rejects.toThrow('lifecycle preflight denied');

      await expect(
        second.withDeploymentLock('retry-after-preflight', 'start', async () => 'acquired')
      ).resolves.toBe('acquired');
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('WD-LEASE-06: boot recovery retains one file lock and lease through its remote sequence', async () => {
    const tempDir = createTempDir('war-deployer-recovery-lease');
    const warPath = createTestWar({
      path: `${tempDir}/TestApp.war`,
      appName: 'TestApp',
    });
    const lockPath = `${tempDir}/deploy.lock`;
    const firstHarness = createLeaseHarness();
    const secondHarness = createLeaseHarness();
    const recoveryReached = deferred();
    const allowRecovery = deferred();
    Object.assign(firstHarness.payara as object, {
      recoverBootDeployment: vi.fn(async () => {
        firstHarness.events.push(
          `recovery-consume:${firstHarness.activeLabel() ?? 'no-lease'}`
        );
        recoveryReached.resolve();
        await allowRecovery.promise;
        firstHarness.events.push(
          `recovery-undeploy:${firstHarness.activeLabel() ?? 'no-lease'}`
        );
        firstHarness.events.push(
          `recovery-deploy:${firstHarness.activeLabel() ?? 'no-lease'}`
        );
        return {
          applications: ['TestApp'],
          bootDeployment: {
            appName: 'TestApp',
            bootEpoch: 'recovery-epoch',
            runtimeFingerprint: 'a'.repeat(64),
            phase: 'ready' as const,
            readiness: 'not_applicable' as const,
            owner: 'agent' as const,
            runtimeListed: true,
            mutationOutcomeUnknown: false,
            startupActive: false,
            startedAt: '2026-08-31T00:00:00.000Z',
          },
        };
      }),
    });
    const first = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: firstHarness.payara,
      logger,
      deploymentLockPath: lockPath,
    });
    const second = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: secondHarness.payara,
      logger,
      deploymentLockPath: lockPath,
    });
    const authorization = {
      bootEpoch: 'recovery-epoch',
      runtimeFingerprint: 'a'.repeat(64),
      expectedArtifactSha256: 'f'.repeat(64),
      authorizationId: 'GO-RECOVERY-LEASE-001',
      expectedRuntimeListed: false,
      reason: 'Exercise coordinated one-shot recovery',
      source: 'WD-LEASE-06',
    };

    try {
      const recovery = first.recoverBootDeployment(authorization);
      await recoveryReached.promise;
      const activeLabel = firstHarness.activeLabel();

      await expect(
        second.withDeploymentLock('contending-recovery', 'deploy', async () => undefined)
      ).rejects.toThrow(/Deployment already in progress|remained contended/);
      expect(activeLabel).toBe('operator-boot-recovery:TestApp');

      allowRecovery.resolve();
      await expect(recovery).resolves.toMatchObject({ applications: ['TestApp'] });
      expect(firstHarness.events).toContain(`recovery-consume:${activeLabel}`);
      expect(firstHarness.events).toContain(`recovery-undeploy:${activeLabel}`);
      expect(firstHarness.events).toContain(`recovery-deploy:${activeLabel}`);
    } finally {
      allowRecovery.resolve();
      cleanupTempDir(tempDir);
    }
  });

  it('WD-LEASE-07: missing application verification is a terminal deploy failure', async () => {
    const tempDir = createTempDir('war-deployer-verify-failure');
    const warPath = createTestWar({
      path: `${tempDir}/TestApp.war`,
      appName: 'TestApp',
    });
    const harness = createLeaseHarness();
    vi.spyOn(harness.payara, 'listApplications').mockResolvedValue([]);
    const deployer = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: harness.payara,
      logger,
      deploymentLockPath: `${tempDir}/deploy.lock`,
    });

    try {
      await expect(deployer.deploy()).rejects.toThrow('DEPLOYMENT_VERIFICATION_FAILED');
      expect(harness.payara.deploy).toHaveBeenCalledOnce();
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('WD-LEASE-08: a rejected deletion cannot produce a successful deploy receipt', async () => {
    const tempDir = createTempDir('war-deployer-delete-failure');
    const warPath = createTestWar({
      path: `${tempDir}/TestApp.war`,
      appName: 'TestApp',
      files: [{ path: 'keep.txt', content: 'before' }],
    });
    const harness = createLeaseHarness();
    const deployer = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: harness.payara,
      logger,
      deploymentLockPath: `${tempDir}/deploy.lock`,
    });

    try {
      const result = await deployer.applyChanges([], ['../outside.war-entry']);
      expect(result.success).toBe(false);
      expect(harness.payara.deploy).not.toHaveBeenCalled();
      expect(getWarFile(warPath, 'keep.txt')?.toString()).toBe('before');
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
