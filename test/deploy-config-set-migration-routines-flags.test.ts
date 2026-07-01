// Path: test/deploy-config-set-migration-routines-flags.test.ts
// Tests for the `deploy config set-migration --routines-bundle/--routines-version`
// CLI flags (C3). Drives the real commander action (mirrors test/cli.test.ts's
// pattern of registering commands on a real Command and invoking parseAsync),
// mocking config-store so no filesystem I/O occurs.

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

describe('deploy config set-migration --routines-bundle / --routines-version', () => {
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

  it('sets migration.routines when both flags are provided', async () => {
    const ctx = makeCtx();
    const program = makeProgram(ctx);

    await program.parseAsync([
      'node', 'znvault',
      'deploy', 'config', 'set-migration', 'staging',
      '--role', 'zincdb-rw',
      '--dir', 'docs/migrations',
      '--routines-bundle', 'zn_helpers',
      '--routines-version', '2',
    ]);

    expect(mockStore.configs.staging.migration).toEqual({
      roleId: 'zincdb-rw',
      migrationsDir: 'docs/migrations',
      routines: { bundle: 'zn_helpers', version: 2 },
    });
    expect(ctx.output.success).toHaveBeenCalledWith(expect.stringContaining('staging'));
  });

  it('does not set routines when neither flag is provided', async () => {
    const ctx = makeCtx();
    const program = makeProgram(ctx);

    await program.parseAsync([
      'node', 'znvault',
      'deploy', 'config', 'set-migration', 'staging',
      '--role', 'zincdb-rw',
      '--dir', 'docs/migrations',
    ]);

    expect(mockStore.configs.staging.migration).toEqual({
      roleId: 'zincdb-rw',
      migrationsDir: 'docs/migrations',
    });
  });

  it('errors when only --routines-bundle is provided', async () => {
    const ctx = makeCtx();
    const program = makeProgram(ctx);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(program.parseAsync([
      'node', 'znvault',
      'deploy', 'config', 'set-migration', 'staging',
      '--role', 'zincdb-rw',
      '--dir', 'docs/migrations',
      '--routines-bundle', 'zn_helpers',
    ])).rejects.toThrow('process.exit(1)');

    expect(ctx.output.error).toHaveBeenCalledWith(expect.stringMatching(/--routines-bundle.*--routines-version|both.*required/i));
    exitSpy.mockRestore();
  });

  it('errors when only --routines-version is provided', async () => {
    const ctx = makeCtx();
    const program = makeProgram(ctx);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(program.parseAsync([
      'node', 'znvault',
      'deploy', 'config', 'set-migration', 'staging',
      '--role', 'zincdb-rw',
      '--dir', 'docs/migrations',
      '--routines-version', '2',
    ])).rejects.toThrow('process.exit(1)');

    expect(ctx.output.error).toHaveBeenCalledWith(expect.stringMatching(/--routines-bundle.*--routines-version|both.*required/i));
    exitSpy.mockRestore();
  });
});
