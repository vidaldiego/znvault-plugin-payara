// Path: src/war-utils.ts
// WAR file utility functions - hash calculation and diff operations

import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import type { WarFileHashes } from './types.js';

/**
 * Calculate diff between local and remote hashes
 *
 * @param localHashes - Hashes from local WAR file
 * @param remoteHashes - Hashes from remote/deployed WAR file
 * @returns Object with changed and deleted file paths
 */
export function calculateDiff(
  localHashes: WarFileHashes,
  remoteHashes: WarFileHashes
): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];

  // Find changed/new files
  for (const [path, hash] of Object.entries(localHashes)) {
    if (!remoteHashes[path] || remoteHashes[path] !== hash) {
      changed.push(path);
    }
  }

  // Find deleted files
  for (const path of Object.keys(remoteHashes)) {
    if (!localHashes[path]) {
      deleted.push(path);
    }
  }

  return { changed, deleted };
}

/**
 * Calculate SHA-256 hashes for all files in a WAR archive
 *
 * @param warPath - Path to the WAR file
 * @returns Object mapping file paths to their SHA-256 hashes
 */
export async function calculateWarHashes(warPath: string): Promise<WarFileHashes> {
  const hashes: WarFileHashes = {};
  const zip = new AdmZip(warPath);

  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) {
      const content = entry.getData();
      const hash = createHash('sha256').update(content).digest('hex');
      hashes[entry.entryName] = hash;
    }
  }

  return hashes;
}

/**
 * Get file content from a WAR archive
 *
 * @param warPath - Path to the WAR file
 * @param path - Entry path within the WAR
 * @returns Buffer containing the file content
 * @throws Error if entry not found or is a directory
 */
export function getWarEntry(warPath: string, path: string): Buffer {
  const zip = new AdmZip(warPath);
  const entry = zip.getEntry(path);

  if (!entry || entry.isDirectory) {
    throw new Error(`Entry not found in WAR: ${path}`);
  }

  return entry.getData();
}
