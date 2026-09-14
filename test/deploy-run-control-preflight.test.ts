import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CLIPluginContext, DeployConfig } from '../src/cli/types.js';

const mocks = vi.hoisted(() => ({
  loadDeployConfigs: vi.fn(),
  runMigrations: vi.fn(),
  openTunnel: vi.fn(),
  setEndpointOverride: vi.fn(),
  clearEndpointOverride: vi.fn(),
  clearAllEndpointOverrides: vi.fn(),
  configureTLS: vi.fn(),
  testHAProxyConnectivity: vi.fn(),
  executePreflightChecks: vi.fn(),
  executePluginUpdates: vi.fn(),
  waitForAgentRestart: vi.fn(),
  executeListrDeployment: vi.fn(),
  loadHostMutationAuthTokens: vi.fn(),
  assertHostControlPlaneCompatible: vi.fn(),
  drainServer: vi.fn(),
  readyServer: vi.fn(),
  quiesceScheduler: vi.fn(),
  resumeScheduler: vi.fn(),
  schedulerStatus: vi.fn(),
  performHealthCheck: vi.fn(),
  agentPost: vi.fn(),
  agentGet: vi.fn(),
  openFleetOutageJournal: vi.fn(),
  openFinalizedFleetOutageJournal: vi.fn(),
  markFleetOutageCommitAuthorized: vi.fn(),
  completeFleetOutageJournal: vi.fn(),
}));

vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: mocks.loadDeployConfigs,
}));

vi.mock('../src/cli/auth-token.js', async importActual => {
  const actual = await importActual<typeof import('../src/cli/auth-token.js')>();
  mocks.loadHostMutationAuthTokens.mockImplementation(
    actual.loadHostMutationAuthTokens
  );
  return {
    ...actual,
    loadHostMutationAuthTokens: mocks.loadHostMutationAuthTokens,
  };
});

vi.mock('@zincapp/znvault-migrate', async importActual => {
  const actual = await importActual<typeof import('@zincapp/znvault-migrate')>();
  return { ...actual, runMigrations: mocks.runMigrations };
});

vi.mock('@zincapp/znvault-deploy-core', async importActual => {
  const actual = await importActual<typeof import('@zincapp/znvault-deploy-core')>();
  return {
    ...actual,
    openTunnel: mocks.openTunnel,
    setEndpointOverride: mocks.setEndpointOverride,
    clearEndpointOverride: mocks.clearEndpointOverride,
    clearAllEndpointOverrides: mocks.clearAllEndpointOverrides,
    configureTLS: mocks.configureTLS,
    testHAProxyConnectivity: mocks.testHAProxyConnectivity,
    drainServer: mocks.drainServer,
    readyServer: mocks.readyServer,
    quiesceScheduler: mocks.quiesceScheduler,
    resumeScheduler: mocks.resumeScheduler,
    schedulerStatus: mocks.schedulerStatus,
    performHealthCheck: mocks.performHealthCheck,
    agentPost: mocks.agentPost,
    agentGet: mocks.agentGet,
  };
});

vi.mock('../src/cli/fleet-outage-journal.js', () => ({
  openFleetOutageJournal: mocks.openFleetOutageJournal,
  openFinalizedFleetOutageJournal: mocks.openFinalizedFleetOutageJournal,
  markFleetOutageCommitAuthorized: mocks.markFleetOutageCommitAuthorized,
  completeFleetOutageJournal: mocks.completeFleetOutageJournal,
}));

// Exercise the real strict barrier from this command-level suite while
// injecting deterministic, side-effect-free control-plane dependencies. This
// also makes the ordering assertions below independent of Vitest's module
// cache and of deploy-core's concrete network clients.
vi.mock('../src/cli/fleet-stop-before-pre.js', async importActual => {
  const actual = await importActual<
    typeof import('../src/cli/fleet-stop-before-pre.js')
  >();
  return {
    ...actual,
    enforceFleetStopBeforePre: (
      groups: Parameters<typeof actual.enforceFleetStopBeforePre>[0],
      ctx: Parameters<typeof actual.enforceFleetStopBeforePre>[1],
    ) => actual.enforceFleetStopBeforePre(groups, ctx, {
      drainServer: mocks.drainServer,
      quiesceScheduler: mocks.quiesceScheduler,
      schedulerStatus: mocks.schedulerStatus,
      agentPost: mocks.agentPost,
      agentGet: mocks.agentGet,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => Date.now()),
    }),
    restoreFleetTrafficAfterSuccessfulRollout: (
      groups: Parameters<typeof actual.restoreFleetTrafficAfterSuccessfulRollout>[0],
      ctx: Parameters<typeof actual.restoreFleetTrafficAfterSuccessfulRollout>[1],
    ) => actual.restoreFleetTrafficAfterSuccessfulRollout(
      groups,
      ctx,
      {
        readyServer: mocks.readyServer,
        drainServer: mocks.drainServer,
        sleep: vi.fn(async () => undefined),
      },
    ),
  };
});

vi.mock('../src/cli/listr-preflight.js', async importActual => {
  const actual = await importActual<typeof import('../src/cli/listr-preflight.js')>();
  return {
    ...actual,
    executePreflightChecks: mocks.executePreflightChecks,
    executePluginUpdates: mocks.executePluginUpdates,
    waitForAgentRestart: mocks.waitForAgentRestart,
    assertHostControlPlaneCompatible: mocks.assertHostControlPlaneCompatible,
    printPreflightSummary: vi.fn(),
  };
});

vi.mock('../src/cli/listr-deploy.js', async importActual => {
  const actual = await importActual<typeof import('../src/cli/listr-deploy.js')>();
  return {
    ...actual,
    executeListrDeployment: mocks.executeListrDeployment,
    printDeploymentSummary: vi.fn(),
  };
});

vi.mock('../src/cli/progress.js', async importActual => {
  const actual = await importActual<typeof import('../src/cli/progress.js')>();
  return {
    ...actual,
    getWarInfo: vi.fn(async () => ({
      path: '/x.war',
      name: 'x.war',
      size: 1,
      fileCount: 1,
      modifiedAt: new Date(0),
    })),
  };
});

vi.mock('../src/war-deployer.js', async importActual => {
  const actual = await importActual<typeof import('../src/war-deployer.js')>();
  return {
    ...actual,
    calculateWarHashes: vi.fn(async () => ({})),
    readLocalWarArtifactSnapshot: vi.fn(async () => ({
      size: 1,
      sha256: 'a'.repeat(64),
      contentSha256: 'b'.repeat(64),
      hashes: {},
      getBytes: () => Buffer.from('snapshot'),
    })),
  };
});

import { registerDeployRunCommand } from '../src/cli/commands/deploy-run.js';

const HOST_A = 'agent-a.example.test';
const HOST_B = 'agent-b.example.test';
const TOKEN_A = 'host-a-control-token-0123456789abcdef';
const TOKEN_B = 'host-b-control-token-0123456789abcdef';
const TARGET_CONTENT_SHA256 = 'b'.repeat(64);
const PREVIOUS_ARTIFACT = {
  size: 512,
  sha256: 'a'.repeat(64),
  contentSha256: 'b'.repeat(64),
};

let tempDirectory: string;
let tokenAPath: string;
let tokenBPath: string;
let preparedStoppedHosts: Set<string>;
let deployedHosts: Set<string>;
let releasePreparedHosts: Set<string>;
let outageOwners: Map<string, string>;
let schedulerReleasedHosts: Set<string>;
let schedulerResumeFailuresRemaining: number;
let finalizeTimeoutHosts: Set<string>;
let journalCompletionFailuresRemaining: number;
let journalSequence: number;
let outageJournals: Map<string, {
  outageOwnerId: string;
  outageCapability: string;
  manifestSha256: string;
  commitAuthorized?: boolean;
}>;
let openedTunnelHandles: Array<{ close: ReturnType<typeof vi.fn> }>;

function requestHost(url: string): string {
  return [HOST_A, HOST_B].find(host => url.includes(host)) ?? url;
}

