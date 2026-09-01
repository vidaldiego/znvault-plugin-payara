// Path: src/war-utils.ts
// WAR file utility functions - hash calculation and diff operations

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import AdmZip from 'adm-zip';
import type {
  LocalWarArtifactSnapshot,
  WarFileHashes,
} from './types.js';

/**
 * Produce a deterministic identity for a WAR's logical entry contents.
 * Length-prefixed fields avoid concatenation ambiguity, and sorting makes the
 * digest independent of ZIP entry order/compression metadata.
 */
export function calculateWarContentSha256(hashes: WarFileHashes): string {
  const digest = createHash('sha256');
  for (const path of Object.keys(hashes).sort()) {
    const entryHash = hashes[path]!;
    digest.update(`${Buffer.byteLength(path, 'utf8')}:`, 'utf8');
    digest.update(path, 'utf8');
    digest.update(`:${entryHash.length}:`, 'utf8');
    digest.update(entryHash, 'utf8');
  }
  return digest.digest('hex');
}

function assertUnambiguousWarEntryName(entryName: string): void {
  const logicalName = entryName.endsWith('/')
    ? entryName.slice(0, -1)
    : entryName;
  const parts = logicalName.split('/');
  const hasAsciiControl = Array.from(entryName).some(character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    logicalName.length === 0
    || hasAsciiControl
    || entryName.includes('\\')
    || entryName.startsWith('/')
    || /^[A-Za-z]:\//u.test(entryName)
    || parts.some(part => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(
      `WAR_ENTRY_PATH_INVALID: ambiguous or unsafe ZIP entry name: ${JSON.stringify(entryName)}`
    );
  }
}

/**
 * Parse one WAR into an unambiguous logical entry map.
 *
 * ZIP permits duplicate names, while extractors/classloaders need not agree on
 * which duplicate wins. Such an archive cannot have one trustworthy logical
 * identity and is rejected instead of silently collapsing entries in an object.
 */
export function calculateWarEntryHashes(artifact: Buffer): WarFileHashes {
  const hashes: WarFileHashes = {};
  const zip = new AdmZip(artifact);
  const seenLogicalEntries = new Set<string>();
  const fileEntries = new Set<string>();
  const logicalParents = new Set<string>();

  for (const entry of zip.getEntries()) {
    assertUnambiguousWarEntryName(entry.entryName);
    const logicalName = entry.entryName.endsWith('/')
      ? entry.entryName.slice(0, -1)
      : entry.entryName;
    if (seenLogicalEntries.has(logicalName)) {
      throw new Error(
        `WAR_ENTRY_DUPLICATE: duplicate or file/directory-colliding ZIP entry: ` +
        JSON.stringify(entry.entryName)
      );
    }
    const parentParts = logicalName.split('/');
    parentParts.pop();
    let parent = '';
    for (const part of parentParts) {
      parent = parent.length === 0 ? part : `${parent}/${part}`;
      if (fileEntries.has(parent)) {
        throw new Error(
          `WAR_ENTRY_PATH_INVALID: file entry ${JSON.stringify(parent)} ` +
          `cannot also be a parent of ${JSON.stringify(entry.entryName)}`
        );
      }
    }
    if (!entry.isDirectory && logicalParents.has(logicalName)) {
      throw new Error(
        `WAR_ENTRY_PATH_INVALID: file entry ${JSON.stringify(entry.entryName)} ` +
        'collides with an existing descendant entry'
      );
    }
    seenLogicalEntries.add(logicalName);
    parent = '';
    for (const part of parentParts) {
      parent = parent.length === 0 ? part : `${parent}/${part}`;
      logicalParents.add(parent);
    }
    if (!entry.isDirectory) {
      const content = entry.getData();
      hashes[entry.entryName] = createHash('sha256').update(content).digest('hex');
      fileEntries.add(logicalName);
    }
  }

  return hashes;
}

/** Read a local WAR exactly once and retain an immutable in-memory snapshot. */
export async function readLocalWarArtifactSnapshot(
  warPath: string
): Promise<LocalWarArtifactSnapshot> {
  const artifact = Buffer.from(await readFile(warPath));
  const hashes = Object.freeze(calculateWarEntryHashes(artifact));
  const snapshot: LocalWarArtifactSnapshot = {
    size: artifact.byteLength,
    sha256: createHash('sha256').update(artifact).digest('hex'),
    contentSha256: calculateWarContentSha256(hashes),
    hashes,
    getBytes: () => Buffer.from(artifact),
  };
  return Object.freeze(snapshot);
}

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
  return (await readLocalWarArtifactSnapshot(warPath)).hashes;
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
