// Path: src/cli/listr-preflight.ts
// Listr2-based parallel pre-deployment checks

import { Listr, ListrTask, PRESET_TIMER } from 'listr2';
import type { WarFileHashes } from '../types.js';
import type { PluginVersionCheckResult } from './types.js';
import type { PreflightResult } from './progress.js';
import type { HostAnalysis } from './unified-progress.js';
import { checkHostReachable, checkPluginVersions, triggerPluginUpdate } from './host-checks.js';
import { analyzeHost } from './commands/deploy.js';
import { formatSize } from './formatters.js';

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
  skipVersionCheck: boolean;
  isPlain: boolean;
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

      // Step 1: Check reachability
      task.output = 'Checking connectivity...';
      const preflight = await checkHostReachable(host, options.port);
      result.preflight = preflight;

      if (!preflight.reachable) {
        task.title = `${host} - unreachable`;
        ctx.results.set(host, result);
        return;
      }

      ctx.reachableHosts.push(host);
      const agentInfo = preflight.agentVersion ? `agent ${preflight.agentVersion}` : '';
      const payaraInfo = preflight.payaraRunning ? 'payara running' : 'payara stopped';

      // Step 2: Check plugin versions (if not skipped)
      if (!options.skipVersionCheck) {
        task.output = 'Checking plugin versions...';
        const versionCheck = await checkPluginVersions(host, options.port);
        result.versionCheck = versionCheck;

        if (versionCheck.success && versionCheck.response?.hasUpdates) {
          ctx.hostsWithUpdates.push(host);
          ctx.updateTargets.push({ host, result: versionCheck });
        }
      }

      // Step 3: Analyze what needs to be deployed
      task.output = 'Analyzing deployment...';
      const analysis = await analyzeHost(host, options.port, options.localHashes, options.force);
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
  isPlain: boolean
): Promise<{ hostsRestarting: number }> {
  let hostsRestarting = 0;

  const tasks: ListrTask[] = targets.map(({ host, result }) => ({
    title: `${host}: updating plugins`,
    task: async (_ctx, task) => {
      const updates = result.response?.versions.filter(v => v.updateAvailable) ?? [];
      const plugins = updates.map(u => u.package).join(', ') || 'plugins';
      task.output = `Updating ${plugins}...`;

      const updateResult = await triggerPluginUpdate(host, port);

      if (updateResult.success) {
        const count = updateResult.response?.updated ?? 0;
        task.title = `${host}: ${count} plugin(s) updated`;
        if (updateResult.response?.willRestart) {
          hostsRestarting++;
          task.title += ' (restarting)';
        }
      } else {
        task.title = `${host}: update failed - ${updateResult.error}`;
        throw new Error(updateResult.error);
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
    // Some updates may have failed, but we continue
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
