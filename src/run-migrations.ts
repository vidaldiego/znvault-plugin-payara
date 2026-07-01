/**
 * run-migrations.ts — the deploy migration phase.
 *
 * Mints a dynamic-secrets lease (4h TTL), opens a MySQL connection with the
 * ephemeral credentials, runs the migration engine, and revokes the lease in
 * the finally block and on SIGINT/SIGTERM.
 *
 * Design decisions (spec §run-migrations.ts + Codex):
 *  - 4h TTL (not 600s): Vault's cleanup job KILLs active DB sessions when a
 *    lease expires mid-DDL. A generous TTL + explicit revoke-on-exit is safer.
 *  - Step 0 (if `opts.routines` configured): apply the vault-owned routine
 *    bundle BEFORE minting the lease. Helper procedures are no longer created
 *    by the migration engine (removed post-B1) — they are provisioned by vault
 *    under the persistent routines account, so the ephemeral migrate user
 *    never owns a routine and revokes cleanly. A bundle-apply failure aborts
 *    the deploy before any lease/host/DB change (same posture as mint failure).
 *  - ALWAYS call runner.run() — never short-circuit on status (CRITICAL F4.1):
 *    run() unconditionally executes pending migrations on every invocation; a
 *    status check short-circuit would leave pending migrations unapplied while
 *    reporting "up to date". (Helper procedure refresh is now Step 0, above —
 *    NOT part of run().)
 *  - revokeOnce: single guarded revoke with 3× retry + backoff; 404/non-ACTIVE
 *    treated as success (Codex F6.1). Signal handlers await the revoke (5s cap)
 *    before exiting (Codex F6.4) so the in-flight HTTP request isn't aborted.
 *  - Lease mint failure aborts the deploy before any DB/host change.
 *  - Migration failure propagates; revokeOnce still runs in finally.
 *  - Credentials held only in memory; never logged (Codex F6.3).
 */

import os from 'node:os';
import type { Lease } from './dynamic-secrets-client.js';
import { makeDynamicSecretsClient } from './dynamic-secrets-client.js';
import { openDb } from './migrate/db.js';
import { MigrationRunner } from './migrate/migration-runner.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunMigrationsOpts {
  env: string;
  roleId: string;
  /**
   * Optional database name override.
   *
   * host/port/database are provided by the Vault dynamic-secrets connection
   * (referenced by roleId) and returned with the lease — the deploy config
   * only names the role + the migrations dir. This field lets the caller
   * override the database name when the lease does not pin one.
   */
  database?: string;
  migrationsDir: string;
  /**
   * Optional server-owned routine bundle to apply BEFORE minting the migrate
   * lease (Step 0). Helpers are provisioned by vault under the persistent
   * routines account — the ephemeral migrate user never owns them, so it
   * revokes cleanly (see B1/C1). Absent = today's behavior (no bundle applied).
   */
  routines?: { bundle: string; version: number };
}

/** Shape of a minimal dynamic-secrets client (for injection / testing). */
export interface DynamicSecretsClient {
  issueCredential(roleId: string, opts: { ttlSeconds: number }): Promise<Lease>;
  revokeCredential(leaseId: string, opts: { reason: string }): Promise<void>;
  applyRoutines(roleId: string, opts: { bundle: string; version: number }): Promise<void>;
}

/** Minimal DB handle exposed by openDb (for injection / testing). */
export interface DbHandle {
  end(): Promise<void>;
}

/** Injectable dependencies (real in production; mocked in tests). */
export interface RunMigrationsDeps {
  client: DynamicSecretsClient;
  openDb(cfg: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean;
  }): Promise<DbHandle>;
  makeRunner(db: DbHandle, dir: string, appliedBy: string): { run(): Promise<unknown> };
  /**
   * Override the settle delay applied after db.end() and before revokeOnce().
   * Set to 0 in tests to avoid real waiting.  Production always uses REVOKE_SETTLE_MS.
   */
  settleMs?: number;
}

// ─── VaultHttp adapter ────────────────────────────────────────────────────────

/**
 * Adapt a CLIPluginContext-style client (returns T directly) to the VaultHttp
 * shape expected by makeDynamicSecretsClient ({ status, body }).
 *
 * The CLI client throws on non-2xx (see agentPost); on success it returns the
 * parsed body directly. We wrap it so revokeCredential's isAlreadyGone() logic
 * can inspect the status on thrown errors.
 *
 * The adapter is intentionally narrow — only `post` is needed.
 */
export function makeVaultHttpAdapter(client: {
  post<T>(path: string, body: unknown): Promise<T>;
}): { post(path: string, body: unknown): Promise<{ status: number; body: unknown }> } {
  return {
    async post(path: string, body: unknown) {
      // ctx.client.post<T> returns T on success, throws on non-2xx.
      const result = await client.post<unknown>(path, body);
      return { status: 200, body: result };
    },
  };
}

// ─── Default production deps factory ─────────────────────────────────────────

/**
 * Build the real production deps.
 *
 * @param client - the vault CLI client (CLIPluginContext.client), used to mint/revoke leases.
 */
