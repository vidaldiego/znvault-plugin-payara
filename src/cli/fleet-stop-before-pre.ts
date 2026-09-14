// Path: src/cli/fleet-stop-before-pre.ts
// Strict fleet-wide stop barrier for pre-deploy migrations that cannot run
// while any application instance remains live.

import type {
  CLIPluginContext,
  DeployConfig,
  HAProxyConfig,
  QuiesceConfig,
} from './types.js';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentGet,
  agentPost,
  buildPluginUrl,
  drainServer,
  quiesceScheduler,
  readyServer,
  resolveClass,
  schedulerStatus,
  type AgentRequestAuth,
  type HAProxyOperationResult,
} from '@zincapp/znvault-deploy-core';
import { getErrorMessage } from '../utils/error.js';
import {
  completeFleetOutageJournal,
  openFinalizedFleetOutageJournal,
  openFleetOutageJournal,
  type FleetOutageContext,
} from './fleet-outage-journal.js';

const DEFAULT_QUIESCE_POLL_MS = 2_000;
const DEFAULT_QUIESCE_TIMEOUT_MS = 120_000;
const PAYARA_STOP_REQUEST_TIMEOUT_MS = 300_000;
const PAYARA_STATUS_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Version-controlled marker placed in a pre-migration directory when those
 * migrations may run only behind the strict full-fleet outage rail.
 */
export const FLEET_STOP_SENTINEL_FILENAME = '.znvault-require-fleet-stop';

export interface FleetStopFlagOptions {
  requireFleetStopBeforePre?: boolean;
  skipDrain?: boolean;
  skipMigrations?: boolean;
  skipPre?: boolean;
  migrationsOnly?: boolean;
  preOnly?: boolean;
  postOnly?: boolean;
  dryRun?: boolean;
  host?: readonly string[];
  only?: readonly string[];
  class?: readonly string[];
}

export interface FleetStopPlanShape {
  runPre: boolean;
  runRollout: boolean;
}

export interface FleetRoutingGroup {
  name: string;
  hosts: readonly string[];
  haproxy?: HAProxyConfig;
}

export interface FleetReadyDependencies {
  readyServer: typeof readyServer;
  drainServer: typeof drainServer;
  sleep(ms: number): Promise<void>;
}

