// Path: src/cli/index.ts
// CLI module entry point - re-exports all CLI components

// Constants
export {
  CHUNK_SIZE,
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
  AGENT_TIMEOUT_MS,
  DEPLOYMENT_TIMEOUT_MS,
  STATUS_POLL_INTERVAL_MS,
  STATUS_POLL_MAX_WAIT_MS,
  CONFIG_DIR,
  CONFIG_FILE,
  ANSI,
  getRetryDelay,
  parsePort,
} from './constants.js';

// Types
export type {
  CLIPluginContext,
  CLIPlugin,
  DeployConfig,
  DeployConfigStore,
  DeploymentStatusResponse,
  AgentPostResult,
  HostReachableResult,
  PluginVersionInfo,
  PluginVersionsResponse,
  PluginUpdateResult,
  PluginUpdateResponse,
  PluginVersionCheckResult,
  TriggerUpdateResult,
  DeployToHostResult,
  DeploymentStrategy,
  DeploymentStrategyBatch,
  HealthCheckConfig,
  HealthCheckResult,
  HAProxyConfig,
} from './types.js';

// Strategy functions
export {
  parseDeploymentStrategy,
  getStrategyDisplayName,
} from './types.js';

// HTTP client
export {
  agentGet,
  agentPost,
  agentPostWithStatus,
  pollDeploymentStatus,
  buildPluginUrl,
} from './http-client.js';
export type { ProgressCallback } from './http-client.js';

// Formatters
export {
  formatSize,
  formatDuration,
  formatDate,
  progressBar,
  truncatePath,
  formatCount,
} from './formatters.js';

// Progress reporter
export {
  ProgressReporter,
  getWarInfo,
} from './progress.js';
export type {
  WarInfo,
  PreflightResult,
} from './progress.js';

// Config store
export {
  loadDeployConfigs,
  saveDeployConfigs,
  getConfig,
  configExists,
  listConfigNames,
} from './config-store.js';

// Host checks
export {
  checkPluginVersions,
  triggerPluginUpdate,
  checkHostReachable,
  performHealthCheck,
} from './host-checks.js';

// Strategy executor
export {
  executeStrategy,
  resolveStrategy,
} from './strategy-executor.js';
export type {
  StrategyExecutionResult,
  StrategyExecutorOptions,
} from './strategy-executor.js';

// Unified progress
export {
  UnifiedProgress,
} from './unified-progress.js';
export type {
  HostState,
  HostStatus,
  HostAnalysis,
  UnifiedProgressOptions,
} from './unified-progress.js';

// HAProxy drain/ready operations
export {
  drainServer,
  readyServer,
  testHAProxyConnectivity,
  getUnmappedHosts,
} from './haproxy.js';
export type {
  SSHExecResult,
  HAProxyOperationResult,
} from './haproxy.js';

// Listr-based deployment (concurrent progress)
export {
  executeListrDeployment,
  printDeploymentSummary,
} from './listr-deploy.js';
export type {
  DeployContext,
  ListrDeployOptions,
} from './listr-deploy.js';

// Listr-based preflight (parallel checks)
export {
  executePreflightChecks,
  executePluginUpdates,
  waitForAgentRestart,
  printPreflightSummary,
} from './listr-preflight.js';
export type {
  HostPreflightResult,
  PreflightContext,
  PreflightOptions,
} from './listr-preflight.js';
