import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitStatements } from './sql-splitter.js';

/**
 * Read and split the scaffolding SQL file (migration-helper procedures/functions).
 * The file lives at <migrationsDir>/<filename> (filename is a bare name, validated
 * config-side). Returns the absolute path and the executable statements.
 */
export function readScaffoldingSql(
  migrationsDir: string,
  filename: string,
): { path: string; statements: string[] } {
  const path = join(migrationsDir, filename);
  if (!existsSync(path)) {
    throw new Error(`scaffolding file not found: ${filename} (looked in ${migrationsDir})`);
  }
  const sql = readFileSync(path, 'utf8');
  return { path, statements: splitStatements(sql) };
}
