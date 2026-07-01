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
 * @param files       Discovered migration files (from discover()).
 * @param rows        All rows from schema_migrations (from repo.all()).
 * @param checksumOf  Checksum function — injectable for unit tests (defaults to canonicalChecksumFile).
 */
export function plan(
  files: MigrationFile[],
  rows: MigrationRow[],
  checksumOf: (path: string) => string = canonicalChecksumFile,
): MigrationPlan {
  // Build a version→file map for non-0000_ files only (helpers are never tracked).
  const filesByVersion = new Map(
    files.filter((f) => !f.version.startsWith('0000_')).map((f) => [f.version, f]),
  );

  // Integrity pass (matches Kotlin MigrationPlanner.plan exactly):
  // Iterate every tracked row (non-0000_); throw on the first orphan or mismatch.
  // This runs BEFORE bucket classification so no partially-classified plan is returned.
  for (const row of rows) {
    if (row.version.startsWith('0000_')) continue; // helpers are never tracked
    const f = filesByVersion.get(row.version);
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
