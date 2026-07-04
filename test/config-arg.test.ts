import { describe, it, expect } from 'vitest';
import { isConfigFilePath } from '../src/cli/config-arg.js';

describe('isConfigFilePath (lexical, no filesystem probe)', () => {
  it('a bare name is NOT a file path', () => {
    expect(isConfigFilePath('staging')).toBe(false);
    expect(isConfigFilePath('production-2')).toBe(false);
  });
  it('a path with a forward slash IS a file path', () => {
    expect(isConfigFilePath('./staging')).toBe(true);
    expect(isConfigFilePath('a/b')).toBe(true);
    expect(isConfigFilePath('/abs/config')).toBe(true);
  });
  it('a path with a backslash IS a file path', () => {
    expect(isConfigFilePath('a\\b')).toBe(true);
  });
  it('anything ending in .json IS a file path', () => {
    expect(isConfigFilePath('config.json')).toBe(true);
    expect(isConfigFilePath('staging.payara.json')).toBe(true);
  });
  it('does NOT probe the filesystem — a bare name that happens to exist stays a NAME', () => {
    // 'package.json' ends in .json so it's a path, but a bare word never is,
    // regardless of whether a file of that name exists in cwd.
    expect(isConfigFilePath('staging')).toBe(false);
  });
});
