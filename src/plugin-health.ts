// Path: src/plugin-health.ts
// Plugin health check logic

import type { Logger } from 'pino';
import type { PluginHealthStatus } from '@zincapp/zn-vault-agent/plugins';
import type { PayaraStatus, PayaraPluginConfig } from './types.js';
import { verifyApiKeyFile } from './secrets-handler.js';

/**
 * Health evaluation context
 */
export interface HealthContext {
  config: PayaraPluginConfig;
  status: PayaraStatus;
  appDeployed: boolean;
  apiKey?: string;
  logger: Logger;
}

/**
 * Health evaluation result
 */
export interface HealthEvaluation {
  status: 'healthy' | 'degraded' | 'unhealthy';
  criticalError?: string;
  keySyncValid: boolean;
  hasDuplicateProcesses: boolean;
}

/**
 * Evaluate plugin health based on Payara status and API key sync
 */
export async function evaluateHealth(ctx: HealthContext): Promise<HealthEvaluation> {
  const { config, status, appDeployed, apiKey, logger } = ctx;

  // Check API key sync if configured
  let keySyncValid = true;
  let keySyncError: string | undefined;

  if (config.apiKeyFilePath && apiKey) {
    const keyVerification = await verifyApiKeyFile(
      config.apiKeyFilePath,
      apiKey,
      logger
    );
    keySyncValid = keyVerification.valid;
    if (!keySyncValid) {
      keySyncError = keyVerification.error || 'API key file mismatch';
      logger.error({
        filePath: config.apiKeyFilePath,
        error: keySyncError,
      }, 'CRITICAL: API key file out of sync - app authentication will fail');
    }
  }

  // Check for duplicate processes
  const processCount = status.processCount ?? 0;
  const hasDuplicateProcesses = processCount > 1;

  if (hasDuplicateProcesses) {
    logger.error({
      processCount,
      pids: status.processPids,
    }, 'CRITICAL: Multiple Payara processes detected - will cause cluster issues');
  }

  // Determine health status
  let healthStatus: 'healthy' | 'degraded' | 'unhealthy';
  let criticalError: string | undefined;

  if (!keySyncValid) {
    healthStatus = 'unhealthy';
    criticalError = keySyncError;
  } else if (hasDuplicateProcesses) {
    healthStatus = 'unhealthy';
    criticalError = `Multiple Payara processes detected (${processCount} PIDs: ${status.processPids?.join(', ')})`;
  } else if (status.running && appDeployed && status.healthy) {
    healthStatus = 'healthy';
  } else if (status.running) {
    healthStatus = 'degraded';
  } else {
    healthStatus = 'unhealthy';
  }

  return {
    status: healthStatus,
    criticalError,
    keySyncValid,
    hasDuplicateProcesses,
  };
}

/**
 * Build the full health status response
 */
export function buildHealthStatus(
  config: PayaraPluginConfig,
  status: PayaraStatus,
  appDeployed: boolean,
  evaluation: HealthEvaluation
): PluginHealthStatus {
  return {
    name: 'payara',
    status: evaluation.status,
    message: evaluation.criticalError ? `CRITICAL: ${evaluation.criticalError}` : undefined,
    details: {
      domain: config.domain,
      running: status.running,
      healthy: status.healthy,
      appDeployed,
      keySyncValid: evaluation.keySyncValid,
      processCount: status.processCount,
      processPids: status.processPids,
      warPath: config.warPath,
      appName: config.appName,
    },
  };
}

/**
 * Build an error health status response
 */
export function buildErrorHealthStatus(
  config: PayaraPluginConfig,
  errorMessage: string
): PluginHealthStatus {
  return {
    name: 'payara',
    status: 'unhealthy',
    message: errorMessage,
    details: {
      domain: config.domain,
      warPath: config.warPath,
    },
  };
}
