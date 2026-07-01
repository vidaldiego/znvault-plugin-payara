/**
 * Unit tests for openDb SSL configuration — no real MySQL server required.
 *
 * Production context: the prod MySQL (172.16.220.40:6446) uses an internal CA not
 * in Node's trust store. Kotlin's ConnectionFactory uses sslMode=REQUIRED (encrypt
 * WITHOUT verifying the server cert). mysql2's `ssl: {}` defaults to
 * rejectUnauthorized:true (CA verification), which fails against the internal CA.
 * The fix: pass `{ rejectUnauthorized: false }` to match Kotlin's REQUIRED semantics.
 *
 * These tests use vi.mock to intercept mysql2/promise.createConnection and verify
 * the exact SSL option object passed by openDb.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the options passed to createConnection across calls.
let capturedConnectOpts: unknown[] = [];

vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: vi.fn(async (opts: unknown) => {
      capturedConnectOpts.push(opts);
      // Throw immediately — openDb's redact() wraps the error; we only care about
      // the options captured above, not about a successful connection.
      throw new Error('__mock_no_server__');
    }),
  },
}));

// Import AFTER vi.mock so the module receives the mocked mysql2.
import { openDb } from '../../src/migrate/db.js';

describe('openDb SSL option (unit — no real server)', () => {
  beforeEach(() => {
    capturedConnectOpts = [];
  });

  it('ssl:true → { rejectUnauthorized: false } (encrypt without cert verify, matching Kotlin sslMode=REQUIRED)', async () => {
    // openDb will throw because the mock never provides a real connection.
    await expect(
      openDb({ host: '127.0.0.1', port: 13306, database: 'test', user: 'test', password: 'test', ssl: true }),
    ).rejects.toThrow();

    expect(capturedConnectOpts).toHaveLength(1);
    const opts = capturedConnectOpts[0] as { ssl?: unknown };

    // The key invariant: ssl:true MUST produce { rejectUnauthorized: false }.
    // An empty object `{}` would leave mysql2 at the default rejectUnauthorized:true,
    // which fails against prod MySQL's internal CA.
    expect(opts.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('ssl:false → ssl option is undefined (no SSL for local/e2e)', async () => {
    await expect(
      openDb({ host: '127.0.0.1', port: 13306, database: 'test', user: 'test', password: 'test', ssl: false }),
    ).rejects.toThrow();

    expect(capturedConnectOpts).toHaveLength(1);
    const opts = capturedConnectOpts[0] as { ssl?: unknown };

    // ssl:false must produce undefined (no SSL at all, for local/e2e paths).
    expect(opts.ssl).toBeUndefined();
  });
});
