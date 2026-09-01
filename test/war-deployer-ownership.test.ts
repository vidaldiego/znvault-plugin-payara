import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PayaraManager } from '../src/payara-manager.js';
import { WarDeployer } from '../src/war-deployer.js';

const logger = pino({ level: 'silent' });

function makeDeployer(payara: PayaraManager): WarDeployer {
  Object.assign(payara as object, {
    registerApplication: vi.fn(),
    withMutationLease: vi.fn(
      async (_label: string, operation: () => Promise<unknown>) => operation()
    ),
    reconcileDurableMutationQuarantine: vi.fn(async () => undefined),
  });
  const deployer = new WarDeployer({
    warPath: '/tmp/ZincAPI.war',
    appName: 'ZincAPI',
    payara,
    logger,
    deploymentLockPath: `/tmp/znvault-ownership-${process.pid}-${randomUUID()}.lock`,
  });
  vi.spyOn(deployer, 'warExists').mockResolvedValue(true);
  return deployer;
}

describe('WarDeployer post-start ownership reconciliation', () => {
  it('WD-OWN-01: preserves the boot epoch when Payara owns a not-yet-visible boot app', async () => {
    const payara = {
      reconcilePostStartDeployment: vi.fn(async () => ({
        outcome: 'boot-owned-skip' as const,
        bootEpoch: 'boot-epoch-57',
        deploymentAttempted: false as const,
        deployedObserved: false,
        readiness: 'unverified' as const,
      })),
      deploy: vi.fn(async () => undefined),
      undeploy: vi.fn(async () => undefined),
    } as unknown as PayaraManager;
    const deployer = makeDeployer(payara);

    await expect(
      deployer.deployAfterStart('skip-if-boot-owned')
    ).resolves.toEqual({
      outcome: 'boot-owned-skip',
      bootEpoch: 'boot-epoch-57',
      deploymentAttempted: false,
      deployedObserved: false,
      readiness: 'unverified',
    });

    expect(payara.reconcilePostStartDeployment).toHaveBeenCalledWith(
      '/tmp/ZincAPI.war',
      'ZincAPI',
      undefined,
      'skip-if-boot-owned'
    );
    expect(payara.deploy).not.toHaveBeenCalled();
    expect(payara.undeploy).not.toHaveBeenCalled();
  });

  it('WD-OWN-02: app visibility does not convert boot ownership into redeploy permission', async () => {
    const payara = {
      reconcilePostStartDeployment: vi.fn(async () => ({
        outcome: 'boot-owned-skip' as const,
        bootEpoch: 'boot-epoch-visible',
        deploymentAttempted: false as const,
        deployedObserved: true,
        readiness: 'health-verified' as const,
      })),
    } as unknown as PayaraManager;
    const deployer = makeDeployer(payara);

    await expect(
      deployer.deployAfterStart('skip-if-boot-owned')
    ).resolves.toMatchObject({
      outcome: 'boot-owned-skip',
      bootEpoch: 'boot-epoch-visible',
      deploymentAttempted: false,
      deployedObserved: true,
      readiness: 'health-verified',
    });
  });

  it('WD-OWN-03: explicit aggressive policy rejects surviving Payara ownership', async () => {
    const payara = {
      reconcilePostStartDeployment: vi.fn(async () => {
        throw new Error('BOOT_OWNER_CONFLICT: Payara owns boot epoch boot-epoch-57');
      }),
    } as unknown as PayaraManager;
    const deployer = makeDeployer(payara);

    await expect(
      deployer.deployAfterStart('require-agent-owned')
    ).rejects.toThrow('BOOT_OWNER_CONFLICT');
    expect(payara.reconcilePostStartDeployment).toHaveBeenCalledWith(
      '/tmp/ZincAPI.war',
      'ZincAPI',
      undefined,
      'require-agent-owned'
    );
  });

  it('WD-OWN-04: returns the atomically reconciled agent deployment result', async () => {
    const payara = {
      reconcilePostStartDeployment: vi.fn(async () => ({
        outcome: 'agent-deployed' as const,
        bootEpoch: 'boot-epoch-agent',
        deploymentAttempted: true as const,
        deployed: true,
        applications: ['ZincAPI'],
      })),
      deploy: vi.fn(async () => undefined),
      undeploy: vi.fn(async () => undefined),
    } as unknown as PayaraManager;
    const deployer = makeDeployer(payara);

    await expect(
      deployer.deployAfterStart('require-agent-owned')
    ).resolves.toEqual({
      outcome: 'agent-deployed',
      bootEpoch: 'boot-epoch-agent',
      deploymentAttempted: true,
      deployed: true,
      applications: ['ZincAPI'],
    });

    expect(payara.reconcilePostStartDeployment).toHaveBeenCalledWith(
      '/tmp/ZincAPI.war',
      'ZincAPI',
      undefined,
      'require-agent-owned'
    );
    expect(payara.deploy).not.toHaveBeenCalled();
    expect(payara.undeploy).not.toHaveBeenCalled();
  });
});
