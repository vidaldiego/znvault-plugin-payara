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

  /**
   * Absolute path to the dedicated Bearer credential for every Payara HTTP
   * mutation. The token is read from this private file during plugin init; it
   * must never be placed directly in config, environment variables, or argv.
   * Default: /etc/zn-vault-agent/payara-mutation-token
   */
  mutationAuthTokenFile?: string;

  /** Health check endpoint URL (e.g., http://localhost:8080/health) */
  healthEndpoint?: string;

  /** Legacy option. true is rejected; certificate events never restart Payara. */
  restartOnCertChange?: boolean;

  /** Legacy option. true is rejected; use apiKeyFilePath for live rotation. */
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
   * Legacy option. Any non-empty value is rejected because secret-change
   * events cannot safely mutate a running Payara environment.
   */
  watchSecrets?: string[];

  /** Timeout for health check in milliseconds (default: 30000) */
  healthCheckTimeout?: number;

  /** Timeout for Payara start/stop operations in milliseconds (default: 120000) */
  operationTimeout?: number;

  /**
   * Timeout for deploy commands in milliseconds (default: 600000 = 10 minutes).
   * Deploy operations can take longer than regular operations for large WARs.
   */
  deployTimeout?: number;

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
   * Path to asadmin password file for Payara 7+ authentication.
   * Required when domain was created with a master password.
   * File should contain: AS_ADMIN_PASSWORD=<password>
   *
   * Example: "/opt/payara/glassfish/domains/zincapi/config/admin-keyfile"
   */
  passwordFile?: string;

  /**
   * Enable aggressive mode for stable deployments.
   *
   * When true, the plugin will:
   * 1. Kill only exact DAS processes for this canonical domain before start
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
   * Only true/default is supported. false is rejected because agent exec child
   * events do not identify the detached DAS and cannot enforce one writer.
   */
  manageLifecycle?: boolean;

  /**
   * Delay in milliseconds after starting Payara before deploying the WAR.
   *
   * This delay allows Payara to fully initialize its environment variable
   * substitution system, which is required for @DataSourceDefinition annotations
   * that use ${ENV=...} placeholders.
   *
   * Without this delay, deployments immediately after a fresh domain start may
   * fail to properly resolve environment variables in resource annotations.
   *
   * Default: 5000 (5 seconds)
   * Set to 0 to disable the delay (not recommended for fresh starts)
   *
   * @example
   * // Use 10 seconds for slower systems
   * postStartDelay: 10000
   */
  postStartDelay?: number;

  /**
   * Secrets to inject as environment variables when starting Payara.
   * Keys are env var names, values are vault references:
   * - "alias:path/to/secret" - fetch secret by alias
   * - "alias:path/to/secret.field" - fetch specific field from JSON secret
   * - "api-key:keyname" - fetch API key value
   * - "literal:value" - use literal value (not recommended for secrets)
   * - "file:<path>" - read a LOCAL file on the node, inject its trimmed contents.
   *     Path must be under `fileSourceRoot` (default /etc/zn-agent/node/). A missing,
   *     unreadable, or empty file omits the env var (app falls back to its default).
   *     For per-node markers (scheduler role, zone) under a shared host-template.
   *
   * Example:
   * {
   *   "ZINC_CONFIG_VAULT_API_KEY": "api-key:zincapi-staging",
   *   "AWS_ACCESS_KEY_ID": "alias:app/staging/object-store.accessKeyId",
   *   "DATABASE_PASSWORD": "alias:db/prod.password"
   * }
   */
  secrets?: Record<string, string>;

  /**
   * Allowlist root for `file:` secret sources (default "/etc/zn-agent/node/").
   * A `file:` path is resolved under this root; a path outside it is rejected
   * and the env var is omitted. Bounds what a shared host-template can read.
   */
  fileSourceRoot?: string;
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
  /**
   * Timeout for deploy commands in milliseconds (default: 600000 = 10 minutes).
   * Deploy operations can take longer than regular operations for large WARs.
   */
  deployTimeout?: number;
  logger: Logger;
  /** Environment variables to pass to Payara processes */
  environment?: Record<string, string>;
  /** Path to asadmin password file for Payara 7+ authentication */
  passwordFile?: string;
  /** TTL for status cache in milliseconds (default: 5000) */
  statusCacheTtlMs?: number;
  /**
   * Override the exact DAS runtime identity probe. Equal values must identify
   * the same JVM process; any different value is treated as a new boot epoch.
   * Primarily intended for deterministic tests.
   */
  runtimeIdentityProvider?: () => Promise<string | number | undefined>;
  /**
   * Synchronous final identity CAS used immediately before a destructive
   * recovery command. Production defaults to a system-wide /proc scan. Tests
   * that override runtimeIdentityProvider must supply the matching sync seam
   * when exercising recovery.
   */
  runtimeIdentitySyncProvider?: () => string | number | undefined;
  /** Override durable mutation quarantine storage; false is for isolated tests only. */
  mutationQuarantinePath?: string | false;
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
  /** Override the cross-process lock path (primarily for isolated tests). */
  deploymentLockPath?: string;
  /**
   * Enable aggressive mode for deployments.
   * When true, deployments will use the full restart sequence:
   * undeploy when running → stop → kill exact domain DAS → start → deploy
   *
   * This ensures only ONE Java process runs at a time.
   * Recommended for production stability.
   */
  aggressiveMode?: boolean;
}