const defaultReadyDependencies: FleetReadyDependencies = {
  readyServer,
  drainServer,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

function routedHosts(group: FleetRoutingGroup): readonly string[] {
  if (!group.haproxy) return [];
  return group.hosts.filter(host => Boolean(group.haproxy!.serverMap[host]));
}

function duplicateHosts(groups: readonly { hosts: readonly string[] }[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const host of groups.flatMap(group => group.hosts)) {
    if (seen.has(host)) duplicates.add(host);
    seen.add(host);
  }
  return [...duplicates].sort();
}

/**
 * Validate the opt-in barrier before credentials, tunnels, hosts, or the
 * database are touched. An empty result means the request is safe to prepare.
 */
export function validateFleetStopBeforePreRequest(
  config: DeployConfig,
  plan: FleetStopPlanShape,
  options: FleetStopFlagOptions,
): string[] {
  // A rollout cannot bypass marker-protected pre migrations by selecting
  // --skip-pre or --skip-migrations. Post-only recovery remains allowed because
  // it neither runs the protected pre phase nor rolls out a schema-dependent WAR.
  if (config.migration && (plan.runPre || plan.runRollout)) {
    const sentinelPath = join(
      config.migration.migrationsDir,
      FLEET_STOP_SENTINEL_FILENAME,
    );
    try {
      const marker = lstatSync(sentinelPath);
      if (!marker.isFile() || marker.isSymbolicLink()) {
        return [
          `Fleet-stop sentinel must be a regular, non-symlink file: ${sentinelPath}`,
        ];
      }
      if (!options.requireFleetStopBeforePre) {
        if (options.postOnly && !options.dryRun) {
          return [
            `Post-only recovery cannot prove or release the active strict fleet outage protected by ${sentinelPath}; ` +
            're-run the complete deployment with --require-fleet-stop-before-pre.',
          ];
        }
        return [
          `Deployment requires --require-fleet-stop-before-pre because ${sentinelPath} ` +
          `protects mandatory pre-deploy migrations.`,
        ];
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return [
          `Cannot inspect fleet-stop sentinel ${sentinelPath}: ${getErrorMessage(error)}`,
        ];
      }
    }
  }

  if (!options.requireFleetStopBeforePre) return [];

  const errors: string[] = [];
  if (!config.migration) {
    errors.push(
      '--require-fleet-stop-before-pre requires a configured pre-deploy migration phase.'
    );
  }
  if (!plan.runPre) {
    errors.push(
      '--require-fleet-stop-before-pre cannot be combined with a plan that skips the pre-deploy migration phase.'
    );
  }
  if (!plan.runRollout) {
    errors.push(
      '--require-fleet-stop-before-pre requires the complete WAR rollout; migration-only and *-only plans are unsafe.'
    );
  }
  if (options.skipDrain) {
    errors.push(
      '--require-fleet-stop-before-pre cannot be combined with --skip-drain.'
    );
  }
  if (config.classes?.length) {
    for (const deployClass of config.classes) {
      if (resolveClass(config, deployClass).tunnel !== true) {
        errors.push(
          `--require-fleet-stop-before-pre requires tunnel=true for class '${deployClass.name}' ` +
          'because release and finalize are direct-loopback-only operations.'
        );
      }
    }
  } else if (config.tunnel !== true) {
    errors.push(
      '--require-fleet-stop-before-pre requires tunnel=true for every host because release and finalize are direct-loopback-only operations.'
    );
  }
  if (
    (options.host?.length ?? 0) > 0
    || (options.only?.length ?? 0) > 0
    || (options.class?.length ?? 0) > 0
  ) {
    errors.push(
      '--require-fleet-stop-before-pre requires the complete configured fleet; --host, --only, and --class are not allowed.'
    );
  }

  const groups = config.classes
    ? config.classes.map(deployClass => resolveClass(config, deployClass))
    : [{
        name: config.name,
        hosts: config.hosts ?? [],
        haproxy: config.haproxy,
        blocking: config.haproxy !== undefined,
      }];
  const fleetHosts = groups.flatMap(group => group.hosts);
  if (fleetHosts.length === 0) {
    errors.push(
      '--require-fleet-stop-before-pre requires at least one configured fleet host.'
    );
  }
  const duplicates = duplicateHosts(groups);
  if (duplicates.length > 0) {
    errors.push(
      `--require-fleet-stop-before-pre requires each host exactly once; duplicate host(s): ${duplicates.join(', ')}.`
    );
  }

  const routedHostCount = groups.reduce(
    (count, group) => count + routedHosts(group).length,
    0,
  );
  for (const group of groups) {
    if (routedHosts(group).length > 0 && group.haproxy?.hosts.length === 0) {
      errors.push(
        `[${group.name}] strict fleet stop has routed hosts but no HAProxy endpoints configured.`
      );
    }
  }
  if (routedHostCount === 0) {
    errors.push(
      '--require-fleet-stop-before-pre requires at least one HAProxy-routed node class; no traffic drain is configured.'
    );
  }

  return errors;
}

export interface FleetStopGroup {
  name: string;
  hosts: readonly string[];
  port: number;
  useTLS: boolean;
  haproxy?: HAProxyConfig;
  quiesce?: QuiesceConfig;
  hostConfigs?: Readonly<Record<string, { quiesceTimeoutMs?: number }>>;
  mutationAuthTokens: ReadonlyMap<string, string>;
  /** Canonical WAR target bound to this class's outage receipts. */
  targetContentSha256: string;
  /** Rebind deploy-core's process-global direct-TLS policy for this group. */
  activateControlPlane(): void;
}

interface FleetPreparedStopStatus {
  mutationLockStale?: true;
  mutationLockOwnerKind?: 'general' | 'payara-outage' | 'legacy-or-invalid';
  outageFenced?: boolean;
  preparedStopped?: boolean;
  running?: boolean;
  processCount?: number;
  receiptPhase?: string;
  receiptId?: string;
  outageOwnerId?: string;
  targetContentSha256?: string;
  artifact?: {
    size?: number;
    sha256?: string;
    contentSha256?: string;
  };
  deployedArtifact?: {
    size?: number;
    sha256?: string;
    contentSha256?: string;
  };
  currentArtifact?: {
    size?: number;
    sha256?: string;
    contentSha256?: string;
  };
  applicationDeployed?: boolean;
}

async function preflightFleetMutationLocks(
  groups: readonly FleetStopGroup[],
  deps: FleetStopDependencies,
): Promise<FleetOutageContext | undefined> {
  const failures: string[] = [];
  const outageOwners = new Set<string>();
  for (const group of groups) {
    group.activateControlPlane();
    const results = await Promise.allSettled(group.hosts.map(async host => {
      const status = await deps.agentGet<FleetPreparedStopStatus>(
        `${buildPluginUrl(host, group.port, group.useTLS)}/stop-for-deployment/status`,
        PAYARA_STATUS_REQUEST_TIMEOUT_MS,
        requestAuth(group, host),
      );
      // General and legacy Agent locks belong to another mutation and must be
      // reconciled manually; taking them over here could race an unknown
      // certificate or secret write.
      if (
        status.mutationLockStale === true
        && status.mutationLockOwnerKind !== 'payara-outage'
      ) {
        throw new Error(
          `stale ${status.mutationLockOwnerKind ?? 'unknown'} mutation lock requires manual reconciliation`,
        );
      }
      if (
        status.mutationLockStale === true
        && status.mutationLockOwnerKind === 'payara-outage'
        && status.outageFenced !== true
      ) {
        throw new Error(
          'stale payara-outage mutation lock has no durable outage receipt; manual reconciliation is required',
        );
      }
      const classification = validatePreparedStopStatus(status, group.targetContentSha256);
      if (classification.outageOwnerId) outageOwners.add(classification.outageOwnerId);
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures.push(
          `[${group.name}] ${group.hosts[index]}: ${getErrorMessage(result.reason)}`,
        );
      }
    });
  }
  if (failures.length > 0) {
    throw formatFailures(
      'FLEET_STOP_MUTATION_LOCK_PREFLIGHT_FAILED; traffic was not drained and no migration was run',
      failures,
    );
  }
  if (outageOwners.size > 1) {
    throw new Error(
      'FLEET_STOP_MUTATION_LOCK_PREFLIGHT_FAILED; traffic was not drained and no migration was run: ' +
      'fleet receipts belong to multiple outage owners',
    );
  }
  const outageOwnerId = [...outageOwners][0];
  if (!outageOwnerId) return undefined;
  try {
    // Recovery authority is local and private. Prove it exists and is bound to
    // this exact fleet/target before changing HAProxy state.
    return openFleetOutageJournal(groups, outageOwnerId);
  } catch (error) {
    throw formatFailures(
      'FLEET_STOP_MUTATION_LOCK_PREFLIGHT_FAILED; traffic was not drained and no migration was run',
      [`private outage recovery is unavailable: ${getErrorMessage(error)}`],
    );
  }
}

export interface FleetStopDependencies {
  drainServer: typeof drainServer;
  quiesceScheduler: typeof quiesceScheduler;
  schedulerStatus: typeof schedulerStatus;
  agentPost: typeof agentPost;
  agentGet: typeof agentGet;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const defaultDependencies: FleetStopDependencies = {
  drainServer,
  quiesceScheduler,
  schedulerStatus,
  agentPost,
  agentGet,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

function requestAuth(group: FleetStopGroup, host: string): AgentRequestAuth {
  const bearerToken = group.mutationAuthTokens.get(host);
  if (!bearerToken) {
    throw new Error(`Payara credential was not loaded for host '${host}'`);
  }
  return { bearerToken };
}

function formatFailures(prefix: string, failures: readonly string[]): Error {
  return new Error(`${prefix}: ${failures.join('; ')}`);
}

function validatePreparedStopStatus(
  status: FleetPreparedStopStatus,
  expectedTargetContentSha256: string,
): {
  state:
    | 'running'
    | 'stop-pending'
    | 'stop-commit-pending'
    | 'prepared-stopped'
    | 'rollout-resume'
    | 'deployed-runtime-resume'
    | 'rollout-deployed'
    | 'release-runtime-resume'
    | 'release-pending'
    | 'finalized-candidate';
  outageOwnerId?: string;
} {
  if (!/^[a-f0-9]{64}$/u.test(expectedTargetContentSha256)) {
    throw new Error('configured target omitted a lowercase canonical SHA-256');
  }
  if (status.outageFenced === true) {
    if (
      typeof status.outageOwnerId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        status.outageOwnerId,
      )
      || status.targetContentSha256 !== expectedTargetContentSha256
    ) {
      throw new Error('active outage fence belongs to a different owner or WAR target');
    }
  } else if (status.outageFenced !== false) {
    throw new Error('prepared-stop status omitted the durable outage-fence state');
  }
  if (status.preparedStopped === true) {
    if (
      status.running !== false
      || status.processCount !== 0
      || status.receiptPhase !== 'stopped'
      || typeof status.receiptId !== 'string'
      || status.receiptId.length === 0
      || status.outageFenced !== true
      || !status.artifact
      || !Number.isSafeInteger(status.artifact.size)
      || Number(status.artifact.size) <= 0
      || !/^[a-f0-9]{64}$/u.test(String(status.artifact.sha256))
      || !/^[a-f0-9]{64}$/u.test(String(status.artifact.contentSha256))
    ) {
      throw new Error('prepared-stop receipt omitted exact stopped/artifact evidence');
    }
    return {
      state: 'prepared-stopped',
      outageOwnerId: status.outageOwnerId,
    };
  }
  if (
    status.preparedStopped === false
    && status.running === false
    && status.processCount === 0
    && status.outageFenced === true
    && status.receiptPhase === 'prepared'
  ) {
    if (
      typeof status.receiptId !== 'string'
      || status.receiptId.length === 0
      || !status.artifact
      || !Number.isSafeInteger(status.artifact.size)
      || Number(status.artifact.size) <= 0
      || !/^[a-f0-9]{64}$/u.test(String(status.artifact.sha256))
      || !/^[a-f0-9]{64}$/u.test(String(status.artifact.contentSha256))
    ) {
      throw new Error('pending stop commit omitted exact receipt/artifact evidence');
    }
    return {
      state: 'stop-commit-pending',
      outageOwnerId: status.outageOwnerId,
    };
  }
  if (
    status.preparedStopped === false
    && status.outageFenced === true
    && status.receiptPhase === 'rollout'
    && (
      (status.running === false && status.processCount === 0)
      || (
        status.running === true
        && Number.isSafeInteger(status.processCount)
        && Number(status.processCount) > 0
      )
    )
  ) {
    if (
      typeof status.receiptId !== 'string'
      || status.receiptId.length === 0
      || !status.artifact
      || !Number.isSafeInteger(status.artifact.size)
      || Number(status.artifact.size) <= 0
      || !/^[a-f0-9]{64}$/u.test(String(status.artifact.sha256))
      || !/^[a-f0-9]{64}$/u.test(String(status.artifact.contentSha256))
      || !status.currentArtifact
      || !Number.isSafeInteger(status.currentArtifact.size)
      || Number(status.currentArtifact.size) <= 0
      || !/^[a-f0-9]{64}$/u.test(String(status.currentArtifact.sha256))
      || !/^[a-f0-9]{64}$/u.test(String(status.currentArtifact.contentSha256))
      || (
        status.currentArtifact.contentSha256 !== status.artifact.contentSha256
        && status.currentArtifact.contentSha256 !== expectedTargetContentSha256
      )
    ) {
      throw new Error('interrupted rollout omitted exact base/current artifact evidence');
    }
    return { state: 'rollout-resume', outageOwnerId: status.outageOwnerId };
  }
  if (
    status.preparedStopped === false
    && status.running === false
    && status.processCount === 0
    && status.outageFenced === true
    && status.receiptPhase === 'releasing'
  ) {
    if (
      typeof status.receiptId !== 'string'
      || status.receiptId.length === 0
      || !status.deployedArtifact
      || !Number.isSafeInteger(status.deployedArtifact.size)
      || Number(status.deployedArtifact.size) <= 0
      || !/^[a-f0-9]{64}$/u.test(String(status.deployedArtifact.sha256))
      || status.deployedArtifact.contentSha256 !== expectedTargetContentSha256
    ) {
      throw new Error('stopped releasing receipt omitted exact target evidence');
    }
    return {
      state: 'release-runtime-resume',
      outageOwnerId: status.outageOwnerId,
    };
  }
  if (
    status.preparedStopped === false
    && status.running === false
    && status.processCount === 0
    && status.outageFenced === true
    && status.receiptPhase === 'deployed'
  ) {
    if (
      typeof status.receiptId !== 'string'
      || status.receiptId.length === 0
      || !status.deployedArtifact
      || !Number.isSafeInteger(status.deployedArtifact.size)
      || Number(status.deployedArtifact.size) <= 0
      || !/^[a-f0-9]{64}$/u.test(String(status.deployedArtifact.sha256))
      || status.deployedArtifact.contentSha256 !== expectedTargetContentSha256
    ) {
      throw new Error('stopped deployed receipt omitted exact target evidence');
    }
    return {
      state: 'deployed-runtime-resume',
      outageOwnerId: status.outageOwnerId,
    };
  }
  if (
    status.preparedStopped === false
    && status.running === true
    && Number.isSafeInteger(status.processCount)
    && Number(status.processCount) > 0
  ) {
    if (status.outageFenced === true) {
      if (status.receiptPhase === 'arming' || status.receiptPhase === 'prepared') {
        if (
          typeof status.receiptId !== 'string'
          || status.receiptId.length === 0
          || !status.artifact
          || !Number.isSafeInteger(status.artifact.size)
          || Number(status.artifact.size) <= 0
          || !/^[a-f0-9]{64}$/u.test(String(status.artifact.sha256))
          || !/^[a-f0-9]{64}$/u.test(String(status.artifact.contentSha256))
        ) {
          throw new Error('pending deployment stop omitted exact receipt/artifact evidence');
        }
        return { state: 'stop-pending', outageOwnerId: status.outageOwnerId };
      }
      if (
        (status.receiptPhase !== 'deployed' && status.receiptPhase !== 'releasing')
        || typeof status.receiptId !== 'string'
        || status.receiptId.length === 0
        || status.applicationDeployed !== true
        || !status.deployedArtifact
        || !Number.isSafeInteger(status.deployedArtifact.size)
        || Number(status.deployedArtifact.size) <= 0
        || !/^[a-f0-9]{64}$/u.test(String(status.deployedArtifact.sha256))
        || status.deployedArtifact?.contentSha256 !== expectedTargetContentSha256
      ) {
        throw new Error('active outage is not in a resumable release phase');
      }
      return {
        state: status.receiptPhase === 'deployed'
          ? 'rollout-deployed'
          : 'release-pending',
        outageOwnerId: status.outageOwnerId,
      };
    }
    if (
      status.applicationDeployed === true
      && status.deployedArtifact?.contentSha256 === expectedTargetContentSha256
      && Number.isSafeInteger(status.deployedArtifact.size)
      && Number(status.deployedArtifact.size) > 0
      && /^[a-f0-9]{64}$/u.test(String(status.deployedArtifact.sha256))
    ) {
      return { state: 'finalized-candidate' };
    }
    return {
      state: 'running',
    };
  }
  if (status.running === false && status.processCount === 0) {
    throw new Error('Payara is stopped without a matching durable prepared-stop receipt');
  }
  throw new Error('prepared-stop status omitted coherent runtime evidence');
}

function validateHAProxyReceipt(
  config: HAProxyConfig,
  receipt: HAProxyOperationResult,
  operation: 'DRAIN' | 'READY',
): string[] {
  const failures: string[] = [];
  const expected = new Set(config.hosts);
  for (const host of config.hosts) {
    const matches = receipt.results.filter(result => result.host === host);
    if (matches.length !== 1) {
      failures.push(
        `${host}: expected one ${operation} receipt, observed ${matches.length}`
      );
    } else if (!matches[0]!.success) {
      failures.push(
        `${host}: ${matches[0]!.error ?? `${operation.toLowerCase()} failed`}`
      );
    }
  }
  for (const result of receipt.results) {
    if (!expected.has(result.host)) {
      failures.push(`${result.host}: unexpected ${operation} receipt`);
    }
  }
  if (!receipt.success && failures.length === 0) {
    failures.push(`aggregate ${operation} result was unsuccessful`);
  }
  return failures;
}

async function waitForStrictSchedulerDrain(
  group: FleetStopGroup,
  host: string,
  deps: FleetStopDependencies,
): Promise<void> {
  const pollMs = group.quiesce?.pollMs ?? DEFAULT_QUIESCE_POLL_MS;
  const timeoutMs = group.hostConfigs?.[host]?.quiesceTimeoutMs
    ?? group.quiesce?.drainTimeoutMs
    ?? DEFAULT_QUIESCE_TIMEOUT_MS;
  const deadline = deps.now() + timeoutMs;
  const auth = requestAuth(group, host);

  while (true) {
    const status = await deps.schedulerStatus(
      host,
      group.port,
      group.useTLS,
      auth,
    );
    if (!status.available) {
      throw new Error(
        `scheduler status unavailable${status.reason ? ` (${status.reason})` : ''}`
      );
    }
    if (!status.quiesced) {
      throw new Error('scheduler did not remain quiesced');
    }
    if (status.inFlightUnits === 0) return;

    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new Error(
        `scheduler drain timed out with ${status.inFlightUnits} in-flight unit(s)`
      );
    }
    await deps.sleep(Math.min(pollMs, remaining));
  }
}

/**
 * Cross the outage boundary in four globally ordered phases:
 *
 * 1. drain every HAProxy-routed host;
 * 2. quiesce every application host and prove zero in-flight work;
 * 3. request Payara stop on every host;
 * 4. independently prove `running=false` and `processCount=0` everywhere.
 *
 * No compensation is attempted here. Once draining begins, every failure keeps
 * the known-safe drain/quiesce state so callers cannot accidentally expose a
 * partially stopped or partially migrated fleet. The subsequent successful WAR
 * rollout owns each host's eventual HAProxy READY transition.
 */
export async function enforceFleetStopBeforePre(
  groups: readonly FleetStopGroup[],
  ctx: CLIPluginContext,
  deps: FleetStopDependencies = defaultDependencies,
): Promise<FleetOutageContext> {
  const allHosts = groups.flatMap(group => group.hosts);
  if (allHosts.length === 0) {
    throw new Error('FLEET_STOP_EMPTY: no hosts were supplied to the strict stop barrier');
  }
  const duplicates = duplicateHosts(groups);
  if (duplicates.length > 0) {
    throw new Error(
      `FLEET_STOP_DUPLICATE_HOSTS: each host must belong to exactly one class (${duplicates.join(', ')})`,
    );
  }
  const routedHostCount = groups.reduce(
    (count, group) => count + routedHosts(group).length,
    0,
  );
  if (routedHostCount === 0) {
    throw new Error(
      'FLEET_STOP_NO_ROUTED_HOSTS: no HAProxy-routed host was supplied to the strict stop barrier'
    );
  }
  const invalidTargetGroups = groups
    .filter(group => !/^[a-f0-9]{64}$/u.test(group.targetContentSha256))
    .map(group => group.name);
  if (invalidTargetGroups.length > 0) {
    throw new Error(
      `FLEET_STOP_TARGET_INVALID: ${invalidTargetGroups.join(', ')}`,
    );
  }
  const missingHAProxyEndpoints = groups
    .filter(group => routedHosts(group).length > 0 && group.haproxy?.hosts.length === 0)
    .map(group => group.name);
  if (missingHAProxyEndpoints.length > 0) {
    throw new Error(
      `FLEET_STOP_NO_HAPROXY_ENDPOINTS: ${missingHAProxyEndpoints.join(', ')}`
    );
  }

  ctx.output.info('[deploy] strict pre-migration fleet stop: checking mutation locks');
  const preflightOutageContext = await preflightFleetMutationLocks(groups, deps);

  ctx.output.info(
    `[deploy] strict pre-migration fleet stop: draining ` +
    `${routedHostCount} routed host(s)`
  );
  const drainFailures: string[] = [];
  let maxDrainWaitMs = 0;
  for (const group of groups) {
    const targets = routedHosts(group);
    if (!group.haproxy || targets.length === 0) continue;
    maxDrainWaitMs = Math.max(
      maxDrainWaitMs,
      (group.haproxy.drainWaitSeconds ?? 5) * 1_000,
    );
    const results = await Promise.allSettled(
      targets.map(host => deps.drainServer(group.haproxy!, host))
    );
    results.forEach((result, index) => {
      const host = targets[index]!;
      if (result.status === 'rejected') {
        drainFailures.push(`[${group.name}] ${host}: ${getErrorMessage(result.reason)}`);
        return;
      }
      const receiptFailures = validateHAProxyReceipt(
        group.haproxy!,
        result.value,
        'DRAIN',
      );
      if (receiptFailures.length > 0) {
        drainFailures.push(
          `[${group.name}] ${host}: ${receiptFailures.join(', ')}`
        );
      }
    });
  }
  if (drainFailures.length > 0) {
    throw formatFailures('FLEET_STOP_DRAIN_FAILED; no migration was run', drainFailures);
  }
  if (maxDrainWaitMs > 0) await deps.sleep(maxDrainWaitMs);

  // Classify every host before scheduler I/O. A host left at PID0 by an earlier
  // invocation may skip quiesce and the second stop only when the agent proves
  // a durable receipt bound to this domain/app and the unchanged previous WAR.
  ctx.output.info('[deploy] strict pre-migration fleet stop: reading durable stop state');
  const quiesceHosts = new Map<FleetStopGroup, readonly string[]>();
  const stopHosts = new Map<FleetStopGroup, readonly string[]>();
  const existingOutageOwners = new Set<string>();
  const releasePendingHosts = new Set<string>();
  const releaseRuntimeResumeHosts = new Set<string>();
  const deployedRuntimeResumeHosts = new Set<string>();
  const rolloutResumeHosts = new Set<string>();
  const alreadyDeployedHosts = new Set<string>();
  const finalizedCandidateHosts = new Set<string>();
  const preparedStateFailures: string[] = [];
  for (const group of groups) {
    group.activateControlPlane();
    const classifications = await Promise.allSettled(group.hosts.map(async host => {
      const status = await deps.agentGet<FleetPreparedStopStatus>(
        `${buildPluginUrl(host, group.port, group.useTLS)}/stop-for-deployment/status`,
        PAYARA_STATUS_REQUEST_TIMEOUT_MS,
        requestAuth(group, host),
      );
      return {
        host,
        classification: validatePreparedStopStatus(
          status,
          group.targetContentSha256,
        ),
      };
    }));
    const active: string[] = [];
    const pendingStop: string[] = [];
    classifications.forEach((result, index) => {
      if (result.status === 'rejected') {
        preparedStateFailures.push(
          `[${group.name}] ${group.hosts[index]}: ${getErrorMessage(result.reason)}`,
        );
      } else if (
        result.value.classification.state === 'running'
        || result.value.classification.state === 'stop-pending'
      ) {
        active.push(result.value.host);
        pendingStop.push(result.value.host);
      } else if (result.value.classification.state === 'stop-commit-pending') {
        pendingStop.push(result.value.host);
      } else if (result.value.classification.state === 'rollout-deployed') {
        alreadyDeployedHosts.add(result.value.host);
      } else if (result.value.classification.state === 'rollout-resume') {
        rolloutResumeHosts.add(result.value.host);
      } else if (result.value.classification.state === 'deployed-runtime-resume') {
        deployedRuntimeResumeHosts.add(result.value.host);
      } else if (result.value.classification.state === 'release-pending') {
        releasePendingHosts.add(result.value.host);
      } else if (result.value.classification.state === 'release-runtime-resume') {
        releaseRuntimeResumeHosts.add(result.value.host);
      } else if (result.value.classification.state === 'finalized-candidate') {
        finalizedCandidateHosts.add(result.value.host);
        active.push(result.value.host);
        pendingStop.push(result.value.host);
      }
      if (
        result.status === 'fulfilled'
        && result.value.classification.outageOwnerId
      ) {
        existingOutageOwners.add(result.value.classification.outageOwnerId);
      }
    });
    quiesceHosts.set(group, active);
    stopHosts.set(group, pendingStop);
  }
  if (preparedStateFailures.length > 0) {
    throw formatFailures(
      'FLEET_STOP_PREPARED_STATE_INVALID; fleet remains drained and no migration was run',
      preparedStateFailures,
    );
  }
  if (existingOutageOwners.size > 1) {
    throw new Error(
      'FLEET_STOP_OWNER_CONFLICT: fleet receipts belong to multiple outage owners',
    );
  }
  const existingOutageOwnerId = [...existingOutageOwners][0];
  if (
    preflightOutageContext
    && existingOutageOwnerId
    && preflightOutageContext.outageOwnerId !== existingOutageOwnerId
  ) {
    throw new Error(
      'FLEET_STOP_OWNER_CONFLICT: fleet outage owner changed after the preflight proof',
    );
  }
  if (!existingOutageOwnerId && finalizedCandidateHosts.size === allHosts.length) {
    const finalizedContext = openFinalizedFleetOutageJournal(groups);
    if (finalizedContext) {
      return {
        ...finalizedContext,
        resumeCommitOnly: true,
        alreadyFinalizedHosts: [...finalizedCandidateHosts],
      };
    }
  }
  const outageContext = preflightOutageContext
    ?? openFleetOutageJournal(groups, existingOutageOwnerId);
  if (
    (releasePendingHosts.size > 0 || releaseRuntimeResumeHosts.size > 0)
    && outageContext.commitAuthorized !== true
  ) {
    throw new Error(
      'FLEET_OUTAGE_RELEASE_RECOVERY_UNPROVEN: a releasing host requires the private post-complete journal',
    );
  }
  if (
    releasePendingHosts.size > 0
    && releaseRuntimeResumeHosts.size === 0
    && deployedRuntimeResumeHosts.size === 0
  ) {
    if (
      releasePendingHosts.size
        + alreadyDeployedHosts.size
        + finalizedCandidateHosts.size !== allHosts.length
      || !outageContext.commitAuthorized
    ) {
      throw new Error(
        'FLEET_OUTAGE_RELEASE_RECOVERY_UNPROVEN: every host and the private post-complete journal are required',
      );
    }
    return {
      ...outageContext,
      resumeCommitOnly: true,
      alreadyFinalizedHosts: [...finalizedCandidateHosts],
    };
  }
  const postCommitRuntimeRecovery = releaseRuntimeResumeHosts.size > 0
    || (deployedRuntimeResumeHosts.size > 0 && outageContext.commitAuthorized === true);
  if (postCommitRuntimeRecovery) {
    if (
      !outageContext.commitAuthorized
      || releasePendingHosts.size
        + releaseRuntimeResumeHosts.size
        + deployedRuntimeResumeHosts.size
        + alreadyDeployedHosts.size
        + finalizedCandidateHosts.size !== allHosts.length
    ) {
      throw new Error(
        'FLEET_OUTAGE_RELEASE_RUNTIME_RECOVERY_UNPROVEN: exact post-complete fleet evidence is required',
      );
    }
    for (const group of groups) {
      quiesceHosts.set(
        group,
        (quiesceHosts.get(group) ?? []).filter(host => !finalizedCandidateHosts.has(host)),
      );
      stopHosts.set(
        group,
        (stopHosts.get(group) ?? []).filter(host => !finalizedCandidateHosts.has(host)),
      );
    }
  }
  const { outageOwnerId, outageCapability } = outageContext;

  ctx.output.info('[deploy] strict pre-migration fleet stop: quiescing schedulers');
  const quiesceFailures: string[] = [];
  for (const group of groups) {
    group.activateControlPlane();
    const targets = quiesceHosts.get(group) ?? [];
    const results = await Promise.allSettled(targets.map(async host => {
      const result = await deps.quiesceScheduler(
        host,
        group.port,
        group.useTLS,
        requestAuth(group, host),
      );
      if (!result.available) {
        throw new Error(
          `scheduler quiesce unavailable${result.reason ? ` (${result.reason})` : ''}`
        );
      }
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        quiesceFailures.push(
          `[${group.name}] ${targets[index]}: ${getErrorMessage(result.reason)}`
        );
      }
    });
  }
  if (quiesceFailures.length > 0) {
    throw formatFailures(
      'FLEET_STOP_QUIESCE_FAILED; fleet remains drained and no migration was run',
      quiesceFailures,
    );
  }

  ctx.output.info('[deploy] strict pre-migration fleet stop: waiting for zero in-flight work');
  const schedulerDrainFailures: string[] = [];
  for (const group of groups) {
    group.activateControlPlane();
    const targets = quiesceHosts.get(group) ?? [];
    const results = await Promise.allSettled(
      targets.map(host => waitForStrictSchedulerDrain(group, host, deps))
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        schedulerDrainFailures.push(
          `[${group.name}] ${targets[index]}: ${getErrorMessage(result.reason)}`
        );
      }
    });
  }
  if (schedulerDrainFailures.length > 0) {
    throw formatFailures(
      'FLEET_STOP_SCHEDULER_DRAIN_FAILED; fleet remains drained/quiesced and no migration was run',
      schedulerDrainFailures,
    );
  }

  ctx.output.info('[deploy] strict pre-migration fleet stop: stopping Payara everywhere');
  const stopFailures: string[] = [];
  for (const group of groups) {
    group.activateControlPlane();
    const quiesceTargets = quiesceHosts.get(group) ?? [];
    const targets = stopHosts.get(group) ?? [];

    // Re-arm the finite API lease immediately before this sequential group's
    // potentially long stop and prove zero work again. With the current 600s
    // API default this bounds exposure to one <=300s stop operation.
    const renewals = await Promise.allSettled(quiesceTargets.map(async host => {
      const result = await deps.quiesceScheduler(
        host,
        group.port,
        group.useTLS,
        requestAuth(group, host),
      );
      if (!result.available) {
        throw new Error(
          `scheduler quiesce renewal unavailable${result.reason ? ` (${result.reason})` : ''}`,
        );
      }
      await waitForStrictSchedulerDrain(group, host, deps);
    }));
    renewals.forEach((result, index) => {
      if (result.status === 'rejected') {
        stopFailures.push(
          `[${group.name}] ${quiesceTargets[index]}: quiesce renewal failed: ${getErrorMessage(result.reason)}`,
        );
      }
    });
    if (renewals.some(result => result.status === 'rejected')) continue;

    const results = await Promise.allSettled(targets.map(async host => {
      const response = await deps.agentPost<{
        status?: string;
        applicationAbsent?: boolean;
        receiptId?: string;
        outageOwnerId?: string;
        targetContentSha256?: string;
        artifact?: { size?: number; sha256?: string; contentSha256?: string };
      }>(
        `${buildPluginUrl(host, group.port, group.useTLS)}/stop-for-deployment`,
        {
          outageOwnerId,
          outageCapability,
          targetContentSha256: group.targetContentSha256,
        },
        PAYARA_STOP_REQUEST_TIMEOUT_MS,
        requestAuth(group, host),
      );
      if (
        response.status !== 'stopped-for-deployment'
        || response.applicationAbsent !== true
        || typeof response.receiptId !== 'string'
        || response.receiptId.length === 0
        || response.outageOwnerId !== outageOwnerId
        || response.targetContentSha256 !== group.targetContentSha256
        || !response.artifact
        || !Number.isSafeInteger(response.artifact.size)
        || Number(response.artifact.size) <= 0
        || !/^[a-f0-9]{64}$/u.test(String(response.artifact.sha256))
        || !/^[a-f0-9]{64}$/u.test(String(response.artifact.contentSha256))
      ) {
        throw new Error(
          `unexpected deployment-stop receipt ` +
          `'${String(response.status)}' (applicationAbsent=` +
          `${String(response.applicationAbsent)})`
        );
      }
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        stopFailures.push(
          `[${group.name}] ${targets[index]}: ${getErrorMessage(result.reason)}`
        );
      }
    });
  }

  // Verify every host even when one stop request failed. The observations help
  // the operator reconcile the partial outage, but any request failure remains
  // fatal and can never be converted into permission to run SQL.
  ctx.output.info('[deploy] strict pre-migration fleet stop: verifying process absence');
  const verifyFailures: string[] = [];
  for (const group of groups) {
    group.activateControlPlane();
    const results = await Promise.allSettled(group.hosts.map(async host => {
      const status = await deps.agentGet<FleetPreparedStopStatus>(
        `${buildPluginUrl(host, group.port, group.useTLS)}/stop-for-deployment/status`,
        PAYARA_STATUS_REQUEST_TIMEOUT_MS,
        requestAuth(group, host),
      );
      const classification = validatePreparedStopStatus(
        status,
        group.targetContentSha256,
      );
      if (
        classification.state !== 'prepared-stopped'
        && !(
          classification.state === 'rollout-deployed'
          && alreadyDeployedHosts.has(host)
        )
        && !(
          classification.state === 'rollout-resume'
          && rolloutResumeHosts.has(host)
        )
        && !(
          classification.state === 'release-runtime-resume'
          && releaseRuntimeResumeHosts.has(host)
        )
        && !(
          classification.state === 'deployed-runtime-resume'
          && deployedRuntimeResumeHosts.has(host)
        )
        && !(
          classification.state === 'release-pending'
          && releasePendingHosts.has(host)
        )
        && !(
          classification.state === 'finalized-candidate'
          && finalizedCandidateHosts.has(host)
          && outageContext.commitAuthorized
        )
      ) {
        throw new Error(
          `expected a stopped receipt or exact resumed deployment, observed ` +
          `running=${String(status.running)}/processCount=${String(status.processCount)}`
        );
      }
      if (
        classification.state !== 'finalized-candidate'
        && classification.outageOwnerId !== outageOwnerId
      ) {
        throw new Error(
          'prepared-stop evidence belongs to a different outage owner'
        );
      }
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        verifyFailures.push(
          `[${group.name}] ${group.hosts[index]}: ${getErrorMessage(result.reason)}`
        );
      }
    });
  }

  if (stopFailures.length > 0 || verifyFailures.length > 0) {
    throw formatFailures(
      'FLEET_STOP_PAYARA_NOT_PROVEN; fleet remains drained and no migration was run',
      [...stopFailures, ...verifyFailures],
    );
  }

  ctx.output.success(
    `[deploy] strict pre-migration fleet stop verified on ${allHosts.length} host(s)`
  );
  const runtimeReleaseRecovery = postCommitRuntimeRecovery;
  const skipDeploymentHosts = new Set([
    ...alreadyDeployedHosts,
    ...(runtimeReleaseRecovery ? releasePendingHosts : []),
    ...(runtimeReleaseRecovery ? finalizedCandidateHosts : []),
  ]);
  return {
    ...outageContext,
    ...(skipDeploymentHosts.size > 0
      ? { alreadyDeployedHosts: [...skipDeploymentHosts] }
      : {}),
    ...(runtimeReleaseRecovery && finalizedCandidateHosts.size > 0
      ? { alreadyFinalizedHosts: [...finalizedCandidateHosts] }
      : {}),
  };
}

