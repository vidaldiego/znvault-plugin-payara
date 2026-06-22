// Path: test/listr-deploy-quiesce.test.ts
// Tests for quiesce/resume wiring in createHostTask (Part 5a, Task 5)
//
// Drives createHostTask's returned task.task() directly with mocked
// dependencies to verify the quiesce → poll → deploy → resume flow.
//
// Test matrix:
// (a) serverMap host → drain THEN quiesce (order)
// (b) UNMAPPED worker host → quiesce, NO drain
// (c) poll until inFlightUnits == 0
// (d) timeout → deploy STILL called (proceed + warn)
// (e) quiesce available:false (old znapi/error) → deploy still called, no resume
// (f) deploy throws → finally STILL calls resumeScheduler (quiesced before try)
// (g) no-change early-return host → NEVER quiesces (no agent calls)
// (h) quiesce.enabled false/absent → NO quiesce/agent calls (byte-identical)
// (i) concurrent strategy + quiesce.enabled → warns once, proceeds

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock scheduler-quiesce BEFORE importing anything that depends on it
// ---------------------------------------------------------------------------
vi.mock('../src/scheduler-quiesce.js', () => ({
  quiesceScheduler: vi.fn(),
  schedulerStatus: vi.fn(),
  resumeScheduler: vi.fn(),
  pollUntilDrained: vi.fn(),
}));

// Mock haproxy drainServer / readyServer
vi.mock('../src/cli/haproxy.js', () => ({
  drainServer: vi.fn(),
  readyServer: vi.fn(),
  testHAProxyConnectivity: vi.fn(),
  getUnmappedHosts: vi.fn(() => []),
}));

// Mock deployToHost
vi.mock('../src/cli/commands/deploy.js', () => ({
  deployToHost: vi.fn(),
}));

// Mock performHealthCheck
vi.mock('../src/cli/host-checks.js', () => ({
  performHealthCheck: vi.fn(),
}));

// Mock http-client (getTLSIndicator etc.)
vi.mock('../src/cli/http-client.js', () => ({
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
}));

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------
import * as schedulerMod from '../src/scheduler-quiesce.js';
import * as haproxyMod from '../src/cli/haproxy.js';
import * as deployMod from '../src/cli/commands/deploy.js';
import { createHostTask, type ListrDeployOptions, type DeployContext, executeListrDeployment } from '../src/cli/listr-deploy.js';
import { parseDeploymentStrategy } from '../src/cli/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOST_API = '172.16.211.10';  // mapped in haproxy serverMap
const HOST_WORKER = '172.16.211.15';  // NOT in serverMap
const PORT = 9100;

/** Fake CLIPluginContext */
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
  };
}

/** Fake Listr2 task object with capture of task.output */
function makeTask() {
  const outputs: string[] = [];
  return {
    output: '',
    get lastOutput() { return outputs[outputs.length - 1] ?? ''; },
    get allOutputs() { return outputs; },
    // Listr sets task.output = '...' as a setter; we capture each value
    _setOutput(v: string) { outputs.push(v); (this as any).output = v; },
    title: '',
    newListr: vi.fn(),
  };
}

/** Proxy that captures output assignments */
function makeTaskProxy() {
  const task = makeTask();
  return new Proxy(task, {
    set(target, prop, value) {
      if (prop === 'output') {
        target._setOutput(value as string);
      } else {
        (target as any)[prop] = value;
      }
      return true;
    },
  });
}

/** Default success deploy result */
function makeSuccessResult() {
  return {
    success: true,
    result: {
      success: true,
      filesChanged: 1,
      filesDeleted: 0,
      message: 'ok',
      deploymentTime: 100,
      appName: 'TestApp',
      completedAt: Date.now(),
    },
  };
}

/** Build ListrDeployOptions for an API host (in serverMap) */
function makeOptions(host: string, overrides: Partial<ListrDeployOptions> = {}): ListrDeployOptions {
  return {
    ctx: makeCtx(),
    warPath: '/tmp/app.war',
    localHashes: { 'WEB-INF/classes/App.class': 'abc123' },
    port: PORT,
    force: false,
    analysisMap: new Map([[host, { success: true, filesChanged: 1, filesDeleted: 0, bytesToUpload: 1024, isFullUpload: false }]]),
    haproxy: {
      hosts: ['172.16.220.20'],
      backend: 'api_servers',
      serverMap: { [HOST_API]: 'server1' },
      drainWaitSeconds: 0,  // no actual sleep in tests
    },
    quiesce: { enabled: true, pollMs: 1, drainTimeoutMs: 5000 },
    ...overrides,
  };
}

