import { describe, it, expect } from 'vitest';
import {
  computeNoFailures,
  computeFullCoverage,
  isScopedDeploy,
  resolvePostSkipReason,
} from '../src/cli/post-gate.js';

describe('computeNoFailures', () => {
  it('true when all zero/false', () => {
    expect(computeNoFailures({ failed: 0, aborted: false, healthCheckFailed: 0, workerFailed: 0 })).toBe(true);
  });
  it('false on worker failure (S3)', () => {
    expect(computeNoFailures({ failed: 0, aborted: false, healthCheckFailed: 0, workerFailed: 1 })).toBe(false);
  });
  it('false on aborted / failed / healthCheckFailed', () => {
    expect(computeNoFailures({ failed: 1, aborted: false, healthCheckFailed: 0, workerFailed: 0 })).toBe(false);
    expect(computeNoFailures({ failed: 0, aborted: true, healthCheckFailed: 0, workerFailed: 0 })).toBe(false);
    expect(computeNoFailures({ failed: 0, aborted: false, healthCheckFailed: 2, workerFailed: 0 })).toBe(false);
  });
});

describe('computeFullCoverage', () => {
  it('true when deployed == configured', () => {
    expect(computeFullCoverage(3, 3)).toBe(true);
  });
  it('false when a host was dropped (B1b)', () => {
    expect(computeFullCoverage(2, 3)).toBe(false);
  });
});

describe('isScopedDeploy', () => {
  it('scoped when deployed set is a proper subset', () => {
    expect(isScopedDeploy(['a', 'b', 'c'], ['a'])).toBe(true);
  });
  it('not scoped when the set enumerates every configured host (SF-nit)', () => {
    expect(isScopedDeploy(['a', 'b'], ['a', 'b'])).toBe(false);
  });
});

describe('resolvePostSkipReason — precedence flag > scoped > partial > rollout', () => {
  it('flag wins', () => {
    expect(resolvePostSkipReason({ runPost: false, runPostFlag: '--skip-post', isScoped: true, fullCoverage: false, noFailures: false, dropped: ['c'] }))
      .toEqual({ kind: 'flag', flag: '--skip-post' });
  });
  it('scoped over partial/rollout', () => {
    expect(resolvePostSkipReason({ runPost: true, isScoped: true, fullCoverage: false, noFailures: false, dropped: ['c'] }))
      .toEqual({ kind: 'scoped-subset' });
  });
  it('partial-coverage over rollout-failed', () => {
    expect(resolvePostSkipReason({ runPost: true, isScoped: false, fullCoverage: false, noFailures: false, dropped: ['c'] }))
      .toEqual({ kind: 'partial-coverage', dropped: ['c'] });
  });
  it('rollout-failed', () => {
    expect(resolvePostSkipReason({ runPost: true, isScoped: false, fullCoverage: true, noFailures: false, dropped: [] }))
      .toEqual({ kind: 'rollout-failed' });
  });
  it('undefined when everything passes → post runs', () => {
    expect(resolvePostSkipReason({ runPost: true, isScoped: false, fullCoverage: true, noFailures: true, dropped: [] }))
      .toBeUndefined();
  });
});
