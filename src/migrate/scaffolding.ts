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

/**
 * Structurally compatible with the real `Db` from './db.js' (query returns the
 * result ROWS DIRECTLY, not the raw mysql2 [rows, fields] tuple — see db.ts's
 * `query` implementation, which already unwraps the tuple before returning).
 * Kept as its own narrow interface (rather than importing `Db`) so tests don't
 * need to fake `execute`/`end`/`connectionId`, but the shape MUST match `Db.query`
 * exactly or this cleanup silently drops nothing against production (see the
 * 2026-07 ER-4006 incident: a `[rows] = await db.query(...)` tuple-destructure
 * against this interface bound `rows` to the wrong thing and never dropped
 * anything).
 */
export interface DefinerCleanupDb {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
}

/** Backtick-quote a MySQL identifier (doubling embedded backticks). */
function q(ident: string): string {
  return '`' + ident.replace(/`/g, '``') + '`';
}

/**
 * Drop EVERY definer-carrying object (procedure, function, trigger, event) whose
 * DEFINER is `<leaseUser>@%`, across all schemas, using DROP ... IF EXISTS.
 *
 * This is the ER-4006 structural guarantee: run before DROP USER (or at phase end),
 * unconditionally. Once the user is the definer of nothing, DROP USER cannot fail
 * with MySQL 8.4 ER 4006, regardless of what the migration created. Scoped to the
 * lease user's OWN objects only (host-inclusive definer match), so it never touches
 * the persistent routines account's helpers or customer objects. Returns the count.
 *
 * CALLER INVARIANT (for the migration runner): this function is NOT transactional
 * across objects — DDL like DROP PROCEDURE/TRIGGER/EVENT cannot be wrapped in a
 * MySQL transaction anyway. If a DROP throws partway through the sweep (e.g. a
 * permissions error or a lock timeout on one object), the function aborts
 * immediately and some definer-owned objects may be LEFT UNDROPPED. The caller
 * MUST NOT proceed to DROP USER after a failed/partial sweep — doing so risks
 * the exact ER 4006 failure this cleanup exists to prevent. On a thrown error,
 * the caller should either retry the sweep (it is idempotent — DROP ... IF EXISTS)
 * or abort the whole revoke and surface the error, but never skip straight to
 * DROP USER.
 */
export async function dropDefinerObjects(db: DefinerCleanupDb, leaseUser: string): Promise<number> {
  const definer = `${leaseUser}@%`;
  let dropped = 0;

  // Routines: procedures AND functions (ROUTINE_TYPE distinguishes; DROP keyword differs).
  // NOTE: db.query() returns the rows array DIRECTLY (see DefinerCleanupDb doc comment
  // above) — do NOT destructure as a [rows, fields] tuple.
  const routineRows = (await db.query(
    'SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE DEFINER = ?',
    [definer],
  )) as { ROUTINE_SCHEMA: string; ROUTINE_NAME: string; ROUTINE_TYPE: string }[];
  for (const r of routineRows) {
    const kw = r.ROUTINE_TYPE === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
    await db.query(`DROP ${kw} IF EXISTS ${q(r.ROUTINE_SCHEMA)}.${q(r.ROUTINE_NAME)}`);
    dropped++;
  }

  // Triggers.
  const triggerRows = (await db.query(
    'SELECT TRIGGER_SCHEMA, TRIGGER_NAME FROM information_schema.TRIGGERS WHERE DEFINER = ?',
    [definer],
  )) as { TRIGGER_SCHEMA: string; TRIGGER_NAME: string }[];
  for (const t of triggerRows) {
    await db.query(`DROP TRIGGER IF EXISTS ${q(t.TRIGGER_SCHEMA)}.${q(t.TRIGGER_NAME)}`);
    dropped++;
  }

  // Events.
  const eventRows = (await db.query(
    'SELECT EVENT_SCHEMA, EVENT_NAME FROM information_schema.EVENTS WHERE DEFINER = ?',
    [definer],
  )) as { EVENT_SCHEMA: string; EVENT_NAME: string }[];
  for (const e of eventRows) {
    await db.query(`DROP EVENT IF EXISTS ${q(e.EVENT_SCHEMA)}.${q(e.EVENT_NAME)}`);
    dropped++;
  }

  return dropped;
}
