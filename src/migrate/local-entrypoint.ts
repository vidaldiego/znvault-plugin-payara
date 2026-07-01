/**
 * Node local migration entrypoint.
 *
 * Usage: node dist/migrate/local-entrypoint.js <status|migrate> <env> <dir>
 *
 * Reads DB credentials from environment variables:
 *   ZINC_DB_HOST, ZINC_DB_PORT, ZINC_DB_NAME, ZINC_DB_USER, ZINC_DB_PASSWORD, ZINC_DB_USE_SSL
 *
 * Output (hard contract — grepped by e2e scripts):
 *   status:  RESULT applied=N reconcile=N pending=N
 *   migrate: RESULT seeded=N reconciled=N applied=N pending=N
 *
 * Exits 0 on success; prints error to stderr and exits non-zero on any failure.
 */

import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { openDb } from './db.js';
import { MigrationRunner } from './migration-runner.js';

/**
 * Read and validate a required environment variable. Throws with the variable name
 * if it is missing or empty.
 */
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

/**
 * Main entry point — parse argv, open DB, run status/migrate, print RESULT line.
 */
export async function main(argv: string[]): Promise<void> {
  // argv: [node, entrypoint.js, cmd, env, dir]
  const cmd = argv[2];
  const _env = argv[3]; // env label (e2e, production, etc.) — informational only
  const dir = argv[4];

  if (!cmd || !_env || !dir) {
    throw new Error('Usage: local-entrypoint.js <status|migrate> <env> <dir>');
  }
  if (cmd !== 'status' && cmd !== 'migrate') {
    throw new Error(`Unknown command: ${cmd}. Expected 'status' or 'migrate'.`);
  }

  // Read DB credentials from environment
  const host = requireEnv('ZINC_DB_HOST');
  const port = Number(process.env['ZINC_DB_PORT'] ?? '3306');
  const database = requireEnv('ZINC_DB_NAME');
  const user = requireEnv('ZINC_DB_USER');
  const password = requireEnv('ZINC_DB_PASSWORD');
  const ssl = (process.env['ZINC_DB_USE_SSL'] ?? 'false').toLowerCase() !== 'false';

  const appliedBy = `${os.userInfo().username}@${os.hostname()}`;
  const db = await openDb({ host, port, database, user, password, ssl });

  try {
    const runner = new MigrationRunner(db, dir, appliedBy);

    if (cmd === 'status') {
      const s = await runner.status();
      // HARD CONTRACT: this exact format is grepped by verify-idempotent.sh
      process.stdout.write(
        `RESULT applied=${s.applied} reconcile=${s.reconcile} pending=${s.pending}\n`,
      );
    } else {
      // cmd === 'migrate'
      const r = await runner.run();
      // HARD CONTRACT: this exact format is grepped by verify-idempotent.sh
      process.stdout.write(
        `RESULT seeded=${r.seeded} reconciled=${r.reconciled} applied=${r.applied} pending=${r.pendingRemaining}\n`,
      );
    }
  } finally {
    await db.end().catch(() => {
      // best-effort close — never mask the primary error
    });
  }
}

// CLI guard: only run when this module is the direct entrypoint.
// ESM: compare the resolved file URL of this module against argv[1].
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  main(process.argv).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  });
}
