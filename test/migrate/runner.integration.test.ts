/**
 * Integration tests for MigrationRunner against a live MySQL instance.
 *
 * Requires: MYSQL_TEST_HOST env var (skipped when unset).
 * Uses: e2e MySQL at 127.0.0.1:33306, db=zincdb, user=root, password=root.
 *
 * The e2e DB should already have the real corpus applied (3 rows, success=1).
 * A fresh run() is expected to report applied=0/reconcile=0/pending=0.
 *
 * Test coverage:
 *  1. Full run against real corpus → seeded=0, reconciled=0, applied=0.
 *  2. Double-run idempotency → second run identical counts.
 *  3. No-asserts reconcile: a success=0 row for a temp migration with NO zn_assert_*
 *     calls causes the runner to re-run the body (satisfied=false with 0 asserts) and
 *     flip the row to success=1.
 *  3b. Reconcile with asserts: flip an existing corpus migration to success=0, run,
 *      confirm it reconciles back to success=1.
 *  4. No per-run helper provisioning → run() does not apply 0000_ files; the corpus
 *     migrations' `CALL zn_*` statements still succeed against helpers that were
 *     pre-provisioned out-of-band (vault's routines bundle in production; the e2e
 *     fixture DB for this test), proving the engine no longer needs to create them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/migrate/db.js';
import { MigrationRunner } from '../../src/migrate/migration-runner.js';
import { canonicalChecksumFile } from '../../src/migrate/checksum.js';
import { splitStatements } from '../../src/migrate/sql-splitter.js';

const HAVE_DB = !!process.env.MYSQL_TEST_HOST;
const cfg = {
  host: process.env.MYSQL_TEST_HOST!,
  port: Number(process.env.MYSQL_TEST_PORT ?? 33306),
  database: process.env.MYSQL_TEST_DB ?? 'zincdb',
  user: process.env.MYSQL_TEST_USER ?? 'root',
  password: process.env.MYSQL_TEST_PASSWORD ?? 'root',
  ssl: false,
};

const MIGRATIONS_DIR = '/Users/diegovidal/Drive/zincapi-parent/docs/migrations';

describe.skipIf(!HAVE_DB)('MigrationRunner integration', () => {
  let db: Db;
  let db2: Db; // second connection for double-run idempotency
  let runner: MigrationRunner;

  beforeAll(async () => {
    db = await openDb(cfg);
    runner = new MigrationRunner(db, MIGRATIONS_DIR, 'test-runner');
  });

  afterAll(async () => {
    await db.end();
    if (db2) await db2.end();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Full run against the real corpus
  // ──────────────────────────────────────────────────────────────────────────
  it('full run on already-migrated DB → 0 seeded, 0 reconciled, 0 applied', async () => {
    const result = await runner.run();

    // The e2e DB should already have all 3 migrations applied (success=1).
    // seedBaselineIfVirgin skips (rows.length > 0), reconcile/pending are empty.
    expect(result.seeded).toBe(0);
    expect(result.reconciled).toBe(0);
    expect(result.applied).toBe(0);
    expect(result.pendingRemaining).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Double-run idempotency
  // ──────────────────────────────────────────────────────────────────────────
  it('second run is idempotent → same zero counts', async () => {
    // Open a fresh connection to simulate a second CLI invocation.
    db2 = await openDb(cfg);
    const runner2 = new MigrationRunner(db2, MIGRATIONS_DIR, 'test-runner-2');
    const result = await runner2.run();

    expect(result.seeded).toBe(0);
    expect(result.reconciled).toBe(0);
    expect(result.applied).toBe(0);
    expect(result.pendingRemaining).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. No-asserts reconcile (the Codex-F4.2 correctness case)
  //    A success=0 row for a migration with ZERO CALL zn_assert_* postconditions
  //    must trigger a full body re-run (satisfied = asserts.length>0 && allPassed
  //    → with 0 asserts, satisfied=false → always re-run). We prove re-run by
  //    observing an idempotent side-effect written by the body.
  // ──────────────────────────────────────────────────────────────────────────
  it('no-asserts reconcile: body is re-run and row flipped to success=1', async () => {
    const migrationVersion = '2099-01-01_001_no-asserts-probe.sql';
    const migrationPath = join(MIGRATIONS_DIR, migrationVersion);

    // Migration body: idempotent probe table + REPLACE so re-run is observable.
    // No CALL zn_assert_* → satisfied=false → runner always re-runs body on reconcile.
    writeFileSync(
      migrationPath,
      [
        'CREATE TABLE IF NOT EXISTS _reconcile_probe (id INT PRIMARY KEY, marker VARCHAR(32)) ENGINE=InnoDB;',
        "REPLACE INTO _reconcile_probe VALUES (1, 'reran');",
      ].join('\n'),
    );

    // Compute the real checksum so the planner routes this row to reconcile (not pending).
    const checksum = canonicalChecksumFile(migrationPath);

    try {
      // Clean up any leftover rows/table from a prior failed run.
      await db.query('DELETE FROM schema_migrations WHERE version = ?', [migrationVersion]);
      await db.query('DROP TABLE IF EXISTS _reconcile_probe');

      // Insert a success=0 claim row with the correct checksum — simulates a crash mid-run.
      await db.query(
        'INSERT INTO schema_migrations (version, checksum, checksum_algo, applied_at, applied_by, execution_ms, success, baselined) VALUES (?, ?, ?, NOW(3), ?, 0, 0, 0)',
        [migrationVersion, checksum, 'sha256-lf-v1', 'test-no-asserts'],
      );

      const dbTemp = await openDb(cfg);
      try {
        const runnerTemp = new MigrationRunner(dbTemp, MIGRATIONS_DIR, 'test-no-asserts');
        const result = await runnerTemp.run();

        // The runner must have reconciled exactly 1 migration (the no-asserts one).
        expect(result.reconciled).toBe(1);
        expect(result.applied).toBe(0);
        expect(result.seeded).toBe(0);
      } finally {
        await dbTemp.end();
      }

      // Verify the row was flipped to success=1 (reconcile completed).
      const rowsAfter = (await db.query(
        'SELECT success FROM schema_migrations WHERE version = ?',
        [migrationVersion],
      )) as { success: unknown }[];
      expect(Number(rowsAfter[0]?.success)).toBe(1);

      // Verify the body actually RE-RAN: the probe table must have the marker row.
      // This is the observable proof that reconcile re-ran the body (not just flipped success).
      const probe = (await db.query(
        "SELECT marker FROM _reconcile_probe WHERE id = 1",
      )) as { marker: string }[];
      expect(probe[0]?.marker).toBe('reran');
    } finally {
      // Always clean up the temp migration file and DB rows/table.
      try { unlinkSync(migrationPath); } catch { /* best-effort */ }
      await db.query('DELETE FROM schema_migrations WHERE version = ?', [migrationVersion]);
      await db.query('DROP TABLE IF EXISTS _reconcile_probe');
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3b. No-asserts reconcile via status() (verifies the reconcile bucket)
  //     Uses a real migration file (first one) with a fake success=0 row.
  // ──────────────────────────────────────────────────────────────────────────
  it('no-asserts reconcile: fake success=0 row for existing file is reconciled', async () => {
    // Use a real file that exists in the corpus (2026-06-30_001_...).
    // We'll temporarily reset its success to 0, then run, and confirm it's back to 1.
    const targetVersion = '2026-06-30_001_residual-historial-state-metadata.sql';

    try {
      // Flip success=0 to simulate a crash
      await db.query(
        'UPDATE schema_migrations SET success = 0 WHERE version = ?',
        [targetVersion],
      );

      const rowsBefore = (await db.query(
        'SELECT success FROM schema_migrations WHERE version = ?',
        [targetVersion],
      )) as { success: unknown }[];
      expect(Number(rowsBefore[0]?.success)).toBe(0);

      // Open a fresh connection for this run (prior db may still have lock state)
      const db3 = await openDb(cfg);
      try {
        const runner3 = new MigrationRunner(db3, MIGRATIONS_DIR, 'test-runner-3');
        const result = await runner3.run();

        // Should reconcile exactly 1 file (the one we flipped)
        expect(result.reconciled).toBe(1);
        expect(result.applied).toBe(0);
      } finally {
        await db3.end();
      }

      // Confirm the row is back to success=1
      const rowsAfter = (await db.query(
        'SELECT success FROM schema_migrations WHERE version = ?',
        [targetVersion],
      )) as { success: unknown }[];
      expect(Number(rowsAfter[0]?.success)).toBe(1);
    } finally {
      // Always restore the row to success=1 so other tests see a clean baseline,
      // even if an assertion above throws.
      await db.query(
        'UPDATE schema_migrations SET success = 1 WHERE version = ?',
        [targetVersion],
      );
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. run() no longer provisions the 0000_ helpers itself.
  //
  //    Helper procs are now provisioned out-of-band, before the migration phase,
  //    by vault's routines bundle (see docs/superpowers/specs/2026-07-01-dynsec-
  //    routines-provisioning-design.md) — owned by a persistent routines account,
  //    NOT the ephemeral migrate user. The engine must not DROP+CREATE them itself.
  //
  //    We prove this two ways:
  //      a) drop every zn_* proc first, run(), and confirm they are still absent
  //         (the runner did not recreate them) while `applied`/`reconciled` stay 0
  //         (nothing pending on the already-migrated DB).
  //      b) re-create the helpers out-of-band (mirroring the vault routines-apply
  //         step) and confirm a subsequent run() still succeeds — i.e. reconcile/
  //         pending migrations that CALL zn_* keep working against pre-provisioned
  //         helpers the engine itself never touched.
  // ──────────────────────────────────────────────────────────────────────────
  it('run() does not (re-)create the 0000_ helper procs', async () => {
    const helperFile = join(MIGRATIONS_DIR, '0000_migration-helpers.sql');
    const helperSql = readFileSync(helperFile, 'utf8');

    // Drop every zn_* proc so we can observe whether run() recreates any of them.
    const before = (await db.query(
      "SHOW PROCEDURE STATUS WHERE Db = ? AND (Name LIKE 'zn_assert_%' OR Name LIKE 'zn_add_%')",
      [cfg.database],
    )) as { Name: string }[];
    for (const p of before) {
      await db.query(`DROP PROCEDURE IF EXISTS \`${p.Name}\``);
    }

    try {
      const db4 = await openDb(cfg);
      try {
        const runner4 = new MigrationRunner(db4, MIGRATIONS_DIR, 'test-runner-4');
        const result = await runner4.run();
        expect(result.applied).toBe(0);
        expect(result.reconciled).toBe(0);
        expect(result.pending).toBeUndefined(); // not a field
        expect(result.pendingRemaining).toBe(0);
      } finally {
        await db4.end();
      }

      // The engine must NOT have recreated any zn_* proc.
      const procsAfterRun = (await db.query(
        "SHOW PROCEDURE STATUS WHERE Db = ? AND (Name LIKE 'zn_assert_%' OR Name LIKE 'zn_add_%')",
        [cfg.database],
      )) as { Name: string }[];
      expect(procsAfterRun.length).toBe(0);
    } finally {
      // Restore the helpers out-of-band (as vault's routines-apply would), so later
      // tests in this file (and other runs against this shared e2e DB) still see
      // working `CALL zn_*` postconditions.
      for (const stmt of splitStatements(helperSql)) {
        await db.query(stmt);
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4b. Migrations that CALL zn_* still work once helpers are pre-provisioned
  //     out-of-band — proving the engine's job is only to CALL them, never to
  //     create them.
  // ──────────────────────────────────────────────────────────────────────────
  it('a migration body calling zn_* succeeds against pre-provisioned helpers', async () => {
    const migrationVersion = '2099-01-02_001_calls-zn-helper-probe.sql';
    const migrationPath = join(MIGRATIONS_DIR, migrationVersion);

    // A minimal body that CALLs a real pre-provisioned helper (zn_assert_table is
    // part of the 0000_ bundle) as its trailing postcondition.
    writeFileSync(
      migrationPath,
      [
        'CREATE TABLE IF NOT EXISTS _call_helper_probe (id INT PRIMARY KEY) ENGINE=InnoDB;',
        "CALL zn_assert_table('_call_helper_probe');",
      ].join('\n'),
    );

    try {
      await db.query('DELETE FROM schema_migrations WHERE version = ?', [migrationVersion]);
      await db.query('DROP TABLE IF EXISTS _call_helper_probe');

      const dbTemp = await openDb(cfg);
      try {
        const runnerTemp = new MigrationRunner(dbTemp, MIGRATIONS_DIR, 'test-calls-helper');
        const result = await runnerTemp.run();

        // Pending: the new file has no row yet.
        expect(result.applied).toBe(1);
        expect(result.reconciled).toBe(0);
      } finally {
        await dbTemp.end();
      }

      const rows = (await db.query(
        'SELECT success FROM schema_migrations WHERE version = ?',
        [migrationVersion],
      )) as { success: unknown }[];
      expect(Number(rows[0]?.success)).toBe(1);
    } finally {
      try { unlinkSync(migrationPath); } catch { /* best-effort */ }
      await db.query('DELETE FROM schema_migrations WHERE version = ?', [migrationVersion]);
      await db.query('DROP TABLE IF EXISTS _call_helper_probe');
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. status() is read-only and returns correct counts
  // ──────────────────────────────────────────────────────────────────────────
  it('status() returns applied=3, reconcile=0, pending=0 on a fully-migrated DB', async () => {
    const status = await runner.status();
    expect(status.reconcile).toBe(0);
    expect(status.pending).toBe(0);
    // All 3 non-helper files should be applied
    expect(status.applied).toBe(3);
  });
});
