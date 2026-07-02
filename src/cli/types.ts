// Path: src/cli/types.ts
// CLI type definitions

import type { Command } from 'commander';
import type { DeployResult } from '../types.js';

/**
 * CLI Plugin context interface
 * Matches the CLIPluginContext from znvault-cli
 */
export interface CLIPluginContext {
  client: {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body: unknown): Promise<T>;
  };
  output: {
    success(message: string): void;
    error(message: string): void;
    warn(message: string): void;
    info(message: string): void;
    table(headers: string[], rows: unknown[][]): void;
    keyValue(data: Record<string, unknown>): void;
  };
  getConfig(): { url: string };
  isPlainMode(): boolean;
}

/**
 * CLI Plugin interface
 */
export interface CLIPlugin {
  name: string;
  version: string;
  description?: string;
  registerCommands(program: Command, ctx: CLIPluginContext): void;
}

/**
 * Deployment strategy batch
 * Represents a group of hosts to deploy to in parallel within a batch
 */
export interface DeploymentStrategyBatch {
  /** Number of hosts in this batch, or 'rest' for remaining hosts */
  count: number | 'rest';
  /** Label for display (e.g., "1", "2", "rest") */
  label: string;
}

/**
 * Parsed deployment strategy
 *
 * Examples:
 * - "sequential" → batches with count=1 for each host
 * - "parallel" → single batch with count='rest'
 * - "1+2" → [{count:1}, {count:2}]
 * - "1+R" or "1+rest" → [{count:1}, {count:'rest'}]
 * - "2+3+R" → [{count:2}, {count:3}, {count:'rest'}]
 */
export interface DeploymentStrategy {
  /** Original strategy string for display */
  name: string;
  /** Ordered list of batches */
  batches: DeploymentStrategyBatch[];
  /** Whether this is a canary strategy (has multiple batches) */
  isCanary: boolean;
}

/**
 * Parse a deployment strategy string into a structured strategy
 *
 * @param strategy Strategy string (e.g., "sequential", "parallel", "1+2", "1+R")
 * @returns Parsed deployment strategy
 * @throws Error if strategy format is invalid
 *
 * @example
 * parseDeploymentStrategy("1+R") // → { name: "1+R", batches: [{count:1}, {count:'rest'}], isCanary: true }
 * parseDeploymentStrategy("sequential") // → { name: "sequential", batches: [{count:1}], isCanary: false }
 */
export function parseDeploymentStrategy(strategy: string): DeploymentStrategy {
  const normalized = strategy.toLowerCase().trim();

  // Handle built-in strategies
  if (normalized === 'sequential') {
    return {
      name: 'sequential',
      batches: [{ count: 1, label: '1' }],
      isCanary: false,
    };
  }

  if (normalized === 'parallel') {
    return {
      name: 'parallel',
      batches: [{ count: 'rest', label: 'all' }],
      isCanary: false,
    };
  }

  // Parse canary strategy (e.g., "1+2", "1+R", "2+3+R")
  const parts = normalized.split('+').map(p => p.trim());

  if (parts.length < 2) {
    throw new Error(
      `Invalid strategy format: "${strategy}". ` +
      `Use "sequential", "parallel", or canary format like "1+2", "1+R", "2+3+R"`
    );
  }

  const batches: DeploymentStrategyBatch[] = [];

  for (const part of parts) {
    if (part === 'r' || part === 'rest') {
      batches.push({ count: 'rest', label: 'rest' });
    } else {
      const count = parseInt(part, 10);
      if (isNaN(count) || count < 1) {
        throw new Error(
          `Invalid batch count "${part}" in strategy "${strategy}". ` +
          `Must be a positive number or "R" for rest.`
        );
      }
      batches.push({ count, label: part });
    }
  }

  // Validate: 'rest' can only appear at the end
  const restIndex = batches.findIndex(b => b.count === 'rest');
  if (restIndex !== -1 && restIndex !== batches.length - 1) {
    throw new Error(
      `"R" (rest) can only appear at the end of the strategy. Got: "${strategy}"`
    );
  }

  return {
    name: strategy,
    batches,
    isCanary: true,
  };
}

