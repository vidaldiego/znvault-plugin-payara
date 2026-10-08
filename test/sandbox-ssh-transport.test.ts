import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
import { preflightSandboxTarget } from '../src/cli/sandbox-target.js';
const sha = 'a'.repeat(64);
const manifest = { version: 1, runtimeId: 'partner-sandbox', gitSha: 'b'.repeat(40),
  warSha256: sha, image: 'registry.example/api@sha256:' + sha, bundlePath: '/tmp/runtime.tgz',
  bundleSha256: sha, driverSha256: sha,
  files: { 'compose.json': sha, 'private-service.json': sha, 'deploy-runtime.py': sha,
    'nginx.conf': sha, 'public-proxy.conf': sha, 'private-mtls.rendered.conf': sha,
    'authority-relay.rendered.conf': sha },
  preMigrations: [], postMigrations: [],
  production: [{ className: 'api', host: '172.16.220.55', warContentSha256: sha }],
  releaseReceiptSha256: sha };

const target = {
  kind: 'partner-sandbox-compose' as const, runtimeId: 'partner-sandbox',
  host: '172.16.221.80', project: 'zincapp-partner-sandbox',
  directory: '/srv/zincapp/partner-sandbox', manifestPath: '/tmp/release-target.json',
  ssh: { user: 'sysadmin' },
};
const receipt = JSON.stringify({ runtimeId: 'partner-sandbox', host: '172.16.221.80',
  database: 'partner_sandbox_zincdb', driverSha256: manifest.driverSha256 });

// External SSH fixture: a protected driver needs sudo, and ordinary CLI output has a banner.
function transport(requirePrivilege: boolean, includeBanner: boolean) {
  spawn.mockImplementation((_binary: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid, stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { end: () => {} }),
    });
    setImmediate(() => {
      const command = args.at(-1)!;
      if (requirePrivilege && (!command.includes('sudo -n sha256sum') ||
          !command.includes("exec 'sudo' '-n' 'python3'"))) {
        child.emit('close', 1);
        return;
      }
      const banner = includeBanner && !args.includes('--quiet') ? '[znvault profile]\n' : '';
      child.stdout.emit('data', Buffer.from(banner + receipt));
      child.emit('close', 0);
    });
    return child;
  });
}

describe('sandbox protected SSH execution', () => {
  beforeEach(() => { spawn.mockReset(); });
  it('runs the digest check and driver using existing noninteractive sudo authority', async () => {
    transport(true, false);
    await expect(preflightSandboxTarget(target, manifest)).resolves.toBeUndefined();
  });
  it('requests a clean machine-readable receipt from the Vault SSH CLI', async () => {
    transport(false, true);
    await expect(preflightSandboxTarget(target, manifest)).resolves.toBeUndefined();
  });
});
