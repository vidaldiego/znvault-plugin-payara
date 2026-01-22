// Path: src/cli/commands/deploy-run.ts
// Deploy run command - multi-host deployment using saved configurations

import type { Command } from 'commander';
import { resolve } from 'node:path';
import type { DeployResult } from '../../types.js';
import { calculateWarHashes } from '../../war-deployer.js';
import { loadDeployConfigs } from '../config-store.js';
import {
  getWarInfo,
  ProgressReporter,
  type WarInfo,
  type PreflightResult,
} from '../progress.js';
import { ANSI } from '../constants.js';
import {
  checkPluginVersions,
  triggerPluginUpdate,
  checkHostReachable,
} from '../host-checks.js';
import type { CLIPluginContext, PluginVersionCheckResult } from '../types.js';
import { getErrorMessage } from '../../utils/error.js';
import { deployToHost } from './deploy.js';

/**
 * Register deploy run command for multi-host deployment
 */
export function registerDeployRunCommand(
  deploy: Command,
  ctx: CLIPluginContext
): void {
  deploy
    .command('run <configName>')
    .alias('to')
    .description('Deploy WAR to all hosts in a saved configuration')
    .option('-f, --force', 'Force full deployment (no diff)')
    .option('--dry-run', 'Show what would be deployed without deploying')
    .option('--sequential', 'Deploy to hosts one at a time (override parallel setting)')
    .option('--skip-preflight', 'Skip pre-flight checks')
    .option('--skip-version-check', 'Skip plugin version check')
    .option('--update-plugins', 'Update plugins if updates are available')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (configName: string, options: {
      force?: boolean;
      dryRun?: boolean;
      sequential?: boolean;
      skipPreflight?: boolean;
      skipVersionCheck?: boolean;
      updatePlugins?: boolean;
      yes?: boolean;
    }) => {
      const progress = new ProgressReporter(ctx.isPlainMode());

      try {
        const store = await loadDeployConfigs();
        const config = store.configs[configName];

        if (!config) {
          ctx.output.error(`Deployment config '${configName}' not found`);
          ctx.output.info('Use "znvault deploy config list" to see available configs');
          process.exit(1);
        }

        if (config.hosts.length === 0) {
          ctx.output.error('No hosts configured for this deployment');
          ctx.output.info(`Use "znvault deploy config add-host ${configName} <host>" to add hosts`);
          process.exit(1);
        }

        // Resolve WAR path and get detailed info
        const warPath = resolve(config.warPath);
        let warInfo: WarInfo;
        try {
          warInfo = await getWarInfo(warPath);
        } catch {
          ctx.output.error(`WAR file not found: ${warPath}`);
          process.exit(1);
        }

        // Header with detailed WAR info
        if (!ctx.isPlainMode()) {
          console.log(`\n${ANSI.bold}Deploying ${ANSI.cyan}${configName}${ANSI.reset}`);
        } else {
          ctx.output.info(`Deploying ${configName}`);
        }
        progress.showWarInfo(warInfo);

        if (!ctx.isPlainMode()) {
          console.log(`${ANSI.dim}  Hosts:    ${ANSI.reset}${config.hosts.length}`);
          console.log(`${ANSI.dim}  Mode:     ${ANSI.reset}${options.sequential || !config.parallel ? 'sequential' : 'parallel'}`);
        } else {
          ctx.output.info(`  Hosts: ${config.hosts.length}`);
          ctx.output.info(`  Mode: ${options.sequential || !config.parallel ? 'sequential' : 'parallel'}`);
        }

        // Pre-flight checks
        if (!options.skipPreflight) {
          progress.showPreflightHeader(config.hosts.length);

          const preflightResults: PreflightResult[] = [];
          for (const [i, host] of config.hosts.entries()) {
            progress.showPreflightChecking(host);
            const result = await checkHostReachable(host, config.port, (attempt, delay, error) => {
              progress.showPreflightRetry(host, attempt, delay, error);
            });
            preflightResults.push(result);
            progress.showPreflightResult(result, i, config.hosts.length);
          }

          const allReachable = progress.showPreflightSummary(preflightResults);

          if (!allReachable && !options.yes) {
            // Ask user if they want to continue
            const unreachableHosts = preflightResults.filter(r => !r.reachable).map(r => r.host);
            console.log('');
            ctx.output.warn(`Unreachable hosts will be skipped: ${unreachableHosts.join(', ')}`);

            // Dynamic import of inquirer
            const inquirerModule = await import('inquirer');
            const inquirer = inquirerModule.default;
            const answers = await inquirer.prompt([{
              type: 'confirm',
              name: 'continue',
              message: 'Continue with deployment to reachable hosts?',
              default: true,
            }]) as { continue: boolean };

            if (!answers.continue) {
              ctx.output.info('Deployment cancelled');
              return;
            }

            // Filter to only reachable hosts
            config.hosts = config.hosts.filter(h =>
              preflightResults.find(r => r.host === h)?.reachable
            );
          }
        }

        // Plugin version check (after preflight so we know hosts are reachable)
        if (!options.skipVersionCheck && !options.skipPreflight) {
          progress.showVersionCheckHeader();

          const versionResults: Array<{ host: string; result: PluginVersionCheckResult }> = [];
          for (const host of config.hosts) {
            const result = await checkPluginVersions(host, config.port);
            versionResults.push({ host, result });
            progress.showVersionCheckResult(host, result);
          }

          const hostsWithUpdates = versionResults.filter(r => r.result.success && r.result.response?.hasUpdates).length;
          const hasUpdates = progress.showVersionSummary(hostsWithUpdates, config.hosts.length);

          if (hasUpdates) {
            if (options.updatePlugins) {
              // Auto-update plugins
              console.log('');
              let hostsRestarting = 0;

              for (const { host, result } of versionResults) {
                if (!result.success || !result.response?.hasUpdates) continue;

                progress.showVersionUpdateHeader(host);
                const updateResult = await triggerPluginUpdate(host, config.port);
                progress.showVersionUpdateResult(host, updateResult);

                if (updateResult.success && updateResult.response?.willRestart) {
                  hostsRestarting++;
                }
              }

              // If any agents are restarting, wait for them
              if (hostsRestarting > 0) {
                console.log('');
                // Wait 25 seconds total for agents to restart (2s delay + 15s restart + buffer)
                const RESTART_WAIT_TIME = 25;
                for (let i = RESTART_WAIT_TIME; i > 0; i--) {
                  progress.showAgentRestartWaiting(i);
                  await new Promise(r => setTimeout(r, 1000));
                }
                progress.showAgentRestartComplete();
              }
            } else if (!options.yes) {
              // Ask user if they want to update
              console.log('');
              const inquirerModule = await import('inquirer');
              const inquirer = inquirerModule.default;
              const answers = await inquirer.prompt([{
                type: 'confirm',
                name: 'update',
                message: 'Update plugins before deploying?',
                default: false,
              }]) as { update: boolean };

              if (answers.update) {
                let hostsRestarting = 0;

                for (const { host, result } of versionResults) {
                  if (!result.success || !result.response?.hasUpdates) continue;

                  progress.showVersionUpdateHeader(host);
                  const updateResult = await triggerPluginUpdate(host, config.port);
                  progress.showVersionUpdateResult(host, updateResult);

                  if (updateResult.success && updateResult.response?.willRestart) {
                    hostsRestarting++;
                  }
                }

                // If any agents are restarting, wait for them
                if (hostsRestarting > 0) {
                  console.log('');
                  const RESTART_WAIT_TIME = 25;
                  for (let i = RESTART_WAIT_TIME; i > 0; i--) {
                    progress.showAgentRestartWaiting(i);
                    await new Promise(r => setTimeout(r, 1000));
                  }
                  progress.showAgentRestartComplete();
                }
              }
            }
          }
        }

        // Calculate local hashes once
        if (!ctx.isPlainMode()) {
          console.log('');
        }
        const localHashes = await calculateWarHashes(warPath);

        if (options.dryRun) {
          ctx.output.info(`Dry run - would deploy ${warInfo.fileCount} files to ${config.hosts.length} host(s)`);
          return;
        }

        const results: Array<{
          host: string;
          success: boolean;
          error?: string;
          result?: DeployResult;
        }> = [];

        const deployToHostWrapper = async (host: string) => {
          progress.setHost(host);
          const result = await deployToHost(
            ctx,
            host,
            config.port,
            warPath,
            localHashes,
            options.force ?? false,
            progress
          );
          results.push({
            host,
            success: result.success,
            error: result.error,
            result: result.result,
          });
          if (result.success && result.result) {
            progress.deployed(result.result);
          } else {
            progress.failed(result.error ?? 'Unknown error');
          }
        };

        if (options.sequential || !config.parallel) {
          // Sequential deployment
          for (const host of config.hosts) {
            await deployToHostWrapper(host);
          }
        } else {
          // Parallel deployment
          await Promise.all(config.hosts.map(deployToHostWrapper));
        }

        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        progress.summary(successful, config.hosts.length, failed);

        if (failed > 0) {
          process.exit(1);
        }
      } catch (err) {
        ctx.output.error(`Deployment failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
