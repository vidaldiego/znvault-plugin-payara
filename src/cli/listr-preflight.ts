// Path: src/cli/listr-preflight.ts
// Listr2-based parallel pre-deployment checks

import { Listr, ListrTask, PRESET_TIMER } from 'listr2';
import type { WarFileHashes } from '../types.js';
import type { PluginVersionCheckResult, PluginVersionInfo } from './types.js';
import type { PreflightResult } from './progress.js';
import { analyzeHost } from './commands/deploy.js';
import { getErrorMessage } from '../utils/error.js';
import type {
  HostAnalysis,
  PluginUpdateRequest,
} from '@zincapp/znvault-deploy-core';
import {
  checkHostReachable,
  checkPluginVersions,
  triggerPluginUpdate,
  createDeploymentId,
  agentGet,
  buildPluginUrl,
  formatSize,
  type AgentRequestAuth,
} from '@zincapp/znvault-deploy-core';

export const PAYARA_PLUGIN_PACKAGE = '@zincapp/znvault-plugin-payara';
const EXACT_SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/** Select exactly one Payara record and ignore unrelated plugin metadata. */
export function getPayaraVersion(
  result: PluginVersionCheckResult
): PluginVersionInfo | undefined {
  const matches = result.response?.versions.filter(
    version => version.package === PAYARA_PLUGIN_PACKAGE
  ) ?? [];
  if (matches.length > 1) {
    throw new Error('Agent returned duplicate Payara plugin version records');
  }
  return matches[0];
}

/** Select exactly one offered Payara update. */
export function getPayaraUpdate(
  result: PluginVersionCheckResult
): PluginVersionInfo | undefined {
  const version = getPayaraVersion(result);
  return version?.updateAvailable ? version : undefined;
}

/**
 * Result of pre-deployment check for a single host
 */
export interface HostPreflightResult {
  host: string;
  /** Preflight check result */
  preflight: PreflightResult;
  /** Plugin version check result (only if reachable) */
  versionCheck?: PluginVersionCheckResult;
  /** Analysis result (only if reachable) */
  analysis?: HostAnalysis;
  /** Plugin 2 is authenticated but may only proceed through the exact update rail. */
  requiresPluginBootstrap?: boolean;
}

/**
 * Context for preflight Listr tasks
 */
export interface PreflightContext {
  results: Map<string, HostPreflightResult>;
  reachableHosts: string[];
  hostsWithUpdates: string[];
  analysisMap: Map<string, HostAnalysis>;
  /** Hosts that need plugin updates */
  updateTargets: Array<{ host: string; result: PluginVersionCheckResult }>;
  /** Reachable Agent 2 hosts whose loaded Payara 2 must be upgraded before analysis. */
  bootstrapUpdateHosts: string[];
  /** Number of hosts that will restart after update */
  hostsRestarting: number;
}

/**
 * Options for preflight execution
 */
export interface PreflightOptions {
  hosts: string[];
  port: number;
  localHashes: WarFileHashes;
  force: boolean;
  isPlain: boolean;
  /** Whether to use HTTPS for agent connections */
  useTLS?: boolean;
  /** Dedicated per-host credentials for the protected Payara namespace. */
  mutationAuthTokens: ReadonlyMap<string, string>;
}

