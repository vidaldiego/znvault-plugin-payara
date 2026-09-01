// Path: test/listr-deploy-node-class.test.ts
// Tests for per-node-class deploy strategy (serving vs worker partitioning).
//
// The deployer must apply the operator's strategy (1+R, sequential, …) to
// SERVING nodes only — hosts present in haproxy.serverMap. Worker nodes (hosts
// NOT in serverMap) deploy in a separate, final batch: parallel, no drain, and
// NON-BLOCKING (a worker failure must not abort or fail the serving roll).
//
// Background: incident 2026-06-23 — a scheduler worker out of HAProxy was the
// meaningless "1" canary in a 1+R config; "canary OK" was a false-green and the
// serving nodes then rolled unsafely → ~1–2 min production outage. This pins the
// durable tool-level fix so no config can repeat it.
//
// Test matrix (from spec):
// 1. Regression (the incident): worker-first 1+R → serving-node canary, worker last
// 2. Worker batch is non-blocking: worker deploy fails → overall result success + warn
// 3. No serverMap: batching/order unchanged (today's behavior)
// 4. All serving: no worker batch produced
// 5. Mixed config emits the warn
// 6. Canary (serving) failure aborts BEFORE any worker batch runs (workers untouched)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @zincapp/znvault-deploy-core BEFORE importing anything that depends on it
// (scheduler-quiesce, haproxy, host-checks, and http-client all now live here)
// ---------------------------------------------------------------------------
vi.mock('@zincapp/znvault-deploy-core', async (importActual) => {
  const actual = await importActual<typeof import('@zincapp/znvault-deploy-core')>();
  return {
    ...actual,
    // scheduler-quiesce
    quiesceScheduler: vi.fn(),
    schedulerStatus: vi.fn(),
    resumeScheduler: vi.fn(),
    pollUntilDrained: vi.fn(),
    // haproxy
    drainServer: vi.fn(),
    readyServer: vi.fn(),
    testHAProxyConnectivity: vi.fn(),
    getUnmappedHosts: vi.fn(() => []),
    // host-checks
    performHealthCheck: vi.fn(),
    // http-client
    agentGet: vi.fn(),
    agentPost: vi.fn(),
    agentPostWithStatus: vi.fn(),
    buildPluginUrl: vi.fn((host: string, port: number) => `http://${host}:${port}/plugins/payara`),
    setEndpointOverride: vi.fn(),
    clearEndpointOverride: vi.fn(),
    clearAllEndpointOverrides: vi.fn(),
    configureTLS: vi.fn(),
    getTLSConfig: vi.fn(() => ({ verify: true })),
    getTLSIndicator: vi.fn(() => ''),
  };
});

