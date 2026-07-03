/**
 * Unit tests for the scaffolding bracket in MigrationRunner.run().
 *
 * Binding contract under test (see .superpowers/sdd/task-5-brief.md):
 *  1. Order: scaffold-apply → reconcile → pending → scaffold-drop.
 *  2. Unconditional cleanup: scaffold-drop still runs even when a pending
 *     migration throws (the phase fails, but the drop must not be skipped).
 *  3. No-op: constructing the runner WITHOUT a scaffolding config performs
 *     zero apply/drop calls — existing (4-arg) callers are byte-identical.
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

vi.mock('../../src/migrate/scaffolding.js', () => ({
  readScaffoldingSql: (_dir: string, filename: string) => ({
    path: `/x/${filename}`,
    statements: [`SELECT 'scaffold ${filename}'`],
  }),
  dropDefinerObjects: async (_db: unknown, leaseUser: string) => {
    trace.push('scaffold-drop');
    dropCalls.push(leaseUser);
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
 */
function makeFakeDb(opts: { throwOnPending?: boolean } = {}): Db {
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
      if (/^SELECT IS_USED_LOCK/.test(sql)) return [{ held: 1 }];
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
