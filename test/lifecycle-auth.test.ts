import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type { CLIPluginContext, DeployConfig } from '../src/cli/types.js';

const mocks = vi.hoisted(() => ({
  agentGet: vi.fn(),
  agentPost: vi.fn(),
  openTunnel: vi.fn(),
  setEndpointOverride: vi.fn(),
  clearEndpointOverride: vi.fn(),
  loadDeployConfigs: vi.fn(),
  loadCliMutationAuthToken: vi.fn(),
  loadHostMutationAuthTokens: vi.fn(),
  configureTLSForDeployment: vi.fn(),
  assertHostControlPlaneCompatible: vi.fn(),
}));

vi.mock('@zincapp/znvault-deploy-core', async importActual => {
  const actual = await importActual<typeof import('@zincapp/znvault-deploy-core')>();
  return {
    ...actual,
    agentGet: mocks.agentGet,
    agentPost: mocks.agentPost,
    openTunnel: mocks.openTunnel,
    setEndpointOverride: mocks.setEndpointOverride,
    clearEndpointOverride: mocks.clearEndpointOverride,
    buildPluginUrl: vi.fn(
      (host: string) => `http://127.0.0.1:55000/plugins/payara?target=${host}`
    ),
  };
});

vi.mock('../src/cli/config-store.js', () => ({
  loadDeployConfigs: mocks.loadDeployConfigs,
}));

vi.mock('../src/cli/auth-token.js', () => ({
  loadCliMutationAuthToken: mocks.loadCliMutationAuthToken,
  loadHostMutationAuthTokens: mocks.loadHostMutationAuthTokens,
}));

vi.mock('../src/cli/commands/deploy-run.js', () => ({
  configureTLSForDeployment: mocks.configureTLSForDeployment,
}));

vi.mock('../src/cli/listr-preflight.js', () => ({
  assertHostControlPlaneCompatible: mocks.assertHostControlPlaneCompatible,
}));

import { registerLifecycleCommands } from '../src/cli/commands/lifecycle.js';

const TOKEN = 'lifecycle-control-token-0123456789abcdef';

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
    getConfig: () => ({ url: 'agent.example.test' }),
    isPlainMode: () => true,
  };
}

async function runLifecycle(
  ctx: CLIPluginContext,
  argv: string[],
  expectExit = false
): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerLifecycleCommands(program, ctx);
  const realExit = process.exit;
  // @ts-expect-error deterministic test replacement
  process.exit = () => {
    throw new Error('__exit__');
  };
  try {
    await program.parseAsync(['node', 'znvault', ...argv]);
  } catch (err) {
    if (!expectExit || (err as Error).message !== '__exit__') throw err;
  } finally {
    process.exit = realExit;
  }
}

function tunnel(localPort = 55000) {
  return {
    localPort,
    pid: 1234,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadCliMutationAuthToken.mockReturnValue(TOKEN);
  mocks.loadHostMutationAuthTokens.mockImplementation(
    (_config: DeployConfig, hosts: string[]) =>
      new Map(hosts.map(host => [host, TOKEN]))
  );
  mocks.openTunnel.mockImplementation(async () => tunnel());
  mocks.configureTLSForDeployment.mockImplementation((config: DeployConfig) => ({
    port: config.tls?.httpsPort ?? 9443,
    useTLS: true,
  }));
  mocks.assertHostControlPlaneCompatible.mockResolvedValue({
    host: 'agent.example.test',
    reachable: true,
    agentVersion: '2.0.0',
    pluginVersion: '3.0.0',
    pluginRunning: true,
  });
  mocks.agentPost.mockResolvedValue({ ok: true });
  mocks.agentGet.mockResolvedValue({
    healthy: true,
    running: true,
    domain: 'production',
    appDeployed: true,
    applications: ['ZincAPI'],
  });
});

