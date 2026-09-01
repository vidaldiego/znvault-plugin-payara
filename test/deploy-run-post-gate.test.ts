import { describe, it, expect, vi, beforeEach } from 'vitest';

const CONFIGURED_HOSTS = ['h1', 'h2', 'h3'];
const verifiedReceipt = () => ({
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
});
const deployResult = { successful: 0, failed: 0, aborted: false, healthCheckFailed: 0, workerFailed: 0, skipped: 0, results: new Map() };
vi.mock('../src/cli/listr-deploy.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/listr-deploy.js')>('../src/cli/listr-deploy.js');
  return { ...actual, executeListrDeployment: vi.fn(async () => deployResult), printDeploymentSummary: vi.fn() };
});
vi.mock('@zincapp/znvault-migrate', async () => {
  const actual = await vi.importActual<typeof import('@zincapp/znvault-migrate')>('@zincapp/znvault-migrate');
  return { ...actual, runMigrations: vi.fn().mockResolvedValue(undefined) };
});
// Preflight must return all hosts reachable + analyzed with changes by
// default. `reachableOverride` lets an individual test narrow which of the
// requested hosts come back as reachable/analyzed (e.g. to simulate a
// dropped/unreachable host without touching the other tests).
let reachableOverride: string[] | undefined;
vi.mock('../src/cli/listr-preflight.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/listr-preflight.js')>('../src/cli/listr-preflight.js');
  return {
    ...actual,
    executePreflightChecks: vi.fn(async (o: any) => {
      const hosts = reachableOverride ?? o.hosts;
      return {
        reachableHosts: hosts,
        analysisMap: new Map(hosts.map((h: string) => [h, { success: true, filesChanged: 1, filesDeleted: 0, bytesToUpload: 10, isFullUpload: false }])),
        updateTargets: [],
      };
    }),
    printPreflightSummary: vi.fn(),
  };
});
vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn().mockResolvedValue({
    configs: { stg: {
      name: 'stg', hosts: ['h1', 'h2', 'h3'], warPath: '/x.war',
      tunnel: false, tls: { useVaultCA: false },
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

// getWarInfo + calculateWarHashes read a real file — stub them.
vi.mock('../src/cli/progress.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/progress.js')>('../src/cli/progress.js');
  return {
    ...actual,
    getWarInfo: vi.fn(async () => ({
      path: '/x.war', name: 'x.war', size: 1, fileCount: 1, modifiedAt: new Date(),
    })),
  };
});
vi.mock('../src/war-deployer.js', async () => {
  const actual = await vi.importActual<typeof import('../src/war-deployer.js')>('../src/war-deployer.js');
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

describe('flat post-deploy gate', () => {
  beforeEach(() => {
    Object.assign(deployResult, {
      successful: CONFIGURED_HOSTS.length,
      failed: 0,
      aborted: false,
      healthCheckFailed: 0,
      workerFailed: 0,
      skipped: 0,
      results: new Map(CONFIGURED_HOSTS.map(host => [host, verifiedReceipt()])),
    });
    reachableOverride = undefined;
  });

  it('post runs after a full clean rollout', async () => {
    const { ctx, infos } = makeCtx();
    const exitCodes = await runDeploy(ctx, ['payara', 'deploy', 'run', 'stg', '--yes', '--skip-drain']);
    expect(infos.some((m) => /Running post-deploy/i.test(m))).toBe(true);
    expect(exitCodes).toEqual([]);
  });

  it('worker failure → post skipped (rollout-failed)', async () => {
    deployResult.workerFailed = 1;
    const { ctx, infos } = makeCtx();
    await runDeploy(ctx, ['payara', 'deploy', 'run', 'stg', '--yes', '--skip-drain']);
    expect(infos.some((m) => /Skipping post-deploy/i.test(m) && /did not fully succeed/i.test(m))).toBe(true);
  });

  it('missing exact receipt blocks post and exits non-zero', async () => {
    deployResult.results.delete('h3');
    deployResult.successful = 2;
    const { ctx, infos } = makeCtx();

    const exitCodes = await runDeploy(ctx, ['payara', 'deploy', 'run', 'stg', '--yes', '--skip-drain']);

    expect(infos.some((m) => /Skipping post-deploy/i.test(m) && /h3/.test(m))).toBe(true);
    expect(infos.some((m) => /Running post-deploy/i.test(m))).toBe(false);
    expect(exitCodes).toContain(1);
  });

  it('--host subset → post skipped (scoped-subset)', async () => {
    const { ctx, infos } = makeCtx();
    await runDeploy(ctx, ['payara', 'deploy', 'run', 'stg', '--host', 'h1', '--yes', '--skip-drain']);
    expect(infos.some((m) => /Skipping post-deploy/i.test(m) && /scoped to a subset/i.test(m))).toBe(true);
  });

  it('unverified host aborts before migration/deployment instead of partial coverage', async () => {
    // Config has 3 hosts, but only h1 comes back reachable/analyzed
    // from preflight — simulating a host that was dropped/unreachable
    // pre-rollout. No --host flag is passed, so flatIsScoped is false: this
    // must be caught by the fleet-wide preflight completeness gate, not the
    // scope check or the later post-deploy coverage gate.
    reachableOverride = ['h1'];
    const { ctx, infos } = makeCtx();
    await runDeploy(ctx, ['payara', 'deploy', 'run', 'stg', '--yes', '--skip-drain']);
    expect(infos.some((m) =>
      /CONTROL_PLANE_PREFLIGHT_INCOMPLETE/i.test(m)
      && /unverified: h2, h3/i.test(m)
      && /analysis failed: h2, h3/i.test(m)
    )).toBe(true);
    expect(infos.some((m) => /Running post-deploy/i.test(m))).toBe(false);
  });
});
