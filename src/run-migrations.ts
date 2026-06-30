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
 *  - ALWAYS call runner.run() — never short-circuit on status (CRITICAL F4.1):
 *    run() refreshes the 0000_ helper procedures on every invocation; a status
 *    check short-circuit would leave stale zn_assert_* bodies in the DB.
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
  host: string;
  port: number;
  database: string;
  migrationsDir: string;
}

/** Shape of a minimal dynamic-secrets client (for injection / testing). */
export interface DynamicSecretsClient {
  issueCredential(roleId: string, opts: { ttlSeconds: number }): Promise<Lease>;
  revokeCredential(leaseId: string, opts: { reason: string }): Promise<void>;
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
 * Build a guarded single-shot revoke function with 3× retry + backoff.
 *
 * Idempotent: subsequent calls after the first are no-ops (the `revoked` flag
 * is captured in closure so parallel signal + finally can't double-revoke).
 *
 * 404/410/non-ACTIVE response → already gone → log WARN, do NOT retry (F6.1).
 * Other transient failures → retry up to 3 times, then log WARN without throwing
 * (the cleanup job + 4h TTL will drop the user eventually).
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
      } catch {
        const isLast = attempt === attempts;
        if (isLast) {
          // All retries exhausted — log and give up; do NOT throw.
          log(
            `[run-migrations] WARN: revoke failed after ${attempts} attempt(s); ` +
              `cleanup job + 4h TTL will drop the user. leaseId=${lease.leaseId}`,
          );
          return;
        }
        // Wait before the next attempt.
        const delayMs = REVOKE_RETRY_DELAYS_MS[attempt - 1] ?? 200;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };
}

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
 * 1. Mint a dynamic-secrets lease (TTL 4h).
 * 2. Install signal handlers that await revoke (5s cap) before exiting.
 * 3. Open a MySQL connection with the ephemeral credentials.
 * 4. ALWAYS call runner.run() — never skip (CRITICAL F4.1).
 * 5. In finally: close DB + revokeOnce + remove signal handlers.
 *
 * @param ctx    - CLI plugin context (used for logging; pass {} as `any` in tests).
 * @param opts   - env, roleId, host, port, database, migrationsDir.
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
    db = await deps.openDb({
      host: opts.host,
      port: opts.port,
      database: opts.database,
      user: lease.username,
      password: lease.password,
      ssl: true,
    });

    const appliedBy = `${os.userInfo().username}@${os.hostname()}`;
    // ALWAYS run() — NEVER short-circuit on status (CRITICAL F4.1).
    // run() refreshes the 0000_ helper procedures every invocation; a status
    // check would leave stale zn_assert_* bodies while reporting "up to date".
    const result = await deps.makeRunner(db, opts.migrationsDir, appliedBy).run();
    info(`[run-migrations] Migrations complete: ${JSON.stringify(result)}`);
  } finally {
    // ── Step 5: Teardown — close DB (best-effort) then revoke ────────────────
    if (db) {
      await db.end().catch(() => {
        // best-effort; never mask the primary error
      });
    }
    await revokeOnce();

    // Remove signal handlers to avoid memory leaks and double-handling.
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
  }
}
