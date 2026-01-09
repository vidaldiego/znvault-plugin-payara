// Path: test/e2e/deploy-e2e.test.ts
// End-to-end tests for deployment using real agent with Payara plugin

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';

/**
 * These tests require a running agent with the Payara plugin on port 9100.
 * They can be run against the SDK test environment.
 *
 * To run these tests:
 * 1. Start the SDK test vault: docker compose -f docker-compose.sdk-test.yml up -d
 * 2. Start the agent with Payara plugin on port 9100
 * 3. Run: npm test -- test/e2e/deploy-e2e.test.ts
 */

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:9100';
const TEST_DIR = join(tmpdir(), 'deploy-e2e-test');

interface WarFileHashes {
  [path: string]: string;
}

/**
 * Create a test WAR file
 */
async function createTestWar(warPath: string, files: Record<string, string>): Promise<void> {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content));
  }
  zip.writeZip(warPath);
}

/**
 * Calculate hashes for WAR files
 */
function calculateWarHashes(warPath: string): WarFileHashes {
  const zip = new AdmZip(warPath);
  const hashes: WarFileHashes = {};

  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) {
      const hash = createHash('sha256').update(entry.getData()).digest('hex');
      hashes[entry.entryName] = hash;
    }
  }

  return hashes;
}

/**
 * Calculate diff between local and remote hashes
 */
function calculateDiff(
  localHashes: WarFileHashes,
  remoteHashes: WarFileHashes
): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];

  for (const [path, hash] of Object.entries(localHashes)) {
    if (!remoteHashes[path] || remoteHashes[path] !== hash) {
      changed.push(path);
    }
  }

  for (const path of Object.keys(remoteHashes)) {
    if (!localHashes[path]) {
      deleted.push(path);
    }
  }

  return { changed, deleted };
}

/**
 * Check if agent is reachable
 */
