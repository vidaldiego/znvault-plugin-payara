import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { PayaraManager } from '../src/payara-manager.js';

const logger = pino({ level: 'silent' });

interface PayaraManagerInternals {
  assertBootEpochCurrent: (
    appName: string,
    expectedBootEpoch: string,
    operation: string
  ) => Promise<unknown>;
  assertRecoveryArtifactCurrentSync: (
    warPath: string,
    expectedArtifactSha256: string
  ) => void;
  asadminCommand: (args: string[], timeoutMs?: number) => Promise<string>;
  getPayaraProcessPidsStrict: () => Promise<number[]>;
  minimumBootOwnershipAbsenceGraceMs: () => number;
  monotonicNowMs: () => number;
  readRuntimeStartedAtMs: () => Promise<number | undefined>;
  sleep: (ms: number) => Promise<void>;
  waitForRunning: (timeoutMs: number) => Promise<void>;
  writeSetenvConfInternal: () => Promise<void>;
}

interface TestManagerOptions {
  runtimeIdentityProvider?: () => Promise<string | number | undefined>;
  runtimeIdentitySyncProvider?: () => string | number | undefined;
  healthEndpoint?: string;
  mutationQuarantinePath?: string | false;
}

function makeManager(options: TestManagerOptions = {}): PayaraManager {
  const manager = new PayaraManager({
    payaraHome: '/tmp/payara-boot-epoch-test',
    domain: 'production',
    user: process.env.USER || 'test',
    logger,
    runtimeIdentityProvider: async () => 1000,
    runtimeIdentitySyncProvider: () => 1000,
    mutationQuarantinePath: false,
    ...options,
  });
  vi.spyOn(internals(manager), 'minimumBootOwnershipAbsenceGraceMs').mockReturnValue(0);
  vi.spyOn(internals(manager), 'monotonicNowMs').mockImplementation(() => Date.now());
  return manager;
}

function internals(manager: PayaraManager): PayaraManagerInternals {
  return manager as unknown as PayaraManagerInternals;
}