// Mock deployToHost — this is where we observe deploy order per host
vi.mock('../src/cli/commands/deploy.js', () => ({
  deployToHost: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------
import * as schedulerMod from '@zincapp/znvault-deploy-core';
import * as haproxyMod from '@zincapp/znvault-deploy-core';
import * as deployMod from '../src/cli/commands/deploy.js';
import { executeListrDeployment, printDeploymentSummary, partitionHostsByClass, type ListrDeployOptions, type DeployContext } from '../src/cli/listr-deploy.js';
import { parseDeploymentStrategy } from '../src/cli/types.js';

// ---------------------------------------------------------------------------
// Incident hosts (the actual config that caused the 2026-06-23 outage)
// ---------------------------------------------------------------------------
const WORKER = '192.0.2.58';      // NOT in serverMap → scheduler worker
const SERVING_1 = '192.0.2.55';   // server1
const SERVING_2 = '192.0.2.56';   // server2
const SERVING_3 = '192.0.2.57';   // server3
const PORT = 9100;

const SERVER_MAP = {
  [SERVING_1]: 'server1',
  [SERVING_2]: 'server2',
  [SERVING_3]: 'server3',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ListrDeployOptions['ctx'] {
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
    getConfig: () => ({ url: 'http://vault' }),
    isPlainMode: () => true,
  } as unknown as ListrDeployOptions['ctx'];
}

function makeSuccessResult() {
  return {
    success: true,
    result: {
      success: true,
      filesChanged: 1,
      filesDeleted: 0,
      message: 'ok',
      deploymentTime: 10,
      appName: 'TestApp',
      deployed: true,
      completedAt: Date.now(),
    },
  };
}

/** analysisMap with a single changed file per host so none are skipped. */
function makeAnalysisMap(hosts: string[]): ListrDeployOptions['analysisMap'] {
  return new Map(
    hosts.map(h => [h, { success: true, filesChanged: 1, filesDeleted: 0, bytesToUpload: 512, isFullUpload: false }]),
  );
}

function makeOptions(hosts: string[], overrides: Partial<ListrDeployOptions> = {}): ListrDeployOptions {
  return {
    ctx: makeCtx(),
    warPath: '/tmp/app.war',
    localHashes: {},
    port: PORT,
    force: false,
    analysisMap: makeAnalysisMap(hosts),
    mutationAuthTokens: new Map(
      hosts.map(host => [host, `test-payara-control-token-${host}`])
    ),
    haproxy: {
      hosts: ['198.51.100.20'],
      backend: 'api_servers',
      serverMap: SERVER_MAP,
      drainWaitSeconds: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(haproxyMod.drainServer).mockResolvedValue({
    success: true,
    results: [{ host: '198.51.100.20', success: true }],
  });
  vi.mocked(haproxyMod.readyServer).mockResolvedValue({
    success: true,
    results: [{ host: '198.51.100.20', success: true }],
  });
  vi.mocked(deployMod.deployToHost).mockResolvedValue(makeSuccessResult());
  vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({ available: true, inFlightUnits: 0 });
  vi.mocked(schedulerMod.pollUntilDrained).mockResolvedValue({ drained: true, timedOut: false });
  vi.mocked(schedulerMod.resumeScheduler).mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

/** Records the order in which deployToHost is invoked per host. */
function captureDeployOrder(): string[] {
  const order: string[] = [];
  vi.mocked(deployMod.deployToHost).mockImplementation(async (_ctx, host) => {
    order.push(host);
    return makeSuccessResult();
  });
  return order;
}

// ---------------------------------------------------------------------------
// 0. partitionHostsByClass: the single source of truth for the serving/worker split
// ---------------------------------------------------------------------------
describe('0. partitionHostsByClass helper', () => {
  it('splits hosts into serving (in serverMap) and workers (not), preserving order', () => {
    const { serving, workers } = partitionHostsByClass(
      [WORKER, SERVING_1, SERVING_2, SERVING_3],
      { hosts: [], backend: 'b', serverMap: SERVER_MAP },
    );
    expect(serving).toEqual([SERVING_1, SERVING_2, SERVING_3]);
    expect(workers).toEqual([WORKER]);
  });

  it('treats all hosts as serving when no haproxy config', () => {
    const hosts = [WORKER, SERVING_1];
    const { serving, workers } = partitionHostsByClass(hosts, undefined);
    expect(serving).toEqual(hosts);
    expect(workers).toEqual([]);
  });

  it('treats all hosts as serving when serverMap is empty', () => {
    const hosts = [WORKER, SERVING_1];
    const { serving, workers } = partitionHostsByClass(hosts, { hosts: [], backend: 'b', serverMap: {} });
    expect(serving).toEqual(hosts);
    expect(workers).toEqual([]);
  });

  it('all-worker when serverMap is present but matches none of the hosts', () => {
    const { serving, workers } = partitionHostsByClass(
      [WORKER, '192.0.2.59'],
      { hosts: [], backend: 'b', serverMap: SERVER_MAP },
    );
    expect(serving).toEqual([]);
    expect(workers).toEqual([WORKER, '192.0.2.59']);
  });
});

// ---------------------------------------------------------------------------
// 1. Regression (the incident): worker-first 1+R
// ---------------------------------------------------------------------------
describe('1. Regression: worker-first 1+R config', () => {
  // hosts ordered worker-first, exactly as the incident config was
  const HOSTS = [WORKER, SERVING_1, SERVING_2, SERVING_3];

  it('deploys a SERVING node first (canary is never the worker)', async () => {
    const order = captureDeployOrder();
    const strategy = parseDeploymentStrategy('1+R');

    await executeListrDeployment(strategy, HOSTS, makeOptions(HOSTS));

    // The very first host deployed must be a serving node — never the worker.
    expect(order[0]).not.toBe(WORKER);
    expect(SERVER_MAP[order[0] as keyof typeof SERVER_MAP]).toBeTruthy();
    // Specifically the first serving host in config order
    expect(order[0]).toBe(SERVING_1);
  });

  it('deploys the worker LAST, after all serving nodes', async () => {
    const order = captureDeployOrder();
    const strategy = parseDeploymentStrategy('1+R');

    await executeListrDeployment(strategy, HOSTS, makeOptions(HOSTS));

    // Worker must be the final deploy, never interleaved with serving nodes.
    expect(order[order.length - 1]).toBe(WORKER);
    const workerIndex = order.indexOf(WORKER);
    const servingIndices = [SERVING_1, SERVING_2, SERVING_3].map(h => order.indexOf(h));
    for (const idx of servingIndices) {
      expect(idx).toBeLessThan(workerIndex);
    }
  });

  it('never drains the worker (not in serverMap)', async () => {
    const strategy = parseDeploymentStrategy('1+R');

    await executeListrDeployment(strategy, HOSTS, makeOptions(HOSTS));

    // drainServer is called per serving host but never for the worker.
    const drainedHosts = vi.mocked(haproxyMod.drainServer).mock.calls.map(c => c[1]);
    expect(drainedHosts).not.toContain(WORKER);
    expect(drainedHosts).toEqual(expect.arrayContaining([SERVING_1, SERVING_2, SERVING_3]));
  });

  it('all four hosts are deployed', async () => {
    const order = captureDeployOrder();
    const strategy = parseDeploymentStrategy('1+R');

    await executeListrDeployment(strategy, HOSTS, makeOptions(HOSTS));

    expect(new Set(order)).toEqual(new Set(HOSTS));
  });
});

// ---------------------------------------------------------------------------
// 2. Worker batch is non-blocking
// ---------------------------------------------------------------------------
describe('2. Worker batch failure is non-blocking', () => {
  const HOSTS = [SERVING_1, SERVING_2, WORKER];

  it('overall deploy result stays success when only the worker fails', async () => {
    // Serving nodes succeed; the worker deploy fails.
    vi.mocked(deployMod.deployToHost).mockImplementation(async (_ctx, host) => {
      if (host === WORKER) {
        return { success: false, error: 'worker boom' };
      }
      return makeSuccessResult();
    });

    const strategy = parseDeploymentStrategy('1+R');
    const result = await executeListrDeployment(strategy, HOSTS, makeOptions(HOSTS));

    // A worker failure must NOT mark the deploy failed or aborted.
    expect(result.aborted).toBe(false);
    expect(result.failed).toBe(0);
    expect(result.successful).toBe(2); // both serving nodes
  });

  it('records the worker failure and surfaces a warning', async () => {
    vi.mocked(deployMod.deployToHost).mockImplementation(async (_ctx, host) => {
      if (host === WORKER) {
        return { success: false, error: 'worker boom' };
      }
      return makeSuccessResult();
    });

    const options = makeOptions(HOSTS);
    const strategy = parseDeploymentStrategy('1+R');
    const result = await executeListrDeployment(strategy, HOSTS, options);

    // Worker failure tracked separately (not in ctx.failed) and warned.
    expect(result.workerFailed).toBe(1);
    expect(options.ctx.output.warn).toHaveBeenCalledWith(expect.stringContaining(WORKER));
  });

  it('records a worker without a terminal receipt as failed', async () => {
    vi.mocked(deployMod.deployToHost).mockImplementation(async (_ctx, host) =>
      host === WORKER ? { success: true } : makeSuccessResult()
    );

    const result = await executeListrDeployment(
      parseDeploymentStrategy('1+R'),
      HOSTS,
      makeOptions(HOSTS)
    );

    expect(result.workerFailed).toBe(1);
    expect(result.results.get(WORKER)).toEqual({ success: true });
  });

  it('still deploys serving nodes when worker fails', async () => {
    const deployedSuccessfully: string[] = [];
    vi.mocked(deployMod.deployToHost).mockImplementation(async (_ctx, host) => {
      if (host === WORKER) {
        return { success: false, error: 'worker boom' };
      }
      deployedSuccessfully.push(host);
      return makeSuccessResult();
    });

    const strategy = parseDeploymentStrategy('1+R');
    await executeListrDeployment(strategy, HOSTS, makeOptions(HOSTS));

    expect(deployedSuccessfully).toEqual(expect.arrayContaining([SERVING_1, SERVING_2]));
  });
});

// ---------------------------------------------------------------------------
// 3. No serverMap: batching/order unchanged
// ---------------------------------------------------------------------------
describe('3. No serverMap configured: one class, behavior unchanged', () => {
  const HOSTS = [WORKER, SERVING_1, SERVING_2];

  it('treats all hosts as one class and deploys in config order under the strategy', async () => {
    const order = captureDeployOrder();
    const strategy = parseDeploymentStrategy('1+R');

    // No haproxy config at all → no serving/worker distinction.
    await executeListrDeployment(strategy, HOSTS, makeOptions(HOSTS, { haproxy: undefined }));

    // Canary "1" is the first host in plain config order (today's behavior).
    expect(order[0]).toBe(WORKER);
    expect(new Set(order)).toEqual(new Set(HOSTS));
  });

  it('does not emit the mixed-config warning when no serverMap', async () => {
    const options = makeOptions(HOSTS, { haproxy: undefined });
    const strategy = parseDeploymentStrategy('1+R');

    await executeListrDeployment(strategy, HOSTS, options);

    expect(options.ctx.output.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('serving'),
    );
  });

  it('treats an empty serverMap as no class distinction', async () => {
    const order = captureDeployOrder();
    const strategy = parseDeploymentStrategy('1+R');
    const options = makeOptions(HOSTS, {
      haproxy: { hosts: ['198.51.100.20'], backend: 'api_servers', serverMap: {}, drainWaitSeconds: 0 },
    });

    await executeListrDeployment(strategy, HOSTS, options);

    expect(order[0]).toBe(WORKER); // unchanged config order
    expect(options.ctx.output.warn).not.toHaveBeenCalledWith(expect.stringContaining('serving'));
  });
});

// ---------------------------------------------------------------------------
// 3a. Sequential/finite strategy coverage
// ---------------------------------------------------------------------------
describe('3a. Strategy coverage is complete or fails closed', () => {
  const HOSTS = [SERVING_1, SERVING_2, SERVING_3];

  it('sequential creates one ordered task for every serving host', async () => {
    const order = captureDeployOrder();

    const result = await executeListrDeployment(
      parseDeploymentStrategy('sequential'),
      HOSTS,
      makeOptions(HOSTS, { haproxy: undefined })
    );

    expect(order).toEqual(HOSTS);
    expect(result.successful).toBe(3);
    expect(Array.from(result.results.keys())).toEqual(HOSTS);
  });

  it('rejects a finite canary plan that leaves a serving tail untouched', async () => {
    await expect(executeListrDeployment(
      parseDeploymentStrategy('1+1'),
      HOSTS,
      makeOptions(HOSTS, { haproxy: undefined })
    )).rejects.toThrow(/covers 2 of 3 serving hosts/);

    expect(deployMod.deployToHost).not.toHaveBeenCalled();
  });

  it('does not count a transport-only success as a deployment receipt', async () => {
    vi.mocked(deployMod.deployToHost).mockImplementation(async (_ctx, host) =>
      host === SERVING_2
        ? { success: true }
        : makeSuccessResult()
    );

    const result = await executeListrDeployment(
      parseDeploymentStrategy('sequential'),
      HOSTS,
      makeOptions(HOSTS, { haproxy: undefined })
    );

    expect(result.failed).toBe(1);
    expect(result.successful).toBe(2);
    expect(result.results.get(SERVING_2)).toEqual({ success: true });
  });

  it('records a pre-deploy credential failure and continues no false-green', async () => {
    const options = makeOptions(HOSTS, {
      haproxy: undefined,
      mutationAuthTokens: new Map([
        [SERVING_1, `test-payara-control-token-${SERVING_1}`],
        [SERVING_3, `test-payara-control-token-${SERVING_3}`],
      ]),
    });

    const result = await executeListrDeployment(
      parseDeploymentStrategy('sequential'),
      HOSTS,
      options
    );

    expect(result.failed).toBe(1);
    expect(result.results.get(SERVING_2)).toMatchObject({
      success: false,
      error: expect.stringContaining('credential'),
    });
  });

  it('records a pre-deploy drain failure and never dispatches that host', async () => {
    vi.mocked(haproxyMod.drainServer).mockImplementation(async (_config, host) =>
      host === SERVING_2
        ? {
            success: false,
            results: [{ host: '198.51.100.20', success: false, error: 'drain rejected' }],
          }
        : {
            success: true,
            results: [{ host: '198.51.100.20', success: true }],
          }
    );

    const result = await executeListrDeployment(
      parseDeploymentStrategy('sequential'),
      HOSTS,
      makeOptions(HOSTS)
    );

    expect(result.failed).toBe(1);
    expect(result.successful).toBe(2);
    expect(result.results.get(SERVING_2)).toMatchObject({
      success: false,
      error: expect.stringContaining('drain'),
    });
    expect(vi.mocked(deployMod.deployToHost).mock.calls.map(call => call[1]))
      .not.toContain(SERVING_2);
  });

  it('keeps a post-receipt ready failure in the non-canary result', async () => {
    vi.mocked(haproxyMod.readyServer).mockImplementation(async (_config, host) =>
      host === SERVING_2
        ? {
            success: false,
            results: [{ host: '198.51.100.20', success: false, error: 'ready rejected' }],
          }
        : {
            success: true,
            results: [{ host: '198.51.100.20', success: true }],
          }
    );

    const result = await executeListrDeployment(
      parseDeploymentStrategy('sequential'),
      HOSTS,
      makeOptions(HOSTS)
    );

    // Listr's non-canary exitOnError:false must not turn the thrown orchestration
    // error into a clean context merely because the deploy receipt already exists.
    expect(result.results.get(SERVING_2)).toMatchObject({
      success: true,
      result: { success: true, deployed: true },
    });
    expect(result.failed).toBe(1);
    expect(result.successful).toBe(2);
    expect(result.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. All serving: no worker batch produced
// ---------------------------------------------------------------------------
describe('4. All hosts serving: no worker batch', () => {
  const HOSTS = [SERVING_1, SERVING_2, SERVING_3];

  it('does not produce a worker batch when every host is in serverMap', async () => {
    const strategy = parseDeploymentStrategy('1+R');
    const result = await executeListrDeployment(strategy, HOSTS, makeOptions(HOSTS));

    expect(result.workerFailed).toBe(0);
    expect(result.successful).toBe(3);
  });

  it('does not emit the mixed-config warning when all hosts serving', async () => {
    const options = makeOptions(HOSTS);
    const strategy = parseDeploymentStrategy('1+R');

    await executeListrDeployment(strategy, HOSTS, options);

    expect(options.ctx.output.warn).not.toHaveBeenCalledWith(expect.stringContaining('serving'));
  });
});

// ---------------------------------------------------------------------------
// 5. Mixed config emits the warn
// ---------------------------------------------------------------------------
describe('5. Mixed serving + worker config emits a warning', () => {
  const HOSTS = [SERVING_1, SERVING_2, WORKER];

  it('warns that the strategy applies to serving nodes only', async () => {
    const options = makeOptions(HOSTS);
    const strategy = parseDeploymentStrategy('1+R');

    await executeListrDeployment(strategy, HOSTS, options);

    // One warning naming the mixed nature and the worker-last behavior.
    expect(options.ctx.output.warn).toHaveBeenCalledWith(
      expect.stringContaining('serving'),
    );
    expect(options.ctx.output.warn).toHaveBeenCalledWith(
      expect.stringContaining(WORKER),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Worker-only config (serverMap present, no host matches it)
// ---------------------------------------------------------------------------
describe('8. Worker-only config: deploy workers, do not error', () => {
  // serverMap is configured (for a DIFFERENT fleet) but none of these hosts
  // are in it → all are workers, no serving node to protect.
  const HOSTS = [WORKER, '192.0.2.59'];

  it('deploys all workers and never aborts', async () => {
    const order = captureDeployOrder();
    const strategy = parseDeploymentStrategy('1+R');

    const result = await executeListrDeployment(strategy, HOSTS, makeOptions(HOSTS));

    expect(new Set(order)).toEqual(new Set(HOSTS));
    expect(result.aborted).toBe(false);
    expect(result.failed).toBe(0);
  });

  it('does not drain any host in a worker-only config', async () => {
    const strategy = parseDeploymentStrategy('1+R');

    await executeListrDeployment(strategy, HOSTS, makeOptions(HOSTS));

    expect(haproxyMod.drainServer).not.toHaveBeenCalled();
  });

  it('does not emit the mixed-config warning (no serving nodes)', async () => {
    const options = makeOptions(HOSTS);
    const strategy = parseDeploymentStrategy('1+R');

    await executeListrDeployment(strategy, HOSTS, options);

    expect(options.ctx.output.warn).not.toHaveBeenCalledWith(expect.stringContaining('serving'));
  });
});

// ---------------------------------------------------------------------------
// 7. Summary surfaces worker failures without marking the deploy failed
// ---------------------------------------------------------------------------
describe('7. Summary surfaces worker failures (non-blocking)', () => {
  function baseCtx(overrides: Partial<DeployContext> = {}): DeployContext {
    return {
      results: new Map(),
      aborted: false,
      skipped: 0,
      successful: 2,
      failed: 0,
      healthCheckFailed: 0,
      workerFailed: 0,
      ...overrides,
    };
  }

  it('reports a worker failure in the summary (plain mode)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printDeploymentSummary(baseCtx({ workerFailed: 1 }), 3, true);
      const out = logSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(out).toMatch(/worker/i);
      expect(out).toMatch(/1/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('shows clean success when no worker failed', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printDeploymentSummary(baseCtx({ workerFailed: 0 }), 3, true);
      const out = logSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(out).not.toMatch(/worker/i);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Canary (serving) failure aborts BEFORE any worker batch runs
// ---------------------------------------------------------------------------
describe('6. Serving canary failure aborts before workers', () => {
  const HOSTS = [SERVING_1, SERVING_2, WORKER];

  it('does NOT deploy the worker when the serving canary fails', async () => {
    // The serving canary (SERVING_1) fails its deploy.
    vi.mocked(deployMod.deployToHost).mockImplementation(async (_ctx, host) => {
      if (host === SERVING_1) {
        return { success: false, error: 'canary boom' };
      }
      return makeSuccessResult();
    });

    const strategy = parseDeploymentStrategy('1+R');
    const result = await executeListrDeployment(strategy, HOSTS, makeOptions(HOSTS));

    // Worker must never be touched if serving is broken.
    const deployedHosts = vi.mocked(deployMod.deployToHost).mock.calls.map(c => c[1]);
    expect(deployedHosts).not.toContain(WORKER);
    expect(result.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. suppressMixedClassWarning option
// ---------------------------------------------------------------------------
describe('9. suppressMixedClassWarning option', () => {
  // A mixed serving+worker host list normally warns; with the suppress flag it must not.
  const HOSTS = [SERVING_1, WORKER];

  it('suppresses the mixed-config warning when suppressMixedClassWarning is true', async () => {
    const options = makeOptions(HOSTS, { suppressMixedClassWarning: true });
    const strategy = parseDeploymentStrategy('1+R');
    await executeListrDeployment(strategy, HOSTS, options);
    expect(options.ctx.output.warn).not.toHaveBeenCalledWith(expect.stringContaining('serving'));
  });

  it('still warns when the flag is absent', async () => {
    const options = makeOptions(HOSTS);
    const strategy = parseDeploymentStrategy('1+R');
    await executeListrDeployment(strategy, HOSTS, options);
    expect(options.ctx.output.warn).toHaveBeenCalledWith(expect.stringContaining('serving'));
  });
});
