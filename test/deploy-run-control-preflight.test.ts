import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

let tempDirectory: string;
let tokenAPath: string;
let tokenBPath: string;

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
  tempDirectory = await mkdtemp(join(tmpdir(), 'payara-control-preflight-'));
  tokenAPath = join(tempDirectory, 'host-a-token');
  tokenBPath = join(tempDirectory, 'host-b-token');
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
  mocks.openTunnel.mockImplementation(async () => ({
    localPort: ++nextPort,
    pid: 12000 + nextPort,
    close: vi.fn().mockResolvedValue(undefined),
  }));
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
