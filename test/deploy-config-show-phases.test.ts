// Path: test/deploy-config-show-phases.test.ts
// Tests for `deploy config show` rendering BOTH migration phases (pre-deploy
// and post-deploy) and including the post-deploy step in the execution plan
// (Task 10). Mocks config-store so no filesystem I/O occurs; captures
// console.log since `show` prints via console.log, not ctx.output.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn(async () => ({
    configs: {
      stg: {
        name: 'stg', hosts: ['h1'], warPath: '/x.war', strategy: 'sequential',
        migration: { roleId: 'rp', migrationsDir: 'db/pre', routines: { bundle: 'znapi-helpers', version: 1 } },
        postMigration: { roleId: 'rq', migrationsDir: 'db/post', routines: { bundle: 'znapi-helpers', version: 1 } },
      },
      'pre-only': {
        name: 'pre-only', hosts: ['h1'], warPath: '/x.war', strategy: 'sequential',
        migration: { roleId: 'rp', migrationsDir: 'db/pre' },
      },
      'post-only': {
        name: 'post-only', warPath: '/x.war',
        postMigration: { roleId: 'rq', migrationsDir: 'db/post' },
      },
    },
  })),
  saveDeployConfigs: vi.fn(),
}));

import { Command } from 'commander';
import { registerConfigCommands } from '../src/cli/commands/index.js';
import type { CLIPluginContext } from '../src/cli/types.js';

describe('config show — two phases', () => {
  let lines: string[]; let spy: any;
  beforeEach(() => { lines = []; spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')); }); });
  afterEach(() => { spy.mockRestore(); });

  const runShow = async (name: string): Promise<string> => {
    const ctx = { output: { info: (m: string) => lines.push(m), warn: vi.fn(), success: vi.fn(), error: vi.fn(), table: vi.fn(), keyValue: vi.fn() }, client: {}, getConfig: () => ({ url: 'x' }), isPlainMode: () => false } as unknown as CLIPluginContext;
    const program = new Command(); program.exitOverride();
    registerConfigCommands(program.command('config'), ctx);
    await program.parseAsync(['node', 'znvault', 'config', 'show', name]);
    return lines.join('\n');
  };

  it('renders both phases and a post execution-plan step', async () => {
    const all = await runShow('stg');
    expect(all).toMatch(/Migration \(pre-deploy\)/);
    expect(all).toMatch(/Migration \(post-deploy\)/);
    // Execution-plan terminology is explicitly pre-/post-deploy throughout (not a
    // bare "Run schema migrations"), and the post routine step is unambiguous about
    // being a re-apply, not a second execution of the pre bundle.
    expect(all).toMatch(/Run pre-deploy schema migrations/);
    expect(all).not.toMatch(/Run schema migrations \(/); // no bare "Run schema migrations"
    expect(all).toMatch(/Run post-deploy schema migrations/);
    expect(all).toMatch(/only if the rollout succeeded/);
  });

  it('labels the post-deploy routine step as a re-apply (not a second execution)', async () => {
    // 'stg' fixture carries routines on both phases; the post routine line must say
    // "re-applied post-deploy" so it never reads as running the bundle twice.
    const all = await runShow('stg');
    expect(all).toMatch(/re-applied post-deploy before post-deploy migrations/);
  });

  it('renders pre-only config with an absent post-deploy note and no post plan step', async () => {
    const all = await runShow('pre-only');
    expect(all).toMatch(/Migration \(post-deploy\):/);
    expect(all).toMatch(/not configured — no post-deploy migrations/i);
    expect(all).not.toMatch(/Run post-deploy schema migrations/);
  });

  it('renders post-only, hosts-less config with the no-rollout annotation', async () => {
    const all = await runShow('post-only');
    expect(all).toMatch(/Run post-deploy schema migrations/);
    expect(all).toMatch(/no rollout in this config/i);
  });
});
