/**
 * Tests for the node local migration entrypoint.
 *
 * Integration tests against the e2e MySQL at 127.0.0.1:33306 (zincdb, root/root).
 * Skipped when ZINC_DB_HOST is not set.
 *
 * We build the project first (npm run build), then spawn
 * `node dist/migrate/local-entrypoint.js <cmd> <env> <dir>` as a child process
 * and assert on stdout / exit code.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO = join(__dirname, '../../');
const ENTRYPOINT = join(REPO, 'dist/migrate/local-entrypoint.js');
const MIGRATIONS_DIR = '/Users/diegovidal/Drive/zincapi-parent/docs/migrations';

// Skip all tests unless ZINC_DB_HOST is provided (set by the e2e runner)
const HAVE_DB = !!process.env['ZINC_DB_HOST'];

const dbEnv = {
  ...process.env,
  ZINC_DB_HOST: process.env['ZINC_DB_HOST'] ?? '127.0.0.1',
  ZINC_DB_PORT: process.env['ZINC_DB_PORT'] ?? '33306',
  ZINC_DB_NAME: process.env['ZINC_DB_NAME'] ?? 'zincdb',
  ZINC_DB_USER: process.env['ZINC_DB_USER'] ?? 'root',
  ZINC_DB_PASSWORD: process.env['ZINC_DB_PASSWORD'] ?? 'root',
  ZINC_DB_USE_SSL: process.env['ZINC_DB_USE_SSL'] ?? 'false',
};

describe.skipIf(!HAVE_DB)('local-entrypoint (integration against e2e MySQL)', () => {
  it('status command prints RESULT line matching the expected format', () => {
    const result = spawnSync('node', [ENTRYPOINT, 'status', 'e2e', MIGRATIONS_DIR], {
      env: dbEnv,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const stdout = result.stdout ?? '';
    // The RESULT line format is a hard contract (grepped by verify-idempotent.sh)
    expect(stdout).toMatch(/^RESULT applied=\d+ reconcile=\d+ pending=\d+$/m);
  });

  it('bad migrations directory causes non-zero exit', () => {
    const result = spawnSync(
      'node',
      [ENTRYPOINT, 'status', 'e2e', '/nonexistent/path/to/migrations'],
      {
        env: dbEnv,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );

    expect(result.status).not.toBe(0);
    // Error should be on stderr
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('migrate command prints RESULT line matching the expected format', () => {
    const result = spawnSync('node', [ENTRYPOINT, 'migrate', 'e2e', MIGRATIONS_DIR], {
      env: dbEnv,
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const stdout = result.stdout ?? '';
    // The RESULT line format is a hard contract (grepped by verify-idempotent.sh)
    expect(stdout).toMatch(
      /^RESULT seeded=\d+ reconciled=\d+ applied=\d+ pending=\d+$/m,
    );
  });

  it('missing ZINC_DB_HOST env var causes non-zero exit', () => {
    const envWithoutHost = { ...dbEnv };
    delete envWithoutHost['ZINC_DB_HOST'];

    const result = spawnSync('node', [ENTRYPOINT, 'status', 'e2e', MIGRATIONS_DIR], {
      env: envWithoutHost,
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ZINC_DB_HOST/);
  });
});
