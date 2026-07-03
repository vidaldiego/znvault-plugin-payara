/**
 * Unit tests for the scaffolding bracket in MigrationRunner.run().
 *
 * Binding contract under test (see .superpowers/sdd/task-5-brief.md):
 *  1. Order: scaffold-apply → reconcile → pending → scaffold-drop.
 *  2. Unconditional cleanup: scaffold-drop still runs even when a pending
 *     migration throws (the phase fails, but the drop must not be skipped).
 *  3. No-op: constructing the runner WITHOUT a scaffolding config performs
 *     zero apply/drop calls — existing (4-arg) callers are byte-identical.
 *  4. Lock-lost guard: if the cleanup's lock-held check rejects (dead connection
 *     during IS_USED_LOCK — not just a clean "not held" result), the drop is
 *     skipped and the guard's own rejection never masks the primary phase's
 *     result/error (success stays success, the real failure still propagates).
 *  5. Cleanup-failure containment: if dropDefinerObjects itself throws, that
 *     failure is logged and swallowed — a successful phase still returns its
 *     RunResult, and a failing phase's primary error still propagates unmasked.
 *
 * `readScaffoldingSql`/`dropDefinerObjects` are stubbed via vi.mock so this
 * is a pure unit test of the bracket's ORDERING, not real MySQL DDL. Every
 * other collaborator (discover/plan/lock/SchemaMigrationsRepo/splitStatements)
 * runs FOR REAL against a fake in-memory `Db` and a real temp migrations
 * directory — this avoids re-faking the planner/repo internals and proves
 * the bracket against the actual run() control flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../../src/migrate/db.js';

const dropCalls: string[] = [];

// Settable from within a test to make the mocked dropDefinerObjects reject —
// reset in beforeEach so it never leaks between tests.
let dropShouldThrow = false;

vi.mock('../../src/migrate/scaffolding.js', () => ({
  readScaffoldingSql: (_dir: string, filename: string) => ({
    path: `/x/${filename}`,
    statements: [`SELECT 'scaffold ${filename}'`],
  }),
  dropDefinerObjects: async (_db: unknown, leaseUser: string) => {
    trace.push('scaffold-drop');
    dropCalls.push(leaseUser);
    if (dropShouldThrow) throw new Error('boom: dropDefinerObjects failed');
    return 1;
  },
}));

// Imported AFTER vi.mock so migration-runner.ts picks up the mocked scaffolding module.
const { MigrationRunner } = await import('../../src/migrate/migration-runner.js');

const trace: string[] = [];

/**
 * A fake `Db` that satisfies the full `Db` interface (query/execute/end/connectionId)
 * and traces control-flow events into `trace` based on the SQL being run:
 *  - GET_LOCK / IS_USED_LOCK / RELEASE_LOCK → lock bookkeeping (always succeeds).
 *  - schema_migrations DDL/DML → an in-memory row store (SchemaMigrationsRepo/plan
 *    run for real against this).
 *  - the scaffold statement text ("-- scaffold ...") → pushes 'scaffold-apply'.
 *  - a migration body statement → pushes 'reconcile' or 'pending' depending on a
 *    marker comment in the file, and optionally throws (for the failure test).
 *
 * `isUsedLockRejectAfter` lets a test make `SELECT IS_USED_LOCK` reject starting
 * from a given 1-based call index, so it can simulate a connection that dies
 * partway through a run — specifically, surviving every `requireLockHeld()` call
 * in the main phase (so the primary work completes/fails normally) and only
 * rejecting on the LAST call, which is always the scaffolding cleanup's
 * non-throwing `lockHeld()` guard in the `finally` block (the only caller of
 * `lockHeld()` in the runner). Undefined/omitted → IS_USED_LOCK always reports
 * the lock held.
 */
