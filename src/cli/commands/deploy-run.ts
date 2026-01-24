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
} from '../progress.js';
import { ANSI } from '../constants.js';
import {
  type CLIPluginContext,
  parseDeploymentStrategy,
  getStrategyDisplayName,
} from '../types.js';
import { getErrorMessage } from '../../utils/error.js';
import { resolveStrategy } from '../strategy-executor.js';
import { formatSize } from '../formatters.js';
import { executeListrDeployment, printDeploymentSummary } from '../listr-deploy.js';
import {
  executePreflightChecks,
  executePluginUpdates,
  waitForAgentRestart,
  printPreflightSummary,
} from '../listr-preflight.js';

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
      const isPlain = ctx.isPlainMode();

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
        if (!isPlain) {
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

        if (!isPlain) {
          console.log(`${ANSI.dim}  Hosts:    ${ANSI.reset}${config.hosts.length}`);
          progress.showStrategy(getStrategyDisplayName(strategy), strategy.isCanary);
        } else {
          ctx.output.info(`  Hosts: ${config.hosts.length}`);
          ctx.output.info(`  Strategy: ${getStrategyDisplayName(strategy)}`);
        }

        // ═══════════════════════════════════════════════════════════════════
        // PARALLEL PRE-FLIGHT PHASE
        // Check all hosts in parallel: reachability + version + analysis
        // ═══════════════════════════════════════════════════════════════════

        console.log('');

        // Calculate local hashes (needed for analysis)
        const localHashes = await calculateWarHashes(warPath);

        // Skip preflight entirely if requested
        if (options.skipPreflight) {
          ctx.output.info('Skipping pre-flight checks');
        }

        // Run parallel preflight checks
        if (!isPlain) {
          console.log(`${ANSI.bold}Checking ${config.hosts.length} hosts...${ANSI.reset}`);
        } else {
          console.log(`Checking ${config.hosts.length} hosts...`);
        }

        const preflightResult = await executePreflightChecks({
          hosts: config.hosts,
          port: config.port,
          localHashes,
          force: options.force ?? false,
          skipVersionCheck: options.skipVersionCheck ?? options.skipPreflight ?? false,
          isPlain,
        });

        // Print summary
        printPreflightSummary(preflightResult, config.hosts.length, isPlain);

        // Handle unreachable hosts
        const unreachableHosts = config.hosts.filter(h => !preflightResult.reachableHosts.includes(h));
        if (unreachableHosts.length > 0 && !options.yes) {
          console.log('');
          ctx.output.warn(`Unreachable hosts will be skipped: ${unreachableHosts.join(', ')}`);

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
        }

        // Filter to only reachable hosts
        const reachableHosts = preflightResult.reachableHosts;
        if (reachableHosts.length === 0) {
          ctx.output.error('No hosts reachable for deployment');
          process.exit(1);
        }

        // Handle plugin updates
        if (preflightResult.updateTargets.length > 0) {
          let shouldUpdate = options.updatePlugins ?? false;

          if (!shouldUpdate && !options.yes) {
            console.log('');
            const inquirerModule = await import('inquirer');
            const inquirer = inquirerModule.default;
            const answers = await inquirer.prompt([{
              type: 'confirm',
              name: 'update',
              message: 'Update plugins before deploying?',
              default: false,
            }]) as { update: boolean };
            shouldUpdate = answers.update;
          }

          if (shouldUpdate) {
            console.log('');
            if (!isPlain) {
              console.log(`${ANSI.bold}Updating plugins...${ANSI.reset}`);
            }

            const updateResult = await executePluginUpdates(
              preflightResult.updateTargets,
              config.port,
              isPlain
            );

            // Wait for agents to restart if needed
            if (updateResult.hostsRestarting > 0) {
              console.log('');
              await waitForAgentRestart(25, isPlain);
            }
          }
        }

        // Get analysis results from preflight
        const analysisMap = preflightResult.analysisMap;

        // Check for failures in analysis
        const failedAnalysis = reachableHosts.filter(h => !analysisMap.has(h) || !analysisMap.get(h)?.success);
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
        const deployableHosts = reachableHosts.filter(h => analysisMap.get(h)?.success);

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
          if (!isPlain) {
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
        // Deploy to hosts using Listr2 for proper concurrent progress display
        // ═══════════════════════════════════════════════════════════════════

        console.log('');

        // Execute deployment using Listr2
        const deployResult = await executeListrDeployment(strategy, deployableHosts, {
          ctx,
          warPath,
          localHashes,
          port: config.port,
          force: options.force ?? false,
          analysisMap,
        });

        // Print final summary
        printDeploymentSummary(deployResult, deployableHosts.length, isPlain);

        if (deployResult.failed > 0 || deployResult.aborted) {
          process.exit(1);
        }
      } catch (err) {
        ctx.output.error(`Deployment failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