describe('Payara boot epoch fence', () => {
  it('BEF-01: installs the startup fence and rotates the epoch before start-domain runs', async () => {
    let clockMs = 1000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
    const manager = makeManager();
    manager.registerApplication('ZincAPI');
    const previousEpoch = manager.getBootDeploymentStatus('ZincAPI').bootEpoch;
    let statusAtCommand: ReturnType<PayaraManager['getBootDeploymentStatus']> | undefined;

    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
    vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
    vi.spyOn(internals(manager), 'sleep').mockImplementation(async ms => {
      clockMs += ms;
    });
    vi.spyOn(internals(manager), 'writeSetenvConfInternal').mockResolvedValue();
    vi.spyOn(internals(manager), 'waitForRunning').mockResolvedValue();
    vi.spyOn(internals(manager), 'getPayaraProcessPidsStrict').mockResolvedValue([]);
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockImplementation(async args => {
        if (args[0] === 'start-domain') {
          statusAtCommand = manager.getBootDeploymentStatus('ZincAPI');
        }
        return args[0] === 'list-domains' ? 'production not running\n' : '';
      });

    try {
      await manager.withStartupFence('ZincAPI', () =>
        manager.start({ waitForApplicationHealth: false })
      );

      expect(command).toHaveBeenCalledWith(
        ['start-domain', 'production'],
        expect.any(Number)
      );
      expect(statusAtCommand).toMatchObject({
        appName: 'ZincAPI',
        phase: 'startup',
        readiness: 'unverified',
        startupActive: true,
      });
      expect(statusAtCommand?.bootEpoch).not.toBe(previousEpoch);
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        phase: 'startup',
        readiness: 'unverified',
        evidenceSource: 'startup-unclassified',
        startupActive: false,
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it('BEF-02: a valid epoch-bound attestation releases future deployment', async () => {
    const manager = makeManager();
    let present = true;
    const mutationCommands: string[] = [];
    vi.spyOn(manager, 'listApplicationRefs').mockImplementation(async () =>
      present ? ['ZincAPI'] : []
    );
    vi.spyOn(manager, 'listApplications').mockImplementation(async () =>
      present ? ['ZincAPI'] : []
    );
    vi.spyOn(internals(manager), 'asadminCommand').mockImplementation(async args => {
      if (args[0] === 'undeploy') {
        mutationCommands.push('undeploy');
        present = false;
      } else if (args[0] === 'deploy') {
        mutationCommands.push('deploy');
        present = true;
      }
      return '';
    });

    const ownership = await manager.withStartupFence('ZincAPI', () =>
      manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      })
    );
    expect(ownership).toMatchObject({
      owner: 'payara',
      runtimeListed: true,
      readiness: 'unverified',
    });

    const ready = await manager.attestBootReady('ZincAPI', {
      bootEpoch: ownership.bootEpoch,
      reason: 'API health and startup logs verified by the incident operator',
      source: 'API-57 recovery runbook',
    });
    expect(ready).toMatchObject({
      bootEpoch: ownership.bootEpoch,
      phase: 'ready',
      readiness: 'externally-attested',
      startupActive: false,
      evidenceSource: 'API-57 recovery runbook',
    });

    await expect(manager.deploy('/tmp/ZincAPI.war', 'ZincAPI')).resolves.toBeUndefined();
    expect(mutationCommands).toEqual(['undeploy', 'deploy']);
  });

  it('BEF-03: rejects an attestation from an older boot epoch', async () => {
    const manager = makeManager();
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);

    const classifyCurrentBoot = () => manager.withStartupFence('ZincAPI', () =>
      manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      })
    );
    const oldOwnership = await classifyCurrentBoot();
    const currentOwnership = await classifyCurrentBoot();

    expect(currentOwnership.bootEpoch).not.toBe(oldOwnership.bootEpoch);
    await expect(manager.attestBootReady('ZincAPI', {
      bootEpoch: oldOwnership.bootEpoch,
      reason: 'Evidence belongs to the previous startup',
      source: 'stale recovery check',
    })).rejects.toThrow('BOOT_EPOCH_MISMATCH');
    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      bootEpoch: currentOwnership.bootEpoch,
      phase: 'payara-booting',
      readiness: 'unverified',
    });
  });

  it('BEF-04: serializes concurrent reconciliations and issues exactly one deploy', async () => {
    let clockMs = 1000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
    const manager = makeManager();
    let present = false;
    let deployCommands = 0;
    const sleep = vi.spyOn(internals(manager), 'sleep').mockImplementation(async ms => {
      clockMs += ms;
    });
    vi.spyOn(manager, 'listApplicationRefs').mockImplementation(async () =>
      present ? ['ZincAPI'] : []
    );
    vi.spyOn(manager, 'listApplications').mockImplementation(async () =>
      present ? ['ZincAPI'] : []
    );
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockImplementation(async args => {
        if (args[0] === 'deploy') {
          deployCommands += 1;
          present = true;
        }
        return '';
      });

    try {
      const first = manager.reconcilePostStartDeployment(
        '/tmp/ZincAPI.war',
        'ZincAPI',
        undefined,
        'skip-if-boot-owned'
      );
      const second = manager.reconcilePostStartDeployment(
        '/tmp/ZincAPI.war',
        'ZincAPI',
        undefined,
        'skip-if-boot-owned'
      );

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toMatchObject({
        outcome: 'agent-deployed',
        deploymentAttempted: true,
        deployed: true,
      });
      expect(secondResult).toMatchObject({
        outcome: 'already-reconciled-skip',
        bootEpoch: firstResult.bootEpoch,
        deploymentAttempted: false,
        deployedObserved: true,
        owner: 'agent',
      });
      expect(deployCommands).toBe(1);
      expect(command.mock.calls.filter(([args]) => args[0] === 'deploy')).toHaveLength(1);
      expect(command.mock.calls.filter(([args]) => args[0] === 'undeploy')).toHaveLength(0);
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        bootEpoch: firstResult.bootEpoch,
        phase: 'ready',
        readiness: 'not_applicable',
        owner: 'agent',
      });
      expect(manager.isMutationInProgress()).toBe(false);
    } finally {
      sleep.mockRestore();
      dateNow.mockRestore();
    }
  });

  it('BEF-05: even a sub-15-second runtime identity change rotates and fences deploy', async () => {
    let runtimeStartedAtMs = 1000;
    const manager = makeManager({
      runtimeIdentityProvider: vi.fn(async () => runtimeStartedAtMs),
    });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
    const command = vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue('');

    const ownership = await manager.withStartupFence('ZincAPI', () =>
      manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      })
    );
    await manager.attestBootReady('ZincAPI', {
      bootEpoch: ownership.bootEpoch,
      reason: 'Runtime and application readiness verified before maintenance',
      source: 'runtime-identity-regression',
    });
    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      bootEpoch: ownership.bootEpoch,
      phase: 'ready',
      owner: 'payara',
    });

    runtimeStartedAtMs = 1001;

    await expect(manager.deploy('/tmp/ZincAPI.war', 'ZincAPI'))
      .rejects.toThrow(/BOOT_(?:READINESS_ATTESTATION_REQUIRED|RUNTIME_IDENTITY_CHANGED)/);

    const current = manager.getBootDeploymentStatus('ZincAPI');
    expect(current.bootEpoch).not.toBe(ownership.bootEpoch);
    expect(current).toMatchObject({
      phase: 'payara-booting',
      readiness: 'unverified',
      owner: 'payara',
    });
    expect(command.mock.calls.filter(([args]) =>
      args[0] === 'deploy' || args[0] === 'undeploy'
    )).toHaveLength(0);
  });

  it('BEF-05a: status readback rotates a ready epoch after an external restart', async () => {
    let runtimeStartedAtMs = 1000;
    const manager = makeManager({
      runtimeIdentityProvider: vi.fn(async () => runtimeStartedAtMs),
    });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);

    const ownership = await manager.withStartupFence('ZincAPI', () =>
      manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      })
    );
    await manager.attestBootReady('ZincAPI', {
      bootEpoch: ownership.bootEpoch,
      reason: 'Runtime and application readiness verified before maintenance',
      source: 'status-readback-regression',
    });

    runtimeStartedAtMs = 60000;
    const current = await manager.readBootDeploymentStatus('ZincAPI');

    expect(current.bootEpoch).not.toBe(ownership.bootEpoch);
    expect(current).toMatchObject({
      phase: 'startup',
      readiness: 'unverified',
      startupActive: false,
      evidenceSource: 'external-runtime-change',
    });
    expect(current).not.toHaveProperty('owner');
  });

  it('BEF-06: an attestation submitted during startup rejects before the startup lease releases', async () => {
    const manager = makeManager();
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);

    let releaseStartup!: () => void;
    const startupRelease = new Promise<void>(resolve => {
      releaseStartup = resolve;
    });
    let signalStartupEntered!: () => void;
    const startupEntered = new Promise<void>(resolve => {
      signalStartupEntered = resolve;
    });

    const startup = manager.withStartupFence('ZincAPI', async () => {
      signalStartupEntered();
      await startupRelease;
    });
    await startupEntered;
    const epoch = manager.getBootDeploymentStatus('ZincAPI').bootEpoch;

    const attestation = manager.attestBootReady('ZincAPI', {
      bootEpoch: epoch,
      reason: 'Evidence collected while startup is still running',
      source: 'premature-attestation-regression',
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const attestationOutcome = await Promise.race([
        attestation.then(
          () => 'unexpectedly-resolved',
          error => error instanceof Error ? error.message : String(error)
        ),
        new Promise<string>(resolve => {
          timeout = setTimeout(() => resolve('still-pending'), 25);
        }),
      ]);

      expect(attestationOutcome).toContain('BOOT_STARTUP_ACTIVE');
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        bootEpoch: epoch,
        phase: 'startup',
        readiness: 'unverified',
        startupActive: true,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseStartup();
      await startup;
      await attestation.catch(() => undefined);
    }
  });

  it('BEF-07: a blocked epoch recovers only after continuous absent inventory', async () => {
    let clockMs = 1000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
    const manager = makeManager();
    let present = false;
    const sleep = vi.spyOn(internals(manager), 'sleep').mockImplementation(async ms => {
      clockMs += ms;
    });
    vi.spyOn(manager, 'listApplicationRefs').mockImplementation(async () =>
      present ? ['ZincAPI'] : []
    );
    vi.spyOn(manager, 'listApplications').mockImplementation(async () =>
      present ? ['ZincAPI'] : []
    );
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockImplementation(async args => {
        if (args[0] === 'deploy') {
          present = true;
        }
        return '';
      });

    try {
      await expect(manager.withStartupFence('ZincAPI', async () => {
        throw new Error('simulated startup failure');
      })).rejects.toThrow('simulated startup failure');
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        phase: 'blocked',
        readiness: 'unverified',
      });

      const result = await manager.reconcilePostStartDeployment(
        '/tmp/ZincAPI.war',
        'ZincAPI',
        undefined,
        'require-agent-owned'
      );

      expect(result).toMatchObject({
        outcome: 'agent-deployed',
        deploymentAttempted: true,
        deployed: true,
      });
      expect(command.mock.calls.filter(([args]) => args[0] === 'deploy')).toHaveLength(1);
      expect(command.mock.calls.filter(([args]) => args[0] === 'undeploy')).toHaveLength(0);
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        bootEpoch: result.bootEpoch,
        phase: 'ready',
        readiness: 'not_applicable',
        owner: 'agent',
      });
    } finally {
      sleep.mockRestore();
      dateNow.mockRestore();
    }
  });

  it('BEF-08: contradictory inventory keeps a blocked epoch closed', async () => {
    const manager = makeManager();
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
    vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
    const command = vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue('');

    await expect(manager.withStartupFence('ZincAPI', async () => {
      throw new Error('simulated startup failure');
    })).rejects.toThrow('simulated startup failure');

    await expect(manager.reconcilePostStartDeployment(
      '/tmp/ZincAPI.war',
      'ZincAPI',
      undefined,
      'require-agent-owned'
    )).rejects.toThrow('BOOT_STATE_CONTRADICTORY');

    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'blocked',
      readiness: 'unverified',
      evidenceSource: 'contradictory-inventory',
    });
    expect(command.mock.calls.filter(([args]) =>
      args[0] === 'deploy' || args[0] === 'undeploy'
    )).toHaveLength(0);
  });

  it('BEF-09: an application registered after start-domain must still be classified', async () => {
    const manager = makeManager({
      runtimeIdentityProvider: vi.fn(async () => 1000),
    });
    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    vi.spyOn(internals(manager), 'writeSetenvConfInternal').mockResolvedValue();
    vi.spyOn(internals(manager), 'waitForRunning').mockResolvedValue();
    vi.spyOn(internals(manager), 'getPayaraProcessPidsStrict').mockResolvedValue([]);
    const refs = vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['LateApp']);
    const apps = vi.spyOn(manager, 'listApplications').mockResolvedValue(['LateApp']);
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockImplementation(async args =>
        args[0] === 'list-domains' ? 'production not running\n' : ''
      );

    await manager.withStartupFence('SeedApp', () =>
      manager.start({ waitForApplicationHealth: false })
    );

    await expect(manager.deploy('/tmp/LateApp.war', 'LateApp'))
      .rejects.toThrow(/BOOT_(?:READINESS_ATTESTATION_REQUIRED|OWNER_CONFLICT)/);

    expect(refs).toHaveBeenCalled();
    expect(apps).toHaveBeenCalled();
    expect(command.mock.calls.filter(([args]) => args[0] === 'start-domain')).toHaveLength(1);
    expect(command.mock.calls.filter(([args]) =>
      args[0] === 'deploy' || args[0] === 'undeploy'
    )).toHaveLength(0);
    expect(manager.getBootDeploymentStatus('LateApp')).toMatchObject({
      phase: 'payara-booting',
      readiness: 'unverified',
      owner: 'payara',
    });
  });

  it.each(['restarting', 'started'] as const)(
    'BEF-10 (%s): an exec lifecycle event rotates ready state immediately and fences deploy',
    async eventType => {
      const manager = makeManager();
      const refs = vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
      const apps = vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
      const command = vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue('');

      const ownership = await manager.withStartupFence('ZincAPI', () =>
        manager.classifyBootOwnership('ZincAPI', {
          timeoutMs: 20,
          pollIntervalMs: 1,
          absenceGraceMs: 5,
        })
      );
      await manager.attestBootReady('ZincAPI', {
        bootEpoch: ownership.bootEpoch,
        reason: 'Application readiness verified before the exec lifecycle event',
        source: 'child-process-event-regression',
      });
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        bootEpoch: ownership.bootEpoch,
        phase: 'ready',
        owner: 'payara',
      });

      manager.fenceExternalRuntimeChange(`child-process:${eventType}`);

      const fenced = manager.getBootDeploymentStatus('ZincAPI');
      expect(fenced.bootEpoch).not.toBe(ownership.bootEpoch);
      expect(fenced).toMatchObject({
        phase: 'blocked',
        readiness: 'unverified',
        startupActive: false,
        evidenceSource: `child-process:${eventType}`,
      });
      expect(fenced).not.toHaveProperty('owner');

      refs.mockClear();
      apps.mockClear();
      await expect(manager.deploy('/tmp/ZincAPI.war', 'ZincAPI'))
        .rejects.toThrow('BOOT_EXTERNAL_TRANSITION_PENDING');

      expect(refs).not.toHaveBeenCalled();
      expect(apps).not.toHaveBeenCalled();
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        bootEpoch: fenced.bootEpoch,
        phase: 'blocked',
        readiness: 'unverified',
        evidenceSource: `child-process:${eventType}:transition-pending`,
      });
      expect(command.mock.calls.filter(([args]) =>
        args[0] === 'deploy' || args[0] === 'undeploy'
      )).toHaveLength(0);
    }
  );

  it('BEF-11: an epoch rotation during attestation inventory cannot ready the new epoch', async () => {
    const manager = makeManager();
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    const apps = vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);

    const ownership = await manager.withStartupFence('ZincAPI', () =>
      manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      })
    );
    apps.mockImplementationOnce(async () => {
      manager.fenceExternalRuntimeChange('attestation-inventory-race');
      return ['ZincAPI'];
    });

    await expect(manager.attestBootReady('ZincAPI', {
      bootEpoch: ownership.bootEpoch,
      reason: 'Evidence collected for the old runtime',
      source: 'cas-regression',
    })).rejects.toThrow('BOOT_EPOCH_CHANGED');

    const current = manager.getBootDeploymentStatus('ZincAPI');
    expect(current.bootEpoch).not.toBe(ownership.bootEpoch);
    expect(current).toMatchObject({
      phase: 'startup',
      readiness: 'unverified',
      evidenceSource: 'attestation-inventory-race',
    });
    expect(current).not.toHaveProperty('owner');
  });

  it('BEF-12: an epoch rotation during health I/O cannot promote the new epoch', async () => {
    const manager = makeManager({ healthEndpoint: 'http://127.0.0.1:8080/service-status' });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
    const fetchMock = vi.fn(async () => {
      manager.fenceExternalRuntimeChange('health-check-race');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(manager.withStartupFence('ZincAPI', () =>
        manager.classifyBootOwnership('ZincAPI', {
          timeoutMs: 20,
          pollIntervalMs: 1,
          absenceGraceMs: 5,
        })
      )).rejects.toThrow('BOOT_EPOCH_CHANGED');

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        phase: 'blocked',
        readiness: 'unverified',
        evidenceSource: 'startup-failed',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('BEF-13: a restart during fresh deploy rejects stale commit and never uses force', async () => {
    const manager = makeManager();
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
    vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
    await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 1,
      pollIntervalMs: 1,
      absenceGraceMs: 0,
    });
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockImplementation(async args => {
        if (args[0] === 'deploy') {
          expect(args).not.toContain('--force=true');
          manager.fenceExternalRuntimeChange('fresh-deploy-race');
        }
        return '';
      });

    await expect(manager.deployFresh('/tmp/ZincAPI.war', 'ZincAPI'))
      .rejects.toThrow('BOOT_EPOCH_CHANGED');

    expect(command.mock.calls.filter(([args]) => args[0] === 'deploy')).toHaveLength(1);
    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'startup',
      readiness: 'unverified',
      evidenceSource: 'fresh-deploy-race',
    });
  });

  it('BEF-14: an unknown undeploy result blocks every later mutation in that epoch', async () => {
    const manager = makeManager();
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
    const ownership = await manager.withStartupFence('ZincAPI', () =>
      manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      })
    );
    await manager.attestBootReady('ZincAPI', {
      bootEpoch: ownership.bootEpoch,
      reason: 'Ready before ambiguous mutation',
      source: 'unknown-outcome-regression',
    });
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockRejectedValue(new Error('asadmin timed out'));

    await expect(manager.undeploy('ZincAPI')).rejects.toThrow('asadmin timed out');
    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'blocked',
      readiness: 'unverified',
      evidenceSource: 'agent-undeploy-outcome-unknown',
    });

    command.mockClear();
    await expect(manager.deploy('/tmp/ZincAPI.war', 'ZincAPI'))
      .rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
    expect(command).not.toHaveBeenCalled();
  });

  it('BEF-15: contradictory strict undeploy inventory closes a previously ready epoch', async () => {
    const manager = makeManager();
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    const apps = vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
    const ownership = await manager.withStartupFence('ZincAPI', () =>
      manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      })
    );
    await manager.attestBootReady('ZincAPI', {
      bootEpoch: ownership.bootEpoch,
      reason: 'Ready before contradictory readback',
      source: 'contradiction-regression',
    });
    apps.mockResolvedValue([]);

    await expect(manager.undeployIfPresentStrict('ZincAPI'))
      .rejects.toThrow('BOOT_STATE_CONTRADICTORY');
    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'blocked',
      readiness: 'unverified',
      evidenceSource: 'contradictory-inventory',
    });
  });

  it('BEF-16: a strict stopped-domain probe error cannot authorize start-domain', async () => {
    const manager = makeManager();
    manager.registerApplication('ZincAPI');
    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    vi.spyOn(internals(manager), 'asadminCommand')
      .mockRejectedValue(new Error('list-domains authentication failed'));

    await expect(manager.start({ waitForApplicationHealth: false }))
      .rejects.toThrow('list-domains authentication failed');
    expect(internals(manager).asadminCommand).not.toHaveBeenCalledWith(
      ['start-domain', 'production']
    );
  });

  it('BEF-17: an unknown deploy result cannot retain prior ready state', async () => {
    const manager = makeManager();
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
    vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
    await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 1,
      pollIntervalMs: 1,
      absenceGraceMs: 0,
    });
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockRejectedValue(new Error('deploy outcome timed out'));

    await expect(manager.deploy('/tmp/ZincAPI.war', 'ZincAPI'))
      .rejects.toThrow('deploy outcome timed out');
    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'blocked',
      readiness: 'unverified',
      evidenceSource: 'agent-deploy-outcome-unknown',
    });

    command.mockClear();
    await expect(manager.undeploy('ZincAPI'))
      .rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
    expect(command).not.toHaveBeenCalled();
  });

  it('BEF-18: a DAS token change during one uptime sample is UNKNOWN', async () => {
    const manager = makeManager();
    const identityInternals = manager as unknown as {
      readExactDasProcessIdentity: () => Promise<string | undefined>;
      readRuntimeStartedAtMs: () => Promise<number | undefined>;
      readRuntimeIdentity: () => Promise<string | undefined>;
    };
    vi.spyOn(identityInternals, 'readExactDasProcessIdentity')
      .mockResolvedValueOnce('boot-a:100:10')
      .mockResolvedValueOnce('boot-a:101:11');
    vi.spyOn(identityInternals, 'readRuntimeStartedAtMs').mockResolvedValue(1000);

    await expect(identityInternals.readRuntimeIdentity())
      .rejects.toThrow('BOOT_RUNTIME_IDENTITY_CHANGED_DURING_PROBE');
  });

  it('BEF-18a: runtime identity requests Payara machine-readable uptime', async () => {
    const manager = makeManager();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(60_000_000);
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockResolvedValue('53977602\nCommand uptime executed successfully.\n');

    try {
      await expect(internals(manager).readRuntimeStartedAtMs())
        .resolves.toBe(6_022_398);
      expect(command).toHaveBeenCalledWith(
        ['uptime', '--milliseconds=true'],
        10000
      );
    } finally {
      dateNow.mockRestore();
    }
  });

  it('BEF-18a2: command status before machine-readable uptime remains parseable', async () => {
    const manager = makeManager();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(60_000_000);
    vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue(
      'Command uptime executed successfully.\n53977602\n'
    );

    try {
      await expect(internals(manager).readRuntimeStartedAtMs())
        .resolves.toBe(6_022_398);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('BEF-18a3: ambiguous machine-readable uptime remains fail-closed', async () => {
    const manager = makeManager();
    vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue(
      '1000\n2000\nCommand uptime executed successfully.\n'
    );

    await expect(internals(manager).readRuntimeStartedAtMs())
      .rejects.toThrow('BOOT_RUNTIME_IDENTITY_UNPARSEABLE');
  });

  it('BEF-18b: localized terse uptime cannot silently identify a runtime', async () => {
    const manager = makeManager();
    vi.spyOn(internals(manager), 'asadminCommand')
      .mockResolvedValue('Up 14 hrs 58 mins\nCommand uptime executed successfully.\n');

    await expect(internals(manager).readRuntimeStartedAtMs())
      .rejects.toThrow('BOOT_RUNTIME_IDENTITY_UNPARSEABLE');
  });

  it('BEF-18c: legacy explicit total milliseconds remains accepted', async () => {
    const manager = makeManager();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(5_000);
    vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue(
      'Uptime: 0 days, 0 hours, 0 minutes, 1 seconds, Total milliseconds: 1000\n' +
      'Command uptime executed successfully.\n'
    );

    try {
      await expect(internals(manager).readRuntimeStartedAtMs())
        .resolves.toBe(4_000);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('BEF-19: a strict PID inventory failure cannot authorize start-domain', async () => {
    const manager = makeManager();
    manager.registerApplication('ZincAPI');
    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    const safetyInternals = manager as unknown as {
      asadminCommand: (args: string[]) => Promise<string>;
      getPayaraProcessPidsStrict: () => Promise<number[]>;
    };
    vi.spyOn(safetyInternals, 'asadminCommand').mockResolvedValue('production not running\n');
    vi.spyOn(safetyInternals, 'getPayaraProcessPidsStrict')
      .mockRejectedValue(new Error('ps permission denied'));

    await expect(manager.start({ waitForApplicationHealth: false }))
      .rejects.toThrow('ps permission denied');
    expect(safetyInternals.asadminCommand).not.toHaveBeenCalledWith(
      ['start-domain', 'production']
    );
  });

  it('BEF-20: continuous absence cannot cross an epoch rotation during poll sleep', async () => {
    let clockMs = 1000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
    const manager = makeManager();
    manager.registerApplication('ZincAPI');
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
    vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
    let rotated = false;
    vi.spyOn(internals(manager), 'sleep').mockImplementation(async ms => {
      clockMs += ms;
      if (!rotated) {
        rotated = true;
        manager.fenceExternalRuntimeChange('absence-sleep-race');
      }
    });
    const command = vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue('');

    try {
      await expect(manager.reconcilePostStartDeployment(
        '/tmp/ZincAPI.war',
        'ZincAPI',
        undefined,
        'require-agent-owned'
      )).rejects.toThrow('BOOT_EPOCH_CHANGED');

      expect(command.mock.calls.filter(([args]) =>
        args[0] === 'deploy' || args[0] === 'undeploy'
      )).toHaveLength(0);
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        phase: 'startup',
        readiness: 'unverified',
        evidenceSource: 'absence-sleep-race',
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it('BEF-21: a startup token cannot bypass an unknown stopped-domain probe', async () => {
    const manager = makeManager();
    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    vi.spyOn(internals(manager), 'writeSetenvConfInternal').mockResolvedValue();
    vi.spyOn(internals(manager), 'waitForRunning').mockResolvedValue();
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockImplementation(async args => {
        if (args[0] === 'list-domains') {
          throw new Error('strict domain probe unavailable');
        }
        return '';
      });

    await expect(manager.withStartupFence('ZincAPI', () =>
      manager.safeStart({ waitForApplicationHealth: false })
    )).rejects.toThrow('strict domain probe unavailable');

    expect(command).not.toHaveBeenCalledWith(['start-domain', 'production']);
  });

  it('BEF-22: a startup token cannot turn an unknown PID probe into zero JVMs', async () => {
    const manager = makeManager();
    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    vi.spyOn(internals(manager), 'writeSetenvConfInternal').mockResolvedValue();
    vi.spyOn(internals(manager), 'waitForRunning').mockResolvedValue();
    const safetyInternals = manager as unknown as PayaraManagerInternals & {
      getPayaraProcessPidsStrict: () => Promise<number[]>;
    };
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockResolvedValue('production not running\n');
    vi.spyOn(safetyInternals, 'getPayaraProcessPidsStrict')
      .mockRejectedValue(new Error('strict PID probe unavailable'));

    await expect(manager.withStartupFence('ZincAPI', () =>
      manager.safeStart({ waitForApplicationHealth: false })
    )).rejects.toThrow('strict PID probe unavailable');

    expect(command).not.toHaveBeenCalledWith(['start-domain', 'production']);
  });

  it('BEF-23: stop cannot report success when the domain-state probe is UNKNOWN', async () => {
    const manager = makeManager();
    manager.registerApplication('ZincAPI');
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockImplementation(async args => {
        if (args[0] === 'list-domains') {
          throw new Error('stop domain probe unavailable');
        }
        return '';
      });

    await expect(manager.stop()).rejects.toThrow('stop domain probe unavailable');
    expect(command).not.toHaveBeenCalledWith(['stop-domain', 'production']);
  });

  it('BEF-24: startup failure cannot erase an ambiguous deploy outcome', async () => {
    const manager = makeManager();
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
    vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockImplementation(async args => {
        if (args[0] === 'deploy') {
          throw new Error('fresh deploy response lost');
        }
        return '';
      });

    await expect(manager.withStartupFence('ZincAPI', async () => {
      await manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 1,
        pollIntervalMs: 1,
        absenceGraceMs: 0,
      });
      await manager.deployFresh('/tmp/ZincAPI.war', 'ZincAPI');
    })).rejects.toThrow('fresh deploy response lost');

    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'blocked',
      evidenceSource: 'agent-fresh-deploy-outcome-unknown',
      mutationOutcomeUnknown: true,
    });
    command.mockClear();
    await expect(manager.deployFresh('/tmp/ZincAPI.war', 'ZincAPI'))
      .rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
    expect(command).not.toHaveBeenCalled();
  });

  it('BEF-25: an identity-probe failure cannot unstick UNKNOWN in the same epoch', async () => {
    let identityUnavailable = false;
    const manager = makeManager({
      runtimeIdentityProvider: async () => {
        if (identityUnavailable) {
          throw new Error('runtime identity temporarily unavailable');
        }
        return 'same-runtime';
      },
    });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
    vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockImplementation(async args => {
        if (args[0] === 'deploy') {
          throw new Error('deploy completion unknown');
        }
        return '';
      });

    await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 1,
      pollIntervalMs: 1,
      absenceGraceMs: 0,
    });
    await expect(manager.deployFresh('/tmp/ZincAPI.war', 'ZincAPI'))
      .rejects.toThrow('deploy completion unknown');

    identityUnavailable = true;
    await expect(manager.readBootDeploymentStatus('ZincAPI'))
      .rejects.toThrow('BOOT_RUNTIME_IDENTITY_UNKNOWN');
    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      evidenceSource: 'agent-fresh-deploy-outcome-unknown',
      mutationOutcomeUnknown: true,
    });

    identityUnavailable = false;
    command.mockClear();
    await expect(manager.deployFresh('/tmp/ZincAPI.war', 'ZincAPI'))
      .rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
    expect(command).not.toHaveBeenCalled();
  });

  it('BEF-26: a failed health probe still CAS-checks an epoch rotation', async () => {
    const manager = makeManager({ healthEndpoint: 'http://127.0.0.1:8080/service-status' });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
    vi.stubGlobal('fetch', vi.fn(async () => {
      manager.fenceExternalRuntimeChange('failed-health-race');
      return new Response('{}', { status: 503 });
    }));

    try {
      await expect(manager.withStartupFence('ZincAPI', () =>
        manager.classifyBootOwnership('ZincAPI', {
          timeoutMs: 20,
          pollIntervalMs: 1,
          absenceGraceMs: 5,
        })
      )).rejects.toThrow('BOOT_EPOCH_CHANGED');
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        phase: 'blocked',
        readiness: 'unverified',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('BEF-27: health polling promotes a previously unverified Payara boot owner', async () => {
    const manager = makeManager({ healthEndpoint: 'http://127.0.0.1:8080/service-status' });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
    const health = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', health);

    try {
      const ownership = await manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      });
      expect(ownership).toMatchObject({
        owner: 'payara',
        readiness: 'unverified',
      });
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        bootEpoch: ownership.bootEpoch,
        phase: 'payara-booting',
        readiness: 'unverified',
      });

      await expect(manager.readBootDeploymentStatus('ZincAPI')).resolves.toMatchObject({
        bootEpoch: ownership.bootEpoch,
        phase: 'ready',
        readiness: 'health-verified',
        owner: 'payara',
      });
      expect(health).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('BEF-28: production ownership absence grace cannot be shortened below 20 seconds', async () => {
    const manager = new PayaraManager({
      payaraHome: '/tmp/payara-grace-test',
      domain: 'production',
      user: process.env.USER || 'test',
      logger,
      runtimeIdentityProvider: async () => 'runtime-grace-test',
      mutationQuarantinePath: false,
    });
    const refs = vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
    const apps = vi.spyOn(manager, 'listApplications').mockResolvedValue([]);

    await expect(manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 10_000,
      pollIntervalMs: 10,
      absenceGraceMs: 19_999,
    })).rejects.toThrow('BOOT_OWNERSHIP_TIMING_INVALID');
    expect(refs).not.toHaveBeenCalled();
    expect(apps).not.toHaveBeenCalled();
  });

  it('BEF-29: wall-clock jumps do not advance the monotonic absence proof', async () => {
    const manager = makeManager();
    let monotonicMs = 0;
    let wallMs = 1_000;
    vi.spyOn(internals(manager), 'monotonicNowMs').mockImplementation(() => monotonicMs);
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => wallMs);
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
    vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
    vi.spyOn(internals(manager), 'sleep').mockImplementation(async ms => {
      monotonicMs += ms;
      wallMs = wallMs < 10_000 ? 10_000_000_000 : 10;
    });

    try {
      await expect(manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 50,
        pollIntervalMs: 10,
        absenceGraceMs: 20,
      })).resolves.toMatchObject({ owner: 'agent' });
      expect(monotonicMs).toBe(20);
    } finally {
      wallClock.mockRestore();
    }
  });

  it('BEF-30: restarting event keeps the old healthy DAS fenced until exact replacement', async () => {
    let runtimeIdentity: string | undefined = 'old-das';
    const manager = makeManager({
      runtimeIdentityProvider: async () => runtimeIdentity,
      healthEndpoint: 'http://127.0.0.1:8080/service-status',
    });
    const refs = vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    const apps = vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
    const health = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', health);

    try {
      await expect(manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      })).resolves.toMatchObject({ owner: 'payara', readiness: 'health-verified' });
      expect(health).toHaveBeenCalledOnce();

      manager.fenceExternalRuntimeChange('child-process:restarting', 'restarting');
      await expect(manager.readBootDeploymentStatus('ZincAPI'))
        .rejects.toThrow('BOOT_EXTERNAL_TRANSITION_PENDING');
      await expect(manager.deploy('/tmp/ZincAPI.war', 'ZincAPI'))
        .rejects.toThrow('BOOT_EXTERNAL_TRANSITION_PENDING');
      expect(health).toHaveBeenCalledOnce();

      runtimeIdentity = undefined;
      await expect(manager.readBootDeploymentStatus('ZincAPI')).resolves.toMatchObject({
        phase: 'blocked',
        evidenceSource: 'child-process:restarting:exact-absence',
      });

      manager.fenceExternalRuntimeChange('child-process:started', 'started');
      runtimeIdentity = 'new-das';
      const replacement = await manager.readBootDeploymentStatus('ZincAPI');
      expect(replacement).toMatchObject({
        phase: 'startup',
        readiness: 'unverified',
        evidenceSource: 'child-process:started:replacement-observed',
      });
      expect(replacement.bootEpoch).not.toBeUndefined();

      await expect(manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      })).resolves.toMatchObject({
        owner: 'payara',
        readiness: 'health-verified',
      });
      expect(refs).toHaveBeenCalled();
      expect(apps).toHaveBeenCalled();
      expect(health).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('BEF-31: startup observation records a restored ref without extending the onStart deadline', async () => {
    const manager = makeManager({
      healthEndpoint: 'http://127.0.0.1:8080/service-status',
    });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
    const health = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', health);

    try {
      const observed = await manager.reconcileBootOwnershipWithoutArtifact('ZincAPI');
      expect(observed).toMatchObject({
        phase: 'payara-booting',
        readiness: 'unverified',
        owner: 'payara',
        runtimeListed: true,
        startupReceipt: {
          outcome: 'boot-owned-skip',
          deploymentAttempted: false,
          bootEpoch: observed.bootEpoch,
          runtimeFingerprint: observed.runtimeFingerprint,
          runtimeListed: true,
          observedAt: expect.any(String),
        },
      });
      expect(health).not.toHaveBeenCalled();

      const promoted = await manager.readBootDeploymentStatus('ZincAPI');
      expect(promoted).toMatchObject({
        phase: 'ready',
        readiness: 'health-verified',
        startupReceipt: observed.startupReceipt,
      });
      expect(health).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('BEF-31a: startup observation never overlaps Payara inventory commands', async () => {
    const manager = makeManager();
    let refsCompleted = false;
    const refs = vi.spyOn(manager, 'listApplicationRefs').mockImplementation(async () => {
      await Promise.resolve();
      refsCompleted = true;
      return ['ZincAPI'];
    });
    const apps = vi.spyOn(manager, 'listApplications').mockImplementation(async () => {
      if (!refsCompleted) {
        throw new Error('concurrent asadmin inventory');
      }
      return ['ZincAPI'];
    });

    await expect(manager.observeBootOwnership('ZincAPI')).resolves.toMatchObject({
      owner: 'payara',
      runtimeListed: true,
    });
    expect(refs).toHaveBeenCalledOnce();
    expect(apps).toHaveBeenCalledOnce();
    expect(refs.mock.invocationCallOrder[0]).toBeLessThan(apps.mock.invocationCallOrder[0]);
  });

  it('BEF-31a2: startup observation retries a transient strict inventory rejection', async () => {
    const manager = makeManager();
    const inventoryError = new Error('unexpected diagnostic row');
    inventoryError.name = 'BOOT_INVENTORY_UNPARSEABLE';
    const refs = vi.spyOn(manager, 'listApplicationRefs')
      .mockRejectedValueOnce(inventoryError)
      .mockResolvedValueOnce(['ZincAPI']);
    const apps = vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
    const sleep = vi.spyOn(internals(manager), 'sleep').mockResolvedValue();

    await expect(manager.observeBootOwnership('ZincAPI')).resolves.toMatchObject({
      owner: 'payara',
      runtimeListed: true,
      startupReceipt: {
        outcome: 'boot-owned-skip',
        deploymentAttempted: false,
      },
    });
    expect(refs).toHaveBeenCalledTimes(2);
    expect(apps).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('BEF-31a3: startup observation remains fenced after bounded inventory retries', async () => {
    const manager = makeManager();
    const inventoryError = new Error('unexpected diagnostic row');
    inventoryError.name = 'BOOT_INVENTORY_UNPARSEABLE';
    const refs = vi.spyOn(manager, 'listApplicationRefs').mockRejectedValue(inventoryError);
    const apps = vi.spyOn(manager, 'listApplications');
    const sleep = vi.spyOn(internals(manager), 'sleep').mockResolvedValue();

    await expect(manager.observeBootOwnership('ZincAPI'))
      .rejects.toThrow('unexpected diagnostic row');
    expect(refs).toHaveBeenCalledTimes(3);
    expect(apps).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('BEF-31b: startup receipt never crosses into a replacement DAS epoch', async () => {
    let runtimeIdentity = 'startup-receipt-das-a';
    const manager = makeManager({
      runtimeIdentityProvider: async () => runtimeIdentity,
      runtimeIdentitySyncProvider: () => runtimeIdentity,
    });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);

    const observed = await manager.observeBootOwnership('ZincAPI');
    expect(observed.startupReceipt).toMatchObject({
      outcome: 'boot-owned-skip',
      bootEpoch: observed.bootEpoch,
      runtimeFingerprint: observed.runtimeFingerprint,
      runtimeListed: true,
      observedAt: expect.any(String),
    });

    runtimeIdentity = 'startup-receipt-das-b';
    const replacement = await manager.readBootDeploymentStatus('ZincAPI');
    expect(replacement.bootEpoch).not.toBe(observed.bootEpoch);
    expect(replacement.runtimeFingerprint).not.toBe(observed.runtimeFingerprint);
    expect(replacement.startupReceipt).toBeUndefined();
  });

  it('BEF-32: one-shot recovery is bound to exact epoch/runtime and replaces only ref-present app-absent', async () => {
    const manager = makeManager({
      runtimeIdentityProvider: async () => 'stuck-das-runtime',
      runtimeIdentitySyncProvider: () => 'stuck-das-runtime',
    });
    let referenced = true;
    let deployed = false;
    const mutationCommands: string[] = [];
    const refs = vi.spyOn(manager, 'listApplicationRefs').mockImplementation(async () =>
      referenced ? ['ZincAPI'] : []
    );
    const apps = vi.spyOn(manager, 'listApplications').mockImplementation(async () =>
      deployed ? ['ZincAPI'] : []
    );
    vi.spyOn(internals(manager), 'asadminCommand').mockImplementation(async args => {
      if (args[0] === 'undeploy') {
        mutationCommands.push('undeploy');
        referenced = false;
        deployed = false;
      } else if (args[0] === 'deploy') {
        mutationCommands.push('deploy');
        referenced = true;
        deployed = true;
      }
      return '';
    });
    vi.spyOn(internals(manager), 'assertRecoveryArtifactCurrentSync')
      .mockImplementation(() => undefined);

    const ownership = await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 20,
      pollIntervalMs: 1,
      absenceGraceMs: 5,
    });
    const blocked = manager.getBootDeploymentStatus('ZincAPI');
    expect(ownership).toMatchObject({
      owner: 'payara',
      runtimeListed: false,
      readiness: 'unverified',
    });
    expect(blocked.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const authorization = {
      bootEpoch: blocked.bootEpoch,
      runtimeFingerprint: blocked.runtimeFingerprint!,
      expectedArtifactSha256: 'f'.repeat(64),
      authorizationId: 'GO-API-57-RECOVERY-001',
      expectedRuntimeListed: false,
      reason: 'Persistent ref remains but ZincAPI failed to appear after the bounded boot window',
      source: 'API-57 incident commander',
    };

    const result = await manager.recoverBootDeployment(
      '/tmp/ZincAPI.war',
      'ZincAPI',
      undefined,
      authorization
    );

    expect(mutationCommands).toEqual(['undeploy', 'deploy']);
    expect(result.applications).toEqual(['ZincAPI']);
    expect(result.bootDeployment).toMatchObject({
      bootEpoch: blocked.bootEpoch,
      runtimeFingerprint: blocked.runtimeFingerprint,
      phase: 'ready',
      readiness: 'not_applicable',
      owner: 'agent',
      runtimeListed: true,
      mutationOutcomeUnknown: false,
    });
    // classify + recovery preflight + post-undeploy + post-deploy verification;
    // there is no fallible read after the WAL commit.
    expect(refs).toHaveBeenCalledTimes(5);
    expect(apps).toHaveBeenCalledTimes(5);

    // Recreate the original stuck inventory in the same DAS epoch. The body is
    // still rejected because authority was consumed, not merely because the
    // first recovery left the app present.
    deployed = false;
    await expect(manager.recoverBootDeployment(
      '/tmp/ZincAPI.war',
      'ZincAPI',
      undefined,
      authorization
    )).rejects.toThrow('BOOT_RECOVERY_AUTHORIZATION_CONSUMED');
    expect(mutationCommands).toEqual(['undeploy', 'deploy']);
  });

  it('BEF-32b: explicitly unhealthy runtime-listed Payara boot can be recovered once', async () => {
    const manager = makeManager({
      runtimeIdentityProvider: async () => 'unhealthy-listed-das',
      runtimeIdentitySyncProvider: () => 'unhealthy-listed-das',
    });
    let referenced = true;
    let deployed = true;
    const mutationCommands: string[] = [];
    vi.spyOn(manager, 'listApplicationRefs').mockImplementation(async () =>
      referenced ? ['ZincAPI'] : []
    );
    vi.spyOn(manager, 'listApplications').mockImplementation(async () =>
      deployed ? ['ZincAPI'] : []
    );
    vi.spyOn(internals(manager), 'asadminCommand').mockImplementation(async args => {
      if (args[0] === 'undeploy') {
        mutationCommands.push('undeploy');
        referenced = false;
        deployed = false;
      } else if (args[0] === 'deploy') {
        mutationCommands.push('deploy');
        referenced = true;
        deployed = true;
      }
      return '';
    });
    vi.spyOn(internals(manager), 'assertRecoveryArtifactCurrentSync')
      .mockImplementation(() => undefined);
    await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 20,
      pollIntervalMs: 1,
      absenceGraceMs: 5,
    });
    const current = manager.getBootDeploymentStatus('ZincAPI');

    await expect(manager.recoverBootDeployment(
      '/tmp/ZincAPI.war',
      'ZincAPI',
      undefined,
      {
        bootEpoch: current.bootEpoch,
        runtimeFingerprint: current.runtimeFingerprint!,
        expectedArtifactSha256: 'f'.repeat(64),
        authorizationId: 'GO-API-57-UNHEALTHY-LISTED-001',
        expectedRuntimeListed: true,
        reason: 'Readiness remains 503 after the bounded Payara boot window',
        source: 'API-57 incident commander',
      }
    )).resolves.toMatchObject({ applications: ['ZincAPI'] });
    expect(mutationCommands).toEqual(['undeploy', 'deploy']);
  });

  it('BEF-32c: inventory drift from the authorized runtime-listed state dispatches nothing', async () => {
    const manager = makeManager({
      runtimeIdentityProvider: async () => 'inventory-drift-das',
      runtimeIdentitySyncProvider: () => 'inventory-drift-das',
    });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    const apps = vi.spyOn(manager, 'listApplications')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['ZincAPI']);
    const command = vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue('');
    await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 20,
      pollIntervalMs: 1,
      absenceGraceMs: 5,
    });
    const current = manager.getBootDeploymentStatus('ZincAPI');

    await expect(manager.recoverBootDeployment(
      '/tmp/ZincAPI.war',
      'ZincAPI',
      undefined,
      {
        bootEpoch: current.bootEpoch,
        runtimeFingerprint: current.runtimeFingerprint!,
        expectedArtifactSha256: 'f'.repeat(64),
        authorizationId: 'GO-INVENTORY-DRIFT-001',
        expectedRuntimeListed: false,
        reason: 'Authorized absent runtime state changed before consumption',
        source: 'BEF-32c',
      }
    )).rejects.toThrow('BOOT_RECOVERY_STATE_INVALID');
    expect(apps).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();
  });

  it('BEF-32d: an app appearing during the pre-dispatch identity CAS is never undeployed', async () => {
    const manager = makeManager({
      runtimeIdentityProvider: async () => 'late-restored-das',
      runtimeIdentitySyncProvider: () => 'late-restored-das',
    });
    let deployed = false;
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockImplementation(async () =>
      deployed ? ['ZincAPI'] : []
    );
    const command = vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue('');
    await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 20,
      pollIntervalMs: 1,
      absenceGraceMs: 5,
    });
    const current = manager.getBootDeploymentStatus('ZincAPI');
    const managerInternals = internals(manager);
    const originalAssert = managerInternals.assertBootEpochCurrent.bind(manager);
    vi.spyOn(managerInternals, 'assertBootEpochCurrent')
      .mockImplementation(async (appName, expectedBootEpoch, operation) => {
        const state = await originalAssert(appName, expectedBootEpoch, operation);
        if (operation === 'operator boot recovery pre-dispatch') {
          deployed = true;
        }
        return state;
      });

    await expect(manager.recoverBootDeployment(
      '/tmp/ZincAPI.war',
      'ZincAPI',
      undefined,
      {
        bootEpoch: current.bootEpoch,
        runtimeFingerprint: current.runtimeFingerprint!,
        expectedArtifactSha256: 'f'.repeat(64),
        authorizationId: 'GO-LATE-RESTORE-001',
        expectedRuntimeListed: false,
        reason: 'App was absent when this recovery was authorized',
        source: 'BEF-32d',
      }
    )).rejects.toThrow('BOOT_RECOVERY_PRE_DISPATCH_CHANGED');
    expect(command).not.toHaveBeenCalled();
    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'payara-booting',
      owner: 'payara',
      mutationOutcomeUnknown: false,
    });
  });

  it('BEF-32e: final synchronous DAS identity drift dispatches nothing and leaves no UNKNOWN', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'payara-recovery-runtime-cas-'));
    const warPath = join(directory, 'ZincAPI.war');
    const warBytes = 'runtime-cas-authorized-war';
    writeFileSync(warPath, warBytes);
    let syncIdentity = 'sync-original-das';
    const manager = makeManager({
      runtimeIdentityProvider: async () => 'sync-original-das',
      runtimeIdentitySyncProvider: () => syncIdentity,
    });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    let applicationReads = 0;
    vi.spyOn(manager, 'listApplications').mockImplementation(async () => {
      applicationReads += 1;
      // classify, initial recovery read, then final pre-dispatch read
      if (applicationReads === 3) syncIdentity = 'sync-replacement-das';
      return [];
    });
    const command = vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue('');
    await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 20,
      pollIntervalMs: 1,
      absenceGraceMs: 5,
    });
    const current = manager.getBootDeploymentStatus('ZincAPI');

    await expect(manager.recoverBootDeployment(
      warPath,
      'ZincAPI',
      undefined,
      {
        bootEpoch: current.bootEpoch,
        runtimeFingerprint: current.runtimeFingerprint!,
        expectedArtifactSha256: createHash('sha256').update(warBytes).digest('hex'),
        authorizationId: 'GO-SYNC-RUNTIME-DRIFT-001',
        expectedRuntimeListed: false,
        reason: 'The exact synchronous DAS must remain unchanged until dispatch',
        source: 'BEF-32e',
      }
    )).rejects.toThrow('BOOT_RUNTIME_IDENTITY_MISMATCH');

    expect(command).not.toHaveBeenCalled();
    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'payara-booting',
      owner: 'payara',
      mutationOutcomeUnknown: false,
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it('BEF-32f: staged WAR hash drift dispatches nothing and consumes no recovery authority', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'payara-recovery-artifact-'));
    const warPath = join(directory, 'ZincAPI.war');
    writeFileSync(warPath, 'authorized-war-bytes');
    const authorizedHash = createHash('sha256')
      .update('different-authorized-war')
      .digest('hex');
    const manager = makeManager({
      runtimeIdentityProvider: async () => 'artifact-bound-das',
      runtimeIdentitySyncProvider: () => 'artifact-bound-das',
    });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
    const command = vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue('');

    try {
      await manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      });
      const current = manager.getBootDeploymentStatus('ZincAPI');
      const authorization = {
        bootEpoch: current.bootEpoch,
        runtimeFingerprint: current.runtimeFingerprint!,
        expectedArtifactSha256: authorizedHash,
        authorizationId: 'GO-ARTIFACT-BOUND-001',
        expectedRuntimeListed: false,
        reason: 'Bind the recovery to a reviewed WAR digest',
        source: 'BEF-32f',
      };

      await expect(manager.recoverBootDeployment(
        warPath,
        'ZincAPI',
        undefined,
        authorization
      )).rejects.toThrow('BOOT_RECOVERY_ARTIFACT_MISMATCH');
      expect(command).not.toHaveBeenCalled();
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        phase: 'payara-booting',
        owner: 'payara',
        mutationOutcomeUnknown: false,
      });

      // A failed digest preflight did not consume the one-shot ID: staging the
      // exact authorized bytes with the same body reaches remote dispatch.
      writeFileSync(warPath, 'different-authorized-war');
      command.mockRejectedValueOnce(new Error('TEST_AFTER_ARTIFACT_PRECHECK'));
      await expect(manager.recoverBootDeployment(
        warPath,
        'ZincAPI',
        undefined,
        authorization
      )).rejects.toThrow('TEST_AFTER_ARTIFACT_PRECHECK');
      expect(command).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('BEF-32g: WAR substitution during undeploy cannot reach deploy and leaves durable UNKNOWN', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'payara-recovery-toctou-'));
    const warPath = join(directory, 'ZincAPI.war');
    const quarantinePath = join(directory, 'mutation-quarantine.json');
    const authorizedBytes = 'authorized-war-A';
    writeFileSync(warPath, authorizedBytes);
    const authorizedHash = createHash('sha256').update(authorizedBytes).digest('hex');
    const manager = makeManager({
      runtimeIdentityProvider: async () => 'artifact-toctou-das',
      runtimeIdentitySyncProvider: () => 'artifact-toctou-das',
      mutationQuarantinePath: quarantinePath,
    });
    let referencePresent = true;
    let signalUndeployEntered!: () => void;
    let releaseUndeploy!: () => void;
    const undeployEntered = new Promise<void>(resolve => {
      signalUndeployEntered = resolve;
    });
    const undeployRelease = new Promise<void>(resolve => {
      releaseUndeploy = resolve;
    });
    vi.spyOn(manager, 'listApplicationRefs').mockImplementation(async () =>
      referencePresent ? ['ZincAPI'] : []
    );
    vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockImplementation(async args => {
        if (args[0] === 'undeploy') {
          referencePresent = false;
          signalUndeployEntered();
          await undeployRelease;
        }
        return '';
      });

    try {
      await manager.classifyBootOwnership('ZincAPI', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        absenceGraceMs: 5,
      });
      const current = manager.getBootDeploymentStatus('ZincAPI');

      const recovery = manager.recoverBootDeployment(
        warPath,
        'ZincAPI',
        undefined,
        {
          bootEpoch: current.bootEpoch,
          runtimeFingerprint: current.runtimeFingerprint!,
          expectedArtifactSha256: authorizedHash,
          authorizationId: 'GO-ARTIFACT-TOCTOU-001',
          expectedRuntimeListed: false,
          reason: 'Prove substituted bytes cannot be consumed by deploy',
          source: 'BEF-32g',
        }
      );
      await undeployEntered;
      // Substitute A with B while recoverBootDeployment is suspended in the
      // awaited undeploy command and the durable WAL is already armed.
      const replacementPath = join(directory, 'ZincAPI.replacement.war');
      writeFileSync(replacementPath, 'substituted-war-B');
      renameSync(replacementPath, warPath);
      releaseUndeploy();
      await expect(recovery).rejects.toThrow('BOOT_RECOVERY_ARTIFACT_MISMATCH');

      expect(command.mock.calls.map(([args]) => args[0])).toEqual(['undeploy']);
      expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
        phase: 'blocked',
        mutationOutcomeUnknown: true,
      });
      await expect(manager.assertMissingRecoveryArtifactStageAllowed(
        'ZincAPI',
        current.bootEpoch
      )).rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
      const quarantine = JSON.parse(readFileSync(quarantinePath, 'utf8')) as {
        records: Array<{ operation: string }>;
      };
      expect(quarantine.records).toEqual([
        expect.objectContaining({ operation: 'boot-recovery:GO-ARTIFACT-TOCTOU-001' }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('BEF-32h: missing-artifact staging requires exact epoch, owner and ref/app inventory', async () => {
    const manager = makeManager({
      runtimeIdentityProvider: async () => 'artifact-stage-das',
      runtimeIdentitySyncProvider: () => 'artifact-stage-das',
    });
    let runtimeListed = false;
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockImplementation(async () =>
      runtimeListed ? ['ZincAPI'] : []
    );
    await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 20,
      pollIntervalMs: 1,
      absenceGraceMs: 5,
    });
    const current = manager.getBootDeploymentStatus('ZincAPI');

    await expect(manager.assertMissingRecoveryArtifactStageAllowed(
      'ZincAPI',
      current.bootEpoch
    )).resolves.toBeUndefined();
    await expect(manager.assertMissingRecoveryArtifactStageAllowed(
      'ZincAPI',
      'operator-stale-epoch'
    )).rejects.toThrow('BOOT_EPOCH_MISMATCH');

    runtimeListed = true;
    await expect(manager.assertMissingRecoveryArtifactStageAllowed(
      'ZincAPI',
      current.bootEpoch
    )).rejects.toThrow('BOOT_RECOVERY_STATE_INVALID');

    const unowned = makeManager({
      runtimeIdentityProvider: async () => 'unowned-artifact-stage-das',
      runtimeIdentitySyncProvider: () => 'unowned-artifact-stage-das',
    });
    const unownedEpoch = unowned.getBootDeploymentStatus('ZincAPI').bootEpoch;
    await expect(unowned.assertMissingRecoveryArtifactStageAllowed(
      'ZincAPI',
      unownedEpoch
    )).rejects.toThrow('BOOT_RECOVERY_OWNER_INVALID');
  });

  it('BEF-33: stale or ambiguous authority cannot dispatch boot recovery', async () => {
    const manager = makeManager({
      runtimeIdentityProvider: async () => 'current-das-runtime',
    });
    vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
    const command = vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue('');
    await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 20,
      pollIntervalMs: 1,
      absenceGraceMs: 5,
    });
    const current = manager.getBootDeploymentStatus('ZincAPI');

    await expect(manager.recoverBootDeployment(
      '/tmp/ZincAPI.war',
      'ZincAPI',
      undefined,
      {
        bootEpoch: current.bootEpoch,
        runtimeFingerprint: '0'.repeat(64),
        expectedArtifactSha256: 'f'.repeat(64),
        authorizationId: 'GO-STALE-RUNTIME',
        expectedRuntimeListed: false,
        reason: 'Evidence belongs to a different DAS runtime',
        source: 'BEF-33',
      }
    )).rejects.toThrow('BOOT_RUNTIME_IDENTITY_MISMATCH');
    expect(command).not.toHaveBeenCalled();
  });

  it('BEF-34: stopped no-WAR start rejects a surviving DAS PID without signal or start', async () => {
    const manager = makeManager({
      runtimeIdentityProvider: async () => undefined,
    });
    manager.registerApplication('ZincAPI');
    const safety = manager as unknown as PayaraManagerInternals;
    vi.spyOn(manager, 'isRunning').mockResolvedValue(false);
    vi.spyOn(manager, 'isRunningStrict').mockResolvedValue(false);
    vi.spyOn(safety, 'getPayaraProcessPidsStrict').mockResolvedValue([9191]);
    const command = vi.spyOn(safety, 'asadminCommand').mockResolvedValue('production not running\n');
    const signal = vi.spyOn(safety, 'execCommand').mockResolvedValue({
      stdout: '',
      stderr: '',
    });

    await expect(manager.withStartupFence('ZincAPI', () =>
      manager.start({ waitForApplicationHealth: false })
    )).rejects.toThrow('BOOT_STOPPED_RECOVERY_UNSAFE');

    expect(command).not.toHaveBeenCalledWith(['start-domain', 'production']);
    expect(signal).not.toHaveBeenCalledWith(
      '/bin/kill',
      expect.anything()
    );
  });
});
