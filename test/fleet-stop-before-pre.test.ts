import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentGet,
  agentPost,
  clearEndpointOverride,
  setEndpointOverride,
} from '@zincapp/znvault-deploy-core';
import type { CLIPluginContext, DeployConfig, HAProxyConfig } from '../src/cli/types.js';
import {
  enforceFleetStopBeforePre,
  finalizeFleetOutageFence,
  releaseFleetOutageFence,
  restoreFleetTrafficAfterSuccessfulRollout,
  validateFleetStopBeforePreRequest,
  type FleetStopDependencies,
  type FleetStopGroup,
} from '../src/cli/fleet-stop-before-pre.js';
import {
  completeFleetOutageJournal,
  markFleetOutageCommitAuthorized,
  openFleetOutageJournal,
} from '../src/cli/fleet-outage-journal.js';

const API_A = 'api-a.example.test';
const API_B = 'api-b.example.test';
const WORKER = 'worker.example.test';
const TOKEN = 'test-control-token-0123456789abcdef';
const OUTAGE_OWNER = '11111111-1111-4111-8111-111111111111';
const TARGET_CONTENT_SHA256 = 'c'.repeat(64);
const PREVIOUS_ARTIFACT = {
  size: 512,
  sha256: 'a'.repeat(64),
  contentSha256: 'b'.repeat(64),
};
const previousJournalStateDir = process.env.ZNVAULT_PAYARA_FLEET_OUTAGE_STATE_DIR;
let testJournalStateDir: string;
beforeEach(() => {
  testJournalStateDir = mkdtempSync(join(tmpdir(), 'payara-fleet-journal-'));
  process.env.ZNVAULT_PAYARA_FLEET_OUTAGE_STATE_DIR = testJournalStateDir;
});
afterEach(() => {
  rmSync(testJournalStateDir, { recursive: true, force: true });
});
afterAll(() => {
  if (previousJournalStateDir === undefined) {
    delete process.env.ZNVAULT_PAYARA_FLEET_OUTAGE_STATE_DIR;
  } else {
    process.env.ZNVAULT_PAYARA_FLEET_OUTAGE_STATE_DIR = previousJournalStateDir;
  }
});

function preparedStoppedStatus(
  host: string,
  outageOwnerId = OUTAGE_OWNER,
  targetContentSha256 = TARGET_CONTENT_SHA256,
) {
  return {
    outageFenced: true,
    outageOwnerId,
    targetContentSha256,
    preparedStopped: true,
    running: false,
    processCount: 0,
    receiptPhase: 'stopped',
    receiptId: `receipt-${host}`,
    artifact: PREVIOUS_ARTIFACT,
  };
}

function deployedStatus(host: string, outageOwnerId: string) {
  const target = { ...PREVIOUS_ARTIFACT, contentSha256: TARGET_CONTENT_SHA256 };
  return {
    outageFenced: true,
    outageOwnerId,
    targetContentSha256: TARGET_CONTENT_SHA256,
    preparedStopped: false,
    running: true,
    processCount: 1,
    receiptPhase: 'deployed',
    receiptId: `receipt-${host}`,
    applicationDeployed: true,
    artifact: PREVIOUS_ARTIFACT,
    currentArtifact: target,
    deployedArtifact: target,
  };
}

function deployedStoppedStatus(host: string, outageOwnerId: string) {
  return {
    ...deployedStatus(host, outageOwnerId),
    running: false,
    processCount: 0,
    applicationDeployed: false,
  };
}

function rolloutStatus(host: string, outageOwnerId: string, running: boolean) {
  return {
    outageFenced: true,
    outageOwnerId,
    targetContentSha256: TARGET_CONTENT_SHA256,
    preparedStopped: false,
    running,
    processCount: running ? 1 : 0,
    receiptPhase: 'rollout',
    receiptId: `receipt-${host}`,
    artifact: PREVIOUS_ARTIFACT,
    currentArtifact: PREVIOUS_ARTIFACT,
  };
}

function haproxy(): HAProxyConfig {
  return {
    hosts: ['lb.example.test'],
    backend: 'api_servers',
    serverMap: {
      [API_A]: 'api_a',
      [API_B]: 'api_b',
    },
    drainWaitSeconds: 0,
  };
}

function productionLikeConfig(): DeployConfig {
  return {
    name: 'production',
    warPath: '/tmp/app.war',
    port: 9100,
    tunnel: true,
    migration: { roleId: 'db-writer', migrationsDir: '/db/pre' },
    classes: [
      { name: 'api', hosts: [API_A, API_B], haproxy: haproxy() },
      { name: 'worker', hosts: [WORKER], blocking: false },
    ],
  };
}

function context(): CLIPluginContext {
  return {
    client: { get: vi.fn(), post: vi.fn() },
    output: {
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      table: vi.fn(),
      keyValue: vi.fn(),
    },
    getConfig: () => ({ url: 'https://vault.example.test' }),
    isPlainMode: () => true,
  };
}

function groups(events: string[] = []): FleetStopGroup[] {
  const tokens = new Map([
    [API_A, TOKEN],
    [API_B, TOKEN],
    [WORKER, TOKEN],
  ]);
  return [
    {
      name: 'api',
      hosts: [API_A, API_B],
      port: 9100,
      useTLS: false,
      haproxy: haproxy(),
      mutationAuthTokens: tokens,
      targetContentSha256: TARGET_CONTENT_SHA256,
      activateControlPlane: () => events.push('activate:api'),
    },
    {
      name: 'worker',
      hosts: [WORKER],
      port: 9100,
      useTLS: false,
      quiesce: { enabled: true, pollMs: 1, drainTimeoutMs: 10 },
      mutationAuthTokens: tokens,
      targetContentSha256: TARGET_CONTENT_SHA256,
      activateControlPlane: () => events.push('activate:worker'),
    },
  ];
}

