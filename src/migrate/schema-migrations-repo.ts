import { type Db } from './db.js';
import { CHECKSUM_ALGO } from './checksum.js';

export interface MigrationRow {
  version: string;
  checksum: string;
  checksumAlgo: string;
  success: boolean;
  baselined: boolean;
}

/**
 * Data-access layer for the schema_migrations table.
 *
 * Mirrors SchemaMigrationsRepo.kt exactly:
 *  - Same CREATE TABLE DDL (version PK, checksum CHAR(64), checksum_algo VARCHAR(16),
 *    applied_at DATETIME(3), applied_by VARCHAR(128), execution_ms INT, success TINYINT(1),
 *    baselined TINYINT(1), ENGINE=InnoDB, CHARSET=utf8mb4).
 *  - success and baselined are normalized via Number() so the comparison is robust
 *    regardless of whether mysql2 returns TINYINT(1) as a JS boolean or number.
 */
export class SchemaMigrationsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Create the schema_migrations table if it does not already exist.
   * Uses the text protocol (db.query) so the DDL executes in a single statement.
   */
  async ensureTable(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
          version       VARCHAR(255) NOT NULL,
          checksum      CHAR(64)     NOT NULL,
          checksum_algo VARCHAR(16)  NOT NULL,
          applied_at    DATETIME(3)  NOT NULL,
          applied_by    VARCHAR(128) NOT NULL,
          execution_ms  INT          NOT NULL DEFAULT 0,
          success       TINYINT(1)   NOT NULL DEFAULT 0,
          baselined     TINYINT(1)   NOT NULL DEFAULT 0,
          PRIMARY KEY (version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  /**
   * Return all migration rows ordered by version ascending.
   */
  async all(): Promise<MigrationRow[]> {
    const rows = await this.db.query(
      'SELECT version, checksum, checksum_algo, success, baselined FROM schema_migrations ORDER BY version',
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      version: r.version as string,
      checksum: r.checksum as string,
      checksumAlgo: r.checksum_algo as string,
      // mysql2 may return TINYINT(1) as boolean true/false or as 0/1 depending
      // on driver configuration and MySQL version — Number() normalizes both.
      success: Number(r.success) === 1,
      baselined: Number(r.baselined) === 1,
    }));
  }

  /**
   * Insert a claim row with success=0. Called before executing a migration so
   * that a crash mid-migration leaves a recoverable false-success marker.
   */
  async claim(version: string, checksum: string, appliedBy: string): Promise<void> {
    await this.db.execute(
      'INSERT INTO schema_migrations (version, checksum, checksum_algo, applied_at, applied_by, execution_ms, success, baselined) VALUES (?, ?, ?, NOW(3), ?, 0, 0, 0)',
      [version, checksum, CHECKSUM_ALGO, appliedBy],
    );
  }

  /**
   * Flip success=1 and record execution_ms after a migration completes successfully.
   * Throws if no row exists for the given version (defensive — claim() should always precede this).
   */
  async markSuccess(version: string, executionMs: number): Promise<void> {
    const [okPacket] = await this.db.execute(
      'UPDATE schema_migrations SET success = 1, execution_ms = ? WHERE version = ?',
      [executionMs, version],
    );
    // mysql2 returns OkPacket with affectedRows for UPDATE statements
    const affected = (okPacket as { affectedRows?: number })?.affectedRows ?? 0;
    if (affected === 0) {
      throw new Error(`no schema_migrations row for version ${version}`);
    }
  }

  /**
   * Insert a pre-applied (baselined) row with success=1, baselined=1.
   * Used when seeding the baseline marker for a fresh database.
   */
  async seedBaseline(version: string, checksum: string, appliedBy: string): Promise<void> {
    await this.db.execute(
      'INSERT INTO schema_migrations (version, checksum, checksum_algo, applied_at, applied_by, execution_ms, success, baselined) VALUES (?, ?, ?, NOW(3), ?, 0, 1, 1)',
      [version, checksum, CHECKSUM_ALGO, appliedBy],
    );
  }
}
