// Path: src/cli/commands/deploy-run.ts
// Deploy run command - multi-host deployment using saved configurations

import type { Command } from 'commander';
import { runMigrations, defaultDeps as migrationDefaultDeps, mysqlAdapter } from '@zincapp/znvault-migrate';
import { resolve, join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  calculateWarHashes,
  readLocalWarArtifactSnapshot,
} from '../../war-deployer.js';
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
  type HAProxyConfig,
  type MigrationConfig,
  parseDeploymentStrategy,
  getStrategyDisplayName,
} from '../types.js';
import { getErrorMessage } from '../../utils/error.js';
import { loadHostMutationAuthTokens } from '../auth-token.js';
import {
  executeListrDeployment,
  printDeploymentSummary,
  partitionHostsByClass,
  missingVerifiedDeploymentReceipts,
  type ListrDeployOptions,
} from '../listr-deploy.js';
import {
  executePreflightChecks,
  executePluginUpdates,
  waitForAgentRestart,
  printPreflightSummary,
  assertHostControlPlaneCompatible,
  type PreflightContext,
} from '../listr-preflight.js';
import {
  isConfigFilePath,
  loadConfigFromFile,
  expandTilde,
  type MigrationSkipReason,
  computeNoFailures,
  computeFullCoverage,
  isScopedDeploy,
  resolvePostSkipReason,
  resolveDeployPlan,
  type DeployPlan,
  resolveStrategy,
  formatSize,
  configureTLS,
  setEndpointOverride,
  clearEndpointOverride,
  clearAllEndpointOverrides,
  openTunnel,
  type Tunnel,
  getUnmappedHosts,
  testHAProxyConnectivity,
  resolveClass,
  partitionSelectedClasses,
  validateDeployConfig,
  resolveConfigPaths,
  executeMultiClassDeployment,
  printMultiClassDryRun,
  printMultiClassSummary,
  type RunClassResult,
  runMigrationPhase as coreRunMigrationPhase,
  siblingIntegrityDirs as coreSiblingIntegrityDirs,
} from '@zincapp/znvault-deploy-core';

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
    const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
    if (duplicateNames.length > 0) {
      return {
        error: `duplicate --class value(s): ${[...new Set(duplicateNames)].join(', ')}. ` +
          'Specify each node class at most once.',
      };
    }
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
export function configureTLSForDeployment(config: DeployConfig, _ctx: CLIPluginContext): { port: number; useTLS: boolean } {
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
    throw new Error(
      `CA certificate not found at ${caCertPath}; run "znvault payara tls setup" ` +
      'or use the default SSH tunnel. Refusing direct HTTP credential fallback.'
    );
  }

  // Configure TLS
  configureTLS({
    verify: true,
    caCertPath,
  });

  return { port: tlsConfig.httpsPort ?? 9443, useTLS: true };
}

/**
 * Resolve the effective deployment strategy for one class in a multi-class config.
 *
 * Priority (highest → lowest):
 *   1. `scopedStrategyOverride` — an explicit `--class X --strategy VALUE` flag (beats everything)
 *   2. `sequential`             — the bare `--sequential` flag (beats the class config)
 *   3. `configStrategy`         — the strategy declared for this class in the config file
 *   4. Default: `'sequential'`
 *
 * This is a pure helper so it can be unit-tested independently of the CLI process loop.
 */