function makeFakeDb(opts: { throwOnPending?: boolean; isUsedLockRejectAfter?: number } = {}): Db {
  let isUsedLockCallCount = 0;
  const rows: {
    version: string;
    checksum: string;
    checksum_algo: string;
    applied_by: string;
    execution_ms: number;
    success: number;
    baselined: number;
  }[] = [];

  const db: Db = {
    connectionId: 42,
    async query(sql: string, _params?: unknown[]): Promise<unknown[]> {
      if (/^SELECT VERSION\(\)/.test(sql)) return [{ v: '8.4.10' }];
      if (/^SELECT @@read_only/.test(sql)) return [{ ro: 0 }];
      if (/^SELECT GET_LOCK/.test(sql)) return [{ 'GET_LOCK(?, ?)': 1 }];
      if (/^SELECT IS_USED_LOCK/.test(sql)) {
        isUsedLockCallCount++;
        if (opts.isUsedLockRejectAfter !== undefined && isUsedLockCallCount > opts.isUsedLockRejectAfter) {
          throw new Error('boom: connection dead (simulated) during IS_USED_LOCK');
        }
        return [{ held: 1 }];
      }
      if (/^SELECT RELEASE_LOCK/.test(sql)) return [{ released: 1 }];
      if (/^\s*CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) return [];
      if (/^SELECT version, checksum, checksum_algo, success, baselined FROM schema_migrations/.test(sql)) {
        return rows;
      }
      if (/^SELECT 'scaffold /.test(sql)) {
        trace.push('scaffold-apply');
        return [];
      }
      if (/^SELECT 'reconcile-body'/.test(sql)) {
        trace.push('reconcile');
        return [];
      }
      if (/^SELECT 'pending-body'/.test(sql)) {
        trace.push('pending');
        if (opts.throwOnPending) throw new Error('boom: pending migration failed');
        return [];
      }
      return [];
    },
    async execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]> {
      if (/^INSERT INTO schema_migrations/.test(sql)) {
        const [version, checksum, checksum_algo, applied_by] = params as string[];
        rows.push({
          version: version!,
          checksum: checksum!,
          checksum_algo: checksum_algo!,
          applied_by: applied_by!,
          execution_ms: 0,
          success: 0,
          baselined: 0,
        });
        return [{ affectedRows: 1 }, null];
      }
      if (/^UPDATE schema_migrations SET success = 1/.test(sql)) {
        const [executionMs, version] = params as [number, string];
        const row = rows.find((r) => r.version === version);
        if (row) {
          row.success = 1;
          row.execution_ms = executionMs;
        }
        return [{ affectedRows: row ? 1 : 0 }, null];
      }
      return [{ affectedRows: 0 }, null];
    },
    async end(): Promise<void> {},
  };
  return db;
}

let dir: string;

