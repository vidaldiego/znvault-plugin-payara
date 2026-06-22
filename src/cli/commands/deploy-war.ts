// Path: src/cli/commands/deploy-war.ts
// Deploy WAR command - single-host deployment with diff transfer

import type { Command } from 'commander';
import { stat } from 'node:fs/promises';
import type { WarFileHashes } from '../../types.js';
import { calculateWarHashes, calculateDiff } from '../../war-deployer.js';
import { ProgressReporter } from '../progress.js';
import { ANSI, parsePort } from '../constants.js';
import { agentGet, buildPluginUrl, setEndpointOverride, clearEndpointOverride } from '../http-client.js';
import type { CLIPluginContext } from '../types.js';
import { getErrorMessage } from '../../utils/error.js';
import { deployToHost } from './deploy.js';
import { openTunnel, isLoopbackHost, type Tunnel } from '../ssh-tunnel.js';

/**
 * Extract the bare host (no scheme, no port, no path) from a target that may be
 * a plain IP/hostname or a URL. Used as the SSH tunnel destination and the
 * endpoint-override key.
 */
function bareHost(target: string): string {
  let h = target.replace(/^[a-z]+:\/\//i, ''); // strip scheme
  h = h.replace(/[/:].*$/, ''); // strip port/path
  return h;
}

/**
 * Register deploy war command for single-host deployment
 */
export function registerDeployWarCommand(
  deploy: Command,
  ctx: CLIPluginContext
): void {
  deploy
    .command('war <warFile>')
    .description('Deploy WAR file using diff transfer (single host)')
    .option('-t, --target <host>', 'Target server URL (default: from profile)')
    .option('-p, --port <port>', 'Agent health port (default: 9100)', '9100')
    .option('-f, --force', 'Force full deployment (no diff)')
    .option('--dry-run', 'Show what would be deployed without deploying')
    .option('--no-tunnel', 'Connect directly to the target instead of via an SSH-CA tunnel')
    .action(async (warFile: string, options: {
      target?: string;
      port: string;
      force?: boolean;
      dryRun?: boolean;
      tunnel?: boolean;
    }) => {
      const progress = new ProgressReporter(ctx.isPlainMode());
      const port = parsePort(options.port);

      // Build target URL
      const target = options.target ?? ctx.getConfig().url;
      const host = bareHost(target);

      // Open an SSH-CA tunnel by default — production agents bind :9100 on
      // loopback only. The override rewrites the URL buildPluginUrl() produces
      // (for BOTH the /hashes fetch and the upload) to the local forward port.
      // Skipped for --no-tunnel or a loopback target.
      let tunnel: Tunnel | undefined;
      const wantTunnel = options.tunnel !== false && !isLoopbackHost(host);
      if (wantTunnel) {
        try {
          tunnel = await openTunnel(host, { remotePort: port });
          setEndpointOverride(target, '127.0.0.1', tunnel.localPort);
          ctx.output.info(`SSH tunnel: ${host} → 127.0.0.1:${tunnel.localPort}`);
        } catch (err) {
          ctx.output.error(`Failed to open SSH tunnel to ${host}: ${getErrorMessage(err)}`);
          ctx.output.error('(use --no-tunnel if the agent is directly reachable)');
          process.exit(1);
        }
      }

      try {
        // Verify WAR file exists
        let warStats;
        try {
          warStats = await stat(warFile);
        } catch {
          ctx.output.error(`WAR file not found: ${warFile}`);
          process.exit(1);
        }

        progress.analyzing(warFile);

        // Calculate local hashes
        const localHashes = await calculateWarHashes(warFile);
        progress.foundFiles(Object.keys(localHashes).length, warStats.size);

        const pluginUrl = buildPluginUrl(target, port);

        // Get remote hashes (for dry-run we need to fetch them separately)
        let remoteHashes: WarFileHashes = {};
        let remoteIsEmpty = false;
        if (!options.force) {
          try {
            const response = await agentGet<{ hashes: WarFileHashes }>(
              `${pluginUrl}/hashes`
            );
            remoteHashes = response.hashes ?? {};
            remoteIsEmpty = Object.keys(remoteHashes).length === 0;
          } catch (err) {
            ctx.output.warn(`Could not fetch remote hashes: ${getErrorMessage(err)}`);
            ctx.output.warn('Will do full deployment');
            remoteIsEmpty = true;
          }
        } else {
          remoteIsEmpty = true;
        }

        // Calculate diff
        const { changed, deleted } = calculateDiff(localHashes, remoteHashes);

        if (remoteIsEmpty) {
          ctx.output.info('Remote has no WAR, will upload full WAR file');
        } else {
          progress.diff(changed.length, deleted.length, changed, deleted);
        }

        // Dry run - just show what would be deployed
        if (options.dryRun) {
          if (remoteIsEmpty) {
            ctx.output.info(`Would upload full WAR (${Object.keys(localHashes).length} files)`);
            return;
          }

          if (changed.length > 0) {
            ctx.output.info('\nFiles to update:');
            for (const file of changed.slice(0, 20)) {
              console.log(`  ${ANSI.green}+${ANSI.reset} ${file}`);
            }
            if (changed.length > 20) {
              console.log(`  ${ANSI.dim}... and ${changed.length - 20} more${ANSI.reset}`);
            }
          }

          if (deleted.length > 0) {
            ctx.output.info('\nFiles to delete:');
            for (const file of deleted.slice(0, 20)) {
              console.log(`  ${ANSI.red}-${ANSI.reset} ${file}`);
            }
            if (deleted.length > 20) {
              console.log(`  ${ANSI.dim}... and ${deleted.length - 20} more${ANSI.reset}`);
            }
          }

          if (changed.length === 0 && deleted.length === 0) {
            progress.noChanges();
          }
          return;
        }

        // Deploy using deployToHost
        progress.setHost(target);
        const result = await deployToHost(
          ctx,
          target,
          port,
          warFile,
          localHashes,
          options.force ?? false,
          progress
        );

        if (result.success && result.result) {
          progress.deployed(result.result);
        } else {
          progress.failed(result.error ?? 'Unknown error');
          process.exit(1);
        }
      } catch (err) {
        ctx.output.error(`Deployment failed: ${getErrorMessage(err)}`);
        process.exit(1);
      } finally {
        // Tear down the tunnel + override on any non-exit path (e.g. dry-run
        // return). process.exit() paths are reaped by the OS.
        if (tunnel) {
          clearEndpointOverride(target);
          await tunnel.close();
        }
      }
    });
}
