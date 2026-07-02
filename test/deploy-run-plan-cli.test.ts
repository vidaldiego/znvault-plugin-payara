import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn().mockResolvedValue({
    configs: {
      stg: {
        name: 'stg', hosts: ['10.0.0.1'], warPath: '/nonexistent.war',
        migration: { roleId: 'r', migrationsDir: 'db/pre' },
        postMigration: { roleId: 'r', migrationsDir: 'db/post' },
      },
    },
  }),
}));
// Stub the migration engine so --post-only/--pre-only don't hit a DB.
vi.mock('../src/run-migrations.js', async () => {
  const actual = await vi.importActual<typeof import('../src/run-migrations.js')>('../src/run-migrations.js');
  return { ...actual, runMigrations: vi.fn().mockResolvedValue(undefined) };
});

import { Command } from 'commander';
import { registerDeployRunCommand } from '../src/cli/commands/deploy-run.js';
import type { CLIPluginContext } from '../src/cli/types.js';

function makeCtx() {
  const infos: string[] = []; const errors: string[] = [];
  const ctx = {
    output: {
      info: (m: string) => infos.push(String(m)),
      warn: vi.fn(), success: vi.fn(), error: (m: string) => errors.push(String(m)),
      table: vi.fn(), keyValue: vi.fn(),
    },
    client: { get: vi.fn(), post: vi.fn() },
    getConfig: () => ({ url: 'https://localhost:8443' }),
    isPlainMode: () => true,
  } as unknown as CLIPluginContext;
  return { ctx, infos, errors };
}
function build(ctx: CLIPluginContext) {
  const program = new Command(); program.exitOverride();
  const deploy = program.command('deploy'); registerDeployRunCommand(deploy, ctx);
  return program;
}
async function parseExit(program: Command, argv: string[]): Promise<number | null> {
  let code: number | null = null; const real = process.exit;
  // @ts-expect-error test stub
  process.exit = (c?: number) => { code = c ?? 0; throw new Error('__exit__'); };
  try { await program.parseAsync(['node', 'znvault', ...argv]); }
  catch (e) { if ((e as Error).message !== '__exit__') throw e; }
  finally { process.exit = real; }
  return code;
}

describe('deploy run — six flags (CLI)', () => {
  let real: typeof process.exit;
  beforeEach(() => { real = process.exit; });
  afterEach(() => { process.exit = real; });

  it('registers all six flags on `deploy run`', () => {
    const { ctx } = makeCtx();
    const run = build(ctx).commands.find((c) => c.name() === 'deploy')!.commands.find((c) => c.name() === 'run')!;
    for (const long of ['--skip-migrations', '--skip-pre', '--skip-post', '--migrations-only', '--pre-only', '--post-only']) {
      expect(run.options.find((o) => o.long === long), long).toBeDefined();
    }
  });

  it('--pre-only + --post-only → exit 1 (mutually exclusive)', async () => {
    const { ctx, errors } = makeCtx();
    const code = await parseExit(build(ctx), ['deploy', 'run', 'stg', '--pre-only', '--post-only']);
    expect(code).toBe(1);
    expect(errors.some((m) => /mutually exclusive/i.test(m))).toBe(true);
  });

  it('--post-only runs post inline and does NOT require a WAR/preflight', async () => {
    const { ctx, infos } = makeCtx();
    // No exit expected on the happy path — the action returns after post.
    await build(ctx).parseAsync(['node', 'znvault', 'deploy', 'run', 'stg', '--post-only']);
    expect(infos.some((m) => /post-deploy/i.test(m) && /Running/i.test(m))).toBe(true);
    // Pre must NOT have run.
    expect(infos.some((m) => /pre-deploy/i.test(m) && /Running/i.test(m))).toBe(false);
  });
});
