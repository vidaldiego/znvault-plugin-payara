// Path: test/helpers/war-utils.ts
// WAR file utilities for testing

import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { dirname } from 'path';

export interface WarFileEntry {
  path: string;
  content: string | Buffer;
}

export interface TestWarOptions {
  /** WAR file path */
  path: string;
  /** Files to include */
  files?: WarFileEntry[];
  /** Include standard web.xml */
  includeWebXml?: boolean;
  /** Include standard index.html */
  includeIndexHtml?: boolean;
  /** Application name for web.xml */
  appName?: string;
}

/**
 * Standard web.xml template
 */
export function createWebXml(appName: string = 'TestApp'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<web-app xmlns="http://xmlns.jcp.org/xml/ns/javaee"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://xmlns.jcp.org/xml/ns/javaee
                             http://xmlns.jcp.org/xml/ns/javaee/web-app_4_0.xsd"
         version="4.0">
    <display-name>${appName}</display-name>
    <welcome-file-list>
        <welcome-file>index.html</welcome-file>
    </welcome-file-list>
</web-app>
`;
}

/**
 * Standard index.html template
 */
export function createIndexHtml(title: string = 'Test Application'): string {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
</head>
<body>
    <h1>${title}</h1>
    <p>Generated at: ${new Date().toISOString()}</p>
</body>
</html>
`;
}

/**
 * Create a test WAR file
 */
export function createTestWar(options: TestWarOptions): string {
  const {
    path: warPath,
    files = [],
    includeWebXml = true,
    includeIndexHtml = true,
    appName = 'TestApp',
  } = options;

  // Ensure directory exists
  mkdirSync(dirname(warPath), { recursive: true });

  const zip = new AdmZip();

  // Add standard files
  if (includeWebXml) {
    zip.addFile('WEB-INF/web.xml', Buffer.from(createWebXml(appName)));
  }

  if (includeIndexHtml) {
    zip.addFile('index.html', Buffer.from(createIndexHtml(appName)));
  }

  // Add custom files
  for (const file of files) {
    const content = typeof file.content === 'string' ? Buffer.from(file.content) : file.content;
    zip.addFile(file.path, content);
  }

  zip.writeZip(warPath);
  return warPath;
}

/**
 * Create a complex test WAR with multiple file types
 */
export function createComplexTestWar(warPath: string, appName: string = 'ComplexApp'): string {
  return createTestWar({
    path: warPath,
    appName,
    includeWebXml: true,
    includeIndexHtml: true,
    files: [
      // CSS
      { path: 'css/style.css', content: 'body { font-family: sans-serif; }' },
      { path: 'css/components.css', content: '.btn { padding: 10px; }' },

      // JavaScript
      { path: 'js/app.js', content: 'console.log("App loaded");' },
      { path: 'js/utils.js', content: 'function util() { return true; }' },

      // Images (simulated binary)
      { path: 'images/logo.png', content: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) },

      // Config files
      { path: 'WEB-INF/classes/config.properties', content: 'app.name=ComplexApp\napp.version=1.0.0' },

      // JSP files
      { path: 'WEB-INF/views/home.jsp', content: '<%@ page language="java" %><html><body>Home</body></html>' },

      // Java classes (simulated .class files)
      { path: 'WEB-INF/classes/com/test/Main.class', content: Buffer.alloc(100, 0xCA) },
      { path: 'WEB-INF/classes/com/test/Service.class', content: Buffer.alloc(200, 0xFE) },

      // Libraries (simulated JARs)
      { path: 'WEB-INF/lib/util-1.0.jar', content: Buffer.alloc(500, 0x50) },
      { path: 'WEB-INF/lib/commons-io-2.11.jar', content: Buffer.alloc(1000, 0x4B) },
    ],
  });
}

/**
 * Calculate hashes for all files in a WAR
 */
export function getWarHashes(warPath: string): Record<string, string> {
  const zip = new AdmZip(warPath);
  const hashes: Record<string, string> = {};

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
 * Get a file from a WAR
 */
export function getWarFile(warPath: string, filePath: string): Buffer | null {
  const zip = new AdmZip(warPath);
  const entry = zip.getEntry(filePath);
  return entry ? entry.getData() : null;
}

/**
 * List all files in a WAR
 */
export function listWarFiles(warPath: string): string[] {
  const zip = new AdmZip(warPath);
  return zip.getEntries()
    .filter(e => !e.isDirectory)
    .map(e => e.entryName)
    .sort();
}

/**
 * Update a file in a WAR
 */
export function updateWarFile(warPath: string, filePath: string, content: string | Buffer): void {
  const zip = new AdmZip(warPath);
  const buffer = typeof content === 'string' ? Buffer.from(content) : content;

  // Remove existing entry if present
  const existingEntry = zip.getEntry(filePath);
  if (existingEntry) {
    zip.deleteFile(filePath);
  }

  zip.addFile(filePath, buffer);
  zip.writeZip(warPath);
}

/**
 * Delete a file from a WAR
 */
export function deleteWarFile(warPath: string, filePath: string): void {
  const zip = new AdmZip(warPath);
  zip.deleteFile(filePath);
  zip.writeZip(warPath);
}

/**
 * Create a modified copy of a WAR with changes
 */
export function createModifiedWar(
  sourceWar: string,
  targetWar: string,
  changes: {
    update?: WarFileEntry[];
    delete?: string[];
    add?: WarFileEntry[];
  }
): string {
  const zip = new AdmZip(sourceWar);

  // Delete files
  for (const path of changes.delete || []) {
    zip.deleteFile(path);
  }

  // Update existing files
  for (const file of changes.update || []) {
    const content = typeof file.content === 'string' ? Buffer.from(file.content) : file.content;
    const existingEntry = zip.getEntry(file.path);
    if (existingEntry) {
      zip.deleteFile(file.path);
    }
    zip.addFile(file.path, content);
  }

  // Add new files
  for (const file of changes.add || []) {
    const content = typeof file.content === 'string' ? Buffer.from(file.content) : file.content;
    zip.addFile(file.path, content);
  }

  mkdirSync(dirname(targetWar), { recursive: true });
  zip.writeZip(targetWar);
  return targetWar;
}

/**
 * Compare two WARs and return differences
 */
export function compareWars(war1Path: string, war2Path: string): {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
} {
  const hashes1 = getWarHashes(war1Path);
  const hashes2 = getWarHashes(war2Path);

  const files1 = new Set(Object.keys(hashes1));
  const files2 = new Set(Object.keys(hashes2));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  // Find added files (in war2 but not in war1)
  for (const file of files2) {
    if (!files1.has(file)) {
      added.push(file);
    }
  }

  // Find removed files (in war1 but not in war2)
  for (const file of files1) {
    if (!files2.has(file)) {
      removed.push(file);
    }
  }

  // Find changed and unchanged files
  for (const file of files1) {
    if (files2.has(file)) {
      if (hashes1[file] === hashes2[file]) {
        unchanged.push(file);
      } else {
        changed.push(file);
      }
    }
  }

  return { added, removed, changed, unchanged };
}

/**
 * Create a temporary directory for test files
 */
export function createTempDir(prefix: string = 'war-test'): string {
  const dir = `/tmp/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Clean up a temporary directory
 */
export function cleanupTempDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
