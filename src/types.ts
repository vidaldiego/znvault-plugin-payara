// Path: src/types.ts
// Type definitions for Payara plugin

import type { Logger } from 'pino';

/**
 * Payara plugin configuration
 */
export interface PayaraPluginConfig {
  /** Path to Payara installation (e.g., /opt/payara) */
  payaraHome: string;

  /** Payara domain name (e.g., domain1) */
  domain: string;

  /** User to run Payara commands as (for sudo) */
  user: string;

  /** Path to WAR file to deploy */
  warPath: string;

  /** Application name in Payara */
  appName: string;

  /** Health check endpoint URL (e.g., http://localhost:8080/health) */
  healthEndpoint?: string;

  /** Restart Payara when certificates change */
  restartOnCertChange?: boolean;

  /** Restart Payara when managed API key is rotated (default: true) */
  restartOnKeyRotation?: boolean;

  /**
   * Path where the API key should be written as a file.
   * When set, the API key is written to this file instead of being embedded
   * in setenv.conf. Payara reads it via ZINC_CONFIG_VAULT_API_KEY_FILE env var.
   * The file is automatically updated when the key rotates.
   *
   * Example: "/var/lib/zn-vault-agent/api-key.txt"
   */
  apiKeyFilePath?: string;

  /**
   * Secret aliases to watch for changes.
   * When any of these secrets change, Payara will be restarted.
   * Useful for application configuration secrets.
   *
   * Example: ["api/staging/config"]
   */
  watchSecrets?: string[];

  /** Timeout for health check in milliseconds (default: 30000) */
  healthCheckTimeout?: number;

  /** Timeout for Payara start/stop operations in milliseconds (default: 120000) */
  operationTimeout?: number;

  /** Deploy context root (default: /) */
  contextRoot?: string;

  /** Enable verbose logging */
  verbose?: boolean;

  /**
   * Validate asadmin binary exists on startup.
   * Default: true (validates unless NODE_ENV=test)
   * Set to false to skip validation (useful for testing or deferred setup)
   */
  validateAsadmin?: boolean;

  /**
   * Enable aggressive mode for stable deployments.
   *
   * When true, the plugin will:
   * 1. Kill ALL Java processes before starting Payara (ensures clean slate)
   * 2. Use full restart sequence for deployments: undeploy → stop → kill → start → deploy
   * 3. Verify no Java processes running before each start
   *
   * This prevents:
   * - Port conflicts from orphan Java processes
   * - Memory issues from accumulated JVMs
   * - Deployment failures from stale state
   *
   * Recommended: true for production
   * Default: false (backwards compatibility)
   */
  aggressiveMode?: boolean;

  /**
   * Whether the plugin should manage Payara lifecycle (start/stop/restart).
   *
   * When true (default): Plugin handles starting/stopping Payara
   * When false: Plugin only handles WAR deployment, health checks, and secrets
   *
   * Set to false when using agent exec mode to start Payara, e.g.:
   *   zn-vault-agent start --exec "asadmin start-domain domain1"
   *
   * In this case, the agent's exec mode manages Payara lifecycle,
   * and the plugin should not interfere.
   */
  manageLifecycle?: boolean;

  /**
   * Secrets to inject as environment variables when starting Payara.
   * Keys are env var names, values are vault references:
   * - "alias:path/to/secret" - fetch secret by alias
   * - "alias:path/to/secret.field" - fetch specific field from JSON secret
   * - "api-key:keyname" - fetch API key value
   * - "literal:value" - use literal value (not recommended for secrets)
   *
   * Example:
   * {
   *   "ZINC_CONFIG_VAULT_API_KEY": "api-key:zincapi-staging",
   *   "AWS_ACCESS_KEY_ID": "alias:api/staging/s3.accessKeyId",
   *   "DATABASE_PASSWORD": "alias:db/prod.password"
   * }
   */
  secrets?: Record<string, string>;
}

/**
 * Payara manager options
 */
export interface PayaraManagerOptions {
  payaraHome: string;
  domain: string;
  user: string;
  healthEndpoint?: string;
  healthCheckTimeout?: number;
  operationTimeout?: number;
  logger: Logger;
  /** Environment variables to pass to Payara processes */
  environment?: Record<string, string>;
}

