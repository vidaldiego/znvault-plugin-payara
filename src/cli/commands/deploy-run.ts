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
import { executeListrDeployment, printDeploymentSummary, partitionHostsByClass, type ListrDeployOptions } from '../listr-deploy.js';
import {
  executePreflightChecks,
  executePluginUpdates,
  waitForAgentRestart,
  printPreflightSummary,
} from '../listr-preflight.js';
import {
  configureTLS,
  setEndpointOverride,
  clearEndpointOverride,
  clearAllEndpointOverrides,
} from '../http-client.js';
import { openTunnel, type Tunnel } from '../ssh-tunnel.js';
import { getUnmappedHosts, testHAProxyConnectivity } from '../haproxy.js';
import { resolveClass, partitionSelectedClasses } from '../deploy-class.js';
import { validateDeployConfig } from '../deploy-config-validate.js';
import {
  executeMultiClassDeployment,
  printMultiClassDryRun,
  printMultiClassSummary,
} from '../multi-class-deploy.js';

/** Default CA certificate path */
const DEFAULT_CA_PATH = join(homedir(), '.znvault', 'ca', 'agent-tls-ca.pem');

/**
 * Detect whether a DeployConfig is flat (hosts array) or multi-class (classes array).
 */
export function detectConfigShape(config: DeployConfig): 'flat' | 'multi-class' {
  return Array.isArray(config.classes) ? 'multi-class' : 'flat';
}

/**
 * Validate --class / --strategy / --host flags against the loaded config.
 * Pure (zero I/O). Returns `{ error }` on violation, `{}` on success.
 */
export function validateClassFlags(
  config: DeployConfig,
  flags: { classNames?: string[]; strategy?: string; host?: string[] },
): { error?: string } {
  const isMulti = detectConfigShape(config) === 'multi-class';
  const names = flags.classNames ?? [];
  const scoped = flags.strategy !== undefined || (flags.host && flags.host.length > 0);

  if (names.length > 0 && !isMulti) {
    return { error: `config '${config.name}' has no classes; --class is only for multi-class configs.` };
  }
  if (isMulti && names.length > 0) {
    const known = new Set(config.classes!.map(c => c.name));
    const unknown = names.filter(n => !known.has(n));
    if (unknown.length > 0) {
      return { error: `unknown --class value(s): ${unknown.join(', ')}. Available: ${[...known].join(', ')}.` };
    }
  }
  if (isMulti && scoped && names.length === 0) {
    return { error: `--strategy/--host are per-class; specify --class on a multi-class config.` };
  }
  if (isMulti && scoped && names.length > 1) {
    return { error: `--strategy/--host require exactly one --class.` };
  }
  return {};
}

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
    return { port: config.port ?? 9100, useTLS: false };
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
    return { port: config.port ?? 9100, useTLS: false };
  }

  // Configure TLS
  configureTLS({
    verify: true,
    caCertPath,
  });

  return { port: tlsConfig.httpsPort ?? 9443, useTLS: true };
}

/**
 * Validate a per-class --host/--only override against the class's resolved host list.
 * Pure (zero I/O). Returns `{ unknownHosts }` on violation (non-empty array), `{ unknownHosts: [] }` on success.
 *
 * The caller must still filter `classHosts` to the override set — this function only validates membership.
 */