function successfulDependencies(events: string[] = []): FleetStopDependencies {
  const stopped = new Set<string>();
  const outageOwners = new Map<string, string>();
  return {
    drainServer: vi.fn(async (_config, host) => {
      events.push(`drain:${host}`);
      return { success: true, results: [{ host: 'lb.example.test', success: true }] };
    }),
    quiesceScheduler: vi.fn(async host => {
      events.push(`quiesce:${host}`);
      return { available: true, inFlightUnits: 0 };
    }),
    schedulerStatus: vi.fn(async host => {
      events.push(`scheduler-status:${host}`);
      return { available: true, quiesced: true, inFlightUnits: 0 };
    }),
    agentPost: vi.fn(async (url, body) => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      events.push(`stop:${host}`);
      stopped.add(host);
      const request = body as {
        outageOwnerId: string;
        targetContentSha256: string;
      };
      outageOwners.set(host, request.outageOwnerId);
      return {
        status: 'stopped-for-deployment',
        applicationAbsent: true,
        receiptId: `receipt-${host}`,
        outageOwnerId: request.outageOwnerId,
        targetContentSha256: request.targetContentSha256,
        artifact: PREVIOUS_ARTIFACT,
      };
    }) as FleetStopDependencies['agentPost'],
    agentGet: vi.fn(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      if (stopped.has(host)) {
        events.push(`verify:${host}`);
        return preparedStoppedStatus(host, outageOwners.get(host));
      }
      events.push(`prepared-status:${host}`);
      return {
        outageFenced: false,
        preparedStopped: false,
        running: true,
        processCount: 1,
      };
    }) as FleetStopDependencies['agentGet'],
    sleep: vi.fn(async () => undefined),
    now: vi.fn(() => 0),
  };
}

function firstIndex(events: string[], prefix: string): number {
  return events.findIndex(event => event.startsWith(prefix));
}

function lastIndex(events: string[], prefix: string): number {
  return events.reduce(
    (found, event, index) => event.startsWith(prefix) ? index : found,
    -1,
  );
}

describe('strict fleet-stop request validation', () => {
  it('does not alter any historical request when the capability flag is absent', () => {
    expect(validateFleetStopBeforePreRequest(
      { name: 'legacy' },
      { runPre: false, runRollout: false },
      {},
    )).toEqual([]);
  });

  it('accepts a complete production-like API + unrouted worker fleet', () => {
    expect(validateFleetStopBeforePreRequest(
      productionLikeConfig(),
      { runPre: true, runRollout: true },
      { requireFleetStopBeforePre: true },
    )).toEqual([]);
  });

  it('accepts a flat mixed fleet and treats hosts outside serverMap as workers', () => {
    const config: DeployConfig = {
      name: 'mixed-flat',
      hosts: [API_A, WORKER],
      tunnel: true,
      migration: { roleId: 'db-writer', migrationsDir: '/db/pre' },
      haproxy: {
        ...haproxy(),
        serverMap: { [API_A]: 'api_a' },
      },
    };

    expect(validateFleetStopBeforePreRequest(
      config,
      { runPre: true, runRollout: true },
      { requireFleetStopBeforePre: true },
    )).toEqual([]);
  });

  it.each([
    ['missing pre migration', (config: DeployConfig) => { delete config.migration; }, {}, { runPre: true, runRollout: true }],
    ['pre skipped', () => undefined, { skipPre: true }, { runPre: false, runRollout: true }],
    ['rollout skipped', () => undefined, { preOnly: true }, { runPre: true, runRollout: false }],
    ['HAProxy drain skipped', () => undefined, { skipDrain: true }, { runPre: true, runRollout: true }],
    ['host scoped', () => undefined, { host: [API_A] }, { runPre: true, runRollout: true }],
    ['class scoped', () => undefined, { class: ['api'] }, { runPre: true, runRollout: true }],
    ['no routed class', (config: DeployConfig) => { config.classes = [{ name: 'worker', hosts: [WORKER], blocking: false }]; }, {}, { runPre: true, runRollout: true }],
    ['no HAProxy endpoints', (config: DeployConfig) => { config.classes![0]!.haproxy!.hosts = []; }, {}, { runPre: true, runRollout: true }],
  ])('rejects %s', (_name, mutate, flags, plan) => {
    const config = productionLikeConfig();
    mutate(config);
    expect(validateFleetStopBeforePreRequest(config, plan, {
      requireFleetStopBeforePre: true,
      ...flags,
    })).not.toEqual([]);
  });

  it('rejects flat and inherited multi-class direct transports', () => {
    const flat: DeployConfig = {
      name: 'flat',
      hosts: [API_A],
      tunnel: false,
      migration: { roleId: 'db-writer', migrationsDir: '/db/pre' },
      haproxy: haproxy(),
    };
    expect(validateFleetStopBeforePreRequest(
      flat,
      { runPre: true, runRollout: true },
      { requireFleetStopBeforePre: true },
    ).join(' ')).toContain('tunnel=true');

    const multi = productionLikeConfig();
    multi.classes![1]!.tunnel = false;
    expect(validateFleetStopBeforePreRequest(
      multi,
      { runPre: true, runRollout: true },
      { requireFleetStopBeforePre: true },
    ).join(' ')).toContain("class 'worker'");
  });

  it('rejects a host assigned to more than one class', () => {
    const config = productionLikeConfig();
    config.classes![1]!.hosts = [API_A];

    expect(validateFleetStopBeforePreRequest(
      config,
      { runPre: true, runRollout: true },
      { requireFleetStopBeforePre: true },
    ).join(' ')).toContain(`duplicate host(s): ${API_A}`);
  });
});

