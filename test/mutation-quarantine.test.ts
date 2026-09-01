import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayaraManager } from '../src/payara-manager.js';

const logger = pino({ level: 'silent' });

interface ManagerInternals {
  asadminCommand: (args: string[], timeoutMs?: number) => Promise<string>;
  assertRecoveryArtifactCurrentSync: (
    warPath: string,
    expectedArtifactSha256: string
  ) => void;
  minimumBootOwnershipAbsenceGraceMs: () => number;
  monotonicNowMs: () => number;
}

function internals(manager: PayaraManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

function makeManager(
  path: string,
  runtimeIdentity: string,
  user = process.env.USER || 'test'
): PayaraManager {
  const manager = new PayaraManager({
    payaraHome: '/tmp/payara-quarantine-test',
    domain: 'production',
    user,
    logger,
    runtimeIdentityProvider: async () => runtimeIdentity,
    mutationQuarantinePath: path,
  });
  vi.spyOn(internals(manager), 'minimumBootOwnershipAbsenceGraceMs').mockReturnValue(0);
  vi.spyOn(internals(manager), 'monotonicNowMs').mockImplementation(() => Date.now());
  return manager;
}

async function grantEmptyTarget(manager: PayaraManager): Promise<void> {
  vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue([]);
  vi.spyOn(manager, 'listApplications').mockResolvedValue([]);
  await manager.classifyBootOwnership('ZincAPI', {
    timeoutMs: 1,
    pollIntervalMs: 1,
    absenceGraceMs: 0,
  });
}

describe('durable Payara mutation quarantine', () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function newPath(): string {
    const directory = mkdtempSync(join(tmpdir(), 'payara-quarantine-'));
    tempDirectories.push(directory);
    return join(directory, 'mutation.json');
  }

  async function leaveUnknown(path: string, rotateDuringCommand = false): Promise<void> {
    const manager = makeManager(path, 'runtime-a');
    await grantEmptyTarget(manager);
    const command = vi.spyOn(internals(manager), 'asadminCommand')
      .mockImplementation(async args => {
        if (args[0] === 'deploy') {
          const durable = JSON.parse(readFileSync(path, 'utf8')) as {
            records: Array<{ operation: string; runtimeIdentity: string }>;
          };
          expect(durable.records).toEqual([
            expect.objectContaining({
              operation: 'deploy-fresh',
              runtimeIdentity: 'runtime-a',
            }),
          ]);
          if (rotateDuringCommand) {
            manager.fenceExternalRuntimeChange('child-process:restarting');
          }
          throw new Error('remote deploy response lost');
        }
        return '';
      });

    await expect(manager.deployFresh('/tmp/ZincAPI.war', 'ZincAPI'))
      .rejects.toThrow('remote deploy response lost');
    expect(command).toHaveBeenCalledWith(
      expect.arrayContaining(['deploy', '--name=ZincAPI']),
      expect.any(Number)
    );
    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'blocked',
      mutationOutcomeUnknown: true,
      evidenceSource: 'agent-fresh-deploy-outcome-unknown',
    });
  }

  it('MQ-01: arms and fsyncs before the command; a second manager on the same DAS blocks', async () => {
    const path = newPath();
    await leaveUnknown(path);

    const successor = makeManager(path, 'runtime-a');
    const refs = vi.spyOn(successor, 'listApplicationRefs').mockResolvedValue([]);
    const apps = vi.spyOn(successor, 'listApplications').mockResolvedValue([]);

    await expect(successor.classifyBootOwnership('ZincAPI', {
      timeoutMs: 1,
      pollIntervalMs: 1,
      absenceGraceMs: 0,
    })).rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
    expect(refs).not.toHaveBeenCalled();
    expect(apps).not.toHaveBeenCalled();
    expect(successor.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'blocked',
      mutationOutcomeUnknown: true,
    });
  });

  it('MQ-02: a child event plus command timeout poisons the provisional epoch', async () => {
    const path = newPath();
    await leaveUnknown(path, true);

    const successor = makeManager(path, 'runtime-a');
    await expect(successor.withStartupFence('ZincAPI', async () => {
      throw new Error('startup callback must not run');
    })).rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
  });

  it('MQ-03: a replacement runtime cannot clear an ambiguous admin-port mutation', async () => {
    const path = newPath();
    await leaveUnknown(path);

    const successor = makeManager(path, 'runtime-b');
    vi.spyOn(successor, 'listApplicationRefs').mockResolvedValue([]);
    vi.spyOn(successor, 'listApplications').mockResolvedValue([]);
    await expect(successor.classifyBootOwnership('ZincAPI', {
      timeoutMs: 1,
      pollIntervalMs: 1,
      absenceGraceMs: 0,
    })).rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
    expect(successor.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'blocked',
      mutationOutcomeUnknown: true,
    });
    expect(readFileSync(path, 'utf8')).toContain('deploy-fresh');
  });

  it('MQ-04: same-runtime attestation cannot clear an ambiguous fresh deploy', async () => {
    const path = newPath();
    await leaveUnknown(path);

    const successor = makeManager(path, 'runtime-a');
    vi.spyOn(successor, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    vi.spyOn(successor, 'listApplications').mockResolvedValue(['ZincAPI']);
    const blocked = await successor.readBootDeploymentStatus('ZincAPI');
    await expect(successor.attestBootReady('ZincAPI', {
      bootEpoch: blocked.bootEpoch,
      reason: 'Operator verified application readiness after the ambiguous command',
      source: 'MQ-04',
    })).rejects.toThrow('BOOT_ATTESTATION_OPERATION_UNSAFE');

    expect(successor.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'blocked',
      mutationOutcomeUnknown: true,
    });
    expect(readFileSync(path, 'utf8')).toContain('deploy-fresh');
  });

  it('MQ-05: an absent target rejects attestation and leaves the durable record sticky', async () => {
    const path = newPath();
    await leaveUnknown(path);

    const successor = makeManager(path, 'runtime-a');
    vi.spyOn(successor, 'listApplicationRefs').mockResolvedValue([]);
    vi.spyOn(successor, 'listApplications').mockResolvedValue([]);
    const blocked = await successor.readBootDeploymentStatus('ZincAPI');
    await expect(successor.attestBootReady('ZincAPI', {
      bootEpoch: blocked.bootEpoch,
      reason: 'This evidence is intentionally insufficient',
      source: 'MQ-05',
    })).rejects.toThrow('BOOT_ATTESTATION_INVENTORY_MISMATCH');

    expect(readFileSync(path, 'utf8')).toContain('deploy-fresh');
    expect(successor.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'blocked',
      mutationOutcomeUnknown: true,
    });
  });

  it('MQ-06: rejects a relative quarantine path before any runtime work', () => {
    expect(() => new PayaraManager({
      payaraHome: '/tmp/payara-quarantine-test',
      domain: 'production',
      user: process.env.USER || 'test',
      logger,
      mutationQuarantinePath: 'relative/mutation.json',
    })).toThrow('BOOT_QUARANTINE_PATH_INVALID');
  });

  it('MQ-07: creates a private state directory below the real 0750 agent parent', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'payara-quarantine-parent-'));
    tempDirectories.push(parent);
    chmodSync(parent, 0o750);
    const path = join(parent, 'payara-mutation-quarantine', 'state.json');

    await leaveUnknown(path);

    expect(statSync(join(parent, 'payara-mutation-quarantine')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('MQ-08: replace-deploy inventory failure before the first command does not arm UNKNOWN', async () => {
    const path = newPath();
    const manager = makeManager(path, 'runtime-a');
    const refs = vi.spyOn(manager, 'listApplicationRefs').mockResolvedValue(['ZincAPI']);
    const apps = vi.spyOn(manager, 'listApplications').mockResolvedValue(['ZincAPI']);
    const ownership = await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 20,
      pollIntervalMs: 1,
      absenceGraceMs: 5,
    });
    await manager.attestBootReady('ZincAPI', {
      bootEpoch: ownership.bootEpoch,
      reason: 'Stable application baseline before replace-deploy inventory failure',
      source: 'MQ-08',
    });
    refs.mockRejectedValueOnce(new Error('transient inventory outage'));
    const command = vi.spyOn(internals(manager), 'asadminCommand').mockResolvedValue('');

    await expect(manager.deploy('/tmp/ZincAPI.war', 'ZincAPI'))
      .rejects.toThrow('transient inventory outage');
    expect(command.mock.calls.filter(([args]) =>
      args[0] === 'deploy' || args[0] === 'undeploy'
    )).toHaveLength(0);
    expect(() => readFileSync(path, 'utf8')).toThrow();
    expect(manager.getBootDeploymentStatus('ZincAPI')).toMatchObject({
      phase: 'ready',
      mutationOutcomeUnknown: false,
    });
    expect(apps).toHaveBeenCalled();
  });

  it('MQ-09: textual user aliases cannot split one physical domain WAL namespace', async () => {
    const path = newPath();
    const writer = makeManager(path, 'runtime-a', 'payara');
    await grantEmptyTarget(writer);
    vi.spyOn(internals(writer), 'asadminCommand').mockRejectedValue(
      new Error('remote deploy response lost')
    );
    await expect(writer.deployFresh('/tmp/ZincAPI.war', 'ZincAPI'))
      .rejects.toThrow('remote deploy response lost');

    const numericAlias = makeManager(path, 'runtime-a', '1001');
    const refs = vi.spyOn(numericAlias, 'listApplicationRefs').mockResolvedValue([]);
    const apps = vi.spyOn(numericAlias, 'listApplications').mockResolvedValue([]);
    await expect(numericAlias.classifyBootOwnership('ZincAPI', {
      timeoutMs: 1,
      pollIntervalMs: 1,
      absenceGraceMs: 0,
    })).rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
    expect(refs).not.toHaveBeenCalled();
    expect(apps).not.toHaveBeenCalled();
  });

  it('MQ-10: a DAS replacement after WAL arm never resolves the dispatched recovery', async () => {
    const path = newPath();
    let runtimeIdentity = 'runtime-a';
    const manager = new PayaraManager({
      payaraHome: '/tmp/payara-quarantine-test',
      domain: 'production',
      user: process.env.USER || 'test',
      logger,
      runtimeIdentityProvider: async () => runtimeIdentity,
      runtimeIdentitySyncProvider: () => runtimeIdentity,
      mutationQuarantinePath: path,
    });
    vi.spyOn(internals(manager), 'minimumBootOwnershipAbsenceGraceMs').mockReturnValue(0);
    vi.spyOn(internals(manager), 'monotonicNowMs').mockImplementation(() => Date.now());
    let referenced = true;
    const deployed = false;
    vi.spyOn(manager, 'listApplicationRefs').mockImplementation(async () =>
      referenced ? ['ZincAPI'] : []
    );
    vi.spyOn(manager, 'listApplications').mockImplementation(async () =>
      deployed ? ['ZincAPI'] : []
    );
    await manager.classifyBootOwnership('ZincAPI', {
      timeoutMs: 20,
      pollIntervalMs: 1,
      absenceGraceMs: 5,
    });
    const authorized = manager.getBootDeploymentStatus('ZincAPI');
    const mutationCommands: string[] = [];
    vi.spyOn(internals(manager), 'asadminCommand').mockImplementation(async args => {
      if (args[0] === 'undeploy') {
        mutationCommands.push('undeploy');
        referenced = false;
        runtimeIdentity = 'runtime-b';
      }
      return '';
    });
    vi.spyOn(internals(manager), 'assertRecoveryArtifactCurrentSync')
      .mockImplementation(() => undefined);

    await expect(manager.recoverBootDeployment(
      '/tmp/ZincAPI.war',
      'ZincAPI',
      undefined,
      {
        bootEpoch: authorized.bootEpoch,
        runtimeFingerprint: authorized.runtimeFingerprint!,
        expectedArtifactSha256: 'f'.repeat(64),
        authorizationId: 'GO-RUNTIME-SWAP-AFTER-WAL-001',
        expectedRuntimeListed: false,
        reason: 'Exercise a replacement after the command was dispatched',
        source: 'MQ-10',
      }
    )).rejects.toThrow();

    expect(mutationCommands).toEqual(['undeploy']);
    expect(readFileSync(path, 'utf8')).toContain('boot-recovery');

    const successor = makeManager(path, 'runtime-b');
    vi.spyOn(successor, 'listApplicationRefs').mockResolvedValue([]);
    vi.spyOn(successor, 'listApplications').mockResolvedValue([]);
    await expect(successor.classifyBootOwnership('ZincAPI', {
      timeoutMs: 1,
      pollIntervalMs: 1,
      absenceGraceMs: 0,
    })).rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
  });
});
