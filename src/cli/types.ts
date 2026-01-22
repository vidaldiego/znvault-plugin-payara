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
 * Deployment configuration
 */
export interface DeployConfig {
  name: string;
  hosts: string[];
  warPath: string;
  port: number;
  parallel: boolean;
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
