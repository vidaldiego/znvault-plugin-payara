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

  /** Timeout for health check in milliseconds (default: 30000) */
  healthCheckTimeout?: number;

  /** Timeout for Payara start/stop operations in milliseconds (default: 120000) */
  operationTimeout?: number;

  /** Deploy context root (default: /) */
  contextRoot?: string;

  /** Enable verbose logging */
  verbose?: boolean;
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
 * Payara status response
 */
export interface PayaraStatus {
  healthy: boolean;
  running: boolean;
  domain: string;
  pid?: number;
  uptime?: number;
}

// Import type for PayaraManager reference in WarDeployerOptions
import type { PayaraManager } from './payara-manager.js';
