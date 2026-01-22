// Path: src/deployment-status.ts
// Deployment status tracking for long-running deployments

import type { Logger } from 'pino';
import type { DeployResult } from './types.js';

/**
 * Deployment status for tracking long-running deployments
 */
export interface DeploymentStatus {
  /** Whether a deployment is currently in progress */
  deploying: boolean;
  /** Current deployment ID (if deploying) */
  deploymentId?: string;
  /** Deployment start time (if deploying) */
  startedAt?: number;
  /** Current step in deployment process */
  currentStep?: string;
  /** Last completed deployment result */
  lastResult?: DeployResult;
  /** Last deployment completion time */
  lastCompletedAt?: number;
}

/**
 * Tracks deployment status for polling by CLI clients.
 *
 * Used to monitor long-running deployment operations and
 * provide status updates during deployment progress.
 */
export class DeploymentStatusTracker {
  private currentDeploymentId?: string;
  private deploymentStartedAt?: number;
  private currentStep?: string;
  private lastDeploymentResult?: DeployResult;
  private lastDeploymentCompletedAt?: number;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Get current deployment status for polling
   *
   * @param isDeploying - Whether deployment lock is held
   * @returns Current deployment status
   */
  getStatus(isDeploying: boolean): DeploymentStatus {
    return {
      deploying: isDeploying,
      deploymentId: this.currentDeploymentId,
      startedAt: this.deploymentStartedAt,
      currentStep: this.currentStep,
      lastResult: this.lastDeploymentResult,
      lastCompletedAt: this.lastDeploymentCompletedAt,
    };
  }

  /**
   * Update current deployment step
   *
   * @param step - Current step name
   */
  setStep(step: string): void {
    this.currentStep = step;
    this.logger.debug({ step }, 'Deployment step');
  }

  /**
   * Mark deployment as started
   *
   * @param deploymentId - Unique deployment identifier
   */
  markStarted(deploymentId: string): void {
    this.currentDeploymentId = deploymentId;
    this.deploymentStartedAt = Date.now();
    this.currentStep = 'starting';
  }

  /**
   * Mark deployment as completed
   *
   * @param result - Deployment result
   */
  markCompleted(result: DeployResult): void {
    this.lastDeploymentResult = result;
    this.lastDeploymentCompletedAt = Date.now();
    this.currentDeploymentId = undefined;
    this.deploymentStartedAt = undefined;
    this.currentStep = undefined;
  }

  /**
   * Get last deployment result
   *
   * @returns Last completed deployment result or undefined
   */
  getLastResult(): DeployResult | undefined {
    return this.lastDeploymentResult;
  }

  /**
   * Get last deployment completion time
   *
   * @returns Timestamp of last completion or undefined
   */
  getLastCompletedAt(): number | undefined {
    return this.lastDeploymentCompletedAt;
  }

  /**
   * Check if there's an active deployment
   *
   * @returns True if a deployment ID is set
   */
  hasActiveDeployment(): boolean {
    return this.currentDeploymentId !== undefined;
  }

  /**
   * Get current deployment ID
   *
   * @returns Current deployment ID or undefined
   */
  getCurrentDeploymentId(): string | undefined {
    return this.currentDeploymentId;
  }
}
