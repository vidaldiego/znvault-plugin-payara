import { describe, it, expect } from 'vitest';
import { plan, ChecksumMismatchError, OrphanTrackedRowError } from '../../src/migrate/migration-planner.js';

const f = (prefix: string) => ({ version: prefix + '_x.sql', prefix, path: '/x' });
const row = (version: string, success: boolean, baselined = false, checksum = 'c') =>
  ({ version, checksum, checksumAlgo: 'sha256-lf-v1', success, baselined });

describe('plan', () => {
  it('success or baselined → applied; success=0 → reconcile; untracked → pending', () => {
    const files = [f('2026-01-01_001'), f('2026-01-01_002'), f('2026-01-01_003')];
    const rows = [row('2026-01-01_001_x.sql', true), row('2026-01-01_002_x.sql', false)];
    const p = plan(files, rows, () => 'c'); // inject checksum fn
    expect(p.applied.map((x) => x.prefix)).toEqual(['2026-01-01_001']);
    expect(p.reconcile.map((x) => x.prefix)).toEqual(['2026-01-01_002']);
    expect(p.pending.map((x) => x.prefix)).toEqual(['2026-01-01_003']);
  });

  it('checksum mismatch on a tracked file throws', () => {
    const files = [f('2026-01-01_001')];
    const rows = [row('2026-01-01_001_x.sql', true, false, 'STORED')];
    expect(() => plan(files, rows, () => 'DIFFERENT')).toThrow(ChecksumMismatchError);
  });

  it('baselined=true → applied (even if success=0)', () => {
    const files = [f('2026-01-01_001')];
    const rows = [row('2026-01-01_001_x.sql', false, true, 'c')];
    const p = plan(files, rows, () => 'c');
    expect(p.applied.map((x) => x.prefix)).toEqual(['2026-01-01_001']);
    expect(p.reconcile).toHaveLength(0);
  });

  it('0000_ helper files are always skipped (never planned)', () => {
    const files = [
      { version: '0000_migration-helpers.sql', prefix: '0000', path: '/helpers.sql' },
      f('2026-01-01_001'),
    ];
    const rows = [row('2026-01-01_001_x.sql', true)];
    const p = plan(files, rows, () => 'c');
    expect(p.applied.map((x) => x.prefix)).toEqual(['2026-01-01_001']);
    // The helper is not in any bucket
    expect(p.applied.some((x) => x.version.startsWith('0000_'))).toBe(false);
    expect(p.pending.some((x) => x.version.startsWith('0000_'))).toBe(false);
    expect(p.reconcile.some((x) => x.version.startsWith('0000_'))).toBe(false);
  });

  it('empty files + empty rows → all empty', () => {
    const p = plan([], [], () => 'x');
    expect(p.applied).toHaveLength(0);
    expect(p.reconcile).toHaveLength(0);
    expect(p.pending).toHaveLength(0);
  });

  it('tracked row with no matching file on disk → throws OrphanTrackedRowError', () => {
    // A DB row (success=true) exists for a version that has no file in `files`.
    // This simulates a migration file being renamed or deleted after it was applied.
    const files: ReturnType<typeof f>[] = []; // no files on disk
    const rows = [row('2026-01-01_001_x.sql', true)];
    expect(() => plan(files, rows, () => 'c')).toThrow(OrphanTrackedRowError);
  });

  it('0000_ tracked row with no matching file does NOT throw OrphanTrackedRowError', () => {
    // 0000_ rows are never tracked — the orphan check must skip them.
    const files: ReturnType<typeof f>[] = [];
    const rows = [row('0000_migration-helpers.sql', true)];
    // Should not throw — just returns empty buckets.
    const p = plan(files, rows, () => 'c');
    expect(p.applied).toHaveLength(0);
    expect(p.reconcile).toHaveLength(0);
    expect(p.pending).toHaveLength(0);
  });
});