beforeEach(() => {
  trace.length = 0;
  dropCalls.length = 0;
  dropShouldThrow = false;
  dir = mkdtempSync(join(tmpdir(), 'runner-scaffold-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('MigrationRunner scaffolding bracket', () => {
  it('applies scaffolding BEFORE migrations and drops definer objects AFTER reconcile/pending', async () => {
    // A single pending migration whose body is traced as 'pending'.
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    const db = makeFakeDb();
    const runner = new MigrationRunner(db, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    const result = await runner.run();

    expect(trace).toEqual(['scaffold-apply', 'pending', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
    expect(result.applied).toBe(1);
  });

  it('applies scaffolding before a reconcile row and drops after it, in order', async () => {
    // Pre-seed a success=0 row so plan() routes this file to reconcile, not pending.
    const migrationPath = join(dir, '2026-07-02_001_probe.sql');
    writeFileSync(migrationPath, "SELECT 'reconcile-body';\n");

    const db = makeFakeDb();
    // Seed the row directly via execute() semantics (bypass claim()) so plan() sees
    // success=0 for this version — i.e. simulate a crashed prior run.
    const { canonicalChecksumFile } = await import('../../src/migrate/checksum.js');
    await db.execute(
      'INSERT INTO schema_migrations (version, checksum, checksum_algo, applied_at, applied_by, execution_ms, success, baselined) VALUES (?, ?, ?, NOW(3), ?, 0, 0, 0)',
      ['2026-07-02_001_probe.sql', canonicalChecksumFile(migrationPath), 'sha256-lf-v1', 'prior-runner'],
    );

    const runner = new MigrationRunner(db, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    const result = await runner.run();

    expect(trace).toEqual(['scaffold-apply', 'reconcile', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
    expect(result.reconciled).toBe(1);
  });

  it('drops definer objects even when a pending migration throws (unconditional cleanup)', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    const db = makeFakeDb({ throwOnPending: true });
    const runner = new MigrationRunner(db, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    await expect(runner.run()).rejects.toThrow(/boom: pending migration failed/);

    // scaffold-apply happened, pending was attempted (and threw), and — critically —
    // scaffold-drop STILL ran despite the thrown error.
    expect(trace).toEqual(['scaffold-apply', 'pending', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
  });

  it('skips the drop (no masking) when the lock-held check rejects during cleanup, on a SUCCESSFUL phase', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    // 3 IS_USED_LOCK calls happen before cleanup on the success path (1 for the
    // scaffold-apply statement, 2 for the pending loop's before-claim/after-exec
    // requireLockHeld() calls) — the 4th call is the scaffolding finally guard's
    // lockHeld(), which we make reject here to simulate a connection that died
    // right as cleanup began (e.g. killed session / proxy reconnect).
    const db = makeFakeDb({ isUsedLockRejectAfter: 3 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new MigrationRunner(db, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    const result = await runner.run();

    // The primary phase succeeded and its result is unchanged — a rejecting
    // lock-held check must not turn a successful phase into a failure.
    expect(result).toEqual({ seeded: 0, reconciled: 0, applied: 1, pendingRemaining: 0 });
    // dropDefinerObjects must NOT be called: the lock-held guard rejected, which
    // is treated as "lock not held" — don't dial the DB under a lost/dead lock.
    expect(trace).toEqual(['scaffold-apply', 'pending']);
    expect(trace).not.toContain('scaffold-drop');
    expect(dropCalls).toEqual([]);
    // The lockHeld() rejection itself is logged, not silently dropped.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lock.isHeld() failed'));

    warnSpy.mockRestore();
  });

  it('skips the drop (no masking) when the lock-held check rejects during cleanup, on a FAILING phase', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    // On the throw path only 2 IS_USED_LOCK calls happen before cleanup (the
    // scaffold-apply statement's requireLockHeld() + the pending loop's
    // before-claim requireLockHeld() — the throw inside executeStatements
    // pre-empts the after-exec requireLockHeld() call) — so the 3rd call is the
    // cleanup guard's lockHeld(), which we make reject.
    const db = makeFakeDb({ throwOnPending: true, isUsedLockRejectAfter: 2 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new MigrationRunner(db, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    // The PRIMARY error (from the pending migration body) must still surface —
    // a rejecting lock-held check in the cleanup guard must not mask it or
    // replace it with its own error.
    await expect(runner.run()).rejects.toThrow(/boom: pending migration failed/);

    expect(trace).toEqual(['scaffold-apply', 'pending']);
    expect(trace).not.toContain('scaffold-drop');
    expect(dropCalls).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lock.isHeld() failed'));

    warnSpy.mockRestore();
  });

  it('swallows a dropDefinerObjects failure on a SUCCESSFUL phase (cleanup failure does not turn success into failure)', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    dropShouldThrow = true;
    const db = makeFakeDb();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new MigrationRunner(db, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    const result = await runner.run();

    // The successful phase result is returned even though cleanup failed.
    expect(result).toEqual({ seeded: 0, reconciled: 0, applied: 1, pendingRemaining: 0 });
    // The drop WAS attempted (unlike the lock-lost tests above) — it just failed.
    expect(trace).toEqual(['scaffold-apply', 'pending', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropDefinerObjects'));

    warnSpy.mockRestore();
  });

  it('swallows a dropDefinerObjects failure on a FAILING phase (cleanup failure does not mask the primary error)', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    dropShouldThrow = true;
    const db = makeFakeDb({ throwOnPending: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new MigrationRunner(db, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    // The PRIMARY error (pending migration body) must still propagate — the
    // cleanup's own failure must not replace or mask it.
    await expect(runner.run()).rejects.toThrow(/boom: pending migration failed/);

    expect(trace).toEqual(['scaffold-apply', 'pending', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropDefinerObjects'));

    warnSpy.mockRestore();
  });

  it('skips scaffolding entirely when constructed without scaffolding config (existing 4-arg callers unaffected)', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    const db = makeFakeDb();
    // 4-arg constructor — no 5th scaffolding param at all.
    const runner = new MigrationRunner(db, dir, 'test-runner');

    const result = await runner.run();

    expect(trace).toEqual(['pending']);
    expect(trace).not.toContain('scaffold-apply');
    expect(trace).not.toContain('scaffold-drop');
    expect(dropCalls).toEqual([]);
    expect(result.applied).toBe(1);
  });
});
