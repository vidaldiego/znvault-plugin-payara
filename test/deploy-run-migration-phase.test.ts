// Path: test/deploy-run-migration-phase.test.ts
/**
 * Tests for the deploy-run migration-phase wiring hook.
 *
 * The `runMigrationPhase` function was extracted from the `.action()` closure
 * in `registerDeployRunCommand` so this conditional branch can be tested in
 * isolation without invoking the full heavy action (config load, TLS, listr).
 *
 * Verifies:
 *  - Skips runMigrations when config.migration is absent (no-op).
 *  - Calls runMigrations with the correct args when config.migration is present.
 *  - Propagates runMigrations failures (migration failure aborts the deploy before rollout).
 *
 * Also covers the --migrations-only behaviour: since the early-return that skips the
 * rollout lives in the `.action()` closure (not in runMigrationPhase itself), the unit
 * tests below verify the runMigrationPhase contract that --migrations-only relies on:
 *  - Runs successfully when config.migration is present (so the caller can early-return).
 *  - Does NOT run when config.migration is absent (guard in the action catches this first,
 *    but runMigrationPhase is a safe no-op regardless).
 * The action-level guard (`--migrations-only requires a migration config`) and the
 * early-return calls to ctx.output.success are in the `.action()` closure and are
 * verified by the integration / cli.test.ts if needed; they're not cheaply testable
 * without spawning a full commander parse.
 *
 * `runMigrationPhase` was generalized (Task 5) to run either the pre-deploy OR
 * post-deploy migration phase, driven by an explicit `phase` argument and a
 * `run` boolean (replacing the old `skipMigrations` boolean) plus an optional
 * reason-tagged `skipReason` for accurate incident-log skip lines.
 */
import { describe, it, expect, vi } from 'vitest';
import { runMigrationPhase } from '../src/cli/commands/deploy-run.js';
import type { RunMigrationsDeps } from '../src/run-migrations.js';
import type { DeployConfig, CLIPluginContext } from '../src/cli/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockDeps(overrides: {
  run?: ReturnType<typeof vi.fn>;
  revoke?: ReturnType<typeof vi.fn>;
} = {}): RunMigrationsDeps {
  const issue = vi.fn().mockResolvedValue({
    leaseId: 'L1',
    username: 'mig_user',
    password: 'mig_pass',
    host: '172.16.220.40',
    port: 6446,
    database: 'zincdb',
  });
  const revoke = overrides.revoke ?? vi.fn().mockResolvedValue(undefined);
  const run = overrides.run ?? vi.fn().mockResolvedValue({
    seeded: 0, reconciled: 0, applied: 1, pendingRemaining: 0,
  });
  const mockDbHandle = { end: vi.fn().mockResolvedValue(undefined) };
  return {
    client: { issueCredential: issue, revokeCredential: revoke },
    openDb: vi.fn().mockResolvedValue(mockDbHandle) as RunMigrationsDeps['openDb'],
    makeRunner: () => ({ run }),
  };
}

type MockCtx = CLIPluginContext & {
  output: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
};

