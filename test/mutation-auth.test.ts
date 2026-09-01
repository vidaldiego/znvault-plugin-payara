// Path: test/mutation-auth.test.ts

import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isMutationAuthorized,
  loadMutationAuthTokenFile,
} from '../src/mutation-auth.js';

const TOKEN = 'payara-control-token-0123456789abcdef';
const cleanup: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'payara-mutation-auth-'));
  cleanup.push(directory);
  return directory;
}

function privateTokenFile(contents = TOKEN): string {
  const filePath = join(tempDirectory(), 'token');
  writeFileSync(filePath, contents, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return filePath;
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Payara mutation credential files', () => {
  it('AUTH-FILE-01: reads a private regular file and permits one final newline', () => {
    expect(loadMutationAuthTokenFile(privateTokenFile(`${TOKEN}\n`))).toBe(TOKEN);
  });

  it('AUTH-FILE-02: rejects group/other permissions', () => {
    const filePath = privateTokenFile();
    chmodSync(filePath, 0o640);
    expect(() => loadMutationAuthTokenFile(filePath)).toThrow(
      'permissions must not grant group or other access'
    );
  });

  it('AUTH-FILE-03: rejects symbolic links', () => {
    const target = privateTokenFile();
    const link = join(tempDirectory(), 'token-link');
    symlinkSync(target, link);
    expect(() => loadMutationAuthTokenFile(link)).toThrow(
      'must not be a symbolic link'
    );
  });

  it('AUTH-FILE-04: rejects files with another hard link', () => {
    const target = privateTokenFile();
    linkSync(target, join(tempDirectory(), 'second-link'));
    expect(() => loadMutationAuthTokenFile(target)).toThrow(
      'exactly one hard link'
    );
  });

  it('AUTH-FILE-05: rejects directories and undersized credentials', () => {
    const directory = tempDirectory();
    mkdirSync(join(directory, 'not-a-file'));
    expect(() => loadMutationAuthTokenFile(join(directory, 'not-a-file'))).toThrow(
      'not a regular file'
    );
    expect(() => loadMutationAuthTokenFile(privateTokenFile('too-short'))).toThrow(
      'token file size must be between'
    );
  });
});

describe('Payara mutation Authorization comparison', () => {
  it('AUTH-CMP-01: accepts only the exact Bearer token', () => {
    expect(isMutationAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isMutationAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isMutationAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isMutationAuthorized(undefined, TOKEN)).toBe(false);
    expect(isMutationAuthorized(['Bearer first', 'Bearer second'], TOKEN)).toBe(false);
  });
});