/**
 * Get display name for a deployment strategy
 */
export function getStrategyDisplayName(strategy: DeploymentStrategy): string {
  if (!strategy.isCanary) {
    return strategy.name;
  }
  return `canary (${strategy.name})`;
}

/**
 * Health check configuration for post-deployment verification
 */
export interface HealthCheckConfig {
  /** URL path to check (e.g., "/api/health", "/health") */
  path: string;
  /** Port to check (default: 8080 for Payara apps) */
  port?: number;
  /** Expected HTTP status code (default: 200) */
  expectedStatus?: number;
  /** Request timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Number of retry attempts (default: 5) */
  retries?: number;
  /** Delay between retries in milliseconds (default: 3000) */
  retryDelay?: number;
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  success: boolean;
  status?: number;
  error?: string;
  attempts: number;
  totalTime: number;
}

/**
 * TLS configuration for agent connections
 */
export interface DeployTLSConfig {
  /** Enable TLS verification (default: true) */
  verify?: boolean;
  /** Path to CA certificate file (PEM format) */
  caCertPath?: string;
  /** Use vault's agent TLS CA (auto-fetched) */
  useVaultCA?: boolean;
  /** HTTPS port for agent connections (default: 9443) */
  httpsPort?: number;
}

/**
 * HAProxy drain/ready configuration for zero-downtime rolling deployments
 */
export interface HAProxyConfig {
  /** HAProxy host addresses to SSH into */
  hosts: string[];
  /** SSH user (default: "sysadmin") */
  user?: string;
  /** SSH port (default: 22) */
  sshPort?: number;
  /** Admin socket path (default: "/run/haproxy/admin.sock") */
  socketPath?: string;
  /** HAProxy backend name (e.g., "api_servers") */
  backend: string;
  /** Mapping from app host to HAProxy server name */
  serverMap: Record<string, string>;
  /** Seconds to wait after draining before deploying (default: 5) */
  drainWaitSeconds?: number;
  /** SSH command timeout in milliseconds (default: 10000) */
  sshTimeout?: number;
  /** Use sudo for socat commands (default: true) */
  sudo?: boolean;
}

/**
 * SSH tunnel settings for tunneled deploys. Identity is convention + ~/.ssh/config;
 * these are optional overrides.
 */
export interface DeploySshConfig {
  /** SSH user for the tunnel (default: "sysadmin"). */
  user?: string;
  /** Readiness timeout in ms for the tunneled agent /health (default: 15000). */
  readinessTimeoutMs?: number;
}

/**
 * Scheduler quiesce-before-deploy configuration (Part 5a).
 * Extracted from the previously-inline literal so it can be reused on
 * DeployConfig, DeployClass, and ListrDeployOptions.
 */
export interface QuiesceConfig {
  /** Enable scheduler quiescing before deploy. Default: false. */
  enabled?: boolean;
  /** Status poll interval in ms while waiting for in-flight units to drain. Default: 2000. */
  pollMs?: number;
  /** Maximum ms to wait for inFlightUnits to reach 0 before proceeding anyway. Default: 120000. */
  drainTimeoutMs?: number;
}

/**
 * Fields with a deployment-wide default that a node class may override.
 * Adding a field here automatically makes it per-class overridable.
 * NOTE: quiesce and hostConfigs are deliberately NOT here — per-class only.
 */
export interface SharedDeployDefaults {
  warPath?: string;
  port?: number;
  tunnel?: boolean;
  ssh?: DeploySshConfig;
  tls?: DeployTLSConfig;
  healthCheck?: HealthCheckConfig;
  haproxy?: HAProxyConfig;
  strategy?: string;
}