function preparedStatus(host: string) {
  if (releasePreparedHosts.has(host)) {
    return {
      outageFenced: true,
      outageOwnerId: outageOwners.get(host),
      targetContentSha256: TARGET_CONTENT_SHA256,
      preparedStopped: false,
      running: true,
      processCount: 1,
      receiptPhase: 'releasing',
      receiptId: `receipt-${host}`,
      applicationDeployed: true,
      artifact: PREVIOUS_ARTIFACT,
      deployedArtifact: { ...PREVIOUS_ARTIFACT, contentSha256: TARGET_CONTENT_SHA256 },
    };
  }
  if (deployedHosts.has(host)) {
    const target = { ...PREVIOUS_ARTIFACT, contentSha256: TARGET_CONTENT_SHA256 };
    return {
      outageFenced: true,
      outageOwnerId: outageOwners.get(host),
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
  return {
    outageFenced: true,
    outageOwnerId: outageOwners.get(host),
    targetContentSha256: TARGET_CONTENT_SHA256,
    preparedStopped: true,
    running: false,
    processCount: 0,
    receiptPhase: 'stopped',
    receiptId: `receipt-${host}`,
    artifact: PREVIOUS_ARTIFACT,
  };
}

function runningStatus() {
  return {
    outageFenced: false,
    preparedStopped: false,
    running: true,
    processCount: 1,
    applicationDeployed: true,
    deployedArtifact: { ...PREVIOUS_ARTIFACT, contentSha256: TARGET_CONTENT_SHA256 },
  };
}

function stopRequests() {
  return mocks.agentPost.mock.calls.filter(([url]) =>
    String(url).endsWith('/stop-for-deployment')
  );
}

function releaseRequests() {
  return mocks.agentPost.mock.calls.filter(([url]) =>
    String(url).endsWith('/stop-for-deployment/release')
  );
}

function finalizeRequests() {
  return mocks.agentPost.mock.calls.filter(([url]) =>
    String(url).endsWith('/stop-for-deployment/finalize')
  );
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

function multiClassConfig(): DeployConfig {
  return {
    name: 'fleet',
    warPath: '/x.war',
    port: 9100,
    tunnel: true,
    mutationAuthTokenFiles: {
      [HOST_A]: tokenAPath,
      [HOST_B]: tokenBPath,
    },
    migration: { roleId: 'migration-role', migrationsDir: '/db/pre' },
    classes: [
      { name: 'api', hosts: [HOST_A] },
      { name: 'worker', hosts: [HOST_B] },
    ],
  };
}

function flatConfig(): DeployConfig {
  return {
    name: 'fleet',
    hosts: [HOST_A, HOST_B],
    warPath: '/x.war',
    port: 9100,
    tunnel: true,
    mutationAuthTokenFiles: {
      [HOST_A]: tokenAPath,
      [HOST_B]: tokenBPath,
    },
    migration: { roleId: 'migration-role', migrationsDir: '/db/pre' },
  };
}

function multiClassTLSConfig(): DeployConfig {
  const config = multiClassConfig();
  config.classes = config.classes!.map((deployClass, index) => ({
    ...deployClass,
    tls: {
      verify: true,
      caCertPath: index === 0 ? tokenAPath : tokenBPath,
      httpsPort: 9443 + index,
    },
}));
  return config;
}

async function runDeploy(
  config: DeployConfig,
  extraArgs: string[] = [],
  options: { skipDrain?: boolean } = {}
): Promise<CLIPluginContext> {
  const ctx = context();
  mocks.loadDeployConfigs.mockResolvedValue({ configs: { fleet: config } });
  const program = new Command();
  program.exitOverride();
  registerDeployRunCommand(program.command('payara').command('deploy'), ctx);
  const realExit = process.exit;
  // @ts-expect-error deterministic test replacement
  process.exit = () => {
    throw new Error('__exit__');
  };
  try {
    await program.parseAsync([
      'node',
      'znvault',
      'payara',
      'deploy',
      'run',
      'fleet',
      '--yes',
      ...(options.skipDrain === false ? [] : ['--skip-drain']),
      ...extraArgs,
    ]);
  } catch (err) {
    if ((err as Error).message !== '__exit__') throw err;
  } finally {
    process.exit = realExit;
  }
  return ctx;
}

beforeEach(async () => {
  vi.clearAllMocks();
  // clearAllMocks intentionally preserves queued mock*Once results. Several
  // fail-closed tests leave an operational mock unconsumed by design, so reset
  // those queues explicitly before installing this test's defaults.
  mocks.runMigrations.mockReset();
  mocks.openTunnel.mockReset();
  mocks.configureTLS.mockReset();
  mocks.testHAProxyConnectivity.mockReset();
  mocks.executePreflightChecks.mockReset();
  mocks.executePluginUpdates.mockReset();
  mocks.waitForAgentRestart.mockReset();
  mocks.executeListrDeployment.mockReset();
  mocks.assertHostControlPlaneCompatible.mockReset();
  mocks.drainServer.mockReset();
  mocks.readyServer.mockReset();
  mocks.quiesceScheduler.mockReset();
  mocks.resumeScheduler.mockReset();
  mocks.schedulerStatus.mockReset();
  mocks.performHealthCheck.mockReset();
  mocks.agentPost.mockReset();
  mocks.agentGet.mockReset();
  tempDirectory = await mkdtemp(join(tmpdir(), 'payara-control-preflight-'));
  tokenAPath = join(tempDirectory, 'host-a-token');
  tokenBPath = join(tempDirectory, 'host-b-token');
  preparedStoppedHosts = new Set();
  deployedHosts = new Set();
  releasePreparedHosts = new Set();
  outageOwners = new Map();
  schedulerReleasedHosts = new Set();
  schedulerResumeFailuresRemaining = 0;
  finalizeTimeoutHosts = new Set();
  journalCompletionFailuresRemaining = 0;
  journalSequence = 0;
  outageJournals = new Map();
  openedTunnelHandles = [];
  await writeFile(tokenAPath, `${TOKEN_A}\n`, { mode: 0o600 });
  await chmod(tokenAPath, 0o600);
  mocks.runMigrations.mockResolvedValue(undefined);
  mocks.configureTLS.mockReturnValue(undefined);
  mocks.executePreflightChecks.mockImplementation(
    async ({ hosts }: { hosts: string[] }) => makePreflight(hosts)
  );
  mocks.executePluginUpdates.mockResolvedValue({ hostsRestarting: 0 });
  mocks.waitForAgentRestart.mockResolvedValue(undefined);
  mocks.testHAProxyConnectivity.mockResolvedValue({
    success: true,
    results: [],
  });
  mocks.assertHostControlPlaneCompatible.mockResolvedValue({
    host: HOST_A,
    reachable: true,
    agentVersion: '2.0.0',
  });
  mocks.executeListrDeployment.mockResolvedValue({
    results: new Map(),
    aborted: false,
    skipped: 0,
    successful: 2,
    failed: 0,
    healthCheckFailed: 0,
    workerFailed: 0,
  });
  mocks.drainServer.mockImplementation(async config => ({
    success: true,
    results: config.hosts.map(host => ({ host, success: true })),
  }));
  mocks.readyServer.mockImplementation(async config => ({
    success: true,
    results: config.hosts.map(host => ({ host, success: true })),
  }));
  mocks.quiesceScheduler.mockResolvedValue({ available: true, inFlightUnits: 0 });
  mocks.schedulerStatus.mockImplementation(async host => schedulerReleasedHosts.has(host)
    ? {
        available: true,
        quiesced: false,
        inFlightUnits: 0,
        deploymentHold: false,
        holdValid: true,
        outageId: null,
        targetContentSha256: null,
      }
    : {
        available: true,
        quiesced: true,
        inFlightUnits: 0,
      });
  mocks.performHealthCheck.mockResolvedValue({
    success: true,
    status: 200,
    attempts: 1,
    totalTime: 1,
  });
  mocks.openFleetOutageJournal.mockImplementation((_groups, existingOutageOwnerId?: string) => {
    if (existingOutageOwnerId) {
      const existing = outageJournals.get(existingOutageOwnerId);
      if (!existing) throw new Error('private outage journal missing');
      return existing;
    }
    journalSequence += 1;
    const outageOwnerId = `00000000-0000-4000-8000-${String(journalSequence).padStart(12, '0')}`;
    const outageContext = {
      outageOwnerId,
      outageCapability: 'C'.repeat(43),
      manifestSha256: 'd'.repeat(64),
      commitAuthorized: false,
    };
    outageJournals.set(outageOwnerId, outageContext);
    return outageContext;
  });
  mocks.openFinalizedFleetOutageJournal.mockImplementation(() => {
    const matches = [...outageJournals.values()].filter(journal => journal.commitAuthorized);
    if (matches.length > 1) throw new Error('ambiguous post-complete journal');
    return matches[0];
  });
  mocks.markFleetOutageCommitAuthorized.mockImplementation(outageContext => {
    const authorized = { ...outageContext, commitAuthorized: true };
    outageJournals.set(outageContext.outageOwnerId, authorized);
    return authorized;
  });
  mocks.completeFleetOutageJournal.mockImplementation(outageContext => {
    if (journalCompletionFailuresRemaining > 0) {
      journalCompletionFailuresRemaining -= 1;
      throw new Error('simulated crash before local journal completion');
    }
    outageJournals.delete(outageContext.outageOwnerId);
  });
  mocks.agentPost.mockImplementation(async (url, body) => {
    const host = requestHost(url);
    if (String(url).endsWith('/stop-for-deployment/release')) {
      const request = body as {
        outageOwnerId: string;
        targetContentSha256: string;
      };
      if (
        outageOwners.get(host) !== request.outageOwnerId
        || request.targetContentSha256 !== TARGET_CONTENT_SHA256
      ) {
        throw new Error('release owner/target mismatch');
      }
      releasePreparedHosts.add(host);
      if (schedulerResumeFailuresRemaining > 0) {
        schedulerResumeFailuresRemaining -= 1;
        throw new Error('simulated CLI crash before resume');
      }
      schedulerReleasedHosts.add(host);
      return {
        status: 'outage-release-prepared',
        releasePrepared: true,
        schedulerResumed: true,
      };
    }
    if (String(url).endsWith('/stop-for-deployment/finalize')) {
      const request = body as {
        outageOwnerId: string;
        targetContentSha256: string;
      };
      if (
        outageOwners.get(host) !== request.outageOwnerId
        || request.targetContentSha256 !== TARGET_CONTENT_SHA256
      ) {
        throw new Error('finalize owner/target mismatch');
      }
      if (finalizeTimeoutHosts.delete(host)) {
        throw new Error('simulated finalize timeout');
      }
      preparedStoppedHosts.delete(host);
      deployedHosts.delete(host);
      releasePreparedHosts.delete(host);
      outageOwners.delete(host);
      return {
        status: 'outage-fence-finalized',
        finalized: true,
        schedulerResumed: true,
      };
    }
    const request = body as {
      outageOwnerId: string;
      targetContentSha256: string;
    };
    preparedStoppedHosts.add(host);
    outageOwners.set(host, request.outageOwnerId);
    return {
      status: 'stopped-for-deployment',
      applicationAbsent: true,
      receiptId: `receipt-${host}`,
      outageOwnerId: request.outageOwnerId,
      targetContentSha256: request.targetContentSha256,
      artifact: PREVIOUS_ARTIFACT,
    };
  });
  mocks.agentGet.mockImplementation(async url => {
    const host = requestHost(url);
    if (String(url).endsWith('/scheduler/status')) {
      return schedulerReleasedHosts.has(host)
        ? {
            quiesced: false,
            inFlightUnits: 0,
            deploymentHold: false,
            holdValid: true,
            outageId: null,
            targetContentSha256: null,
          }
        : {
            quiesced: true,
            inFlightUnits: 0,
            deploymentHold: true,
            holdValid: true,
            outageId: outageOwners.get(host),
            targetContentSha256: TARGET_CONTENT_SHA256,
          };
    }
    return preparedStoppedHosts.has(host)
      ? preparedStatus(host)
      : runningStatus();
  });
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

function expectNoMigrationOrControlRequest(): void {
  expect(mocks.runMigrations).not.toHaveBeenCalled();
  expect(mocks.executePreflightChecks).not.toHaveBeenCalled();
  expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
}

function makePreflight(
  hosts: string[],
  options: {
    updateTargets?: Array<{ host: string; result: unknown }>;
    bootstrapHosts?: string[];
    marker?: string;
  } = {}
) {
  const bootstrapHosts = new Set(options.bootstrapHosts ?? []);
  return {
    results: new Map(),
    reachableHosts: [...hosts],
    hostsWithUpdates: options.updateTargets?.map(target => target.host) ?? [],
    analysisMap: new Map(hosts
      .filter(host => !bootstrapHosts.has(host))
      .map(host => [host, {
      success: true,
      filesChanged: 1,
      filesDeleted: 0,
      bytesToUpload: 1,
      isFullUpload: false,
      marker: options.marker,
    }])),
    updateTargets: options.updateTargets ?? [],
    bootstrapUpdateHosts: [...bootstrapHosts],
    hostsRestarting: 0,
  };
}

async function installSecondToken(): Promise<void> {
  await writeFile(tokenBPath, `${TOKEN_B}\n`, { mode: 0o600 });
  await chmod(tokenBPath, 0o600);
}

function stubSuccessfulTunnels(): void {
  let nextPort = 55000;
  mocks.openTunnel.mockImplementation(async () => {
    const tunnel = {
      localPort: ++nextPort,
      pid: 12000 + nextPort,
      close: vi.fn().mockResolvedValue(undefined),
    };
    openedTunnelHandles.push(tunnel);
    return tunnel;
  });
}

function withClassHAProxy(config: DeployConfig): DeployConfig {
  const classes = config.classes!.map((deployClass, index) => ({
    ...deployClass,
    haproxy: {
      hosts: [`lb-${index + 1}.example.test`],
      backend: `${deployClass.name}_servers`,
      serverMap: Object.fromEntries(
        (deployClass.hosts ?? []).map(host => [host, `${deployClass.name}_${host}`])
      ),
    },
  }));
  return { ...config, classes };
}

function withFlatHAProxy(config: DeployConfig): DeployConfig {
  return {
    ...config,
    haproxy: {
      hosts: ['lb-flat.example.test'],
      backend: 'api_servers',
      serverMap: Object.fromEntries(
        (config.hosts ?? []).map(host => [host, `api_${host}`])
      ),
    },
  };
}

describe('deploy run credential and transport preflight', () => {
  it.each(['--skip-version-check', '--skip-preflight'])(
    'rejects removed compatibility bypass %s before entering the action',
    async removedFlag => {
      const ctx = context();
      mocks.loadDeployConfigs.mockResolvedValue({
        configs: { fleet: flatConfig() },
      });
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeErr: () => undefined });
      registerDeployRunCommand(
        program.command('payara').command('deploy'),
        ctx
      );

      await expect(program.parseAsync([
        'node', 'znvault', 'payara', 'deploy', 'run', 'fleet', removedFlag,
      ])).rejects.toMatchObject({ code: 'commander.unknownOption' });

      expect(mocks.loadDeployConfigs).not.toHaveBeenCalled();
      expect(mocks.loadHostMutationAuthTokens).not.toHaveBeenCalled();
      expect(mocks.openTunnel).not.toHaveBeenCalled();
      expect(mocks.assertHostControlPlaneCompatible).not.toHaveBeenCalled();
      expect(mocks.executePreflightChecks).not.toHaveBeenCalled();
      expect(mocks.executePluginUpdates).not.toHaveBeenCalled();
      expect(mocks.runMigrations).not.toHaveBeenCalled();
      expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['missing', undefined],
    ['malformed', 'short'],
  ])('loads every selected class token before migration (%s later token)', async (_label, token) => {
    if (token !== undefined) {
      await writeFile(tokenBPath, token, { mode: 0o600 });
      await chmod(tokenBPath, 0o600);
    }

    const ctx = await runDeploy(multiClassConfig());

    expect(mocks.openTunnel).not.toHaveBeenCalled();
    expectNoMigrationOrControlRequest();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('Deployment failed')
    );
  });

  it('aborts a multi-class rollout before migration when a later tunnel fails', async () => {
    await writeFile(tokenBPath, `${TOKEN_B}\n`, { mode: 0o600 });
    await chmod(tokenBPath, 0o600);
    const firstTunnel = {
      localPort: 55001,
      pid: 12001,
      close: vi.fn().mockResolvedValue(undefined),
    };
    mocks.openTunnel
      .mockResolvedValueOnce(firstTunnel)
      .mockRejectedValueOnce(new Error('ssh refused'));

    const ctx = await runDeploy(multiClassConfig());

    expectNoMigrationOrControlRequest();
    expect(firstTunnel.close).toHaveBeenCalledOnce();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('refusing direct credential fallback')
    );
  });

  it('aborts a flat rollout before migration and requests when its tunnel fails', async () => {
    await writeFile(tokenBPath, `${TOKEN_B}\n`, { mode: 0o600 });
    await chmod(tokenBPath, 0o600);
    mocks.openTunnel.mockRejectedValueOnce(new Error('ssh refused'));

    const ctx = await runDeploy(flatConfig());

    expectNoMigrationOrControlRequest();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('refusing direct credential fallback')
    );
  });

  it('gates a flat rollout on Agent 2 / plugin 3 before migration', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks.mockRejectedValueOnce(
      new Error('CONTROL_PLANE_VERSION_INCOMPATIBLE: Agent 1')
    );

    const ctx = await runDeploy(flatConfig());

    expect(mocks.executePreflightChecks).toHaveBeenCalledOnce();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('CONTROL_PLANE_VERSION_INCOMPATIBLE')
    );
  });

  it('rejects a flat partial analysis even with --yes before HAProxy, migration, or WAR', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    const incomplete = makePreflight([HOST_A, HOST_B]);
    incomplete.analysisMap.delete(HOST_B);
    mocks.executePreflightChecks.mockResolvedValueOnce(incomplete);

    const ctx = await runDeploy(
      withFlatHAProxy(flatConfig()),
      [],
      { skipDrain: false }
    );

    expect(mocks.testHAProxyConnectivity).not.toHaveBeenCalled();
    expect(mocks.executePluginUpdates).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('CONTROL_PLANE_PREFLIGHT_INCOMPLETE')
    );
  });

  it('gates every multi-class target before migration or an earlier class rollout', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks
      .mockResolvedValueOnce(makePreflight([HOST_A]))
      .mockRejectedValueOnce(
        new Error('CONTROL_PLANE_VERSION_INCOMPATIBLE: plugin 2')
      );

    const ctx = await runDeploy(multiClassConfig());

    expect(mocks.executePreflightChecks).toHaveBeenCalledTimes(2);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('CONTROL_PLANE_VERSION_INCOMPATIBLE')
    );
  });

  it('performs zero updates when a later class fails the global initial preflight', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks
      .mockResolvedValueOnce(makePreflight(
        [HOST_A],
        { updateTargets: [{ host: HOST_A, result: {} }] }
      ))
      .mockRejectedValueOnce(
        new Error('CONTROL_PLANE_VERSION_INCOMPATIBLE: later worker class')
      );

    await runDeploy(multiClassConfig(), ['--update-plugins']);

    expect(mocks.executePreflightChecks).toHaveBeenCalledTimes(2);
    expect(mocks.executePluginUpdates).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
  });

  it('settles every class initial preflight even when the first class fails', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks
      .mockRejectedValueOnce(new Error('api updater metadata invalid'))
      .mockResolvedValueOnce(makePreflight([HOST_B]));

    await runDeploy(multiClassConfig(), ['--update-plugins']);

    expect(mocks.executePreflightChecks).toHaveBeenCalledTimes(2);
    expect(mocks.executePluginUpdates).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
  });

  it('gates a flat HAProxy fleet before plugin updates, migration, or WAR dispatch', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks.mockResolvedValueOnce(makePreflight(
      [HOST_A, HOST_B],
      { updateTargets: [{ host: HOST_A, result: {} }] }
    ));
    mocks.testHAProxyConnectivity.mockResolvedValueOnce({
      success: false,
      results: [{
        host: 'lb-flat.example.test',
        success: false,
        error: 'ssh refused',
      }],
    });

    const ctx = await runDeploy(
      withFlatHAProxy(flatConfig()),
      ['--update-plugins'],
      { skipDrain: false }
    );

    expect(mocks.testHAProxyConnectivity).toHaveBeenCalledOnce();
    expect(mocks.executePluginUpdates).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('HAPROXY_CONNECTIVITY_PREFLIGHT_FAILED')
    );
  });

  it('gates every class HAProxy before any multi-class update, migration, or WAR dispatch', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks
      .mockResolvedValueOnce(makePreflight(
        [HOST_A],
        { updateTargets: [{ host: HOST_A, result: {} }] }
      ))
      .mockResolvedValueOnce(makePreflight([HOST_B]));
    mocks.testHAProxyConnectivity
      .mockResolvedValueOnce({
        success: true,
        results: [{ host: 'lb-1.example.test', success: true }],
      })
      .mockResolvedValueOnce({
        success: false,
        results: [{
          host: 'lb-2.example.test',
          success: false,
          error: 'ssh refused',
        }],
      });

    const ctx = await runDeploy(
      withClassHAProxy(multiClassConfig()),
      ['--update-plugins'],
      { skipDrain: false }
    );

    expect(mocks.testHAProxyConnectivity).toHaveBeenCalledTimes(2);
    expect(mocks.executePluginUpdates).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('HAPROXY_CONNECTIVITY_PREFLIGHT_FAILED')
    );
  });

  it('consumes one successful global HAProxy check per class without rechecking during rollout', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.testHAProxyConnectivity
      .mockResolvedValueOnce({
        success: true,
        results: [{ host: 'lb-1.example.test', success: true }],
      })
      .mockResolvedValueOnce({
        success: true,
        results: [{ host: 'lb-2.example.test', success: true }],
      });

    await runDeploy(
      withClassHAProxy(multiClassConfig()),
      [],
      { skipDrain: false }
    );

    expect(mocks.testHAProxyConnectivity).toHaveBeenCalledTimes(2);
    expect(mocks.runMigrations).toHaveBeenCalled();
    expect(mocks.executeListrDeployment).toHaveBeenCalledTimes(2);
  });

  it('does not impose the rollout HAProxy gate on an explicit migration-only command', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.testHAProxyConnectivity.mockRejectedValueOnce(
      new Error('HAProxy intentionally unavailable during maintenance')
    );
    const config = {
      ...withClassHAProxy(multiClassConfig()),
      postMigration: { roleId: 'migration-role', migrationsDir: '/db/post' },
    };

    await runDeploy(config, ['--post-only'], { skipDrain: false });

    expect(mocks.testHAProxyConnectivity).not.toHaveBeenCalled();
    expect(mocks.runMigrations).toHaveBeenCalledOnce();
    expect(mocks.executePluginUpdates).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
  });

  it('rejects an empty multi-class selection before credentials, tunnels, or DB mutation', async () => {
    const config = multiClassConfig();
    config.classes = [
      { name: 'empty', hosts: [] },
      { name: 'worker', hosts: [HOST_B] },
    ];

    const ctx = await runDeploy(config, ['--class', 'empty']);

    expect(mocks.loadHostMutationAuthTokens).not.toHaveBeenCalled();
    expect(mocks.openTunnel).not.toHaveBeenCalled();
    expectNoMigrationOrControlRequest();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('no target hosts')
    );
  });

  it('gates every multi-class migration-only target before the DB lease', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.assertHostControlPlaneCompatible
      .mockResolvedValueOnce({
        host: HOST_A, reachable: true, agentVersion: '2.0.0',
      })
      .mockRejectedValueOnce(
        new Error('CONTROL_PLANE_VERSION_INCOMPATIBLE: plugin 2')
      );
    const config = {
      ...multiClassConfig(),
      postMigration: { roleId: 'migration-role', migrationsDir: '/db/post' },
    };

    const ctx = await runDeploy(config, ['--post-only']);

    expect(mocks.openTunnel).toHaveBeenCalledTimes(2);
    expect(mocks.assertHostControlPlaneCompatible).toHaveBeenCalledTimes(2);
    expect(
      mocks.openTunnel.mock.invocationCallOrder[1]
    ).toBeLessThan(
      mocks.assertHostControlPlaneCompatible.mock.invocationCallOrder[0]!
    );
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executePreflightChecks).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('CONTROL_PLANE_VERSION_INCOMPATIBLE')
    );
  });

  it('aborts flat deployment before migration when any plugin update fails', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks.mockResolvedValueOnce(makePreflight(
      [HOST_A, HOST_B],
      { updateTargets: [{ host: HOST_B, result: {} }] }
    ));
    mocks.executePluginUpdates.mockRejectedValueOnce(
      new Error(`Plugin update failed on ${HOST_B}`)
    );

    const ctx = await runDeploy(flatConfig(), ['--update-plugins']);

    expect(mocks.executePluginUpdates).toHaveBeenCalledOnce();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('Plugin update failed')
    );
  });

  it('performs no analysis-backed migration or WAR work when a Plugin 2 bootstrap update fails', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks.mockResolvedValueOnce(makePreflight(
      [HOST_A, HOST_B],
      {
        bootstrapHosts: [HOST_A],
        updateTargets: [{ host: HOST_A, result: {} }],
      }
    ));
    mocks.executePluginUpdates.mockRejectedValueOnce(
      new Error(`Exact Plugin 2 -> 3 update failed on ${HOST_A}`)
    );

    const ctx = await runDeploy(flatConfig(), ['--update-plugins']);

    expect(mocks.executePluginUpdates).toHaveBeenCalledOnce();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('Plugin 2 -> 3 update failed')
    );
  });

  it('bootstraps a mixed flat Plugin 2/3 fleet then discards the whole initial snapshot', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    const initial = makePreflight(
      [HOST_A, HOST_B],
      {
        bootstrapHosts: [HOST_A],
        updateTargets: [{ host: HOST_A, result: {} }],
        marker: 'mixed-stale',
      }
    );
    const refreshed = makePreflight(
      [HOST_A, HOST_B],
      { marker: 'mixed-fresh' }
    );
    mocks.executePreflightChecks
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);

    await runDeploy(flatConfig(), ['--update-plugins']);

    expect(initial.analysisMap.has(HOST_A)).toBe(false);
    expect(initial.analysisMap.has(HOST_B)).toBe(true);
    expect(mocks.executePluginUpdates).toHaveBeenCalledOnce();
    expect(mocks.executePreflightChecks).toHaveBeenCalledTimes(2);
    expect(mocks.runMigrations).toHaveBeenCalled();
    expect(mocks.executeListrDeployment.mock.calls[0]?.[2].analysisMap).toBe(
      refreshed.analysisMap
    );
  });

  it('does not bootstrap one flat host when another Plugin 3 analysis is invalid', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    const initial = makePreflight(
      [HOST_A, HOST_B],
      {
        bootstrapHosts: [HOST_A],
        updateTargets: [{ host: HOST_A, result: {} }],
      }
    );
    initial.analysisMap.delete(HOST_B);
    mocks.executePreflightChecks.mockResolvedValueOnce(initial);

    await runDeploy(flatConfig(), ['--update-plugins']);

    expect(mocks.executePluginUpdates).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
  });

  it('applies multi-class updates before migration and fails closed on a later class', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks
      .mockResolvedValueOnce(makePreflight([HOST_A]))
      .mockResolvedValueOnce(makePreflight(
        [HOST_B],
        { updateTargets: [{ host: HOST_B, result: {} }] }
      ));
    mocks.executePluginUpdates.mockRejectedValueOnce(
      new Error(`Plugin update failed on ${HOST_B}`)
    );

    await runDeploy(multiClassConfig(), ['--update-plugins']);

    expect(mocks.executePluginUpdates).toHaveBeenCalledOnce();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
  });

  it('attempts every class update receipt before rejecting one failed updater group', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks
      .mockResolvedValueOnce(makePreflight(
        [HOST_A],
        { updateTargets: [{ host: HOST_A, result: {} }] }
      ))
      .mockResolvedValueOnce(makePreflight(
        [HOST_B],
        { updateTargets: [{ host: HOST_B, result: {} }] }
      ));
    mocks.executePluginUpdates
      .mockRejectedValueOnce(new Error(`Plugin update failed on ${HOST_A}`))
      .mockResolvedValueOnce({ hostsRestarting: 1 });

    await runDeploy(multiClassConfig(), ['--update-plugins']);

    expect(mocks.executePluginUpdates).toHaveBeenCalledTimes(2);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
  });

  it('re-preflights every class globally after all multi-class updates succeed', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks
      .mockResolvedValueOnce(makePreflight(
        [HOST_A],
        { updateTargets: [{ host: HOST_A, result: {} }], marker: 'api-stale' }
      ))
      .mockResolvedValueOnce(makePreflight(
        [HOST_B],
        { updateTargets: [{ host: HOST_B, result: {} }], marker: 'worker-stale' }
      ))
      .mockResolvedValueOnce(makePreflight([HOST_A], { marker: 'api-fresh' }))
      .mockResolvedValueOnce(makePreflight([HOST_B], { marker: 'worker-fresh' }));
    mocks.executePluginUpdates.mockResolvedValue({ hostsRestarting: 0 });

    await runDeploy(multiClassConfig(), ['--update-plugins']);

    expect(mocks.executePluginUpdates).toHaveBeenCalledTimes(2);
    expect(mocks.executePreflightChecks).toHaveBeenCalledTimes(4);
    expect(mocks.runMigrations).toHaveBeenCalled();
    expect(mocks.executeListrDeployment).toHaveBeenCalledTimes(2);
    expect(
      mocks.executePreflightChecks.mock.invocationCallOrder[3]
    ).toBeLessThan(mocks.runMigrations.mock.invocationCallOrder[0]!);
  });

  it('settles every post-update class preflight and blocks DB/WAR on one failure', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks
      .mockResolvedValueOnce(makePreflight(
        [HOST_A],
        {
          bootstrapHosts: [HOST_A],
          updateTargets: [{ host: HOST_A, result: {} }],
        }
      ))
      .mockResolvedValueOnce(makePreflight(
        [HOST_B],
        { updateTargets: [{ host: HOST_B, result: {} }] }
      ))
      .mockRejectedValueOnce(new Error('api did not restart into Plugin 3'))
      .mockResolvedValueOnce(makePreflight([HOST_B]));

    await runDeploy(multiClassConfig(), ['--update-plugins']);

    expect(mocks.executePluginUpdates).toHaveBeenCalledTimes(2);
    expect(mocks.executePreflightChecks).toHaveBeenCalledTimes(4);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
  });

  it('rebinds each class CA before every update and global re-preflight', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks
      .mockResolvedValueOnce(makePreflight(
        [HOST_A],
        {
          bootstrapHosts: [HOST_A],
          updateTargets: [{ host: HOST_A, result: {} }],
        }
      ))
      .mockResolvedValueOnce(makePreflight(
        [HOST_B],
        { updateTargets: [{ host: HOST_B, result: {} }] }
      ))
      .mockResolvedValueOnce(makePreflight([HOST_A]))
      .mockResolvedValueOnce(makePreflight([HOST_B]));

    await runDeploy(multiClassTLSConfig(), ['--update-plugins']);

    expect(mocks.executePluginUpdates).toHaveBeenCalledTimes(2);
    expect(mocks.executePreflightChecks).toHaveBeenCalledTimes(4);
    expect(mocks.configureTLS.mock.calls.slice(0, 6).map(call => call[0])).toEqual([
      { verify: true, caCertPath: tokenAPath },
      { verify: true, caCertPath: tokenBPath },
      { verify: true, caCertPath: tokenAPath },
      { verify: true, caCertPath: tokenBPath },
      { verify: true, caCertPath: tokenAPath },
      { verify: true, caCertPath: tokenBPath },
    ]);
    expect(mocks.runMigrations).toHaveBeenCalled();
    expect(mocks.executeListrDeployment).toHaveBeenCalledTimes(2);
  });

  it('fails closed before migration and WAR when a class TLS context cannot be restored', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executePreflightChecks
      .mockResolvedValueOnce(makePreflight(
        [HOST_A],
        { updateTargets: [{ host: HOST_A, result: {} }] }
      ))
      .mockResolvedValueOnce(makePreflight(
        [HOST_B],
        { updateTargets: [{ host: HOST_B, result: {} }] }
      ));
    mocks.configureTLS
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new Error('class A CA context mismatch');
      });

    const ctx = await runDeploy(multiClassTLSConfig(), ['--update-plugins']);

    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('class A CA context mismatch')
    );
  });

  it('discards pre-update analysis and revalidates before migration/deployment', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    const initial = makePreflight(
      [HOST_A, HOST_B],
      { updateTargets: [{ host: HOST_A, result: {} }], marker: 'stale' }
    );
    const refreshed = makePreflight(
      [HOST_A, HOST_B],
      { marker: 'fresh' }
    );
    mocks.executePreflightChecks
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    mocks.executePluginUpdates.mockResolvedValueOnce({ hostsRestarting: 1 });

    await runDeploy(flatConfig(), ['--update-plugins']);

    expect(mocks.executePreflightChecks).toHaveBeenCalledTimes(2);
    expect(mocks.waitForAgentRestart).toHaveBeenCalledOnce();
    expect(mocks.runMigrations).toHaveBeenCalled();
    expect(mocks.executeListrDeployment).toHaveBeenCalledOnce();
    expect(
      mocks.executePreflightChecks.mock.invocationCallOrder[1]
    ).toBeLessThan(mocks.runMigrations.mock.invocationCallOrder[0]!);
    expect(
      mocks.runMigrations.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.executeListrDeployment.mock.invocationCallOrder[0]!);
    expect(mocks.executeListrDeployment.mock.calls[0]?.[2].analysisMap).toBe(
      refreshed.analysisMap
    );
  });
});

