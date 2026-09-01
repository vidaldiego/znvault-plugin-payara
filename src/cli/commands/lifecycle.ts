// Path: src/cli/commands/lifecycle.ts
// Server lifecycle commands (restart, status, applications)

import type { Command } from 'commander';
import type { CLIPluginContext, DeployConfig } from '../types.js';
import { loadDeployConfigs } from '../config-store.js';
import { ANSI, parsePort } from '../constants.js';
import {
  agentGet,
  agentPost,
  buildPluginUrl,
  clearEndpointOverride,
  openTunnel,
  resolveClass,
  setEndpointOverride,
  type AgentRequestAuth,
  type Tunnel,
} from '@zincapp/znvault-deploy-core';
import { getErrorMessage } from '../../utils/error.js';
import { withErrorHandling } from './helpers.js';
import {
  loadCliMutationAuthToken,
  loadHostMutationAuthTokens,
} from '../auth-token.js';
import { configureTLSForDeployment } from './deploy-run.js';
import { assertHostControlPlaneCompatible } from '../listr-preflight.js';

function payaraRequestAuth(mutationAuthToken: string): AgentRequestAuth {
  return { bearerToken: mutationAuthToken };
}

function bareHost(target: string): string {
  return target
    .replace(/^[a-z]+:\/\//iu, '')
    .replace(/[/:].*$/u, '');
}

interface LifecycleConnection {
  host: string;
  port: number;
  useTLS: boolean;
  pluginUrl: string;
  mutationAuthToken: string;
  tunnel?: Tunnel;
  /** Direct HTTPS policy to reactivate immediately before this request. */
  directConfig?: DeployConfig;
}

async function closeLifecycleConnections(
  connections: readonly LifecycleConnection[]
): Promise<void> {
  for (const connection of connections) {
    if (!connection.tunnel) continue;
    clearEndpointOverride(connection.host);
    await connection.tunnel.close().catch(() => undefined);
  }
}

function configLifecycleTargets(config: DeployConfig): Array<{
  host: string;
  config: DeployConfig;
}> {
  const normalized = { ...config, tunnel: config.tunnel ?? true };
  if (!normalized.classes) {
    return (normalized.hosts ?? []).map(host => ({ host, config: normalized }));
  }
  return normalized.classes.flatMap(cls => {
    const resolved = resolveClass(normalized, cls);
    return resolved.hosts.map(host => ({
      host,
      config: {
        ...normalized,
        port: resolved.port,
        tls: resolved.tls,
        tunnel: resolved.tunnel,
        ssh: resolved.ssh,
      },
    }));
  });
}

function assertLifecycleTargetSet(
  configName: string,
  targets: readonly { host: string }[]
): void {
  if (targets.length === 0) {
    throw new Error(
      `Lifecycle config '${configName}' has no target hosts; no request was sent`
    );
  }
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.host)) {
      throw new Error(
        `Lifecycle config '${configName}' contains duplicate host ` +
        `'${target.host}'; no request was sent`
      );
    }
    seen.add(target.host);
  }
}

/** Pre-open every requested tunnel so one failure cannot cause partial mutation. */
async function prepareConfigLifecycleConnections(
  config: DeployConfig,
  ctx: CLIPluginContext,
  tokenFileOverride?: string
): Promise<LifecycleConnection[]> {
  const targets = configLifecycleTargets(config);
  assertLifecycleTargetSet(config.name, targets);
  const tokens = loadHostMutationAuthTokens(
    config,
    targets.map(target => target.host),
    tokenFileOverride
  );
  const connections: LifecycleConnection[] = [];
  try {
    for (const target of targets) {
      const mutationAuthToken = tokens.get(target.host)!;
      if (target.config.tunnel !== false) {
        const tunnel = await openTunnel(bareHost(target.host), {
          user: target.config.ssh?.user,
          remotePort: target.config.port,
          readinessTimeoutMs: target.config.ssh?.readinessTimeoutMs,
        });
        setEndpointOverride(target.host, '127.0.0.1', tunnel.localPort);
        connections.push({
          host: target.host,
          port: target.config.port ?? 9100,
          useTLS: false,
          pluginUrl: buildPluginUrl(target.host, target.config.port ?? 9100),
          mutationAuthToken,
          tunnel,
        });
      } else {
        const { port, useTLS } = configureTLSForDeployment(target.config, ctx);
        connections.push({
          host: target.host,
          port,
          useTLS,
          pluginUrl: buildPluginUrl(target.host, port, useTLS),
          mutationAuthToken,
          directConfig: target.config,
        });
      }
    }
    return connections;
  } catch (err) {
    await closeLifecycleConnections(connections);
    throw new Error(
      `Lifecycle connection preflight failed; no request was sent: ${getErrorMessage(err)}`
    );
  }
}

/**
 * Snapshot compatibility for the complete restart target set before the first
 * lifecycle mutation. A later incompatible host can therefore never be
 * discovered after an earlier host has already restarted.
 */
