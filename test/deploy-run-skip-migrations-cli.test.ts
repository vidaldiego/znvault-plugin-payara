// Path: test/deploy-run-skip-migrations-cli.test.ts
/**
 * CLI-wiring tests for the `--skip-migrations` flag on `znvault deploy run`.
 *
 * The skip BEHAVIOUR (runMigrationPhase short-circuits) is unit-tested in
 * deploy-run-migration-phase.test.ts. This file covers the parts that live in
 * the commander `.action()` closure and cannot be reached from runMigrationPhase:
 *
 *   1. The flag is registered on `deploy run` with the expected long name/description.
 *   2. The mutual-exclusion guard (`--migrations-only` + `--skip-migrations`) fires
 *      with exit 1 and the right message, BEFORE any host is touched.
 *   3. The guard fires only after config resolution — a missing config exits at the
 *      "config not found" check first (so the guard never masks that error).
 *
 * We drive the real `registerDeployRunCommand` through commander with a mocked
 * config store and a stubbed `process.exit`, so no network / filesystem I/O runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the config store so the action reaches the guard without touching
// ~/.znvault/deploy-configs.json. 'stg' has a migration block so the guard
// (which runs after config load) is reachable; the heavy rollout never runs
// because the guard/exit fires first.
vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: vi.fn().mockResolvedValue({
    configs: {
      stg: {
        name: 'stg',
        hosts: ['10.0.0.1'],
        warPath: '/nonexistent.war',
        migration: { roleId: 'zincdb-rw', migrationsDir: 'docs/migrations' },
      },
    },
  }),
}));

import { Command } from 'commander';
import { registerDeployRunCommand } from '../src/cli/commands/deploy-run.js';
import type { CLIPluginContext } from '../src/cli/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(): { ctx: CLIPluginContext; errors: string[] } {
  const errors: string[] = [];
  const ctx = {
    output: {
      info: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
      error: (m: string) => errors.push(String(m)),
      table: vi.fn(),
      keyValue: vi.fn(),
    },
    client: { get: vi.fn(), post: vi.fn() },
    getConfig: () => ({ url: 'https://localhost:8443' }),
    isPlainMode: () => true,
  } as unknown as CLIPluginContext;
  return { ctx, errors };
}

/** Build a program with the real command registered against the given ctx. */
function buildProgram(ctx: CLIPluginContext): Command {
  const program = new Command();
  program.exitOverride(); // don't kill the test process on commander parse errors
  const deploy = program.command('deploy');
  registerDeployRunCommand(deploy, ctx);
  return program;
}

/**
 * Parse argv with process.exit stubbed to throw a sentinel, so the first
 * process.exit(code) unwinds the action instead of killing the runner.
 * Returns the captured exit code (or null if the action never exited).
 */
async function parseCapturingExit(program: Command, argv: string[]): Promise<number | null> {
  let exitCode: number | null = null;
  const realExit = process.exit;
  // @ts-expect-error test stub — replaced in finally
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__exit__');
  };
  try {
    await program.parseAsync(['node', 'znvault', ...argv]);
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    process.exit = realExit;
  }
  return exitCode;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('deploy run --skip-migrations (CLI wiring)', () => {
  let realExit: typeof process.exit;
  beforeEach(() => {
    realExit = process.exit;
  });
  afterEach(() => {
    process.exit = realExit; // belt-and-suspenders in case a test path skipped the finally
  });

  it('registers --skip-migrations on `deploy run` with the expected description', () => {
    const { ctx } = makeCtx();
    const program = buildProgram(ctx);
    const run = program.commands
      .find((c) => c.name() === 'deploy')!
      .commands.find((c) => c.name() === 'run')!;

    const opt = run.options.find((o) => o.long === '--skip-migrations');
    expect(opt).toBeDefined();
    expect(opt!.description).toMatch(/without running any schema migrations/i);
  });

  it('rejects --migrations-only + --skip-migrations with exit 1 and a clear message', async () => {
    const { ctx, errors } = makeCtx();
    const program = buildProgram(ctx);

    const exitCode = await parseCapturingExit(program, [
      'deploy', 'run', 'stg', '--migrations-only', '--skip-migrations',
    ]);

    expect(exitCode).toBe(1);
    expect(errors.some((m) => /cannot be combined/i.test(m))).toBe(true);
  });

  it('the mutual-exclusion guard does not mask a missing-config error', async () => {
    // With an unknown config name, the action must exit at the "config not found"
    // check — NOT at the guard — so the operator gets the actionable error even
    // when they also passed the contradictory flag combo.
    const { ctx, errors } = makeCtx();
    const program = buildProgram(ctx);

    const exitCode = await parseCapturingExit(program, [
      'deploy', 'run', 'does-not-exist', '--migrations-only', '--skip-migrations',
    ]);

    expect(exitCode).toBe(1);
    expect(errors.some((m) => /not found/i.test(m))).toBe(true);
    expect(errors.some((m) => /cannot be combined/i.test(m))).toBe(false);
  });
});
