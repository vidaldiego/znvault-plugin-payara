// Path: src/mutation-auth.ts
// Dedicated authorization for Payara lifecycle and deployment mutations.

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';

export const DEFAULT_MUTATION_AUTH_TOKEN_FILE =
  '/etc/zn-vault-agent/payara-mutation-token';

const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 4096;

function mutationAuthError(message: string): Error {
  const error = new Error(`PAYARA_MUTATION_AUTH_INVALID: ${message}`);
  error.name = 'PAYARA_MUTATION_AUTH_INVALID';
  return error;
}

/**
 * Read the Payara mutation credential from a private regular file.
 *
 * The descriptor is opened with O_NOFOLLOW and validated after open so a
 * pathname swap cannot turn the read into a symlink traversal. A single final
 * LF (or CRLF) is accepted for compatibility with standard secret-file tools;
 * all other whitespace is rejected because the token is transported in an
 * Authorization header.
 */
export function loadMutationAuthTokenFile(filePath: string): string {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(filePath);
    if (pathStat.isSymbolicLink()) {
      throw mutationAuthError('token file must not be a symbolic link');
    }

    fd = openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw mutationAuthError('token path is not a regular file');
    }
    if (stat.nlink !== 1) {
      throw mutationAuthError('token file must have exactly one hard link');
    }
    if ((stat.mode & 0o077) !== 0) {
      throw mutationAuthError('token file permissions must not grant group or other access');
    }
    if (stat.size < MIN_TOKEN_BYTES || stat.size > MAX_TOKEN_BYTES + 2) {
      throw mutationAuthError(
        `token file size must be between ${MIN_TOKEN_BYTES} and ${MAX_TOKEN_BYTES + 2} bytes`
      );
    }

    const raw = readFileSync(fd, 'utf8');
    const token = raw.endsWith('\r\n')
      ? raw.slice(0, -2)
      : raw.endsWith('\n')
        ? raw.slice(0, -1)
        : raw;
    const tokenBytes = Buffer.byteLength(token, 'utf8');
    if (tokenBytes < MIN_TOKEN_BYTES || tokenBytes > MAX_TOKEN_BYTES) {
      throw mutationAuthError(
        `token length must be between ${MIN_TOKEN_BYTES} and ${MAX_TOKEN_BYTES} bytes`
      );
    }
    if (/\s/u.test(token)) {
      throw mutationAuthError('token must not contain whitespace');
    }
    return token;
  } catch (err) {
    if (err instanceof Error && err.name === 'PAYARA_MUTATION_AUTH_INVALID') {
      throw err;
    }
    const error = mutationAuthError(`unable to read private token file '${filePath}'`);
    // Preserve the filesystem cause for diagnostics without copying file data.
    Object.defineProperty(error, 'cause', { value: err, enumerable: false });
    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Compare a Bearer credential without token-length or token-content branches. */
export function isMutationAuthorized(
  authorizationHeader: string | string[] | undefined,
  expectedToken: string
): boolean {
  const header = typeof authorizationHeader === 'string'
    ? authorizationHeader
    : '';
  const match = /^Bearer ([^\s]+)$/iu.exec(header);
  const candidate = match?.[1] ?? '';
  const equal = timingSafeEqual(tokenDigest(candidate), tokenDigest(expectedToken));
  return match !== null && equal;
}

export function mutationAuthorizationHeader(token: string): string {
  return `Bearer ${token}`;
}
