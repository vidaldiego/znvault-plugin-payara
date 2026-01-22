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
 * Deployment configuration
 */
export interface DeployConfig {
  name: string;
  hosts: string[];
  warPath: string;
  port: number;
  /** @deprecated Use strategy instead. Kept for backwards compatibility. */
  parallel: boolean;
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