/** Positive evidence, if any, that a Payara-owned boot deployment may be mutated. */
export type BootDeploymentReadiness =
  | 'unverified'
  | 'health-verified'
  | 'externally-attested'
  | 'not_applicable';

/** Current single-writer state for one application in one domain boot epoch. */
export type BootDeploymentPhase =
  | 'unfenced'
  | 'startup'
  | 'payara-booting'
  | 'agent-reserved'
  | 'ready'
  | 'blocked';

/** Immutable evidence that startup observed Payara ownership and skipped deploy. */
export interface BootStartupReceipt {
  outcome: 'boot-owned-skip';
  deploymentAttempted: false;
  bootEpoch: string;
  /** SHA-256 token for the exact DAS boot_id/PID/startticks identity. */
  runtimeFingerprint: string;
  runtimeListed: boolean;
  observedAt: string;
}

/** Read-only status exposed to operators so readiness attestations are epoch-bound. */
export interface BootDeploymentStatus {
  appName: string;
  bootEpoch: string;
  /** SHA-256 token for the exact DAS boot_id/PID/startticks identity. */
  runtimeFingerprint?: string;
  phase: BootDeploymentPhase;
  readiness: BootDeploymentReadiness;
  owner?: 'payara' | 'agent';
  runtimeListed?: boolean;
  /** A deploy/undeploy command may have completed despite an ambiguous result. */
  mutationOutcomeUnknown: boolean;
  startupActive: boolean;
  startedAt: string;
  readyAt?: string;
  evidenceSource?: string;
  /** Startup-only receipt retained for this exact DAS epoch. */
  startupReceipt?: BootStartupReceipt;
}

/** Audited external evidence used when no application health endpoint is configured. */
export interface BootReadinessAttestation {
  bootEpoch: string;
  reason: string;
  source: string;
}

/**
 * Explicit authority for one immediate recovery of a Payara-owned boot whose
 * persistent reference exists but whose runtime application is absent or is
 * explicitly declared unhealthy by the operator.
 *
 * This is deliberately distinct from readiness attestation: submitting it
 * performs the bounded recovery while the same file lock and mutation lease
 * are held. It never grants reusable mutation authority.
 */
export interface BootRecoveryAuthorization {
  bootEpoch: string;
  runtimeFingerprint: string;
  /** SHA-256 of the exact staged WAR the operator authorizes for recovery. */
  expectedArtifactSha256: string;
  authorizationId: string;
  /** Exact inventory state the operator observed and is authorizing to replace. */
  expectedRuntimeListed: boolean;
  reason: string;
  source: string;
}

export interface BootRecoveryResult {
  applications: string[];
  bootDeployment: BootDeploymentStatus;
}

