// Path: test/ssh-tunnel.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExistsSync = vi.fn();
vi.mock('node:fs', () => ({ existsSync: (...a: unknown[]) => mockExistsSync(...a) }));

const { resolveZnvaultBin } = await import('../src/cli/ssh-tunnel.js');

describe('resolveZnvaultBin', () => {
  const origEnv = process.env.ZNVAULT_BIN;
  beforeEach(() => { vi.clearAllMocks(); delete process.env.ZNVAULT_BIN; });
  afterEach(() => { if (origEnv === undefined) delete process.env.ZNVAULT_BIN; else process.env.ZNVAULT_BIN = origEnv; });

  it('prefers ZNVAULT_BIN when set and existing', () => {
    process.env.ZNVAULT_BIN = '/custom/znvault';
    mockExistsSync.mockImplementation((p: string) => p === '/custom/znvault');
    expect(resolveZnvaultBin()).toBe('/custom/znvault');
  });

  it('falls back to bare "znvault" when nothing else resolves', () => {
    mockExistsSync.mockReturnValue(false);
    expect(resolveZnvaultBin()).toBe('znvault');
  });
});

import * as http from 'node:http';
import { EventEmitter } from 'node:events';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => mockSpawn(...a) }));

// Re-import with child_process mocked
const tunnelMod = await import('../src/cli/ssh-tunnel.js');

function fakeForwardChild(localPort: number): EventEmitter & {
  stdout: EventEmitter; stderr: EventEmitter; kill: (sig?: string) => void; pid: number;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: (sig?: string) => void; pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = vi.fn();
  // Emit the contract line on next tick
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ localPort, pid: 4242, forwardUp: true }) + '\n'));
  }, 5);
  return child;
}

describe('openTunnel', () => {
  let agent: http.Server;
  let agentPort: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    agent = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200); res.end('{"status":"healthy"}'); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => agent.listen(0, '127.0.0.1', r));
    agentPort = (agent.address() as import('node:net').AddressInfo).port;
  });
  afterEach(() => new Promise<void>((r) => agent.close(() => r())));

  it('opens a tunnel, reports the local port, and tears down on close', async () => {
    // The fake forward "binds" the same port our local stub agent listens on,
    // so the readiness probe to 127.0.0.1:<port>/health hits the stub.
    const child = fakeForwardChild(agentPort);
    mockSpawn.mockReturnValue(child);

    const t = await tunnelMod.openTunnel('172.16.220.55', {
      user: 'sysadmin', remotePort: 9100, znvaultBin: 'znvault', readinessTimeoutMs: 2000,
    });

    expect(t.localPort).toBe(agentPort);
    // spawn called with ssh forward --print-port
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('ssh');
    expect(args).toContain('forward');
    expect(args).toContain('--print-port');

    await t.close();
    expect(child.kill).toHaveBeenCalled();
  });

  it('throws if the forward child exits before printing a port', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void; pid: number };
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn(); child.pid = 1;
    mockSpawn.mockReturnValue(child);
    const p = tunnelMod.openTunnel('h', { znvaultBin: 'znvault', readinessTimeoutMs: 500 });
    setTimeout(() => child.emit('close', 255), 5);
    await expect(p).rejects.toThrow();
  });
});