/**
 * Atomically release every scheduler hold after pre, rollout, post, health,
 * and exact receipt gates. HAProxy remains drained until every host also
 * proves the marker and in-memory latch are gone.
 */
export async function releaseFleetOutageFence(
  groups: readonly FleetStopGroup[],
  outageContext: FleetOutageContext,
  ctx: CLIPluginContext,
  deps: Pick<FleetStopDependencies, 'agentPost' | 'agentGet'> = defaultDependencies,
): Promise<void> {
  const { outageOwnerId, outageCapability } = outageContext;
  const alreadyFinalized = new Set(outageContext.alreadyFinalizedHosts ?? []);
  const failures: string[] = [];
  for (const group of groups) {
    group.activateControlPlane();
    const pendingHosts = group.hosts.filter(host => !alreadyFinalized.has(host));
    const results = await Promise.allSettled(pendingHosts.map(async host => {
      const response = await deps.agentPost<{
        status?: string;
        releasePrepared?: boolean;
        schedulerResumed?: boolean;
      }>(
        `${buildPluginUrl(host, group.port, group.useTLS)}` +
        '/stop-for-deployment/release',
        {
          outageOwnerId,
          outageCapability,
          targetContentSha256: group.targetContentSha256,
        },
        PAYARA_STATUS_REQUEST_TIMEOUT_MS,
        requestAuth(group, host),
      );
      if (
        response.status !== 'outage-release-prepared'
        || response.releasePrepared !== true
        || response.schedulerResumed !== true
      ) {
        throw new Error(`unexpected release receipt '${String(response.status)}'`);
      }
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures.push(
          `[${group.name}] ${pendingHosts[index]}: ${getErrorMessage(result.reason)}`,
        );
      }
    });
  }
  if (failures.length > 0) {
    throw formatFailures(
      'FLEET_OUTAGE_RELEASE_FAILED; fleet remains HAProxy-drained',
      failures,
    );
  }
  const resumeFailures: string[] = [];
  for (const group of groups) {
    group.activateControlPlane();
    const results = await Promise.allSettled(group.hosts.map(async host => {
      const auth = requestAuth(group, host);
      const pluginUrl = buildPluginUrl(host, group.port, group.useTLS);
      const pluginSuffix = '/plugins/payara';
      if (!pluginUrl.endsWith(pluginSuffix)) {
        throw new Error('cannot derive the agent scheduler status URL');
      }
      const schedulerUrl = pluginUrl.slice(0, -pluginSuffix.length);
      // deploy-core's scheduler projection omits deployment ownership. Read
      // the authenticated agent response directly before publishing traffic.
      const status = await deps.agentGet<{
        available?: boolean;
        quiesced?: boolean;
        inFlightUnits?: number;
        deploymentHold?: boolean;
        outageId?: string | null;
        targetContentSha256?: string | null;
        holdValid?: boolean;
      }>(
        `${schedulerUrl}/scheduler/status`,
        PAYARA_STATUS_REQUEST_TIMEOUT_MS,
        auth,
      );
      if (status.available === false
        || status.quiesced !== false
        || !Number.isInteger(status.inFlightUnits)
        || (status.inFlightUnits ?? -1) < 0
        || status.deploymentHold !== false || status.holdValid !== true
        || status.outageId !== null
        || status.targetContentSha256 !== null) {
        throw new Error('scheduler did not prove the committed deployment hold was released');
      }
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        resumeFailures.push(`[${group.name}] ${group.hosts[index]}: ${getErrorMessage(result.reason)}`);
      }
    });
  }
  if (resumeFailures.length > 0) {
    throw formatFailures(
      'FLEET_SCHEDULER_RESUME_UNPROVEN; HAProxy remains drained',
      resumeFailures,
    );
  }
  ctx.output.success('[deploy] scheduler release proven on every host; fleet may be published');
}