/**
 * One node class within a multi-class deploy. IS a SharedDeployDefaults (every
 * field overridable) plus the fields intrinsic to a class.
 */
export type DeployClass = SharedDeployDefaults & {
  /** 'api' | 'worker' | 'ai' — unique within the config. */
  name: string;
  /** Hosts in this class. No host may appear in two classes. */
  hosts: string[];
  /**
   * Whether this class must fully succeed before the next class starts.
   * Default: true if the resolved haproxy is present AND has a non-empty
   * serverMap, else false. Explicit value overrides.
   */
  blocking?: boolean;
  /** Scheduler quiesce — PER-CLASS ONLY (does not inherit from the base). */
  quiesce?: QuiesceConfig;
  /** Per-host quiesce-timeout overrides. Author on the SAME class as quiesce. */
  hostConfigs?: Record<string, { quiesceTimeoutMs?: number }>;
};

/**
 * Deployment configuration
 */
export interface DeployConfig {
  name: string;
  hosts?: string[];                 // optional: absent on multi-class configs
  warPath?: string;                 // optional: may live per-class
  port?: number;                    // optional: may live per-class
  /** @deprecated Use strategy instead. Kept for backwards compatibility. */
  parallel?: boolean;
  /**
   * Deployment strategy
   * - "sequential" - deploy one host at a time
   * - "parallel" - deploy all hosts at once
   * - "1+R" - deploy to 1 host, if success deploy to rest in parallel
   * - "1+2" - deploy to 1, then 2 in parallel
   * - "2+3+R" - deploy to 2, then 3, then rest in parallel
   */
  strategy?: string;
  description?: string;
  /** Health check configuration for post-deployment verification */
  healthCheck?: HealthCheckConfig;
  /** TLS configuration for secure agent connections */
  tls?: DeployTLSConfig;
  /** HAProxy drain/ready configuration for zero-downtime deployments */
  haproxy?: HAProxyConfig;
  /**
   * When true, reach each host's agent through an SSH-CA-authenticated local
   * port-forward (via `znvault ssh forward`) instead of connecting to :9100
   * directly. Lets the agent bind loopback-only. Default: false.
   */
  tunnel?: boolean;
  /** SSH tunnel settings (only used when tunnel is true). */
  ssh?: DeploySshConfig;
  /**
   * Optional scheduler quiesce-before-deploy (Part 5a).
   * When absent or `enabled` is false, deployment is byte-identical to today.
   */
  quiesce?: QuiesceConfig;
  /**
   * Per-host configuration overrides.
   * A host NOT present in haproxy.serverMap is treated as a worker (no drain/ready).
   */
  hostConfigs?: Record<string, {
    /** Per-host override for the maximum quiesce drain wait in ms. */
    quiesceTimeoutMs?: number;
  }>;
  /** ORDERED array — array order IS deploy order. Mutually exclusive with top-level `hosts`. */
  classes?: DeployClass[];
  /**
   * Optional migration phase configuration (Task 8 / spec §run-migrations.ts).
   *
   * When present, schema migrations are applied ONCE, BEFORE the rolling WAR
   * rollout begins, so a migration failure aborts the deploy before any host
   * is touched. When absent, the migration phase is skipped entirely.
   *
   * Set via `znvault payara config set-migration <name> --role <roleId> --dir <path>`;
   * clear via `--clear`. Validated by `validateDeployConfig` (errors on missing
   * roleId or migrationsDir). host/port/database come from the Vault
   * dynamic-secrets connection referenced by roleId via the lease, not from
   * this config (database may optionally be overridden here).
   */
  migration?: MigrationConfig;

  /**
   * Optional POST-deploy migration phase. Runs ONLY after a fully successful
   * rollout (every configured host on the new WAR, no failures, not scoped).
   * For destructive changes (drop column/table, remove routines) that are unsafe
   * while old app instances are still live. Same shape as `migration`, but MUST
   * point at a DIFFERENT migrationsDir (the engine applies "all pending per dir").
   * Absent = no post-deploy phase. Set via
   * `payara config set-migration <name> --phase post ...`.
   */
  postMigration?: MigrationConfig;
}