function parseMajor(version: string | undefined): number | undefined {
  const match = /^v?(\d+)\.\d+\.\d+(?:[-+].*)?$/u.exec(version ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Major-3 CLI is safe only with the coordinated Agent 2 / Payara 3 pair. */
function assertSupportedAgentVersion(
  host: string,
  agentVersion: string | undefined
): void {
  if (parseMajor(agentVersion) !== 2) {
    throw new Error(
      `CONTROL_PLANE_VERSION_INCOMPATIBLE: ${host} reports Agent ` +
      `'${agentVersion ?? 'unknown'}'; Payara plugin 3 CLI requires Agent >=2 <3`
    );
  }
}

function assertSupportedPluginVersion(
  host: string,
  pluginVersion: string | undefined
): void {
  if (parseMajor(pluginVersion) !== 3) {
    throw new Error(
      `CONTROL_PLANE_VERSION_INCOMPATIBLE: ${host} reports Payara plugin ` +
      `'${pluginVersion ?? 'unknown'}'; Payara plugin 3 CLI requires plugin >=3 <4`
    );
  }
}

function assertLoadedPluginVersionMatches(
  host: string,
  healthVersion: string | undefined,
  authenticatedVersion: string | undefined
): asserts authenticatedVersion is string {
  if (
    healthVersion === undefined
    || authenticatedVersion === undefined
    || healthVersion !== authenticatedVersion
  ) {
    throw new Error(
      `CONTROL_PLANE_VERSION_DRIFT: ${host} root health reports Payara ` +
      `'${healthVersion ?? 'unknown'}', but authenticated status reports ` +
      `'${authenticatedVersion ?? 'unknown'}'`
    );
  }
}

function assertExactBootstrapUpdate(
  host: string,
  runningPluginVersion: string,
  versionCheck: PluginVersionCheckResult
): PluginVersionInfo {
  if (!versionCheck.success || !versionCheck.response) {
    throw new Error(
      `CONTROL_PLANE_BOOTSTRAP_UNVERIFIED: ${host} runs Payara plugin ` +
      `${runningPluginVersion}, but exact Agent update metadata is unavailable`
    );
  }
  const update = getPayaraVersion(versionCheck);
  if (!update) {
    throw new Error(
      `CONTROL_PLANE_BOOTSTRAP_UNVERIFIED: ${host} has no exact Payara package record`
    );
  }
  if (update.current !== runningPluginVersion) {
    throw new Error(
      `CONTROL_PLANE_BOOTSTRAP_CURRENT_MISMATCH: ${host} runs Payara plugin ` +
      `${runningPluginVersion}, but updater metadata reports ${update.current}`
    );
  }
  assertExactUpdaterRail(host, update, 'CONTROL_PLANE_BOOTSTRAP');
  if (
    parseMajor(update.current) !== 2
    || parseMajor(update.latest) !== 3
    || update.updateAvailable !== true
    || update.current === update.latest
  ) {
    throw new Error(
      `CONTROL_PLANE_BOOTSTRAP_TARGET_INVALID: ${host} lacks an exact ` +
      `Payara 2 -> 3 update target (current ${update.current}, target ${update.latest})`
    );
  }
  return update;
}

function assertExactUpdaterRail(
  host: string,
  version: PluginVersionInfo,
  errorPrefix: string
): void {
  if (
    version.channel !== 'dr-m4'
    || version.updaterReady !== true
    || version.targetVersion !== version.latest
    || !EXACT_SEMVER_PATTERN.test(version.current)
    || !EXACT_SEMVER_PATTERN.test(version.latest)
  ) {
    throw new Error(
      `${errorPrefix}_UPDATER_RAIL_INVALID: ${host} Payara updater metadata ` +
      `must prove exact current/latest semvers, channel dr-m4, updaterReady ` +
      `true, and targetVersion exactly equal to latest ${version.latest}`
    );
  }
}

function assertExactCompatiblePluginMetadata(
  host: string,
  runningPluginVersion: string,
  versionCheck: PluginVersionCheckResult
): PluginVersionInfo {
  if (!versionCheck.success || !versionCheck.response) {
    throw new Error(
      `CONTROL_PLANE_UPDATE_METADATA_UNVERIFIED: ${host} did not return ` +
      'authenticated Agent updater metadata for Payara'
    );
  }
  const version = getPayaraVersion(versionCheck);
  if (!version) {
    throw new Error(
      `CONTROL_PLANE_UPDATE_METADATA_UNVERIFIED: ${host} has no exact ` +
      'Payara package record'
    );
  }
  if (version.current !== runningPluginVersion) {
    throw new Error(
      `CONTROL_PLANE_UPDATE_CURRENT_MISMATCH: ${host} authenticated status ` +
      `reports Payara ${runningPluginVersion}, but updater metadata reports ` +
      version.current
    );
  }
  assertExactUpdaterRail(host, version, 'CONTROL_PLANE_UPDATE');
  if (
    (version.updateAvailable && (
      version.current === version.latest || parseMajor(version.latest) !== 3
    ))
    || (!version.updateAvailable && version.current !== version.latest)
  ) {
    throw new Error(
      `CONTROL_PLANE_UPDATE_TARGET_INVALID: ${host} returned inconsistent or ` +
      `unsupported Payara update metadata (current ${version.current}, ` +
      `target ${version.latest}, available ${String(version.updateAvailable)})`
    );
  }
  return version;
}

export function assertSupportedControlPlaneVersions(
  host: string,
  agentVersion: string | undefined,
  pluginVersion: string | undefined
): void {
  assertSupportedAgentVersion(host, agentVersion);
  assertSupportedPluginVersion(host, pluginVersion);
}

/**
 * Prove that one target is running the only control-plane pair supported by
 * Payara plugin 3 CLI. This check is intentionally not optional: migration-only rails
 * use it too, before they mutate a database without a WAR analysis.
 */
export async function assertHostControlPlaneCompatible(
  host: string,
  port: number,
  useTLS: boolean | undefined,
  mutationAuthToken: string
): Promise<PreflightResult> {
  if (!mutationAuthToken) {
    throw new Error(`Payara credential was not loaded for host '${host}'`);
  }

  const preflight = await checkHostReachable(host, port, undefined, useTLS);
  if (!preflight.reachable) {
    throw new Error(
      `CONTROL_PLANE_VERSION_UNVERIFIED: ${host} is unreachable; ` +
      'Payara plugin 3 CLI requires Agent >=2 <3 and plugin >=3 <4'
    );
  }

  // Reject Agent 1 before touching a Payara status rail that relies on Agent
  // 2's outer authentication and coordinated lock contract.
  assertSupportedAgentVersion(host, preflight.agentVersion);
  // Standalone and migration-only rails never bootstrap. Reject a root-health
  // Plugin 2 observation without invoking any Plugin 2-owned route.
  assertSupportedPluginVersion(host, preflight.pluginVersion);
  const requestAuth: AgentRequestAuth = { bearerToken: mutationAuthToken };
  const versionCheck = await checkPluginVersions(
    host,
    port,
    useTLS,
    'payara',
    requestAuth
  );
  const pluginUrl = buildPluginUrl(host, port, useTLS);
  const running = await agentGet<{ pluginVersion?: string }>(
    `${pluginUrl}/status`,
    undefined,
    requestAuth
  );
  assertLoadedPluginVersionMatches(
    host,
    preflight.pluginVersion,
    running.pluginVersion
  );
  assertSupportedPluginVersion(host, running.pluginVersion);
  assertExactCompatiblePluginMetadata(
    host,
    running.pluginVersion,
    versionCheck
  );
  return preflight;
}

/**
 * Create a preflight task for a single host
 * Runs: reachability -> version check -> analysis (all sequential per host)
 */
function createHostPreflightTask(
  host: string,
  options: PreflightOptions
): ListrTask<PreflightContext> {
  return {
    title: host,
    task: async (ctx, task) => {
      const result: HostPreflightResult = {
        host,
        preflight: { host, reachable: false },
      };

      const mutationAuthToken = options.mutationAuthTokens.get(host);
      if (!mutationAuthToken) {
        throw new Error(`Payara credential was not loaded for host '${host}'`);
      }
      const requestAuth: AgentRequestAuth = { bearerToken: mutationAuthToken };

      // Step 1: Check root health reachability (the root health snapshot is public).
      task.output = 'Checking connectivity...';
      const preflight = await checkHostReachable(
        host,
        options.port,
        undefined,
        options.useTLS
      );
      if (!preflight.reachable) {
        throw new Error(
          `CONTROL_PLANE_VERSION_UNVERIFIED: ${host} is unreachable; ` +
          'Payara plugin 3 CLI requires Agent >=2 <3'
        );
      }
      assertSupportedAgentVersion(host, preflight.agentVersion);
      result.preflight = preflight;

      ctx.reachableHosts.push(host);
      const agentInfo = preflight.agentVersion ? `agent ${preflight.agentVersion}` : '';
      const payaraInfo = preflight.pluginRunning ? 'payara running' : 'payara stopped';

      // Step 2: read authenticated Agent-owned updater metadata. A loaded
      // Plugin 2 is allowed only as a transient bootstrap state when its exact
      // health version equals `current` and Agent offers one exact Plugin 3
      // target. Never call a Plugin 2 status/analyze route.
      task.output = 'Checking plugin versions...';
      const versionCheck = await checkPluginVersions(
        host,
        options.port,
        options.useTLS,
        'payara',
        requestAuth
      );
      result.versionCheck = versionCheck;

      if (parseMajor(preflight.pluginVersion) === 2) {
        assertExactBootstrapUpdate(host, preflight.pluginVersion!, versionCheck);
        result.requiresPluginBootstrap = true;
        ctx.hostsWithUpdates.push(host);
        ctx.bootstrapUpdateHosts.push(host);
        ctx.updateTargets.push({ host, result: versionCheck });
        task.title = `${host} (${agentInfo}, Payara ${preflight.pluginVersion}) - bootstrap update required`;
        ctx.results.set(host, result);
        return;
      }

      // Plugin 3 must prove the exact loaded version through its authenticated
      // status route before any WAR analysis. Agent-owned updater metadata is
      // part of the same exact snapshot and cannot disagree with that version.
      assertSupportedPluginVersion(host, preflight.pluginVersion);
      const pluginUrl = buildPluginUrl(host, options.port, options.useTLS);
      const running = await agentGet<{ pluginVersion?: string }>(
        `${pluginUrl}/status`,
        undefined,
        requestAuth
      );
      assertLoadedPluginVersionMatches(
        host,
        preflight.pluginVersion,
        running.pluginVersion
      );
      assertSupportedPluginVersion(host, running.pluginVersion);

      const payaraVersion = assertExactCompatiblePluginMetadata(
        host,
        running.pluginVersion,
        versionCheck
      );

      if (payaraVersion.updateAvailable) {
        ctx.hostsWithUpdates.push(host);
        ctx.updateTargets.push({ host, result: versionCheck });
      }

      // Step 3: Analyze what needs to be deployed
      task.output = 'Analyzing deployment...';
      const analysis = await analyzeHost(
        host,
        options.port,
        options.localHashes,
        options.force,
        mutationAuthToken,
        options.useTLS
      );
      result.analysis = analysis;

      if (analysis.success) {
        ctx.analysisMap.set(host, analysis);
        const changes = `+${analysis.filesChanged} -${analysis.filesDeleted}`;
        const size = formatSize(analysis.bytesToUpload);
        const mode = analysis.isFullUpload ? 'full' : 'diff';
        task.title = `${host} (${agentInfo}, ${payaraInfo}) ${changes} (${size}, ${mode})`;
      } else {
        task.title = `${host} (${agentInfo}, ${payaraInfo}) - analysis failed`;
      }

      ctx.results.set(host, result);
    },
    rendererOptions: {
      outputBar: 1,
    },
  };
}

/**
 * Execute parallel preflight checks for all hosts
 */
export async function executePreflightChecks(
  options: PreflightOptions
): Promise<PreflightContext> {
  const ctx: PreflightContext = {
    results: new Map(),
    reachableHosts: [],
    hostsWithUpdates: [],
    analysisMap: new Map(),
    updateTargets: [],
    bootstrapUpdateHosts: [],
    hostsRestarting: 0,
  };

  const tasks = options.hosts.map(host => createHostPreflightTask(host, options));

  const listrOptions = {
    concurrent: true,
    collectErrors: 'minimal' as const,
    rendererOptions: {
      collapseSubtasks: false,
      timer: PRESET_TIMER,
    },
    ctx,
  };

  const listr = options.isPlain
    ? new Listr<PreflightContext, 'simple'>(tasks, { ...listrOptions, renderer: 'simple' })
    : new Listr<PreflightContext, 'default'>(tasks, { ...listrOptions, renderer: 'default' });

  await listr.run();

  return ctx;
}

/**
 * Execute plugin updates in parallel
 */
export async function executePluginUpdates(
  targets: Array<{ host: string; result: PluginVersionCheckResult }>,
  port: number,
  isPlain: boolean,
  useTLS: boolean,
  mutationAuthTokens: ReadonlyMap<string, string>
): Promise<{ hostsRestarting: number }> {
  let hostsRestarting = 0;
  const failedHosts: string[] = [];

  const tasks: ListrTask[] = targets.map(({ host, result }) => ({
    title: `${host}: updating plugins`,
    task: async (_ctx, task) => {
      try {
        const update = getPayaraUpdate(result);
        if (!update) {
          throw new Error('Payara update target is missing from preflight receipt');
        }
        task.output = `Updating ${update.package}@${update.latest}...`;

        const mutationAuthToken = mutationAuthTokens.get(host);
        if (!mutationAuthToken) {
          throw new Error(`Payara credential was not loaded for host '${host}'`);
        }
        const requestId = createDeploymentId();
        const updateRequest: PluginUpdateRequest = {
          requestId,
          package: PAYARA_PLUGIN_PACKAGE,
          expectedCurrentVersion: update.current,
          expectedVersion: update.latest,
        };
        const updateResult = await triggerPluginUpdate(
          host,
          port,
          useTLS,
          'payara',
          updateRequest,
          { bearerToken: mutationAuthToken }
        );

        if (!updateResult.success) {
          throw new Error(updateResult.error ?? 'unknown plugin update error');
        }
        const response = updateResult.response;
        const receipts = response?.results.filter(
          receipt => receipt.package === PAYARA_PLUGIN_PACKAGE
        ) ?? [];
        const receipt = receipts[0];
        if (
          response?.requestId !== requestId
          || response.results.length !== 1
          || receipts.length !== 1
          || receipt?.success !== true
          || receipt.previousVersion !== update.current
          || receipt.newVersion !== update.latest
          || response.updated !== 1
          || response.willRestart !== true
        ) {
          throw new Error(
            'Agent update receipt did not prove the exact Payara current/target transition'
          );
        }
        const count = response.updated;
        task.title = `${host}: ${count} plugin(s) updated`;
        if (response.willRestart) {
          hostsRestarting++;
          task.title += ' (restarting)';
        }
      } catch (err) {
        failedHosts.push(host);
        task.title = `${host}: update failed - ${getErrorMessage(err)}`;
        throw err;
      }
    },
    rendererOptions: {
      outputBar: 1,
    },
  }));

  const listrOptions = {
    concurrent: true,
    exitOnError: false,
    collectErrors: 'minimal' as const,
    rendererOptions: {
      collapseSubtasks: false,
      timer: PRESET_TIMER,
    },
  };

  const listr = isPlain
    ? new Listr<unknown, 'simple'>(tasks, { ...listrOptions, renderer: 'simple' })
    : new Listr<unknown, 'default'>(tasks, { ...listrOptions, renderer: 'default' });

  try {
    await listr.run();
  } catch {
    // Listr runs every target so the receipt is complete. The aggregate below
    // is the fail-closed boundary consumed by deploy-run.
  }
  if (failedHosts.length > 0) {
    throw new Error(
      `Plugin update failed on ${failedHosts.length} of ${targets.length} host(s): ` +
      failedHosts.join(', ')
    );
  }

  return { hostsRestarting };
}

/**
 * Wait for agents to restart with a countdown
 */
export async function waitForAgentRestart(
  seconds: number,
  isPlain: boolean
): Promise<void> {
  const tasks: ListrTask[] = [{
    title: `Waiting for agents to restart (${seconds}s)`,
    task: async (_ctx, task) => {
      for (let i = seconds; i > 0; i--) {
        task.title = `Waiting for agents to restart (${i}s)`;
        await new Promise(r => setTimeout(r, 1000));
      }
      task.title = 'Agents restarted';
    },
  }];

  const listr = isPlain
    ? new Listr<unknown, 'simple'>(tasks, { renderer: 'simple' })
    : new Listr<unknown, 'default'>(tasks, {
        renderer: 'default',
        rendererOptions: { collapseSubtasks: false },
      });

  await listr.run();
}

/**
 * Print preflight summary
 */
export function printPreflightSummary(
  ctx: PreflightContext,
  totalHosts: number,
  isPlain: boolean
): void {
  const unreachable = totalHosts - ctx.reachableHosts.length;

  if (unreachable > 0) {
    if (isPlain) {
      console.log(`${ctx.reachableHosts.length}/${totalHosts} hosts reachable, ${unreachable} unreachable`);
    } else {
      console.log(`\x1b[33m${ctx.reachableHosts.length}/${totalHosts} hosts reachable\x1b[0m, ${unreachable} unreachable`);
    }
  }

  if (ctx.hostsWithUpdates.length > 0) {
    if (isPlain) {
      console.log(`${ctx.hostsWithUpdates.length}/${totalHosts} hosts have plugin updates available`);
    } else {
      console.log(`\x1b[36m${ctx.hostsWithUpdates.length}/${totalHosts} hosts have plugin updates available\x1b[0m`);
    }
  }
}