export function defaultDeps(client: { post<T>(path: string, body: unknown): Promise<T> }): RunMigrationsDeps {
  const http = makeVaultHttpAdapter(client);
  const dynamicClient = makeDynamicSecretsClient(http);
  return {
    client: dynamicClient,
    openDb: openDb as RunMigrationsDeps['openDb'],
    makeRunner(db, dir, appliedBy) {
      // In production the db is always a full Db handle (from openDb), so the cast is safe.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new MigrationRunner(db as any, dir, appliedBy);
    },
  };
}

// ─── revokeOnce with retry helper ────────────────────────────────────────────

const REVOKE_RETRY_DELAYS_MS = [200, 600]; // 3 attempts: immediate + 2 retries

/**
 * Return true when the caught error indicates the lease is permanently in a
 * non-revocable state (e.g. vault already marked it FAILED after a previous
 * failed attempt).  Retrying these is futile — bail out immediately.
 *
 * Examples from the vault server:
 *   "Cannot revoke failed lease"
 *   "Cannot revoke a FAILED lease"
 */
function isNonRevocable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /cannot revoke .* lease|failed lease/i.test(msg);
}

/**
 * Build a guarded single-shot revoke function with 3× retry + backoff.
 *
 * Idempotent: subsequent calls after the first are no-ops (the `revoked` flag
 * is captured in closure so parallel signal + finally can't double-revoke).
 *
 * 404/410/non-ACTIVE response → already gone → resolved as success (F6.1 — handled
 * inside revokeCredential, never reaches the catch here).
 *
 * Non-revocable lease (vault marked FAILED) → log WARN with real error, stop
 * immediately without retrying — retrying cannot fix a FAILED-lease state.
 *
 * Other transient failures → log DEBUG + retry up to 3 times; on final failure
 * log WARN with the real error and give up without throwing (cleanup job + 4h
 * TTL will drop the user eventually).
 */
function makeRevokeOnce(
  client: DynamicSecretsClient,
  lease: Lease,
  log: (msg: string) => void,
): () => Promise<void> {
  let revoked = false;

  return async function revokeOnce(): Promise<void> {
    if (revoked) return;
    revoked = true;

    const attempts = 1 + REVOKE_RETRY_DELAYS_MS.length; // 3 total

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await client.revokeCredential(lease.leaseId, { reason: 'migration complete' });
        return; // success
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);

        // Part C: if the lease is permanently non-revocable (vault already
        // marked it FAILED), retrying is futile — stop immediately.
        if (isNonRevocable(e)) {
          log(
            `[run-migrations] WARN: revoke failed after ${attempt} attempt(s): ${errMsg}; ` +
              `lease is in a non-revocable state — cleanup job + 4h TTL will drop the user. leaseId=${lease.leaseId}`,
          );
          return;
        }

        const isLast = attempt === attempts;
        if (isLast) {
          // All retries exhausted — log real error and give up; do NOT throw.
          log(
            `[run-migrations] WARN: revoke failed after ${attempts} attempt(s): ${errMsg}; ` +
              `cleanup job + 4h TTL will drop the user. leaseId=${lease.leaseId}`,
          );
          return;
        }
        // Non-last transient failure: log attempt details then wait before retry.
        const delayMs = REVOKE_RETRY_DELAYS_MS[attempt - 1] ?? 200;
        log(
          `[run-migrations] revoke attempt ${attempt} failed: ${errMsg}; retrying in ${delayMs}ms`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };
}

// ─── Settle delay constant ────────────────────────────────────────────────────

/**
 * How long to wait after db.end() before calling revokeOnce() in the normal
 * teardown path.
 *
 * WHY: db.end() sends COM_QUIT to MySQL, but the server-side session lingers
 * for a short window.  The vault revoke path does:
 *   SELECT ID FROM processlist WHERE user=<ephemeral> → KILL sessions → DROP USER
 * If the KILL races a just-closed session, the DROP USER fails transiently and
 * vault marks the lease FAILED — subsequent retry attempts then hit
 * "Cannot revoke failed lease" (vault's failed-lease guard), making all 3
 * attempts fail.  Waiting ~1.5s gives the server time to tear down the session
 * so the revoke's KILL/DROP runs against a clean slate.
 *
 * This delay is ONLY in the normal finally teardown.  The signal handler path
 * calls revokeOnce() directly (inside withTimeout) and must stay fast.
 */
export const REVOKE_SETTLE_MS = 1500;

// ─── withTimeout helper ───────────────────────────────────────────────────────

/**
 * Race a promise against a timeout. Resolves (possibly undefined) on timeout
 * so that a stuck revoke doesn't block process.exit indefinitely.
 */
