import type { MigrationFile } from './migration-files.js';
import type { MigrationRow } from './schema-migrations-repo.js';
import { canonicalChecksumFile } from './checksum.js';

export interface MigrationPlan {
  applied: MigrationFile[];
  reconcile: MigrationFile[];
  pending: MigrationFile[];
}

export class ChecksumMismatchError extends Error {
  constructor(version: string) {
    super(
      `Checksum mismatch for already-applied migration '${version}' (immutable history)`,
    );
    this.name = 'ChecksumMismatchError';
  }
}

export class OrphanTrackedRowError extends Error {
  constructor(version: string) {
    super(
      `Tracked migration '${version}' has no file on disk (renamed/deleted?). Refusing to proceed.`,
    );
    this.name = 'OrphanTrackedRowError';
  }
}

/**
 * Build a migration plan by comparing discovered files against tracked DB rows.
 *
 * Ports MigrationPlanner.kt exactly:
 *  - 0000_ helpers are skipped (applied unconditionally by the runner before planning).
 *  - For each tracked row: if no matching file exists on disk → throw OrphanTrackedRowError
 *    (migration history is immutable — a renamed/deleted file is a fatal integrity violation).
 *  - For each tracked row: if the file's checksum differs from the stored checksum → throw
 *    ChecksumMismatchError (migration history is immutable).
 *  - File without a row → pending.
 *  - Row with success=1 or baselined=1 → applied.
 *  - Row with success=0 and baselined=0 → reconcile (crashed mid-run).
 *
 * @param files       Migration files for the CURRENT phase's directory (from
 *                    discover()) — the set that gets classified into apply/reconcile/
 *                    pending buckets.
 * @param rows        All rows from schema_migrations (from repo.all()).
 * @param checksumOf  Checksum function — injectable for unit tests (defaults to canonicalChecksumFile).
 * @param allTrackedFiles  The UNION of every migration directory that shares this
 *                    schema_migrations table (pre ∪ post). Used ONLY for the
 *                    orphan/checksum integrity lookup, so a row applied in a sibling
 *                    phase's directory is not mistaken for a renamed/deleted file.
 *                    Defaults to `files` (single-directory configs are byte-identical
 *                    to the pre-split behavior). Classification still uses `files`
 *                    alone — the current phase only ever applies its own directory.
 */
export function plan(
  files: MigrationFile[],
  rows: MigrationRow[],
  checksumOf: (path: string) => string = canonicalChecksumFile,
  allTrackedFiles: MigrationFile[] = files,
): MigrationPlan {
  // Integrity lookup spans the UNION of all phase dirs that share the history table.
  // A shared schema_migrations table (pre/ then post/ against one DB) means the
  // post phase legitimately sees rows for pre/ migrations whose files live in the
  // sibling directory — those must NOT be flagged as orphans.
  const integrityByVersion = new Map(
    allTrackedFiles.filter((f) => !f.version.startsWith('0000_')).map((f) => [f.version, f]),
  );

  // Integrity pass (matches Kotlin MigrationPlanner.plan exactly, now union-scoped):
  // Iterate every tracked row (non-0000_); throw on the first orphan or mismatch.
  // This runs BEFORE bucket classification so no partially-classified plan is returned.
  for (const row of rows) {
    if (row.version.startsWith('0000_')) continue; // helpers are never tracked
    const f = integrityByVersion.get(row.version);
    if (!f) {
      throw new OrphanTrackedRowError(row.version);
    }
    if (checksumOf(f.path) !== row.checksum) {
      throw new ChecksumMismatchError(row.version);
    }
  }

  // Bucket classification — now safe: all tracked rows have a matching file.
  const rowByVersion = new Map(rows.map((r) => [r.version, r]));
  const applied: MigrationFile[] = [];
  const reconcile: MigrationFile[] = [];
  const pending: MigrationFile[] = [];

  for (const f of files) {
    // 0000_ helpers are re-applied every run and are never tracked/planned.
    if (f.version.startsWith('0000_')) continue;

    const row = rowByVersion.get(f.version);
    if (!row) {
      pending.push(f);
    } else if (row.success || row.baselined) {
      applied.push(f);
    } else {
      reconcile.push(f);
    }
  }

  return { applied, reconcile, pending };
}
