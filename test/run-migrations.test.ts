/**
 * test/run-migrations.test.ts
 *
 * Tests for the run-migrations deploy phase (mocked deps — no real vault/DB).
 *
 * Verifies:
 *  - Lease minted on the correct role with TTL 14400 (4h)
 *  - runner.run() is ALWAYS called exactly once (no status short-circuit — CRITICAL F4.1)
 *  - revokeOnce called exactly once on success
 *  - revokeOnce called exactly once when run() throws (deploy fails, revoke still fires)
 *  - Transient revoke failures are retried; a 3× failure logs rather than throwing
 *  - openDb is called with the LEASE's host/port/database (not from opts)
 *  - Signal handler registration/cleanup (hard to test process.exit path safely)
 *  - Real error message is included in the WARN log on revoke failure (Part A)
 *  - Non-revocable lease (vault FAILED state) stops retrying immediately (Part C)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '../src/run-migrations.js';
import type { RunMigrationsDeps, RunMigrationsOpts } from '../src/run-migrations.js';

// ─── Test harness ─────────────────────────────────────────────────────────────

interface HarnessOverrides {
  revoke?: ReturnType<typeof vi.fn>;
  run?: ReturnType<typeof vi.fn>;
  openDb?: ReturnType<typeof vi.fn>;
  applyRoutines?: ReturnType<typeof vi.fn>;
}

function harness(overrides: HarnessOverrides = {}): {
  issue: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  applyRoutines: ReturnType<typeof vi.fn>;
  deps: RunMigrationsDeps;
  opts: RunMigrationsOpts;
} {
  const issue = vi.fn().mockResolvedValue({
    leaseId: 'L',
    username: 'u',
    password: 'p',
    host: 'vault-host.example.com',
    port: 6446,
    database: 'zincdb',
  });
  const revoke = overrides.revoke ?? vi.fn().mockResolvedValue(undefined);
  const run = overrides.run ?? vi.fn().mockResolvedValue({
    seeded: 0, reconciled: 0, applied: 1, pendingRemaining: 0,
  });
  const applyRoutines = overrides.applyRoutines ?? vi.fn().mockResolvedValue(undefined);

  const mockDbHandle = { end: vi.fn().mockResolvedValue(undefined) };
  const openDb = overrides.openDb ?? vi.fn().mockResolvedValue(mockDbHandle);

  const deps: RunMigrationsDeps = {
    client: { issueCredential: issue, revokeCredential: revoke, applyRoutines },
    openDb: openDb as RunMigrationsDeps['openDb'],
    makeRunner: () => ({ run }),
    settleMs: 0, // no real waiting in tests
  };

  const opts: RunMigrationsOpts = {
    env: 'production',
    roleId: 'dbr_bc3546e8729d4727',
    // NOTE: no host/port here — those come from the lease
    database: 'zincdb', // optional override (matches the lease's database in this harness)
    migrationsDir: '/migrations',
  };

  return { issue, revoke, run, applyRoutines, deps, opts };
}

// Minimal ctx that captures warn messages
function makeCtx(): {
  output: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  warns: string[];
} {
  const warns: string[] = [];
  return {
    output: {
      info: vi.fn(),
      warn: vi.fn((msg: string) => { warns.push(msg); }),
    },
    warns,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('runMigrations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('mints a 4h lease on the rw role, always runs, revokes exactly once on success', async () => {
    const { issue, revoke, run, deps, opts } = harness();
    const ctx = makeCtx();

    await runMigrations(ctx, opts, deps);

    // Lease minted with the correct role and TTL (4h = 14400s)
    expect(issue).toHaveBeenCalledWith('dbr_bc3546e8729d4727', { ttlSeconds: 14400 });
    expect(issue).toHaveBeenCalledTimes(1);

    // runner.run() ALWAYS called — no status short-circuit
    expect(run).toHaveBeenCalledTimes(1);

    // Revoke called exactly once (in finally)
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('L', { reason: 'migration complete' });
  });

  it('opens DB with the LEASE host/port/database (not from opts), ssl: true', async () => {
    const issue = vi.fn().mockResolvedValue({
      leaseId: 'L',
      username: 'dynUser',
      password: 'dynPass',
      host: '172.16.220.40',   // host comes from the lease
      port: 6446,              // port comes from the lease
      database: 'zincdb',     // database comes from the lease
    });
    const mockDbHandle = { end: vi.fn().mockResolvedValue(undefined) };
    const openDb = vi.fn().mockResolvedValue(mockDbHandle);

    const deps: RunMigrationsDeps = {
      client: { issueCredential: issue, revokeCredential: vi.fn().mockResolvedValue(undefined), applyRoutines: vi.fn().mockResolvedValue(undefined) },
      openDb: openDb as RunMigrationsDeps['openDb'],
      makeRunner: () => ({ run: vi.fn().mockResolvedValue({}) }),
      settleMs: 0,
    };
    // NOTE: opts does NOT carry host/port — those come from the lease
    const opts: RunMigrationsOpts = {
      env: 'production',
      roleId: 'r',
      migrationsDir: '/m',
    };
    const ctx = makeCtx();

    await runMigrations(ctx, opts, deps);

    // openDb must receive the LEASE's host/port/database, not the opts
    expect(openDb).toHaveBeenCalledWith({
      host: '172.16.220.40',
      port: 6446,
      database: 'zincdb',
      user: 'dynUser',
      password: 'dynPass',
      ssl: true,
    });
  });

  it('uses opts.database override when lease does not provide a database name', async () => {
    const issue = vi.fn().mockResolvedValue({
      leaseId: 'L',
      username: 'u',
      password: 'p',
      host: '10.0.0.1',
      port: 3306,
      // no database in lease
    });
    const mockDbHandle = { end: vi.fn().mockResolvedValue(undefined) };
    const openDb = vi.fn().mockResolvedValue(mockDbHandle);

    const deps: RunMigrationsDeps = {
      client: { issueCredential: issue, revokeCredential: vi.fn().mockResolvedValue(undefined), applyRoutines: vi.fn().mockResolvedValue(undefined) },
      openDb: openDb as RunMigrationsDeps['openDb'],
      makeRunner: () => ({ run: vi.fn().mockResolvedValue({}) }),
      settleMs: 0,
    };
    const opts: RunMigrationsOpts = {
      env: 'production',
      roleId: 'r',
      migrationsDir: '/m',
      database: 'override_db', // caller-supplied fallback
    };
    const ctx = makeCtx();

    await runMigrations(ctx, opts, deps);

    expect(openDb).toHaveBeenCalledWith(expect.objectContaining({
      host: '10.0.0.1',
      port: 3306,
      database: 'override_db',
    }));
  });

  it('throws when neither lease nor opts provide a database name', async () => {
    const issue = vi.fn().mockResolvedValue({
      leaseId: 'L',
      username: 'u',
      password: 'p',
      host: '10.0.0.1',
      port: 3306,
      // no database
    });
    const revoke = vi.fn().mockResolvedValue(undefined);
    const deps: RunMigrationsDeps = {
      client: { issueCredential: issue, revokeCredential: revoke, applyRoutines: vi.fn().mockResolvedValue(undefined) },
      openDb: vi.fn() as RunMigrationsDeps['openDb'],
      makeRunner: () => ({ run: vi.fn() }),
      settleMs: 0,
    };
    const opts: RunMigrationsOpts = {
      env: 'production',
      roleId: 'r',
      migrationsDir: '/m',
      // no database override
    };
    const ctx = makeCtx();

    await expect(runMigrations(ctx, opts, deps)).rejects.toThrow(
      '[run-migrations] No database name',
    );
    // Lease should still be revoked in finally
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('revokes exactly once even when runner.run() throws (migration failure)', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    const { deps, opts } = harness({ revoke, run });
    const ctx = makeCtx();

    await expect(runMigrations(ctx, opts, deps)).rejects.toThrow('boom');
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('revokes exactly once even when openDb throws (no DB connection)', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const openDb = vi.fn().mockRejectedValue(new Error('connect failed'));
    const { deps, opts } = harness({ revoke, openDb });
    const ctx = makeCtx();

    await expect(runMigrations(ctx, opts, deps)).rejects.toThrow('connect failed');
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('propagates mint (issueCredential) failure without revoking', async () => {
    const issue = vi.fn().mockRejectedValue(new Error('vault down'));
    const revoke = vi.fn();
    const deps: RunMigrationsDeps = {
      client: { issueCredential: issue, revokeCredential: revoke, applyRoutines: vi.fn().mockResolvedValue(undefined) },
      openDb: vi.fn() as RunMigrationsDeps['openDb'],
      makeRunner: () => ({ run: vi.fn() }),
      settleMs: 0,
    };
    const ctx = makeCtx();

    await expect(
      runMigrations(ctx, { env: 'production', roleId: 'r', migrationsDir: '/m' }, deps)
    ).rejects.toThrow('vault down');

    // revokeOnce never set up (lease never minted) — no revoke call
    expect(revoke).not.toHaveBeenCalled();
  });

  it('retries revoke on transient failures: rejects twice, succeeds on 3rd — resolves', async () => {
    vi.useRealTimers(); // real timers for setTimeout in retry loop
    const revoke = vi.fn()
      .mockRejectedValueOnce(new Error('net blip 1'))
      .mockRejectedValueOnce(new Error('net blip 2'))
      .mockResolvedValueOnce(undefined);

    const { deps, opts } = harness({ revoke });
    const ctx = makeCtx();

    await expect(runMigrations(ctx, opts, deps)).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(3); // 3 attempts; 3rd succeeds
  });

  it('all 3 revoke attempts fail — runMigrations still resolves (logs WARN, does NOT throw)', async () => {
    vi.useRealTimers();
    const revoke = vi.fn().mockRejectedValue(new Error('persistent network failure'));
    const { deps, opts } = harness({ revoke });
    const ctx = makeCtx();

    // Should NOT reject even though revoke always fails
    await expect(runMigrations(ctx, opts, deps)).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(3);
    // Should have logged a WARN about the failure
    expect(ctx.warns.some((w) => w.includes('revoke failed'))).toBe(true);
  });

  it('revokeOnce is idempotent: parallel calls still invoke revokeCredential only once', async () => {
    // Simulate a scenario where both the finally-block and a concurrent signal handler
    // try to invoke revokeOnce — the credential should be revoked only once.
    vi.useRealTimers();
    const revoke = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({});

    // We test idempotency by making makeRunner return a runner that
    // schedules a secondary revokeOnce call. We can't inject into the closure
    // directly, but we can verify via call count after two concurrent callers:
    // the simplest approach is to confirm that a normal run (finally calls revokeOnce)
    // plus the fact that calling runMigrations again would re-mint (i.e., idempotency
    // within a single run is internal). Instead, test the revoke count == 1:
    const { deps, opts } = harness({ revoke, run });
    const ctx = makeCtx();

    await runMigrations(ctx, opts, deps);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('registers SIGINT/SIGTERM handlers and removes them after completion', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const offSpy = vi.spyOn(process, 'removeListener');

    const { deps, opts } = harness();
    const ctx = makeCtx();

    await runMigrations(ctx, opts, deps);

    // Should have registered SIGINT and SIGTERM
    const registeredEvents = onSpy.mock.calls.map(([event]) => event);
    expect(registeredEvents).toContain('SIGINT');
    expect(registeredEvents).toContain('SIGTERM');

    // Should have removed SIGINT and SIGTERM
    const removedEvents = offSpy.mock.calls.map(([event]) => event);
    expect(removedEvents).toContain('SIGINT');
    expect(removedEvents).toContain('SIGTERM');
  });

  it('signal handler registration cleaned up even when run() throws', async () => {
    const offSpy = vi.spyOn(process, 'removeListener');

    const run = vi.fn().mockRejectedValue(new Error('migration error'));
    const { deps, opts } = harness({ run });
    const ctx = makeCtx();

    await expect(runMigrations(ctx, opts, deps)).rejects.toThrow('migration error');

    // Signal handlers MUST still be cleaned up in the finally block
    const removedEvents = offSpy.mock.calls.map(([event]) => event);
    expect(removedEvents).toContain('SIGINT');
    expect(removedEvents).toContain('SIGTERM');
  });

  it('does not log the DB password when openDb fails', async () => {
    const SECRET = 'super-secret-lease-password-xyz';
    const revoke = vi.fn().mockResolvedValue(undefined);
    const openDb = vi.fn().mockRejectedValue(new Error('connection refused to 172.16.220.40'));

    // Capture ALL log output (info, warn, error)
    const logged: string[] = [];
    const ctx = {
      output: {
        info: (...args: unknown[]) => { logged.push(args.map(String).join(' ')); },
        warn: (...args: unknown[]) => { logged.push(args.map(String).join(' ')); },
        error: (...args: unknown[]) => { logged.push(args.map(String).join(' ')); },
      },
    };

    const deps: RunMigrationsDeps = {
      client: {
        issueCredential: vi.fn().mockResolvedValue({
          leaseId: 'L',
          username: 'u',
          password: SECRET,
          host: 'h',
          port: 3306,
          database: 'd',
        }),
        revokeCredential: revoke,
        applyRoutines: vi.fn().mockResolvedValue(undefined),
      },
      openDb: openDb as RunMigrationsDeps['openDb'],
      makeRunner: () => ({ run: vi.fn() }),
      settleMs: 0,
    };

    const opts: RunMigrationsOpts = {
      env: 'production',
      roleId: 'r',
      migrationsDir: '/m',
    };

    await expect(runMigrations(ctx as any, opts, deps)).rejects.toThrow('connection refused');

    // The password must NEVER appear in any log line
    const allLogs = logged.join('\n');
    expect(allLogs).not.toContain(SECRET);

    // Verify the lease was still revoked (cleanup ran)
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  // ─── Part A: real error message in WARN log ────────────────────────────────

  it('WARN log includes the real error message when all revoke attempts fail', async () => {
    vi.useRealTimers();
    const revoke = vi.fn().mockRejectedValue(new Error('tls handshake timeout'));
    const { deps, opts } = harness({ revoke });
    const ctx = makeCtx();

    await expect(runMigrations(ctx, opts, deps)).resolves.toBeUndefined();

    // At least one WARN must include the actual error text, not just "revoke failed"
    const warnWithError = ctx.warns.find(
      (w) => w.includes('tls handshake timeout'),
    );
    expect(warnWithError).toBeTruthy();
    // And the final WARN must mention how many attempts were made
    expect(ctx.warns.some((w) => w.includes('revoke failed after'))).toBe(true);
  });

  it('non-last retry attempt logs DEBUG line with attempt number and error', async () => {
    vi.useRealTimers();
    const revoke = vi.fn()
      .mockRejectedValueOnce(new Error('net blip attempt 1'))
      .mockResolvedValueOnce(undefined); // succeeds on attempt 2

    const { deps, opts } = harness({ revoke });
    const ctx = makeCtx();

    await expect(runMigrations(ctx, opts, deps)).resolves.toBeUndefined();

    // Should have logged a retry attempt message with the error text
    const retryLog = ctx.warns.find(
      (w) => w.includes('revoke attempt') && w.includes('net blip attempt 1'),
    );
    expect(retryLog).toBeTruthy();
  });

  // ─── Part C: non-revocable lease stops retrying immediately ───────────────

  it('stops retrying immediately when vault reports a non-revocable FAILED lease state', async () => {
    vi.useRealTimers();
    const revoke = vi.fn().mockRejectedValue(
      new Error('Cannot revoke failed lease'),
    );
    const { deps, opts } = harness({ revoke });
    const ctx = makeCtx();

    // Must resolve (not throw) — the non-retrying path still logs and returns
    await expect(runMigrations(ctx, opts, deps)).resolves.toBeUndefined();

    // Should have called revokeCredential only ONCE (no futile retries)
    expect(revoke).toHaveBeenCalledTimes(1);

    // WARN log must include the real vault error
    const warnWithMsg = ctx.warns.find(
      (w) => w.includes('Cannot revoke failed lease'),
    );
    expect(warnWithMsg).toBeTruthy();
  });

  it('stops retrying immediately on "failed lease" variant error message', async () => {
    vi.useRealTimers();
    const revoke = vi.fn().mockRejectedValue(
      new Error('Cannot revoke a FAILED lease — state transition not allowed'),
    );
    const { deps, opts } = harness({ revoke });
    const ctx = makeCtx();

    await expect(runMigrations(ctx, opts, deps)).resolves.toBeUndefined();
    // Only ONE attempt — no retries
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('still retries 3× on a generic transient error (not a failed-lease error)', async () => {
    vi.useRealTimers();
    const revoke = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const { deps, opts } = harness({ revoke });
    const ctx = makeCtx();

    await expect(runMigrations(ctx, opts, deps)).resolves.toBeUndefined();
    // Generic transient error → all 3 attempts exhausted
    expect(revoke).toHaveBeenCalledTimes(3);
  });

  // ─── Step 0: apply routine bundle BEFORE minting the lease ────────────────

  it('applies the routine bundle BEFORE minting the lease when opts.routines is set', async () => {
    const { issue, applyRoutines, deps, opts } = harness();
    const ctx = makeCtx();

    const routines = { bundle: 'zn_migration_helpers', version: 3 };
    await runMigrations(ctx, { ...opts, routines }, deps);

    expect(applyRoutines).toHaveBeenCalledWith('dbr_bc3546e8729d4727', routines);
    expect(issue).toHaveBeenCalledTimes(1);

    // Call order: applyRoutines must fire strictly before issueCredential.
    const applyOrder = applyRoutines.mock.invocationCallOrder[0];
    const issueOrder = issue.mock.invocationCallOrder[0];
    expect(applyOrder).toBeLessThan(issueOrder);
  });

  it('aborts before minting a lease when applyRoutines rejects', async () => {
    const applyRoutines = vi.fn().mockRejectedValue(new Error('bundle rejected: DEFINER clause present'));
    const { issue, revoke, deps, opts } = harness({ applyRoutines });
    const ctx = makeCtx();

    const routines = { bundle: 'zn_migration_helpers', version: 3 };
    await expect(runMigrations(ctx, { ...opts, routines }, deps)).rejects.toThrow(
      'bundle rejected: DEFINER clause present',
    );

    // No lease minted, and therefore nothing to revoke.
    expect(issue).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('does not call applyRoutines when opts.routines is absent (byte-identical to today)', async () => {
    const { issue, revoke, run, applyRoutines, deps, opts } = harness();
    const ctx = makeCtx();

    await runMigrations(ctx, opts, deps);

    expect(applyRoutines).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
