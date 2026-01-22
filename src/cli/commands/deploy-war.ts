// Path: src/cli/commands/deploy-war.ts
// Deploy WAR command - single-host deployment with diff transfer

import type { Command } from 'commander';
import { stat } from 'node:fs/promises';
import type { WarFileHashes } from '../../types.js';
import { calculateWarHashes, calculateDiff } from '../../war-deployer.js';
import { ProgressReporter } from '../progress.js';
import { ANSI, parsePort } from '../constants.js';
import { agentGet, buildPluginUrl } from '../http-client.js';
import type { CLIPluginContext } from '../types.js';
import { getErrorMessage } from '../../utils/error.js';
import { deployToHost } from './deploy.js';

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
    .action(async (warFile: string, options: {
      target?: string;
      port: string;
      force?: boolean;
      dryRun?: boolean;
    }) => {
      const progress = new ProgressReporter(ctx.isPlainMode());

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

        // Build target URL
        const target = options.target ?? ctx.getConfig().url;
        const pluginUrl = buildPluginUrl(target, parsePort(options.port));

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
          parsePort(options.port),
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
      }
    });
}