async function assertLifecycleConnectionsCompatible(
  connections: readonly LifecycleConnection[],
  ctx: CLIPluginContext
): Promise<void> {
  for (const connection of connections) {
    activateLifecycleTransport(connection, ctx);
    await assertHostControlPlaneCompatible(
      connection.host,
      connection.port,
      connection.useTLS,
      connection.mutationAuthToken
    );
  }
}

function activateLifecycleTransport(
  connection: LifecycleConnection,
  ctx: CLIPluginContext
): void {
  if (connection.directConfig) {
    // deploy-core TLS configuration is process-global. Lifecycle requests are
    // deliberately sequential, so reapply the owning host/class policy at the
    // request boundary and never let a later class's CA bleed into this host.
    configureTLSForDeployment(connection.directConfig, ctx);
  }
}

async function prepareSingleLifecycleConnection(
  target: string,
  port: number,
  mutationAuthToken: string,
  useTunnel: boolean
): Promise<LifecycleConnection> {
  if (!useTunnel) {
    return {
      host: target,
      port,
      useTLS: false,
      pluginUrl: buildPluginUrl(target, port),
      mutationAuthToken,
    };
  }
  try {
    const tunnel = await openTunnel(bareHost(target), { remotePort: port });
    setEndpointOverride(target, '127.0.0.1', tunnel.localPort);
    return {
      host: target,
      port,
      useTLS: false,
      pluginUrl: buildPluginUrl(target, port),
      mutationAuthToken,
      tunnel,
    };
  } catch (err) {
    throw new Error(
      `SSH tunnel failed; refusing direct credential fallback: ${getErrorMessage(err)}`
    );
  }
}

/**
 * Register lifecycle commands (restart, status, applications)
 */
