import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, preflight, type Db } from '../../src/migrate/db.js';
import { SchemaMigrationsRepo } from '../../src/migrate/schema-migrations-repo.js';
import * as lock from '../../src/migrate/migration-lock.js';

const HAVE_DB = !!process.env.MYSQL_TEST_HOST;
const cfg = {
  host: process.env.MYSQL_TEST_HOST!,
  port: Number(process.env.MYSQL_TEST_PORT ?? 33306),
  database: process.env.MYSQL_TEST_DB ?? 'zincdb',
  user: process.env.MYSQL_TEST_USER ?? 'root',
  password: process.env.MYSQL_TEST_PASSWORD ?? 'root',
  ssl: false,
};

describe.skipIf(!HAVE_DB)('repo + lock', () => {
  let db: Db;

  beforeAll(async () => {
    db = await openDb(cfg);
  });

  afterAll(async () => {
    await db.end();
  });

  it('openDb asserts live autocommit + captures a connection id', () => {
    expect(typeof db.connectionId).toBe('number');
    expect(db.connectionId).toBeGreaterThan(0);
  });

  it('ensureTable then claim→markSuccess flips success', async () => {
    const repo = new SchemaMigrationsRepo(db);
    await repo.ensureTable();

    // Clean up any leftover from a previous failed run
    await db.query('DELETE FROM schema_migrations WHERE version = ?', ['zzz_test_001']);

    await repo.claim('zzz_test_001', 'deadbeef', 'tester');
    let row = (await repo.all()).find((r) => r.version === 'zzz_test_001')!;
    expect(row).toBeDefined();
    expect(row.success).toBe(false); // Number(TINYINT) normalization

    await repo.markSuccess('zzz_test_001', 12);
    row = (await repo.all()).find((r) => r.version === 'zzz_test_001')!;
    expect(row.success).toBe(true); // Number(TINYINT) normalization

    // Cleanup
    await db.query('DELETE FROM schema_migrations WHERE version = ?', ['zzz_test_001']);
  });

  it('acquire → isHeld true → release true → isHeld false', async () => {
    await lock.acquire(db);
    expect(await lock.isHeld(db)).toBe(true);
    expect(await lock.release(db)).toBe(true);
    expect(await lock.isHeld(db)).toBe(false);
  });

  // preflight tests — ported from ConnectionFactory.preflight (Kotlin)

  it('preflight(db, false) resolves — version-only check, no read-only gate', async () => {
    // status mode: skips @@read_only check; e2e MySQL is 8.4 so version gate passes.
    await expect(preflight(db, false)).resolves.toBeUndefined();
  });

  it('preflight(db, true) resolves — e2e MySQL is a writable primary (@@read_only=0)', async () => {
    // migrate mode: adds @@read_only check; Docker e2e MySQL is not a replica.
    await expect(preflight(db, true)).resolves.toBeUndefined();
  });

  it('preflight rejects a version string below 8 (unit-level parse check)', async () => {
    // Construct a minimal fake Db that returns a 5.7-style VERSION() without a real server.
    const fakeDb: Db = {
      connectionId: 0,
      query: async (sql: string) => {
        if (sql.includes('VERSION()')) return [{ v: '5.7.44' }];
        if (sql.includes('@@read_only')) return [{ ro: 0 }];
        return [];
      },
      execute: async () => [[], []],
      end: async () => {},
    };
    await expect(preflight(fakeDb, false)).rejects.toThrow('MySQL 8+ required');
  });

  it('preflight rejects when @@read_only = 1 (unit-level fake-Db check)', async () => {
    // Simulate a read-only replica without spinning up a second server.
    const fakeReadOnly: Db = {
      connectionId: 0,
      query: async (sql: string) => {
        if (sql.includes('VERSION()')) return [{ v: '8.4.0' }];
        if (sql.includes('@@read_only')) return [{ ro: 1 }];
        return [];
      },
      execute: async () => [[], []],
      end: async () => {},
    };
    await expect(preflight(fakeReadOnly, true)).rejects.toThrow(
      'Target is read-only (not the write primary). Refusing to migrate.',
    );
  });
});
