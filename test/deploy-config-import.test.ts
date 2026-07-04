// Path: test/deploy-config-import.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const saveSpy = vi.fn();
vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn(async () => ({
    configs: { existing: { name: 'existing', warPath: '/a.war' } },
  })),
  saveDeployConfigs: (...a: unknown[]) => saveSpy(...a),
}));
// Force TTY off by default so tests are deterministic; individual tests can flip it.
vi.mock('../src/cli/commands/helpers.js', async (orig) => {
  const actual = await orig<typeof import('../src/cli/commands/helpers.js')>();
  return { ...actual, confirmPrompt: vi.fn(async () => true) };
});

import { Command } from 'commander';
import { registerConfigCommands } from '../src/cli/commands/index.js';
import type { CLIPluginContext } from '../src/cli/types.js';
import { confirmPrompt } from '../src/cli/commands/helpers.js';

function tmpCfg(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'import-'));
  const p = join(dir, 'tmpl.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function makeCtx(lines: string[]): CLIPluginContext {
  return { output: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push('WARN ' + m), success: (m: string) => lines.push(m), error: (m: string) => lines.push('ERR ' + m), table: vi.fn(), keyValue: vi.fn() },
    client: {}, getConfig: () => ({ url: 'x' }), isPlainMode: () => false } as unknown as CLIPluginContext;
}
async function runCmd(argv: string[], lines: string[]): Promise<void> {
  const program = new Command(); program.exitOverride();
  registerConfigCommands(program.command('payara').command('config'), makeCtx(lines));
  await program.parseAsync(['node', 'znvault', 'payara', 'config', ...argv]);
}

describe('config import', () => {
  beforeEach(() => { saveSpy.mockClear(); vi.mocked(confirmPrompt).mockClear(); Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true }); });

  it('imports a fresh config (creates it in the store)', async () => {
    const p = tmpCfg({ name: 'fresh', warPath: 'w.war', rootDir: '/r' });
    await runCmd(['import', p, '--with-root', '/root'], []);
    const saved = saveSpy.mock.calls[0]![0] as { configs: Record<string, { rootDir?: string; name: string }> };
    expect(saved.configs.fresh!.name).toBe('fresh');
    expect(saved.configs.fresh!.rootDir).toBe('/root'); // --with-root overrode file's /r
  });

  it('upgrades an existing config after TTY confirm', async () => {
    const p = tmpCfg({ name: 'existing', warPath: 'new.war', rootDir: '/x' });
    await runCmd(['import', p], []);
    expect(confirmPrompt).toHaveBeenCalled();
    const saved = saveSpy.mock.calls[0]![0] as { configs: Record<string, { warPath: string }> };
    expect(saved.configs.existing!.warPath).toBe('new.war');
  });

  it('--force skips the prompt on an existing config', async () => {
    const p = tmpCfg({ name: 'existing', warPath: 'forced.war', rootDir: '/x' });
    await runCmd(['import', p, '--force'], []);
    expect(confirmPrompt).not.toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalled();
  });

  it('non-TTY without --force on an existing name errors, does not save or hang', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const p = tmpCfg({ name: 'existing', warPath: 'x.war', rootDir: '/x' });
    const lines: string[] = [];
    await runCmd(['import', p], lines).catch(() => {});
    expect(lines.join('\n')).toMatch(/exists; pass --force/);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(confirmPrompt).not.toHaveBeenCalled();
  });

  it('--name overrides the stored name and store key', async () => {
    const p = tmpCfg({ name: 'fromfile', warPath: 'w.war', rootDir: '/r' });
    await runCmd(['import', p, '--name', 'renamed', '--force'], []);
    const saved = saveSpy.mock.calls[0]![0] as { configs: Record<string, { name: string }> };
    expect(saved.configs.renamed!.name).toBe('renamed');
    expect(saved.configs.fromfile).toBeUndefined();
  });

  it('errors when neither file name nor --name is present', async () => {
    const p = tmpCfg({ warPath: 'w.war', rootDir: '/r' }); // no name
    const lines: string[] = [];
    await runCmd(['import', p, '--force'], lines).catch(() => {});
    expect(lines.join('\n')).toMatch(/no "name"|pass --name/);
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