export function validateClassHostOverride(
  classHosts: string[],
  hostOverride: string[],
): { unknownHosts: string[] } {
  return { unknownHosts: hostOverride.filter(h => !classHosts.includes(h)) };
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
    .option('--host <host>', 'Deploy to only this host from the config (repeatable) — for canaries', collectHosts, [])
    .option('--only <host>', 'Alias for --host', collectHosts, [])
    .option('--class <name>', 'Deploy only this node class from a multi-class config (repeatable)', collectHosts, [])
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
      host: string[];
      only: string[];
      class: string[];
      yes?: boolean;
    }) => {
      const progress = new ProgressReporter(ctx.isPlainMode());
      const isPlain = ctx.isPlainMode();

      // Hoisted so the finally + exit backstop can see them across all early-exit paths.
      let config: DeployConfig | undefined;
      const openTunnels: Tunnel[] = [];

      // Synchronous backstop: process.exit() does NOT await an async finally,
      // so kill any open ssh -N children synchronously on process exit.
      const killTunnelsSync = (): void => {
        for (const t of openTunnels) {
          if (t.pid) { try { process.kill(t.pid, 'SIGTERM'); } catch { /* already gone */ } }
        }
      };
      process.on('exit', killTunnelsSync);

      try {
        const store = await loadDeployConfigs();
        config = store.configs[configName];

        if (!config) {
          ctx.output.error(`Deployment config '${configName}' not found`);
          ctx.output.info('Use "znvault deploy config list" to see available configs');
          process.exit(1);
        }

        // ── Multi-class branch (Spec §3, §4) ──
        if (detectConfigShape(config) === 'multi-class') {
          // 1. Validate (zero network I/O) — hard violation aborts before any host.
          const report = validateDeployConfig(config);
          for (const w of report.warnings) ctx.output.warn(w);
          for (const i of report.info) ctx.output.info(i);
          if (report.errors.length > 0) {
            for (const e of report.errors) ctx.output.error(e);
            process.exit(1);
          }
          // 2. Flag guards.
          const flagCheck = validateClassFlags(config, {
            classNames: options.class, strategy: options.strategy, host: [...options.host, ...options.only],
          });
          if (flagCheck.error) { ctx.output.error(flagCheck.error); process.exit(1); }
          // 3. Run the multi-class deploy (helper below) and exit.
          await runMultiClassDeploy(ctx, config, options, { openTunnels, isPlain });
          return; // handled — do not fall through to the flat path
        }

        if ((config.hosts ?? []).length === 0) {
          ctx.output.error('No hosts configured for this deployment');
          ctx.output.info(`Use "znvault deploy config add-host ${configName} <host>" to add hosts`);
          process.exit(1);
        }

        // Single-host filter (--host / --only) — scope a config deploy to a
        // subset (e.g. a canary) without redeploying every host. Filters into a
        // COPY so the persisted store is never mutated.
        const hostFilter = [...options.host, ...options.only];
        if (hostFilter.length > 0) {
          const unknown = hostFilter.filter(h => !config!.hosts!.includes(h));
          if (unknown.length > 0) {
            ctx.output.error(`--host value(s) not in config '${configName}': ${unknown.join(', ')}`);
            ctx.output.info(`Config hosts: ${config.hosts!.join(', ')}`);
            process.exit(1);
          }
          config = { ...config, hosts: config.hosts!.filter(h => hostFilter.includes(h)) };
          ctx.output.info(`Scoped to ${config.hosts!.length} of host(s): ${config.hosts!.join(', ')}`);
        }

        // Resolve WAR path and get detailed info
        const warPath = resolve(config.warPath!);
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
          console.log(`${ANSI.dim}  Hosts:    ${ANSI.reset}${config.hosts!.length}`);
          progress.showStrategy(getStrategyDisplayName(strategy), strategy.isCanary);
        } else {
          ctx.output.info(`  Hosts: ${config.hosts!.length}`);
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
          const mappedCount = config.hosts!.filter(h => haproxyConfig.serverMap[h]).length;
          const unmapped = getUnmappedHosts(haproxyConfig, config.hosts!);
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

        // ═══════════════════════════════════════════════════════════════════
        // SSH TUNNEL PHASE (opt-in via config.tunnel)
        // Open one SSH-CA forward per host so the agent can stay loopback-only.
        // Real host IPs remain the identity/display/HAProxy key; only the URL
        // the fetch hits is rewritten (via setEndpointOverride).
        // ═══════════════════════════════════════════════════════════════════
        if (config.tunnel) {
          if (!isPlain) {
            console.log(`${ANSI.bold}Opening SSH tunnels (${config.hosts!.length} hosts)...${ANSI.reset}`);
          } else {
            console.log(`Opening SSH tunnels (${config.hosts!.length} hosts)...`);
          }
          for (const host of config.hosts!) {
            try {
              const t = await openTunnel(host, {
                user: config.ssh?.user,
                remotePort: config.port,
                readinessTimeoutMs: config.ssh?.readinessTimeoutMs,
              });
              setEndpointOverride(host, '127.0.0.1', t.localPort);
              openTunnels.push(t);
              ctx.output.info(`  ${host} → 127.0.0.1:${t.localPort}`);
            } catch (err) {
              ctx.output.warn(`  ${host}: tunnel failed (${getErrorMessage(err)})`);
            }
          }
        }

        // Skip preflight entirely if requested
        if (options.skipPreflight) {
          ctx.output.info('Skipping pre-flight checks');
        }

        // Run parallel preflight checks
        if (!isPlain) {
          console.log(`${ANSI.bold}Checking ${config.hosts!.length} hosts...${ANSI.reset}`);
        } else {
          console.log(`Checking ${config.hosts!.length} hosts...`);
        }

        const preflightResult = await executePreflightChecks({
          hosts: config.hosts!,
          port: effectivePort,
          localHashes,
          force: options.force ?? false,
          skipVersionCheck: options.skipVersionCheck ?? options.skipPreflight ?? false,
          isPlain,
          useTLS,
        });

        // Print summary
        printPreflightSummary(preflightResult, config.hosts!.length, isPlain);

        // Handle unreachable hosts
        const unreachableHosts = config.hosts!.filter(h => !preflightResult.reachableHosts.includes(h));
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

          // Show the per-node-class plan: the strategy (1+R, …) applies to
          // serving nodes only; workers deploy last (parallel, no drain,
          // non-blocking). Mirrors executeListrDeployment via the shared helper.
          const { serving, workers } = partitionHostsByClass(hostsWithChanges, haproxyConfig);

          const describeHost = (host: string): string => {
            const analysis = analysisMap.get(host)!;
            const mode = analysis.isFullUpload ? 'full' : 'diff';
            return `+${analysis.filesChanged} -${analysis.filesDeleted} (${formatSize(analysis.bytesToUpload)}, ${mode})`;
          };

          if (workers.length > 0 && serving.length > 0) {
            ctx.output.info(`  Strategy '${strategy.name}' applies to serving nodes; workers deploy last (parallel, no drain, non-blocking).`);
            ctx.output.info(`  Serving (${serving.length}, strategy ${strategy.name}):`);
            for (const host of serving) {
              ctx.output.info(`    ${host}: ${describeHost(host)}  [drain]`);
            }
            ctx.output.info(`  Workers (${workers.length}, final batch):`);
            for (const host of workers) {
              ctx.output.info(`    ${host}: ${describeHost(host)}  [no drain, non-blocking]`);
            }
          } else {
            // Single class (all serving / all worker / no serverMap): flat list.
            for (const host of hostsWithChanges) {
              ctx.output.info(`  ${host}: ${describeHost(host)}`);
            }
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
          quiesce: config.quiesce,
          hostConfigs: config.hostConfigs,
        });

        // Print final summary
        printDeploymentSummary(deployResult, deployableHosts.length, isPlain);

        if (deployResult.failed > 0 || deployResult.aborted || deployResult.healthCheckFailed > 0) {
          process.exit(1);
        }
      } catch (err) {
        ctx.output.error(`Deployment failed: ${getErrorMessage(err)}`);
        process.exit(1);
      } finally {
        // Normal-path teardown: close tunnels + clear overrides. (process.exit
        // paths are covered by the synchronous killTunnelsSync backstop above.)
        if (config?.tunnel) {
          clearAllEndpointOverrides();
          await Promise.all(openTunnels.map(t => t.close().catch(() => undefined)));
        }
        process.removeListener('exit', killTunnelsSync);
      }
    });
}

