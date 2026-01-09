// Path: test/war-deployer.test.ts
// Tests for WAR deployer

import { describe, it, expect } from 'vitest';
import { calculateDiff, calculateWarHashes } from '../src/war-deployer.js';
import type { WarFileHashes } from '../src/types.js';

describe('calculateDiff', () => {
  it('should detect no changes when hashes match', () => {
    const local: WarFileHashes = {
      'WEB-INF/web.xml': 'abc123',
      'index.html': 'def456',
    };
    const remote: WarFileHashes = {
      'WEB-INF/web.xml': 'abc123',
      'index.html': 'def456',
    };

    const { changed, deleted } = calculateDiff(local, remote);

    expect(changed).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  it('should detect new files', () => {
    const local: WarFileHashes = {
      'WEB-INF/web.xml': 'abc123',
      'index.html': 'def456',
      'new-file.js': 'ghi789',
    };
    const remote: WarFileHashes = {
      'WEB-INF/web.xml': 'abc123',
      'index.html': 'def456',
    };

    const { changed, deleted } = calculateDiff(local, remote);

    expect(changed).toContain('new-file.js');
    expect(changed).toHaveLength(1);
    expect(deleted).toHaveLength(0);
  });

  it('should detect changed files', () => {
    const local: WarFileHashes = {
      'WEB-INF/web.xml': 'abc123-modified',
      'index.html': 'def456',
    };
    const remote: WarFileHashes = {
      'WEB-INF/web.xml': 'abc123',
      'index.html': 'def456',
    };

    const { changed, deleted } = calculateDiff(local, remote);

    expect(changed).toContain('WEB-INF/web.xml');
    expect(changed).toHaveLength(1);
    expect(deleted).toHaveLength(0);
  });

  it('should detect deleted files', () => {
    const local: WarFileHashes = {
      'WEB-INF/web.xml': 'abc123',
    };
    const remote: WarFileHashes = {
      'WEB-INF/web.xml': 'abc123',
      'index.html': 'def456',
      'old-file.css': 'jkl012',
    };

    const { changed, deleted } = calculateDiff(local, remote);

    expect(changed).toHaveLength(0);
    expect(deleted).toContain('index.html');
    expect(deleted).toContain('old-file.css');
    expect(deleted).toHaveLength(2);
  });

  it('should handle complex changes', () => {
    const local: WarFileHashes = {
      'WEB-INF/web.xml': 'abc123-modified', // changed
      'index.html': 'def456',               // unchanged
      'new-script.js': 'mno345',            // new
    };
    const remote: WarFileHashes = {
      'WEB-INF/web.xml': 'abc123',
      'index.html': 'def456',
      'old-style.css': 'pqr678',            // deleted
    };

    const { changed, deleted } = calculateDiff(local, remote);

    expect(changed).toContain('WEB-INF/web.xml');
    expect(changed).toContain('new-script.js');
    expect(changed).toHaveLength(2);
    expect(deleted).toContain('old-style.css');
    expect(deleted).toHaveLength(1);
  });

  it('should handle empty local (all deleted)', () => {
    const local: WarFileHashes = {};
    const remote: WarFileHashes = {
      'file1.txt': 'hash1',
      'file2.txt': 'hash2',
    };

    const { changed, deleted } = calculateDiff(local, remote);

    expect(changed).toHaveLength(0);
    expect(deleted).toHaveLength(2);
  });

  it('should handle empty remote (all new)', () => {
    const local: WarFileHashes = {
      'file1.txt': 'hash1',
      'file2.txt': 'hash2',
    };
    const remote: WarFileHashes = {};

    const { changed, deleted } = calculateDiff(local, remote);

    expect(changed).toHaveLength(2);
    expect(deleted).toHaveLength(0);
  });
});

describe('calculateWarHashes', () => {
  it('should throw for non-existent file', async () => {
    await expect(calculateWarHashes('/nonexistent/file.war')).rejects.toThrow();
  });

  // Note: More comprehensive tests would require creating actual WAR files
  // which is better done in integration tests
});
