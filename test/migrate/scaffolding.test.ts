import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readScaffoldingSql } from '../../src/migrate/scaffolding.js';

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
