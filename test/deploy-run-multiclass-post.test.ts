import { describe, it, expect, vi, beforeEach } from 'vitest';

const mcResult: any = { classes: [], abortedAt: undefined };
vi.mock('@zincapp/znvault-deploy-core', async () => {
  const actual = await vi.importActual<typeof import('@zincapp/znvault-deploy-core')>('@zincapp/znvault-deploy-core');
  return { ...actual, executeMultiClassDeployment: vi.fn(async () => mcResult), printMultiClassSummary: vi.fn(), printMultiClassDryRun: vi.fn() };
});
vi.mock('@zincapp/znvault-migrate', async () => {
  const actual = await vi.importActual<typeof import('@zincapp/znvault-migrate')>('@zincapp/znvault-migrate');
  return { ...actual, runMigrations: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn().mockResolvedValue({
    configs: { stg: {
      name: 'stg',
      classes: [
        { name: 'api', hosts: ['h1', 'h2', 'h3'], strategy: 'sequential' },
        { name: 'worker', hosts: ['h4'] },
      ],
      warPath: '/x.war',
      port: 9100,
      tunnel: false,
      tls: { useVaultCA: false },
      migration: { roleId: 'r', migrationsDir: 'db/pre' },
      postMigration: { roleId: 'r', migrationsDir: 'db/post' },
    } },
  }),
}));
vi.mock('../src/cli/auth-token.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/auth-token.js')>(
    '../src/cli/auth-token.js'
  );
  return {
    ...actual,
    loadHostMutationAuthTokens: vi.fn((_config, hosts: string[]) =>
      new Map(hosts.map(host => [host, `test-control-token-${host}-0123456789`]))
    ),
  };
});
vi.mock('../src/cli/listr-preflight.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/listr-preflight.js')>(
    '../src/cli/listr-preflight.js'
  );
  return {
    ...actual,
    executePreflightChecks: vi.fn(async (options: { hosts: string[] }) => ({
      reachableHosts: [...options.hosts],
      analysisMap: new Map(options.hosts.map(host => [host, {
        success: true,
        filesChanged: 1,
        filesDeleted: 0,
        bytesToUpload: 1,
        isFullUpload: false,
      }])),
      updateTargets: [],
    })),
    printPreflightSummary: vi.fn(),
  };
});
vi.mock('../src/cli/progress.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/progress.js')>(
    '../src/cli/progress.js'
  );
  return {
    ...actual,
    getWarInfo: vi.fn(async () => ({
      path: '/x.war', name: 'x.war', size: 1, fileCount: 1,
      modifiedAt: new Date(0),
    })),
  };
});
vi.mock('../src/war-deployer.js', async () => {
  const actual = await vi.importActual<typeof import('../src/war-deployer.js')>(
    '../src/war-deployer.js'
  );
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

import { Command } from 'commander';
import { executeMultiClassDeployment } from '@zincapp/znvault-deploy-core';
import { runMigrations } from '@zincapp/znvault-migrate';
import { registerDeployRunCommand } from '../src/cli/commands/deploy-run.js';
import type { CLIPluginContext } from '../src/cli/types.js';

function makeCtx() {
  const infos: string[] = [];
  const ctx = { output: {
    info: (m: string) => infos.push(String(m)), warn: (m: string) => infos.push(String(m)),
    success: (m: string) => infos.push(String(m)), error: (m: string) => infos.push(String(m)),
    table: vi.fn(), keyValue: vi.fn(),
  }, client: { get: vi.fn(), post: vi.fn() }, getConfig: () => ({ url: 'x' }), isPlainMode: () => true } as unknown as CLIPluginContext;
  return { ctx, infos };
}
async function runDeploy(ctx: CLIPluginContext, argv: string[]) {
  const program = new Command(); program.exitOverride();
  registerDeployRunCommand(program.command('payara').command('deploy'), ctx);
  const real = process.exit;
  const exitCodes: number[] = [];
  // @ts-expect-error stub
  process.exit = (code?: number) => { exitCodes.push(code ?? 0); throw new Error('__exit__'); };
  try { await program.parseAsync(['node', 'znvault', ...argv]); }
  catch (e) { if ((e as Error).message !== '__exit__') throw e; }
  finally { process.exit = real; }
  return exitCodes;
}

// A "ran, clean" class outcome with full per-class coverage.
// coverageOk rides on the ClassOutcome (set by executeMultiClassDeployment from
// runClass's return value); the tail gate reads it from there, so the mock must
// supply it directly since executeMultiClassDeployment is stubbed here.
const cleanClass = (name: string, hosts: string[]) => ({
  name, blocking: name === 'api', ran: true, coverageOk: true,
  ctx: {
    failed: 0,
    aborted: false,
    healthCheckFailed: 0,
    workerFailed: 0,
    successful: hosts.length,
    skipped: 0,
    results: new Map(hosts.map(host => [host, {
      success: true,
      result: {
        success: true,
        filesChanged: 0,
        filesDeleted: 0,
        message: 'verified',
        deploymentTime: 1,
        appName: 'ZincAPI',
        deployed: true,
      },
    }])),
  },
});

describe('multi-class post-deploy gate', () => {
  beforeEach(() => {
    vi.mocked(executeMultiClassDeployment).mockClear();
    vi.mocked(runMigrations).mockClear();
    mcResult.abortedAt = undefined;
    mcResult.classes = [
      cleanClass('api', ['h1', 'h2', 'h3']),
      cleanClass('worker', ['h4']),
    ];
  });

  it('post runs after a clean multi-class rollout', async () => {
    const { ctx, infos } = makeCtx();
    const exitCodes = await runDeploy(ctx, ['payara', 'deploy', 'run', 'stg', '--yes', '--skip-drain']);
    expect(infos.some((m) => /Running post-deploy/i.test(m))).toBe(true);
    expect(exitCodes).toEqual([]);
  });

  it('post skipped when a class aborted', async () => {
    mcResult.abortedAt = 'api';
    mcResult.classes = [{ name: 'api', blocking: true, ran: true, coverageOk: false, ctx: { failed: 1, aborted: true, healthCheckFailed: 0, workerFailed: 0, successful: 0, skipped: 0, results: new Map() } }];
    const { ctx, infos } = makeCtx();
    await runDeploy(ctx, ['payara', 'deploy', 'run', 'stg', '--yes', '--skip-drain']);
    expect(infos.some((m) => /Skipping post-deploy/i.test(m))).toBe(true);
    expect(infos.some((m) => /Running post-deploy/i.test(m))).toBe(false);
  });

  it('post skipped on partial coverage (a class dropped a host, clean ctx otherwise)', async () => {
    // 'worker' ran with a clean ctx but coverageOk:false — a host was dropped
    // pre-rollout (still serving the old WAR). Destructive post migrations must skip.
    mcResult.abortedAt = undefined;
    mcResult.classes = [
      cleanClass('api', ['h1', 'h2', 'h3']),
      { name: 'worker', blocking: false, ran: true, coverageOk: false, ctx: { failed: 0, aborted: false, healthCheckFailed: 0, workerFailed: 0, successful: 0, skipped: 0, results: new Map() } },
    ];
    const { ctx, infos } = makeCtx();
    await runDeploy(ctx, ['payara', 'deploy', 'run', 'stg', '--yes', '--skip-drain']);
    expect(infos.some((m) => /Skipping post-deploy/i.test(m))).toBe(true);
    expect(infos.some((m) => /worker/i.test(m))).toBe(true);
    expect(infos.some((m) => /Running post-deploy/i.test(m))).toBe(false);
  });

  it('coverageOk cannot substitute for the missing receipt of one sequential host', async () => {
    const api = cleanClass('api', ['h1', 'h2', 'h3']);
    api.ctx.results.delete('h3');
    api.ctx.successful = 2;
    mcResult.classes = [api, cleanClass('worker', ['h4'])];
    const { ctx, infos } = makeCtx();

    const exitCodes = await runDeploy(ctx, ['payara', 'deploy', 'run', 'stg', '--yes', '--skip-drain']);

    expect(infos.some((m) => /Skipping post-deploy/i.test(m) && /api:h3/.test(m))).toBe(true);
    expect(infos.some((m) => /Running post-deploy/i.test(m))).toBe(false);
    expect(exitCodes).toContain(1);
  });

  it('an omitted selected class outcome blocks post and exits non-zero', async () => {
    mcResult.classes = [cleanClass('api', ['h1', 'h2', 'h3'])];
    const { ctx, infos } = makeCtx();

    const exitCodes = await runDeploy(ctx, [
      'payara', 'deploy', 'run', 'stg', '--yes', '--skip-drain',
    ]);

    expect(infos.some((message) => /Skipping post-deploy/i.test(message) && /worker:h4/.test(message))).toBe(true);
    expect(infos.some((message) => /Running post-deploy/i.test(message))).toBe(false);
    expect(exitCodes).toContain(1);
  });

  it('rejects duplicate --class before migrations or deployment', async () => {
    const { ctx, infos } = makeCtx();

    const exitCodes = await runDeploy(ctx, [
      'payara', 'deploy', 'run', 'stg', '--class', 'api', '--class', 'api',
      '--yes', '--skip-drain',
    ]);

    expect(infos.some((message) => /duplicate --class.*api/i.test(message))).toBe(true);
    expect(infos.some((message) => /Running post-deploy/i.test(message))).toBe(false);
    expect(runMigrations).not.toHaveBeenCalled();
    expect(executeMultiClassDeployment).not.toHaveBeenCalled();
    expect(exitCodes).toContain(1);
  });
});
