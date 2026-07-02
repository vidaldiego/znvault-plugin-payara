import { describe, it, expect, vi, beforeEach } from 'vitest';

const mcResult: any = { classes: [], abortedAt: undefined };
vi.mock('../src/cli/multi-class-deploy.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/multi-class-deploy.js')>('../src/cli/multi-class-deploy.js');
  return { ...actual, executeMultiClassDeployment: vi.fn(async () => mcResult), printMultiClassSummary: vi.fn(), printMultiClassDryRun: vi.fn() };
});
vi.mock('../src/run-migrations.js', async () => {
  const actual = await vi.importActual<typeof import('../src/run-migrations.js')>('../src/run-migrations.js');
  return { ...actual, runMigrations: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn().mockResolvedValue({
    configs: { stg: {
      name: 'stg',
      classes: [{ name: 'api', hosts: ['h1'] }, { name: 'worker', hosts: ['h2'] }],
      warPath: '/x.war',
      port: 9100,
      migration: { roleId: 'r', migrationsDir: 'db/pre' },
      postMigration: { roleId: 'r', migrationsDir: 'db/post' },
    } },
  }),
}));

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
  // @ts-expect-error stub
  process.exit = () => { throw new Error('__exit__'); };
  try { await program.parseAsync(['node', 'znvault', ...argv]); }
  catch (e) { if ((e as Error).message !== '__exit__') throw e; }
  finally { process.exit = real; }
}

// A "ran, clean" class outcome with full per-class coverage.
// coverageOk rides on the ClassOutcome (set by executeMultiClassDeployment from
// runClass's return value); the tail gate reads it from there, so the mock must
// supply it directly since executeMultiClassDeployment is stubbed here.
const cleanClass = (name: string, hosts: string[]) => ({
  name, blocking: name === 'api', ran: true, coverageOk: true,
  ctx: { failed: 0, aborted: false, healthCheckFailed: 0, workerFailed: 0, successful: hosts.length, skipped: 0, results: new Map() },
});

describe('multi-class post-deploy gate', () => {
  beforeEach(() => { mcResult.abortedAt = undefined; mcResult.classes = [cleanClass('api', ['h1']), cleanClass('worker', ['h2'])]; });

  it('post runs after a clean multi-class rollout', async () => {
    const { ctx, infos } = makeCtx();
    await runDeploy(ctx, ['payara', 'deploy', 'run', 'stg', '--yes', '--skip-drain']);
    expect(infos.some((m) => /Running post-deploy/i.test(m))).toBe(true);
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
      cleanClass('api', ['h1']),
      { name: 'worker', blocking: false, ran: true, coverageOk: false, ctx: { failed: 0, aborted: false, healthCheckFailed: 0, workerFailed: 0, successful: 1, skipped: 0, results: new Map() } },
    ];
    const { ctx, infos } = makeCtx();
    await runDeploy(ctx, ['payara', 'deploy', 'run', 'stg', '--yes', '--skip-drain']);
    expect(infos.some((m) => /Skipping post-deploy/i.test(m))).toBe(true);
    expect(infos.some((m) => /worker/i.test(m))).toBe(true);
    expect(infos.some((m) => /Running post-deploy/i.test(m))).toBe(false);
  });
});