/**
 * WAR deployer options
 */
export interface WarDeployerOptions {
  warPath: string;
  appName: string;
  contextRoot?: string;
  payara: PayaraManager;
  logger: Logger;
  /**
   * Enable aggressive mode for deployments.
   * When true, deployments will use the full restart sequence:
   * undeploy → stop → kill all Java → start → deploy
   *
   * This ensures only ONE Java process runs at a time.
   * Recommended for production stability.
   */
  aggressiveMode?: boolean;
}

/**
 * File hash map for WAR diff deployment
 */
export interface WarFileHashes {
  [relativePath: string]: string; // path -> SHA-256 hash
}

/**
 * File change for deployment
 */
export interface FileChange {
  path: string;
  content: Buffer;
}

/**
 * Deploy request body
 */
export interface DeployRequest {
  files: Array<{ path: string; content: string }>; // base64 content
  deletions: string[];
}

/**
 * Deploy response
 */
export interface DeployResponse {
  status: 'deployed' | 'failed';
  filesChanged: number;
  filesDeleted: number;
  message?: string;
}

/**
 * Deploy result with full details
 */
export interface DeployResult {
  /** Whether deployment succeeded */
  success: boolean;
  /** Number of files changed */
  filesChanged: number;
  /** Number of files deleted */
  filesDeleted: number;
  /** Result message */
  message: string;
  /** Deployment time in milliseconds */
  deploymentTime: number;
  /** Application name */
  appName: string;
  /** Whether app is now deployed */
  deployed?: boolean;
  /** List of all deployed applications */
  applications?: string[];
}

/**
 * Full deployment result with timing breakdown (aggressive mode)
 */
export interface FullDeployResult extends DeployResult {
  /** Whether aggressive mode was used */
  aggressiveMode: true;
  /** Timing breakdown for each phase */
  timings: {
    /** Time to update WAR file (ms) */
    warUpdate?: number;
    /** Time to undeploy app (ms) */
    undeploy?: number;
    /** Time to stop Payara + kill Java (ms) */
    stop?: number;
    /** Time to start Payara (ms) */
    start?: number;
    /** Time to deploy WAR (ms) */
    deploy?: number;
  };
}

/**
 * Chunked deploy session - tracks state across multiple chunk uploads
 */
export interface ChunkedDeploySession {
  /** Session ID */
  id: string;
  /** Timestamp when session was created */
  createdAt: number;
  /** Files accumulated so far */
  files: Array<{ path: string; content: string }>;
  /** Deletions to apply */
  deletions: string[];
  /** Expected total files (for progress) */
  expectedFiles?: number;
}

/**
 * Chunked deploy request - upload a batch of files
 */
export interface ChunkedDeployRequest {
  /** Session ID (optional for first chunk - server generates one) */
  sessionId?: string;
  /** Files in this chunk */
  files: Array<{ path: string; content: string }>;
  /** Deletions (only needed in first chunk) */
  deletions?: string[];
  /** Expected total file count (for progress tracking) */
  expectedFiles?: number;
  /** If true, this is the last chunk - commit the deployment */
  commit?: boolean;
}

/**
 * Chunked deploy response
 */
export interface ChunkedDeployResponse {
  /** Session ID for subsequent chunks */
  sessionId: string;
  /** Files received so far */
  filesReceived: number;
  /** Whether deployment was committed */
  committed: boolean;
  /** Deployment result (only if committed) */
  result?: DeployResult;
}

/**
 * WAR upload request (multipart form data parsed)
 */
export interface WarUploadRequest {
  /** The WAR file buffer */
  warFile: Buffer;
}

/**
 * Payara status response
 */
export interface PayaraStatus {
  healthy: boolean;
  running: boolean;
  domain: string;
  pid?: number;
  uptime?: number;
  appDeployed?: boolean;
  appName?: string;
}

// Import type for PayaraManager reference in WarDeployerOptions
import type { PayaraManager } from './payara-manager.js';
