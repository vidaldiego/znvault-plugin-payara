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
} from '@zincapp/znvault-deploy-core';
export type { ProgressCallback } from '@zincapp/znvault-deploy-core';

// Formatters
export {
  formatSize,
  formatDuration,
  formatDate,
  progressBar,
  truncatePath,
  formatCount,
} from '@zincapp/znvault-deploy-core';

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
} from '@zincapp/znvault-deploy-core';

// Strategy executor
export {
  executeStrategy,
  resolveStrategy,
} from '@zincapp/znvault-deploy-core';
export type {
  StrategyExecutionResult,
  StrategyExecutorOptions,
} from '@zincapp/znvault-deploy-core';

// Unified progress
export {
  UnifiedProgress,
} from '@zincapp/znvault-deploy-core';
export type {
  HostState,
  HostStatus,
  HostAnalysis,
  UnifiedProgressOptions,
} from '@zincapp/znvault-deploy-core';

// HAProxy drain/ready operations
export {
  drainServer,
  readyServer,
  testHAProxyConnectivity,
  getUnmappedHosts,
} from '@zincapp/znvault-deploy-core';
export type {
  SSHExecResult,
  HAProxyOperationResult,
} from '@zincapp/znvault-deploy-core';

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
