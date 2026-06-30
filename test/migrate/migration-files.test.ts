import { describe, it, expect } from 'vitest';
import { parsePrefix, discover, DuplicatePrefixError } from '../../src/migrate/migration-files.js';
import { readBaselineMarker } from '../../src/migrate/baseline-marker.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('parsePrefix', () => {
  it('parses helper', () => expect(parsePrefix('0000_migration-helpers.sql')).toBe('0000'));
  it('parses dated', () => expect(parsePrefix('2026-06-27_001_address.sql')).toBe('2026-06-27_001'));
  it('throws on garbage', () => expect(() => parsePrefix('nope.sql')).toThrow());
});
describe('discover', () => {
  it('shallow, excludes baseline/, sorts, dedups', () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(d, '2026-06-27_001_b.sql'), 'x'); writeFileSync(join(d, '0000_h.sql'), 'x');
    mkdirSync(join(d, 'baseline')); writeFileSync(join(d, 'baseline', '00-baseline-schema.sql'), 'x');
    const out = discover(d).map(f => f.prefix);
    expect(out).toEqual(['0000', '2026-06-27_001']);   // baseline/ excluded; sorted
  });
  it('throws on duplicate prefix', () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(d, '2026-06-27_001_a.sql'), 'x'); writeFileSync(join(d, '2026-06-27_001_b.sql'), 'x');
    expect(() => discover(d)).toThrow(DuplicatePrefixError);
  });
});
describe('readBaselineMarker', () => {
  it('reads the marker', () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-')); const p = join(d, 'b.sql');
    writeFileSync(p, '-- BASELINE_MARKER: 2026-06-28_000\nCREATE …');
    expect(readBaselineMarker(p)).toBe('2026-06-28_000');
  });
  it('null when absent', () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-')); const p = join(d, 'b.sql'); writeFileSync(p, 'CREATE …');
    expect(readBaselineMarker(p)).toBeNull();
  });
});
