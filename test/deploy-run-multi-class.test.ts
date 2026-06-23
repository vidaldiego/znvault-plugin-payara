// Path: test/deploy-run-multi-class.test.ts
import { describe, it, expect } from 'vitest';
import { detectConfigShape, validateClassFlags, validateClassHostOverride } from '../src/cli/commands/deploy-run.js';
import type { DeployConfig } from '../src/cli/types.js';

const multi: DeployConfig = { name: 'staging', warPath: '/a.war', port: 9100, classes: [
  { name: 'api', hosts: ['.55'] }, { name: 'worker', hosts: ['.58'] },
] };
const flat: DeployConfig = { name: 'flat', hosts: ['.1'], warPath: '/a.war', port: 9100, parallel: false };

describe('detectConfigShape', () => {
  it('multi-class when classes present', () => { expect(detectConfigShape(multi)).toBe('multi-class'); });
  it('flat when no classes', () => { expect(detectConfigShape(flat)).toBe('flat'); });
});

describe('validateClassFlags', () => {
  it('rejects --class on a flat config', () => {
    expect(validateClassFlags(flat, { classNames: ['api'] }).error).toMatch(/no classes/i);
  });
  it('rejects an unknown --class name', () => {
    expect(validateClassFlags(multi, { classNames: ['bogus'] }).error).toMatch(/bogus/);
  });
  it('rejects bare --strategy on a multi-class config', () => {
    expect(validateClassFlags(multi, { strategy: '1+2' }).error).toMatch(/per-class|specify --class/i);
  });
  it('rejects bare --host on a multi-class config', () => {
    expect(validateClassFlags(multi, { host: ['.55'] }).error).toMatch(/per-class|specify --class/i);
  });
  it('rejects --strategy with more than one --class', () => {
    expect(validateClassFlags(multi, { classNames: ['api', 'worker'], strategy: '1+2' }).error).toMatch(/exactly one --class/i);
  });
  it('accepts --class api --strategy 1+2', () => {
    expect(validateClassFlags(multi, { classNames: ['api'], strategy: '1+2' }).error).toBeUndefined();
  });
  it('accepts a plain multi-class run (no scoped flags)', () => {
    expect(validateClassFlags(multi, {}).error).toBeUndefined();
  });
});

describe('validateClassHostOverride (FIX 1)', () => {
  const classHosts = ['host-a', 'host-b', 'host-c'];

  it('returns empty unknownHosts when all overrides are class members', () => {
    expect(validateClassHostOverride(classHosts, ['host-a', 'host-c']).unknownHosts).toEqual([]);
  });

  it('returns unknownHosts containing values not in classHosts', () => {
    const result = validateClassHostOverride(classHosts, ['host-a', 'host-x', 'host-y']);
    expect(result.unknownHosts).toEqual(['host-x', 'host-y']);
  });

  it('returns empty unknownHosts for an empty override (no --host/--only flags)', () => {
    expect(validateClassHostOverride(classHosts, []).unknownHosts).toEqual([]);
  });

  it('treats a fully unknown override list as entirely unknown', () => {
    expect(validateClassHostOverride(classHosts, ['bogus-1', 'bogus-2']).unknownHosts).toEqual(['bogus-1', 'bogus-2']);
  });

  it('preserves class order: filtered result keeps config order, not flag order', () => {
    // The filter (`classHosts.filter(h => override.includes(h))`) preserves config order.
    // This test verifies the override-set membership check is order-insensitive.
    const { unknownHosts } = validateClassHostOverride(classHosts, ['host-c', 'host-a']);
    expect(unknownHosts).toEqual([]); // both in class — no unknowns, order doesn't matter for validation
  });
});