/** Which controller owns application deployment immediately after start-domain. */
export type BootDeploymentOwnership =
  | {
      owner: 'payara';
      bootEpoch: string;
      runtimeListed: boolean;
      readiness: Exclude<BootDeploymentReadiness, 'not_applicable'>;
    }
  | {
      owner: 'agent';
      bootEpoch: string;
      runtimeListed: boolean;
      readiness: 'not_applicable';
    };

/** How a post-start caller handles an application restored by Payara itself. */
export type PostStartDeploymentPolicy =
  | 'skip-if-boot-owned'
  | 'require-agent-owned';

/** Result of reconciling deployment ownership after start-domain. */
export type PostStartDeploymentResult =
  | {
      outcome: 'boot-owned-skip';
      bootEpoch: string;
      deploymentAttempted: false;
      deployedObserved: boolean;
      readiness: Exclude<BootDeploymentReadiness, 'not_applicable'>;
    }
  | {
      outcome: 'agent-deployed';
      bootEpoch: string;
      deploymentAttempted: true;
      deployed: boolean;
      applications: string[];
    }
  | {
      outcome: 'already-reconciled-skip';
      bootEpoch: string;
      deploymentAttempted: false;
      deployedObserved: true;
      owner: 'agent';
    };

/**
 * File hash map for WAR diff deployment
 */
export interface WarFileHashes {
  [relativePath: string]: string; // path -> SHA-256 hash
}

/** One coherent read of the exact stored WAR plus its entry hashes. */
export interface WarArtifactIdentity {
  size: number;
  /** SHA-256 of the exact persisted WAR bytes. Used as the base CAS token. */
  sha256: string;
  /**
   * Deterministic SHA-256 of the sorted entry-path/entry-hash manifest.
   * Diff deployment can reproduce this identity even when ZIP metadata differs.
   */
  contentSha256: string;
}

/** One coherent read of the exact stored WAR plus its entry hashes. */
export interface WarArtifactReadback extends WarArtifactIdentity {
  hashes: WarFileHashes;
}

/**
 * One immutable local read used by preflight and every host deployment.
 * `getBytes()` returns a defensive copy so callers cannot mutate the snapshot.
 */
export interface LocalWarArtifactSnapshot extends WarArtifactReadback {
  getBytes(): Buffer;
}

/** Artifact identities that bind a deployment request to one observed base. */
export interface DeploymentArtifactExpectation {
  /** Exact whole-WAR SHA observed from /hashes, or null when no WAR existed. */
  expectedBaseSha256: string | null;
  /** Canonical entry-content SHA of the local target snapshot. */
  targetContentSha256: string;
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
  /** Caller-generated lowercase UUIDv4 for this exact deployment operation. */
  deploymentId: string;
  /** Exact artifact identity fence for this deployment. */
  artifact: DeploymentArtifactExpectation;
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
  /** Unix timestamp when deployment completed */
  completedAt?: number;
  /** Exact persisted artifact proven after deployment. */
  artifact?: WarArtifactIdentity;
  /** Canonical target identity supplied by the caller and verified on readback. */
  targetContentSha256?: string;
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
  /** One identity shared by every chunk and the final commit. */
  deploymentId: string;
  /** Artifact fence fixed by the first chunk for the lifetime of the session. */
  artifact: DeploymentArtifactExpectation;
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
  /** Caller-generated lowercase UUIDv4 repeated exactly on every chunk. */
  deploymentId: string;
  /**
   * Artifact fence. Required on the first chunk and, when repeated, must match
   * the session exactly.
   */
  artifact?: DeploymentArtifactExpectation;
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
  /** Exact deployment identity bound to this session/result. */
  deploymentId: string;
  /** Session ID for subsequent chunks */
  sessionId: string;
  /** Files received so far */
  filesReceived: number;
  /** Whether deployment was committed */
  committed: boolean;
  /** Unix timestamp when deployment completed (only if committed) */
  completedAt?: number;
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
  /** Number of Payara/Java processes detected (should be 0 or 1) */
  processCount?: number;
  /** PIDs of detected Payara processes */
  processPids?: number[];
}

// Import type for PayaraManager reference in WarDeployerOptions
import type { PayaraManager } from './payara-manager.js';
