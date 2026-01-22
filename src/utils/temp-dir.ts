// Path: src/utils/temp-dir.ts
// Temporary directory management utilities

import { mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';

/**
 * Create a unique temporary directory.
 *
 * @param prefix - Prefix for the directory name (e.g., 'war-deploy', 'war-update')
 * @param baseDir - Base directory (default: '/tmp')
 * @returns Path to the created temporary directory
 */
export async function createTempDir(prefix: string, baseDir = '/tmp'): Promise<string> {
  const uniqueSuffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const tempDir = `${baseDir}/${prefix}-${uniqueSuffix}`;
  await mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Clean up a temporary directory, logging warnings on failure.
 *
 * @param tempDir - Path to the temporary directory to remove
 * @param logger - Optional logger for warnings
 */
export async function cleanupTempDir(tempDir: string, logger?: Logger): Promise<void> {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch (err) {
    if (logger) {
      logger.warn({ err, tempDir }, 'Failed to cleanup temp directory');
    }
    // Silently ignore cleanup errors - temp dirs will be cleaned by OS eventually
  }
}

/**
 * Execute a function with a temporary directory that is automatically cleaned up.
 *
 * @param prefix - Prefix for the directory name
 * @param fn - Function to execute with the temp directory path
 * @param logger - Optional logger for cleanup warnings
 * @returns Result of the function
 */
export async function withTempDir<T>(
  prefix: string,
  fn: (tempDir: string) => Promise<T>,
  logger?: Logger
): Promise<T> {
  const tempDir = await createTempDir(prefix);
  try {
    return await fn(tempDir);
  } finally {
    await cleanupTempDir(tempDir, logger);
  }
}
