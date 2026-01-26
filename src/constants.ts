// Path: src/constants.ts
// Centralized constants for the Payara plugin

/**
 * Timeout constants (in milliseconds)
 */
export const TIMEOUTS = {
  /** Default operation timeout (2 minutes) */
  OPERATION: 120_000,

  /** Health check timeout (30 seconds) */
  HEALTH_CHECK: 30_000,

  /** Wait for healthy after start (1 minute) */
  WAIT_FOR_HEALTHY: 60_000,

  /** Wait for stopped (30 seconds) */
  WAIT_FOR_STOPPED: 30_000,

  /** Quick command timeout (10 seconds) - for list-domains, etc. */
  QUICK_COMMAND: 10_000,

  /** Session timeout (30 minutes) */
  SESSION: 30 * 60 * 1000,

  /** Status cache TTL (5 seconds) */
  STATUS_CACHE: 5_000,

  /** Stale lock detection (10 minutes) */
  STALE_LOCK: 600,
} as const;

/**
 * Polling intervals (in milliseconds)
 */
export const INTERVALS = {
  /** Health check polling (2 seconds) */
  HEALTH_POLL: 2_000,

  /** Stop check polling (1 second) */
  STOP_POLL: 1_000,

  /** Process kill delay (2 seconds) */
  KILL_DELAY: 2_000,
} as const;

/**
 * Limits and sizes
 */
export const LIMITS = {
  /** Maximum concurrent sessions */
  MAX_SESSIONS: 10,

  /** Maximum WAR file size (500MB) */
  MAX_WAR_SIZE: 500 * 1024 * 1024,

  /** Safe prefix length for logging API keys (4 chars) */
  SAFE_API_KEY_PREFIX: 4,

  /** Files per chunk in deployment */
  FILES_PER_CHUNK: 50,
} as const;

/**
 * File permissions
 */
export const PERMISSIONS = {
  /** setenv.conf file permissions (owner rw, group r) */
  SETENV_FILE: 0o640,

  /** Directory permissions (owner rwx, group rx) */
  DIRECTORY: 0o750,
} as const;

/**
 * Default paths
 */
export const PATHS = {
  /** Default deployment lock path */
  LOCK_FILE: '/var/lib/zn-vault-agent/znvault-deploy.lock',

  /** Default deployment journal path */
  JOURNAL_FILE: '/var/lib/zn-vault-agent/deployment-journal.json',
} as const;
