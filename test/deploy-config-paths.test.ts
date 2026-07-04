import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandTilde, resolveConfigPath, resolveConfigPaths } from '../src/cli/deploy-config-paths.js';
import type { DeployConfig } from '../src/cli/types.js';

const HOME = homedir();

describe('expandTilde', () => {
  it('expands a leading ~/ to homedir', () => {
    expect(expandTilde('~/Drive/x')).toBe(join(HOME, 'Drive/x'));
  });
  it('expands a bare ~ to homedir', () => {
    expect(expandTilde('~')).toBe(HOME);
  });
  it('leaves a mid-path ~ alone', () => {
    expect(expandTilde('/a/~b/c')).toBe('/a/~b/c');
  });
  it('leaves an absolute path without ~ unchanged', () => {
    expect(expandTilde('/abs/path')).toBe('/abs/path');
  });
  it('leaves a relative path without ~ unchanged', () => {
    expect(expandTilde('rel/path')).toBe('rel/path');
  });
});

describe('resolveConfigPath', () => {
  it('absolute value wins — rootDir ignored', () => {
    expect(resolveConfigPath('/abs/war.war', '/root')).toBe('/abs/war.war');
  });
  it('relative value joins rootDir', () => {
    expect(resolveConfigPath('sub/war.war', '/root')).toBe('/root/sub/war.war');
  });
  it('tilde-expands the value before the absolute check (~ is absolute-ish → wins)', () => {
    expect(resolveConfigPath('~/w.war', '/root')).toBe(join(HOME, 'w.war'));
  });
  it('tilde-expands the rootDir before joining a relative value', () => {
    expect(resolveConfigPath('sub/w.war', '~/root')).toBe(join(HOME, 'root/sub/w.war'));
  });
  it('undefined value → undefined (absent optional field passthrough)', () => {
    expect(resolveConfigPath(undefined, '/root')).toBeUndefined();
  });
  it('relative value with NO rootDir → left as-is (validation is the gate)', () => {
    expect(resolveConfigPath('rel/x', undefined)).toBe('rel/x');
  });
});

describe('resolveConfigPaths', () => {
  const base: DeployConfig = {
    name: 'staging',
    rootDir: '/root',
    warPath: 'war/app.war',
    healthCheck: { path: '/service-status', port: 8080, expectedStatus: 200 },
    migration: { roleId: 'r', migrationsDir: 'docs/pre', scaffoldingFile: 'docs/0000.sql' },
    postMigration: { roleId: 'r', migrationsDir: 'docs/post', scaffoldingFile: 'docs/0000.sql' },
    classes: [
      { name: 'api', hosts: ['h1'], warPath: 'war/api.war' },
      { name: 'worker', hosts: ['h2'] },
    ],
  } as unknown as DeployConfig;

  it('resolves all 5 local fields (incl. per-class warPath) to absolute', () => {
    const r = resolveConfigPaths(base);
    expect(r.warPath).toBe('/root/war/app.war');
    expect(r.migration!.migrationsDir).toBe('/root/docs/pre');
    expect(r.migration!.scaffoldingFile).toBe('/root/docs/0000.sql');
    expect(r.postMigration!.migrationsDir).toBe('/root/docs/post');
    expect(r.postMigration!.scaffoldingFile).toBe('/root/docs/0000.sql');
    expect(r.classes![0]!.warPath).toBe('/root/war/api.war');
  });

  it('does NOT touch healthCheck.path or absent per-class warPath', () => {
    const r = resolveConfigPaths(base);
    expect(r.healthCheck!.path).toBe('/service-status');
    expect(r.classes![1]!.warPath).toBeUndefined();
  });

  it('does not mutate the input config', () => {
    const copy = JSON.parse(JSON.stringify(base));
    resolveConfigPaths(base);
    expect(base).toEqual(copy);
  });

  it('no rootDir + all-absolute → returns equivalent absolute values (byte-identical downstream)', () => {
    const abs: DeployConfig = {
      name: 's',
      warPath: '/a/app.war',
      migration: { roleId: 'r', migrationsDir: '/a/pre', scaffoldingFile: '/a/0000.sql' },
    } as unknown as DeployConfig;
    const r = resolveConfigPaths(abs);
    expect(r.warPath).toBe('/a/app.war');
    expect(r.migration!.migrationsDir).toBe('/a/pre');
    expect(r.migration!.scaffoldingFile).toBe('/a/0000.sql');
  });
});
