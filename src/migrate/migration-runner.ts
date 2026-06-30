import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.js';
import { preflight } from './db.js';
import { SchemaMigrationsRepo } from './schema-migrations-repo.js';
import { discover } from './migration-files.js';
import { readBaselineMarker } from './baseline-marker.js';
import { canonicalChecksumFile } from './checksum.js';
import { splitStatements } from './sql-splitter.js';
import { plan } from './migration-planner.js';
import * as lock from './migration-lock.js';

export interface RunResult {
  seeded: number;
  reconciled: number;
  applied: number;
  pendingRemaining: number;
}

/**
 * Orchestrates migration discovery, planning, locking, and execution.
 *
 * Ports MigrationRunner.kt + MigrateMain.kt orchestration EXACTLY:
 *  - status(): read-only — ensureTable + plan; preflight(version-check only).
 *  - run(): write path — preflight(requireWritePrimary=true) → ensureTable (before lock,
 *    Kotlin parity) → acquire → helpers every run → seedIfVirgin → plan → reconcile →
 *    pending → release.
 */
export class MigrationRunner {
  private repo: SchemaMigrationsRepo;

  constructor(
    private readonly db: Db,
    private readonly migrationsDir: string,
    private readonly appliedBy: string,
  ) {
    this.repo = new SchemaMigrationsRepo(db);
  }

  /**
   * Read-only status: how many migrations are in each state.
   * Does NOT acquire the lock or apply any helpers.
   * Mirrors MigrateMain: preflight(requireWritePrimary=false) for 'status'.
   */
  async status(): Promise<{ applied: number; reconcile: number; pending: number }> {
    await preflight(this.db, false); // version-check only; skip read-only check
    await this.repo.ensureTable();
    const p = plan(discover(this.migrationsDir), await this.repo.all());
    return { applied: p.applied.length, reconcile: p.reconcile.length, pending: p.pending.length };
  }

  /**
   * Apply all pending and reconcile migrations.
   *
   * Order (load-bearing — matches Kotlin MigrationRunner.run() exactly):
   *  1. preflight(requireWritePrimary=true) — refuse read-only replicas.
   *  2. ensureTable() BEFORE the lock (the only pre-lock mutation, per Kotlin parity).
   *  3. acquire(db) — GET_LOCK.
   *  4. Apply ALL 0000_ helper files unconditionally on EVERY run (DROP-then-CREATE =
   *     idempotent). These must exist before any migration CALLs them and before
   *     reconcile runs a trailing postcondition. requireLockHeld() per file.
   *  5. seedBaselineIfVirgin — seed baselined rows when schema_migrations is empty.
   *  6. plan() — classify remaining files.
   *  7. reconcile — asserts-first; re-run body only when unmet or no asserts.
   *  8. pending — claim(success=0) → exec → markSuccess(success=1).
   *  9. finally: release lock; if release was not clean and no primary error, throw tripwire.
   */
  async run(): Promise<RunResult> {
    await preflight(this.db, true); // refuse read-only replica

    // ensureTable BEFORE the lock — the CREATE TABLE IF NOT EXISTS is the sole
    // pre-lock mutation. This matches Kotlin to allow a fresh DB to get the table
    // without contention risk (only one runner is expected in normal operation).
    await this.repo.ensureTable();

    await lock.acquire(this.db);
    let primary: unknown = null;
    try {
      const files = discover(this.migrationsDir);

      // Step 4: Apply ALL 0000_ helper files unconditionally on EVERY run.
      // These contain DROP-then-CREATE procedure bodies that must be refreshed even
      // when nothing is pending — a stale body from a prior version would break
      // zn_assert_* postcondition logic.
      for (const f of files.filter((x) => x.version.startsWith('0000_'))) {
        await this.requireLockHeld();
        await this.executeStatements(f.path);
      }

      // Step 5: Seed baseline rows for a virgin DB (schema_migrations is empty).
      const seeded = await this.seedBaselineIfVirgin(files);

      // Step 6: Plan.
      const p = plan(files, await this.repo.all());

      // Step 7: Reconcile — asserts-first; re-run body only when asserts are absent
      // or one failed (indicating the migration was only partially applied).
      let reconciled = 0;
      for (const f of p.reconcile) {
        await this.requireLockHeld();
        await this.reconcile(f.path);
        reconciled++;
      }

      // Step 8: Pending — claim(success=0) → execute body → markSuccess(success=1).
      // A throw in executeStatements leaves the row at success=0 for later reconcile.
      let applied = 0;
      for (const f of p.pending) {
        await this.requireLockHeld();
        const checksum = canonicalChecksumFile(f.path);
        await this.repo.claim(f.version, checksum, this.appliedBy); // autocommit → durable
        const start = Date.now();
        await this.executeStatements(f.path); // throws → row stays success=0
        await this.requireLockHeld();
        await this.repo.markSuccess(f.version, Date.now() - start);
        applied++;
      }

      return { seeded, reconciled, applied, pendingRemaining: 0 };
    } catch (e) {
      primary = e;
      throw e;
    } finally {
      // release() never throws — it must not mask the primary error.
      // A non-clean release is the lost-lock tripwire: surface it only when
      // there is no primary error to preserve.
      const released = await lock.release(this.db);
      if (!released && primary === null) {
        // eslint-disable-next-line no-unsafe-finally
        throw new Error(
          'Lock was not held at release — a concurrent runner may have run. Re-run status and verify schema_migrations.',
        );
      }
    }
  }