async function isAgentReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${AGENT_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

describe('Deploy E2E Tests', () => {
  let agentAvailable = false;

  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    agentAvailable = await isAgentReachable();

    if (!agentAvailable) {
      console.log('⚠️  Agent not available at', AGENT_URL);
      console.log('   Skipping E2E tests. To run:');
      console.log('   1. Start SDK test vault');
      console.log('   2. Start agent with Payara plugin on port 9100');
    }
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('Agent Health and Plugin', () => {
    it('E2E-01: should have healthy agent', async () => {
      if (!agentAvailable) {
        console.log('   Skipped: Agent not available');
        return;
      }

      const response = await fetch(`${AGENT_URL}/health`);
      expect(response.ok).toBe(true);

      const health = await response.json();
      expect(health.status).toBe('healthy');
    });

    it('E2E-02: should have Payara plugin loaded', async () => {
      if (!agentAvailable) {
        console.log('   Skipped: Agent not available');
        return;
      }

      const response = await fetch(`${AGENT_URL}/health`);
      const health = await response.json();

      expect(health.plugins).toBeDefined();
      const payaraPlugin = health.plugins.find((p: { name: string }) => p.name === 'payara');
      expect(payaraPlugin).toBeDefined();
      expect(payaraPlugin.status).toBe('healthy');
    });

    it('E2E-03: should have Payara status endpoint', async () => {
      if (!agentAvailable) {
        console.log('   Skipped: Agent not available');
        return;
      }

      const response = await fetch(`${AGENT_URL}/plugins/payara/status`);
      expect(response.ok).toBe(true);

      const status = await response.json();
      expect(status).toHaveProperty('healthy');
      expect(status).toHaveProperty('running');
      expect(status).toHaveProperty('domain');
    });
  });

  describe('WAR Hashes Endpoint', () => {
    it('E2E-04: should return WAR file hashes', async () => {
      if (!agentAvailable) {
        console.log('   Skipped: Agent not available');
        return;
      }

      const response = await fetch(`${AGENT_URL}/plugins/payara/hashes`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data).toHaveProperty('hashes');
      expect(typeof data.hashes).toBe('object');
    });

    it('E2E-05: should return SHA-256 hashes', async () => {
      if (!agentAvailable) {
        console.log('   Skipped: Agent not available');
        return;
      }

      const response = await fetch(`${AGENT_URL}/plugins/payara/hashes`);
      const data = await response.json();

      for (const hash of Object.values(data.hashes)) {
        // SHA-256 hashes are 64 hex characters
        expect(typeof hash).toBe('string');
        expect((hash as string).length).toBe(64);
        expect((hash as string)).toMatch(/^[a-f0-9]+$/);
      }
    });
  });

  describe('Diff Calculation', () => {
    it('E2E-06: should calculate correct diff for new files', async () => {
      const localHashes: WarFileHashes = {
        'index.html': 'abc123',
        'new-file.txt': 'def456',
      };
      const remoteHashes: WarFileHashes = {
        'index.html': 'abc123',
      };

      const diff = calculateDiff(localHashes, remoteHashes);
      expect(diff.changed).toContain('new-file.txt');
      expect(diff.changed).not.toContain('index.html');
      expect(diff.deleted).toHaveLength(0);
    });

    it('E2E-07: should calculate correct diff for changed files', async () => {
      const localHashes: WarFileHashes = {
        'index.html': 'new-hash',
        'style.css': 'same-hash',
      };
      const remoteHashes: WarFileHashes = {
        'index.html': 'old-hash',
        'style.css': 'same-hash',
      };

      const diff = calculateDiff(localHashes, remoteHashes);
      expect(diff.changed).toContain('index.html');
      expect(diff.changed).not.toContain('style.css');
    });

    it('E2E-08: should calculate correct diff for deleted files', async () => {
      const localHashes: WarFileHashes = {
        'index.html': 'abc123',
      };
      const remoteHashes: WarFileHashes = {
        'index.html': 'abc123',
        'old-file.txt': 'def456',
      };

      const diff = calculateDiff(localHashes, remoteHashes);
      expect(diff.deleted).toContain('old-file.txt');
      expect(diff.changed).toHaveLength(0);
    });

    it('E2E-09: should handle empty remote hashes (full deploy)', async () => {
      const localHashes: WarFileHashes = {
        'index.html': 'abc123',
        'style.css': 'def456',
        'app.js': 'ghi789',
      };
      const remoteHashes: WarFileHashes = {};

      const diff = calculateDiff(localHashes, remoteHashes);
      expect(diff.changed).toHaveLength(3);
      expect(diff.deleted).toHaveLength(0);
    });
  });

  describe('WAR File Operations', () => {
    it('E2E-10: should create WAR file correctly', async () => {
      const warPath = join(TEST_DIR, 'test-create.war');
      await createTestWar(warPath, {
        'index.html': '<html>Test</html>',
        'WEB-INF/web.xml': '<web-app/>',
      });

      const zip = new AdmZip(warPath);
      const entries = zip.getEntries();

      expect(entries.some(e => e.entryName === 'index.html')).toBe(true);
      expect(entries.some(e => e.entryName === 'WEB-INF/web.xml')).toBe(true);
    });

    it('E2E-11: should calculate consistent hashes', async () => {
      const warPath = join(TEST_DIR, 'test-hash.war');
      await createTestWar(warPath, {
        'index.html': '<html>Test</html>',
      });

      const hashes1 = calculateWarHashes(warPath);
      const hashes2 = calculateWarHashes(warPath);

      expect(hashes1['index.html']).toBe(hashes2['index.html']);
    });

    it('E2E-12: should detect changes between WAR versions', async () => {
      const warV1 = join(TEST_DIR, 'app-v1.war');
      const warV2 = join(TEST_DIR, 'app-v2.war');

      await createTestWar(warV1, {
        'index.html': '<html>v1</html>',
        'style.css': 'body {}',
      });

      await createTestWar(warV2, {
        'index.html': '<html>v2</html>',
        'style.css': 'body {}',
        'new.js': 'console.log("new");',
      });

      const hashesV1 = calculateWarHashes(warV1);
      const hashesV2 = calculateWarHashes(warV2);
      const diff = calculateDiff(hashesV2, hashesV1);

      expect(diff.changed).toContain('index.html'); // Changed content
      expect(diff.changed).toContain('new.js'); // New file
      expect(diff.changed).not.toContain('style.css'); // Unchanged
    });
  });

  describe('Deployment Payload', () => {
    it('E2E-13: should prepare correct deployment payload', async () => {
      const warPath = join(TEST_DIR, 'deploy-payload.war');
      await createTestWar(warPath, {
        'index.html': '<html>Deploy Test</html>',
        'config.json': '{"version": 1}',
      });

      const localHashes = calculateWarHashes(warPath);
      const remoteHashes: WarFileHashes = {}; // Full deploy

      const diff = calculateDiff(localHashes, remoteHashes);

      // Prepare payload as the CLI would
      const zip = new AdmZip(warPath);
      const files = diff.changed.map(path => {
        const entry = zip.getEntry(path);
        return {
          path,
          content: entry?.getData().toString('base64'),
        };
      });

      expect(files).toHaveLength(2);
      expect(files.every(f => f.content && f.content.length > 0)).toBe(true);
    });
  });

  describe('Agent Deployment Endpoint', () => {
    // Note: These tests are skipped in CI because deployment triggers actual Payara restart
    // which can take significant time. Run manually with longer timeout if needed.
    it.skip('E2E-14: should accept deployment request', async () => {
      if (!agentAvailable) {
        console.log('   Skipped: Agent not available');
        return;
      }

      // Get current hashes first
      const hashResponse = await fetch(`${AGENT_URL}/plugins/payara/hashes`);
      const { hashes: currentHashes } = await hashResponse.json();

      // Prepare a small update (just metadata to avoid actual restart)
      const response = await fetch(`${AGENT_URL}/plugins/payara/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [],
          deletions: [],
        }),
      });

      // Should succeed even with empty payload (no-op)
      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.status).toBe('deployed');
    });

    it.skip('E2E-15: should report deployment stats', async () => {
      if (!agentAvailable) {
        console.log('   Skipped: Agent not available');
        return;
      }

      const response = await fetch(`${AGENT_URL}/plugins/payara/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [],
          deletions: [],
        }),
      });

      const result = await response.json();
      expect(result).toHaveProperty('filesChanged');
      expect(result).toHaveProperty('filesDeleted');
      expect(typeof result.filesChanged).toBe('number');
      expect(typeof result.filesDeleted).toBe('number');
    });
  });

  describe('Agent Applications Endpoint', () => {
    it('E2E-16: should list deployed applications', async () => {
      if (!agentAvailable) {
        console.log('   Skipped: Agent not available');
        return;
      }

      const response = await fetch(`${AGENT_URL}/plugins/payara/applications`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data).toHaveProperty('applications');
      expect(Array.isArray(data.applications)).toBe(true);
    });
  });

  describe('Agent Restart Endpoint', () => {
    // Note: Restart test skipped in CI because it triggers actual Payara restart
    it.skip('E2E-17: should have restart endpoint', async () => {
      if (!agentAvailable) {
        console.log('   Skipped: Agent not available');
        return;
      }

      // Just verify the endpoint exists (don't actually restart in tests)
      const response = await fetch(`${AGENT_URL}/plugins/payara/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Should succeed (mock Payara will handle it)
      expect(response.ok).toBe(true);
    });
  });
});
