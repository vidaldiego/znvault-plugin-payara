/**
 * Dynamic-secrets REST client for ZN-Vault.
 *
 * These are raw async functions hitting the Vault REST API — NOT the znvault-cli
 * command handlers (which call inquirer.prompt / process.exit and are unusable as
 * lifecycle primitives).
 *
 * Key design (Codex F6.1): a 404 / 410 / non-ACTIVE-lease response on revokeCredential
 * is treated as SUCCESS — the lease is already gone. This is critical because a
 * timed-out-then-retried revoke hits a now-non-ACTIVE lease on the 2nd attempt and
 * must not be retried into an error.
 */

export interface Lease {
  leaseId: string;
  username: string;
  password: string;
  /** MySQL hostname returned by the Vault dynamic-secrets connection. */
  host: string;
  /** MySQL port returned by the Vault dynamic-secrets connection. */
  port: number;
  /** MySQL database name returned by the Vault dynamic-secrets connection (may be undefined if the connection doesn't pin a database). */
  database?: string;
}

export interface VaultHttp {
  post(path: string, body: unknown): Promise<{ status: number; body: any }>;
}

/**
 * Classify a revoke error as "already gone" (the lease no longer exists).
 *
 * A lease is already gone when:
 *  - The error carries HTTP status 404 (not found) or 410 (gone).
 *  - The error carries a response body indicating a non-ACTIVE or not-found lease state
 *    (e.g. status: 'EXPIRED', 'REVOKED', 'NOT_FOUND').
 *
 * Any other error (500, network failure, etc.) is NOT already-gone.
 */
function isAlreadyGone(e: unknown): boolean {
  if (e == null || typeof e !== 'object') return false;
  const obj = e as Record<string, unknown>;

  // 404 / 410 by HTTP status
  const status = obj['status'];
  if (status === 404 || status === 410) return true;

  // Response body carries a non-ACTIVE lease status
  const body = obj['body'];
  if (body != null && typeof body === 'object') {
    const bodyStatus = (body as Record<string, unknown>)['status'];
    if (
      typeof bodyStatus === 'string' &&
      bodyStatus !== 'ACTIVE'
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Create a dynamic-secrets client bound to the given HTTP transport.
 *
 * @param http - The vault HTTP client (e.g. the plugin's existing VaultHttp).
 */
export function makeDynamicSecretsClient(http: VaultHttp): {
  issueCredential(roleId: string, opts: { ttlSeconds: number }): Promise<Lease>;
  revokeCredential(leaseId: string, opts: { reason: string }): Promise<void>;
} {
  return {
    /**
     * Issue a new dynamic-secrets credential for the given role.
     *
     * POST /v1/dynamic-secrets/roles/:roleId/credentials
     * → { leaseId, username, password, host, port, database? }
     *
     * CRITICAL: validates that host and port are present in the response.
     * If missing, the just-minted lease is revoked (best-effort) before
     * throwing so the orphaned credential is not left to expire passively.
     * Mirrors the znvault-cli mysql broker pattern (spec F2).
     */
    async issueCredential(roleId: string, opts: { ttlSeconds: number }): Promise<Lease> {
      const path = `/v1/dynamic-secrets/roles/${roleId}/credentials`;
      const res = await http.post(path, { ttlSeconds: opts.ttlSeconds });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = res.body as any;

      // Validate that the server returned host and port (spec F2 — no --host fallback).
      if (!body.host || body.port === undefined) {
        // Best-effort revoke of the just-minted partial lease before throwing.
        // Wrap in try/catch so a revoke failure does not mask the validation error.
        try {
          const revokePath = `/v1/dynamic-secrets/leases/${body.leaseId as string}/revoke`;
          await http.post(revokePath, { reason: 'incomplete credential' });
        } catch {
          // Intentionally swallowed — cleanup job + TTL will expire the lease.
        }
        throw new Error(
          `Vault did not return host/port in the credential for role '${roleId}'. ` +
          `Please upgrade vault to a version that returns host/port in dynamic-secret credentials.`,
        );
      }

      return {
        leaseId: body.leaseId as string,
        username: body.username as string,
        password: body.password as string,
        host: body.host as string,
        port: body.port as number,
        database: body.database as string | undefined,
      };
    },

    /**
     * Revoke an existing dynamic-secrets credential lease.
     *
     * POST /v1/dynamic-secrets/leases/:leaseId/revoke
     *
     * CRITICAL (Codex F6.1): a 404 / 410 / non-ACTIVE-lease error is treated as
     * SUCCESS — the lease is already gone. Resolve, do NOT throw.
     */
    async revokeCredential(leaseId: string, opts: { reason: string }): Promise<void> {
      const path = `/v1/dynamic-secrets/leases/${leaseId}/revoke`;
      try {
        await http.post(path, { reason: opts.reason });
      } catch (e) {
        if (isAlreadyGone(e)) {
          // Lease is already gone — treat as success per spec F6.1.
          return;
        }
        throw e;
      }
    },
  };
}