describe('strict fleet-stop execution', () => {
  it('serializes fresh rollout owners before scheduler or Payara mutation', () => {
    const first = openFleetOutageJournal(groups());

    expect(() => openFleetOutageJournal(groups()))
      .toThrow('FLEET_OUTAGE_ALREADY_ACTIVE');

    completeFleetOutageJournal(markFleetOutageCommitAuthorized(first));
  });

  it('recovers the exact journal left durable before active.lock publication', () => {
    const first = openFleetOutageJournal(groups());
    rmSync(join(testJournalStateDir, 'active.lock'));

    const recovered = openFleetOutageJournal(groups());

    expect(recovered).toMatchObject({
      outageOwnerId: first.outageOwnerId,
      outageCapability: first.outageCapability,
      manifestSha256: first.manifestSha256,
    });
    completeFleetOutageJournal(markFleetOutageCommitAuthorized(recovered));
  });

  it('reclaims a dead exact active.lock without changing the private rollout identity', () => {
    const first = openFleetOutageJournal(groups());
    const path = join(testJournalStateDir, 'active.lock');
    const stale = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const staleToken = stale.token;
    writeFileSync(path, `${JSON.stringify({
      ...stale,
      processInstanceId: '11111111-1111-4111-8111-111111111111',
    })}\n`);

    const recovered = openFleetOutageJournal(groups(), first.outageOwnerId);
    const replacement = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

    expect(recovered.outageCapability).toBe(first.outageCapability);
    expect(replacement.token).not.toBe(staleToken);
    expect(replacement.outageOwnerId).toBe(first.outageOwnerId);
    completeFleetOutageJournal(markFleetOutageCommitAuthorized(recovered));
  });

  it('repairs the exact active.lock temp alias left after hard-link publication', () => {
    const first = openFleetOutageJournal(groups());
    const path = join(testJournalStateDir, 'active.lock');
    const temporary = join(
      testJournalStateDir,
      '.active.123.11111111-1111-4111-8111-111111111111.tmp',
    );
    linkSync(path, temporary);

    const authorized = markFleetOutageCommitAuthorized(first);

    expect(() => readFileSync(temporary, 'utf8')).toThrow();
    completeFleetOutageJournal(authorized);
  });

  it('never lets completion of one rollout delete a live successor lock', () => {
    const first = markFleetOutageCommitAuthorized(openFleetOutageJournal(groups()));
    const path = join(testJournalStateDir, 'active.lock');
    const successor = {
      ...(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>),
      outageOwnerId: '22222222-2222-4222-8222-222222222222',
      manifestSha256: 'd'.repeat(64),
      capabilitySha256: 'e'.repeat(64),
      token: '33333333-3333-4333-8333-333333333333',
    };
    writeFileSync(path, `${JSON.stringify(successor)}\n`);

    expect(() => completeFleetOutageJournal(first))
      .toThrow('FLEET_OUTAGE_ALREADY_ACTIVE');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(successor);
  });

  it('rejects duplicate hosts before any direct barrier side effect', async () => {
    const deps = successfulDependencies();
    const duplicateGroups = groups();
    duplicateGroups[1]!.hosts = [API_A];

    await expect(
      enforceFleetStopBeforePre(duplicateGroups, context(), deps)
    ).rejects.toThrow('FLEET_STOP_DUPLICATE_HOSTS');
    expect(deps.drainServer).not.toHaveBeenCalled();
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
    expect(deps.agentGet).not.toHaveBeenCalled();
  });

  it('rejects a direct barrier call without routed hosts before any mutation', async () => {
    const deps = successfulDependencies();
    const [apiGroup] = groups();
    const unrouted = { ...apiGroup!, haproxy: undefined };

    await expect(
      enforceFleetStopBeforePre([unrouted], context(), deps)
    ).rejects.toThrow('FLEET_STOP_NO_ROUTED_HOSTS');
    expect(deps.drainServer).not.toHaveBeenCalled();
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it.each(['general', 'legacy-or-invalid'] as const)(
    'rejects a stale %s mutation lock before draining traffic',
    async mutationLockOwnerKind => {
      const deps = successfulDependencies();
      vi.mocked(deps.agentGet).mockResolvedValueOnce({
        mutationLockStale: true,
        mutationLockOwnerKind,
        outageFenced: false,
        preparedStopped: false,
        running: true,
        processCount: 1,
      } as never);

      await expect(enforceFleetStopBeforePre(groups(), context(), deps))
        .rejects.toThrow('FLEET_STOP_MUTATION_LOCK_PREFLIGHT_FAILED');
      expect(deps.agentGet).toHaveBeenCalledTimes(3);
      expect(deps.drainServer).not.toHaveBeenCalled();
      expect(deps.quiesceScheduler).not.toHaveBeenCalled();
      expect(deps.agentPost).not.toHaveBeenCalled();
    },
  );

  it('rejects an outage-scoped stale lock without a durable outage receipt before draining traffic', async () => {
    const deps = successfulDependencies();
    vi.mocked(deps.agentGet).mockResolvedValue({
      mutationLockStale: true,
      mutationLockOwnerKind: 'payara-outage',
      outageFenced: false,
      preparedStopped: false,
      running: true,
      processCount: 1,
    } as never);

    await expect(enforceFleetStopBeforePre(groups(), context(), deps))
      .rejects.toThrow('no durable outage receipt');
    expect(deps.agentGet).toHaveBeenCalledTimes(3);
    expect(deps.drainServer).not.toHaveBeenCalled();
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('allows an exact outage-scoped stale lock into capability recovery', async () => {
    const deps = successfulDependencies();
    const saved = openFleetOutageJournal(groups());
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      return {
        ...preparedStoppedStatus(host, saved.outageOwnerId),
        mutationLockStale: true,
        mutationLockOwnerKind: 'payara-outage',
      } as never;
    });

    await expect(enforceFleetStopBeforePre(groups(), context(), deps)).resolves.toMatchObject({
      outageOwnerId: saved.outageOwnerId,
    });
    expect(deps.drainServer).toHaveBeenCalledTimes(2);
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('rejects an outage-scoped stale lock without its private journal before draining traffic', async () => {
    const deps = successfulDependencies();
    const saved = openFleetOutageJournal(groups());
    rmSync(join(testJournalStateDir, `${saved.outageOwnerId}.json`));
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      return {
        ...preparedStoppedStatus(host, saved.outageOwnerId),
        mutationLockStale: true,
        mutationLockOwnerKind: 'payara-outage',
      } as never;
    });

    await expect(enforceFleetStopBeforePre(groups(), context(), deps))
      .rejects.toThrow('FLEET_OUTAGE_CAPABILITY_MISSING');
    expect(deps.agentGet).toHaveBeenCalledTimes(3);
    expect(deps.drainServer).not.toHaveBeenCalled();
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('orders drain -> quiesce -> zero-in-flight proof -> stop -> process-absence proof', async () => {
    const events: string[] = [];
    const deps = successfulDependencies(events);
    await enforceFleetStopBeforePre(groups(events), context(), deps);

    expect(events.filter(event => event.startsWith('drain:'))).toHaveLength(2);
    expect(events.filter(event => event.startsWith('prepared-status:'))).toHaveLength(6);
    expect(events.filter(event => event.startsWith('quiesce:'))).toHaveLength(6);
    expect(events.filter(event => event.startsWith('scheduler-status:'))).toHaveLength(6);
    expect(events.filter(event => event.startsWith('stop:'))).toHaveLength(3);
    expect(events.filter(event => event.startsWith('verify:'))).toHaveLength(3);
    expect(lastIndex(events, 'drain:')).toBeLessThan(firstIndex(events, 'quiesce:'));
    expect(firstIndex(events, 'quiesce:')).toBeLessThan(firstIndex(events, 'scheduler-status:'));
    expect(lastIndex(events, 'scheduler-status:')).toBeLessThan(lastIndex(events, 'stop:'));
    expect(lastIndex(events, 'stop:')).toBeLessThan(firstIndex(events, 'verify:'));
    expect(vi.mocked(deps.agentPost).mock.calls.every(([url]) =>
      url.endsWith('/plugins/payara/stop-for-deployment')
    )).toBe(true);
  });

  it('waits the configured HAProxy drain window after every drain receipt', async () => {
    const events: string[] = [];
    const [apiGroup] = groups(events);
    apiGroup!.hosts = [API_A, API_B];
    apiGroup!.haproxy = { ...haproxy(), drainWaitSeconds: 3 };
    const deps = successfulDependencies(events);
    deps.sleep = vi.fn(async milliseconds => {
      events.push(`wait:${milliseconds}`);
    });

    await enforceFleetStopBeforePre([apiGroup!], context(), deps);

    expect(events.filter(event => event.startsWith('drain:'))).toHaveLength(2);
    expect(events.filter(event => event === 'wait:3000')).toHaveLength(1);
    expect(lastIndex(events, 'drain:')).toBeLessThan(firstIndex(events, 'wait:'));
    expect(lastIndex(events, 'wait:')).toBeLessThan(firstIndex(events, 'quiesce:'));
  });

  it('drains only routed hosts while strictly stopping every flat worker too', async () => {
    const events: string[] = [];
    const [apiGroup] = groups(events);
    const mixedGroup: FleetStopGroup = {
      ...apiGroup!,
      hosts: [API_A, WORKER],
      haproxy: {
        ...haproxy(),
        serverMap: { [API_A]: 'api_a' },
      },
    };
    const deps = successfulDependencies(events);

    await enforceFleetStopBeforePre([mixedGroup], context(), deps);

    expect(deps.drainServer).toHaveBeenCalledOnce();
    expect(deps.drainServer).toHaveBeenCalledWith(mixedGroup.haproxy, API_A);
    expect(deps.quiesceScheduler).toHaveBeenCalledTimes(4);
    expect(deps.agentPost).toHaveBeenCalledTimes(2);
    expect(deps.agentGet).toHaveBeenCalledTimes(6);
  });

  it('fails after any partial HAProxy drain and never touches scheduler or Payara', async () => {
    const deps = successfulDependencies();
    vi.mocked(deps.drainServer).mockResolvedValueOnce({
      success: false,
      results: [{ host: 'lb.example.test', success: false, error: 'socket rejected' }],
    });

    await expect(
      enforceFleetStopBeforePre(groups(), context(), deps)
    ).rejects.toThrow('FLEET_STOP_DRAIN_FAILED');
    expect(deps.drainServer).toHaveBeenCalledTimes(2);
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
    expect(deps.agentGet).toHaveBeenCalledTimes(3);
  });

  it('rejects an aggregate drain success without one receipt per load balancer', async () => {
    const deps = successfulDependencies();
    vi.mocked(deps.drainServer).mockResolvedValueOnce({
      success: true,
      results: [],
    });

    await expect(
      enforceFleetStopBeforePre(groups(), context(), deps)
    ).rejects.toThrow('expected one DRAIN receipt, observed 0');
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
  });

  it('fails closed when scheduler quiesce is unavailable on any host', async () => {
    const deps = successfulDependencies();
    vi.mocked(deps.quiesceScheduler).mockResolvedValueOnce({
      available: false,
      reason: 'old znapi',
    });

    await expect(
      enforceFleetStopBeforePre(groups(), context(), deps)
    ).rejects.toThrow('FLEET_STOP_QUIESCE_FAILED');
    expect(deps.quiesceScheduler).toHaveBeenCalledTimes(3);
    expect(deps.schedulerStatus).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable', { available: false, reason: 'status endpoint down' }],
    ['not quiesced', { available: true, quiesced: false, inFlightUnits: 0 }],
  ])('fails closed when scheduler drain proof is %s', async (_name, result) => {
    const deps = successfulDependencies();
    vi.mocked(deps.schedulerStatus).mockResolvedValueOnce(result as never);

    await expect(
      enforceFleetStopBeforePre(groups(), context(), deps)
    ).rejects.toThrow('FLEET_STOP_SCHEDULER_DRAIN_FAILED');
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('fails closed on scheduler drain timeout', async () => {
    const deps = successfulDependencies();
    vi.mocked(deps.schedulerStatus).mockResolvedValue({
      available: true,
      quiesced: true,
      inFlightUnits: 2,
    });
    let clock = 0;
    vi.mocked(deps.now).mockImplementation(() => {
      clock += 200_000;
      return clock;
    });

    await expect(
      enforceFleetStopBeforePre(groups(), context(), deps)
    ).rejects.toThrow('FLEET_STOP_SCHEDULER_DRAIN_FAILED');
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('attempts and verifies every stop but rejects one failed stop receipt', async () => {
    const deps = successfulDependencies();
    vi.mocked(deps.agentPost).mockImplementation(async (url, body) => {
      if (url.includes(API_A)) throw new Error('stop timeout');
      const request = body as {
        outageOwnerId: string;
        targetContentSha256: string;
      };
      return {
        status: 'stopped-for-deployment',
        applicationAbsent: true,
        receiptId: `receipt-${url}`,
        outageOwnerId: request.outageOwnerId,
        targetContentSha256: request.targetContentSha256,
        artifact: PREVIOUS_ARTIFACT,
      } as never;
    });

    await expect(
      enforceFleetStopBeforePre(groups(), context(), deps)
    ).rejects.toThrow('FLEET_STOP_PAYARA_NOT_PROVEN');
    expect(deps.agentPost).toHaveBeenCalledTimes(3);
    expect(deps.agentGet).toHaveBeenCalledTimes(9);
  });

  it.each([
    ['legacy plain-stop receipt', { status: 'stopped' }],
    ['missing application-absence proof', { status: 'stopped-for-deployment' }],
  ])('rejects an incomplete deployment-stop receipt: %s', async (_name, receipt) => {
    const deps = successfulDependencies();
    vi.mocked(deps.agentPost).mockResolvedValueOnce(receipt as never);

    await expect(
      enforceFleetStopBeforePre(groups(), context(), deps)
    ).rejects.toThrow('FLEET_STOP_PAYARA_NOT_PROVEN');
    expect(deps.agentGet).toHaveBeenCalledTimes(9);
  });

  it.each([
    ['still running', {
      outageFenced: false,
      preparedStopped: false,
      running: true,
      processCount: 1,
    }],
    ['missing process evidence', { preparedStopped: true, running: false }],
  ])('rejects incomplete Payara absence proof: %s', async (_name, result) => {
    const deps = successfulDependencies();
    let calls = 0;
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      calls += 1;
      if (calls === 7) return result as never;
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      return calls <= 6
        ? {
            outageFenced: false,
            preparedStopped: false,
            running: true,
            processCount: 1,
          } as never
        : preparedStoppedStatus(host) as never;
    });

    await expect(
      enforceFleetStopBeforePre(groups(), context(), deps)
    ).rejects.toThrow('FLEET_STOP_PAYARA_NOT_PROVEN');
    expect(deps.agentGet).toHaveBeenCalledTimes(9);
  });

  it('retries an all-stopped fleet using matching durable receipts without scheduler or stop I/O', async () => {
    const deps = successfulDependencies();
    const saved = openFleetOutageJournal(groups());
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      return preparedStoppedStatus(host, saved.outageOwnerId) as never;
    });

    await enforceFleetStopBeforePre(groups(), context(), deps);

    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.schedulerStatus).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
    expect(deps.agentGet).toHaveBeenCalledTimes(9);
  });

  it('retries a mixed fleet by stopping only running hosts and still re-proves global PID0', async () => {
    const deps = successfulDependencies();
    const saved = openFleetOutageJournal(groups());
    const newlyStopped = new Set<string>();
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      if (host === API_A || newlyStopped.has(host)) {
        return preparedStoppedStatus(host, saved.outageOwnerId) as never;
      }
      return {
        outageFenced: false,
        preparedStopped: false,
        running: true,
        processCount: 1,
      } as never;
    });
    vi.mocked(deps.agentPost).mockImplementation(async (url, body) => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      newlyStopped.add(host);
      const request = body as {
        outageOwnerId: string;
        targetContentSha256: string;
      };
      return {
        status: 'stopped-for-deployment',
        applicationAbsent: true,
        receiptId: `receipt-${host}`,
        outageOwnerId: request.outageOwnerId,
        targetContentSha256: request.targetContentSha256,
        artifact: PREVIOUS_ARTIFACT,
      } as never;
    });

    await enforceFleetStopBeforePre(groups(), context(), deps);

    expect(deps.agentPost).toHaveBeenCalledTimes(2);
    expect(deps.quiesceScheduler).toHaveBeenCalledTimes(4);
    expect(deps.schedulerStatus).toHaveBeenCalledTimes(4);
    expect(deps.agentGet).toHaveBeenCalledTimes(9);
  });

  it.each(['arming', 'prepared'] as const)(
    're-enters an interrupted %s stop with the same owner and exact artifact',
    async receiptPhase => {
      const deps = successfulDependencies();
      const saved = openFleetOutageJournal(groups());
      let statusCalls = 0;
      vi.mocked(deps.agentGet).mockImplementation(async url => {
        const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
        statusCalls += 1;
        if (statusCalls <= 6) {
          return {
            outageFenced: true,
            outageOwnerId: saved.outageOwnerId,
            targetContentSha256: TARGET_CONTENT_SHA256,
            preparedStopped: false,
            running: true,
            processCount: 1,
            receiptPhase,
            receiptId: `receipt-${host}`,
            artifact: PREVIOUS_ARTIFACT,
          } as never;
        }
        return preparedStoppedStatus(host, saved.outageOwnerId) as never;
      });

      await expect(enforceFleetStopBeforePre(groups(), context(), deps)).resolves.toMatchObject({
        outageOwnerId: saved.outageOwnerId,
      });
      expect(deps.quiesceScheduler).toHaveBeenCalledTimes(6);
      expect(deps.schedulerStatus).toHaveBeenCalledTimes(6);
      expect(deps.agentPost).toHaveBeenCalledTimes(3);
      expect(deps.agentGet).toHaveBeenCalledTimes(9);
    },
  );

  it('commits a prepared receipt left at PID0 without trying to quiesce a stopped JVM', async () => {
    const deps = successfulDependencies();
    const saved = openFleetOutageJournal(groups());
    let statusCalls = 0;
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      statusCalls += 1;
      return statusCalls <= 6
        ? {
            outageFenced: true,
            outageOwnerId: saved.outageOwnerId,
            targetContentSha256: TARGET_CONTENT_SHA256,
            preparedStopped: false,
            running: false,
            processCount: 0,
            receiptPhase: 'prepared',
            receiptId: `receipt-${host}`,
            artifact: PREVIOUS_ARTIFACT,
          } as never
        : preparedStoppedStatus(host, saved.outageOwnerId) as never;
    });

    await expect(enforceFleetStopBeforePre(groups(), context(), deps)).resolves.toMatchObject({
      outageOwnerId: saved.outageOwnerId,
    });
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.schedulerStatus).not.toHaveBeenCalled();
    expect(deps.agentPost).toHaveBeenCalledTimes(3);
  });

  it('resumes a partial rollout without stopping an exact deployed target again', async () => {
    const deps = successfulDependencies();
    const saved = openFleetOutageJournal(groups());
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      return host === API_A
        ? deployedStatus(host, saved.outageOwnerId) as never
        : preparedStoppedStatus(host, saved.outageOwnerId) as never;
    });

    await expect(enforceFleetStopBeforePre(groups(), context(), deps)).resolves.toMatchObject({
      outageOwnerId: saved.outageOwnerId,
      alreadyDeployedHosts: [API_A],
    });
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.schedulerStatus).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('re-enters rollout receipts from either a running JVM or PID0', async () => {
    const deps = successfulDependencies();
    const saved = openFleetOutageJournal(groups());
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      if (host === API_A) return rolloutStatus(host, saved.outageOwnerId, true) as never;
      if (host === API_B) return rolloutStatus(host, saved.outageOwnerId, false) as never;
      return preparedStoppedStatus(host, saved.outageOwnerId) as never;
    });

    await expect(enforceFleetStopBeforePre(groups(), context(), deps)).resolves.toMatchObject({
      outageOwnerId: saved.outageOwnerId,
    });
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('resumes a deployed PID0 host before post without requiring a post-complete journal', async () => {
    const deps = successfulDependencies();
    const saved = openFleetOutageJournal(groups());
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      return host === API_A
        ? deployedStoppedStatus(host, saved.outageOwnerId) as never
        : preparedStoppedStatus(host, saved.outageOwnerId) as never;
    });

    const resumed = await enforceFleetStopBeforePre(groups(), context(), deps);

    expect(resumed).toMatchObject({
      outageOwnerId: saved.outageOwnerId,
      commitAuthorized: false,
    });
    expect(resumed.resumeCommitOnly).not.toBe(true);
    // The caller must run its idempotent pre phase and dispatch every host.
    // A PID0 receipt proves the exact target, but does not prove a live deploy.
    expect(resumed.alreadyDeployedHosts).toBeUndefined();
    expect(resumed.alreadyFinalizedHosts).toBeUndefined();
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('rejects a releasing runtime mixed with deployed PID0 before post-complete is durable', async () => {
    const deps = successfulDependencies();
    const saved = openFleetOutageJournal(groups());
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      if (host === API_A) {
        return {
          outageFenced: true,
          outageOwnerId: saved.outageOwnerId,
          targetContentSha256: TARGET_CONTENT_SHA256,
          preparedStopped: false,
          running: true,
          processCount: 1,
          receiptPhase: 'releasing',
          receiptId: `receipt-${host}`,
          applicationDeployed: true,
          artifact: PREVIOUS_ARTIFACT,
          deployedArtifact: { ...PREVIOUS_ARTIFACT, contentSha256: TARGET_CONTENT_SHA256 },
        } as never;
      }
      if (host === API_B) return deployedStoppedStatus(host, saved.outageOwnerId) as never;
      return preparedStoppedStatus(host, saved.outageOwnerId) as never;
    });

    await expect(enforceFleetStopBeforePre(groups(), context(), deps))
      .rejects.toThrow('FLEET_OUTAGE_RELEASE_RECOVERY_UNPROVEN');
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.schedulerStatus).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('rejects a running pending-stop receipt without exact base artifact evidence', async () => {
    const deps = successfulDependencies();
    const saved = openFleetOutageJournal(groups());
    vi.mocked(deps.agentGet).mockResolvedValue({
      outageFenced: true,
      outageOwnerId: saved.outageOwnerId,
      targetContentSha256: TARGET_CONTENT_SHA256,
      preparedStopped: false,
      running: true,
      processCount: 1,
      receiptPhase: 'arming',
      receiptId: 'receipt-without-artifact',
    } as never);

    await expect(enforceFleetStopBeforePre(groups(), context(), deps))
      .rejects.toThrow('FLEET_STOP_MUTATION_LOCK_PREFLIGHT_FAILED');
    expect(deps.drainServer).not.toHaveBeenCalled();
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('resumes only commit when every host is releasing and post-complete is durable', async () => {
    const deps = successfulDependencies();
    const saved = markFleetOutageCommitAuthorized(openFleetOutageJournal(groups()));
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      return {
        outageFenced: true,
        outageOwnerId: saved.outageOwnerId,
        targetContentSha256: TARGET_CONTENT_SHA256,
        preparedStopped: false,
        running: true,
        processCount: 1,
        receiptPhase: 'releasing',
        receiptId: `receipt-${host}`,
        applicationDeployed: true,
        artifact: PREVIOUS_ARTIFACT,
        deployedArtifact: { ...PREVIOUS_ARTIFACT, contentSha256: TARGET_CONTENT_SHA256 },
      } as never;
    });

    await expect(enforceFleetStopBeforePre(groups(), context(), deps)).resolves.toMatchObject({
      outageOwnerId: saved.outageOwnerId,
      commitAuthorized: true,
      resumeCommitOnly: true,
    });
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
    completeFleetOutageJournal(saved);
  });

  it('recovers a mixed post-complete reboot with releasing and deployed hosts at PID0', async () => {
    const deps = successfulDependencies();
    const saved = markFleetOutageCommitAuthorized(openFleetOutageJournal(groups()));
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      if (host === API_A) {
        return {
          ...deployedStoppedStatus(host, saved.outageOwnerId),
          receiptPhase: 'releasing',
        } as never;
      }
      if (host === API_B) return deployedStoppedStatus(host, saved.outageOwnerId) as never;
      return {
        outageFenced: false,
        preparedStopped: false,
        running: true,
        processCount: 1,
        applicationDeployed: true,
        deployedArtifact: {
          ...PREVIOUS_ARTIFACT,
          contentSha256: TARGET_CONTENT_SHA256,
        },
      } as never;
    });

    const recovered = await enforceFleetStopBeforePre(groups(), context(), deps);

    expect(recovered).toMatchObject({
      outageOwnerId: saved.outageOwnerId,
      commitAuthorized: true,
    });
    expect(recovered.resumeCommitOnly).not.toBe(true);
    expect(recovered.alreadyDeployedHosts).toEqual([WORKER]);
    expect(recovered.alreadyFinalizedHosts).toEqual([WORKER]);
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
    completeFleetOutageJournal(saved);
  });

  it('skips finalized peers when post-complete recovery starts only from deployed PID0', async () => {
    const deps = successfulDependencies();
    const saved = markFleetOutageCommitAuthorized(openFleetOutageJournal(groups()));
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      if (host === API_A) return deployedStoppedStatus(host, saved.outageOwnerId) as never;
      return {
        outageFenced: false,
        preparedStopped: false,
        running: true,
        processCount: 1,
        applicationDeployed: true,
        deployedArtifact: {
          ...PREVIOUS_ARTIFACT,
          contentSha256: TARGET_CONTENT_SHA256,
        },
      } as never;
    });

    const recovered = await enforceFleetStopBeforePre(groups(), context(), deps);

    expect(recovered).toMatchObject({
      outageOwnerId: saved.outageOwnerId,
      commitAuthorized: true,
      alreadyDeployedHosts: [API_B, WORKER],
      alreadyFinalizedHosts: [API_B, WORKER],
    });
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
    completeFleetOutageJournal(saved);
  });

  it('recovers after every host finalized before the local post-complete journal was cleared', async () => {
    const deps = successfulDependencies();
    const saved = markFleetOutageCommitAuthorized(openFleetOutageJournal(groups()));
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      if (String(url).endsWith('/scheduler/status')) {
        return {
          available: true,
          quiesced: false,
          inFlightUnits: 0,
          deploymentHold: false,
          holdValid: true,
          outageId: null,
          targetContentSha256: null,
        } as never;
      }
      return {
        outageFenced: false,
        preparedStopped: false,
        running: true,
        processCount: 1,
        applicationDeployed: true,
        deployedArtifact: { ...PREVIOUS_ARTIFACT, contentSha256: TARGET_CONTENT_SHA256 },
      } as never;
    });

    const recovered = await enforceFleetStopBeforePre(groups(), context(), deps);

    expect(recovered).toMatchObject({
      outageOwnerId: saved.outageOwnerId,
      outageCapability: saved.outageCapability,
      commitAuthorized: true,
      resumeCommitOnly: true,
      alreadyFinalizedHosts: [API_A, API_B, WORKER],
    });
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();

    await releaseFleetOutageFence(groups(), recovered, context(), deps);
    await finalizeFleetOutageFence(groups(), recovered, context(), deps);
    expect(deps.agentPost).not.toHaveBeenCalled();
    expect(deps.agentGet).toHaveBeenCalledTimes(9);
  });

  it('fails closed when a host is already stopped without a matching receipt', async () => {
    const deps = successfulDependencies();
    const runningStatus = {
      outageFenced: false,
      preparedStopped: false,
      running: true,
      processCount: 1,
    } as never;
    vi.mocked(deps.agentGet)
      .mockResolvedValueOnce(runningStatus)
      .mockResolvedValueOnce(runningStatus)
      .mockResolvedValueOnce(runningStatus)
      .mockResolvedValueOnce({
        outageFenced: false,
        preparedStopped: false,
        running: false,
        processCount: 0,
      } as never);

    await expect(enforceFleetStopBeforePre(groups(), context(), deps))
      .rejects.toThrow('FLEET_STOP_PREPARED_STATE_INVALID');
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('binds one opaque outage owner and the exact WAR target across the fleet', async () => {
    const deps = successfulDependencies();

    const outage = await enforceFleetStopBeforePre(groups(), context(), deps);

    expect(outage.outageOwnerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const stopBodies = vi.mocked(deps.agentPost).mock.calls.map(call => call[1]);
    expect(stopBodies).toHaveLength(3);
    expect(stopBodies).toEqual(Array.from({ length: 3 }, () => ({
      outageOwnerId: outage.outageOwnerId,
      outageCapability: outage.outageCapability,
      targetContentSha256: TARGET_CONTENT_SHA256,
    })));
  });

  it('fails closed before scheduler or stop I/O when durable fleet owners conflict', async () => {
    const deps = successfulDependencies();
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      return preparedStoppedStatus(
        host,
        host === API_A
          ? OUTAGE_OWNER
          : '22222222-2222-4222-8222-222222222222',
      ) as never;
    });

    await expect(enforceFleetStopBeforePre(groups(), context(), deps))
      .rejects.toThrow('FLEET_STOP_MUTATION_LOCK_PREFLIGHT_FAILED');
    expect(deps.drainServer).not.toHaveBeenCalled();
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });

  it('fails closed when an existing outage fence targets a different WAR', async () => {
    const deps = successfulDependencies();
    vi.mocked(deps.agentGet).mockImplementation(async url => {
      const host = [API_A, API_B, WORKER].find(candidate => url.includes(candidate)) ?? url;
      return preparedStoppedStatus(host, OUTAGE_OWNER, 'd'.repeat(64)) as never;
    });

    await expect(enforceFleetStopBeforePre(groups(), context(), deps))
      .rejects.toThrow('FLEET_STOP_MUTATION_LOCK_PREFLIGHT_FAILED');
    expect(deps.drainServer).not.toHaveBeenCalled();
    expect(deps.quiesceScheduler).not.toHaveBeenCalled();
    expect(deps.agentPost).not.toHaveBeenCalled();
  });
});

