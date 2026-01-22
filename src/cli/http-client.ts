// Path: src/cli/http-client.ts
// HTTP client for agent communication

import type { DeployResult } from '../types.js';
import type { AgentPostResult, DeploymentStatusResponse } from './types.js';
import {
  AGENT_TIMEOUT_MS,
  DEPLOYMENT_TIMEOUT_MS,
  STATUS_POLL_INTERVAL_MS,
  STATUS_POLL_MAX_WAIT_MS,
} from './constants.js';
import { getErrorMessage } from '../utils/error.js';

/**
 * GET request to agent endpoint
 */
export async function agentGet<T>(url: string, timeout = AGENT_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
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
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

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
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
  });
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
      } else if (status.appDeployed && status.healthy) {
        // Not deploying but app is deployed and healthy - likely completed
        return { success: true };
      }

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
 */
export function buildPluginUrl(host: string, defaultPort: number): string {
  const trimmed = host.replace(/\/$/, '');

  // Parse the URL to check for existing port
  try {
    // Add protocol if missing for URL parsing
    const urlString = trimmed.startsWith('http') ? trimmed : `http://${trimmed}`;
    const url = new URL(urlString);

    // If URL has a port explicitly set, use it; otherwise use defaultPort
    const effectivePort = url.port || String(defaultPort);
    return `${url.protocol}//${url.hostname}:${effectivePort}/plugins/payara`;
  } catch {
    // Fallback for invalid URLs - just append port
    const withProtocol = trimmed.startsWith('http') ? trimmed : `http://${trimmed}`;
    return `${withProtocol}:${defaultPort}/plugins/payara`;
  }
}
