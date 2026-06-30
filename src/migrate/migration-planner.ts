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

/**
 * Build a migration plan by comparing discovered files against tracked DB rows.
 *
 * Ports MigrationPlanner.kt exactly:
 *  - 0000_ helpers are skipped (applied unconditionally by the runner before planning).
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
  const byVersion = new Map(rows.map((r) => [r.version, r]));

  const applied: MigrationFile[] = [];
  const reconcile: MigrationFile[] = [];
  const pending: MigrationFile[] = [];

  for (const f of files) {
    // 0000_ helpers are re-applied every run and are never tracked/planned.
    if (f.version.startsWith('0000_')) continue;

    const row = byVersion.get(f.version);
    if (!row) {
      pending.push(f);
      continue;
    }

    // Immutability check — the stored checksum is the source of truth for
    // files that have already been applied. A mismatch means the file was
    // edited after application, which is never allowed.
    if (checksumOf(f.path) !== row.checksum) {
      throw new ChecksumMismatchError(row.version);
    }

    if (row.success || row.baselined) {
      applied.push(f);
    } else {
      reconcile.push(f);
    }
  }

  return { applied, reconcile, pending };
}
