import { describe, it, expect, vi } from 'vitest';
import { makeDynamicSecretsClient } from '../src/dynamic-secrets-client.js';

describe('dynamic-secrets client', () => {
  it('issueCredential posts to the role credentials endpoint with ttl', async () => {
    const http = {
      post: vi.fn().mockResolvedValue({
        status: 200,
        body: { leaseId: 'L', username: 'u', password: 'p' },
      }),
    };
    const c = makeDynamicSecretsClient(http as any);
    const lease = await c.issueCredential('dbr_bc3546e8729d4727', { ttlSeconds: 14400 });
    expect(http.post).toHaveBeenCalledWith(
      '/v1/dynamic-secrets/roles/dbr_bc3546e8729d4727/credentials',
      { ttlSeconds: 14400 },
    );
    expect(lease).toEqual({ leaseId: 'L', username: 'u', password: 'p' });
  });

  it('revokeCredential posts to the lease revoke endpoint', async () => {
    const http = {
      post: vi.fn().mockResolvedValue({ status: 200, body: {} }),
    };
    const c = makeDynamicSecretsClient(http as any);
    await expect(c.revokeCredential('LEASE-1', { reason: 'migration complete' })).resolves.toBeUndefined();
    expect(http.post).toHaveBeenCalledWith('/v1/dynamic-secrets/leases/LEASE-1/revoke', {
      reason: 'migration complete',
    });
  });

  it('revokeCredential treats 404 rejection as success (no throw)', async () => {
    const http = { post: vi.fn().mockRejectedValue({ status: 404 }) };
    const c = makeDynamicSecretsClient(http as any);
    await expect(c.revokeCredential('L', { reason: 'x' })).resolves.toBeUndefined();
  });

  it('revokeCredential treats 410 rejection as success (no throw)', async () => {
    const http = { post: vi.fn().mockRejectedValue({ status: 410 }) };
    const c = makeDynamicSecretsClient(http as any);
    await expect(c.revokeCredential('L', { reason: 'x' })).resolves.toBeUndefined();
  });

  it('revokeCredential treats non-ACTIVE lease response body as success', async () => {
    // The vault may reject with a 422/400 carrying a non-ACTIVE state error
    const http = {
      post: vi.fn().mockRejectedValue({ status: 422, body: { status: 'EXPIRED' } }),
    };
    const c = makeDynamicSecretsClient(http as any);
    await expect(c.revokeCredential('L', { reason: 'x' })).resolves.toBeUndefined();
  });

  it('revokeCredential rejects on a real error (500)', async () => {
    const err = Object.assign(new Error('server error'), { status: 500 });
    const http = { post: vi.fn().mockRejectedValue(err) };
    const c = makeDynamicSecretsClient(http as any);
    await expect(c.revokeCredential('L', { reason: 'x' })).rejects.toThrow('server error');
  });

  it('issueCredential rejects on error', async () => {
    const err = Object.assign(new Error('vault down'), { status: 503 });
    const http = { post: vi.fn().mockRejectedValue(err) };
    const c = makeDynamicSecretsClient(http as any);
    await expect(c.issueCredential('roleX', { ttlSeconds: 300 })).rejects.toThrow('vault down');
  });
});