export function registerLifecycleCommands(
  deploy: Command,
  ctx: CLIPluginContext
): void {
  // deploy restart [configName]
  deploy
    .command('restart [configName]')
    .description('Restart Payara on remote server(s)')
    .option('-t, --target <host>', 'Target server URL (single host mode)')
    .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
    .option('--no-tunnel', 'Connect directly (requires loopback or verified HTTPS)')
    .option('--mutation-auth-token-file <path>', 'Local private Payara credential file')
    .action(async (configName: string | undefined, options: {
      target?: string;
      port: string;
      tunnel?: boolean;
      mutationAuthTokenFile?: string;
    }) => {
      await withErrorHandling(ctx, async () => {
        if (configName) {
          // Multi-host restart using config
          const store = await loadDeployConfigs();
          const config = store.configs[configName];

          if (!config) {
            ctx.output.error(`Config '${configName}' not found`);
            process.exit(1);
          }
          const connections = await prepareConfigLifecycleConnections(
            config,
            ctx,
            options.mutationAuthTokenFile
          );
          const failedHosts: string[] = [];
          try {
            await assertLifecycleConnectionsCompatible(connections, ctx);
            ctx.output.info(`Restarting Payara on ${connections.length} host(s)...`);

            for (const connection of connections) {
              try {
                activateLifecycleTransport(connection, ctx);
                await agentPost(
                  `${connection.pluginUrl}/restart`,
                  {},
                  undefined,
                  payaraRequestAuth(connection.mutationAuthToken)
                );
                console.log(`  ${ANSI.green}✓${ANSI.reset} ${connection.host} restarted`);
              } catch (err) {
                failedHosts.push(connection.host);
                console.log(
                  `  ${ANSI.red}✗${ANSI.reset} ${connection.host}: ${getErrorMessage(err)}`
                );
              }
            }
          } finally {
            await closeLifecycleConnections(connections);
          }
          if (failedHosts.length > 0) {
            throw new Error(
              `Restart failed on ${failedHosts.length} of ${connections.length} host(s): ` +
              failedHosts.join(', ')
            );
          }
        } else {
          // Single host restart
          const target = options.target ?? ctx.getConfig().url;
          const mutationAuthToken = loadCliMutationAuthToken(
            options.mutationAuthTokenFile
          );
          const connection = await prepareSingleLifecycleConnection(
            target,
            parsePort(options.port),
            mutationAuthToken,
            options.tunnel !== false
          );
          try {
            await assertLifecycleConnectionsCompatible([connection], ctx);
            ctx.output.info('Restarting Payara...');
            await agentPost(
              `${connection.pluginUrl}/restart`,
              {},
              undefined,
              payaraRequestAuth(connection.mutationAuthToken)
            );
            ctx.output.success('Payara restarted');
          } finally {
            await closeLifecycleConnections([connection]);
          }
        }
      }, 'Restart failed');
    });

  // deploy status [configName]
  deploy
    .command('status [configName]')
    .description('Get Payara status from remote server(s)')
    .option('-t, --target <host>', 'Target server URL (single host mode)')
    .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
    .option('--no-tunnel', 'Connect directly (requires loopback or verified HTTPS)')
    .option('--mutation-auth-token-file <path>', 'Local private Payara credential file')
    .action(async (configName: string | undefined, options: {
      target?: string;
      port: string;
      tunnel?: boolean;
      mutationAuthTokenFile?: string;
    }) => {
      await withErrorHandling(ctx, async () => {
        if (configName) {
          // Multi-host status using config
          const store = await loadDeployConfigs();
          const config = store.configs[configName];

          if (!config) {
            ctx.output.error(`Config '${configName}' not found`);
            process.exit(1);
          }
          const connections = await prepareConfigLifecycleConnections(
            config,
            ctx,
            options.mutationAuthTokenFile
          );

          console.log(`\n${ANSI.bold}Status for ${configName}:${ANSI.reset}\n`);

          const failedHosts: string[] = [];
          try {
            for (const connection of connections) {
              try {
                activateLifecycleTransport(connection, ctx);
                const status = await agentGet<{
                  healthy: boolean;
                  running: boolean;
                  domain: string;
                  appDeployed?: boolean;
                  appName?: string;
                  bootDeployment?: {
                    phase: string;
                    readiness: string;
                    mutationOutcomeUnknown: boolean;
                  };
                }>(
                  `${connection.pluginUrl}/status`,
                  undefined,
                  payaraRequestAuth(connection.mutationAuthToken)
                );
                const icon = status.healthy && status.appDeployed ? ANSI.green + '✓' : status.running ? ANSI.yellow + '!' : ANSI.red + '✗';
                const state = status.healthy && status.appDeployed ? 'healthy' : status.running ? 'degraded' : 'down';
                const appInfo = status.appDeployed ? `${status.appName || 'app'} deployed` : 'no app';
                console.log(`  ${icon}${ANSI.reset} ${connection.host}: ${state} (${status.domain}, ${appInfo})`);
              } catch (err) {
                failedHosts.push(connection.host);
                console.log(
                  `  ${ANSI.red}✗${ANSI.reset} ${connection.host}: ` +
                  `unreachable (${getErrorMessage(err)})`
                );
              }
            }
          } finally {
            await closeLifecycleConnections(connections);
          }
          console.log();
          if (failedHosts.length > 0) {
            throw new Error(
              `Status failed on ${failedHosts.length} of ${connections.length} host(s): ` +
              failedHosts.join(', ')
            );
          }
        } else {
          // Single host status
          const target = options.target ?? ctx.getConfig().url;
          const mutationAuthToken = loadCliMutationAuthToken(
            options.mutationAuthTokenFile
          );
          const connection = await prepareSingleLifecycleConnection(
            target,
            parsePort(options.port),
            mutationAuthToken,
            options.tunnel !== false
          );
          try {
            const status = await agentGet<{
              healthy: boolean;
              running: boolean;
              domain: string;
              appDeployed?: boolean;
              appName?: string;
              warPath?: string;
              pid?: number;
              bootDeployment?: {
                bootEpoch: string;
                phase: string;
                readiness: string;
                mutationOutcomeUnknown: boolean;
              };
            }>(
              `${connection.pluginUrl}/status`,
              undefined,
              payaraRequestAuth(connection.mutationAuthToken)
            );

            ctx.output.keyValue({
              'Domain': status.domain,
              'Running': status.running,
              'Healthy': status.healthy,
              'App Deployed': status.appDeployed ?? false,
              'App Name': status.appName ?? 'N/A',
              'Boot Epoch': status.bootDeployment?.bootEpoch ?? 'N/A',
              'Boot Fence': status.bootDeployment?.phase ?? 'N/A',
              'Boot Readiness': status.bootDeployment?.readiness ?? 'N/A',
              'Mutation Outcome Unknown': status.bootDeployment?.mutationOutcomeUnknown ?? false,
              'WAR Path': status.warPath ?? 'N/A',
              'PID': status.pid ?? 'N/A',
            });
          } finally {
            await closeLifecycleConnections([connection]);
          }
        }
      }, 'Failed to get status');
    });

  // deploy applications
  deploy
    .command('applications')
    .alias('apps')
    .description('List deployed applications')
    .option('-t, --target <host>', 'Target server URL')
    .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
    .option('--no-tunnel', 'Connect directly (requires loopback or verified HTTPS)')
    .option('--mutation-auth-token-file <path>', 'Local private Payara credential file')
    .action(async (options: {
      target?: string;
      port: string;
      tunnel?: boolean;
      mutationAuthTokenFile?: string;
    }) => {
      await withErrorHandling(ctx, async () => {
        const target = options.target ?? ctx.getConfig().url;
        const mutationAuthToken = loadCliMutationAuthToken(
          options.mutationAuthTokenFile
        );
        const connection = await prepareSingleLifecycleConnection(
          target,
          parsePort(options.port),
          mutationAuthToken,
          options.tunnel !== false
        );
        try {
          const response = await agentGet<{ applications: string[] }>(
            `${connection.pluginUrl}/applications`,
            undefined,
            payaraRequestAuth(connection.mutationAuthToken)
          );

          if (response.applications.length === 0) {
            ctx.output.info('No applications deployed');
            return;
          }

          ctx.output.info(`Deployed applications (${response.applications.length}):`);
          for (const app of response.applications) {
            console.log(`  - ${app}`);
          }
        } finally {
          await closeLifecycleConnections([connection]);
        }
      }, 'Failed to list applications');
    });
}
