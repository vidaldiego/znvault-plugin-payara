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

// Global TLS options for all requests
let globalTLSOptions: TLSOptions = { verify: true };

/**
 * Configure TLS options for all HTTPS requests
 */
export function configureTLS(options: TLSOptions): void {
  globalTLSOptions = { ...globalTLSOptions, ...options };
}

/**
 * Get fetch options with TLS configuration for HTTPS URLs
 */
function getFetchOptions(url: string, baseOptions: RequestInit): RequestInit {
  // Only apply TLS options for HTTPS URLs
  if (!url.startsWith('https://')) {
    return baseOptions;
  }

  const options: RequestInit & { dispatcher?: unknown } = { ...baseOptions };

  // Note: Node.js native fetch doesn't support custom TLS options directly.
  // We use undici's dispatcher option which is compatible with Node 18+
  // For older Node versions or when using node-fetch, different approach is needed.

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

  // For Node.js, we need to use the undici dispatcher
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
    // undici not available, fall back to process.env workaround
    if (!globalTLSOptions.verify) {
      // WARNING: This disables TLS verification globally
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
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