function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    p.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); },
    );
  });
}

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Run schema migrations as a deploy phase.
 *
 * 0. If `opts.routines` is configured, apply the vault-owned routine bundle
 *    BEFORE minting any lease. Failure aborts the deploy here — no lease is
 *    minted, no host/DB change has happened yet.
 * 1. Mint a dynamic-secrets lease (TTL 4h).
 * 2. Install signal handlers that await revoke (5s cap) before exiting.
 * 3. Open a MySQL connection with the ephemeral credentials.
 * 4. ALWAYS call runner.run() — never skip (CRITICAL F4.1).
 * 5. In finally: close DB + revokeOnce + remove signal handlers.
 *
 * @param ctx    - CLI plugin context (used for logging; pass {} as `any` in tests).
 * @param opts   - env, roleId, migrationsDir, an optional database override, and
 *                 an optional routines bundle applied before the lease is minted.
 *                 host/port/database come from the Vault dynamic-secrets lease.
 * @param deps   - Injectable deps (real = defaultDeps(ctx.client); tests pass mocks).
 */
export async function runMigrations(
  ctx: { output?: { info(msg: string): void; warn(msg: string): void } },
  opts: RunMigrationsOpts,
  deps: RunMigrationsDeps,
): Promise<void> {
  const log = (msg: string): void => {
    if (ctx.output?.warn) {
      ctx.output.warn(msg);
    } else {
      // eslint-disable-next-line no-console
      console.warn(msg);
    }
  };
  const info = (msg: string): void => {
    if (ctx.output?.info) {
      ctx.output.info(msg);
    } else {
      // eslint-disable-next-line no-console
      console.info(msg);
    }
  };

  // ── Step 0: Apply the server-owned routine bundle (if configured), BEFORE any lease. ──
  // Helpers are provisioned by vault (owned by the persistent routines account), NOT created
  // by the migration engine (see B1). Failure aborts the deploy before any host/DB change —
  // same posture as lease-mint failure. Must run before issueCredential.
  if (opts.routines) {
    await deps.client.applyRoutines(opts.roleId, opts.routines);
    info(`[run-migrations] Routine bundle applied: ${opts.routines.bundle} v${opts.routines.version}`);
  }

  // ── Step 1: Mint lease (4h TTL). Failure aborts deploy before any host change. ──
  const LEASE_TTL_SECONDS = 4 * 3600; // 14400 — NOT 600; see spec §run-migrations.ts
  const lease = await deps.client.issueCredential(opts.roleId, { ttlSeconds: LEASE_TTL_SECONDS });
  info(`[run-migrations] Lease minted: ${lease.leaseId} (TTL ${LEASE_TTL_SECONDS}s)`);

  // ── Step 2: Build the guarded revoke function ──────────────────────────────
  const revokeOnce = makeRevokeOnce(deps.client, lease, log);

  // ── Step 3: Signal handlers — await revoke before exit (Codex F6.4) ───────
  const onSignal = async (): Promise<void> => {
    log('[run-migrations] Signal received — revoking lease before exit...');
    await withTimeout(revokeOnce(), 5000);
    process.exit(1);
  };

  const sigintHandler = (): void => { void onSignal(); };
  const sigtermHandler = (): void => { void onSignal(); };
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  // ── Step 4: Open DB + run engine ──────────────────────────────────────────
  let db: DbHandle | undefined;
  try {
    // Resolve the database name: prefer the lease's value (from the Vault connection),
    // fall back to the opts override, and error if neither is available.
    // This check is INSIDE the try so that revokeOnce fires in finally even on validation failure.
    const database = lease.database ?? opts.database;
    if (!database) {
      throw new Error(
        '[run-migrations] No database name: the Vault dynamic-secrets connection did not return a ' +
        'database name and no database override was provided in the migration config.',
      );
    }

    db = await deps.openDb({
      host: lease.host,
      port: lease.port,
      database,
      user: lease.username,
      password: lease.password,
      ssl: true,
    });

    const appliedBy = `${os.userInfo().username}@${os.hostname()}`;
    // ALWAYS run() — NEVER short-circuit on status (CRITICAL F4.1).
    // Helper procedures are NOT refreshed here anymore (post-B1): they are
    // provisioned by the vault routines bundle in Step 0, above, before this
    // lease was even minted. run() only CALLs them and applies pending
    // migrations; a status-check short-circuit would still leave pending
    // migrations unapplied while reporting "up to date".
    const result = await deps.makeRunner(db, opts.migrationsDir, appliedBy).run();
    info(`[run-migrations] Migrations complete: ${JSON.stringify(result)}`);
  } finally {
    // ── Step 5: Teardown — close DB (best-effort) then revoke ────────────────
    if (db) {
      await db.end().catch(() => {
        // best-effort; never mask the primary error
      });
      // Settle delay: give the server time to tear down the just-closed
      // ephemeral session before the vault revoke's KILL/DROP runs.
      // Without this, db.end() (COM_QUIT) may still linger server-side,
      // causing the revoke's KILL to race it → vault marks the lease FAILED
      // → subsequent retry attempts hit "Cannot revoke failed lease".
      // The signal handler path does NOT include this delay (stays fast).
      // deps.settleMs overrides REVOKE_SETTLE_MS (set to 0 in tests to skip).
      const settleMs = deps.settleMs ?? REVOKE_SETTLE_MS;
      if (settleMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
      }
    }
    await revokeOnce();

    // Remove signal handlers to avoid memory leaks and double-handling.
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
  }
}
