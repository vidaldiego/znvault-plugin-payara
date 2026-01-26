// Path: src/cli/host-checks.ts
// Host reachability and plugin version checks

import { buildPluginUrl } from './http-client.js';
import { MAX_RETRIES, getRetryDelay } from './constants.js';
import { getErrorMessage } from '../utils/error.js';
import type {
  PluginVersionsResponse,
  PluginUpdateResponse,
  PluginVersionCheckResult,
  TriggerUpdateResult,
  HealthCheckConfig,
  HealthCheckResult,
} from './types.js';
import type { PreflightResult } from './progress.js';

/** Default health check configuration values */
const HEALTH_CHECK_DEFAULTS = {
  port: 8080,
  expectedStatus: 200,
  timeout: 5000,
  retries: 5,
  retryDelay: 3000,
} as const;

/**
 * Check plugin versions on a host
 */
export async function checkPluginVersions(
  host: string,
  port: number
): Promise<PluginVersionCheckResult> {
  const pluginUrl = buildPluginUrl(host, port);
  const versionsUrl = pluginUrl.replace('/plugins/payara', '/plugins/versions');

  try {
    const response = await fetch(versionsUrl, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 404) {
        return { success: false, error: 'Agent does not support plugin version check (upgrade agent to 1.15+)' };
      }
      return { success: false, error: `HTTP ${response.status}: ${text || response.statusText}` };
    }

    const data = await response.json() as PluginVersionsResponse;
    return { success: true, response: data };
  } catch (err) {
    const message = getErrorMessage(err);
    if (message.includes('timeout') || message.includes('aborted')) {
      return { success: false, error: 'Version check timed out' };
    }
    return { success: false, error: message };
  }
}

/**
 * Trigger plugin update on a host
 */
export async function triggerPluginUpdate(
  host: string,
  port: number
): Promise<TriggerUpdateResult> {
  const pluginUrl = buildPluginUrl(host, port);
  const updateUrl = pluginUrl.replace('/plugins/payara', '/plugins/update');

  try {
    const response = await fetch(updateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // Fastify requires a body when Content-Type is application/json
      signal: AbortSignal.timeout(180000), // 3 minute timeout for npm install
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 404) {
        return { success: false, error: 'Agent does not support plugin updates (upgrade agent to 1.15+)' };
      }
      return { success: false, error: `HTTP ${response.status}: ${text || response.statusText}` };
    }

    const data = await response.json() as PluginUpdateResponse;
    return { success: true, response: data };
  } catch (err) {
    const message = getErrorMessage(err);
    if (message.includes('timeout') || message.includes('aborted')) {
      return { success: false, error: 'Update timed out (npm install may still be running)' };
    }
    return { success: false, error: message };
  }
}

/**
 * Check if a host is reachable and get basic info
 * Uses same retry logic as deployment for consistency
 */
export async function checkHostReachable(
  host: string,
  port: number,
  onRetry?: (attempt: number, delay: number, error: string) => void
): Promise<PreflightResult> {
  const pluginUrl = buildPluginUrl(host, port);
  const healthUrl = pluginUrl.replace('/plugins/payara', '/health');

  let lastError = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt);
          onRetry?.(attempt, delay, lastError);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return { host, reachable: false, error: lastError };
      }

      const health = await response.json() as {
        version?: string;
        plugins?: Array<{ name: string; version?: string; details?: { running?: boolean } }>;
      };

      const payaraPlugin = health.plugins?.find(p => p.name === 'payara');

      return {
        host,
        reachable: true,
        agentVersion: health.version,
        pluginVersion: payaraPlugin?.version,
        payaraRunning: payaraPlugin?.details?.running,
      };
    } catch (err) {
      lastError = getErrorMessage(err);
      if (attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt);
        onRetry?.(attempt, delay, lastError);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
    }
  }

  return {
    host,
    reachable: false,
    error: lastError,
  };
}

/**
 * Perform post-deployment health check on the application
 * Retries with configurable delay until success or max retries reached
 *
 * @param host Host address (IP or hostname)
 * @param config Health check configuration
 * @param onAttempt Optional callback for each attempt
 * @returns Health check result
 */
export async function performHealthCheck(
  host: string,
  config: HealthCheckConfig,
  onAttempt?: (attempt: number, maxAttempts: number, status?: number, error?: string) => void
): Promise<HealthCheckResult> {
  const port = config.port ?? HEALTH_CHECK_DEFAULTS.port;
  const expectedStatus = config.expectedStatus ?? HEALTH_CHECK_DEFAULTS.expectedStatus;
  const timeout = config.timeout ?? HEALTH_CHECK_DEFAULTS.timeout;
  const maxRetries = config.retries ?? HEALTH_CHECK_DEFAULTS.retries;
  const retryDelay = config.retryDelay ?? HEALTH_CHECK_DEFAULTS.retryDelay;

  // Build health check URL
  const path = config.path.startsWith('/') ? config.path : `/${config.path}`;
  const url = `http://${host}:${port}${path}`;

  const startTime = Date.now();
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      onAttempt?.(attempt, maxRetries, undefined, undefined);

      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeout),
      });

      lastStatus = response.status;

      if (response.status === expectedStatus) {
        return {
          success: true,
          status: response.status,
          attempts: attempt,
          totalTime: Date.now() - startTime,
        };
      }

      // Wrong status code
      lastError = `Expected ${expectedStatus}, got ${response.status}`;
      onAttempt?.(attempt, maxRetries, response.status, lastError);
    } catch (err) {
      lastError = getErrorMessage(err);
      if (lastError.includes('timeout') || lastError.includes('aborted')) {
        lastError = 'Request timed out';
      } else if (lastError.includes('ECONNREFUSED')) {
        lastError = 'Connection refused';
      }
      onAttempt?.(attempt, maxRetries, undefined, lastError);
    }

    // Wait before retry (unless this was the last attempt)
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  return {
    success: false,
    status: lastStatus,
    error: lastError ?? 'Health check failed',
    attempts: maxRetries,
    totalTime: Date.now() - startTime,
  };
}