/**
 * Collector for the repeatable --host / --only / --class options.
 */
function collectHosts(value: string, previous: string[]): string[] {
  return previous.concat([value.trim()]);
}

/**
 * Options for the action handler passed down to runMultiClassDeploy.
 */
interface DeployRunOptions {
  force?: boolean;
  dryRun?: boolean;
  sequential?: boolean;
  strategy?: string;
  skipPreflight?: boolean;
  skipVersionCheck?: boolean;
  skipDrain?: boolean;
  updatePlugins?: boolean;
  host: string[];
  only: string[];
  class: string[];
  yes?: boolean;
}

/**
 * Execute a multi-class deploy. Called from the action handler when
 * `detectConfigShape(config) === 'multi-class'`.
 *
 * Wiring:
 * 1. `partitionSelectedClasses` → selected classes in config order.
 * 2. If single --class + scoped strategy/host, apply override to that class.
 * 3. For --dry-run: print plan and return.
 * 4. Warn if selected omits an upstream blocking class.
 * 5. Build `runClass(rc)` that per-class:
 *    - Opens tunnels (pushed into shared openTunnels[]).
 *    - Runs preflight for rc.hosts.
 *    - Calls executeListrDeployment with suppressMixedClassWarning:true.
 *    - Closes that class's tunnels in a finally.
 * 6. `executeMultiClassDeployment(resolved, runClass, ctx.output)`.
 * 7. `printMultiClassSummary(result, isPlain)`.
 * 8. `if (result.abortedAt) process.exit(1)`.
 */
