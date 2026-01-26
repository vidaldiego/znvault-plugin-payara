// Path: src/cli/http-client.ts
// HTTP/HTTPS client for agent communication

import type { DeployResult } from '../types.js';
import type { AgentPostResult, DeploymentStatusResponse } from './types.js';
import {
  AGENT_TIMEOUT_MS,
  DEPLOYMENT_TIMEOUT_MS,
  STATUS_POLL_INTERVAL_MS,
  STATUS_POLL_MAX_WAIT_MS,
} from './constants.js';
import { getErrorMessage } from '../utils/error.js';
import { readFileSync } from 'node:fs';
import { Agent as HttpsAgent } from 'node:https';

/**
 * TLS configuration for HTTPS connections
 */
export interface TLSOptions {
  /** Enable TLS verification (default: true) */
  verify?: boolean;
  /** Path to CA certificate file (PEM format) */
  caCertPath?: string;
  /** Inline CA certificate (PEM format) */
  caCert?: string;
}

/**
 * Connection information for a host
 */
export interface ConnectionInfo {
  /** Host address */
  host: string;
  /** Whether TLS is being used */
  tls: boolean;
  /** Whether TLS certificate is verified (only relevant if tls=true) */
  verified: boolean;
  /** Effective port being used */
  port: number;
  /** Full plugin URL */
  pluginUrl: string;
}

/**
 * Global TLS options for all HTTPS requests in this CLI session.
 * This is intentionally global because the CLI runs as a single process
 * and TLS configuration should be consistent across all agent requests.
 */
let globalTLSOptions: TLSOptions = { verify: true };

/**
 * Cached HTTPS agent for reuse across requests
 */
let cachedHttpsAgent: HttpsAgent | null = null;

/**
 * Configure TLS options for all HTTPS requests.
 * Call this once at startup, before making any HTTPS requests.
 */
export function configureTLS(options: TLSOptions): void {
  globalTLSOptions = { ...globalTLSOptions, ...options };
  // Invalidate cached agent when options change
  cachedHttpsAgent = null;
}

/**
 * Get the current TLS configuration (for debugging/display)
 */
export function getTLSConfig(): Readonly<TLSOptions> {
  return { ...globalTLSOptions };
}

/**
 * Get or create a cached HTTPS agent with current TLS options
 */
function getHttpsAgent(): HttpsAgent | undefined {
  // Only create agent if we have custom TLS options
  const needsCustomAgent = !globalTLSOptions.verify ||
    globalTLSOptions.caCertPath !== undefined ||
    globalTLSOptions.caCert !== undefined;

  if (!needsCustomAgent) {
    return undefined;
  }

  if (cachedHttpsAgent) {
    return cachedHttpsAgent;
  }

  const agentOptions: {
    rejectUnauthorized?: boolean;
    ca?: string;
  } = {};

  if (!globalTLSOptions.verify) {
    agentOptions.rejectUnauthorized = false;
  }

  if (globalTLSOptions.caCertPath || globalTLSOptions.caCert) {
    const ca = globalTLSOptions.caCert ??
      (globalTLSOptions.caCertPath ? readFileSync(globalTLSOptions.caCertPath, 'utf-8') : undefined);
    if (ca) {
      agentOptions.ca = ca;
    }
  }

  cachedHttpsAgent = new HttpsAgent(agentOptions);
  return cachedHttpsAgent;
}

/**
 * Get fetch options with TLS configuration for HTTPS URLs
 */
function getFetchOptions(url: string, baseOptions: RequestInit): RequestInit {
  // Only apply TLS options for HTTPS URLs
  if (!url.startsWith('https://')) {
    return baseOptions;
  }

  const options: RequestInit & { dispatcher?: unknown; agent?: HttpsAgent } = { ...baseOptions };

  // Note: Node.js native fetch doesn't support custom TLS options directly.
  // We use undici's dispatcher option which is compatible with Node 18+

  // For Bun runtime, TLS options are handled differently
  if (typeof process !== 'undefined' && process.versions?.bun) {
    // Bun uses native TLS options
    if (!globalTLSOptions.verify) {
      (options as Record<string, unknown>).tls = { rejectUnauthorized: false };
    } else if (globalTLSOptions.caCertPath || globalTLSOptions.caCert) {
      const ca = globalTLSOptions.caCert ??
        (globalTLSOptions.caCertPath ? readFileSync(globalTLSOptions.caCertPath, 'utf-8') : undefined);
      if (ca) {
        (options as Record<string, unknown>).tls = { ca };
      }
    }
    return options;
  }

  // For Node.js, try undici dispatcher first (best approach for native fetch)
  try {
    // Dynamic import to avoid issues if undici is not available
    const { Agent } = require('undici') as { Agent: new (options: Record<string, unknown>) => unknown };
    const agentOptions: Record<string, unknown> = {};

    if (!globalTLSOptions.verify) {
      agentOptions.connect = { rejectUnauthorized: false };
    } else if (globalTLSOptions.caCertPath || globalTLSOptions.caCert) {
      const ca = globalTLSOptions.caCert ??
        (globalTLSOptions.caCertPath ? readFileSync(globalTLSOptions.caCertPath, 'utf-8') : undefined);
      if (ca) {
        agentOptions.connect = { ca };
      }
    }

    if (Object.keys(agentOptions).length > 0) {
      options.dispatcher = new Agent(agentOptions) as RequestInit['dispatcher'];
    }
  } catch {
    // undici not available - use node:https Agent
    // This works with node-fetch but may not work with native fetch in all cases
    const agent = getHttpsAgent();
    if (agent) {
      // Note: This only works if the fetch implementation supports 'agent' option
      // Native fetch in Node.js requires undici dispatcher
      (options as Record<string, unknown>).agent = agent;
    }
  }

  return options;
}

