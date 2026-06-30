import { type Db } from './db.js';

export const LOCK_KEY = 'zincapp_migration';

export class MigrationLockBusyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'MigrationLockBusyError';
  }
}

export class MigrationLockError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'MigrationLockError';
  }
}

/**
 * Acquire the named session-scoped migration lock via GET_LOCK.
 *
 * GET_LOCK return values:
 *   1    → lock acquired successfully
 *   0    → timed out waiting (another session holds it) → throws MigrationLockBusyError
 *   NULL → error (OOM, connection error, etc.)          → throws MigrationLockError
 *
 * @param db             An open Db connection.
 * @param timeoutSeconds How long to wait for the lock (default 30s, matching Kotlin).
 */
export async function acquire(db: Db, timeoutSeconds = 30): Promise<void> {
  const rows = await db.query('SELECT GET_LOCK(?, ?)', [LOCK_KEY, timeoutSeconds]);
  // mysql2 returns the result column by its expression text; extract robustly
  const cell = Object.values(rows[0] as Record<string, unknown>)[0];
  if (cell === null || cell === undefined) {
    throw new MigrationLockError(`GET_LOCK returned NULL (connection/server error)`);
  }
  if (Number(cell) !== 1) {
    throw new MigrationLockBusyError(`Another migration runner holds '${LOCK_KEY}' (GET_LOCK returned 0)`);
  }
}

/**
 * Check whether THIS connection's session still holds the migration lock.
 *
 * Uses `IS_USED_LOCK(?) = ?` with the captured CONNECTION_ID so we verify
 * that the lock is held by THIS specific session — not just by any session.
 * A MySQL Router / wait_timeout eviction would silently drop the lock server-side
 * and this function would correctly return false even if the same code path
 * reconnected with a new session.
 *
 * @param db An open Db connection (must be the same connection that called acquire).
 */
export async function isHeld(db: Db): Promise<boolean> {
  const rows = await db.query('SELECT IS_USED_LOCK(?) = ? AS held', [LOCK_KEY, db.connectionId]);
  const cell = (rows[0] as Record<string, unknown>)['held'];
  if (cell === null || cell === undefined) {
    // NULL means no session holds the lock at all
    return false;
  }
  return Number(cell) === 1;
}

/**
 * Release the migration lock. NEVER throws — this is designed to run in a
 * finally block and must not mask any in-flight migration exception.
 *
 * @returns true if the lock was cleanly released; false if the lock was not
 *          held at release time (possible lost session or concurrent runner).
 */
export async function release(db: Db): Promise<boolean> {
  try {
    const rows = await db.query('SELECT RELEASE_LOCK(?) AS released', [LOCK_KEY]);
    const cell = (rows[0] as Record<string, unknown>)['released'];
    const released = cell !== null && cell !== undefined && Number(cell) === 1;
    if (!released) {
      console.warn(
        `RELEASE_LOCK('${LOCK_KEY}') returned ${String(cell)} — lock was not held at release (lost session / concurrent runner?)`,
      );
    }
    return released;
  } catch (e) {
    console.warn(
      `RELEASE_LOCK('${LOCK_KEY}') failed (connection likely dead): ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