/** Run the task function and return the fake task (for assertions) */
async function runTask(host: string, options: ListrDeployOptions) {
  const listTask = createHostTask(host, options);
  const ctx: DeployContext = {
    results: new Map(),
    aborted: false,
    skipped: 0,
    successful: 0,
    failed: 0,
    healthCheckFailed: 0,
  };
  const fakeTask = makeTaskProxy();
  await (listTask.task as (ctx: DeployContext, task: unknown) => Promise<void>)(ctx, fakeTask);
  return { ctx, fakeTask };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default drain/ready success
  vi.mocked(haproxyMod.drainServer).mockResolvedValue({
    success: true,
    results: [{ host: '172.16.220.20', success: true }],
  });
  vi.mocked(haproxyMod.readyServer).mockResolvedValue({
    success: true,
    results: [{ host: '172.16.220.20', success: true }],
  });

  // Default deploy success
  vi.mocked(deployMod.deployToHost).mockResolvedValue(makeSuccessResult());

  // Default quiesce: available, no in-flight
  vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({ available: true, inFlightUnits: 0 });
  vi.mocked(schedulerMod.pollUntilDrained).mockResolvedValue({ drained: true, timedOut: false });
  vi.mocked(schedulerMod.resumeScheduler).mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// (a) serverMap host → drain THEN quiesce (order)
// ---------------------------------------------------------------------------
describe('(a) serverMap host: drain before quiesce', () => {
  it('calls drainServer before quiesceScheduler for mapped hosts', async () => {
    const callOrder: string[] = [];
    vi.mocked(haproxyMod.drainServer).mockImplementation(async () => {
      callOrder.push('drain');
      return { success: true, results: [{ host: '172.16.220.20', success: true }] };
    });
    vi.mocked(schedulerMod.quiesceScheduler).mockImplementation(async () => {
      callOrder.push('quiesce');
      return { available: true, inFlightUnits: 0 };
    });

    await runTask(HOST_API, makeOptions(HOST_API));

    expect(callOrder[0]).toBe('drain');
    expect(callOrder[1]).toBe('quiesce');
    expect(haproxyMod.drainServer).toHaveBeenCalledOnce();
    expect(schedulerMod.quiesceScheduler).toHaveBeenCalledOnce();
  });

  it('calls readyServer after deploy', async () => {
    await runTask(HOST_API, makeOptions(HOST_API));
    expect(haproxyMod.readyServer).toHaveBeenCalledOnce();
  });

  it('calls resumeScheduler after deploy', async () => {
    await runTask(HOST_API, makeOptions(HOST_API));
    expect(schedulerMod.resumeScheduler).toHaveBeenCalledOnce();
    expect(schedulerMod.resumeScheduler).toHaveBeenCalledWith(HOST_API, PORT, false);
  });
});

// ---------------------------------------------------------------------------
// (b) Unmapped worker host → quiesce, NO drain
// ---------------------------------------------------------------------------
describe('(b) Unmapped worker host: quiesce without drain', () => {
  it('does NOT drain for a host not in serverMap', async () => {
    const workerOptions = makeOptions(HOST_WORKER, {
      // analysisMap for the worker host
      analysisMap: new Map([[HOST_WORKER, { success: true, filesChanged: 1, filesDeleted: 0, bytesToUpload: 512, isFullUpload: false }]]),
    });

    await runTask(HOST_WORKER, workerOptions);

    expect(haproxyMod.drainServer).not.toHaveBeenCalled();
    expect(schedulerMod.quiesceScheduler).toHaveBeenCalledOnce();
    expect(schedulerMod.quiesceScheduler).toHaveBeenCalledWith(HOST_WORKER, PORT, false);
  });

  it('does NOT call readyServer for unmapped host', async () => {
    const workerOptions = makeOptions(HOST_WORKER, {
      analysisMap: new Map([[HOST_WORKER, { success: true, filesChanged: 1, filesDeleted: 0, bytesToUpload: 512, isFullUpload: false }]]),
    });

    await runTask(HOST_WORKER, workerOptions);
    expect(haproxyMod.readyServer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (c) Poll until inFlightUnits reaches 0
// ---------------------------------------------------------------------------
describe('(c) Poll until drained', () => {
  it('calls pollUntilDrained when inFlightUnits > 0 on quiesce', async () => {
    vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({ available: true, inFlightUnits: 3 });
    vi.mocked(schedulerMod.pollUntilDrained).mockResolvedValue({ drained: true, timedOut: false });

    await runTask(HOST_API, makeOptions(HOST_API));

    expect(schedulerMod.pollUntilDrained).toHaveBeenCalledOnce();
    expect(schedulerMod.pollUntilDrained).toHaveBeenCalledWith(
      HOST_API,
      PORT,
      { pollMs: 1, timeoutMs: 5000 },
      false
    );
  });

  it('also calls pollUntilDrained when inFlightUnits is 0', async () => {
    // pollUntilDrained is always called when quiesce is available
    vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({ available: true, inFlightUnits: 0 });

    await runTask(HOST_API, makeOptions(HOST_API));

    expect(schedulerMod.pollUntilDrained).toHaveBeenCalledOnce();
    expect(deployMod.deployToHost).toHaveBeenCalledOnce();
  });

  it('uses per-host quiesceTimeoutMs when configured', async () => {
    vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({ available: true, inFlightUnits: 2 });

    const options = makeOptions(HOST_API, {
      quiesce: { enabled: true, pollMs: 500, drainTimeoutMs: 60000 },
      hostConfigs: { [HOST_API]: { quiesceTimeoutMs: 30000 } },
    });

    await runTask(HOST_API, options);

    expect(schedulerMod.pollUntilDrained).toHaveBeenCalledWith(
      HOST_API,
      PORT,
      { pollMs: 500, timeoutMs: 30000 },  // per-host override wins
      false
    );
  });
});

// ---------------------------------------------------------------------------
// (d) Drain timeout → deploy STILL called (proceed + warn)
// ---------------------------------------------------------------------------
describe('(d) Drain timeout: proceed + warn, deploy still runs', () => {
  it('proceeds with deploy even when pollUntilDrained times out', async () => {
    vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({ available: true, inFlightUnits: 5 });
    vi.mocked(schedulerMod.pollUntilDrained).mockResolvedValue({ drained: false, timedOut: true });

    await runTask(HOST_API, makeOptions(HOST_API));

    // Deploy must still be called
    expect(deployMod.deployToHost).toHaveBeenCalledOnce();
    // And resume still happens
    expect(schedulerMod.resumeScheduler).toHaveBeenCalledOnce();
  });

  it('emits a timeout warning message to task output', async () => {
    vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({ available: true, inFlightUnits: 5 });
    vi.mocked(schedulerMod.pollUntilDrained).mockResolvedValue({ drained: false, timedOut: true });

    const listTask = createHostTask(HOST_API, makeOptions(HOST_API));
    const ctx: DeployContext = {
      results: new Map(),
      aborted: false,
      skipped: 0,
      successful: 0,
      failed: 0,
      healthCheckFailed: 0,
    };
    const fakeTask = makeTaskProxy();
    await (listTask.task as (ctx: DeployContext, task: unknown) => Promise<void>)(ctx, fakeTask);

    const timeoutMsg = fakeTask.allOutputs.find((o: string) => o.includes('timed out'));
    expect(timeoutMsg).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (e) quiesce available:false → deploy still called, no resume
// ---------------------------------------------------------------------------
describe('(e) Quiesce unavailable: deploy proceeds, no resume', () => {
  it('deploys when quiesceScheduler returns available:false (old znapi)', async () => {
    vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({
      available: false,
      reason: 'znapi-internal-scheduler-not-found',
    });

    await runTask(HOST_API, makeOptions(HOST_API));

    expect(deployMod.deployToHost).toHaveBeenCalledOnce();
  });

  it('does NOT call resumeScheduler when quiesce was unavailable', async () => {
    vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({
      available: false,
      reason: 'znapi-internal-scheduler-not-found',
    });

    await runTask(HOST_API, makeOptions(HOST_API));

    expect(schedulerMod.resumeScheduler).not.toHaveBeenCalled();
  });

  it('does NOT call pollUntilDrained when quiesce was unavailable', async () => {
    vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({ available: false });

    await runTask(HOST_API, makeOptions(HOST_API));

    expect(schedulerMod.pollUntilDrained).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (f) Deploy throws → finally STILL calls resumeScheduler
// ---------------------------------------------------------------------------
describe('(f) Deploy failure: finally always calls resumeScheduler', () => {
  it('calls resumeScheduler even when deployToHost throws', async () => {
    vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({ available: true, inFlightUnits: 0 });
    vi.mocked(deployMod.deployToHost).mockRejectedValue(new Error('Deployment exploded'));

    const listTask = createHostTask(HOST_API, makeOptions(HOST_API));
    const ctx: DeployContext = {
      results: new Map(),
      aborted: false,
      skipped: 0,
      successful: 0,
      failed: 0,
      healthCheckFailed: 0,
    };
    const fakeTask = makeTaskProxy();

    // Task should throw (deploy failed)
    await expect((listTask.task as (ctx: DeployContext, task: unknown) => Promise<void>)(ctx, fakeTask)).rejects.toThrow('Deployment exploded');

    // But resume must still have been called
    expect(schedulerMod.resumeScheduler).toHaveBeenCalledOnce();
    expect(schedulerMod.resumeScheduler).toHaveBeenCalledWith(HOST_API, PORT, false);
  });

  it('restores HAProxy ready even when deploy throws AND quiesce was done', async () => {
    vi.mocked(schedulerMod.quiesceScheduler).mockResolvedValue({ available: true, inFlightUnits: 0 });
    vi.mocked(deployMod.deployToHost).mockRejectedValue(new Error('oops'));

    const listTask = createHostTask(HOST_API, makeOptions(HOST_API));
    const ctx: DeployContext = { results: new Map(), aborted: false, skipped: 0, successful: 0, failed: 0, healthCheckFailed: 0 };
    const fakeTask = makeTaskProxy();

    await expect((listTask.task as (ctx: DeployContext, task: unknown) => Promise<void>)(ctx, fakeTask)).rejects.toThrow();

    // Both drain-restore AND resume must run in finally
    expect(haproxyMod.readyServer).toHaveBeenCalled();  // drain recovery
    expect(schedulerMod.resumeScheduler).toHaveBeenCalled();  // quiesce recovery
  });
});

// ---------------------------------------------------------------------------
// (g) No-change early-return host → NEVER quiesces
// ---------------------------------------------------------------------------
describe('(g) No-change host: skipped before quiesce', () => {
  it('does not call quiesceScheduler when host has no changes', async () => {
    const options = makeOptions(HOST_API, {
      analysisMap: new Map([[HOST_API, { success: true, filesChanged: 0, filesDeleted: 0, bytesToUpload: 0, isFullUpload: false }]]),
    });

    await runTask(HOST_API, options);

    expect(schedulerMod.quiesceScheduler).not.toHaveBeenCalled();
    expect(schedulerMod.pollUntilDrained).not.toHaveBeenCalled();
    expect(schedulerMod.resumeScheduler).not.toHaveBeenCalled();
  });

  it('does not drain HAProxy for no-change hosts', async () => {
    const options = makeOptions(HOST_API, {
      analysisMap: new Map([[HOST_API, { success: true, filesChanged: 0, filesDeleted: 0, bytesToUpload: 0, isFullUpload: false }]]),
    });

    await runTask(HOST_API, options);

    expect(haproxyMod.drainServer).not.toHaveBeenCalled();
    expect(deployMod.deployToHost).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (h) quiesce.enabled false/absent → byte-identical (no agent calls)
// ---------------------------------------------------------------------------
describe('(h) Quiesce disabled: byte-identical to original deploy', () => {
  it('does not call any scheduler function when quiesce is absent', async () => {
    const options = makeOptions(HOST_API, { quiesce: undefined });

    await runTask(HOST_API, options);

    expect(schedulerMod.quiesceScheduler).not.toHaveBeenCalled();
    expect(schedulerMod.pollUntilDrained).not.toHaveBeenCalled();
    expect(schedulerMod.resumeScheduler).not.toHaveBeenCalled();
    // But deploy + drain/ready run as normal
    expect(haproxyMod.drainServer).toHaveBeenCalledOnce();
    expect(deployMod.deployToHost).toHaveBeenCalledOnce();
    expect(haproxyMod.readyServer).toHaveBeenCalledOnce();
  });

  it('does not call any scheduler function when quiesce.enabled is false', async () => {
    const options = makeOptions(HOST_API, { quiesce: { enabled: false } });

    await runTask(HOST_API, options);

    expect(schedulerMod.quiesceScheduler).not.toHaveBeenCalled();
    expect(schedulerMod.pollUntilDrained).not.toHaveBeenCalled();
    expect(schedulerMod.resumeScheduler).not.toHaveBeenCalled();
  });

  it('deploy is called even without quiesce config', async () => {
    const options = makeOptions(HOST_API, { quiesce: undefined });
    await runTask(HOST_API, options);
    expect(deployMod.deployToHost).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// (i) Concurrent strategy + quiesce.enabled → warns once, proceeds
// ---------------------------------------------------------------------------
describe('(i) Concurrent (parallel) strategy + quiesce: warns once', () => {
  it('emits a console.warn when strategy is parallel and quiesce is enabled', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const strategy = parseDeploymentStrategy('parallel');
    const ctx2 = makeCtx();
    const analysisMap = new Map([
      [HOST_API, { success: true, filesChanged: 1, filesDeleted: 0, bytesToUpload: 512, isFullUpload: false }],
    ]);

    await executeListrDeployment(strategy, [HOST_API], {
      ctx: ctx2,
      warPath: '/tmp/app.war',
      localHashes: {},
      port: PORT,
      force: false,
      analysisMap,
      quiesce: { enabled: true, pollMs: 1, drainTimeoutMs: 5000 },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('quiesce + concurrent strategy')
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);  // warn ONCE, not per-host

    warnSpy.mockRestore();
  });

  it('does NOT warn when strategy is sequential (not concurrent)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const strategy = parseDeploymentStrategy('sequential');
    const ctx2 = makeCtx();
    const analysisMap = new Map([
      [HOST_API, { success: true, filesChanged: 1, filesDeleted: 0, bytesToUpload: 512, isFullUpload: false }],
    ]);

    await executeListrDeployment(strategy, [HOST_API], {
      ctx: ctx2,
      warPath: '/tmp/app.war',
      localHashes: {},
      port: PORT,
      force: false,
      analysisMap,
      quiesce: { enabled: true, pollMs: 1, drainTimeoutMs: 5000 },
    });

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('quiesce + concurrent'));
    warnSpy.mockRestore();
  });

  it('does NOT warn when quiesce is disabled (even with parallel strategy)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const strategy = parseDeploymentStrategy('parallel');
    const ctx2 = makeCtx();
    const analysisMap = new Map([
      [HOST_API, { success: true, filesChanged: 1, filesDeleted: 0, bytesToUpload: 512, isFullUpload: false }],
    ]);

    await executeListrDeployment(strategy, [HOST_API], {
      ctx: ctx2,
      warPath: '/tmp/app.war',
      localHashes: {},
      port: PORT,
      force: false,
      analysisMap,
      quiesce: { enabled: false },
    });

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('quiesce + concurrent'));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tunnel port/useTLS: resolved connection wins over options.port
// ---------------------------------------------------------------------------
describe('Tunnel port/useTLS resolution', () => {
  it('calls quiesceScheduler with tunnel-resolved port when connectionMap is set', async () => {
    const options = makeOptions(HOST_API, {
      port: 9100,  // default port (would be wrong for tunnel)
      connectionMap: new Map([[HOST_API, { host: '127.0.0.1', port: 55000, tls: false, verified: false }]]),
    });

    await runTask(HOST_API, options);

    // quiesce must use the tunnel port, not options.port
    expect(schedulerMod.quiesceScheduler).toHaveBeenCalledWith(HOST_API, 55000, false);
    // deploy also uses the same port
    expect(deployMod.deployToHost).toHaveBeenCalledWith(
      expect.anything(),
      HOST_API,
      55000,
      expect.any(String),
      expect.any(Object),
      expect.any(Boolean),
      expect.anything(),
      false
    );
  });

  it('calls resumeScheduler with tunnel-resolved port', async () => {
    const options = makeOptions(HOST_API, {
      port: 9100,
      connectionMap: new Map([[HOST_API, { host: '127.0.0.1', port: 55000, tls: true, verified: true }]]),
    });

    await runTask(HOST_API, options);

    expect(schedulerMod.resumeScheduler).toHaveBeenCalledWith(HOST_API, 55000, true);
  });
});
