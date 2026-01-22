// Path: src/utils/zip.ts
// ZIP file utility functions

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

/**
 * Recursively add directory contents to a ZIP archive.
 *
 * @param zip - AdmZip instance to add files to
 * @param dirPath - Directory path to read from
 * @param zipPath - Path prefix within the ZIP (empty for root)
 */
export async function addDirectoryToZip(
  zip: AdmZip,
  dirPath: string,
  zipPath: string
): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, fullPath, entryZipPath);
    } else {
      const content = await readFile(fullPath);
      zip.addFile(entryZipPath, content);
    }
  }
}

/**
 * Create a new ZIP archive from a directory.
 *
 * @param dirPath - Directory to archive
 * @returns AdmZip instance with directory contents
 */
export async function createZipFromDirectory(dirPath: string): Promise<AdmZip> {
  const zip = new AdmZip();
  await addDirectoryToZip(zip, dirPath, '');
  return zip;
}

/**
 * Get file content from a ZIP archive.
 *
 * @param zip - AdmZip instance
 * @param path - Entry path within the ZIP
 * @returns Buffer with file content, or null if not found
 */
export function getZipEntry(zip: AdmZip, path: string): Buffer | null {
  const entry = zip.getEntry(path);

  if (!entry || entry.isDirectory) {
    return null;
  }

  return entry.getData();
}

/**
 * List all file entries in a ZIP archive (excluding directories).
 *
 * @param zip - AdmZip instance
 * @returns Array of file paths
 */
export function listZipFiles(zip: AdmZip): string[] {
  return zip
    .getEntries()
    .filter(entry => !entry.isDirectory)
    .map(entry => entry.entryName);
}

/**
 * Count files in a ZIP archive (excluding directories).
 *
 * @param zip - AdmZip instance
 * @returns Number of files
 */
export function countZipFiles(zip: AdmZip): number {
  return zip.getEntries().filter(entry => !entry.isDirectory).length;
}