export async function finalizeFleetOutageFence(
  groups: readonly FleetStopGroup[],
  outageContext: FleetOutageContext,
  ctx: CLIPluginContext,
  deps: Pick<FleetStopDependencies, 'agentPost'> = defaultDependencies,
): Promise<void> {
  const failures: string[] = [];
  const alreadyFinalized = new Set(outageContext.alreadyFinalizedHosts ?? []);
  for (const group of groups) {
    group.activateControlPlane();
    const pendingHosts = group.hosts.filter(host => !alreadyFinalized.has(host));
    const results = await Promise.allSettled(pendingHosts.map(async host => {
      const response = await deps.agentPost<{
        status?: string;
        finalized?: boolean;
        schedulerResumed?: boolean;
      }>(
        `${buildPluginUrl(host, group.port, group.useTLS)}/stop-for-deployment/finalize`,
        {
          outageOwnerId: outageContext.outageOwnerId,
          outageCapability: outageContext.outageCapability,
          targetContentSha256: group.targetContentSha256,
        },
        PAYARA_STATUS_REQUEST_TIMEOUT_MS,
        requestAuth(group, host),
      );
      if (
        response.status !== 'outage-fence-finalized'
        || response.finalized !== true
        || response.schedulerResumed !== true
      ) {
        throw new Error(`unexpected finalize receipt '${String(response.status)}'`);
      }
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures.push(`[${group.name}] ${pendingHosts[index]}: ${getErrorMessage(result.reason)}`);
      }
    });
  }
  if (failures.length > 0) {
    throw formatFailures('FLEET_OUTAGE_FINALIZE_FAILED', failures);
  }

  completeFleetOutageJournal(outageContext);
  ctx.output.success('[deploy] durable mutation fence finalized on every host');
}