/**
 * Schema migration configuration for the deploy-run migration phase.
 *
 * Credentials are NOT stored here — they are dynamically issued from the
 * vault dynamic-secrets role identified by `roleId`.
 *
 * host/port/database are provided by the Vault dynamic-secrets connection
 * (referenced by roleId) and returned with the lease — the deploy config
 * only names the role + the migrations dir. `database` is an optional
 * override for when the Vault connection does not pin a database name.
 */
export interface MigrationConfig {
  /** Dynamic-secrets role ID for the migration DB user (write role). */
  roleId: string;
  /**
   * Optional database name override.
   * If omitted, the database name from the Vault dynamic-secrets lease is used.
   * If neither the lease nor this field provides a name, the migration phase will abort.
   */
  database?: string;
  /** Absolute path to the migrations directory (the flat `docs/migrations` folder). */
  migrationsDir: string;
  /**
   * Optional server-owned routine bundle to apply BEFORE the migrate lease is
   * minted (run-migrations.ts Step 0). Helper procedures (e.g. `zn_assert_*`)
   * are provisioned by vault under the persistent routines account — NOT by
   * the migration engine — so the ephemeral migrate user never owns a routine
   * and revokes cleanly (MySQL 8.4 `ER 4006` DEFINER-reference guard). Absent
   * = no bundle is applied and behavior is byte-identical to today.
   */
  routines?: { bundle: string; version: number };
}

/**
 * Deployment configuration store
 */
export interface DeployConfigStore {
  configs: Record<string, DeployConfig>;
  /** If true, configs are synced from vault */
  vaultEnabled?: boolean;
  /** Vault secret alias for config storage */
  vaultAlias?: string;
}

/**
 * Deployment status response from /deploy/status endpoint
 */
export interface DeploymentStatusResponse {
  deploying: boolean;
  deploymentId?: string;
  startedAt?: number;
  currentStep?: string;
  elapsedMs?: number;
  lastResult?: DeployResult;
  lastCompletedAt?: number;
  appDeployed: boolean;
  appName: string;
  healthy: boolean;
  running: boolean;
}

/**
 * HTTP POST result with special 409 handling
 */
export type AgentPostResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; inProgress: boolean; error: string };

/**
 * Result from checkHostReachable
 */
export interface HostReachableResult {
  reachable: boolean;
  error?: string;
}

/**
 * Plugin version info from agent
 */
export interface PluginVersionInfo {
  package: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
}

/**
 * Plugin versions response from agent /plugins/versions endpoint
 */
export interface PluginVersionsResponse {
  hasUpdates: boolean;
  versions: PluginVersionInfo[];
  timestamp: string;
}

/**
 * Single plugin update result
 */
export interface PluginUpdateResult {
  package: string;
  previousVersion: string;
  newVersion: string;
  success: boolean;
  error?: string;
}

/**
 * Plugin update response from agent /plugins/update endpoint
 */
export interface PluginUpdateResponse {
  updated: number;
  results: PluginUpdateResult[];
  willRestart: boolean;
  message: string;
  timestamp: string;
}

/**
 * Result from plugin version check operation
 */
export interface PluginVersionCheckResult {
  success: boolean;
  response?: PluginVersionsResponse;
  error?: string;
}

/**
 * Result from triggering plugin update operation
 */
export interface TriggerUpdateResult {
  success: boolean;
  response?: PluginUpdateResponse;
  error?: string;
}

/**
 * Result from deploying to a single host
 */
export interface DeployToHostResult {
  success: boolean;
  result?: DeployResult;
  error?: string;
}

/**
 * Result type for deployment operations
 * Used by uploadFullWar, deployChunked, and deployToHost functions
 */
export interface DeployOperationResult {
  success: boolean;
  error?: string;
  result?: DeployResult;
}
