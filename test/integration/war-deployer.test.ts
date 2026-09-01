// Path: test/integration/war-deployer.test.ts
// WarDeployer integration tests with real WAR file operations

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { WarDeployer, calculateDiff, calculateWarHashes } from '../../src/war-deployer.js';
import { PayaraManager } from '../../src/payara-manager.js';
import { createMockPayara, MockPayara } from '../helpers/mock-payara.js';
import {
  createTestWar,
  createComplexTestWar,
  createModifiedWar,
  createTempDir,
  cleanupTempDir,
  getWarHashes,
  getWarFile,
  listWarFiles,
} from '../helpers/war-utils.js';
import pino from 'pino';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, statSync } from 'node:fs';

describe('WarDeployer Integration', () => {
  let mockPayara: MockPayara;
  let tempDir: string;
  let logger: pino.Logger;

  beforeAll(async () => {
    logger = pino({ level: 'silent' });
  });

  beforeEach(async () => {
    tempDir = createTempDir('war-deployer-test');
    mockPayara = await createMockPayara({ baseDir: `${tempDir}/payara` });
    mockPayara.simulateStart();
  });

  afterEach(async () => {
    await mockPayara.cleanup();
    cleanupTempDir(tempDir);
  });

  // Helper to create deployer without lifecycle methods
  function createDeployer(warPath: string) {
    // WAR-only edits are exercised against a strictly stopped mock runtime.
    mockPayara.simulateStop();
    const payaraManager = new PayaraManager({
      payaraHome: mockPayara.payaraHome,
      domain: mockPayara.domain,
      user: process.env.USER || 'test',
      logger,
      runtimeIdentityProvider: async () => undefined,
      mutationQuarantinePath: `${tempDir}/mutation-quarantine/state.json`,
    });
    vi.spyOn(
      payaraManager as unknown as { getPayaraProcessPidsStrict: () => Promise<number[]> },
      'getPayaraProcessPidsStrict'
    ).mockResolvedValue([]);

    return new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: payaraManager,
      logger,
      deploymentLockPath: `${tempDir}/deploy.lock`,
    });
  }

  describe('Hash Calculation', () => {
    it('WD-01: should calculate hashes for all files in WAR', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/test.war`,
        appName: 'HashTest',
        files: [
          { path: 'test.txt', content: 'hello world' },
          { path: 'data/config.json', content: '{"key": "value"}' },
        ],
      });

      const hashes = await calculateWarHashes(warPath);

      expect(hashes).toHaveProperty('WEB-INF/web.xml');
      expect(hashes).toHaveProperty('index.html');
      expect(hashes).toHaveProperty('test.txt');
      expect(hashes).toHaveProperty('data/config.json');

      // Verify hash format (SHA-256 = 64 hex chars)
      for (const hash of Object.values(hashes)) {
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    it('WD-02: should produce consistent hashes for same content', async () => {
      const warPath1 = createTestWar({
        path: `${tempDir}/test1.war`,
        appName: 'Test',
        files: [{ path: 'file.txt', content: 'same content' }],
      });

      const warPath2 = createTestWar({
        path: `${tempDir}/test2.war`,
        appName: 'Test',
        files: [{ path: 'file.txt', content: 'same content' }],
      });

      const hashes1 = await calculateWarHashes(warPath1);
      const hashes2 = await calculateWarHashes(warPath2);

      expect(hashes1['file.txt']).toBe(hashes2['file.txt']);
    });

    it('WD-03: should produce different hashes for different content', async () => {
      const warPath1 = createTestWar({
        path: `${tempDir}/test1.war`,
        files: [{ path: 'file.txt', content: 'content A' }],
      });

      const warPath2 = createTestWar({
        path: `${tempDir}/test2.war`,
        files: [{ path: 'file.txt', content: 'content B' }],
      });

      const hashes1 = await calculateWarHashes(warPath1);
      const hashes2 = await calculateWarHashes(warPath2);

      expect(hashes1['file.txt']).not.toBe(hashes2['file.txt']);
    });

    it('WD-04: should handle complex WAR with many files', async () => {
      const warPath = createComplexTestWar(`${tempDir}/complex.war`);
      const hashes = await calculateWarHashes(warPath);

      expect(Object.keys(hashes).length).toBeGreaterThan(10);
      expect(hashes).toHaveProperty('css/style.css');
      expect(hashes).toHaveProperty('js/app.js');
    });

    it('WD-05: should throw for non-existent WAR file', async () => {
      await expect(calculateWarHashes(`${tempDir}/nonexistent.war`)).rejects.toThrow();
    });
  });

  describe('Diff Calculation', () => {
    it('WD-06: should detect no changes when WARs are identical', () => {
      const hashes = {
        'file1.txt': 'abc123',
        'file2.txt': 'def456',
      };

      const { changed, deleted } = calculateDiff(hashes, hashes);

      expect(changed).toHaveLength(0);
      expect(deleted).toHaveLength(0);
    });

    it('WD-07: should detect new files', () => {
      const local = {
        'existing.txt': 'abc123',
        'new-file.txt': 'ghi789',
      };
      const remote = {
        'existing.txt': 'abc123',
      };

      const { changed } = calculateDiff(local, remote);

      expect(changed).toContain('new-file.txt');
      expect(changed).toHaveLength(1);
    });

    it('WD-08: should detect modified files', () => {
      const local = { 'file.txt': 'new-hash' };
      const remote = { 'file.txt': 'old-hash' };

      const { changed } = calculateDiff(local, remote);

      expect(changed).toContain('file.txt');
    });

    it('WD-09: should detect deleted files', () => {
      const local = { 'kept.txt': 'abc123' };
      const remote = {
        'kept.txt': 'abc123',
        'deleted.txt': 'def456',
      };

      const { deleted } = calculateDiff(local, remote);

      expect(deleted).toContain('deleted.txt');
    });

    it('WD-10: should handle complex diff scenarios', () => {
      const local = {
        'unchanged.txt': 'same-hash',
        'modified.txt': 'new-hash',
        'added.txt': 'new-file-hash',
      };
      const remote = {
        'unchanged.txt': 'same-hash',
        'modified.txt': 'old-hash',
        'removed.txt': 'deleted-file-hash',
      };

      const { changed, deleted } = calculateDiff(local, remote);

      expect(changed).toContain('modified.txt');
      expect(changed).toContain('added.txt');
      expect(deleted).toContain('removed.txt');
    });
  });

  describe('File Operations', () => {
    it('WD-11: should get current hashes from WAR', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/app.war`,
        appName: 'TestApp',
        files: [{ path: 'custom.txt', content: 'custom content' }],
      });

      const deployer = createDeployer(warPath);
      const hashes = await deployer.getCurrentHashes();

      expect(hashes).toHaveProperty('WEB-INF/web.xml');
      expect(hashes).toHaveProperty('custom.txt');
    });

    it('WD-11a: should return one coherent exact WAR identity and entry map', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/identity.war`,
        appName: 'TestApp',
        files: [{ path: 'custom.txt', content: 'custom content' }],
      });
      const artifact = readFileSync(warPath);

      const readback = await createDeployer(warPath).getCurrentArtifactReadback();

      expect(readback).not.toBeNull();
      expect(readback?.size).toBe(artifact.byteLength);
      expect(readback?.sha256).toBe(
        createHash('sha256').update(artifact).digest('hex')
      );
      expect(readback?.hashes).toHaveProperty('custom.txt');
    });

    it('WD-11b: should return a bounded whole-WAR identity without an entry map', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/bounded-identity.war`,
        appName: 'TestApp',
        files: [{ path: 'custom.txt', content: 'custom content' }],
      });
      const artifact = readFileSync(warPath);

      const identity = await createDeployer(warPath).getCurrentArtifactIdentity();

      expect(identity).toEqual({
        size: artifact.byteLength,
        sha256: createHash('sha256').update(artifact).digest('hex'),
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(identity).not.toHaveProperty('hashes');
    });

    it('WD-12: should return empty hashes when WAR does not exist', async () => {
      const deployer = createDeployer(`${tempDir}/nonexistent.war`);
      const hashes = await deployer.getCurrentHashes();

      expect(hashes).toEqual({});
    });

    it('WD-12a: should return no artifact readback when WAR does not exist', async () => {
      const deployer = createDeployer(`${tempDir}/nonexistent.war`);

      expect(await deployer.getCurrentArtifactReadback()).toBeNull();
    });

    it('WD-12b: should return no bounded artifact identity when WAR does not exist', async () => {
      const deployer = createDeployer(`${tempDir}/nonexistent.war`);

      expect(await deployer.getCurrentArtifactIdentity()).toBeNull();
    });

    it('WD-13: should get specific file from WAR', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/app.war`,
        appName: 'TestApp',
        files: [{ path: 'data/config.json', content: '{"setting": true}' }],
      });

      const deployer = createDeployer(warPath);
      const content = await deployer.getFile('data/config.json');

      expect(content?.toString()).toBe('{"setting": true}');
    });

    it('WD-14: should return null for non-existent file in WAR', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/app.war`,
        appName: 'TestApp',
      });

      const deployer = createDeployer(warPath);
      const content = await deployer.getFile('nonexistent.txt');

      expect(content).toBeNull();
    });
  });

  describe('Apply Changes (WAR modification only)', () => {
    it('WD-14a: should preserve mode and ownership when atomically replacing a WAR', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/app.war`,
        appName: 'TestApp',
      });
      chmodSync(warPath, 0o640);
      const before = statSync(warPath);

      await createDeployer(warPath).applyChangesWithoutDeploy(
        [{ path: 'metadata.txt', content: Buffer.from('preserved') }],
        []
      );

      const after = statSync(warPath);
      expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
      expect(after.uid).toBe(before.uid);
      expect(after.gid).toBe(before.gid);
    });

    it('WD-14b: should make a first WAR readable without relying on a shared group', async () => {
      const warPath = `${tempDir}/first/app.war`;
      const previousUmask = process.umask(0o077);
      try {
        await createDeployer(warPath).applyChangesWithoutDeploy(
          [{ path: 'first.txt', content: Buffer.from('created') }],
          []
        );
      } finally {
        process.umask(previousUmask);
      }

      const created = statSync(warPath);
      expect(created.mode & 0o7777).toBe(0o644);
      expect(created.mode & 0o004).toBe(0o004);
      expect(readFileSync(warPath).length).toBeGreaterThan(0);
    });

    it('WD-15: should apply file additions to WAR', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/app.war`,
        appName: 'TestApp',
      });

      const deployer = createDeployer(warPath);
      const initialFiles = listWarFiles(warPath);

      // Use applyChangesWithoutDeploy to test WAR modification only
      await deployer.applyChangesWithoutDeploy(
        [{ path: 'new-file.txt', content: Buffer.from('new content') }],
        []
      );

      const finalFiles = listWarFiles(warPath);
      expect(finalFiles).toContain('new-file.txt');
      expect(finalFiles.length).toBe(initialFiles.length + 1);
    });

    it('WD-16: should apply file modifications to WAR', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/app.war`,
        appName: 'TestApp',
        files: [{ path: 'config.txt', content: 'original' }],
      });

      const deployer = createDeployer(warPath);

      await deployer.applyChangesWithoutDeploy(
        [{ path: 'config.txt', content: Buffer.from('modified') }],
        []
      );

      const content = getWarFile(warPath, 'config.txt');
      expect(content?.toString()).toBe('modified');
    });

    it('WD-17: should apply file deletions to WAR', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/app.war`,
        appName: 'TestApp',
        files: [
          { path: 'keep.txt', content: 'keep this' },
          { path: 'delete.txt', content: 'delete this' },
        ],
      });

      const deployer = createDeployer(warPath);

      await deployer.applyChangesWithoutDeploy([], ['delete.txt']);

      const finalFiles = listWarFiles(warPath);
      expect(finalFiles).not.toContain('delete.txt');
      expect(finalFiles).toContain('keep.txt');
    });

    it('WD-18: should handle complex changes', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/app.war`,
        appName: 'TestApp',
        files: [
          { path: 'unchanged.txt', content: 'unchanged' },
          { path: 'modify.txt', content: 'original' },
          { path: 'delete.txt', content: 'to delete' },
        ],
      });

      const deployer = createDeployer(warPath);

      await deployer.applyChangesWithoutDeploy(
        [
          { path: 'modify.txt', content: Buffer.from('modified') },
          { path: 'new.txt', content: Buffer.from('new file') },
        ],
        ['delete.txt']
      );

      const finalFiles = listWarFiles(warPath);
      expect(finalFiles).toContain('new.txt');
      expect(finalFiles).not.toContain('delete.txt');
      expect(getWarFile(warPath, 'modify.txt')?.toString()).toBe('modified');
      expect(getWarFile(warPath, 'unchanged.txt')?.toString()).toBe('unchanged');
    });

    it('WD-19: should handle nested directory additions', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/app.war`,
        appName: 'TestApp',
      });

      const deployer = createDeployer(warPath);

      await deployer.applyChangesWithoutDeploy(
        [{ path: 'deep/nested/path/file.txt', content: Buffer.from('deep content') }],
        []
      );

      const content = getWarFile(warPath, 'deep/nested/path/file.txt');
      expect(content?.toString()).toBe('deep content');
    });

    it('WD-20: should handle binary files', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/app.war`,
        appName: 'TestApp',
      });

      const deployer = createDeployer(warPath);
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);

      await deployer.applyChangesWithoutDeploy(
        [{ path: 'binary.bin', content: binaryContent }],
        []
      );

      const retrieved = getWarFile(warPath, 'binary.bin');
      expect(retrieved).toEqual(binaryContent);
    });

    it('WD-20a: epoch rotation before atomic rename leaves the prior WAR intact', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/epoch-race.war`,
        appName: 'TestApp',
        files: [{ path: 'version.txt', content: 'before' }],
      });
      const deployer = createDeployer(warPath);
      const commitFence = vi.spyOn(
        PayaraManager.prototype,
        'assertArtifactMutationEpochCurrent'
      ).mockRejectedValueOnce(new Error('BOOT_EPOCH_CHANGED: test rotation'));

      try {
        await expect(deployer.applyChangesWithoutDeploy(
          [{ path: 'version.txt', content: Buffer.from('after') }],
          []
        )).rejects.toThrow('BOOT_EPOCH_CHANGED');
        expect(getWarFile(warPath, 'version.txt')?.toString()).toBe('before');
      } finally {
        commitFence.mockRestore();
      }
    });

    it('WD-20b: a rejected deletion aborts without rewriting the WAR', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/delete-failure.war`,
        appName: 'TestApp',
        files: [{ path: 'keep.txt', content: 'before' }],
      });
      const deployer = createDeployer(warPath);

      await expect(
        deployer.applyChangesWithoutDeploy([], ['../outside.war-entry'])
      ).rejects.toThrow();
      expect(getWarFile(warPath, 'keep.txt')?.toString()).toBe('before');
    });
  });

  describe('Deployment Lock', () => {
    it('WD-21: should track deployment status', async () => {
      const warPath = createTestWar({
        path: `${tempDir}/app.war`,
        appName: 'TestApp',
      });

      const deployer = createDeployer(warPath);
      expect(deployer.isDeploying()).toBe(false);
    });
  });
});

describe('WAR Utility Functions', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('war-utils-test');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('WD-22: should compare two WAR files correctly', () => {
    const war1 = createTestWar({
      path: `${tempDir}/war1.war`,
      files: [
        { path: 'same.txt', content: 'unchanged' },
        { path: 'modified.txt', content: 'original' },
        { path: 'deleted.txt', content: 'to be deleted' },
      ],
    });

    const war2 = createModifiedWar(war1, `${tempDir}/war2.war`, {
      update: [{ path: 'modified.txt', content: 'changed' }],
      delete: ['deleted.txt'],
      add: [{ path: 'added.txt', content: 'new file' }],
    });

    const hashes1 = getWarHashes(war1);
    const hashes2 = getWarHashes(war2);
    const diff = calculateDiff(hashes2, hashes1);

    expect(diff.changed).toContain('added.txt');
    expect(diff.changed).toContain('modified.txt');
    expect(diff.deleted).toContain('deleted.txt');
  });

  it('WD-23: should create WAR with various file types', () => {
    const warPath = createComplexTestWar(`${tempDir}/complex.war`);
    const files = listWarFiles(warPath);

    expect(files.some(f => f.endsWith('.css'))).toBe(true);
    expect(files.some(f => f.endsWith('.js'))).toBe(true);
    expect(files.some(f => f.endsWith('.class'))).toBe(true);
    expect(files.some(f => f.endsWith('.jar'))).toBe(true);
  });
});