describe('deploy run strict fleet-stop gate', () => {
  async function requireFleetStopFor(
    config: DeployConfig,
    options: { relative?: boolean } = {},
  ): Promise<DeployConfig> {
    const migrationsDir = join(tempDirectory, 'migrations', 'pre');
    await mkdir(migrationsDir, { recursive: true });
    await writeFile(
      join(migrationsDir, '.znvault-require-fleet-stop'),
      'This pre-migration requires a complete fleet stop.\n',
    );
    return {
      ...config,
      ...(options.relative ? { rootDir: tempDirectory } : {}),
      migration: {
        ...config.migration!,
        migrationsDir: options.relative
          ? join('migrations', 'pre')
          : migrationsDir,
      },
    };
  }

  function strictFlatConfig(): DeployConfig {
    return {
      ...withFlatHAProxy(flatConfig()),
      postMigration: { roleId: 'migration-role', migrationsDir: '/db/post' },
    };
  }

  function strictMultiConfig(): DeployConfig {
    const config = multiClassConfig();
    config.postMigration = { roleId: 'migration-role', migrationsDir: '/db/post' };
    config.classes = [
      {
        ...config.classes![0]!,
        haproxy: {
          hosts: ['lb-api.example.test'],
          backend: 'api_servers',
          serverMap: { [HOST_A]: 'api_a' },
          drainWaitSeconds: 0,
        },
      },
      { ...config.classes![1]!, blocking: false },
    ];
    return config;
  }

  it('registers the explicit fleet-stop capability flag', () => {
    const ctx = context();
    const program = new Command();
    registerDeployRunCommand(program.command('payara').command('deploy'), ctx);
    const run = program.commands
      .find(command => command.name() === 'payara')!
      .commands.find(command => command.name() === 'deploy')!
      .commands.find(command => command.name() === 'run')!;

    expect(
      run.options.find(option => option.long === '--require-fleet-stop-before-pre')
    ).toBeDefined();
  });

  it('keeps strict dry-run free of fleet mutations, SQL, and WAR dispatch', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    const config = await requireFleetStopFor(strictFlatConfig());

    const ctx = await runDeploy(
      config,
      ['--require-fleet-stop-before-pre', '--dry-run'],
      { skipDrain: false },
    );

    expect(mocks.drainServer).not.toHaveBeenCalled();
    expect(mocks.quiesceScheduler).not.toHaveBeenCalled();
    expect(mocks.agentPost).not.toHaveBeenCalled();
    expect(mocks.agentGet).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(mocks.readyServer).not.toHaveBeenCalled();
    expect(ctx.output.info).toHaveBeenCalledWith(
      expect.stringContaining('[dry-run] would drain routed hosts')
    );
  });

  it.each([
    ['flat', false],
    ['multi-class with a root-relative migrationsDir', true],
  ])(
    'requires the sentinel capability flag for %s before credentials, hosts, or SQL',
    async (_name, multiClass) => {
      const base = multiClass ? strictMultiConfig() : strictFlatConfig();
      const config = await requireFleetStopFor(base, { relative: multiClass });

      const ctx = await runDeploy(config, [], { skipDrain: false });

      expect(mocks.loadHostMutationAuthTokens).not.toHaveBeenCalled();
      expect(mocks.openTunnel).not.toHaveBeenCalled();
      expect(mocks.executePreflightChecks).not.toHaveBeenCalled();
      expect(mocks.testHAProxyConnectivity).not.toHaveBeenCalled();
      expect(mocks.drainServer).not.toHaveBeenCalled();
      expect(mocks.quiesceScheduler).not.toHaveBeenCalled();
      expect(mocks.agentPost).not.toHaveBeenCalled();
      expect(mocks.agentGet).not.toHaveBeenCalled();
      expect(mocks.runMigrations).not.toHaveBeenCalled();
      expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
      expect(ctx.output.error).toHaveBeenCalledWith(
        expect.stringContaining('.znvault-require-fleet-stop')
      );
    }
  );

  it.each([
    ['--skip-pre'],
    ['--skip-migrations'],
  ])(
    'does not let %s bypass a rollout sentinel when the capability flag is omitted',
    async bypassFlag => {
      const config = await requireFleetStopFor(strictFlatConfig());

      const ctx = await runDeploy(
        config,
        [bypassFlag],
        { skipDrain: false },
      );

      expect(mocks.loadHostMutationAuthTokens).not.toHaveBeenCalled();
      expect(mocks.openTunnel).not.toHaveBeenCalled();
      expect(mocks.executePreflightChecks).not.toHaveBeenCalled();
      expect(mocks.testHAProxyConnectivity).not.toHaveBeenCalled();
      expect(mocks.drainServer).not.toHaveBeenCalled();
      expect(mocks.quiesceScheduler).not.toHaveBeenCalled();
      expect(mocks.agentPost).not.toHaveBeenCalled();
      expect(mocks.agentGet).not.toHaveBeenCalled();
      expect(mocks.runMigrations).not.toHaveBeenCalled();
      expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
      expect(ctx.output.error).toHaveBeenCalledWith(
        expect.stringContaining('.znvault-require-fleet-stop')
      );
    }
  );

  it('does not require the pre sentinel flag for a post-only recovery plan', async () => {
    const config = await requireFleetStopFor(strictFlatConfig());

    const ctx = await runDeploy(
      config,
      ['--post-only', '--dry-run'],
      { skipDrain: false },
    );

    expect(ctx.output.error).not.toHaveBeenCalledWith(
      expect.stringContaining('.znvault-require-fleet-stop')
    );
    expect(mocks.loadHostMutationAuthTokens).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it.each([
    ['scoped host', ['--host', HOST_A]],
    ['scoped alias', ['--only', HOST_A]],
    ['skip drain', ['--skip-drain']],
    ['skip pre', ['--skip-pre']],
    ['skip migrations', ['--skip-migrations']],
    ['pre only', ['--pre-only']],
    ['post only', ['--post-only']],
    ['migrations only', ['--migrations-only']],
  ])('rejects %s before credentials, host requests, or SQL', async (_name, flags) => {
    await installSecondToken();

    const ctx = await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre', ...flags],
      { skipDrain: false },
    );

    expect(mocks.loadHostMutationAuthTokens).not.toHaveBeenCalled();
    expect(mocks.openTunnel).not.toHaveBeenCalled();
    expect(mocks.executePreflightChecks).not.toHaveBeenCalled();
    expect(mocks.testHAProxyConnectivity).not.toHaveBeenCalled();
    expect(mocks.drainServer).not.toHaveBeenCalled();
    expect(mocks.quiesceScheduler).not.toHaveBeenCalled();
    expect(mocks.agentPost).not.toHaveBeenCalled();
    expect(mocks.agentGet).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalled();
  });

  it('rejects a class-scoped multi-class request before operational I/O', async () => {
    await installSecondToken();
    const config = withClassHAProxy(multiClassConfig());

    await runDeploy(
      config,
      ['--require-fleet-stop-before-pre', '--class', 'api'],
      { skipDrain: false },
    );

    expect(mocks.loadHostMutationAuthTokens).not.toHaveBeenCalled();
    expect(mocks.openTunnel).not.toHaveBeenCalled();
    expect(mocks.executePreflightChecks).not.toHaveBeenCalled();
    expect(mocks.drainServer).not.toHaveBeenCalled();
    expect(mocks.quiesceScheduler).not.toHaveBeenCalled();
    expect(mocks.agentPost).not.toHaveBeenCalled();
    expect(mocks.agentGet).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it.each(['flat', 'multi-class']) (
    'requires tunneled local operator transport for %s before operational I/O',
    async shape => {
      const config = shape === 'flat' ? strictFlatConfig() : strictMultiConfig();
      if (shape === 'flat') config.tunnel = false;
      else config.classes![1]!.tunnel = false;

      const ctx = await runDeploy(
        config,
        ['--require-fleet-stop-before-pre'],
        { skipDrain: false },
      );

      expect(mocks.loadHostMutationAuthTokens).not.toHaveBeenCalled();
      expect(mocks.openTunnel).not.toHaveBeenCalled();
      expect(mocks.agentPost).not.toHaveBeenCalled();
      expect(mocks.runMigrations).not.toHaveBeenCalled();
      expect(ctx.output.error).toHaveBeenCalledWith(expect.stringContaining('tunnel=true'));
    },
  );

  it('runs SQL only after the complete strict fleet-stop barrier succeeds', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executeListrDeployment.mockResolvedValueOnce({
      results: new Map([
        [HOST_A, { success: true, result: { success: true, deployed: true } }],
        [HOST_B, { success: true, result: { success: true, deployed: true } }],
      ]),
      aborted: false,
      skipped: 0,
      successful: 2,
      failed: 0,
      healthCheckFailed: 0,
      workerFailed: 0,
    });

    await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(mocks.drainServer).toHaveBeenCalledTimes(2);
    expect(mocks.quiesceScheduler).toHaveBeenCalledTimes(4);
    expect(mocks.schedulerStatus).toHaveBeenCalledTimes(4);
    expect(stopRequests()).toHaveLength(2);
    expect(releaseRequests()).toHaveLength(2);
    expect(finalizeRequests()).toHaveLength(2);
    expect(mocks.agentGet).toHaveBeenCalledTimes(8);
    expect(mocks.runMigrations).toHaveBeenCalled();
    const stoppedStateReadOrders = mocks.agentGet.mock.calls.flatMap((call, index) =>
      String(call[0]).endsWith('/stop-for-deployment/status')
        ? [mocks.agentGet.mock.invocationCallOrder[index]!]
        : []
    );
    expect(stoppedStateReadOrders.at(-1)!)
      .toBeLessThan(mocks.runMigrations.mock.invocationCallOrder[0]!);
    expect(mocks.executeListrDeployment).toHaveBeenCalledOnce();
    expect(
      mocks.executeListrDeployment.mock.calls[0]?.[2].deferHAProxyReady
    ).toBe(true);
    expect(
      mocks.executeListrDeployment.mock.calls[0]?.[2].outageOwnerId,
    ).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(mocks.readyServer).toHaveBeenCalledTimes(2);
    const firstReleaseIndex = mocks.agentPost.mock.calls.findIndex(([url]) =>
      String(url).endsWith('/stop-for-deployment/release')
    );
    expect(firstReleaseIndex).toBeGreaterThanOrEqual(0);
    expect(
      mocks.runMigrations.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(mocks.agentPost.mock.invocationCallOrder[firstReleaseIndex]!);
    const firstFinalizeIndex = mocks.agentPost.mock.calls.findIndex(([url]) =>
      String(url).endsWith('/stop-for-deployment/finalize')
    );
    expect(firstFinalizeIndex).toBeGreaterThanOrEqual(0);
    expect(
      mocks.agentPost.mock.invocationCallOrder[firstReleaseIndex],
    ).toBeLessThan(mocks.readyServer.mock.invocationCallOrder[0]!);
    const schedulerReleaseProofOrders = mocks.agentGet.mock.calls.flatMap((call, index) =>
      String(call[0]).endsWith('/scheduler/status')
        ? [mocks.agentGet.mock.invocationCallOrder[index]!]
        : []
    );
    expect(schedulerReleaseProofOrders).toHaveLength(2);
    expect(schedulerReleaseProofOrders.at(-1)!)
      .toBeLessThan(mocks.readyServer.mock.invocationCallOrder[0]!);
    expect(
      mocks.readyServer.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(mocks.agentPost.mock.invocationCallOrder[firstFinalizeIndex]!);
    for (const tunnel of openedTunnelHandles) {
      expect(tunnel.close).toHaveBeenCalledOnce();
      expect(mocks.agentPost.mock.invocationCallOrder.at(-1)!)
        .toBeLessThan(tunnel.close.mock.invocationCallOrder[0]!);
    }
    expect(
      mocks.runMigrations.mock.invocationCallOrder.at(-1)
    ).toBeLessThan(
      mocks.readyServer.mock.invocationCallOrder[0]!
    );
  });

  it('allows --skip-post and publishes only after pre + verified rollout', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executeListrDeployment.mockResolvedValueOnce({
      results: new Map([
        [HOST_A, { success: true, result: { success: true, deployed: true } }],
        [HOST_B, { success: true, result: { success: true, deployed: true } }],
      ]),
      aborted: false,
      skipped: 0,
      successful: 2,
      failed: 0,
      healthCheckFailed: 0,
      workerFailed: 0,
    });

    await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre', '--skip-post'],
      { skipDrain: false },
    );

    expect(mocks.runMigrations).toHaveBeenCalledOnce();
    expect(mocks.executeListrDeployment).toHaveBeenCalledOnce();
    expect(mocks.readyServer).toHaveBeenCalledTimes(2);
    expect(
      mocks.executeListrDeployment.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.readyServer.mock.invocationCallOrder[0]!);
  });

  it('never runs SQL or dispatches a WAR when strict fleet stop is not proven', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    let reads = 0;
    mocks.agentGet.mockImplementation(async url => {
      reads += 1;
      const host = requestHost(url);
      if (reads === 5) return runningStatus();
      return reads <= 4
        ? runningStatus()
        : preparedStatus(host);
    });

    const ctx = await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(stopRequests()).toHaveLength(2);
    expect(releaseRequests()).toHaveLength(0);
    expect(mocks.agentGet).toHaveBeenCalledTimes(6);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(mocks.readyServer).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('FLEET_STOP_PAYARA_NOT_PROVEN')
    );
  });

  it.each([
    [
      'drain',
      () => mocks.drainServer.mockResolvedValueOnce({
        success: false,
        results: [{
          host: 'lb-flat.example.test',
          success: false,
          error: 'drain refused',
        }],
      }),
      'FLEET_STOP_DRAIN_FAILED',
    ],
    [
      'quiesce',
      () => mocks.quiesceScheduler.mockResolvedValueOnce({
        available: false,
        reason: 'scheduler endpoint unavailable',
      }),
      'FLEET_STOP_QUIESCE_FAILED',
    ],
    [
      'zero-in-flight proof',
      () => mocks.schedulerStatus.mockResolvedValueOnce({
        available: false,
        reason: 'status endpoint unavailable',
      }),
      'FLEET_STOP_SCHEDULER_DRAIN_FAILED',
    ],
    [
      'stop receipt',
      () => mocks.agentPost.mockResolvedValueOnce({ status: 'stopping' }),
      'FLEET_STOP_PAYARA_NOT_PROVEN',
    ],
    [
      'process-absence proof',
      () => {
        let reads = 0;
        mocks.agentGet.mockImplementation(async url => {
          reads += 1;
          const host = requestHost(url);
          if (reads === 5) {
            return runningStatus();
          }
          return reads <= 4
            ? runningStatus()
            : preparedStatus(host);
        });
      },
      'FLEET_STOP_PAYARA_NOT_PROVEN',
    ],
  ])('blocks every SQL migration when the %s phase fails', async (
    _phase,
    failPhase,
    expectedCode,
  ) => {
    await installSecondToken();
    stubSuccessfulTunnels();
    failPhase();

    const ctx = await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(mocks.readyServer).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining(expectedCode)
    );
  });

  it('keeps the fleet drained when the pre migration fails after the barrier', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.runMigrations.mockRejectedValueOnce(new Error('pre SQL failed'));

    await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(mocks.agentGet).toHaveBeenCalledTimes(6);
    expect(mocks.runMigrations).toHaveBeenCalledOnce();
    expect(mocks.executeListrDeployment).not.toHaveBeenCalled();
    expect(mocks.readyServer).not.toHaveBeenCalled();
  });

  it('keeps the fleet drained when rollout receipts are incomplete', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executeListrDeployment.mockResolvedValueOnce({
      results: new Map([
        [HOST_A, { success: true, result: { success: true, deployed: true } }],
      ]),
      aborted: false,
      skipped: 0,
      successful: 1,
      failed: 1,
      healthCheckFailed: 0,
      workerFailed: 0,
    });

    await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(mocks.runMigrations).toHaveBeenCalledOnce();
    expect(mocks.executeListrDeployment).toHaveBeenCalledOnce();
    expect(mocks.readyServer).not.toHaveBeenCalled();
  });

  it('keeps the fleet drained when the post migration fails', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executeListrDeployment.mockResolvedValueOnce({
      results: new Map([
        [HOST_A, { success: true, result: { success: true, deployed: true } }],
        [HOST_B, { success: true, result: { success: true, deployed: true } }],
      ]),
      aborted: false,
      skipped: 0,
      successful: 2,
      failed: 0,
      healthCheckFailed: 0,
      workerFailed: 0,
    });
    mocks.runMigrations
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('post SQL failed'));

    await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(mocks.runMigrations).toHaveBeenCalledTimes(2);
    expect(mocks.readyServer).not.toHaveBeenCalled();
  });

  it('re-drains the complete fleet when the final READY commit is partial', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executeListrDeployment.mockResolvedValueOnce({
      results: new Map([
        [HOST_A, { success: true, result: { success: true, deployed: true } }],
        [HOST_B, { success: true, result: { success: true, deployed: true } }],
      ]),
      aborted: false,
      skipped: 0,
      successful: 2,
      failed: 0,
      healthCheckFailed: 0,
      workerFailed: 0,
    });
    mocks.readyServer.mockImplementation(async (config, host) => ({
      success: host !== HOST_A,
      results: config.hosts.map(loadBalancer => ({
        host: loadBalancer,
        success: host !== HOST_A,
        error: host === HOST_A ? 'READY refused' : undefined,
      })),
    }));

    const ctx = await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(mocks.runMigrations).toHaveBeenCalledTimes(2);
    expect(mocks.readyServer).toHaveBeenCalledTimes(2);
    // Two initial strict drains plus a compensating drain for every routed host.
    expect(mocks.drainServer).toHaveBeenCalledTimes(4);
    expect(
      mocks.readyServer.mock.invocationCallOrder.at(-1)!
    ).toBeLessThan(mocks.drainServer.mock.invocationCallOrder.at(-1)!);
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('compensation returned the complete routed fleet to DRAIN')
    );
  });

  it('keeps every multi-class API host drained through worker and post phases', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executeListrDeployment
      .mockResolvedValueOnce({
        results: new Map([
          [HOST_A, { success: true, result: { success: true, deployed: true } }],
        ]),
        aborted: false,
        skipped: 0,
        successful: 1,
        failed: 0,
        healthCheckFailed: 0,
        workerFailed: 0,
      })
      .mockResolvedValueOnce({
        results: new Map([
          [HOST_B, { success: true, result: { success: true, deployed: true } }],
        ]),
        aborted: false,
        skipped: 0,
        successful: 1,
        failed: 0,
        healthCheckFailed: 0,
        workerFailed: 0,
      });

    await runDeploy(
      strictMultiConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(mocks.executeListrDeployment).toHaveBeenCalledTimes(2);
    expect(
      mocks.executeListrDeployment.mock.calls.map(call => call[2].deferHAProxyReady)
    ).toEqual([true, true]);
    expect(mocks.readyServer).toHaveBeenCalledOnce();
    expect(mocks.readyServer.mock.calls[0]?.[1]).toBe(HOST_A);
    expect(
      mocks.runMigrations.mock.invocationCallOrder.at(-1)!
    ).toBeLessThan(mocks.readyServer.mock.invocationCallOrder[0]!);
    expect(finalizeRequests()).toHaveLength(2);
    for (const tunnel of openedTunnelHandles) {
      expect(tunnel.close).toHaveBeenCalledOnce();
      expect(mocks.agentPost.mock.invocationCallOrder.at(-1)!)
        .toBeLessThan(tunnel.close.mock.invocationCallOrder[0]!);
    }
  });

  it('recovers a CLI crash after PID0 by reusing exact receipts and re-proving the whole fleet before SQL', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.runMigrations
      .mockRejectedValueOnce(new Error('simulated CLI interruption before SQL commit'))
      .mockResolvedValue(undefined);
    mocks.executeListrDeployment.mockResolvedValue({
      results: new Map([
        [HOST_A, { success: true, result: { success: true, deployed: true } }],
        [HOST_B, { success: true, result: { success: true, deployed: true } }],
      ]),
      aborted: false,
      skipped: 0,
      successful: 2,
      failed: 0,
      healthCheckFailed: 0,
      workerFailed: 0,
    });

    await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );
    expect(preparedStoppedHosts).toEqual(new Set([HOST_A, HOST_B]));
    expect(stopRequests()).toHaveLength(2);
    expect(releaseRequests()).toHaveLength(0);
    expect(mocks.runMigrations).toHaveBeenCalledOnce();

    await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(stopRequests()).toHaveLength(2);
    expect(releaseRequests()).toHaveLength(2);
    expect(mocks.quiesceScheduler).toHaveBeenCalledTimes(4);
    expect(mocks.agentGet).toHaveBeenCalledTimes(14);
    expect(mocks.runMigrations).toHaveBeenCalledTimes(3);
    const stoppedStateReadOrders = mocks.agentGet.mock.calls.flatMap((call, index) =>
      String(call[0]).endsWith('/stop-for-deployment/status')
        ? [mocks.agentGet.mock.invocationCallOrder[index]!]
        : []
    );
    expect(stoppedStateReadOrders.at(-1)!)
      .toBeLessThan(mocks.runMigrations.mock.invocationCallOrder[1]!);
  });

  it('resumes only unfinished hosts after a partial deployed/stopped rollout', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    const config = {
      ...strictFlatConfig(),
      healthCheck: { path: '/health' },
    };
    mocks.executeListrDeployment
      .mockImplementationOnce(async (_strategy, hosts) => {
        expect(hosts).toEqual([HOST_A, HOST_B]);
        deployedHosts.add(HOST_A);
        return {
          results: new Map([
            [HOST_A, { success: true, result: { success: true, deployed: true } }],
            [HOST_B, { success: false, error: 'simulated rollout interruption' }],
          ]),
          aborted: true,
          skipped: 0,
          successful: 1,
          failed: 1,
          healthCheckFailed: 0,
          workerFailed: 0,
        };
      })
      .mockImplementationOnce(async (_strategy, hosts) => {
        expect(hosts).toEqual([HOST_B]);
        deployedHosts.add(HOST_B);
        return {
          results: new Map([
            [HOST_B, { success: true, result: { success: true, deployed: true } }],
          ]),
          aborted: false,
          skipped: 0,
          successful: 1,
          failed: 0,
          healthCheckFailed: 0,
          workerFailed: 0,
        };
      });

    await runDeploy(config, ['--require-fleet-stop-before-pre'], { skipDrain: false });
    expect(releaseRequests()).toHaveLength(0);

    await runDeploy(config, ['--require-fleet-stop-before-pre'], { skipDrain: false });

    expect(mocks.executeListrDeployment).toHaveBeenCalledTimes(2);
    expect(mocks.performHealthCheck).toHaveBeenCalledWith(
      HOST_A,
      config.healthCheck,
    );
    expect(releaseRequests()).toHaveLength(2);
    expect(finalizeRequests()).toHaveLength(2);
  });

  it('rechecks health and completes post after every host was deployed before a CLI crash', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    const config = {
      ...strictFlatConfig(),
      healthCheck: { path: '/health' },
    };
    mocks.runMigrations
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('simulated post interruption'))
      .mockResolvedValue(undefined);
    mocks.executeListrDeployment
      .mockImplementationOnce(async (_strategy, hosts) => {
        expect(hosts).toEqual([HOST_A, HOST_B]);
        deployedHosts.add(HOST_A);
        deployedHosts.add(HOST_B);
        return {
          results: new Map([
            [HOST_A, { success: true, result: { success: true, deployed: true } }],
            [HOST_B, { success: true, result: { success: true, deployed: true } }],
          ]),
          aborted: false,
          skipped: 0,
          successful: 2,
          failed: 0,
          healthCheckFailed: 0,
          workerFailed: 0,
        };
      })
      .mockImplementationOnce(async (_strategy, hosts) => {
        expect(hosts).toEqual([]);
        return {
          results: new Map(),
          aborted: false,
          skipped: 0,
          successful: 0,
          failed: 0,
          healthCheckFailed: 0,
          workerFailed: 0,
        };
      });

    await runDeploy(config, ['--require-fleet-stop-before-pre'], { skipDrain: false });
    expect(releaseRequests()).toHaveLength(0);

    await runDeploy(config, ['--require-fleet-stop-before-pre'], { skipDrain: false });

    expect(mocks.executeListrDeployment).toHaveBeenCalledTimes(2);
    expect(mocks.performHealthCheck).toHaveBeenCalledTimes(2);
    expect(releaseRequests()).toHaveLength(2);
    expect(finalizeRequests()).toHaveLength(2);
  });

  it('resumes only the final commit after a crash in releasing phase', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executeListrDeployment.mockResolvedValue({
      results: new Map([
        [HOST_A, { success: true, result: { success: true, deployed: true } }],
        [HOST_B, { success: true, result: { success: true, deployed: true } }],
      ]),
      aborted: false,
      skipped: 0,
      successful: 2,
      failed: 0,
      healthCheckFailed: 0,
      workerFailed: 0,
    });
    schedulerResumeFailuresRemaining = 1;

    await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );
    expect(releasePreparedHosts).toEqual(new Set([HOST_A, HOST_B]));
    expect(mocks.runMigrations).toHaveBeenCalledTimes(2);
    expect(mocks.executeListrDeployment).toHaveBeenCalledOnce();
    expect(mocks.readyServer).not.toHaveBeenCalled();
    expect(finalizeRequests()).toHaveLength(0);

    await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(mocks.runMigrations).toHaveBeenCalledTimes(2);
    expect(mocks.executeListrDeployment).toHaveBeenCalledOnce();
    expect(mocks.readyServer).toHaveBeenCalledTimes(2);
    expect(finalizeRequests()).toHaveLength(2);
    expect(releasePreparedHosts).toEqual(new Set());
  });

  it('converges after one host finalized and the other finalize timed out', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executeListrDeployment.mockResolvedValue({
      results: new Map([
        [HOST_A, { success: true, result: { success: true, deployed: true } }],
        [HOST_B, { success: true, result: { success: true, deployed: true } }],
      ]),
      aborted: false,
      skipped: 0,
      successful: 2,
      failed: 0,
      healthCheckFailed: 0,
      workerFailed: 0,
    });
    finalizeTimeoutHosts.add(HOST_B);

    const first = await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(first.output.error).toHaveBeenCalledWith(
      expect.stringContaining('FLEET_OUTAGE_FINALIZE_FAILED'),
    );
    expect(finalizeRequests()).toHaveLength(2);
    expect(outageOwners.has(HOST_A)).toBe(false);
    expect(outageOwners.has(HOST_B)).toBe(true);
    expect(releasePreparedHosts).toEqual(new Set([HOST_B]));
    expect(mocks.runMigrations).toHaveBeenCalledTimes(2);
    expect(mocks.executeListrDeployment).toHaveBeenCalledOnce();

    const second = await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(second.output.error).not.toHaveBeenCalled();
    expect(mocks.runMigrations).toHaveBeenCalledTimes(2);
    expect(mocks.executeListrDeployment).toHaveBeenCalledOnce();
    expect(finalizeRequests().filter(([url]) => requestHost(String(url)) === HOST_A))
      .toHaveLength(1);
    expect(finalizeRequests().filter(([url]) => requestHost(String(url)) === HOST_B))
      .toHaveLength(2);
    expect(releaseRequests().filter(([url]) => requestHost(String(url)) === HOST_A))
      .toHaveLength(1);
    expect(releaseRequests().filter(([url]) => requestHost(String(url)) === HOST_B))
      .toHaveLength(2);
    expect(outageOwners).toEqual(new Map());
    expect(releasePreparedHosts).toEqual(new Set());
    expect(mocks.completeFleetOutageJournal).toHaveBeenCalledOnce();
  });

  it('converges without another rollout after every host finalized before local journal cleanup', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();
    mocks.executeListrDeployment.mockResolvedValue({
      results: new Map([
        [HOST_A, { success: true, result: { success: true, deployed: true } }],
        [HOST_B, { success: true, result: { success: true, deployed: true } }],
      ]),
      aborted: false,
      skipped: 0,
      successful: 2,
      failed: 0,
      healthCheckFailed: 0,
      workerFailed: 0,
    });
    journalCompletionFailuresRemaining = 1;

    const first = await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(first.output.error).toHaveBeenCalledWith(
      expect.stringContaining('simulated crash before local journal completion'),
    );
    expect(outageOwners).toEqual(new Map());
    expect(outageJournals.size).toBe(1);
    expect(mocks.runMigrations).toHaveBeenCalledTimes(2);
    expect(mocks.executeListrDeployment).toHaveBeenCalledOnce();
    expect(stopRequests()).toHaveLength(2);
    expect(releaseRequests()).toHaveLength(2);
    expect(finalizeRequests()).toHaveLength(2);

    const second = await runDeploy(
      strictFlatConfig(),
      ['--require-fleet-stop-before-pre'],
      { skipDrain: false },
    );

    expect(second.output.error).not.toHaveBeenCalled();
    expect(mocks.runMigrations).toHaveBeenCalledTimes(2);
    expect(mocks.executeListrDeployment).toHaveBeenCalledOnce();
    expect(stopRequests()).toHaveLength(2);
    expect(releaseRequests()).toHaveLength(2);
    expect(finalizeRequests()).toHaveLength(2);
    expect(mocks.openFinalizedFleetOutageJournal).toHaveBeenCalled();
    expect(mocks.completeFleetOutageJournal).toHaveBeenCalledTimes(2);
    expect(outageJournals).toEqual(new Map());
  });

  it('preserves the historical migration-before-rollout path without the flag', async () => {
    await installSecondToken();
    stubSuccessfulTunnels();

    await runDeploy(strictFlatConfig(), [], { skipDrain: false });

    expect(mocks.drainServer).not.toHaveBeenCalled();
    expect(mocks.quiesceScheduler).not.toHaveBeenCalled();
    expect(mocks.agentPost).not.toHaveBeenCalled();
    expect(mocks.agentGet).not.toHaveBeenCalled();
    expect(mocks.readyServer).not.toHaveBeenCalled();
    expect(mocks.runMigrations).toHaveBeenCalled();
    expect(mocks.executeListrDeployment).toHaveBeenCalledOnce();
  });
});
