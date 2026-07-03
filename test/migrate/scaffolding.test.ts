import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readScaffoldingSql, dropDefinerObjects } from '../../src/migrate/scaffolding.js';

const SQL = [
  'DROP PROCEDURE IF EXISTS zn_x;',
  'DELIMITER //',
  'CREATE PROCEDURE zn_x() SQL SECURITY INVOKER BEGIN SELECT 1; END //',
  'DELIMITER ;',
].join('\n');

function tmpDirWith(name: string, sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
  writeFileSync(join(dir, name), sql);
  return dir;
}

describe('readScaffoldingSql', () => {
  it('reads and splits the named file into statements', () => {
    const dir = tmpDirWith('migration_utils.sql', SQL);
    const { path, statements } = readScaffoldingSql(dir, 'migration_utils.sql');
    expect(path).toBe(join(dir, 'migration_utils.sql'));
    // DROP + CREATE (the DELIMITER lines are directives, not emitted statements)
    expect(statements.some((s) => /DROP PROCEDURE IF EXISTS zn_x/.test(s))).toBe(true);
    expect(statements.some((s) => /CREATE PROCEDURE zn_x/.test(s))).toBe(true);
  });

  it('throws a clear error when the file is missing', () => {
    const dir = tmpDirWith('present.sql', SQL);
    expect(() => readScaffoldingSql(dir, 'absent.sql')).toThrow(/scaffolding file.*absent\.sql/i);
  });
});

// IMPORTANT: the real `Db.query` (src/migrate/db.ts) returns the result ROWS
// DIRECTLY — it already unwraps the raw mysql2 [rows, fields] tuple internally
// (see db.ts's `query: async (...) => { const [rows] = await conn.query(...); return rows; }`).
// This fake MUST mirror that exact shape. A fake that instead returns the tuple
// `[rows, null]` matches the OLD, WRONG `DefinerCleanupDb` interface and would
// hide the ER-4006 production bug where `dropDefinerObjects` silently dropped
// nothing (see the contract-pinning test below for a regression guard).
function fakeDb(rowsByTable: Record<string, any[]>) {
  const executed: string[] = [];
  return {
    executed,
    async query(sql: string, _params?: unknown[]) {
      if (/information_schema\.ROUTINES/i.test(sql)) return rowsByTable.ROUTINES ?? [];
      if (/information_schema\.TRIGGERS/i.test(sql)) return rowsByTable.TRIGGERS ?? [];
      if (/information_schema\.EVENTS/i.test(sql)) return rowsByTable.EVENTS ?? [];
      executed.push(sql);
      return [];
    },
  };
}

describe('dropDefinerObjects', () => {
  it('drops procedures, functions, triggers, and events owned by the lease user', async () => {
    const db = fakeDb({
      ROUTINES: [
        { ROUTINE_SCHEMA: 'zincdb', ROUTINE_NAME: 'zn_p', ROUTINE_TYPE: 'PROCEDURE' },
        { ROUTINE_SCHEMA: 'zincdb', ROUTINE_NAME: 'zn_f', ROUTINE_TYPE: 'FUNCTION' },
      ],
      TRIGGERS: [{ TRIGGER_SCHEMA: 'zincdb', TRIGGER_NAME: 'zn_trg' }],
      EVENTS: [{ EVENT_SCHEMA: 'zincdb', EVENT_NAME: 'zn_evt' }],
    });
    const n = await dropDefinerObjects(db, 'v_migrate_abc123');
    expect(n).toBe(4);
    expect(db.executed).toContain('DROP PROCEDURE IF EXISTS `zincdb`.`zn_p`');
    expect(db.executed).toContain('DROP FUNCTION IF EXISTS `zincdb`.`zn_f`');
    expect(db.executed).toContain('DROP TRIGGER IF EXISTS `zincdb`.`zn_trg`');
    expect(db.executed).toContain('DROP EVENT IF EXISTS `zincdb`.`zn_evt`');
  });

  it('binds the DEFINER filter host-inclusive as <user>@%', async () => {
    let boundParam: unknown;
    const db = {
      executed: [] as string[],
      async query(sql: string, params?: unknown[]) {
        if (/information_schema\.ROUTINES/i.test(sql)) { boundParam = params?.[0]; return []; }
        return [];
      },
    };
    await dropDefinerObjects(db, 'v_migrate_abc123');
    expect(boundParam).toBe('v_migrate_abc123@%');
  });

  it('is a no-op (drops 0) when the user owns nothing', async () => {
    const db = fakeDb({});
    expect(await dropDefinerObjects(db, 'v_migrate_none')).toBe(0);
  });

  // CONTRACT-PINNING REGRESSION TEST (ER-4006 fix):
  // Constructs a fake whose `query` mirrors the REAL `Db.query` shape (rows array
  // returned directly — see src/migrate/db.ts) as literally as possible, including
  // routing through the same tuple-unwrap step the real implementation performs
  // internally, so this test would FAIL if `dropDefinerObjects` ever regressed to
  // `const [rows] = await db.query(...)` (that destructure would bind `rows` to a
  // single row object instead of the array, the for-of loops would iterate nothing
  // useful, and the assertions below on count/executed statements would break).
  it('[contract] reads rows from a Db.query fake shaped exactly like the real db.ts implementation', async () => {
    // Mirrors db.ts's real `query` closure: an inner mysql2-shaped tuple source,
    // unwrapped via `const [rows] = await inner(...)` before returning — i.e. the
    // CORRECT unwrap, performed once, inside the fake `Db`, exactly as production does.
    const mysql2Tuple = (sql: string): [unknown[], unknown] => {
      if (/information_schema\.ROUTINES/i.test(sql)) {
        return [
          [
            { ROUTINE_SCHEMA: 'zincdb', ROUTINE_NAME: 'zn_p', ROUTINE_TYPE: 'PROCEDURE' },
            { ROUTINE_SCHEMA: 'zincdb', ROUTINE_NAME: 'zn_f', ROUTINE_TYPE: 'FUNCTION' },
          ],
          null,
        ];
      }
      if (/information_schema\.TRIGGERS/i.test(sql)) {
        return [[{ TRIGGER_SCHEMA: 'zincdb', TRIGGER_NAME: 'zn_trg' }], null];
      }
      if (/information_schema\.EVENTS/i.test(sql)) {
        return [[{ EVENT_SCHEMA: 'zincdb', EVENT_NAME: 'zn_evt' }], null];
      }
      return [[], null];
    };

    const executed: string[] = [];
    const realShapedDb = {
      // Matches db.ts's `Db.query` signature AND behavior: unwraps the mysql2
      // tuple internally and returns rows directly (Promise<unknown[]>).
      async query(sql: string, _params?: unknown[]): Promise<unknown[]> {
        const [rows] = mysql2Tuple(sql);
        if (!/information_schema\./i.test(sql)) executed.push(sql);
        return rows;
      },
    };

    const n = await dropDefinerObjects(realShapedDb, 'v_migrate_abc123');

    expect(n).toBe(4);
    expect(executed).toContain('DROP PROCEDURE IF EXISTS `zincdb`.`zn_p`');
    expect(executed).toContain('DROP FUNCTION IF EXISTS `zincdb`.`zn_f`');
    expect(executed).toContain('DROP TRIGGER IF EXISTS `zincdb`.`zn_trg`');
    expect(executed).toContain('DROP EVENT IF EXISTS `zincdb`.`zn_evt`');
  });
});