export function resolveClassStrategy(
  configStrategy: string | undefined,
  scopedStrategyOverride: string | undefined,
  sequential: boolean | undefined,
): string {
  return resolveStrategy({
    strategy: scopedStrategyOverride,  // priority 1: explicit --class X --strategy VALUE
    sequential,                        // priority 2: bare --sequential flag
    configStrategy,                    // priority 3: class's configured strategy
  });
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

interface PreparedDeployClass {
  rc: ReturnType<typeof resolveClass>;
  scopedStrategyOverride?: string;
  preOverrideHostCount: number;
}

interface PreparedClassPreflight {
  className: string;
  hosts: string[];
  warPath: string;
  warInfo: WarInfo;
  localHashes: Awaited<ReturnType<typeof calculateWarHashes>>;
  artifactSnapshot: Awaited<ReturnType<typeof readLocalWarArtifactSnapshot>>;
  effectivePort: number;
  useTLS: boolean;
  /** Resolved per-class connection settings used to rebind Core's global TLS context. */
  controlPlaneConfig: DeployConfig;
  preflightResult: PreflightContext;
}

function restorePreparedClassControlPlane(
  prepared: PreparedClassPreflight,
  ctx: CLIPluginContext
): { port: number; useTLS: boolean } {
  const restored = configureTLSForDeployment(prepared.controlPlaneConfig, ctx);
  if (
    restored.port !== prepared.effectivePort
    || restored.useTLS !== prepared.useTLS
  ) {
    throw new Error(
      `[${prepared.className}] CONTROL_PLANE_TLS_CONTEXT_DRIFT: prepared ` +
      `${prepared.useTLS ? 'TLS' : 'HTTP'}:${prepared.effectivePort}, restored ` +
      `${restored.useTLS ? 'TLS' : 'HTTP'}:${restored.port}`
    );
  }
  return restored;
}

interface NamedHAProxyPreflight {
  name: string;
  config: HAProxyConfig;
}

/**
 * Prove every selected rollout load balancer is reachable before crossing the
 * first mutable boundary.  All checks settle before failure is reported, so a
 * later class can never be discovered only after an earlier plugin update or
 * database migration has already run.
 */
async function assertGlobalHAProxyConnectivity(
  targets: NamedHAProxyPreflight[],
  ctx: CLIPluginContext,
  isPlain: boolean
): Promise<void> {
  if (targets.length === 0) return;

  if (!isPlain) {
    console.log(`${ANSI.dim}Checking global HAProxy connectivity...${ANSI.reset}`);
  } else {
    console.log('Checking global HAProxy connectivity...');
  }

  const checks = await Promise.all(targets.map(async target => {
    try {
      const result = await testHAProxyConnectivity(target.config);
      return {
        target,
        success: result.success,
        failures: result.results
          .filter(item => !item.success)
          .map(item => ({ host: item.host, error: item.error ?? 'connectivity check failed' })),
      };
    } catch (err) {
      return {
        target,
        success: false,
        failures: [{ host: target.config.hosts.join(', '), error: getErrorMessage(err) }],
      };
    }
  }));

  const failedChecks = checks.filter(check => !check.success);
  if (failedChecks.length > 0) {
    for (const check of failedChecks) {
      if (check.failures.length === 0) {
        ctx.output.error(`  [${check.target.name}] HAProxy connectivity check failed`);
      }
      for (const failure of check.failures) {
        ctx.output.error(
          `  [${check.target.name}] HAProxy ${failure.host}: ${failure.error}`
        );
      }
    }
    throw new Error(
      'HAPROXY_CONNECTIVITY_PREFLIGHT_FAILED: cannot reach every selected ' +
      'HAProxy; refusing plugin updates, migrations, and WAR deployment. ' +
      'Use --skip-drain to deploy without drain/ready.'
    );
  }

  const checkedHosts = targets.reduce(
    (count, target) => count + target.config.hosts.length,
    0
  );
  if (!isPlain) {
    console.log(
      `${ANSI.green}✓${ANSI.reset} All ${checkedHosts} selected HAProxy ` +
      `endpoint${checkedHosts === 1 ? '' : 's'} reachable\n`
    );
  } else {
    console.log(
      `All ${checkedHosts} selected HAProxy endpoint${checkedHosts === 1 ? '' : 's'} reachable`
    );
  }
}

/** Fail one global preflight phase unless every class host is fully analyzable. */
function assertCompleteClassPreflight(
  prepared: Pick<PreparedClassPreflight, 'className' | 'hosts'>,
  preflight: PreflightContext,
  requireNoPendingUpdates = false
): void {
  const bootstrapHosts = new Set(preflight.bootstrapUpdateHosts ?? []);
  const unverified = prepared.hosts.filter(
    host => !preflight.reachableHosts.includes(host)
  );
  const failedAnalysis = prepared.hosts.filter(
    host => preflight.analysisMap.get(host)?.success !== true
      && !(bootstrapHosts.has(host) && !requireNoPendingUpdates)
  );
  if (unverified.length > 0 || failedAnalysis.length > 0) {
    throw new Error(
      `[${prepared.className}] CONTROL_PLANE_PREFLIGHT_INCOMPLETE: ` +
      (unverified.length > 0 ? `unverified: ${unverified.join(', ')}. ` : '') +
      (failedAnalysis.length > 0
        ? `analysis failed: ${failedAnalysis.join(', ')}.`
        : '')
    );
  }
  if (requireNoPendingUpdates && preflight.updateTargets.length > 0) {
    throw new Error(
      `[${prepared.className}] Post-update preflight still reports pending ` +
      `Payara plugin updates on: ${preflight.updateTargets
        .map(target => target.host)
        .join(', ')}`
    );
  }
}

/** Resolve and validate the exact selected class/host set before any side effect. */
function prepareSelectedDeployClasses(
  config: DeployConfig,
  options: Pick<DeployRunOptions, 'class' | 'host' | 'only' | 'strategy'>
): PreparedDeployClass[] {
  // DeployClass's contract forbids one physical host from appearing in two
  // classes. Enforce it here as well as in authored config validation: tunnel
  // ownership and per-host credentials must never be rebound mid-rollout.
  const hostOwner = new Map<string, string>();
  for (const deployClass of config.classes!) {
    const resolvedClass = resolveClass(config, deployClass);
    for (const host of resolvedClass.hosts) {
      const priorOwner = hostOwner.get(host);
      if (priorOwner) {
        throw new Error(
          `host '${host}' appears in both '${priorOwner}' and ` +
          `'${resolvedClass.name}' classes`
        );
      }
      hostOwner.set(host, resolvedClass.name);
    }
  }

  const { selected } = partitionSelectedClasses(config.classes!, options.class);
  return selected.map(cls => {
    let rc = resolveClass(config, cls);
    const preOverrideHostCount = rc.hosts.length;
    let scopedStrategyOverride: string | undefined;
    if (options.class.length === 1 && options.class[0] === cls.name) {
      scopedStrategyOverride = options.strategy;
      const hostOverride = [...options.host, ...options.only];
      if (hostOverride.length > 0) {
        const { unknownHosts } = validateClassHostOverride(rc.hosts, hostOverride);
        if (unknownHosts.length > 0) {
          throw new Error(
            `--host value(s) not in class '${rc.name}': ${unknownHosts.join(', ')}. ` +
            `Class hosts: ${rc.hosts.join(', ')}`
          );
        }
        rc = { ...rc, hosts: rc.hosts.filter(host => hostOverride.includes(host)) };
      }
    }
    return { rc, scopedStrategyOverride, preOverrideHostCount };
  });
}

/**
 * The OTHER migration phase's directory (post's dir for the pre phase, and vice
 * versa), as a one-element array for `integrityDirs` — or `[]` when the other phase
 * is unconfigured or shares this phase's directory. Both phases write to the same
 * schema_migrations table, so the planner's integrity check must know about the
 * sibling dir to avoid flagging its rows as orphaned. Pure (zero I/O).
 *
 * Re-exported (unchanged signature/behavior) from `@zincapp/znvault-deploy-core`,
 * which lifted this verbatim out of payara — kept as a local export because
 * `test/deploy-run-migration-phase.test.ts` imports it from this module.
 */
export const siblingIntegrityDirs = coreSiblingIntegrityDirs;

/**
 * Run a schema-migration phase (pre-deploy or post-deploy) if a migration config
 * is provided. No-op when `migration` is undefined.
 *
 * Thin payara-specific wrapper over `@zincapp/znvault-deploy-core`'s
 * target-agnostic `runMigrationPhase` gate: the gate's `runPhase` callback is
 * bound here to payara's own `runMigrations` (mysql, via
 * `@zincapp/znvault-migrate`) using the injected `deps`, and `dryRunRender`
 * reproduces payara's exact original dry-run line. The gate's `labels`
 * default text ("WAR" / "payara deploy run … --post-only") already matches
 * payara's original wording, so no override is passed. Kept with payara's
 * ORIGINAL signature (`deps` as an explicit param, not a closure the caller
 * can't reach) because `test/deploy-run-migration-phase.test.ts` calls it
 * with an injected `deps` object and inspects `deps.makeRunner` calls.
 *
 * @param migration  - The migration config for this phase (undefined = no-op).
 * @param phase      - Which phase this is, for log lines and skip-reason messages.
 * @param configName - The config name, used as the `env` label in runMigrations.
 * @param ctx        - The CLI plugin context (output + client).
 * @param deps       - Injectable deps (defaults to production wiring via migrationDefaultDeps).
 * @param opts       - `dryRun` prints the plan only; `run: false` skips with a
 *                     reason-tagged log line built from `skipReason`.
 */
export async function runMigrationPhase(
  migration: MigrationConfig | undefined,
  phase: 'pre-deploy' | 'post-deploy',
  configName: string,
  ctx: CLIPluginContext,
  deps = migrationDefaultDeps(ctx.client, mysqlAdapter),
  opts: { dryRun?: boolean; run?: boolean; skipReason?: MigrationSkipReason; integrityDirs?: string[] } = {},
): Promise<void> {
  await coreRunMigrationPhase(
    migration,
    phase,
    configName,
    ctx,
    async (m, p, c) => {
      await runMigrations(c, {
        env: configName,
        engine: 'mysql',
        roleId: m.roleId,
        migrationsDir: m.migrationsDir,
        database: m.database,
        // The sibling phase's dir shares the schema_migrations history table; pass it
        // so the planner's integrity check treats sibling-applied rows as tracked, not
        // as orphaned (renamed/deleted) files.
        integrityDirs: opts.integrityDirs,
        scaffoldingFile: m.scaffoldingFile,
      }, deps);
    },
    (m, p) =>
      `[deploy] [dry-run] would run ${p} schema migrations ` +
      `(role '${m.roleId}', dir '${m.migrationsDir}')`,
    opts,
  );
}

interface RefreshablePreflightOptions {
  hosts: string[];
  port: number;
  localHashes: Awaited<ReturnType<typeof calculateWarHashes>>;
  force: boolean;
  isPlain: boolean;
  useTLS: boolean;
  mutationAuthTokens: ReadonlyMap<string, string>;
  updatePlugins?: boolean;
  yes?: boolean;
  ctx: CLIPluginContext;
}

/**
 * Apply requested plugin updates and discard every pre-update observation.
 * Any update failure aborts. A successful update is followed by a complete,
 * authenticated compatibility + hashes analysis of every target.
 */
async function refreshPreflightAfterPluginUpdates(
  initial: PreflightContext,
  options: RefreshablePreflightOptions
): Promise<PreflightContext> {
  if (initial.updateTargets.length === 0) return initial;

  const bootstrapHosts = initial.bootstrapUpdateHosts ?? [];

  let shouldUpdate = options.updatePlugins ?? false;
  if (!shouldUpdate && !options.yes) {
    console.log('');
    const inquirerModule = await import('inquirer');
    const answers = await inquirerModule.default.prompt([{
      type: 'confirm',
      name: 'update',
      message: 'Update plugins before deploying?',
      default: false,
    }]) as { update: boolean };
    shouldUpdate = answers.update;
  }
  if (!shouldUpdate) {
    if (bootstrapHosts.length > 0) {
      throw new Error(
        'CONTROL_PLANE_BOOTSTRAP_REQUIRED: Payara plugin 2 may only proceed ' +
        `through an exact Plugin 3 update on: ${bootstrapHosts.join(', ')}`
      );
    }
    return initial;
  }

  console.log('');
  if (!options.isPlain) {
    console.log(`${ANSI.bold}Updating plugins...${ANSI.reset}`);
  }
  const updateResult = await executePluginUpdates(
    initial.updateTargets,
    options.port,
    options.isPlain,
    options.useTLS,
    options.mutationAuthTokens
  );
  if (updateResult.hostsRestarting > 0) {
    console.log('');
    await waitForAgentRestart(25, options.isPlain);
  }

  const refreshed = await executePreflightChecks({
    hosts: options.hosts,
    port: options.port,
    localHashes: options.localHashes,
    force: options.force,
    isPlain: options.isPlain,
    useTLS: options.useTLS,
    mutationAuthTokens: options.mutationAuthTokens,
  });
  printPreflightSummary(refreshed, options.hosts.length, options.isPlain);

  const unreachable = options.hosts.filter(
    host => !refreshed.reachableHosts.includes(host)
  );
  const failedAnalysis = options.hosts.filter(
    host => !refreshed.analysisMap.get(host)?.success
  );
  if (unreachable.length > 0 || failedAnalysis.length > 0) {
    throw new Error(
      'Post-update preflight failed; refusing deployment. ' +
      (unreachable.length > 0 ? `Unreachable: ${unreachable.join(', ')}. ` : '') +
      (failedAnalysis.length > 0
        ? `Analysis failed: ${failedAnalysis.join(', ')}.`
        : '')
    );
  }
  if (refreshed.updateTargets.length > 0) {
    throw new Error(
      'Post-update preflight still reports pending plugin updates on: ' +
      refreshed.updateTargets.map(target => target.host).join(', ')
    );
  }
  return refreshed;
}

interface CompatibilityGroup {
  name: string;
  hosts: string[];
  port?: number;
  tunnel?: boolean;
  ssh?: DeployConfig['ssh'];
  tls?: DeployConfig['tls'];
}

/**
 * Migration-only commands do not have a WAR to analyze, but they are still a
 * mutating rail owned by the Payara plugin 3 CLI. Prove the complete Agent 2 / plugin 3 fleet
 * before issuing a database lease or applying any migration.
 */
async function assertMigrationControlPlaneCompatibility(
  config: DeployConfig,
  tokenFileOverride: string | undefined,
  ctx: CLIPluginContext,
  openTunnels: Tunnel[]
): Promise<void> {
  const groups: CompatibilityGroup[] = detectConfigShape(config) === 'multi-class'
    ? prepareSelectedDeployClasses(config, {
        class: [], host: [], only: [], strategy: undefined,
      }).map(({ rc }) => ({
        name: rc.name,
        hosts: rc.hosts,
        port: rc.port,
        tunnel: rc.tunnel,
        ssh: rc.ssh,
        tls: rc.tls,
      }))
    : [{
        name: config.name,
        hosts: config.hosts ?? [],
        port: config.port,
        tunnel: config.tunnel,
        ssh: config.ssh,
        tls: config.tls,
      }];
  const hosts = groups.flatMap(group => group.hosts);
  if (hosts.length === 0) {
    throw new Error(
      'CONTROL_PLANE_VERSION_UNVERIFIED: no hosts are configured for the migration'
    );
  }

  // Load the complete token set, then establish every requested tunnel, before
  // the first compatibility request. A later host can never fail after a
  // migration has started.
  const mutationAuthTokens = loadHostMutationAuthTokens(
    config,
    hosts,
    tokenFileOverride
  );
  for (const group of groups) {
    if (!group.tunnel) continue;
    for (const host of group.hosts) {
      try {
        const tunnel = await openTunnel(host, {
          user: group.ssh?.user,
          remotePort: group.port,
          readinessTimeoutMs: group.ssh?.readinessTimeoutMs,
        });
        setEndpointOverride(host, '127.0.0.1', tunnel.localPort);
        openTunnels.push(tunnel);
        ctx.output.info(
          `  [${group.name}] ${host} → 127.0.0.1:${tunnel.localPort}`
        );
      } catch (err) {
        throw new Error(
          `[${group.name}] SSH tunnel failed for ${host}; refusing direct ` +
          `credential fallback: ${getErrorMessage(err)}`
        );
      }
    }
  }

  for (const group of groups) {
    // Core TLS options are process-global, so apply one group's policy and
    // finish its checks before moving to the next group.
    const { port, useTLS } = configureTLSForDeployment(
      { ...config, port: group.port, tls: group.tls },
      ctx
    );
    await Promise.all(group.hosts.map(async host => {
      const mutationAuthToken = mutationAuthTokens.get(host);
      if (!mutationAuthToken) {
        throw new Error(`Payara credential was not loaded for host '${host}'`);
      }
      await assertHostControlPlaneCompatible(
        host,
        port,
        useTLS,
        mutationAuthToken
      );
    }));
  }
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
    .option('--skip-drain', 'Skip HAProxy drain/ready operations')
    .option('--update-plugins', 'Update plugins if updates are available')
    .option('--host <host>', 'Deploy to only this host from the config (repeatable) — for canaries', collectHosts, [])
    .option('--only <host>', 'Alias for --host', collectHosts, [])
    .option('--class <name>', 'Deploy only this node class from a multi-class config (repeatable)', collectHosts, [])
    .option('-y, --yes', 'Skip confirmation prompts')
    .option('--migrations-only', 'Run both migration phases (pre + post), then stop (skip the WAR rollout)')
    .option('--skip-migrations', 'Deploy the WAR without running any schema migrations (skips both pre and post)')
    .option('--skip-pre', 'Skip the pre-deploy migration phase (still deploys + runs post)')
    .option('--skip-post', 'Skip the post-deploy migration phase (still runs pre + deploys)')
    .option('--pre-only', 'Run only the pre-deploy migration phase, then stop (no rollout)')
    .option('--post-only', 'Run only the post-deploy migration phase, then stop (no rollout) — recovery')
    .option('--with-root <dir>', 'Base dir for relative local paths in the config (sets/overrides rootDir for this deploy)')
    .option('--mutation-auth-token-file <path>', 'Local private Payara credential file')
    .action(async (configName: string, options: {
      force?: boolean;
      dryRun?: boolean;
      sequential?: boolean;
      strategy?: string;
      skipDrain?: boolean;
      updatePlugins?: boolean;
      host: string[];
      only: string[];
      class: string[];
      yes?: boolean;
      migrationsOnly?: boolean;
      skipMigrations?: boolean;
      skipPre?: boolean;
      skipPost?: boolean;
      preOnly?: boolean;
      postOnly?: boolean;
      withRoot?: string;
      mutationAuthTokenFile?: string;
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
        if (isConfigFilePath(configName)) {
          // Deploy directly from a file — ephemeral, never written to the store.
          // loadConfigFromFile applies --with-root (sets rootDir) inside the helper.
          config = loadConfigFromFile(configName, options.withRoot);
          // Ensure a non-empty name/label so downstream logging/validation never
          // prints 'config undefined'. The file basename (minus .json) is a fine
          // ephemeral label; only cosmetic (a log/env string).
          if (!config.name) config.name = basename(configName, '.json');
          configName = config.name;
        } else {
          const store = await loadDeployConfigs();
          config = store.configs[configName];
          if (!config) {
            ctx.output.error(`Deployment config '${configName}' not found`);
            ctx.output.info('Use "znvault payara config list" to see available configs');
            process.exit(1);
          }
          // --with-root on a SAVED name overrides its rootDir for THIS run only
          // (never persisted — deploy-run never calls saveDeployConfigs). Copy
          // rather than mutate the store's object (the store may cache/reuse it
          // across calls). This must land BEFORE the pre-resolve
          // validateDeployConfig below so both validate and resolveConfigPaths
          // see the overridden root.
          if (options.withRoot) {
            config = { ...config, rootDir: resolve(expandTilde(options.withRoot)) };
          }
        }

        // Validate the AS-STORED config (so relative-path / rootDir messages
        // quote what the user wrote + emit the relative-without-root warning),
        // then resolve every local filesystem path to absolute against rootDir
        // (+ tilde expansion). Everything downstream — runMigrationPhase,
        // siblingIntegrityDirs, the WAR deployer, the multi-class executor, and
        // the migrate library — receives ABSOLUTE paths and needs no rootDir
        // awareness. (The existing per-branch validateDeployConfig calls remain
        // and re-emit info lines on the resolved config; this early pass adds the
        // hard-error gate + surfaces the as-stored warnings once.)
        {
          const preReport = validateDeployConfig(config);
          for (const w of preReport.warnings) ctx.output.warn(w);
          if (preReport.errors.length > 0) {
            for (const e of preReport.errors) ctx.output.error(e);
            process.exit(1);
          }
        }
        config = resolveConfigPaths(config);
        // Major-3 transport default: legacy configs that omit tunnel now use an
        // SSH forward. Sending the control credential over direct HTTP is never
        // a compatibility fallback. An explicit false requires verified HTTPS.
        config = { ...config, tunnel: config.tunnel ?? true };

        // Resolve the six-flag plan (pure). Contradictions abort before any host.
        const { plan, error: planError } = resolveDeployPlan({
          skipMigrations: options.skipMigrations, skipPre: options.skipPre, skipPost: options.skipPost,
          migrationsOnly: options.migrationsOnly, preOnly: options.preOnly, postOnly: options.postOnly,
        });
        if (planError || !plan) { ctx.output.error(planError ?? 'invalid deploy plan'); process.exit(1); }
        // Required-block checks for -only flags (config-dependent, action-level).
        if (options.preOnly && !config.migration) {
          ctx.output.error(`--pre-only requires a pre-deploy migration config; none set on '${configName}'. Use 'payara config set-migration ${configName} --phase pre ...'.`);
          process.exit(1);
        }
        if (options.postOnly && !config.postMigration) {
          ctx.output.error(`--post-only requires a post-deploy migration config; none set on '${configName}'. Use 'payara config set-migration ${configName} --phase post ...'.`);
          process.exit(1);
        }
        if (options.migrationsOnly && !config.migration && !config.postMigration) {
          ctx.output.error(`--migrations-only requires a migration config; none set on '${configName}'.`);
          process.exit(1);
        }

        // ── No-rollout shape: the three -only flags. Handle before WAR
        //    resolution and rollout analysis, while still requiring the
        //    authenticated Agent 2 / plugin 3 compatibility gate before DB work.
        if (!plan.runRollout) {
          // Validate first (parity with the multi-class rollout path).
          // Warnings were already surfaced by the pre-resolve pass above (on the
          // as-stored paths); only re-emit info + re-check the error gate here.
          const report = validateDeployConfig(config);
          for (const i of report.info) ctx.output.info(i);
          if (report.errors.length > 0) { for (const e of report.errors) ctx.output.error(e); process.exit(1); }

          // Reject stray scoping flags — meaningless without a rollout.
          if ([...options.host, ...options.only, ...options.class].length > 0) {
            ctx.output.error('--host/--only/--class have no effect with --pre-only/--post-only/--migrations-only.');
            process.exit(1);
          }

          if (!options.dryRun) {
            await assertMigrationControlPlaneCompatibility(
              config,
              options.mutationAuthTokenFile,
              ctx,
              openTunnels
            );
          }

          await runMigrationPhase(config.migration, 'pre-deploy', configName, ctx, undefined,
            { dryRun: options.dryRun, run: plan.runPre, integrityDirs: siblingIntegrityDirs(config, 'pre-deploy') });
          await runMigrationPhase(config.postMigration, 'post-deploy', configName, ctx, undefined,
            { dryRun: options.dryRun, run: plan.runPost, integrityDirs: siblingIntegrityDirs(config, 'post-deploy') });
          ctx.output.success(
            options.dryRun
              ? `[deploy] --dry-run: nothing executed (${options.migrationsOnly ? 'both phases' : options.preOnly ? 'pre only' : 'post only'}).`
              : `[deploy] migrations complete (${options.migrationsOnly ? 'pre + post' : options.preOnly ? 'pre' : 'post'}); no rollout.`,
          );
          return;
        }

        // ── Multi-class branch (Spec §3, §4) ──
        if (detectConfigShape(config) === 'multi-class') {
          // 1. Validate (zero network I/O) — hard violation aborts before any host.
          // Warnings already surfaced by the pre-resolve pass; re-emit info + error gate only.
          const report = validateDeployConfig(config);
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
          const preparedClasses = prepareSelectedDeployClasses(config, options);
          const selectedHosts = preparedClasses.flatMap(({ rc }) => rc.hosts);
          if (selectedHosts.length === 0) {
            ctx.output.error(
              'The selected node classes contain no target hosts; refusing ' +
              'credentials, tunnels, migrations, and deployment'
            );
            process.exit(1);
          }
          const mutationAuthTokens = options.dryRun
            ? new Map<string, string>()
            : loadHostMutationAuthTokens(
                config,
                selectedHosts,
                options.mutationAuthTokenFile
              );
          const preopenedTunnels = new Map<string, Tunnel>();
          if (!options.dryRun) {
            for (const { rc } of preparedClasses) {
              if (!rc.tunnel) continue;
              for (const host of rc.hosts) {
                try {
                  const tunnel = await openTunnel(host, {
                    user: rc.ssh?.user,
                    remotePort: rc.port,
                    readinessTimeoutMs: rc.ssh?.readinessTimeoutMs,
                  });
                  setEndpointOverride(host, '127.0.0.1', tunnel.localPort);
                  openTunnels.push(tunnel);
                  preopenedTunnels.set(host, tunnel);
                  ctx.output.info(
                    `  [${rc.name}] ${host} → 127.0.0.1:${tunnel.localPort}`
                  );
                } catch (err) {
                  throw new Error(
                    `[${rc.name}] SSH tunnel failed for ${host}; refusing direct ` +
                    `credential fallback: ${getErrorMessage(err)}`
                  );
                }
              }
            }
          }
          // 3. Global control-plane boundary:
          //    A) preflight EVERY selected class and HAProxy without mutation;
          //    B) only after A is complete, apply the exact requested updates;
          //    C) after every update succeeds, re-preflight EVERY class and
          //       discard all pre-update observations.
          // No migration or WAR dispatch is reachable until the whole boundary
          // commits. In particular, class A cannot update before a broken class B
          // has even been observed.
          const classPreflights = new Map<string, PreparedClassPreflight>();
          if (!options.dryRun) {
            // Phase A: complete read-only control-plane preflight for every class.
            const initialPreflightFailures: string[] = [];
            for (const { rc } of preparedClasses) {
              try {
                const { port: effectivePort, useTLS } = configureTLSForDeployment(
                  { ...config, tls: rc.tls, port: rc.port },
                  ctx
                );

                if (rc.tunnel) {
                  const missingTunnel = rc.hosts.find(
                    host => !preopenedTunnels.has(host)
                  );
                  if (missingTunnel) {
                    throw new Error(
                      `[${rc.name}] SSH tunnel snapshot is missing for ${missingTunnel}; ` +
                      'refusing direct credential fallback'
                    );
                  }
                }

                const warPath = resolve(rc.warPath!);
                let warInfo: WarInfo;
                try {
                  warInfo = await getWarInfo(warPath);
                } catch {
                  throw new Error(`[${rc.name}] WAR file not found: ${warPath}`);
                }

                if (!isPlain) {
                  console.log(
                    `\n${ANSI.bold}Preflight class: ${ANSI.cyan}${rc.name}${ANSI.reset}` +
                    `${ANSI.bold} (${rc.hosts.length} host${rc.hosts.length !== 1 ? 's' : ''})${ANSI.reset}`
                  );
                } else {
                  ctx.output.info(
                    `Preflight class: ${rc.name} (${rc.hosts.length} ` +
                    `host${rc.hosts.length !== 1 ? 's' : ''})`
                  );
                }
                new ProgressReporter(isPlain).showWarInfo(warInfo);
                const artifactSnapshot = await readLocalWarArtifactSnapshot(warPath);
                const localHashes = artifactSnapshot.hashes;

                const preflightResult = await executePreflightChecks({
                  hosts: rc.hosts,
                  port: effectivePort,
                  localHashes,
                  force: options.force ?? false,
                  isPlain,
                  useTLS,
                  mutationAuthTokens,
                });
                printPreflightSummary(preflightResult, rc.hosts.length, isPlain);
                const prepared: PreparedClassPreflight = {
                  className: rc.name,
                  hosts: [...rc.hosts],
                  warPath,
                  warInfo,
                  localHashes,
                  artifactSnapshot,
                  effectivePort,
                  useTLS,
                  controlPlaneConfig: {
                    ...config,
                    tls: rc.tls,
                    port: rc.port,
                  },
                  preflightResult,
                };
                assertCompleteClassPreflight(prepared, preflightResult);
                classPreflights.set(rc.name, prepared);
              } catch (err) {
                initialPreflightFailures.push(
                  `[${rc.name}] ${getErrorMessage(err)}`
                );
              }
            }
            if (initialPreflightFailures.length > 0) {
              throw new Error(
                'Global Payara preflight failed; refusing plugin updates, ' +
                `migrations, and WAR deployment: ${initialPreflightFailures.join('; ')}`
              );
            }

            // HAProxy is part of the same fleet-wide read-only boundary. Test
            // every selected class before the first plugin update. The per-class
            // executor consumes this result and must not repeat the check after
            // migrations have started.
            await assertGlobalHAProxyConnectivity(
              preparedClasses.flatMap(({ rc }) =>
                !options.skipDrain && rc.haproxy
                  ? [{ name: rc.name, config: rc.haproxy }]
                  : []
              ),
              ctx,
              isPlain
            );

            // Resolve the update decision once for the complete fleet snapshot.
            const pendingUpdateCount = [...classPreflights.values()].reduce(
              (count, prepared) => count + prepared.preflightResult.updateTargets.length,
              0
            );
            let shouldUpdate = options.updatePlugins ?? false;
            const bootstrapHosts = [...classPreflights.values()].flatMap(
              prepared => prepared.preflightResult.bootstrapUpdateHosts ?? []
            );
            if (pendingUpdateCount > 0 && !shouldUpdate && !options.yes) {
              console.log('');
              const inquirerModule = await import('inquirer');
              const answers = await inquirerModule.default.prompt([{
                type: 'confirm',
                name: 'update',
                message: `Update Payara plugins on ${pendingUpdateCount} host(s) before deploying?`,
                default: false,
              }]) as { update: boolean };
              shouldUpdate = answers.update;
            }

            if (bootstrapHosts.length > 0 && !shouldUpdate) {
              throw new Error(
                'CONTROL_PLANE_BOOTSTRAP_REQUIRED: Payara plugin 2 may only ' +
                'proceed through an exact Plugin 3 update on: ' +
                bootstrapHosts.join(', ')
              );
            }

            if (pendingUpdateCount > 0 && shouldUpdate) {
              // Phase B: attempt every class update group. Keep collecting
              // failures so one class cannot suppress the receipts for another.
              let hostsRestarting = 0;
              const updateFailures: string[] = [];
              for (const prepared of classPreflights.values()) {
                const targets = prepared.preflightResult.updateTargets;
                if (targets.length === 0) continue;
                try {
                  const connection = restorePreparedClassControlPlane(
                    prepared,
                    ctx
                  );
                  const result = await executePluginUpdates(
                    targets,
                    connection.port,
                    isPlain,
                    connection.useTLS,
                    mutationAuthTokens
                  );
                  hostsRestarting += result.hostsRestarting;
                } catch (err) {
                  updateFailures.push(
                    `[${prepared.className}] ${getErrorMessage(err)}`
                  );
                }
              }
              if (updateFailures.length > 0) {
                throw new Error(
                  `Global Payara plugin update failed; refusing migrations and ` +
                  `WAR deployment: ${updateFailures.join('; ')}`
                );
              }
              if (hostsRestarting > 0) {
                console.log('');
                await waitForAgentRestart(25, isPlain);
              }

              // Phase C: global post-update preflight. Build a replacement map
              // off to the side and publish it only after every class passes.
              const refreshedPreflights = new Map<string, PreparedClassPreflight>();
              const refreshedPreflightFailures: string[] = [];
              for (const prepared of classPreflights.values()) {
                try {
                  const connection = restorePreparedClassControlPlane(
                    prepared,
                    ctx
                  );
                  const preflightResult = await executePreflightChecks({
                    hosts: prepared.hosts,
                    port: connection.port,
                    localHashes: prepared.localHashes,
                    force: options.force ?? false,
                    isPlain,
                    useTLS: connection.useTLS,
                    mutationAuthTokens,
                  });
                  printPreflightSummary(
                    preflightResult,
                    prepared.hosts.length,
                    isPlain
                  );
                  assertCompleteClassPreflight(prepared, preflightResult, true);
                  refreshedPreflights.set(prepared.className, {
                    ...prepared,
                    preflightResult,
                  });
                } catch (err) {
                  refreshedPreflightFailures.push(
                    `[${prepared.className}] ${getErrorMessage(err)}`
                  );
                }
              }
              if (refreshedPreflightFailures.length > 0) {
                throw new Error(
                  'Global post-update Payara preflight failed; refusing ' +
                  `migrations and WAR deployment: ${refreshedPreflightFailures.join('; ')}`
                );
              }
              classPreflights.clear();
              for (const [name, prepared] of refreshedPreflights) {
                classPreflights.set(name, prepared);
              }
            }
          }

          // 4. Run the pre-deploy migration phase only after every selected
          //    class has a compatible, authenticated control-plane snapshot.
          //    --dry-run prints the plan without executing.
          await runMigrationPhase(config.migration, 'pre-deploy', configName, ctx, undefined, {
            dryRun: options.dryRun,
            run: plan.runPre,
            integrityDirs: siblingIntegrityDirs(config, 'pre-deploy'),
          });
          // 5. Run the multi-class deploy from the immutable pre-migration
          //    preflight snapshots and exit.
          const mcIsScoped =
            (options.class.length > 0 &&
              options.class.length < config.classes!.length) ||
            // per-class --host override on the single named class (B1c)
            ((options.class.length === 1) && [...options.host, ...options.only].length > 0);
          await runMultiClassDeploy(
            ctx,
            config,
            options,
            plan,
            mcIsScoped,
            preparedClasses,
            mutationAuthTokens,
            { preopenedTunnels, classPreflights, isPlain }
          );
          return; // handled — do not fall through to the flat path
        }

        if ((config.hosts ?? []).length === 0) {
          ctx.output.error('No hosts configured for this deployment');
          ctx.output.info(`Use "znvault payara config add-host ${configName} <host>" to add hosts`);
          process.exit(1);
        }

        // Validate migration blocks before touching any host (flat path — SF6).
        // Warnings already surfaced by the pre-resolve pass; error gate only.
        const flatReport = validateDeployConfig(config);
        if (flatReport.errors.length > 0) { for (const e of flatReport.errors) ctx.output.error(e); process.exit(1); }

        // Single-host filter (--host / --only) — scope a config deploy to a
        // subset (e.g. a canary) without redeploying every host. Filters into a
        // COPY so the persisted store is never mutated.
        const hostFilter = [...options.host, ...options.only];
        const configuredHostCount = config.hosts!.length; // pre --host-filter (B1b/B1 coverage baseline)
        const configuredHosts = [...config.hosts!];
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
        const flatIsScoped = hostFilter.length > 0
          ? isScopedDeploy(configuredHosts, config.hosts!)
          : false;

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

        // Capture the local WAR once. The same immutable bytes feed preflight
        // and every host, even if the source path changes during a rollout.
        const artifactSnapshot = await readLocalWarArtifactSnapshot(warPath);
        const localHashes = artifactSnapshot.hashes;
        const mutationAuthTokens = loadHostMutationAuthTokens(
          config,
          config.hosts!,
          options.mutationAuthTokenFile
        );

        // ═══════════════════════════════════════════════════════════════════
        // SSH TUNNEL PHASE (default in major 3; explicit false is fenced by core)
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
              throw new Error(
                `SSH tunnel failed for ${host}; refusing direct credential ` +
                `fallback: ${getErrorMessage(err)}`
              );
            }
          }
        }

        // Run parallel preflight checks
        if (!isPlain) {
          console.log(`${ANSI.bold}Checking ${config.hosts!.length} hosts...${ANSI.reset}`);
        } else {
          console.log(`Checking ${config.hosts!.length} hosts...`);
        }

        let preflightResult = await executePreflightChecks({
          hosts: config.hosts!,
          port: effectivePort,
          localHashes,
          force: options.force ?? false,
          isPlain,
          useTLS,
          mutationAuthTokens,
        });

        // Print summary
        printPreflightSummary(preflightResult, config.hosts!.length, isPlain);

        // A full flat rollout has the same all-host boundary as a multi-class
        // rollout. `--yes` may suppress prompts, but it must never turn a
        // missing/failed authenticated analysis into permission to migrate the
        // database or deploy only a subset of the configured fleet. Plugin 2
        // bootstrap hosts are the sole initial exception and remain update-only.
        assertCompleteClassPreflight(
          { className: configName, hosts: config.hosts! },
          preflightResult
        );

        // Handle unreachable hosts
        const unreachableHosts = config.hosts!.filter(h => !preflightResult.reachableHosts.includes(h));
        if (unreachableHosts.length > 0) {
          throw new Error(
            'CONTROL_PLANE_VERSION_UNVERIFIED: could not verify Agent 2 / ' +
            `Payara plugin 3 on ${unreachableHosts.join(', ')}; ` +
            'refusing migration/deployment'
          );
        }
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
        let reachableHosts = preflightResult.reachableHosts;
        if (reachableHosts.length === 0) {
          ctx.output.error('No hosts reachable for deployment');
          process.exit(1);
        }

        // HAProxy joins the initial read-only fleet boundary. It must be proven
        // before refreshPreflightAfterPluginUpdates can mutate even one host.
        // A dry-run never updates plugins and preserves the historical no-LB-I/O
        // behavior.
        if (!options.dryRun) {
          await assertGlobalHAProxyConnectivity(
            haproxyConfig
              ? [{ name: configName, config: haproxyConfig }]
              : [],
            ctx,
            isPlain
          );
          preflightResult = await refreshPreflightAfterPluginUpdates(
            preflightResult,
            {
              hosts: config.hosts!,
              port: effectivePort,
              localHashes,
              force: options.force ?? false,
              isPlain,
              useTLS,
              mutationAuthTokens,
              updatePlugins: options.updatePlugins,
              yes: options.yes,
              ctx,
            }
          );
        }
        reachableHosts = preflightResult.reachableHosts;

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

        // ═══════════════════════════════════════════════════════════════════
        // MIGRATION PHASE — PRE (guarded, runs once before any WAR swap)
        //
        // When `config.migration` is present, schema migrations are applied
        // to the database BEFORE the rolling WAR rollout begins. This means:
        //   - A migration failure aborts the deploy BEFORE any host is touched.
        //   - The new schema serves the old WAR during the rolling window
        //     (expand/contract forward-compat required — see spec §Forward-compat).
        //
        // When `config.migration` is absent, this block is skipped entirely
        // so existing deploy configs without migration settings are unaffected.
        // The -only shapes (no rollout) were already handled earlier and returned.
        //
        // Pre-deploy migrations run here — after both interactive cancel prompts,
        // before the up-to-date/dry-run returns (so pre isn't silently skipped).
        // ═══════════════════════════════════════════════════════════════════
        await runMigrationPhase(config.migration, 'pre-deploy', configName, ctx, undefined,
          { dryRun: options.dryRun, run: plan.runPre, integrityDirs: siblingIntegrityDirs(config, 'pre-deploy') });

        // Hash equality cannot prove that Payara dispatched that WAR. Every
        // target therefore performs a verified deploy, including a zero-diff
        // deploy, before it can contribute to the post-migration coverage gate.
        const hostsWithChanges = [...deployableHosts];

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
          await runMigrationPhase(config.postMigration, 'post-deploy', configName, ctx, undefined,
            { dryRun: true, run: plan.runPost, integrityDirs: siblingIntegrityDirs(config, 'post-deploy') });
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
          artifactSnapshot,
          port: effectivePort,
          force: options.force ?? false,
          analysisMap,
          healthCheck: config.healthCheck,
          useTLS,
          haproxy: haproxyConfig,
          quiesce: config.quiesce,
          hostConfigs: config.hostConfigs,
          mutationAuthTokens,
        });

        // Print final summary
        printDeploymentSummary(deployResult, deployableHosts.length, isPlain);

        // ═══════════════════════════════════════════════════════════════════
        // MIGRATION PHASE — POST (destructive; gated on full-coverage, no-failure rollout)
        //
        // Post-deploy migrations must NEVER run while any configured host still
        // serves the old WAR. The gate below requires: not scoped to a subset,
        // every configured host was deployed (no drops), and the rollout had no
        // failures (incl. worker failures).
        // ═══════════════════════════════════════════════════════════════════
        const noFailures = computeNoFailures(deployResult);
        const selectedMissingReceipts = missingVerifiedDeploymentReceipts(
          deployResult,
          config.hosts!
        );
        const dropped = missingVerifiedDeploymentReceipts(deployResult, configuredHosts);
        const fullCoverage = computeFullCoverage(
          configuredHostCount - dropped.length,
          configuredHostCount
        );
        const postSkipReason = resolvePostSkipReason({
          runPost: plan.runPost, runPostFlag: options.skipMigrations ? '--skip-migrations' : '--skip-post',
          isScoped: flatIsScoped, fullCoverage, noFailures, dropped,
        });
        try {
          await runMigrationPhase(config.postMigration, 'post-deploy', configName, ctx, undefined,
            { dryRun: options.dryRun, run: postSkipReason === undefined, skipReason: postSkipReason, integrityDirs: siblingIntegrityDirs(config, 'post-deploy') });
        } catch (postErr) {
          ctx.output.error(`Rollout succeeded but post-deploy migrations FAILED: ${getErrorMessage(postErr)}`);
          ctx.output.info(`Re-run just the post phase with: payara deploy run ${configName} --post-only`);
          process.exit(1);
        }

        if (
          deployResult.failed > 0
          || deployResult.aborted
          || deployResult.healthCheckFailed > 0
          || deployResult.workerFailed > 0
          || selectedMissingReceipts.length > 0
        ) {
          process.exit(1);
        }
      } catch (err) {
        ctx.output.error(`Deployment failed: ${getErrorMessage(err)}`);
        process.exit(1);
      } finally {
        // Normal-path teardown: close tunnels + clear overrides. (process.exit
        // paths are covered by the synchronous killTunnelsSync backstop above.)
        if (openTunnels.length > 0) {
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
  skipDrain?: boolean;
  updatePlugins?: boolean;
  host: string[];
  only: string[];
  class: string[];
  yes?: boolean;
  migrationsOnly?: boolean;
  skipMigrations?: boolean;
  skipPre?: boolean;
  skipPost?: boolean;
  preOnly?: boolean;
  postOnly?: boolean;
}

/**
 * Execute a multi-class deploy. Called from the action handler when
 * `detectConfigShape(config) === 'multi-class'`.
 *
 * Wiring:
 * 1. `partitionSelectedClasses` → selected classes in config order.
 * 2. If single --class + scoped strategy/host, apply override to that class
 *    (capturing each class's PRE-override host count for the coverage gate).
 * 3. For --dry-run: print plan, print the post-deploy plan line, and return.
 * 4. Warn if selected omits an upstream blocking class.
 * 5. Build `runClass(rc)` that per-class:
 *    - Reuses the pre-migration tunnel snapshot.
 *    - Reuses the fleet-wide control-plane and HAProxy preflight boundary.
 *    - Calls executeListrDeployment with suppressMixedClassWarning:true.
 *    - Returns `{ ctx, coverageOk }` — coverageOk computed at every return
 *      path and carried on the return value (not a side-channel map), so
 *      `executeMultiClassDeployment` can copy it onto `ClassOutcome.coverageOk`
 *      regardless of how/whether runClass is invoked (e.g. when mocked).
 *    - Closes that class's tunnels in a finally.
 * 6. `executeMultiClassDeployment(resolved, runClass, ctx.output)`.
 * 7. `printMultiClassSummary(result, isPlain)`.
 * 8. Gate + run the post-deploy migration phase: post-deploy migrations are
 *    DESTRUCTIVE and must NEVER run while any host — in any class, including
 *    a host dropped by a per-class `--host` override (B1c) — still serves the
 *    old WAR. Requires: not scoped (`isScoped`), full per-class coverage
 *    (read from `result.classes[i].coverageOk`), and no rollout failures
 *    (incl. worker failures), mirroring the flat-path gate.
 * 9. `if (result.abortedAt) process.exit(1)`.
 */
async function runMultiClassDeploy(
  ctx: CLIPluginContext,
  config: DeployConfig,
  options: DeployRunOptions,
  plan: DeployPlan,
  isScoped: boolean,
  preparedClasses: PreparedDeployClass[],
  mutationAuthTokens: ReadonlyMap<string, string>,
  shared: {
    preopenedTunnels: ReadonlyMap<string, Tunnel>;
    classPreflights: ReadonlyMap<string, PreparedClassPreflight>;
    isPlain: boolean;
  },
): Promise<void> {
  const { preopenedTunnels, classPreflights, isPlain } = shared;

  // 2. Resolve the classes (inheriting config-level defaults).
  // We track each class's scoped strategy override SEPARATELY from rc.strategy (the
  // config-file value) so that resolveClassStrategy() can apply the correct priority:
  //   explicit --class X --strategy  >  --sequential  >  class config strategy
  //
  // preOverrideClassHostCount: the PRE-override host count per class, captured
  // BEFORE any per-class --host/--only filter shrinks rc.hosts. Post-deploy
  // coverage must compare against this original count, not the shrunk one —
  // otherwise a per-class --host override (B1c) would make a scoped/partial
  // deploy look like "full coverage" and destructive post migrations could run
  // while hosts dropped by the override still serve the old WAR.
  const preOverrideClassHostCount = new Map(
    preparedClasses.map(({ rc, preOverrideHostCount }) => [rc.name, preOverrideHostCount])
  );
  const resolvedWithOverrides = preparedClasses.map(
    ({ rc, scopedStrategyOverride }) => ({ rc, scopedStrategyOverride })
  );
  const resolved = resolvedWithOverrides.map(({ rc }) => rc);

  // 3. For --dry-run: print plan and return.
  if (options.dryRun) {
    // Resolve the effective strategy for each class using the correct priority:
    //   explicit --class X --strategy  >  --sequential  >  class config strategy
    // (mirrors the executor path so the printed plan always matches what would run).
    const effectiveStrategies = resolvedWithOverrides.map(({ rc, scopedStrategyOverride }) =>
      resolveClassStrategy(rc.strategy, scopedStrategyOverride, options.sequential)
    );
    printMultiClassDryRun(resolved, effectiveStrategies, isPlain);
    await runMigrationPhase(config.postMigration, 'post-deploy', config.name, ctx, undefined,
      { dryRun: true, run: plan.runPost, integrityDirs: siblingIntegrityDirs(config, 'post-deploy') });
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

  // Build a lookup from class name → scoped strategy override for the executor.
  const scopedStrategyOverrideMap = new Map<string, string | undefined>(
    resolvedWithOverrides.map(({ rc, scopedStrategyOverride }) => [rc.name, scopedStrategyOverride])
  );

  // 5. Build runClass(rc) — per-class: reuse preflight + executeListrDeployment.
  // Returns { ctx, coverageOk }: coverageOk is true iff every PRE-override configured
  // host for this class was deployed (computed at every return path below, including
  // the early no-hosts/unreachable returns, which always resolve to false — the class
  // did not fully deploy). Carried on the return value so executeMultiClassDeployment
  // can copy it onto ClassOutcome.coverageOk — no side-channel map.
  const runClass = async (rc: typeof resolved[0]): Promise<RunClassResult> => {
    const classTunnels: Tunnel[] = [];

    try {
      // Configure TLS for this class.
      const { port: effectivePort, useTLS } = configureTLSForDeployment({ ...config, tls: rc.tls, port: rc.port }, ctx);

      // Tunnels were opened for every selected class before pre-migrations.
      // Reuse that exact transport snapshot; never fall back to a direct URL.
      if (rc.tunnel) {
        for (const host of rc.hosts) {
          const tunnel = preopenedTunnels.get(host);
          if (!tunnel) {
            throw new Error(
              `[${rc.name}] SSH tunnel snapshot is missing for ${host}; ` +
              'refusing direct credential fallback'
            );
          }
          classTunnels.push(tunnel);
        }
      }

      const prepared = classPreflights.get(rc.name);
      if (!prepared) {
        throw new Error(
          `[${rc.name}] authenticated preflight snapshot is missing; ` +
          'refusing deployment'
        );
      }
      const {
        warPath,
        warInfo,
        localHashes,
        artifactSnapshot,
        preflightResult,
      } = prepared;

      // Announce class and WAR info.
      if (!isPlain) {
        console.log(`\n${ANSI.bold}Class: ${ANSI.cyan}${rc.name}${ANSI.reset}${ANSI.bold} (${rc.hosts.length} host${rc.hosts.length !== 1 ? 's' : ''})${ANSI.reset}`);
      } else {
        ctx.output.info(`Class: ${rc.name} (${rc.hosts.length} host${rc.hosts.length !== 1 ? 's' : ''})`);
      }
      const classProgress = new ProgressReporter(isPlain);
      classProgress.showWarInfo(warInfo);

      // HAProxy config for this class (skip drain if --skip-drain).
      const haproxyConfig = (!options.skipDrain && rc.haproxy) ? rc.haproxy : undefined;

      // Filter to reachable hosts.
      const reachableHosts = preflightResult.reachableHosts;
      if (reachableHosts.length === 0) {
        ctx.output.error(`[${rc.name}] No hosts reachable`);
        return {
          ctx: {
            results: new Map(), aborted: false, skipped: 0,
            successful: 0, failed: rc.hosts.length, healthCheckFailed: 0, workerFailed: 0,
          },
          coverageOk: false,
        };
      }

      // Filter to deployable (successful analysis).
      const deployableHosts = reachableHosts.filter(h => preflightResult.analysisMap.get(h)?.success);
      if (deployableHosts.length === 0) {
        ctx.output.error(`[${rc.name}] No hosts available for deployment`);
        return {
          ctx: {
            results: new Map(), aborted: false, skipped: 0,
            successful: 0, failed: rc.hosts.length, healthCheckFailed: 0, workerFailed: 0,
          },
          coverageOk: false,
        };
      }

      // There is intentionally no up-to-date fast path. Disk hashes do not
      // prove runtime dispatch, so every class target must produce a verified
      // deployment result before post-deploy migrations are eligible.
      const hostsWithChanges = [...deployableHosts];

      // Resolve the class-scoped strategy using the correct priority:
      //   explicit --class X --strategy  >  --sequential  >  class config strategy
      const classScopedStrategy = resolveClassStrategy(
        rc.strategy,                                     // priority 3: class config strategy
        scopedStrategyOverrideMap.get(rc.name),          // priority 1: explicit scoped --strategy
        options.sequential,                              // priority 2: bare --sequential flag
      );

      let strategy;
      try {
        strategy = parseDeploymentStrategy(classScopedStrategy);
      } catch (err) {
        ctx.output.error(`[${rc.name}] ${getErrorMessage(err)}`);
        return {
          ctx: {
            results: new Map(), aborted: false, skipped: 0,
            successful: 0, failed: hostsWithChanges.length, healthCheckFailed: 0, workerFailed: 0,
          },
          coverageOk: false,
        };
      }

      // Execute deployment.
      console.log('');
      const deployOpts: ListrDeployOptions = {
        ctx,
        warPath,
        localHashes,
        artifactSnapshot,
        port: effectivePort,
        force: options.force ?? false,
        analysisMap: preflightResult.analysisMap,
        healthCheck: rc.healthCheck,
        useTLS,
        haproxy: haproxyConfig,
        quiesce: rc.quiesce,
        hostConfigs: rc.hostConfigs,
        suppressMixedClassWarning: true,
        mutationAuthTokens,
      };

      const deployCtx = await executeListrDeployment(strategy, deployableHosts, deployOpts);
      const missingReceipts = missingVerifiedDeploymentReceipts(deployCtx, rc.hosts);
      return {
        ctx: deployCtx,
        coverageOk:
          rc.hosts.length === (preOverrideClassHostCount.get(rc.name) ?? rc.hosts.length)
          && missingReceipts.length === 0,
      };
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

  // ═══════════════════════════════════════════════════════════════════
  // MIGRATION PHASE — POST (destructive; gated on full-coverage, no-failure rollout)
  //
  // Mirrors the flat-path gate: post-deploy migrations must NEVER run while
  // any configured host — across every class, including one dropped by a
  // per-class --host override (B1c) — still serves the old WAR.
  // ═══════════════════════════════════════════════════════════════════
  const selectedHostsByClass = new Map(resolved.map(rc => [rc.name, rc.hosts]));
  const outcomeByClass = new Map(result.classes.map(outcome => [outcome.name, outcome]));
  const missingReceiptsByClass = new Map(
    resolved.map(rc => {
      const outcome = outcomeByClass.get(rc.name);
      return [
        rc.name,
        outcome?.ctx
        ? missingVerifiedDeploymentReceipts(
            outcome.ctx,
            rc.hosts
          )
        : rc.hosts,
      ];
    })
  );
  const noFailures = !result.abortedAt && resolved.every((rc) => {
    const outcome = outcomeByClass.get(rc.name);
    return outcome?.ran === true
      && outcome.ctx !== undefined
      && outcome.ctx.failed === 0
      && outcome.ctx.healthCheckFailed === 0
      && outcome.ctx.workerFailed === 0
      && !outcome.ctx.aborted;
  });
  // Coverage rides on ClassOutcome.coverageOk (set by executeMultiClassDeployment from
  // runClass's return value) — NOT a closure side-map — so the gate reads real per-class
  // data even when executeMultiClassDeployment is mocked. A class that ran must have
  // coverageOk === true; undefined/false means a host was dropped pre-rollout.
  const fullCoverage = resolved.every((rc) => {
    const outcome = outcomeByClass.get(rc.name);
    return outcome?.ran === true
      && outcome.coverageOk === true
      && (missingReceiptsByClass.get(rc.name)?.length ?? 0) === 0;
  });
  const dropped = Array.from(new Set(resolved.flatMap((rc) => {
    const outcome = outcomeByClass.get(rc.name);
    const missingReceipts = missingReceiptsByClass.get(rc.name) ?? [];
    if (missingReceipts.length > 0) {
      return missingReceipts.map(host => `${rc.name}:${host}`);
    }
    return outcome?.coverageOk !== true ? [rc.name] : [];
  })));
  const postSkipReason = resolvePostSkipReason({
    runPost: plan.runPost, runPostFlag: options.skipMigrations ? '--skip-migrations' : '--skip-post',
    isScoped, fullCoverage, noFailures, dropped,
  });
  try {
    await runMigrationPhase(config.postMigration, 'post-deploy', config.name, ctx, undefined,
      { dryRun: options.dryRun, run: postSkipReason === undefined, skipReason: postSkipReason, integrityDirs: siblingIntegrityDirs(config, 'post-deploy') });
  } catch (postErr) {
    ctx.output.error(`Rollout succeeded but post-deploy migrations FAILED: ${getErrorMessage(postErr)}`);
    ctx.output.info(`Re-run just the post phase with: payara deploy run ${config.name} --post-only`);
    process.exit(1);
  }

  // 8. A scoped run may deliberately omit configured hosts, but every host
  // selected for this invocation still requires its own verified receipt. This
  // also catches pre-deploy orchestration failures that never reached the
  // deployment helper and therefore cannot be inferred from preflight counts.
  const selectedRolloutFailed = resolved.some(rc => {
    const outcome = outcomeByClass.get(rc.name);
    if (outcome?.ran !== true || !outcome.ctx) return true;
    const selectedHosts = selectedHostsByClass.get(rc.name) ?? [];
    return missingVerifiedDeploymentReceipts(outcome.ctx, selectedHosts).length > 0
      || outcome.ctx.failed > 0
      || outcome.ctx.healthCheckFailed > 0
      || outcome.ctx.workerFailed > 0
      || outcome.ctx.aborted;
  });
  if (result.abortedAt || selectedRolloutFailed) {
    process.exit(1);
  }
}