describe('lifecycle control-plane authorization', () => {
  it('sends the dedicated Bearer via AgentRequestAuth and closes the tunnel', async () => {
    const ctx = makeContext();
    const openedTunnel = tunnel();
    mocks.openTunnel.mockResolvedValue(openedTunnel);

    await runLifecycle(ctx, [
      'restart',
      '--target',
      'agent.example.test',
      '--mutation-auth-token-file',
      '/private/token',
    ]);

    expect(mocks.loadCliMutationAuthToken).toHaveBeenCalledWith('/private/token');
    expect(mocks.assertHostControlPlaneCompatible).toHaveBeenCalledWith(
      'agent.example.test',
      9100,
      false,
      TOKEN
    );
    expect(mocks.agentPost).toHaveBeenCalledWith(
      expect.stringContaining('/plugins/payara'),
      {},
      undefined,
      { bearerToken: TOKEN }
    );
    expect(openedTunnel.close).toHaveBeenCalledOnce();
    expect(mocks.clearEndpointOverride).toHaveBeenCalledWith('agent.example.test');
  });

  it('pre-opens every fleet tunnel before the first lifecycle mutation', async () => {
    const ctx = makeContext();
    const config: DeployConfig = {
      name: 'fleet',
      hosts: ['agent-a.example.test', 'agent-b.example.test'],
      port: 9100,
      tunnel: true,
    };
    mocks.loadDeployConfigs.mockResolvedValue({ configs: { fleet: config } });

    await runLifecycle(ctx, ['restart', 'fleet']);

    expect(mocks.openTunnel).toHaveBeenCalledTimes(2);
    expect(mocks.assertHostControlPlaneCompatible).toHaveBeenCalledTimes(2);
    expect(mocks.agentPost).toHaveBeenCalledTimes(2);
    expect(mocks.openTunnel.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.assertHostControlPlaneCompatible.mock.invocationCallOrder[0]
    );
    expect(mocks.assertHostControlPlaneCompatible.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.agentPost.mock.invocationCallOrder[0]
    );
    for (const call of mocks.agentPost.mock.calls) {
      expect(call[3]).toEqual({ bearerToken: TOKEN });
    }
  });

  it('preflights the complete fleet and performs zero restarts when a later host is incompatible', async () => {
    const ctx = makeContext();
    const firstTunnel = tunnel(55001);
    const secondTunnel = tunnel(55002);
    mocks.loadDeployConfigs.mockResolvedValue({
      configs: {
        fleet: {
          name: 'fleet',
          hosts: ['agent-a.example.test', 'agent-b.example.test'],
          port: 9100,
          tunnel: true,
        },
      },
    });
    mocks.openTunnel
      .mockResolvedValueOnce(firstTunnel)
      .mockResolvedValueOnce(secondTunnel);
    mocks.assertHostControlPlaneCompatible
      .mockResolvedValueOnce({
        host: 'agent-a.example.test',
        reachable: true,
        agentVersion: '2.0.0',
        pluginVersion: '3.0.0',
      })
      .mockRejectedValueOnce(new Error('CONTROL_PLANE_VERSION_INCOMPATIBLE'));

    await runLifecycle(ctx, ['restart', 'fleet'], true);

    expect(mocks.assertHostControlPlaneCompatible).toHaveBeenCalledTimes(2);
    expect(mocks.agentPost).not.toHaveBeenCalled();
    expect(firstTunnel.close).toHaveBeenCalledOnce();
    expect(secondTunnel.close).toHaveBeenCalledOnce();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('CONTROL_PLANE_VERSION_INCOMPATIBLE')
    );
  });

  it('returns non-zero after a partial fleet restart while preserving the receipt', async () => {
    const ctx = makeContext();
    mocks.loadDeployConfigs.mockResolvedValue({
      configs: {
        fleet: {
          name: 'fleet',
          hosts: ['agent-a.example.test', 'agent-b.example.test'],
          port: 9100,
          tunnel: true,
        },
      },
    });
    mocks.agentPost
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('401 Unauthorized'));

    await runLifecycle(ctx, ['restart', 'fleet'], true);

    expect(mocks.agentPost).toHaveBeenCalledTimes(2);
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringMatching(/Restart failed.*1 of 2.*agent-b/u)
    );
    expect(mocks.clearEndpointOverride).toHaveBeenCalledTimes(2);
  });

  it('returns non-zero when every fleet restart fails', async () => {
    const ctx = makeContext();
    mocks.loadDeployConfigs.mockResolvedValue({
      configs: {
        fleet: {
          name: 'fleet',
          hosts: ['agent-a.example.test', 'agent-b.example.test'],
          port: 9100,
          tunnel: true,
        },
      },
    });
    mocks.agentPost.mockRejectedValue(new Error('timeout'));

    await runLifecycle(ctx, ['restart', 'fleet'], true);

    expect(mocks.agentPost).toHaveBeenCalledTimes(2);
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringMatching(/Restart failed.*2 of 2.*agent-a.*agent-b/u)
    );
    expect(mocks.clearEndpointOverride).toHaveBeenCalledTimes(2);
  });

  it('fails closed with zero requests when a later fleet tunnel fails', async () => {
    const ctx = makeContext();
    const firstTunnel = tunnel();
    mocks.loadDeployConfigs.mockResolvedValue({
      configs: {
        fleet: {
          name: 'fleet',
          hosts: ['agent-a.example.test', 'agent-b.example.test'],
          port: 9100,
          tunnel: true,
        },
      },
    });
    mocks.openTunnel
      .mockResolvedValueOnce(firstTunnel)
      .mockRejectedValueOnce(new Error('ssh refused'));

    await runLifecycle(ctx, ['restart', 'fleet'], true);

    expect(mocks.agentPost).not.toHaveBeenCalled();
    expect(mocks.agentGet).not.toHaveBeenCalled();
    expect(firstTunnel.close).toHaveBeenCalledOnce();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringContaining('no request was sent')
    );
  });

  it.each([
    ['an empty target set', []],
    ['a duplicate target', ['agent-a.example.test', 'agent-a.example.test']],
  ])('rejects %s before loading credentials, tunnels, or requests', async (_label, hosts) => {
    const ctx = makeContext();
    mocks.loadDeployConfigs.mockResolvedValue({
      configs: {
        fleet: {
          name: 'fleet',
          hosts,
          port: 9100,
          tunnel: true,
        },
      },
    });

    await runLifecycle(ctx, ['restart', 'fleet'], true);

    expect(mocks.loadHostMutationAuthTokens).not.toHaveBeenCalled();
    expect(mocks.openTunnel).not.toHaveBeenCalled();
    expect(mocks.assertHostControlPlaneCompatible).not.toHaveBeenCalled();
    expect(mocks.agentPost).not.toHaveBeenCalled();
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringMatching(/no target hosts|duplicate host/u)
    );
  });

  it('reapplies each direct class TLS policy at its request boundary', async () => {
    const ctx = makeContext();
    mocks.loadDeployConfigs.mockResolvedValue({
      configs: {
        fleet: {
          name: 'fleet',
          tunnel: false,
          classes: [
            {
              name: 'api',
              hosts: ['agent-a.example.test'],
              tls: { caCertPath: '/private/ca-a.pem', httpsPort: 9443 },
            },
            {
              name: 'worker',
              hosts: ['agent-b.example.test'],
              tls: { caCertPath: '/private/ca-b.pem', httpsPort: 9553 },
            },
          ],
        },
      },
    });

    await runLifecycle(ctx, ['status', 'fleet']);

    expect(mocks.configureTLSForDeployment.mock.calls.map(call =>
      (call[0] as DeployConfig).tls?.caCertPath
    )).toEqual([
      '/private/ca-a.pem',
      '/private/ca-b.pem',
      '/private/ca-a.pem',
      '/private/ca-b.pem',
    ]);
    expect(mocks.configureTLSForDeployment.mock.invocationCallOrder[2])
      .toBeLessThan(mocks.agentGet.mock.invocationCallOrder[0]);
    expect(mocks.agentGet.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.configureTLSForDeployment.mock.invocationCallOrder[3]);
    expect(mocks.configureTLSForDeployment.mock.invocationCallOrder[3])
      .toBeLessThan(mocks.agentGet.mock.invocationCallOrder[1]);
  });

  it('returns non-zero when a fleet status readback is incomplete', async () => {
    const ctx = makeContext();
    mocks.loadDeployConfigs.mockResolvedValue({
      configs: {
        fleet: {
          name: 'fleet',
          hosts: ['agent-a.example.test', 'agent-b.example.test'],
          port: 9100,
          tunnel: true,
        },
      },
    });
    mocks.agentGet
      .mockResolvedValueOnce({
        healthy: true,
        running: true,
        domain: 'production',
        appDeployed: true,
      })
      .mockRejectedValueOnce(new Error('401 Unauthorized'));

    await runLifecycle(ctx, ['status', 'fleet'], true);

    expect(mocks.agentGet).toHaveBeenCalledTimes(2);
    expect(ctx.output.error).toHaveBeenCalledWith(
      expect.stringMatching(/Status failed.*1 of 2.*agent-b/u)
    );
  });

  it.each([
    ['status', 'agentGet'],
    ['applications', 'agentGet'],
  ])('authenticates %s readbacks', async command => {
    const ctx = makeContext();

    await runLifecycle(ctx, [command, '--target', 'agent.example.test']);

    expect(mocks.agentGet).toHaveBeenCalledWith(
      expect.stringContaining('/plugins/payara'),
      undefined,
      { bearerToken: TOKEN }
    );
  });
});
