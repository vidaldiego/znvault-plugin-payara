// Path: src/cli/war-info.ts
// WAR file information extraction utilities

import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import AdmZip from 'adm-zip';

/**
 * WAR file information
 */
export interface WarInfo {
  path: string;
  name: string;
  size: number;
  modifiedAt: Date;
  version?: string;
  buildTime?: string;
  fileCount: number;
}

/**
 * Extract WAR info including version from manifest
 *
 * Reads the WAR file and extracts:
 * - Basic file info (path, name, size, modified date)
 * - Version from MANIFEST.MF (Implementation-Version, Bundle-Version, or Specification-Version)
 * - Build time from MANIFEST.MF (Build-Time, Build-Timestamp, or Built-At)
 * - File count (excluding directories)
 *
 * @param warPath - Path to the WAR file
 * @returns WAR file information
 *
 * @example
 * ```typescript
 * const info = await getWarInfo('/path/to/app.war');
 * console.log(`WAR: ${info.name} v${info.version}`);
 * console.log(`Size: ${info.size} bytes, ${info.fileCount} files`);
 * ```
 */
export async function getWarInfo(warPath: string): Promise<WarInfo> {
  const warStats = await stat(warPath);
  const zip = new AdmZip(warPath);

  let version: string | undefined;
  let buildTime: string | undefined;

  // Try to read version from MANIFEST.MF
  const manifestEntry = zip.getEntry('META-INF/MANIFEST.MF');
  if (manifestEntry) {
    const manifest = manifestEntry.getData().toString('utf-8');

    // Look for Implementation-Version or Bundle-Version
    const versionMatch = manifest.match(/Implementation-Version:\s*(.+)/i)
      || manifest.match(/Bundle-Version:\s*(.+)/i)
      || manifest.match(/Specification-Version:\s*(.+)/i);
    if (versionMatch?.[1]) {
      version = versionMatch[1].trim();
    }

    // Look for Build-Time or Build-Timestamp
    const buildMatch = manifest.match(/Build-Time:\s*(.+)/i)
      || manifest.match(/Build-Timestamp:\s*(.+)/i)
      || manifest.match(/Built-At:\s*(.+)/i);
    if (buildMatch?.[1]) {
      buildTime = buildMatch[1].trim();
    }
  }

  // Count files
  const fileCount = zip.getEntries().filter(e => !e.isDirectory).length;

  return {
    path: warPath,
    name: basename(warPath),
    size: warStats.size,
    modifiedAt: warStats.mtime,
    version,
    buildTime,
    fileCount,
  };
}
