// Path: src/cli/ssh-tunnel.ts
// SSH-CA-authenticated tunnel manager. Opens `znvault ssh forward` local
// forwards to each host's loopback-bound agent (:9100), so deploys work
// while the agent never exposes :9100 on the network.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Resolve the znvault CLI binary to shell out to (O2).
 * Order: $ZNVAULT_BIN (if exists) → sibling of process.execPath → "znvault" on PATH.
 */
export function resolveZnvaultBin(): string {
  const fromEnv = process.env.ZNVAULT_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // The plugin runs inside the znvault process, so a sibling of the node
  // binary's dir is a good guess for a bundled install.
  try {
    const sibling = join(dirname(process.execPath), 'znvault');
    if (existsSync(sibling)) return sibling;
  } catch {
    // ignore — fall through to PATH
  }

  return 'znvault';
}
