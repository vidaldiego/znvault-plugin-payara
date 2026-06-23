// Path: test/deploy-run-multi-class.test.ts
import { describe, it, expect } from 'vitest';
import { detectConfigShape, validateClassFlags } from '../src/cli/commands/deploy-run.js';
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
