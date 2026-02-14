// Path: src/cli/commands/deploy-run.ts
// Deploy run command - multi-host deployment using saved configurations

import type { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
  type DeployConfig,
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
import { configureTLS } from '../http-client.js';
import { getUnmappedHosts, testHAProxyConnectivity } from '../haproxy.js';

/** Default CA certificate path */
const DEFAULT_CA_PATH = join(homedir(), '.znvault', 'ca', 'agent-tls-ca.pem');

/**
 * Configure TLS for deployment based on config settings
 * Returns the effective port to use (HTTP or HTTPS)
 */
function configureTLSForDeployment(config: DeployConfig, ctx: CLIPluginContext): { port: number; useTLS: boolean } {
  const tlsConfig = config.tls;

  // No TLS configured - use HTTP
  if (!tlsConfig || tlsConfig.verify === false) {
    if (tlsConfig?.verify === false) {
      // Explicitly disabled TLS verification (insecure mode)
      configureTLS({ verify: false });
      return { port: tlsConfig.httpsPort ?? 9443, useTLS: true };
    }
    return { port: config.port, useTLS: false };
  }

  // TLS enabled - determine CA certificate path
  let caCertPath: string | undefined;

  if (tlsConfig.caCertPath) {
    // Explicit CA path provided
    caCertPath = tlsConfig.caCertPath;
  } else if (tlsConfig.useVaultCA !== false) {
    // Use vault CA (default)
    caCertPath = DEFAULT_CA_PATH;
  }

  // Verify CA certificate exists
  if (caCertPath && !existsSync(caCertPath)) {
    ctx.output.warn(`CA certificate not found at ${caCertPath}`);
    ctx.output.info('Run "znvault deploy tls setup" to fetch CA from vault');
    ctx.output.info('Falling back to HTTP (insecure)');
    return { port: config.port, useTLS: false };
  }

  // Configure TLS
  configureTLS({
    verify: true,
    caCertPath,
  });

  return { port: tlsConfig.httpsPort ?? 9443, useTLS: true };
}

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
    .option('--skip-drain', 'Skip HAProxy drain/ready operations')
    .option('--update-plugins', 'Update plugins if updates are available')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (configName: string, options: {
      force?: boolean;
      dryRun?: boolean;
      sequential?: boolean;
      strategy?: string;
      skipPreflight?: boolean;
      skipVersionCheck?: boolean;
      skipDrain?: boolean;
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

        // Configure TLS if enabled
        const { port: effectivePort, useTLS } = configureTLSForDeployment(config, ctx);

        // Header with detailed WAR info
        if (!isPlain) {
          console.log(`\n${ANSI.bold}Deploying ${ANSI.cyan}${configName}${ANSI.reset}`);
        } else {
          ctx.output.info(`Deploying ${configName}`);
        }
        progress.showWarInfo(warInfo);

        // Show TLS status
        if (useTLS && !isPlain) {
          console.log(`${ANSI.dim}  TLS:      ${ANSI.reset}${ANSI.green}enabled${ANSI.reset} (HTTPS port ${effectivePort})`);
        } else if (useTLS && isPlain) {
          ctx.output.info(`  TLS: enabled (HTTPS port ${effectivePort})`);
        }

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

        // HAProxy drain/ready info
        const haproxyConfig = (!options.skipDrain && config.haproxy) ? config.haproxy : undefined;
        if (config.haproxy && options.skipDrain) {
          if (!isPlain) {
            console.log(`${ANSI.dim}  HAProxy:  ${ANSI.reset}${ANSI.yellow}skipped${ANSI.reset} (--skip-drain)`);
          } else {
            ctx.output.info('  HAProxy: skipped (--skip-drain)');
          }
        } else if (haproxyConfig) {
          const mappedCount = config.hosts.filter(h => haproxyConfig.serverMap[h]).length;
          const unmapped = getUnmappedHosts(haproxyConfig, config.hosts);
          if (!isPlain) {
            console.log(`${ANSI.dim}  HAProxy:  ${ANSI.reset}${ANSI.green}enabled${ANSI.reset} (${haproxyConfig.hosts.length} LB, ${mappedCount} mapped)`);
          } else {
            ctx.output.info(`  HAProxy: enabled (${haproxyConfig.hosts.length} LB, ${mappedCount} mapped)`);
          }
          if (unmapped.length > 0) {
            ctx.output.warn(`  Unmapped hosts (will deploy without drain): ${unmapped.join(', ')}`);
          }
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
          port: effectivePort,
          localHashes,
          force: options.force ?? false,
          skipVersionCheck: options.skipVersionCheck ?? options.skipPreflight ?? false,
          isPlain,
          useTLS,
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
              effectivePort,
              isPlain,
              useTLS
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

        // HAProxy connectivity pre-check
        if (haproxyConfig) {
          if (!isPlain) {
            console.log(`${ANSI.dim}Checking HAProxy connectivity...${ANSI.reset}`);
          } else {
            console.log('Checking HAProxy connectivity...');
          }
          const connResult = await testHAProxyConnectivity(haproxyConfig);
          if (!connResult.success) {
            const failed = connResult.results.filter(r => !r.success);
            for (const f of failed) {
              ctx.output.error(`  HAProxy ${f.host}: ${f.error}`);
            }
            ctx.output.error('Cannot reach all HAProxy hosts. Use --skip-drain to deploy without drain/ready.');
            process.exit(1);
          }
          if (!isPlain) {
            console.log(`${ANSI.green}✓${ANSI.reset} All ${haproxyConfig.hosts.length} HAProxy hosts reachable\n`);
          } else {
            console.log(`All ${haproxyConfig.hosts.length} HAProxy hosts reachable`);
          }
        }

        // Execute deployment using Listr2
        const deployResult = await executeListrDeployment(strategy, deployableHosts, {
          ctx,
          warPath,
          localHashes,
          port: effectivePort,
          force: options.force ?? false,
          analysisMap,
          healthCheck: config.healthCheck,
          useTLS,
          haproxy: haproxyConfig,
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
