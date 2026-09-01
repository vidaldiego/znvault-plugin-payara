// Path: src/cli/commands/deploy-war.ts
// Deploy WAR command - single-host deployment with diff transfer

import type { Command } from 'commander';
import type { WarFileHashes } from '../../types.js';
import {
  calculateDiff,
  readLocalWarArtifactSnapshot,
} from '../../war-deployer.js';
import { ProgressReporter } from '../progress.js';
import { ANSI, parsePort } from '../constants.js';
import type { CLIPluginContext } from '../types.js';
import { getErrorMessage } from '../../utils/error.js';
import { deployToHost } from './deploy.js';
import { loadCliMutationAuthToken } from '../auth-token.js';
import { assertHostControlPlaneCompatible } from '../listr-preflight.js';
import {
  agentGet,
  buildPluginUrl,
  setEndpointOverride,
  clearEndpointOverride,
  openTunnel,
  isLoopbackHost,
  type Tunnel,
  type AgentRequestAuth,
} from '@zincapp/znvault-deploy-core';

function payaraRequestAuth(mutationAuthToken: string): AgentRequestAuth {
  return { bearerToken: mutationAuthToken };
}

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
    .option('--mutation-auth-token-file <path>', 'Local private Payara credential file')
    .option('--dry-run', 'Show what would be deployed without deploying')
    .option('--no-tunnel', 'Connect directly to the target instead of via an SSH-CA tunnel')
    .action(async (warFile: string, options: {
      target?: string;
      port: string;
      force?: boolean;
      dryRun?: boolean;
      tunnel?: boolean;
      mutationAuthTokenFile?: string;
    }) => {
      const progress = new ProgressReporter(ctx.isPlainMode());
      const port = parsePort(options.port);

      // Build target URL
      const target = options.target ?? ctx.getConfig().url;
      const host = bareHost(target);

      // Validate local input before opening a long-lived SSH child. Apart from
      // being cheaper, this makes a missing WAR incapable of orphaning a
      // tunnel when the command fails.
      let localSnapshot;
      try {
        localSnapshot = await readLocalWarArtifactSnapshot(warFile);
      } catch {
        ctx.output.error(`WAR file not found: ${warFile}`);
        process.exitCode = 1;
        return;
      }

      let mutationAuthToken: string;
      try {
        mutationAuthToken = loadCliMutationAuthToken(
          options.mutationAuthTokenFile
        );
      } catch (err) {
        ctx.output.error(getErrorMessage(err));
        process.exitCode = 1;
        return;
      }

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
          process.exitCode = 1;
          return;
        }
      }

      let failed = false;
      try {
        progress.analyzing(warFile);

        // Calculate local hashes
        const localHashes = localSnapshot.hashes;
        progress.foundFiles(Object.keys(localHashes).length, localSnapshot.size);

        const pluginUrl = buildPluginUrl(target, port);

        // This command is a separate public mutation rail from `deploy run`.
        // Prove the coordinated Agent 2 / plugin 3 pair even for --force,
        // before hashes, uploads, or any deployment POST can be attempted.
        await assertHostControlPlaneCompatible(
          target,
          port,
          undefined,
          mutationAuthToken
        );

        // Get remote hashes (for dry-run we need to fetch them separately)
        let remoteHashes: WarFileHashes = {};
        let remoteIsEmpty = false;
        if (!options.force) {
          try {
            const response = await agentGet<{ hashes: WarFileHashes }>(
              `${pluginUrl}/hashes`,
              undefined,
              payaraRequestAuth(mutationAuthToken)
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
          progress,
          mutationAuthToken,
          false,
          localSnapshot
        );

        if (result.success && result.result) {
          progress.deployed(result.result);
        } else {
          progress.failed(result.error ?? 'Unknown error');
          failed = true;
        }
      } catch (err) {
        ctx.output.error(`Deployment failed: ${getErrorMessage(err)}`);
        failed = true;
      } finally {
        // Never call process.exit() while a tunnel is live: Node does not run
        // finally blocks on explicit exit and the forward child can survive.
        if (tunnel) {
          clearEndpointOverride(target);
          await tunnel.close();
        }
      }

      if (failed) {
        process.exitCode = 1;
      }
    });
}
