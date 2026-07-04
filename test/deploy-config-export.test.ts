// Path: test/deploy-config-export.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const writeSpy = vi.fn();
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, writeFileSync: (...a: unknown[]) => writeSpy(...a) };
});
vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn(async () => ({
    configs: {
      stg: { name: 'stg', warPath: 'znapi/app.war', rootDir: '/Users/x/zincapi',
             migration: { roleId: 'r', migrationsDir: 'docs/pre' } },
    },
  })),
  saveDeployConfigs: vi.fn(),
}));

import { Command } from 'commander';
import { registerConfigCommands } from '../src/cli/commands/index.js';
import type { CLIPluginContext } from '../src/cli/types.js';

function makeCtx(lines: string[]): CLIPluginContext {
  return { output: { info: (m: string) => lines.push(m), warn: vi.fn(), success: (m: string) => lines.push(m), error: (m: string) => lines.push('ERR ' + m), table: vi.fn(), keyValue: vi.fn() },
    client: {}, getConfig: () => ({ url: 'x' }), isPlainMode: () => false } as unknown as CLIPluginContext;
}
async function runCmd(argv: string[], lines: string[]): Promise<void> {
  const program = new Command(); program.exitOverride();
  registerConfigCommands(program.command('payara').command('config'), makeCtx(lines));
  await program.parseAsync(['node', 'znvault', 'payara', 'config', ...argv]);
}

describe('config export', () => {
  beforeEach(() => { writeSpy.mockClear(); });

  it('writes the config with rootDir STRIPPED and other fields intact', async () => {
    await runCmd(['export', 'stg', 'out.json'], []);
    const [path, contents] = writeSpy.mock.calls[0]!;
    expect(path).toBe('out.json');
    const written = JSON.parse(contents as string);
    expect(written.rootDir).toBeUndefined();       // stripped
    expect(written.name).toBe('stg');
    expect(written.warPath).toBe('znapi/app.war'); // kept as-is
    expect(written.migration.migrationsDir).toBe('docs/pre');
  });

  it('defaults the filename to <name>.payara.json when omitted', async () => {
    await runCmd(['export', 'stg'], []);
    expect(writeSpy.mock.calls[0]![0]).toBe('stg.payara.json');
  });

  it('errors cleanly for a missing config', async () => {
    const lines: string[] = [];
    await runCmd(['export', 'nope', 'o.json'], lines).catch(() => {});
    expect(lines.join('\n')).toMatch(/not found/i);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
