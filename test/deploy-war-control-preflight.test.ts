import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type { CLIPluginContext } from '../src/cli/types.js';

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  readLocalWarArtifactSnapshot: vi.fn(),
  calculateWarHashes: vi.fn(),
  calculateDiff: vi.fn(),
  deployToHost: vi.fn(),
  loadCliMutationAuthToken: vi.fn(),
  assertHostControlPlaneCompatible: vi.fn(),
  agentGet: vi.fn(),
  buildPluginUrl: vi.fn(),
  openTunnel: vi.fn(),
  setEndpointOverride: vi.fn(),
  clearEndpointOverride: vi.fn(),
  isLoopbackHost: vi.fn(),
  progress: {
    analyzing: vi.fn(),
    foundFiles: vi.fn(),
    diff: vi.fn(),
    noChanges: vi.fn(),
    setHost: vi.fn(),
    deployed: vi.fn(),
    failed: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  stat: mocks.stat,
}));

vi.mock('../src/war-deployer.js', () => ({
  calculateWarHashes: mocks.calculateWarHashes,
  calculateDiff: mocks.calculateDiff,
  readLocalWarArtifactSnapshot: mocks.readLocalWarArtifactSnapshot,
}));

vi.mock('../src/cli/commands/deploy.js', () => ({
  deployToHost: mocks.deployToHost,
}));

vi.mock('../src/cli/auth-token.js', () => ({
  loadCliMutationAuthToken: mocks.loadCliMutationAuthToken,
}));

vi.mock('../src/cli/listr-preflight.js', () => ({
  assertHostControlPlaneCompatible: mocks.assertHostControlPlaneCompatible,
}));

vi.mock('../src/cli/progress.js', () => ({
  ProgressReporter: class {
    analyzing = mocks.progress.analyzing;
    foundFiles = mocks.progress.foundFiles;
    diff = mocks.progress.diff;
    noChanges = mocks.progress.noChanges;
    setHost = mocks.progress.setHost;
    deployed = mocks.progress.deployed;
    failed = mocks.progress.failed;
  },
}));

vi.mock('@zincapp/znvault-deploy-core', async importActual => {
  const actual = await importActual<typeof import('@zincapp/znvault-deploy-core')>();
  return {
    ...actual,
    agentGet: mocks.agentGet,
    buildPluginUrl: mocks.buildPluginUrl,
    openTunnel: mocks.openTunnel,
    setEndpointOverride: mocks.setEndpointOverride,
    clearEndpointOverride: mocks.clearEndpointOverride,
    isLoopbackHost: mocks.isLoopbackHost,
  };
});

import { registerDeployWarCommand } from '../src/cli/commands/deploy-war.js';

const TOKEN = 'deploy-war-control-token-0123456789abcdef';
const TARGET = 'agent.example.test';

function makeContext(): CLIPluginContext {
  return {
    client: { get: vi.fn(), post: vi.fn() },
    output: {
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      table: vi.fn(),
      keyValue: vi.fn(),
    },
    getConfig: () => ({ url: TARGET }),
    isPlainMode: () => true,
  };
}

function tunnel() {
  return {
    host: TARGET,
    localPort: 55000,
    pid: 1234,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function runDeployWar(ctx: CLIPluginContext, argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerDeployWarCommand(program, ctx);
  await program.parseAsync(['node', 'znvault', 'war', '/tmp/app.war', ...argv]);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  mocks.stat.mockResolvedValue({ size: 1024 });
  mocks.readLocalWarArtifactSnapshot.mockResolvedValue({
    size: 1024,
    sha256: 'a'.repeat(64),
    contentSha256: 'b'.repeat(64),
    hashes: { 'WEB-INF/web.xml': 'abc' },
    getBytes: () => Buffer.from('snapshot'),
  });
  mocks.calculateWarHashes.mockResolvedValue({ 'WEB-INF/web.xml': 'abc' });
  mocks.calculateDiff.mockReturnValue({ changed: ['WEB-INF/web.xml'], deleted: [] });
  mocks.loadCliMutationAuthToken.mockReturnValue(TOKEN);
  mocks.assertHostControlPlaneCompatible.mockResolvedValue({
    host: TARGET,
    reachable: true,
    agentVersion: '2.0.0',
    pluginVersion: '3.0.0',
  });
  mocks.agentGet.mockResolvedValue({ hashes: {} });
  mocks.buildPluginUrl.mockReturnValue('http://127.0.0.1:55000/plugins/payara');
  mocks.isLoopbackHost.mockReturnValue(false);
  mocks.openTunnel.mockResolvedValue(tunnel());
  mocks.deployToHost.mockResolvedValue({ success: true, result: { deployed: true } });
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('deploy war control-plane gate and tunnel cleanup', () => {
  it('performs zero hashes/uploads/mutations and closes the tunnel when compatibility fails', async () => {
    const ctx = makeContext();
    const openedTunnel = tunnel();
    mocks.openTunnel.mockResolvedValue(openedTunnel);
    mocks.assertHostControlPlaneCompatible.mockRejectedValue(
      new Error('CONTROL_PLANE_VERSION_INCOMPATIBLE')
    );

    await runDeployWar(ctx, ['--force']);

    expect(mocks.assertHostControlPlaneCompatible).toHaveBeenCalledWith(
      TARGET,
      9100,
      undefined,
      TOKEN
    );
    expect(mocks.agentGet).not.toHaveBeenCalled();
    expect(mocks.deployToHost).not.toHaveBeenCalled();
    expect(openedTunnel.close).toHaveBeenCalledOnce();
    expect(mocks.clearEndpointOverride).toHaveBeenCalledWith(TARGET);
    expect(process.exitCode).toBe(1);
  });

  it('gates before the hashes read and deployment', async () => {
    const ctx = makeContext();
    const openedTunnel = tunnel();
    mocks.openTunnel.mockResolvedValue(openedTunnel);

    await runDeployWar(ctx, []);

    expect(mocks.assertHostControlPlaneCompatible.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.agentGet.mock.invocationCallOrder[0]);
    expect(mocks.agentGet.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.deployToHost.mock.invocationCallOrder[0]);
    expect(openedTunnel.close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it('closes the tunnel before returning a deployment failure', async () => {
    const ctx = makeContext();
    const openedTunnel = tunnel();
    mocks.openTunnel.mockResolvedValue(openedTunnel);
    mocks.deployToHost.mockRejectedValue(new Error('upload failed'));

    await runDeployWar(ctx, ['--force']);

    expect(openedTunnel.close).toHaveBeenCalledOnce();
    expect(mocks.clearEndpointOverride).toHaveBeenCalledWith(TARGET);
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('upload failed')
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects a missing WAR before opening any tunnel', async () => {
    const ctx = makeContext();
    mocks.readLocalWarArtifactSnapshot.mockRejectedValue(new Error('ENOENT'));

    await runDeployWar(ctx, []);

    expect(mocks.openTunnel).not.toHaveBeenCalled();
    expect(mocks.assertHostControlPlaneCompatible).not.toHaveBeenCalled();
    expect(mocks.deployToHost).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
