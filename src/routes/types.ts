// Path: src/routes/types.ts
// Shared types for HTTP routes

import type { Logger } from 'pino';
import type { PayaraManager } from '../payara-manager.js';
import type { WarDeployer } from '../war-deployer.js';
import type { SessionStore } from '../session-store.js';

/**
 * Context passed to route handlers
 */
export interface RouteContext {
  payara: PayaraManager;
  deployer: WarDeployer;
  sessionStore: SessionStore;
  logger: Logger;
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
