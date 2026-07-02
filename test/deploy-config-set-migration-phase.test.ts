// Path: test/deploy-config-set-migration-phase.test.ts
// Tests for `deploy config set-migration --phase pre|post` (Task 9). Drives the
// real commander action, mocking config-store so no filesystem I/O occurs.
// Mirrors the seam pattern of test/deploy-config-set-migration-routines-flags.test.ts.

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
  const deploy = program.command('deploy');
  const configCmd = deploy.command('config');
  registerConfigCommands(configCmd, ctx);
  return program;
}

describe('deploy config set-migration --phase', () => {
  beforeEach(() => {
    mockStore.configs = {
      stg: {
        name: 'stg',
        hosts: ['h1'],
        warPath: '/x.war',
      },
    };
    vi.clearAllMocks();
  });

  it('--phase post writes postMigration', async () => {
    const ctx = makeCtx();
    const program = makeProgram(ctx);

    await program.parseAsync([
      'node', 'znvault',
      'deploy', 'config', 'set-migration', 'stg',
      '--phase', 'post',
      '--role', 'r',
      '--dir', 'db/post',
    ]);

    expect(mockStore.configs.stg.postMigration).toEqual({ roleId: 'r', migrationsDir: 'db/post' });
    expect(mockStore.configs.stg.migration).toBeUndefined();
    expect(ctx.output.success).toHaveBeenCalledWith(expect.stringContaining('post-deploy'));
  });

  it('default (no --phase) writes migration', async () => {
    const ctx = makeCtx();
    const program = makeProgram(ctx);

    await program.parseAsync([
      'node', 'znvault',
      'deploy', 'config', 'set-migration', 'stg',
      '--role', 'r',
      '--dir', 'db/pre',
    ]);

    expect(mockStore.configs.stg.migration).toEqual({ roleId: 'r', migrationsDir: 'db/pre' });
    expect(mockStore.configs.stg.postMigration).toBeUndefined();
    expect(ctx.output.success).toHaveBeenCalledWith(expect.stringContaining('pre-deploy'));
  });

  it('--phase pre is equivalent to default', async () => {
    const ctx = makeCtx();
    const program = makeProgram(ctx);

    await program.parseAsync([
      'node', 'znvault',
      'deploy', 'config', 'set-migration', 'stg',
      '--phase', 'pre',
      '--role', 'r',
      '--dir', 'db/pre',
    ]);

    expect(mockStore.configs.stg.migration).toEqual({ roleId: 'r', migrationsDir: 'db/pre' });
    expect(mockStore.configs.stg.postMigration).toBeUndefined();
  });

  it('--clear --phase post clears only postMigration', async () => {
    mockStore.configs.stg.migration = { roleId: 'r', migrationsDir: 'db/pre' };
    mockStore.configs.stg.postMigration = { roleId: 'r', migrationsDir: 'db/post' };

    const ctx = makeCtx();
    const program = makeProgram(ctx);

    await program.parseAsync([
      'node', 'znvault',
      'deploy', 'config', 'set-migration', 'stg',
      '--phase', 'post',
      '--clear',
    ]);

    expect(mockStore.configs.stg.postMigration).toBeUndefined();
    expect(mockStore.configs.stg.migration).toEqual({ roleId: 'r', migrationsDir: 'db/pre' });
    expect(ctx.output.success).toHaveBeenCalledWith(expect.stringContaining('post-deploy'));
  });

  it('--clear (default pre) notes a surviving post-deploy block', async () => {
    mockStore.configs.stg.migration = { roleId: 'r', migrationsDir: 'db/pre' };
    mockStore.configs.stg.postMigration = { roleId: 'r', migrationsDir: 'db/post' };

    const ctx = makeCtx();
    const program = makeProgram(ctx);

    await program.parseAsync([
      'node', 'znvault',
      'deploy', 'config', 'set-migration', 'stg',
      '--clear',
    ]);

    expect(mockStore.configs.stg.migration).toBeUndefined();
    expect(mockStore.configs.stg.postMigration).toEqual({ roleId: 'r', migrationsDir: 'db/post' });
    expect(ctx.output.info).toHaveBeenCalledWith(expect.stringMatching(/post-deploy migration.*still set/i));
  });

  it('errors when --phase is invalid', async () => {
    const ctx = makeCtx();
    const program = makeProgram(ctx);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(program.parseAsync([
      'node', 'znvault',
      'deploy', 'config', 'set-migration', 'stg',
      '--phase', 'bogus',
      '--role', 'r',
      '--dir', 'db/pre',
    ])).rejects.toThrow('process.exit(1)');

    expect(ctx.output.error).toHaveBeenCalledWith(expect.stringMatching(/--phase must be 'pre' or 'post'/));
    exitSpy.mockRestore();
  });
});