describe('fleet-wide outage-fence release', () => {
  const outage = {
    outageOwnerId: OUTAGE_OWNER,
    outageCapability: Buffer.alloc(32, 9).toString('base64url'),
    manifestSha256: 'e'.repeat(64),
  };
  it('requires one exact release receipt from every host', async () => {
    const deps = {
      agentPost: vi.fn(async () => ({
        status: 'outage-release-prepared',
        releasePrepared: true,
        schedulerResumed: true,
      })) as FleetStopDependencies['agentPost'],
      agentGet: vi.fn(async () => ({
        quiesced: false,
        // New work may enter immediately after the atomic release commit; the
        // pre-commit drain was already proven by znapi's fixed receipt.
        inFlightUnits: 3,
        deploymentHold: false,
        holdValid: true,
        outageId: null,
        targetContentSha256: null,
      })) as FleetStopDependencies['agentGet'],
    };

    await releaseFleetOutageFence(groups(), outage, context(), deps);

    expect(deps.agentPost).toHaveBeenCalledTimes(3);
    const releaseCalls = deps.agentPost.mock.calls.filter(([url]) =>
      String(url).endsWith('/stop-for-deployment/release')
    );
    expect(releaseCalls.map(call => call[1])).toEqual(
      Array.from({ length: 3 }, () => ({
        outageOwnerId: OUTAGE_OWNER,
        outageCapability: outage.outageCapability,
        targetContentSha256: TARGET_CONTENT_SHA256,
      })),
    );
  });

  it('fails closed after attempting all hosts when one release is not proven', async () => {
    let calls = 0;
    const deps = {
      agentPost: vi.fn(async () => {
        calls += 1;
        return calls === 2
          ? { status: 'still-fenced', released: false }
          : { status: 'outage-release-prepared', releasePrepared: true, schedulerResumed: true };
      }) as FleetStopDependencies['agentPost'],
      agentGet: vi.fn() as FleetStopDependencies['agentGet'],
    };

    await expect(
      releaseFleetOutageFence(groups(), outage, context(), deps),
    ).rejects.toThrow('FLEET_OUTAGE_RELEASE_FAILED');
    expect(deps.agentPost).toHaveBeenCalledTimes(3);
  });

  it('rejects the legacy three-field scheduler projection at the release gate', async () => {
    const deps = {
      agentPost: vi.fn(async () => ({
        status: 'outage-release-prepared',
        releasePrepared: true,
        schedulerResumed: true,
      })) as FleetStopDependencies['agentPost'],
      agentGet: vi.fn(async () => ({
        available: true,
        quiesced: false,
        inFlightUnits: 0,
      })) as FleetStopDependencies['agentGet'],
    };

    await expect(
      releaseFleetOutageFence(groups(), outage, context(), deps),
    ).rejects.toThrow('FLEET_SCHEDULER_RESUME_UNPROVEN');
    expect(deps.agentGet).toHaveBeenCalledTimes(3);
  });

  it('preserves deployment-hold evidence through the real authenticated JSON client', async () => {
    const requests: Array<{ method?: string; url?: string; authorization?: string; body?: unknown }> = [];
    const server = createServer((request, response) => {
      let rawBody = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { rawBody += chunk; });
      request.on('end', () => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          ...(rawBody ? { body: JSON.parse(rawBody) as unknown } : {}),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        if (request.url === '/plugins/payara/stop-for-deployment/release') {
          response.end(JSON.stringify({
            status: 'outage-release-prepared',
            releasePrepared: true,
            schedulerResumed: true,
          }));
        } else if (request.url === '/scheduler/status') {
          response.end(JSON.stringify({
            quiesced: false,
            inFlightUnits: 0,
            deploymentHold: false,
            outageId: null,
            targetContentSha256: null,
            holdValid: true,
          }));
        } else {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'unexpected route' }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
    setEndpointOverride(API_A, '127.0.0.1', address.port);

    try {
      const [apiGroup] = groups();
      const singleHostGroup = { ...apiGroup!, hosts: [API_A] };
      await releaseFleetOutageFence([singleHostGroup], outage, context(), {
        agentPost,
        agentGet,
      });
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/plugins/payara/stop-for-deployment/release',
          authorization: `Bearer ${TOKEN}`,
          body: {
            outageOwnerId: OUTAGE_OWNER,
            outageCapability: outage.outageCapability,
            targetContentSha256: TARGET_CONTENT_SHA256,
          },
        },
        {
          method: 'GET',
          url: '/scheduler/status',
          authorization: `Bearer ${TOKEN}`,
        },
      ]);
    } finally {
      clearEndpointOverride(API_A);
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  });
});

