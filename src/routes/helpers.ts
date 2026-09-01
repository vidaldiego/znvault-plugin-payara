// Path: src/routes/helpers.ts
// Route validation and helper functions

import type { FastifyReply } from 'fastify';
import type { WarDeployer } from '../war-deployer.js';
import type { DeploymentArtifactExpectation } from '../types.js';

/** Stable wire name for binary deployment operation correlation. */
export const DEPLOYMENT_ID_HEADER = 'x-znvault-deployment-id';
/** Exact whole-WAR base token for binary uploads; `none` means no WAR existed. */
export const EXPECTED_BASE_SHA256_HEADER = 'x-znvault-expected-base-sha256';
/** Canonical entry-content target token for binary uploads. */
export const TARGET_CONTENT_SHA256_HEADER = 'x-znvault-target-content-sha256';

const DEPLOYMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/** Validate the explicit artifact CAS contract shared by every deploy rail. */
export function resolveArtifactExpectation(
  value: unknown,
  reply: FastifyReply
): DeploymentArtifactExpectation | undefined {
  if (!value || typeof value !== 'object') {
    reply.code(400).send({
      error: 'Invalid artifact expectation',
      message: 'artifact.expectedBaseSha256 and artifact.targetContentSha256 are required',
    });
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const expectedBaseSha256 = candidate.expectedBaseSha256;
  const targetContentSha256 = candidate.targetContentSha256;
  if (
    (expectedBaseSha256 !== null
      && (typeof expectedBaseSha256 !== 'string'
        || !SHA256_PATTERN.test(expectedBaseSha256)))
    || typeof targetContentSha256 !== 'string'
    || !SHA256_PATTERN.test(targetContentSha256)
  ) {
    reply.code(400).send({
      error: 'Invalid artifact expectation',
      message: 'expectedBaseSha256 must be a lowercase SHA-256 or null, and targetContentSha256 must be a lowercase SHA-256',
    });
    return undefined;
  }
  return { expectedBaseSha256, targetContentSha256 };
}

/** Decode the artifact CAS contract carried by a binary upload. */
export function resolveBinaryArtifactExpectation(
  expectedBaseHeader: unknown,
  targetContentHeader: unknown,
  reply: FastifyReply
): DeploymentArtifactExpectation | undefined {
  const expectedBaseSha256 = expectedBaseHeader === 'none'
    ? null
    : expectedBaseHeader;
  return resolveArtifactExpectation({
    expectedBaseSha256,
    targetContentSha256: targetContentHeader,
  }, reply);
}

/**
 * Resolve the caller-owned UUIDv4 for exactly one deployment mutation. Major 3
 * never invents this identity server-side: a client must know it before send so
 * a lost response remains recoverable through the exact status receipt.
 */
export function resolveDeploymentId(
  value: unknown,
  reply: FastifyReply,
  headerValue?: unknown
): string | undefined {
  if (value === undefined || value === null || value === '') {
    reply.code(400).send({
      error: 'Missing deployment ID',
      message: 'A caller-generated lowercase UUIDv4 deploymentId is required',
    });
    return undefined;
  }
  if (typeof value !== 'string' || !DEPLOYMENT_ID_PATTERN.test(value)) {
    reply.code(400).send({
      error: 'Invalid deployment ID',
      message: 'deploymentId must be a lowercase UUIDv4',
    });
    return undefined;
  }
  if (headerValue !== undefined && headerValue !== value) {
    reply.code(400).send({
      error: 'Deployment ID mismatch',
      message: 'The deploymentId body and x-znvault-deployment-id header must match exactly',
    });
    return undefined;
  }
  return value;
}

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
 * @param requestedDeploymentId - Identity of the caller's attempted operation
 * @param reply - Fastify reply object
 * @returns True if deployment is in progress (response sent), false otherwise
 *
 * @example
 * ```typescript
 * if (checkDeploymentInProgress(deployer, deploymentId, reply)) {
 *   return; // 409 already sent
 * }
 * // Continue with deployment...
 * ```
 */
export function checkDeploymentInProgress(
  deployer: WarDeployer,
  requestedDeploymentId: string,
  reply: FastifyReply
): boolean {
  if (deployer.isDeploying()) {
    const activeDeploymentId = deployer.getDeploymentStatus().deploymentId;
    reply.code(409).send({
      error: 'Deployment in progress',
      message: activeDeploymentId === requestedDeploymentId
        ? 'This deployment is already in progress. Poll its exact status.'
        : 'Another deployment is already in progress.',
      deploymentId: activeDeploymentId,
      requestedDeploymentId,
      sameOperation: activeDeploymentId === requestedDeploymentId,
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
