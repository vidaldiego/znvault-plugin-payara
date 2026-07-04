// Path: test/deploy-config-set-rootdir.test.ts
// Tests for `config set <name> rootdir <value>` and the `config show` Root line.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const saveSpy = vi.fn();
vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn(async () => ({
    configs: {
      stg: { name: 'stg', hosts: ['h1'], warPath: '/x.war', strategy: 'sequential' },
      withroot: { name: 'withroot', hosts: ['h1'], warPath: 'x.war', rootDir: '/base' },
    },
  })),
  saveDeployConfigs: (...args: unknown[]) => saveSpy(...args),
}));

import { Command } from 'commander';
import { registerConfigCommands } from '../src/cli/commands/index.js';
import type { CLIPluginContext } from '../src/cli/types.js';

function makeCtx(lines: string[]): CLIPluginContext {
  return {
    output: { info: (m: string) => lines.push(m), warn: vi.fn(), success: vi.fn(), error: (m: string) => lines.push('ERR ' + m), table: vi.fn(), keyValue: vi.fn() },
    client: {}, getConfig: () => ({ url: 'x' }), isPlainMode: () => false,
  } as unknown as CLIPluginContext;
}

async function runCmd(argv: string[], lines: string[]): Promise<void> {
  const ctx = makeCtx(lines);
  const program = new Command(); program.exitOverride();
  registerConfigCommands(program.command('payara').command('config'), ctx);
  await program.parseAsync(['node', 'znvault', 'payara', 'config', ...argv]);
}

describe('config set rootdir', () => {
  beforeEach(() => { saveSpy.mockClear(); });

  it('sets rootDir to an absolute path (persisted raw)', async () => {
    await runCmd(['set', 'stg', 'rootdir', '/root/x'], []);
    const saved = saveSpy.mock.calls[0]![0] as { configs: Record<string, { rootDir?: string }> };
    expect(saved.configs.stg!.rootDir).toBe('/root/x');
  });

  it('stores a leading-~ value RAW (not expanded on store)', async () => {
    await runCmd(['set', 'stg', 'rootdir', '~/Drive/y'], []);
    const saved = saveSpy.mock.calls[0]![0] as { configs: Record<string, { rootDir?: string }> };
    expect(saved.configs.stg!.rootDir).toBe('~/Drive/y');
  });

  it('empty value clears rootDir', async () => {
    await runCmd(['set', 'withroot', 'rootdir', ''], []);
    const saved = saveSpy.mock.calls[0]![0] as { configs: Record<string, { rootDir?: string }> };
    expect(saved.configs.withroot!.rootDir).toBeUndefined();
  });

  it('key is case-insensitive (rootDir works too)', async () => {
    await runCmd(['set', 'stg', 'rootDir', '/root/z'], []);
    const saved = saveSpy.mock.calls[0]![0] as { configs: Record<string, { rootDir?: string }> };
    expect(saved.configs.stg!.rootDir).toBe('/root/z');
  });
});

describe('config show — Root line', () => {
  let lines: string[]; let logSpy: any;
  beforeEach(() => { lines = []; logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')); }); });
  afterEach(() => { logSpy.mockRestore(); });

  it('renders Root: when rootDir is set', async () => {
    await runCmd(['show', 'withroot'], lines);
    expect(lines.join('\n')).toMatch(/Root:\s+\/base/);
  });

  it('omits Root: when rootDir is not set', async () => {
    await runCmd(['show', 'stg'], lines);
    expect(lines.join('\n')).not.toMatch(/Root:/);
  });
});