describe('fleet-wide HAProxy READY commit', () => {
  it('restores every routed host only at the explicit fleet commit', async () => {
    const ready = vi.fn(async () => ({
      success: true,
      results: [{ host: 'lb.example.test', success: true }],
    }));
    const drain = vi.fn();

    await restoreFleetTrafficAfterSuccessfulRollout(
      [
        { name: 'api', hosts: [API_A, API_B], haproxy: haproxy() },
        { name: 'worker', hosts: [WORKER] },
      ],
      context(),
      { readyServer: ready, drainServer: drain, sleep: vi.fn() },
    );

    expect(ready).toHaveBeenCalledTimes(2);
    expect(ready.mock.calls.map(call => call[1])).toEqual([API_A, API_B]);
  });

  it('attempts every READY and reports a partial fleet publication', async () => {
    const ready = vi.fn(async (_config: HAProxyConfig, host: string) => host === API_A
      ? {
          success: false,
          results: [{ host: 'lb.example.test', success: false, error: 'socket failed' }],
        }
        : {
          success: true,
          results: [{ host: 'lb.example.test', success: true }],
        });
    const drain = vi.fn(async () => ({
      success: true,
      results: [{ host: 'lb.example.test', success: true }],
    }));

    await expect(restoreFleetTrafficAfterSuccessfulRollout(
      [{ name: 'api', hosts: [API_A, API_B], haproxy: haproxy() }],
      context(),
      { readyServer: ready, drainServer: drain, sleep: vi.fn() },
    )).rejects.toThrow('compensation returned the complete routed fleet to DRAIN');
    expect(ready).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('rejects an aggregate READY success without exact load-balancer receipts', async () => {
    const ready = vi.fn(async () => ({ success: true, results: [] }));
    const drain = vi.fn(async () => ({
      success: true,
      results: [{ host: 'lb.example.test', success: true }],
    }));

    await expect(restoreFleetTrafficAfterSuccessfulRollout(
      [{ name: 'api', hosts: [API_A], haproxy: haproxy() }],
      context(),
      { readyServer: ready, drainServer: drain, sleep: vi.fn() },
    )).rejects.toThrow('expected one READY receipt, observed 0');
    expect(drain).toHaveBeenCalledOnce();
  });

  it('reports when a partial READY cannot be compensated back to DRAIN', async () => {
    const ready = vi.fn(async () => ({ success: true, results: [] }));
    const drain = vi.fn(async () => ({ success: true, results: [] }));

    await expect(restoreFleetTrafficAfterSuccessfulRollout(
      [{ name: 'api', hosts: [API_A], haproxy: haproxy() }],
      context(),
      { readyServer: ready, drainServer: drain, sleep: vi.fn() },
    )).rejects.toThrow('FLEET_READY_COMPENSATION_NOT_PROVEN');
  });

  it('never publishes an unmapped flat worker to HAProxy', async () => {
    const ready = vi.fn(async () => ({
      success: true,
      results: [{ host: 'lb.example.test', success: true }],
    }));
    const mixedHAProxy = {
      ...haproxy(),
      serverMap: { [API_A]: 'api_a' },
    };

    await restoreFleetTrafficAfterSuccessfulRollout(
      [{ name: 'mixed', hosts: [API_A, WORKER], haproxy: mixedHAProxy }],
      context(),
      { readyServer: ready, drainServer: vi.fn(), sleep: vi.fn() },
    );

    expect(ready).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledWith(mixedHAProxy, API_A);
  });
});