/**
 * Publish the fleet only after the caller has proved every deployment receipt
 * and completed every enabled migration phase. A failure is reported after all
 * READY attempts settle so the operator has a complete reconciliation set.
 */
export async function restoreFleetTrafficAfterSuccessfulRollout(
  groups: readonly FleetRoutingGroup[],
  ctx: CLIPluginContext,
  deps: FleetReadyDependencies = defaultReadyDependencies,
): Promise<void> {
  const routed = groups.flatMap(group =>
    group.haproxy
      ? routedHosts(group).map(host => ({ group, host }))
      : []
  );
  if (routed.length === 0) {
    throw new Error(
      'FLEET_READY_EMPTY: strict fleet stop completed without any routed host to restore'
    );
  }

  ctx.output.info(
    `[deploy] fleet-wide commit: restoring ${routed.length} routed host(s) to HAProxy READY`
  );
  const failures: string[] = [];
  const results = await Promise.allSettled(routed.map(async ({ group, host }) => {
    const result = await deps.readyServer(group.haproxy!, host);
    const receiptFailures = validateHAProxyReceipt(
      group.haproxy!,
      result,
      'READY',
    );
    if (receiptFailures.length > 0) {
      throw new Error(receiptFailures.join(', '));
    }
  }));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const target = routed[index]!;
      failures.push(
        `[${target.group.name}] ${target.host}: ${getErrorMessage(result.reason)}`
      );
    }
  });
  if (failures.length > 0) {
    ctx.output.warn(
      '[deploy] fleet-wide READY was partial; returning every routed host to DRAIN'
    );
    const compensationFailures: string[] = [];
    const compensationResults = await Promise.allSettled(
      routed.map(async ({ group, host }) => {
        const result = await deps.drainServer(group.haproxy!, host);
        const receiptFailures = validateHAProxyReceipt(
          group.haproxy!,
          result,
          'DRAIN',
        );
        if (receiptFailures.length > 0) {
          throw new Error(receiptFailures.join(', '));
        }
      })
    );
    compensationResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const target = routed[index]!;
        compensationFailures.push(
          `[${target.group.name}] ${target.host}: ${getErrorMessage(result.reason)}`
        );
      }
    });
    if (compensationFailures.length === 0) {
      const drainWaitMs = groups.reduce(
        (maximum, group) => Math.max(
          maximum,
          (group.haproxy?.drainWaitSeconds ?? 0) * 1_000,
        ),
        0,
      );
      if (drainWaitMs > 0) await deps.sleep(drainWaitMs);
      throw formatFailures(
        'FLEET_READY_FAILED; compensation returned the complete routed fleet to DRAIN',
        failures,
      );
    }
    throw formatFailures(
      'FLEET_READY_FAILED; FLEET_READY_COMPENSATION_NOT_PROVEN',
      [...failures, ...compensationFailures],
    );
  }
  ctx.output.success('[deploy] fleet-wide HAProxy READY commit complete');
}
