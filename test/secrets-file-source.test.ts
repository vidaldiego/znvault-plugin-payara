import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveUnderRoot } from '../src/secrets-handler.js';

const ROOT = '/etc/zn-agent/node/';

describe('resolveUnderRoot', () => {
  it('resolves a relative path under the root', () => {
    expect(resolveUnderRoot('node-role', ROOT)).toBe(path.resolve(ROOT, 'node-role'));
  });
  it('accepts an absolute path that is under the root', () => {
    expect(resolveUnderRoot('/etc/zn-agent/node/node-role', ROOT))
      .toBe(path.resolve('/etc/zn-agent/node/node-role'));
  });
  it('rejects a relative path that escapes via ..', () => {
    expect(resolveUnderRoot('../../etc/shadow', ROOT)).toBeNull();
  });
  it('rejects an absolute path outside the root', () => {
    expect(resolveUnderRoot('/etc/shadow', ROOT)).toBeNull();
  });
  it('rejects the root\'s parent', () => {
    expect(resolveUnderRoot('/etc/zn-agent', ROOT)).toBeNull();
  });
});
