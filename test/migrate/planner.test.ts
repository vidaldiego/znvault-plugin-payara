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

  // ── Cross-phase integrity (pre/post migration split sharing one history table) ──
  describe('allTrackedFiles (cross-phase integrity lookup)', () => {
    it('a row tracked in the SIBLING phase dir is NOT an orphan when in allTrackedFiles', () => {
      // The post-deploy phase scans only post/ (2026-07-01_002), but the shared
      // schema_migrations table has rows for the pre/ migrations too. The integrity
      // check must validate rows against the UNION (pre ∪ post), not just phaseFiles.
      const phaseFiles = [f('2026-07-01_002')];                 // post/ only (what we apply)
      const preFile = f('2026-06-30_001');                      // lives in pre/
      const allTracked = [preFile, ...phaseFiles];              // pre ∪ post
      const rows = [
        row('2026-06-30_001_x.sql', true),                     // applied in the pre phase
        row('2026-07-01_002_x.sql', false),                    // reconcile in this post phase
      ];
      // Without allTracked this throws OrphanTrackedRowError on 2026-06-30_001.
      const p = plan(phaseFiles, rows, () => 'c', allTracked);
      // Classify/apply is scoped to phaseFiles only — the pre file is NOT re-applied.
      expect(p.reconcile.map((x) => x.prefix)).toEqual(['2026-07-01_002']);
      expect(p.applied).toHaveLength(0);   // 2026-06-30_001 is not in phaseFiles → not classified
      expect(p.pending).toHaveLength(0);
    });

    it('a GENUINE orphan (row in NEITHER dir) still throws even with allTrackedFiles', () => {
      const phaseFiles = [f('2026-07-01_002')];
      const allTracked = [f('2026-06-30_001'), ...phaseFiles];  // pre ∪ post
      const rows = [
        row('2026-06-30_001_x.sql', true),                     // ok — in allTracked
        row('2026-05-01_099_x.sql', true),                     // orphan — in NEITHER dir
      ];
      expect(() => plan(phaseFiles, rows, () => 'c', allTracked)).toThrow(OrphanTrackedRowError);
    });

    it('checksum mismatch is validated against the sibling-dir file too', () => {
      const phaseFiles = [f('2026-07-01_002')];
      const preFile = f('2026-06-30_001'); // path '/x'
      const allTracked = [preFile, ...phaseFiles];
      const rows = [row('2026-06-30_001_x.sql', true, false, 'STORED')];
      // The pre row's stored checksum differs from the (sibling) file's checksum → throw.
      expect(() => plan(phaseFiles, rows, () => 'DIFFERENT', allTracked)).toThrow(ChecksumMismatchError);
    });

    it('defaults allTrackedFiles to phaseFiles (single-dir configs unchanged)', () => {
      // When omitted, behavior is byte-identical to the pre-split single-dir path:
      // a row with no file in phaseFiles is still an orphan.
      const phaseFiles: ReturnType<typeof f>[] = [];
      const rows = [row('2026-01-01_001_x.sql', true)];
      expect(() => plan(phaseFiles, rows, () => 'c')).toThrow(OrphanTrackedRowError);
    });
  });
});