/**
 * GET request to agent endpoint
 */
export async function agentGet<T>(url: string, timeout = AGENT_TIMEOUT_MS): Promise<T> {
  const options = getFetchOptions(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent request failed: ${response.status} ${text}`);
  }
  return response.json() as Promise<T>;
}

/**
 * POST request that handles 409 "Deployment in progress" specially
 * Returns a discriminated union so caller can handle in-progress case
 */
export async function agentPostWithStatus<T>(
  url: string,
  body: unknown,
  timeout = DEPLOYMENT_TIMEOUT_MS
): Promise<AgentPostResult<T>> {
  try {
    const options = getFetchOptions(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const response = await fetch(url, options);

    if (response.ok) {
      const data = await response.json() as T;
      return { ok: true, data };
    }

    // Handle 409 "Deployment in progress" specially
    if (response.status === 409) {
      const text = await response.text();
      return { ok: false, status: 409, inProgress: true, error: text };
    }

    const text = await response.text();
    return { ok: false, status: response.status, inProgress: false, error: text };
  } catch (err) {
    // Timeout or network error
    const message = getErrorMessage(err);
    const isTimeout = message.includes('timeout') || message.includes('aborted');
    return { ok: false, status: 0, inProgress: isTimeout, error: message };
  }
}

/**
 * Legacy agentPost for backwards compatibility (throws on non-2xx)
 */
export async function agentPost<T>(url: string, body: unknown): Promise<T> {
  const options = getFetchOptions(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
  });
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent request failed: ${response.status} ${text}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Progress callback interface for deployment polling
 */
export interface ProgressCallback {
  waitingForDeployment(elapsed: number, step?: string): void;
}

/**
 * Poll deployment status until complete or timeout
 * Used when initial request times out or returns 409
 */
export async function pollDeploymentStatus(
  pluginUrl: string,
  startedAfter: number,
  progress: ProgressCallback,
  maxWaitMs = STATUS_POLL_MAX_WAIT_MS
): Promise<{ success: boolean; result?: DeployResult; error?: string }> {
  const pollStart = Date.now();

  while (Date.now() - pollStart < maxWaitMs) {
    try {
      const status = await agentGet<DeploymentStatusResponse>(
        `${pluginUrl}/deploy/status`,
        10000 // 10s timeout for status check
      );

      // Check if deployment completed after our request started
      if (status.lastCompletedAt && status.lastCompletedAt > startedAfter) {
        if (status.lastResult?.success) {
          return { success: true, result: status.lastResult };
        } else {
          return {
            success: false,
            error: status.lastResult?.message ?? 'Deployment failed',
            result: status.lastResult,
          };
        }
      }

      // Still deploying - show progress
      if (status.deploying) {
        const elapsed = Math.round((Date.now() - pollStart) / 1000);
        progress.waitingForDeployment(elapsed, status.currentStep);
      }
      // NOTE: We intentionally do NOT return early based on appDeployed && healthy
      // because that could be from a PREVIOUS deployment. We MUST wait for
      // lastCompletedAt > startedAfter to confirm THIS deployment finished.

      await new Promise(r => setTimeout(r, STATUS_POLL_INTERVAL_MS));
    } catch {
      // Status check failed - server might be restarting, keep polling
      await new Promise(r => setTimeout(r, STATUS_POLL_INTERVAL_MS));
    }
  }

  return { success: false, error: 'Timed out waiting for deployment to complete' };
}

/**
 * Build plugin URL from host and port, handling cases where:
 * 1. Host already includes protocol and port (e.g., http://host:9100)
 * 2. Host includes protocol but no port (e.g., http://host)
 * 3. Host is just hostname/IP (e.g., 172.16.220.55)
 *
 * @param useTLS - If true, use HTTPS protocol (default: false for backwards compat)
 */
export function buildPluginUrl(host: string, defaultPort: number, useTLS = false): string {
  const trimmed = host.replace(/\/$/, '');
  const defaultProtocol = useTLS ? 'https' : 'http';

  // Parse the URL to check for existing port
  try {
    // Add protocol if missing for URL parsing
    const urlString = trimmed.startsWith('http') ? trimmed : `${defaultProtocol}://${trimmed}`;
    const url = new URL(urlString);

    // If URL has a port explicitly set, use it; otherwise use defaultPort
    const effectivePort = url.port || String(defaultPort);
    return `${url.protocol}//${url.hostname}:${effectivePort}/plugins/payara`;
  } catch {
    // Fallback for invalid URLs - just append port
    const withProtocol = trimmed.startsWith('http') ? trimmed : `${defaultProtocol}://${trimmed}`;
    return `${withProtocol}:${defaultPort}/plugins/payara`;
  }
}