function makeMockCtx(): MockCtx {
  return {
    output: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    client: {} as CLIPluginContext['client'],
  } as unknown as MockCtx;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('runMigrationPhase', () => {
  it('is a no-op when config.migration is absent', async () => {
    const config: DeployConfig = {
      name: 'test-config',
      hosts: ['10.0.0.1'],
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps();

    await runMigrationPhase(config.migration, 'pre-deploy', 'test-config', ctx, deps, { run: true });

    // runMigrations should NOT have been called (deps.client.issueCredential is the
    // first thing runMigrations calls — if it wasn't called, runMigrations was skipped)
    expect(deps.client.issueCredential).not.toHaveBeenCalled();
    expect(ctx.output.info).not.toHaveBeenCalled();
  });

  it('does NOT run migrations under dryRun — prints the plan and skips execution', async () => {
    // Regression: --dry-run must not actually mint a lease / apply the bundle / run
    // migrations. Previously runMigrationPhase ignored dryRun and executed the full
    // migration phase against the real DB even for a dry run.
    const config: DeployConfig = {
      name: 'staging',
      hosts: ['10.0.0.1'],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
        routines: { bundle: 'znapi-helpers', version: 1 },
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps();

    await runMigrationPhase(config.migration, 'pre-deploy', 'staging', ctx, deps, { dryRun: true, run: true });

    // Nothing executed: no lease minted, no runner invoked.
    expect(deps.client.issueCredential).not.toHaveBeenCalled();
    // A dry-run plan line was printed (mentions the routines bundle + that it's a dry run).
    const infoCalls = ctx.output.info.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((m) => /dry.?run/i.test(m))).toBe(true);
    expect(infoCalls.some((m) => m.includes('znapi-helpers') && m.includes('1'))).toBe(true);
    // The "Migrations complete" line (which only fires after a real run) must NOT appear.
    expect(ctx.output.info).not.toHaveBeenCalledWith('[deploy] pre-deploy migrations complete.');
  });

  it('calls runMigrations with the correct roleId and migrationsDir when config.migration is present', async () => {
    const config: DeployConfig = {
      name: 'production',
      hosts: ['10.0.0.1'],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps();

    await runMigrationPhase(config.migration, 'pre-deploy', 'production', ctx, deps, { run: true });

    // The lease must have been minted — runMigrations ran
    expect(deps.client.issueCredential).toHaveBeenCalledWith('zincdb-rw', { ttlSeconds: 14400 });
    expect(deps.client.issueCredential).toHaveBeenCalledTimes(1);

    // Verify via output messages — both info lines must have fired (before + after),
    // which proves the full runMigrations call completed successfully.
    expect(ctx.output.info).toHaveBeenCalledWith('[deploy] Running pre-deploy schema migrations...');
    expect(ctx.output.info).toHaveBeenCalledWith('[deploy] pre-deploy migrations complete.');
  });

  it('forwards config.migration.routines to runMigrations opts (C3 pass-through)', async () => {
    // Regression guard for the C2 handoff bug: runMigrationPhase must forward the
    // routines selector through to runMigrations — otherwise a saved deploy config's
    // routines selector never reaches the migration engine and Step 0 never runs.
    const runMigrationsSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/run-migrations.js', async () => {
      const actual = await vi.importActual<typeof import('../src/run-migrations.js')>('../src/run-migrations.js');
      return {
        ...actual,
        runMigrations: runMigrationsSpy,
      };
    });

    // Re-import runMigrationPhase with the mocked run-migrations module.
    vi.resetModules();
    const { runMigrationPhase: runMigrationPhaseMocked } = await import('../src/cli/commands/deploy-run.js');

    const config: DeployConfig = {
      name: 'production',
      hosts: ['10.0.0.1'],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
        routines: { bundle: 'zn_helpers', version: 2 },
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps();

    await runMigrationPhaseMocked(config.migration, 'pre-deploy', 'production', ctx, deps, { run: true });

    expect(runMigrationsSpy).toHaveBeenCalledTimes(1);
    const [, opts] = runMigrationsSpy.mock.calls[0];
    expect(opts.routines).toEqual({ bundle: 'zn_helpers', version: 2 });

    vi.doUnmock('../src/run-migrations.js');
    vi.resetModules();
  });

  it('forwards undefined routines when config.migration.routines is absent', async () => {
    const runMigrationsSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/run-migrations.js', async () => {
      const actual = await vi.importActual<typeof import('../src/run-migrations.js')>('../src/run-migrations.js');
      return {
        ...actual,
        runMigrations: runMigrationsSpy,
      };
    });

    vi.resetModules();
    const { runMigrationPhase: runMigrationPhaseMocked } = await import('../src/cli/commands/deploy-run.js');

    const config: DeployConfig = {
      name: 'production',
      hosts: ['10.0.0.1'],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps();

    await runMigrationPhaseMocked(config.migration, 'pre-deploy', 'production', ctx, deps, { run: true });

    expect(runMigrationsSpy).toHaveBeenCalledTimes(1);
    const [, opts] = runMigrationsSpy.mock.calls[0];
    expect(opts.routines).toBeUndefined();

    vi.doUnmock('../src/run-migrations.js');
    vi.resetModules();
  });

  it('runs with correct runner invocation (runner.run is called once)', async () => {
    const run = vi.fn().mockResolvedValue({ seeded: 0, reconciled: 0, applied: 3, pendingRemaining: 0 });
    const config: DeployConfig = {
      name: 'staging',
      hosts: ['10.0.0.2'],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps({ run });

    await runMigrationPhase(config.migration, 'pre-deploy', 'staging', ctx, deps, { run: true });

    // runner.run() must be called exactly once (no short-circuit)
    expect(run).toHaveBeenCalledTimes(1);

    // Lease must be revoked after success
    expect(deps.client.revokeCredential).toHaveBeenCalledTimes(1);
    expect(deps.client.revokeCredential).toHaveBeenCalledWith('L1', { reason: 'migration complete' });
  });

  it('propagates runMigrations failure and still revokes the lease (aborts deploy before rollout)', async () => {
    const migrationError = new Error('migration failed: duplicate column "foo"');
    const run = vi.fn().mockRejectedValue(migrationError);
    const revoke = vi.fn().mockResolvedValue(undefined);

    const config: DeployConfig = {
      name: 'production',
      hosts: ['10.0.0.1'],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps({ run, revoke });

    // runMigrationPhase must REJECT — proving the caller (the action) sees the error
    // and cannot proceed to executeListrDeployment
    await expect(
      runMigrationPhase(config.migration, 'pre-deploy', 'production', ctx, deps, { run: true }),
    ).rejects.toThrow('migration failed: duplicate column "foo"');

    // The lease must still be revoked even on failure (run-migrations finally block)
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

// ─── --skip-migrations ──────────────────────────────────────────────────────
//
// `--skip-migrations` is the inverse of `--migrations-only`: it deploys the WAR
// WITHOUT running the schema-migration phase, even when config.migration is set.
// The skip is implemented in runMigrationPhase via opts.run === false so both the
// flat and multi-class call-sites share one behaviour. When run is false and a
// migration config exists, runMigrationPhase prints a reason-tagged skip line and
// returns before minting a lease / applying the bundle / running any SQL.
//

describe('runMigrationPhase — --skip-migrations', () => {
  it('does NOT run migrations when run:false is set (config.migration present)', async () => {
    const run = vi.fn().mockResolvedValue({ seeded: 0, reconciled: 0, applied: 1, pendingRemaining: 0 });
    const config: DeployConfig = {
      name: 'production',
      hosts: ['10.0.0.1'],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
        routines: { bundle: 'znapi-helpers', version: 1 },
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps({ run });

    await runMigrationPhase(config.migration, 'pre-deploy', 'production', ctx, deps, {
      run: false, skipReason: { kind: 'flag', flag: '--skip-migrations' },
    });

    // Nothing executed: no lease minted, no runner invoked, no bundle applied.
    expect(deps.client.issueCredential).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    // A visible skip line was printed (so the operator knows migrations were bypassed).
    const infoCalls = ctx.output.info.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((m) => /skip/i.test(m) && /migration/i.test(m))).toBe(true);

    // The real-run lines must NOT appear.
    expect(ctx.output.info).not.toHaveBeenCalledWith('[deploy] Running pre-deploy schema migrations...');
    expect(ctx.output.info).not.toHaveBeenCalledWith('[deploy] pre-deploy migrations complete.');
  });

  it('is a silent no-op when run:false is set but config.migration is absent', async () => {
    const config: DeployConfig = {
      name: 'no-migration',
      hosts: ['10.0.0.1'],
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps();

    await runMigrationPhase(config.migration, 'pre-deploy', 'no-migration', ctx, deps, {
      run: false, skipReason: { kind: 'flag', flag: '--skip-migrations' },
    });

    expect(deps.client.issueCredential).not.toHaveBeenCalled();
    // Nothing to skip, so no skip line is printed either.
    expect(ctx.output.info).not.toHaveBeenCalled();
  });

  it('run:false takes precedence over dryRun (skip line, not dry-run plan)', async () => {
    // If both are somehow set, skip wins — no plan is printed, nothing runs.
    const config: DeployConfig = {
      name: 'staging',
      hosts: ['10.0.0.1'],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
        routines: { bundle: 'znapi-helpers', version: 1 },
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps();

    await runMigrationPhase(config.migration, 'pre-deploy', 'staging', ctx, deps, {
      run: false, dryRun: true, skipReason: { kind: 'flag', flag: '--skip-migrations' },
    });

    expect(deps.client.issueCredential).not.toHaveBeenCalled();
    const infoCalls = ctx.output.info.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((m) => /skip/i.test(m) && /migration/i.test(m))).toBe(true);
    // The dry-run plan line must NOT appear (skip short-circuited before it).
    expect(infoCalls.some((m) => /would run.*schema migrations/i.test(m))).toBe(false);
  });
});

// ─── Multi-class config shape ─────────────────────────────────────────────────
//
// These tests prove that runMigrationPhase is shape-agnostic: it inspects only
// the migration config and phase — it does NOT care whether the caller's config has
// `hosts` (flat) or `classes` (multi-class).  The call-site addition in
// deploy-run.ts now calls runMigrationPhase BEFORE runMultiClassDeploy, so the
// multi-class deploy aborts on migration failure before ANY host is touched.
//

describe('runMigrationPhase — multi-class config shape', () => {
  it('is a no-op when a multi-class config has no migration block', async () => {
    const config: DeployConfig = {
      name: 'staging',
      classes: [
        { name: 'api', hosts: ['10.0.0.1'] },
        { name: 'worker', hosts: ['10.0.0.2'] },
      ],
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps();

    await runMigrationPhase(config.migration, 'pre-deploy', 'staging', ctx, deps, { run: true });

    expect(deps.client.issueCredential).not.toHaveBeenCalled();
    expect(ctx.output.info).not.toHaveBeenCalled();
  });

  it('runs migrations when a multi-class config has a migration block', async () => {
    const config: DeployConfig = {
      name: 'staging',
      classes: [
        { name: 'api', hosts: ['10.0.0.1'] },
        { name: 'worker', hosts: ['10.0.0.2'] },
      ],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps();

    await runMigrationPhase(config.migration, 'pre-deploy', 'staging', ctx, deps, { run: true });

    // Credential must have been issued — runMigrations ran
    expect(deps.client.issueCredential).toHaveBeenCalledWith('zincdb-rw', { ttlSeconds: 14400 });
    expect(deps.client.issueCredential).toHaveBeenCalledTimes(1);

    // Both info lines fire — full runMigrations lifecycle completed
    expect(ctx.output.info).toHaveBeenCalledWith('[deploy] Running pre-deploy schema migrations...');
    expect(ctx.output.info).toHaveBeenCalledWith('[deploy] pre-deploy migrations complete.');
  });

  it('propagates failure for a multi-class config (aborts before any class rolls out)', async () => {
    const migrationError = new Error('migration failed: table already exists');
    const run = vi.fn().mockRejectedValue(migrationError);
    const revoke = vi.fn().mockResolvedValue(undefined);

    const config: DeployConfig = {
      name: 'production',
      classes: [
        { name: 'api', hosts: ['10.0.0.1', '10.0.0.2'] },
        { name: 'worker', hosts: ['10.0.0.3'] },
      ],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps({ run, revoke });

    // Must reject — the caller (the action handler) will NOT proceed to runMultiClassDeploy
    await expect(
      runMigrationPhase(config.migration, 'pre-deploy', 'production', ctx, deps, { run: true }),
    ).rejects.toThrow('migration failed: table already exists');

    // Lease revoked even on failure
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

// ─── --migrations-only contract ───────────────────────────────────────────────
//
// The early-return that skips the rollout lives inside the `.action()` closure and
// can't be unit-tested without a full commander spawn.  These tests verify the
// runMigrationPhase contract that the --migrations-only path relies on:
//   • runMigrationPhase completes successfully when migration config is present
//     (so the caller can safely early-return after it).
//   • runMigrationPhase is a no-op when migration config is absent
//     (the action-level guard fires before this, but no-op is safe regardless).
//

describe('--migrations-only: runMigrationPhase contract', () => {
  it('completes successfully with migration config (caller can early-return after)', async () => {
    const run = vi.fn().mockResolvedValue({ seeded: 0, reconciled: 0, applied: 2, pendingRemaining: 0 });
    const config: DeployConfig = {
      name: 'production',
      hosts: ['10.0.0.1'],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps({ run });

    // Must resolve (not throw) — --migrations-only returns right after this
    await expect(
      runMigrationPhase(config.migration, 'pre-deploy', 'production', ctx, deps, { run: true }),
    ).resolves.toBeUndefined();

    // Migrations ran and lease was revoked
    expect(run).toHaveBeenCalledTimes(1);
    expect(deps.client.revokeCredential).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without migration config (action guard fires first; runMigrationPhase safe regardless)', async () => {
    const config: DeployConfig = {
      name: 'no-migration',
      hosts: ['10.0.0.1'],
      // No migration block
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps();

    await expect(
      runMigrationPhase(config.migration, 'pre-deploy', 'no-migration', ctx, deps, { run: true }),
    ).resolves.toBeUndefined();

    // runMigrations was NOT invoked
    expect(deps.client.issueCredential).not.toHaveBeenCalled();
  });

  it('propagates failure so the action cannot proceed past runMigrationPhase', async () => {
    const run = vi.fn().mockRejectedValue(new Error('migration failed: column missing'));

    const config: DeployConfig = {
      name: 'production',
      hosts: ['10.0.0.1'],
      migration: {
        roleId: 'zincdb-rw',
        migrationsDir: 'docs/migrations',
      },
    } as unknown as DeployConfig;

    const ctx = makeMockCtx();
    const deps = makeMockDeps({ run });

    // --migrations-only flow: if runMigrationPhase rejects, the action
    // propagates the error (no rollout runs, no success message emitted)
    await expect(
      runMigrationPhase(config.migration, 'pre-deploy', 'production', ctx, deps, { run: true }),
    ).rejects.toThrow('migration failed: column missing');
    expect(ctx.output.success).not.toHaveBeenCalled();
  });
});

// ─── Generalized (post + reasons) ─────────────────────────────────────────────
//
// Task 5: runMigrationPhase now takes an explicit `migration` value (not a whole
// DeployConfig) and a `phase` ('pre-deploy' | 'post-deploy'), so it can drive
// either migration phase. `opts.run === false` skips with a reason-tagged line
// built from `opts.skipReason` (see MigrationSkipReason in post-gate.ts).
//

describe('runMigrationPhase — generalized (post + reasons)', () => {
  it('runs the post-deploy phase against its own dir', async () => {
    const run = vi.fn().mockResolvedValue({ seeded: 0, reconciled: 0, applied: 1, pendingRemaining: 0 });
    const post = { roleId: 'zincdb-rw', migrationsDir: 'db/post' } as any;
    const ctx = makeMockCtx();
    const deps = makeMockDeps({ run });
    await runMigrationPhase(post, 'post-deploy', 'prod', ctx, deps, { run: true });
    expect(deps.client.issueCredential).toHaveBeenCalledWith('zincdb-rw', { ttlSeconds: 14400 });
    const infoCalls = ctx.output.info.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((m) => /post-deploy/i.test(m) && /Running/i.test(m))).toBe(true);
  });

  it('run:false prints a reason-tagged skip line and does not execute', async () => {
    const post = { roleId: 'r', migrationsDir: 'db/post' } as any;
    const ctx = makeMockCtx();
    const deps = makeMockDeps();
    await runMigrationPhase(post, 'post-deploy', 'prod', ctx, deps, {
      run: false, skipReason: { kind: 'partial-coverage', dropped: ['h3'] },
    });
    expect(deps.client.issueCredential).not.toHaveBeenCalled();
    const infoCalls = ctx.output.info.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((m) => /Skipping post-deploy/i.test(m) && /h3/.test(m))).toBe(true);
  });

  it('run:false with a flag reason names the flag', async () => {
    const pre = { roleId: 'r', migrationsDir: 'db/pre' } as any;
    const ctx = makeMockCtx();
    const deps = makeMockDeps();
    await runMigrationPhase(pre, 'pre-deploy', 'prod', ctx, deps, {
      run: false, skipReason: { kind: 'flag', flag: '--skip-migrations' },
    });
    const infoCalls = ctx.output.info.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((m) => /Skipping pre-deploy/i.test(m) && /--skip-migrations/.test(m))).toBe(true);
  });
});