async function runMultiClassDeploy(
  ctx: CLIPluginContext,
  config: DeployConfig,
  options: DeployRunOptions,
  shared: { openTunnels: Tunnel[]; isPlain: boolean },
): Promise<void> {
  const { openTunnels, isPlain } = shared;

  // 1. Partition --class selection (preserves config order).
  const { selected: selectedClasses } = partitionSelectedClasses(config.classes!, options.class);

  // 2. Resolve the classes (inheriting config-level defaults).
  const resolved = selectedClasses.map(cls => {
    let rc = resolveClass(config, cls);

    // Scoped per-class override: single --class + --strategy/--host.
    if (options.class.length === 1 && options.class[0] === cls.name) {
      if (options.strategy) {
        rc = { ...rc, strategy: options.strategy };
      }
      const hostOverride = [...options.host, ...options.only];
      if (hostOverride.length > 0) {
        // Validate: every override value must be a member of this class's hosts.
        const { unknownHosts } = validateClassHostOverride(rc.hosts, hostOverride);
        if (unknownHosts.length > 0) {
          ctx.output.error(
            `--host value(s) not in class '${rc.name}': ${unknownHosts.join(', ')}. Class hosts: ${rc.hosts.join(', ')}`
          );
          process.exit(1);
        }
        // Filter (preserving class order) instead of replacing with the raw array.
        rc = { ...rc, hosts: rc.hosts.filter(h => hostOverride.includes(h)) };
      }
    }
    return rc;
  });

  // 3. For --dry-run: print plan and return.
  if (options.dryRun) {
    // Resolve the effective strategy for each class (mirrors the executor path)
    // so the printed plan always matches what would run (e.g. --sequential overrides
    // the class's configured strategy).
    const effectiveStrategies = resolved.map(rc =>
      resolveStrategy({ strategy: rc.strategy, sequential: options.sequential })
    );
    printMultiClassDryRun(resolved, effectiveStrategies, isPlain);
    return;
  }

  // 4. Warn if the selection omits an upstream blocking class.
  if (options.class.length > 0) {
    const selectedSet = new Set(options.class);
    const allClasses = config.classes!;
    for (const cls of allClasses) {
      if (!selectedSet.has(cls.name)) {
        const rc = resolveClass(config, cls);
        if (rc.blocking) {
          ctx.output.warn(
            `[znvault-deploy] Blocking class '${cls.name}' was omitted from the --class selection. ` +
            `Downstream classes may depend on it succeeding first.`
          );
          break; // warn once for the first omitted blocking class upstream
        }
      }
      // Stop scanning once we hit the first selected class (they're in order)
      if (selectedSet.has(cls.name)) break;
    }
  }

  // 5. Build runClass(rc) — per-class: tunnels + preflight + executeListrDeployment.
  const runClass = async (rc: typeof resolved[0]) => {
    const classTunnels: Tunnel[] = [];

    try {
      // Configure TLS for this class.
      const { port: effectivePort, useTLS } = configureTLSForDeployment({ ...config, tls: rc.tls, port: rc.port }, ctx);

      // Open SSH tunnels for this class's hosts (if enabled).
      if (rc.tunnel) {
        if (!isPlain) {
          console.log(`${ANSI.bold}[${rc.name}] Opening SSH tunnels (${rc.hosts.length} hosts)...${ANSI.reset}`);
        } else {
          console.log(`[${rc.name}] Opening SSH tunnels (${rc.hosts.length} hosts)...`);
        }
        for (const host of rc.hosts) {
          try {
            const t = await openTunnel(host, {
              user: rc.ssh?.user,
              remotePort: rc.port,
              readinessTimeoutMs: rc.ssh?.readinessTimeoutMs,
            });
            setEndpointOverride(host, '127.0.0.1', t.localPort);
            openTunnels.push(t);
            classTunnels.push(t);
            ctx.output.info(`  [${rc.name}] ${host} → 127.0.0.1:${t.localPort}`);
          } catch (err) {
            ctx.output.warn(`  [${rc.name}] ${host}: tunnel failed (${getErrorMessage(err)})`);
          }
        }
      }

      // Resolve the WAR path for this class.
      const warPath = resolve(rc.warPath!);
      let warInfo: WarInfo;
      try {
        warInfo = await getWarInfo(warPath);
      } catch {
        ctx.output.error(`[${rc.name}] WAR file not found: ${warPath}`);
        // Return a failed DeployContext — don't throw (let the gate handle it).
        return {
          results: new Map(), aborted: false, skipped: 0,
          successful: 0, failed: rc.hosts.length, healthCheckFailed: 0, workerFailed: 0,
        };
      }

      // Announce class and WAR info.
      if (!isPlain) {
        console.log(`\n${ANSI.bold}Class: ${ANSI.cyan}${rc.name}${ANSI.reset}${ANSI.bold} (${rc.hosts.length} host${rc.hosts.length !== 1 ? 's' : ''})${ANSI.reset}`);
      } else {
        ctx.output.info(`Class: ${rc.name} (${rc.hosts.length} host${rc.hosts.length !== 1 ? 's' : ''})`);
      }
      const classProgress = new ProgressReporter(isPlain);
      classProgress.showWarInfo(warInfo);

      // Calculate hashes for this class's WAR.
      const localHashes = await calculateWarHashes(warPath);

      // HAProxy config for this class (skip drain if --skip-drain).
      const haproxyConfig = (!options.skipDrain && rc.haproxy) ? rc.haproxy : undefined;

      // Pre-flight checks.
      if (!isPlain) {
        console.log(`${ANSI.bold}[${rc.name}] Checking ${rc.hosts.length} hosts...${ANSI.reset}`);
      } else {
        console.log(`[${rc.name}] Checking ${rc.hosts.length} hosts...`);
      }

      const preflightResult = await executePreflightChecks({
        hosts: rc.hosts,
        port: effectivePort,
        localHashes,
        force: options.force ?? false,
        skipVersionCheck: options.skipVersionCheck ?? options.skipPreflight ?? false,
        isPlain,
        useTLS,
      });

      printPreflightSummary(preflightResult, rc.hosts.length, isPlain);

      // Filter to reachable hosts.
      const reachableHosts = preflightResult.reachableHosts;
      if (reachableHosts.length === 0) {
        ctx.output.error(`[${rc.name}] No hosts reachable`);
        return {
          results: new Map(), aborted: false, skipped: 0,
          successful: 0, failed: rc.hosts.length, healthCheckFailed: 0, workerFailed: 0,
        };
      }

      // Filter to deployable (successful analysis).
      const deployableHosts = reachableHosts.filter(h => preflightResult.analysisMap.get(h)?.success);
      if (deployableHosts.length === 0) {
        ctx.output.error(`[${rc.name}] No hosts available for deployment`);
        return {
          results: new Map(), aborted: false, skipped: 0,
          successful: 0, failed: rc.hosts.length, healthCheckFailed: 0, workerFailed: 0,
        };
      }

      // Check if all hosts have no changes.
      const hostsWithChanges = deployableHosts.filter(h => {
        const analysis = preflightResult.analysisMap.get(h);
        return analysis && (analysis.filesChanged > 0 || analysis.filesDeleted > 0);
      });

      if (hostsWithChanges.length === 0) {
        if (!isPlain) {
          console.log(`\n${ANSI.green}✓${ANSI.reset} [${rc.name}] All hosts up to date — no deployment needed`);
        } else {
          ctx.output.success(`[${rc.name}] All hosts up to date — no deployment needed`);
        }
        return {
          results: new Map(), aborted: false, skipped: 0,
          successful: deployableHosts.length, failed: 0, healthCheckFailed: 0, workerFailed: 0,
        };
      }

      // HAProxy connectivity pre-check.
      if (haproxyConfig) {
        const connResult = await testHAProxyConnectivity(haproxyConfig);
        if (!connResult.success) {
          const failedHosts = connResult.results.filter(r => !r.success);
          for (const f of failedHosts) {
            ctx.output.error(`  [${rc.name}] HAProxy ${f.host}: ${f.error}`);
          }
          ctx.output.error(`[${rc.name}] Cannot reach all HAProxy hosts. Use --skip-drain to deploy without drain/ready.`);
          return {
            results: new Map(), aborted: false, skipped: 0,
            successful: 0, failed: hostsWithChanges.length, healthCheckFailed: 0, workerFailed: 0,
          };
        }
      }

      // Resolve the class-scoped strategy.
      const classScopedStrategy = resolveStrategy({
        strategy: rc.strategy,
        sequential: options.sequential,
        configStrategy: undefined, // already resolved into rc.strategy
        configParallel: undefined,
      });

      let strategy;
      try {
        strategy = parseDeploymentStrategy(classScopedStrategy);
      } catch (err) {
        ctx.output.error(`[${rc.name}] ${getErrorMessage(err)}`);
        return {
          results: new Map(), aborted: false, skipped: 0,
          successful: 0, failed: hostsWithChanges.length, healthCheckFailed: 0, workerFailed: 0,
        };
      }

      // Execute deployment.
      console.log('');
      const deployOpts: ListrDeployOptions = {
        ctx,
        warPath,
        localHashes,
        port: effectivePort,
        force: options.force ?? false,
        analysisMap: preflightResult.analysisMap,
        healthCheck: rc.healthCheck,
        useTLS,
        haproxy: haproxyConfig,
        quiesce: rc.quiesce,
        hostConfigs: rc.hostConfigs,
        suppressMixedClassWarning: true,
      };

      return await executeListrDeployment(strategy, deployableHosts, deployOpts);
    } finally {
      // Close ONLY this class's tunnels; do NOT call clearAllEndpointOverrides()
      // mid-loop — other classes may still have their overrides active.
      for (const host of rc.hosts) {
        clearEndpointOverride(host);
      }
      await Promise.all(classTunnels.map(t => t.close().catch(() => undefined)));
    }
  };

  // 6. Execute multi-class deployment.
  const result = await executeMultiClassDeployment(resolved, runClass, ctx.output);

  // 7. Print summary.
  printMultiClassSummary(result, isPlain);

  // 8. Exit 1 if aborted.
  if (result.abortedAt) {
    process.exit(1);
  }
}

