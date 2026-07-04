// Path: test/deploy-run-from-file.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const saveSpy = vi.fn();
vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn().mockResolvedValue({
    configs: {
      // A saved config using a RELATIVE migrationsDir + rootDir (v2.5.0 style).
      staging: {
        name: 'staging', hosts: ['10.0.0.1'], warPath: 'app.war', rootDir: '/saved/root',
        migration: { roleId: 'r', migrationsDir: 'db/pre' },
        postMigration: { roleId: 'r', migrationsDir: 'db/post' },
      },
    },
  }),
  saveDeployConfigs: (...a: unknown[]) => saveSpy(...a),
}));
vi.mock('@zincapp/znvault-migrate', async () => {
  const actual = await vi.importActual<typeof import('@zincapp/znvault-migrate')>('@zincapp/znvault-migrate');
  return { ...actual, runMigrations: vi.fn().mockResolvedValue(undefined) };
});

import { Command } from 'commander';
import { registerDeployRunCommand } from '../src/cli/commands/deploy-run.js';
import type { CLIPluginContext } from '../src/cli/types.js';

function makeCtx() {
  const infos: string[] = []; const errors: string[] = [];
  const ctx = { output: { info: (m: string) => infos.push(String(m)), warn: vi.fn(), success: vi.fn(), error: (m: string) => errors.push(String(m)), table: vi.fn(), keyValue: vi.fn() },
    client: { get: vi.fn(), post: vi.fn() }, getConfig: () => ({ url: 'https://localhost:8443' }), isPlainMode: () => true } as unknown as CLIPluginContext;
  return { ctx, infos, errors };
}
function build(ctx: CLIPluginContext): Command {
  const program = new Command(); program.exitOverride();
  const deploy = program.command('payara').command('deploy'); registerDeployRunCommand(deploy, ctx);
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
function tmpConfigFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fromfile-'));
  const p = join(dir, 'tmpl.json');
  writeFileSync(p, JSON.stringify({
    name: 'filecfg', hosts: ['10.0.0.1'], warPath: 'app.war',
    migration: { roleId: 'r', migrationsDir: 'docs/migrations/pre' },
    postMigration: { roleId: 'r', migrationsDir: 'docs/migrations/post' },
  }));
  return p;
}

describe('deploy run — from file + --with-root', () => {
  let real: typeof process.exit;
  beforeEach(() => { real = process.exit; saveSpy.mockClear(); });
  afterEach(() => { process.exit = real; });

  it('deploy run <file> --with-root <dir> resolves migration dirs against <dir> (file config, dry-run)', async () => {
    const { ctx, infos } = makeCtx();
    const file = tmpConfigFile();
    await parseExit(build(ctx), ['payara', 'deploy', 'run', file, '--with-root', '/base', '--pre-only', '-y', '--dry-run']);
    const out = infos.join('\n');
    expect(out).toContain(`dir '/base/docs/migrations/pre'`); // resolved via resolveConfigPaths
  });

  it('deploy run <savedName> --with-root <dir> overrides the saved rootDir for the run (not persisted)', async () => {
    const { ctx, infos } = makeCtx();
    await parseExit(build(ctx), ['payara', 'deploy', 'run', 'staging', '--with-root', '/override', '--pre-only', '-y', '--dry-run']);
    const out = infos.join('\n');
    expect(out).toContain(`dir '/override/db/pre'`); // overridden root, not /saved/root
    expect(saveSpy).not.toHaveBeenCalled();          // never persisted
  });

  it('deploy run <savedName> (bare name, no path chars) still loads the SAVED config (regression)', async () => {
    const { ctx, infos } = makeCtx();
    await parseExit(build(ctx), ['payara', 'deploy', 'run', 'staging', '--pre-only', '-y', '--dry-run']);
    const out = infos.join('\n');
    expect(out).toContain(`dir '/saved/root/db/pre'`); // resolved against the SAVED rootDir
  });

  it('deploy run <missing-file>.json errors cleanly (file mode, not "config not found")', async () => {
    const { ctx, errors } = makeCtx();
    await parseExit(build(ctx), ['payara', 'deploy', 'run', '/no/such/config.json', '--dry-run']);
    expect(errors.join('\n')).toMatch(/config file not found/);
  });
});
