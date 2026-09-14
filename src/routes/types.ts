// Path: src/routes/types.ts
// Shared types for HTTP routes

import type { Logger } from 'pino';
import type { PayaraManager } from '../payara-manager.js';
import type { WarDeployer } from '../war-deployer.js';
import type { SessionStore } from '../session-store.js';
import type {
  SchedulerDeploymentFinalizeReceipt,
  SchedulerDeploymentStatusReceipt,
} from '../scheduler-internal-client.js';

export type SchedulerDeploymentFinalize = (
  outageId: string,
  targetContentSha256: string,
  outageCapability: string,
) => Promise<SchedulerDeploymentFinalizeReceipt>;

export type SchedulerDeploymentStatus = () => Promise<SchedulerDeploymentStatusReceipt>;

/**
 * Context passed to route handlers
 */
export interface RouteContext {
  payara: PayaraManager;
  deployer: WarDeployer;
  sessionStore: SessionStore;
  logger: Logger;
  /** Running plugin package version for the authenticated CLI compatibility gate. */
  pluginVersion: string;
  /** Exact loopback znapi atomic marker/latch finalization path. */
  finalizeSchedulerDeployment: SchedulerDeploymentFinalize;
  /** Exact loopback readback used only for reboot recovery after hold removal. */
  getSchedulerDeploymentStatus: SchedulerDeploymentStatus;
}

/**
 * Content type mappings for file responses
 */
export const CONTENT_TYPES: Record<string, string> = {
  'xml': 'application/xml',
  'html': 'text/html',
  'css': 'text/css',
  'js': 'application/javascript',
  'json': 'application/json',
  'properties': 'text/plain',
  'txt': 'text/plain',
  'class': 'application/java-vm',
  'jar': 'application/java-archive',
};
