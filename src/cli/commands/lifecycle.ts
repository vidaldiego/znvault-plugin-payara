// Path: src/cli/commands/lifecycle.ts
// Server lifecycle commands (restart, status, applications)

import type { Command } from 'commander';
import type { CLIPluginContext } from '../types.js';
import { loadDeployConfigs } from '../config-store.js';
import { ANSI, parsePort } from '../constants.js';
import { agentGet, agentPost, buildPluginUrl } from '../http-client.js';
import { getErrorMessage } from '../../utils/error.js';
import { withErrorHandling } from './helpers.js';

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
    .action(async (configName: string | undefined, options: { target?: string; port: string }) => {
      await withErrorHandling(ctx, async () => {
        if (configName) {
          // Multi-host restart using config
          const store = await loadDeployConfigs();
          const config = store.configs[configName];

          if (!config) {
            ctx.output.error(`Config '${configName}' not found`);
            process.exit(1);
          }

          ctx.output.info(`Restarting Payara on ${config.hosts.length} host(s)...`);

          for (const host of config.hosts) {
            const pluginUrl = buildPluginUrl(host, config.port);
            try {
              await agentPost(`${pluginUrl}/restart`, {});
              console.log(`  ${ANSI.green}✓${ANSI.reset} ${host} restarted`);
            } catch (err) {
              console.log(`  ${ANSI.red}✗${ANSI.reset} ${host}: ${getErrorMessage(err)}`);
            }
          }
        } else {
          // Single host restart
          const target = options.target ?? ctx.getConfig().url;
          const pluginUrl = buildPluginUrl(target, parsePort(options.port));

          ctx.output.info('Restarting Payara...');
          await agentPost(`${pluginUrl}/restart`, {});
          ctx.output.success('Payara restarted');
        }
      }, 'Restart failed');
    });

  // deploy status [configName]
  deploy
    .command('status [configName]')
    .description('Get Payara status from remote server(s)')
    .option('-t, --target <host>', 'Target server URL (single host mode)')
    .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
    .action(async (configName: string | undefined, options: { target?: string; port: string }) => {
      await withErrorHandling(ctx, async () => {
        if (configName) {
          // Multi-host status using config
          const store = await loadDeployConfigs();
          const config = store.configs[configName];

          if (!config) {
            ctx.output.error(`Config '${configName}' not found`);
            process.exit(1);
          }

          console.log(`\n${ANSI.bold}Status for ${configName}:${ANSI.reset}\n`);

          for (const host of config.hosts) {
            const pluginUrl = buildPluginUrl(host, config.port);
            try {
              const status = await agentGet<{
                healthy: boolean;
                running: boolean;
                domain: string;
                appDeployed?: boolean;
                appName?: string;
              }>(`${pluginUrl}/status`);
              const icon = status.healthy && status.appDeployed ? ANSI.green + '✓' : status.running ? ANSI.yellow + '!' : ANSI.red + '✗';
              const state = status.healthy && status.appDeployed ? 'healthy' : status.running ? 'degraded' : 'down';
              const appInfo = status.appDeployed ? `${status.appName || 'app'} deployed` : 'no app';
              console.log(`  ${icon}${ANSI.reset} ${host}: ${state} (${status.domain}, ${appInfo})`);
            } catch {
              console.log(`  ${ANSI.red}✗${ANSI.reset} ${host}: unreachable`);
            }
          }
          console.log();
        } else {
          // Single host status
          const target = options.target ?? ctx.getConfig().url;
          const pluginUrl = buildPluginUrl(target, parsePort(options.port));

          const status = await agentGet<{
            healthy: boolean;
            running: boolean;
            domain: string;
            appDeployed?: boolean;
            appName?: string;
            warPath?: string;
            pid?: number;
          }>(`${pluginUrl}/status`);

          ctx.output.keyValue({
            'Domain': status.domain,
            'Running': status.running,
            'Healthy': status.healthy,
            'App Deployed': status.appDeployed ?? false,
            'App Name': status.appName ?? 'N/A',
            'WAR Path': status.warPath ?? 'N/A',
            'PID': status.pid ?? 'N/A',
          });
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
    .action(async (options: { target?: string; port: string }) => {
      await withErrorHandling(ctx, async () => {
        const target = options.target ?? ctx.getConfig().url;
        const pluginUrl = buildPluginUrl(target, parsePort(options.port));

        const response = await agentGet<{ applications: string[] }>(
          `${pluginUrl}/applications`
        );

        if (response.applications.length === 0) {
          ctx.output.info('No applications deployed');
          return;
        }

        ctx.output.info(`Deployed applications (${response.applications.length}):`);
        for (const app of response.applications) {
          console.log(`  - ${app}`);
        }
      }, 'Failed to list applications');
    });
}
