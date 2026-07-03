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

function fakeDb(rowsByTable: Record<string, any[]>) {
  const executed: string[] = [];
  return {
    executed,
    async query(sql: string, _params?: unknown[]) {
      if (/information_schema\.ROUTINES/i.test(sql)) return [rowsByTable.ROUTINES ?? [], null] as [unknown[], unknown];
      if (/information_schema\.TRIGGERS/i.test(sql)) return [rowsByTable.TRIGGERS ?? [], null] as [unknown[], unknown];
      if (/information_schema\.EVENTS/i.test(sql)) return [rowsByTable.EVENTS ?? [], null] as [unknown[], unknown];
      executed.push(sql);
      return [[], null] as [unknown[], unknown];
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
        if (/information_schema\.ROUTINES/i.test(sql)) { boundParam = params?.[0]; return [[], null] as [unknown[], unknown]; }
        return [[], null] as [unknown[], unknown];
      },
    };
    await dropDefinerObjects(db, 'v_migrate_abc123');
    expect(boundParam).toBe('v_migrate_abc123@%');
  });

  it('is a no-op (drops 0) when the user owns nothing', async () => {
    const db = fakeDb({});
    expect(await dropDefinerObjects(db, 'v_migrate_none')).toBe(0);
  });
});
