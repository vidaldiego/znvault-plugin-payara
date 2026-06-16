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

import { spawn, type ChildProcess } from 'node:child_process';

/** An open tunnel: local port to use, and a teardown. */
export interface Tunnel {
  host: string;
  localPort: number;
  /** PID of the spawned `znvault ssh forward` child (for synchronous orphan-kill backstops). */
  pid?: number;
  close(): Promise<void>;
}

export interface OpenTunnelOptions {
  /** SSH user; defaults to convention. Honors ~/.ssh/config either way. */
  user?: string;
  /** Remote agent port to forward to (default 9100). */
  remotePort?: number;
  /** Path/name of the znvault binary (default: resolveZnvaultBin()). */
  znvaultBin?: string;
  /** Max ms to wait for /health to answer through the tunnel (default 15000). */
  readinessTimeoutMs?: number;
}

const DEFAULT_REMOTE_PORT = 9100;
const DEFAULT_READINESS_TIMEOUT_MS = 15000;
const READINESS_POLL_INTERVAL_MS = 250;

/**
 * Open an SSH-CA-authenticated local forward to host:remotePort via
 * `znvault ssh forward --print-port`. Resolves once the tunnel's local port
 * answers GET /health, or rejects on spawn/exit/readiness failure.
 */
export async function openTunnel(host: string, opts: OpenTunnelOptions = {}): Promise<Tunnel> {
  const bin = opts.znvaultBin ?? resolveZnvaultBin();
  const user = opts.user ?? 'sysadmin';
  const remotePort = opts.remotePort ?? DEFAULT_REMOTE_PORT;
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  const args = [
    'ssh', 'forward',
    '--print-port',
    '-L', `127.0.0.1:0:127.0.0.1:${remotePort}`,
    `${user}@${host}`,
  ];

  const child: ChildProcess = spawn(bin, args, { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });

  const localPort = await new Promise<number>((resolve, reject) => {
    let buf = '';
    let settled = false;
    const onClose = (code: number | null): void => {
      if (!settled) { settled = true; reject(new Error(`ssh forward exited (code ${code ?? 'null'}) before reporting a port`)); }
    };
    child.on('close', onClose);
    child.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0 && !settled) {
        const line = buf.slice(0, nl).trim();
        try {
          const parsed = JSON.parse(line) as { localPort?: number };
          if (typeof parsed.localPort === 'number') {
            settled = true;
            child.removeListener('close', onClose);
            resolve(parsed.localPort);
          }
        } catch {
          // not the JSON line yet; keep buffering
        }
      }
    });
  });

  const close = async (): Promise<void> => {
    if (child.pid && !child.killed) child.kill('SIGTERM');
    // give it a beat to die; don't hang the deploy if it lingers
    await new Promise((r) => setTimeout(r, 100));
  };

  // App-level readiness (component owns this, not `forward`): poll /health.
  const deadline = Date.now() + readinessTimeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${localPort}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return { host, localPort, pid: child.pid, close };
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, READINESS_POLL_INTERVAL_MS));
  }
  await close();
  throw new Error(`Tunnel to ${host} opened (port ${localPort}) but /health never answered: ${lastErr}`);
}
