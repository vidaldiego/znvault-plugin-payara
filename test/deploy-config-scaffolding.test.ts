// Path: test/deploy-config-scaffolding.test.ts
// Tests for the `deploy config set-migration --scaffolding-file` CLI flag.
// Drives the real commander action, mocking config-store so no filesystem I/O
// occurs. Mirrors the seam pattern of
// test/deploy-config-set-migration-routines-flags.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import type { DeployConfigStore } from '../src/cli/types.js';

const mockStore: DeployConfigStore = { configs: {} };

vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn(async () => mockStore),
  saveDeployConfigs: vi.fn(async (store: DeployConfigStore) => {
    Object.assign(mockStore, store);
  }),
}));

const { registerConfigCommands } = await import('../src/cli/commands/deploy-config.js');

function makeCtx() {
  return {
    output: {
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      table: vi.fn(),
      keyValue: vi.fn(),
    },
    client: {} as unknown,
    getConfig: () => ({ url: 'https://vault.example.com' }),
    isPlainMode: () => false,
  } as any;
}

function makeProgram(ctx: ReturnType<typeof makeCtx>) {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on commander errors
  const payara = program.command('payara');
  const configCmd = payara.command('config');
  registerConfigCommands(configCmd, ctx);
  return program;
}

describe('deploy config set-migration --scaffolding-file', () => {
  beforeEach(() => {
    mockStore.configs = {
      staging: {
        name: 'staging',
        hosts: ['.55'],
        warPath: '/app.war',
        port: 9100,
      },
    };
    vi.clearAllMocks();
  });

  it('writes scaffoldingFile into the migration block', async () => {
    const ctx = makeCtx();
    const program = makeProgram(ctx);

    await program.parseAsync([
      'node', 'znvault',
      'payara', 'config', 'set-migration', 'staging',
      '--role', 'dbr_x',
      '--dir', '/repo/migs',
      '--scaffolding-file', 'migration_utils.sql',
    ]);

    expect(mockStore.configs.staging.migration).toEqual({
      roleId: 'dbr_x',
      migrationsDir: '/repo/migs',
      scaffoldingFile: 'migration_utils.sql',
    });
    expect(ctx.output.success).toHaveBeenCalledWith(expect.stringContaining('staging'));
  });

  it('omits scaffoldingFile when the flag is absent', async () => {
    const ctx = makeCtx();
    const program = makeProgram(ctx);

    await program.parseAsync([
      'node', 'znvault',
      'payara', 'config', 'set-migration', 'staging',
      '--role', 'dbr_x',
      '--dir', '/repo/migs',
    ]);

    expect(mockStore.configs.staging.migration).toEqual({
      roleId: 'dbr_x',
      migrationsDir: '/repo/migs',
    });
    expect(mockStore.configs.staging.migration?.scaffoldingFile).toBeUndefined();
  });
});