/**
 * Build plugin URL with automatic TLS detection
 * Uses HTTPS if TLS is configured, otherwise HTTP
 */
export function buildPluginUrlAuto(host: string, httpPort: number, httpsPort: number): string {
  const useTLS = globalTLSOptions.caCertPath !== undefined ||
                 globalTLSOptions.caCert !== undefined ||
                 !globalTLSOptions.verify;
  const port = useTLS ? httpsPort : httpPort;
  return buildPluginUrl(host, port, useTLS);
}

/**
 * Probe a host to determine the best connection method
 * Tries HTTPS first (if configured or auto-detect enabled), falls back to HTTP
 *
 * @param host Host address
 * @param httpPort HTTP port (default: 9100)
 * @param httpsPort HTTPS port (default: 9443)
 * @param autoDetect If true, try HTTPS even without explicit TLS config
 * @returns Connection info with the working configuration
 */
export async function probeHost(
  host: string,
  httpPort = 9100,
  httpsPort = 9443,
  autoDetect = true
): Promise<ConnectionInfo> {
  const tlsConfigured = globalTLSOptions.caCertPath !== undefined ||
                        globalTLSOptions.caCert !== undefined ||
                        !globalTLSOptions.verify;

  // If TLS is explicitly configured, use it directly
  if (tlsConfigured) {
    const pluginUrl = buildPluginUrl(host, httpsPort, true);
    return {
      host,
      tls: true,
      verified: globalTLSOptions.verify !== false,
      port: httpsPort,
      pluginUrl,
    };
  }

  // Try HTTPS first if auto-detect is enabled
  if (autoDetect) {
    try {
      const httpsUrl = buildPluginUrl(host, httpsPort, true);
      // Quick probe with short timeout - try unverified first to see if HTTPS is available
      const probeOptions = getFetchOptions(`${httpsUrl}/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });

      // Temporarily allow unverified for probe
      const originalVerify = globalTLSOptions.verify;
      globalTLSOptions.verify = false;
      cachedHttpsAgent = null;

      try {
        const response = await fetch(`${httpsUrl}/status`, probeOptions);
        if (response.ok || response.status === 401 || response.status === 403) {
          // HTTPS is available - keep using unverified mode since we detected it
          return {
            host,
            tls: true,
            verified: false,
            port: httpsPort,
            pluginUrl: httpsUrl,
          };
        }
      } catch {
        // HTTPS probe failed - fall through to HTTP
      } finally {
        // Restore original verify setting
        globalTLSOptions.verify = originalVerify;
        cachedHttpsAgent = null;
      }
    } catch {
      // HTTPS not available, fall through to HTTP
    }
  }

  // Fall back to HTTP
  const pluginUrl = buildPluginUrl(host, httpPort, false);
  return {
    host,
    tls: false,
    verified: false,
    port: httpPort,
    pluginUrl,
  };
}

/**
 * Probe multiple hosts in parallel
 */
export async function probeHosts(
  hosts: string[],
  httpPort = 9100,
  httpsPort = 9443,
  autoDetect = true
): Promise<Map<string, ConnectionInfo>> {
  const results = new Map<string, ConnectionInfo>();

  const probeResults = await Promise.all(
    hosts.map(async (host) => {
      try {
        const info = await probeHost(host, httpPort, httpsPort, autoDetect);
        return { host, info };
      } catch (err) {
        // Return HTTP fallback on error
        return {
          host,
          info: {
            host,
            tls: false,
            verified: false,
            port: httpPort,
            pluginUrl: buildPluginUrl(host, httpPort, false),
          },
        };
      }
    })
  );

  for (const { host, info } of probeResults) {
    results.set(host, info);
  }

  return results;
}

/**
 * Format connection info for display
 */
export function formatConnectionInfo(info: ConnectionInfo, plain = false): string {
  if (!info.tls) {
    return plain ? 'HTTP' : '\x1b[33mHTTP\x1b[0m'; // Yellow for unencrypted
  }
  if (info.verified) {
    return plain ? 'HTTPS (verified)' : '\x1b[32mHTTPS\x1b[0m'; // Green for verified
  }
  return plain ? 'HTTPS (unverified)' : '\x1b[36mHTTPS\x1b[0m'; // Cyan for unverified
}

/**
 * Get a short TLS indicator for task titles
 */
export function getTLSIndicator(info: ConnectionInfo, plain = false): string {
  if (!info.tls) {
    return plain ? '[HTTP]' : '\x1b[33m🔓\x1b[0m';
  }
  if (info.verified) {
    return plain ? '[TLS]' : '\x1b[32m🔒\x1b[0m';
  }
  return plain ? '[TLS*]' : '\x1b[36m🔐\x1b[0m';
}
