import mysql from 'mysql2/promise';

export interface Db {
  /** Run a query and return the result rows. Uses text protocol (query, not execute). */
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  /**
   * Parameterized execute (prepared statement). Returns the raw mysql2 result tuple
   * [OkPacket|RowDataPacket[], FieldPacket[]] so callers can access affectedRows for
   * DML statements as well as rows for SELECT statements.
   */
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  /** Close the connection. */
  end(): Promise<void>;
  /** The MySQL CONNECTION_ID() captured immediately after connecting. */
  connectionId: number;
}

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

/**
 * Open a single MySQL connection (NOT a pool — pools can silently reconnect
 * and would drop the session-scoped GET_LOCK).
 *
 * Security / integrity contracts:
 *  - Asserts that the LIVE session has @@autocommit = 1 (not just a config flag).
 *  - Captures CONNECTION_ID() and exposes it as db.connectionId so callers can
 *    verify lock ownership via IS_USED_LOCK.
 *  - Sets time_zone = '+00:00' so applied_at timestamps are UTC.
 *  - Redacts the password from any connection error before re-throwing.
 *  - multipleStatements: false to prevent SQL-injection via DDL concatenation.
 */
export async function openDb(cfg: DbConfig): Promise<Db> {
  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      ssl: cfg.ssl ? {} : undefined,
      multipleStatements: false,
      // connector-j 9.x note: on the SSL-disabled path (dev/e2e) allowPublicKeyRetrieval
      // is needed for caching_sha2_password auth. The mysql2 driver handles this
      // transparently when ssl is not set.
      supportBigNumbers: true,
      bigNumberStrings: false, // BIGINT execution_ms comes back as JS number
      timezone: 'Z',
    });
  } catch (e) {
    throw redact(e);
  }

  try {
    // 1. Assert LIVE autocommit — a config flag is NOT sufficient; a MySQL Router
    //    or session carryover could leave it 0.
    const [acRows] = (await conn.query('SELECT @@autocommit AS ac')) as [{ ac: unknown }[], unknown];
    const acValue = (acRows as { ac: unknown }[])[0]?.ac;
    if (Number(acValue) !== 1) {
      throw new Error('Target session does not have autocommit=1 — refusing to open a migration connection');
    }

    // 2. Set time_zone so TS-written applied_at values match the convention.
    await conn.query("SET time_zone = '+00:00'");

    // 3. Capture CONNECTION_ID immediately; expose it for lock ownership checks.
    const [cidRows] = (await conn.query('SELECT CONNECTION_ID() AS id')) as [{ id: unknown }[], unknown];
    const connectionId = Number((cidRows as { id: unknown }[])[0]?.id);

    const db: Db = {
      connectionId,
      // Text protocol — required for the migration DDL path (multipleStatements guard above).
      query: async (sql: string, params?: unknown[]): Promise<unknown[]> => {
        const [rows] = await conn.query(sql, params);
        return rows as unknown[];
      },
      // Prepared statement path — used for parameterized metadata queries in repo.
      // Returns raw tuple [OkPacket|rows, fields] so callers can inspect affectedRows
      // for DML statements (UPDATE/INSERT) as well as row data for SELECT statements.
      execute: async (sql: string, params?: unknown[]): Promise<[unknown, unknown]> => {
        const result = await conn.execute(sql, params);
        return result as [unknown, unknown];
      },
      end: (): Promise<void> => conn.end(),
    };

    return db;
  } catch (e) {
    await conn.end().catch(() => {
      // best-effort close; swallow error
    });
    throw redact(e);
  }
}

/**
 * Redact the password from any error message so it never leaks in logs/traces.
 */
function redact(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  const safe = new Error(err.message.replace(/password\s*[:=]\s*'[^']*'/gi, "password:'***'"));
  safe.stack = err.stack?.replace(/password\s*[:=]\s*'[^']*'/gi, "password:'***'");
  return safe;
}
