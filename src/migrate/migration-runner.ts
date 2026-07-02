import { readFileSync, existsSync } from 'node:fs';
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
 *    Kotlin parity) → acquire → seedIfVirgin → plan → reconcile → pending → release.
 *
 * `zn_*` helper procedures (0000_ files) are NOT created by this engine — see the
 * doc comment on run() for details.
 */
export class MigrationRunner {
  private repo: SchemaMigrationsRepo;

  /**
   * @param db             The DB handle.
   * @param migrationsDir  The CURRENT phase's migrations directory — the one whose
   *                       files are classified and applied.
   * @param appliedBy      The applied-by identity recorded on each row.
   * @param integrityDirs  Additional directories that share this DB's
   *                       schema_migrations history (the OTHER migration phase's dir,
   *                       e.g. the pre/ dir when this runner is running post/). Used
   *                       only to widen the orphan/checksum integrity lookup so a row
   *                       applied by a sibling phase is not mistaken for a
   *                       renamed/deleted file. Defaults to none (single-dir configs).
   */
  constructor(
    private readonly db: Db,
    private readonly migrationsDir: string,
    private readonly appliedBy: string,
    private readonly integrityDirs: string[] = [],
  ) {
    this.repo = new SchemaMigrationsRepo(db);
  }

  /**
   * Build the union of migration files across this phase's dir and any sibling
   * integrity dirs (pre ∪ post), for the planner's integrity lookup. Missing dirs
   * are skipped defensively (discover() throws on a non-existent path). If two dirs
   * ever declare the same version prefix, the current phase's file wins the lookup.
   */
  private allTrackedFiles(phaseFiles: ReturnType<typeof discover>): ReturnType<typeof discover> {
    const byVersion = new Map(phaseFiles.map((f) => [f.version, f]));
    for (const dir of this.integrityDirs) {
      if (dir === this.migrationsDir || !existsSync(dir)) continue;
      for (const f of discover(dir)) {
        if (!byVersion.has(f.version)) byVersion.set(f.version, f);
      }
    }
    return [...byVersion.values()];
  }

  /**
   * Read-only status: how many migrations are in each state.
   * Does NOT acquire the lock or apply any helpers.
   * Mirrors MigrateMain: preflight(requireWritePrimary=false) for 'status'.
   */
  async status(): Promise<{ applied: number; reconcile: number; pending: number }> {
    await preflight(this.db, false); // version-check only; skip read-only check
    await this.repo.ensureTable();
    const phaseFiles = discover(this.migrationsDir);
    const p = plan(phaseFiles, await this.repo.all(), canonicalChecksumFile, this.allTrackedFiles(phaseFiles));
    return { applied: p.applied.length, reconcile: p.reconcile.length, pending: p.pending.length };
  }

  /**
   * Apply all pending and reconcile migrations.
   *
   * Order (load-bearing — matches Kotlin MigrationRunner.run() exactly):
   *  1. preflight(requireWritePrimary=true) — refuse read-only replicas.
   *  2. ensureTable() BEFORE the lock (the only pre-lock mutation, per Kotlin parity).
   *  3. acquire(db) — GET_LOCK.
   *  4. seedBaselineIfVirgin — seed baselined rows when schema_migrations is empty.
   *  5. plan() — classify remaining files.
   *  6. reconcile — asserts-first; re-run body only when unmet or no asserts.
   *  7. pending — claim(success=0) → exec → markSuccess(success=1).
   *  8. finally: release lock; if release was not clean and no primary error, throw tripwire.
   *
   * The `zn_*` helper procedures (0000_ files) are NO LONGER created here. They are
   * now provisioned ahead of the migration phase by vault's routines-apply step,
   * owned by a persistent routines DB account — see the vault-side dynsec-routines-
   * provisioning feature (docs/superpowers/specs/2026-07-01-dynsec-routines-
   * provisioning-design.md). Root cause: DROP+CREATE'ing them here made the
   * ephemeral migrate user their DEFINER, and MySQL 8.4 refuses `DROP USER` for an
   * account referenced as a stored-routine DEFINER (ER 4006) — which broke lease
   * revocation on every migration run. Migrations now only `CALL zn_*`; they never
   * (re)create the procedures themselves.
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

      // NOTE: 0000_ helper files are discovered above (discover() does not filter
      // them out) but are intentionally never applied here — plan() excludes them
      // from all buckets (migration-planner.ts) and seedBaselineIfVirgin() skips
      // them too, so they are inert as far as this engine is concerned. See the
      // class doc comment on run() for why per-run creation was removed.

      // Step 4: Seed baseline rows for a virgin DB (schema_migrations is empty).
      const seeded = await this.seedBaselineIfVirgin(files);

      // Step 5: Plan. Integrity lookup spans this dir ∪ the sibling phase dir(s)
      // (they share one schema_migrations table); classification stays scoped to
      // `files` (this phase only ever applies its own directory).
      const p = plan(files, await this.repo.all(), canonicalChecksumFile, this.allTrackedFiles(files));

      // Step 6: Reconcile — asserts-first; re-run body only when asserts are absent
      // or one failed (indicating the migration was only partially applied).
      let reconciled = 0;
      for (const f of p.reconcile) {
        await this.requireLockHeld();
        await this.reconcile(f.path);
        reconciled++;
      }

      // Step 7: Pending — claim(success=0) → execute body → markSuccess(success=1).
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
