// Path: src/routes/helpers.ts
// Route validation and helper functions

import type { FastifyReply } from 'fastify';
import type { WarDeployer } from '../war-deployer.js';

/**
 * Standard error response structure
 */
export interface ErrorResponse {
  error: string;
  message: string;
}

/**
 * Check if deployment is in progress and send 409 response if so.
 *
 * @param deployer - WarDeployer instance
 * @param reply - Fastify reply object
 * @returns True if deployment is in progress (response sent), false otherwise
 *
 * @example
 * ```typescript
 * if (await checkDeploymentInProgress(deployer, reply)) {
 *   return; // 409 already sent
 * }
 * // Continue with deployment...
 * ```
 */
export function checkDeploymentInProgress(
  deployer: WarDeployer,
  reply: FastifyReply
): boolean {
  if (deployer.isDeploying()) {
    reply.code(409).send({
      error: 'Deployment in progress',
      message: 'Another deployment is already in progress. Please wait.',
    });
    return true;
  }
  return false;
}

/**
 * Validate that a value is an array.
 *
 * @param value - Value to check
 * @param fieldName - Field name for error message
 * @param reply - Fastify reply object
 * @returns True if validation failed (response sent), false if valid
 */
export function validateArray(
  value: unknown,
  fieldName: string,
  reply: FastifyReply
): boolean {
  if (!Array.isArray(value)) {
    reply.code(400).send({
      error: 'Invalid request',
      message: `${fieldName} must be an array`,
    });
    return true;
  }
  return false;
}

/**
 * Validate deploy request body.
 *
 * @param body - Request body with files and deletions
 * @param reply - Fastify reply object
 * @returns True if validation failed (response sent), false if valid
 */
export function validateDeployRequest(
  body: { files?: unknown; deletions?: unknown },
  reply: FastifyReply
): boolean {
  if (validateArray(body.files, 'files', reply)) {
    return true;
  }
  if (validateArray(body.deletions, 'deletions', reply)) {
    return true;
  }
  return false;
}

/**
 * Send a standardized error response.
 *
 * @param reply - Fastify reply object
 * @param code - HTTP status code
 * @param error - Error type/title
 * @param message - Error message
 */
export function sendError(
  reply: FastifyReply,
  code: number,
  error: string,
  message: string
): void {
  reply.code(code).send({ error, message });
}

/**
 * Send a 400 Bad Request error.
 */
export function sendBadRequest(
  reply: FastifyReply,
  message: string
): void {
  sendError(reply, 400, 'Bad Request', message);
}

/**
 * Send a 404 Not Found error.
 */
export function sendNotFound(
  reply: FastifyReply,
  message: string
): void {
  sendError(reply, 404, 'Not Found', message);
}

/**
 * Send a 500 Internal Server Error.
 */
export function sendServerError(
  reply: FastifyReply,
  message: string
): void {
  sendError(reply, 500, 'Internal Server Error', message);
}

/**
 * Decode base64 file contents from deploy request.
 *
 * @param files - Array of files with base64 content
 * @returns Array of files with Buffer content
 */
export function decodeFileContents(
  files: Array<{ path: string; content: string }>
): Array<{ path: string; content: Buffer }> {
  return files.map(f => ({
    path: f.path,
    content: Buffer.from(f.content, 'base64'),
  }));
}
