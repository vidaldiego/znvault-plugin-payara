// Path: src/cli/constants.ts
// CLI constants and configuration values

import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Chunk size for batched deployments (number of files per chunk)
 * Keeping chunks small to avoid body size limits
 */
export const CHUNK_SIZE = 50;

/**
 * Retry configuration for transient failures
 * Uses exponential backoff: 3s, 6s, 12s (~21s total)
 * This covers typical agent restart time (~10-15s)
 */
export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 3000;

/**
 * HTTP timeout configuration
 * - AGENT_TIMEOUT_MS: For quick API calls (status, hashes, health)
 * - DEPLOYMENT_TIMEOUT_MS: For deployment operations (may take several minutes)
 * - STATUS_POLL_INTERVAL_MS: How often to poll for deployment status
 * - STATUS_POLL_MAX_WAIT_MS: Maximum time to wait for deployment to complete
 */
export const AGENT_TIMEOUT_MS = 30000;           // 30 seconds for quick API calls
export const DEPLOYMENT_TIMEOUT_MS = 300000;     // 5 minutes for deployment requests
export const STATUS_POLL_INTERVAL_MS = 5000;     // Poll every 5 seconds
export const STATUS_POLL_MAX_WAIT_MS = 600000;   // Wait up to 10 minutes for completion

/**
 * Config file paths
 */
export const CONFIG_DIR = join(homedir(), '.znvault');
export const CONFIG_FILE = join(CONFIG_DIR, 'deploy-configs.json');

/**
 * ANSI escape codes for colors and cursor control
 */
export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  clearLine: '\x1b[2K',
  cursorUp: '\x1b[1A',
  cursorHide: '\x1b[?25l',
  cursorShow: '\x1b[?25h',
} as const;

/**
 * Get retry delay using exponential backoff
 */
export function getRetryDelay(attempt: number): number {
  // Exponential backoff: 3s, 6s, 12s
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

/**
 * Parse and validate port number
 * @throws Error if port is invalid
 */
export function parsePort(portStr: string, optionName = 'port'): number {
  const port = parseInt(portStr, 10);
  if (isNaN(port)) {
    throw new Error(`Invalid ${optionName}: "${portStr}" is not a number`);
  }
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid ${optionName}: ${port} must be between 1 and 65535`);
  }
  return port;
}
