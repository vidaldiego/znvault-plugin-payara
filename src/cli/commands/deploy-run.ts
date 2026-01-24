// Path: src/cli/commands/deploy-run.ts
// Deploy run command - multi-host deployment using saved configurations

import type { Command } from 'commander';
import { resolve } from 'node:path';
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
import {
  type CLIPluginContext,
  type PluginVersionCheckResult,
  parseDeploymentStrategy,
  getStrategyDisplayName,
} from '../types.js';
import { getErrorMessage } from '../../utils/error.js';
import { analyzeHost, deployToHost } from './deploy.js';
import { executeStrategy, resolveStrategy } from '../strategy-executor.js';
import { UnifiedProgress, type HostAnalysis } from '../unified-progress.js';
import { formatSize } from '../formatters.js';

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
    .option('-s, --strategy <strategy>', 'Deployment strategy: sequential, parallel, or canary (e.g., 1+R, 1+2, 2+3+R)')
    .option('--skip-preflight', 'Skip pre-flight checks')
    .option('--skip-version-check', 'Skip plugin version check')
    .option('--update-plugins', 'Update plugins if updates are available')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (configName: string, options: {
      force?: boolean;
      dryRun?: boolean;
      sequential?: boolean;
      strategy?: string;
      skipPreflight?: boolean;
      skipVersionCheck?: boolean;
      updatePlugins?: boolean;
      yes?: boolean;
    }) => {
      const progress = new ProgressReporter(ctx.isPlainMode());
      const unified = new UnifiedProgress({ plain: ctx.isPlainMode() });

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

        // Resolve deployment strategy
        const strategyString = resolveStrategy({
          strategy: options.strategy,
          sequential: options.sequential,
          configStrategy: config.strategy,
          configParallel: config.parallel,
        });

        let strategy;
        try {
          strategy = parseDeploymentStrategy(strategyString);
        } catch (err) {
          ctx.output.error(getErrorMessage(err));
          process.exit(1);
        }

        if (!ctx.isPlainMode()) {
          console.log(`${ANSI.dim}  Hosts:    ${ANSI.reset}${config.hosts.length}`);
          progress.showStrategy(getStrategyDisplayName(strategy), strategy.isCanary);
        } else {
          ctx.output.info(`  Hosts: ${config.hosts.length}`);
          ctx.output.info(`  Strategy: ${getStrategyDisplayName(strategy)}`);
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
        const localHashes = await calculateWarHashes(warPath);

        // ═══════════════════════════════════════════════════════════════════
        // PRE-DEPLOYMENT ANALYSIS PHASE
        // Analyze all hosts in parallel to determine what needs to be deployed
        // ═══════════════════════════════════════════════════════════════════

        unified.initHosts(config.hosts);
        unified.setStrategy(getStrategyDisplayName(strategy));
        unified.showAnalysisHeader();

        // Analyze all hosts in parallel
        const analysisPromises = config.hosts.map(host =>
          analyzeHost(host, config.port, localHashes, options.force ?? false)
        );
        const analysisResults = await Promise.all(analysisPromises);

        // Store analysis results and display
        const analysisMap = new Map<string, HostAnalysis>();
        for (const analysis of analysisResults) {
          analysisMap.set(analysis.host, analysis);
          unified.setHostAnalysis(analysis.host, analysis);
          unified.showAnalysisResult(analysis);
        }

        // Show summary
        const { totalFiles, totalBytes } = unified.showAnalysisSummary();

        // Check for failures in analysis
        const failedAnalysis = analysisResults.filter(a => !a.success);
        if (failedAnalysis.length > 0 && !options.yes) {
          console.log('');
          ctx.output.warn(`${failedAnalysis.length} host(s) failed analysis`);

          const inquirerModule = await import('inquirer');
          const inquirer = inquirerModule.default;
          const answers = await inquirer.prompt([{
            type: 'confirm',
            name: 'continue',
            message: 'Continue with deployment to remaining hosts?',
            default: true,
          }]) as { continue: boolean };

          if (!answers.continue) {
            ctx.output.info('Deployment cancelled');
            return;
          }
        }

        // Filter to only successful analyses
        const deployableHosts = config.hosts.filter(h => analysisMap.get(h)?.success);

        if (deployableHosts.length === 0) {
          ctx.output.error('No hosts available for deployment');
          process.exit(1);
        }

        // Check if all hosts have no changes
        const hostsWithChanges = deployableHosts.filter(h => {
          const analysis = analysisMap.get(h);
          return analysis && (analysis.filesChanged > 0 || analysis.filesDeleted > 0);
        });

        if (hostsWithChanges.length === 0) {
          if (!ctx.isPlainMode()) {
            console.log(`\n${ANSI.green}✓${ANSI.reset} All hosts up to date - no deployment needed`);
          } else {
            ctx.output.success('All hosts up to date - no deployment needed');
          }
          return;
        }

        if (options.dryRun) {
          console.log('');
          ctx.output.info(`Dry run - would deploy to ${hostsWithChanges.length} host(s):`);
          for (const host of hostsWithChanges) {
            const analysis = analysisMap.get(host)!;
            const mode = analysis.isFullUpload ? 'full' : 'diff';
            ctx.output.info(`  ${host}: +${analysis.filesChanged} -${analysis.filesDeleted} (${formatSize(analysis.bytesToUpload)}, ${mode})`);
          }
          return;
        }

        // ═══════════════════════════════════════════════════════════════════
        // DEPLOYMENT PHASE
        // Deploy to hosts using the selected strategy
        // ═══════════════════════════════════════════════════════════════════

        console.log('');

        // Enable silent mode - UnifiedProgress handles display
        progress.setSilent(true);

        // Wire up progress callbacks to forward updates to UnifiedProgress
        progress.setOnProgress((host, filesUploaded, _bytesUploaded) => {
          unified.updateHostProgress(host, filesUploaded, 0);
        });
        progress.setOnDeploying((host) => {
          unified.setHostDeploying(host);
        });

        // Deploy function for strategy executor
        const deployFn = async (host: string) => {
          const analysis = analysisMap.get(host);

          // Skip hosts with no changes
          if (analysis && analysis.filesChanged === 0 && analysis.filesDeleted === 0) {
            unified.showNoChanges(host);
            return { success: true, result: {
              success: true,
              filesChanged: 0,
              filesDeleted: 0,
              message: 'No changes',
              deploymentTime: 0,
              appName: '',
            }};
          }

          unified.startHost(host);
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

          if (result.success) {
            unified.setHostDeployed(host);
          } else {
            unified.setHostFailed(host, result.error ?? 'Unknown error');
          }

          return result;
        };

        // Execute deployment strategy
        const executionResult = await executeStrategy(
          strategy,
          deployableHosts,
          deployFn,
          {
            abortOnFailure: strategy.isCanary,
            progress,
          }
        );

        // Handle canary abort
        if (executionResult.aborted) {
          unified.showCanaryAbort(executionResult.failedBatch ?? 1, executionResult.skipped);
        }

        // Show final summary
        unified.finalize();
        const summary = unified.showSummary();

        if (summary.failed > 0 || executionResult.aborted) {
          process.exit(1);
        }
      } catch (err) {
        ctx.output.error(`Deployment failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
