// Path: test/deploy-config-show-phases.test.ts
// Tests for `deploy config show` rendering BOTH migration phases (pre-deploy
// and post-deploy) and including the post-deploy step in the execution plan
// (Task 10). Mocks config-store so no filesystem I/O occurs; captures
// console.log since `show` prints via console.log, not ctx.output.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn(async () => ({
    configs: { stg: {
      name: 'stg', hosts: ['h1'], warPath: '/x.war', strategy: 'sequential',
      migration: { roleId: 'rp', migrationsDir: 'db/pre' },
      postMigration: { roleId: 'rq', migrationsDir: 'db/post' },
    } },
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

  it('renders both phases and a post execution-plan step', async () => {
    const ctx = { output: { info: (m: string) => lines.push(m), warn: vi.fn(), success: vi.fn(), error: vi.fn(), table: vi.fn(), keyValue: vi.fn() }, client: {}, getConfig: () => ({ url: 'x' }), isPlainMode: () => false } as unknown as CLIPluginContext;
    const program = new Command(); program.exitOverride();
    registerConfigCommands(program.command('config'), ctx);
    await program.parseAsync(['node', 'znvault', 'config', 'show', 'stg']);
    const all = lines.join('\n');
    expect(all).toMatch(/Migration \(pre-deploy\)/);
    expect(all).toMatch(/Migration \(post-deploy\)/);
    expect(all).toMatch(/Run post-deploy schema migrations/);
    expect(all).toMatch(/only if the rollout succeeded/);
  });
});