  /**
   * Abort immediately if this session no longer holds the GET_LOCK.
   * A killed session or proxy reconnect would silently drop the lock server-side.
   */
  private async requireLockHeld(): Promise<void> {
    if (!(await lock.isHeld(this.db))) {
      throw new Error(
        'Lost the migration lock mid-run (session killed or reconnected). Aborting to avoid concurrent DDL.',
      );
    }
  }

  /**
   * Execute every SQL statement in a file (text protocol, one at a time).
   * A failed CALL zn_assert_* signals SIGNAL '45000', which propagates as an
   * Error and leaves any pending claim row at success=0.
   */
  private async executeStatements(path: string): Promise<void> {
    const sql = readFileSync(path, 'utf8');
    for (const stmt of splitStatements(sql)) {
      await this.db.query(stmt);
    }
  }

  /**
   * True when a statement is a postcondition assertion call (zn_assert_* proc).
   */
  private isPostcondition(stmt: string): boolean {
    return /^\s*CALL\s+zn_assert_/i.test(stmt);
  }

  /**
   * Seed baselined rows for a virgin DB (schema_migrations has no rows yet).
   *
   * Reads the BASELINE_MARKER from baseline/00-baseline-schema.sql and seeds
   * a baselined row for every non-0000_ file whose prefix <= the marker.
   * Returns the number of rows seeded.
   */
  private async seedBaselineIfVirgin(files: ReturnType<typeof discover>): Promise<number> {
    if ((await this.repo.all()).length > 0) return 0;
    const marker = readBaselineMarker(join(this.migrationsDir, 'baseline', '00-baseline-schema.sql'));
    if (!marker) return 0; // no baseline file (unit/throwaway DB) → nothing to seed
    let n = 0;
    for (const f of files) {
      if (f.version.startsWith('0000_')) continue; // helpers are never seeded
      if (f.prefix <= marker) {
        await this.repo.seedBaseline(f.version, canonicalChecksumFile(f.path), this.appliedBy);
        n++;
      }
    }
    return n;
  }

  /**
   * Reconcile a success=0 row per spec step 7a.
   *
   * Run the file's trailing CALL zn_assert_* postconditions FIRST:
   *  - If they exist and all pass → the migration is already fully applied;
   *    markSuccess WITHOUT re-running the body (avoids double-apply hazard for
   *    non-idempotent bodies).
   *  - If there are no asserts, OR any assert throws → re-run the ENTIRE
   *    (idempotent) body, then markSuccess.
   *
   * requireLockHeld() is called before markSuccess to detect session kills
   * during a long reconcile re-execution.
   */
  private async reconcile(path: string): Promise<void> {
    const stmts = splitStatements(readFileSync(path, 'utf8'));
    const asserts = stmts.filter((s) => this.isPostcondition(s));

    let satisfied = false;
    if (asserts.length > 0) {
      try {
        for (const a of asserts) {
          await this.db.query(a);
        }
        satisfied = true; // all asserts passed
      } catch {
        satisfied = false; // at least one assert failed → re-run body
      }
    }
    // satisfied = false also when asserts.length === 0 (no-asserts → always re-run)

    if (!satisfied) {
      // Re-run entire body — must be idempotent (spec requirement).
      // A genuinely failed CALL zn_assert_* will throw and propagate.
      for (const s of stmts) {
        await this.db.query(s);
      }
    }

    await this.requireLockHeld(); // guard: detect session kill during re-exec
    const version = path.split('/').pop()!;
    await this.repo.markSuccess(version, 0);
  }
}
