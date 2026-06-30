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
     * → { leaseId, username, password }
     */
    async issueCredential(roleId: string, opts: { ttlSeconds: number }): Promise<Lease> {
      const path = `/v1/dynamic-secrets/roles/${roleId}/credentials`;
      const res = await http.post(path, { ttlSeconds: opts.ttlSeconds });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return res.body as Lease;
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
