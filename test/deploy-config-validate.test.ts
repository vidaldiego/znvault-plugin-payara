// Path: test/deploy-config-validate.test.ts
import { describe, it, expect } from 'vitest';
import { validateDeployConfig } from '../src/cli/deploy-config-validate.js';
import type { DeployConfig } from '../src/cli/types.js';

const validMultiClass: DeployConfig = {
  name: 'staging',
  warPath: '/app.war',
  port: 9100,
  classes: [
    { name: 'api', hosts: ['.55', '.56'], strategy: '1+R',
      haproxy: { hosts: ['lb'], backend: 'b', serverMap: { '.55': 's1', '.56': 's2' } } },
    { name: 'worker', hosts: ['.58'], strategy: 'parallel', blocking: false },
  ],
};

describe('validateDeployConfig', () => {
  it('passes a fully valid 2-class config', () => {
    const r = validateDeployConfig(validMultiClass);
    expect(r.errors).toEqual([]);
  });

  it('errors when both hosts and classes are present', () => {
    const r = validateDeployConfig({ ...validMultiClass, hosts: ['.99'] });
    expect(r.errors.some(e => /both .*hosts.* and .*classes/i.test(e))).toBe(true);
  });

  it('errors on an empty classes array', () => {
    const r = validateDeployConfig({ name: 'x', classes: [] });
    expect(r.errors.some(e => /empty classes/i.test(e))).toBe(true);
  });

  it('errors on top-level quiesce in a multi-class config', () => {
    const r = validateDeployConfig({ ...validMultiClass, quiesce: { enabled: true } });
    expect(r.errors.some(e => /quiesce.*per-class/i.test(e))).toBe(true);
  });

  it('errors on a duplicate class name', () => {
    const r = validateDeployConfig({ name: 'x', classes: [
      { name: 'api', hosts: ['.1'] }, { name: 'api', hosts: ['.2'] },
    ], warPath: '/a.war', port: 9100 });
    expect(r.errors.some(e => /duplicate class/i.test(e))).toBe(true);
  });

  it('errors when a host appears in two classes', () => {
    const r = validateDeployConfig({ name: 'x', warPath: '/a.war', port: 9100, classes: [
      { name: 'api', hosts: ['.55'] }, { name: 'worker', hosts: ['.55'] },
    ] });
    expect(r.errors.some(e => /\.55.*two classes|host.*\.55/i.test(e))).toBe(true);
  });

  it('errors when a serverMap key is not in the class hosts', () => {
    const r = validateDeployConfig({ name: 'x', warPath: '/a.war', port: 9100, classes: [
      { name: 'api', hosts: ['.55'], haproxy: { hosts: ['lb'], backend: 'b', serverMap: { '.55': 's1', '.99': 's9' } } },
    ] });
    expect(r.errors.some(e => /\.99/.test(e))).toBe(true);
  });

  it('warns when a class host is absent from its serverMap', () => {
    const r = validateDeployConfig({ name: 'x', warPath: '/a.war', port: 9100, classes: [
      { name: 'api', hosts: ['.55', '.56'], haproxy: { hosts: ['lb'], backend: 'b', serverMap: { '.55': 's1' } } },
    ] });
    expect(r.warnings.some(w => /\.56/.test(w))).toBe(true);
  });

  it('errors when a class resolves no warPath', () => {
    const r = validateDeployConfig({ name: 'x', port: 9100, classes: [ { name: 'api', hosts: ['.55'] } ] });
    expect(r.errors.some(e => /warPath/i.test(e))).toBe(true);
  });

  it('warns + does not error on an empty-hosts class', () => {
    const r = validateDeployConfig({ name: 'x', warPath: '/a.war', port: 9100, classes: [
      { name: 'api', hosts: ['.55'] }, { name: 'ai', hosts: [] },
    ] });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some(w => /ai.*no hosts/i.test(w))).toBe(true);
  });

  it('warns (not errors) on a blocking class with empty serverMap', () => {
    const r = validateDeployConfig({ name: 'x', warPath: '/a.war', port: 9100, classes: [
      { name: 'api', hosts: ['.55'], blocking: true, haproxy: { hosts: ['lb'], backend: 'b', serverMap: {} } },
    ] });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some(w => /blocking.*drain|no.*serverMap/i.test(w))).toBe(true);
  });

  it('does not flag a valid flat config', () => {
    const r = validateDeployConfig({ name: 'flat', hosts: ['.1'], warPath: '/a.war', port: 9100, parallel: false });
    expect(r.errors).toEqual([]);
  });
});

const base = (over: Partial<DeployConfig>): DeployConfig =>
  ({ name: 'x', hosts: ['h1'], warPath: '/a.war', ...over }) as DeployConfig;

describe('validateDeployConfig — postMigration', () => {
  it('errors when postMigration is missing roleId', () => {
    const cfg = base({ postMigration: { roleId: '', migrationsDir: 'db/post' } as any });
    const { errors } = validateDeployConfig(cfg);
    expect(errors.some((e) => /postMigration/i.test(e) && /roleId/i.test(e))).toBe(true);
  });

  it('errors when postMigration is missing migrationsDir', () => {
    const cfg = base({ postMigration: { roleId: 'r', migrationsDir: '' } as any });
    const { errors } = validateDeployConfig(cfg);
    expect(errors.some((e) => /postMigration/i.test(e) && /migrationsDir/i.test(e))).toBe(true);
  });

  it('warns when pre and post share the same migrationsDir', () => {
    const cfg = base({
      migration: { roleId: 'r', migrationsDir: 'db/all' },
      postMigration: { roleId: 'r', migrationsDir: 'db/all' },
    });
    const { warnings } = validateDeployConfig(cfg);
    expect(warnings.some((w) => /same.*migrationsDir|same dir/i.test(w))).toBe(true);
  });

  it('accepts a well-formed postMigration with a distinct dir', () => {
    const cfg = base({
      migration: { roleId: 'r', migrationsDir: 'db/pre' },
      postMigration: { roleId: 'r', migrationsDir: 'db/post' },
    });
    const { errors } = validateDeployConfig(cfg);
    expect(errors).toHaveLength(0);
  });
});

describe('validateDeployConfig — migration.scaffoldingFile', () => {
  it('errors when scaffoldingFile contains a path separator', () => {
    const cfg = base({
      migration: { roleId: 'r', migrationsDir: 'db/pre', scaffoldingFile: 'utils/helpers.sql' },
    });
    const { errors } = validateDeployConfig(cfg);
    expect(errors.some((e) => /scaffoldingFile/i.test(e))).toBe(true);
  });

  it('errors when scaffoldingFile is empty', () => {
    const cfg = base({
      migration: { roleId: 'r', migrationsDir: 'db/pre', scaffoldingFile: '' },
    });
    const { errors } = validateDeployConfig(cfg);
    expect(errors.some((e) => /scaffoldingFile/i.test(e))).toBe(true);
  });

  it('does not error on a valid bare scaffoldingFile', () => {
    const cfg = base({
      migration: { roleId: 'r', migrationsDir: 'db/pre', scaffoldingFile: 'migration_utils.sql' },
    });
    const { errors } = validateDeployConfig(cfg);
    expect(errors.some((e) => /scaffoldingFile/i.test(e))).toBe(false);
  });

  it('accepts an absolute scaffoldingFile path', () => {
    const cfg = base({
      migration: { roleId: 'r', migrationsDir: 'db/pre', scaffoldingFile: '/repo/docs/migrations/0000_migration-helpers.sql' },
    });
    const { errors } = validateDeployConfig(cfg);
    expect(errors.some((e) => /scaffoldingFile/i.test(e))).toBe(false);
  });

  it('still rejects a RELATIVE scaffoldingFile containing a path separator', () => {
    const cfg = base({
      migration: { roleId: 'r', migrationsDir: 'db/pre', scaffoldingFile: 'sub/helpers.sql' },
    });
    const { errors } = validateDeployConfig(cfg);
    expect(errors.some((e) => /scaffoldingFile/i.test(e))).toBe(true);
  });

  it('still rejects an empty scaffoldingFile', () => {
    const cfg = base({
      migration: { roleId: 'r', migrationsDir: 'db/pre', scaffoldingFile: '' },
    });
    const { errors } = validateDeployConfig(cfg);
    expect(errors.some((e) => /scaffoldingFile/i.test(e))).toBe(true);
  });
});

describe('rootDir validation', () => {
  const mk = (over: Record<string, unknown>): any => ({ name: 'c', warPath: '/abs/app.war', ...over });

  // rootDir itself: relative rootDir is a hard ERROR (nothing to anchor to).
  it('rootDir that is relative → error', () => {
    const r = validateDeployConfig(mk({ rootDir: 'rel/root' }));
    expect(r.errors.some((e) => /rootDir must be an absolute path/.test(e))).toBe(true);
  });

  it('rootDir with leading ~ is accepted (expands to absolute)', () => {
    const r = validateDeployConfig(mk({ rootDir: '~/Drive/x' }));
    expect(r.errors.some((e) => /rootDir must be an absolute path/.test(e))).toBe(false);
  });

  // Relative local field WITHOUT rootDir is a WARNING, not an error
  // (backward-compat: today these resolve against cwd and are accepted).
  it('relative warPath with NO rootDir → WARNING (not error)', () => {
    const r = validateDeployConfig(mk({ warPath: 'war/app.war' }));
    expect(r.errors.some((e) => /warPath is a relative path/.test(e))).toBe(false);
    expect(r.warnings.some((w) => /warPath is a relative path.*no rootDir/.test(w))).toBe(true);
  });

  it('relative warPath WITH rootDir → no warning', () => {
    const r = validateDeployConfig(mk({ rootDir: '/root', warPath: 'war/app.war' }));
    expect(r.warnings.some((w) => /warPath is a relative path/.test(w))).toBe(false);
  });

  it('relative migration.migrationsDir with NO rootDir → WARNING (not error)', () => {
    const r = validateDeployConfig(mk({
      migration: { roleId: 'r', migrationsDir: 'docs/pre' },
    }));
    expect(r.errors.some((e) => /migrationsDir is a relative path/.test(e))).toBe(false);
    expect(r.warnings.some((w) => /migration\.migrationsDir is a relative path.*no rootDir/.test(w))).toBe(true);
  });

  it('rootDir set: relative scaffoldingFile WITH separators is VALID (supersedes the old rule)', () => {
    const r = validateDeployConfig(mk({
      rootDir: '/root',
      migration: { roleId: 'r', migrationsDir: 'docs/pre', scaffoldingFile: 'docs/0000.sql' },
    }));
    expect(r.errors.some((e) => /scaffoldingFile must be a bare filename/.test(e))).toBe(false);
  });

  it('no rootDir: relative scaffoldingFile WITH separators still rejected (existing rule)', () => {
    const r = validateDeployConfig(mk({
      migration: { roleId: 'r', migrationsDir: '/abs/pre', scaffoldingFile: 'sub/0000.sql' },
    }));
    expect(r.errors.some((e) => /scaffoldingFile must be a bare filename/.test(e))).toBe(true);
  });

  it('existing all-absolute config with no rootDir stays valid (no errors)', () => {
    const r = validateDeployConfig(mk({
      migration: { roleId: 'r', migrationsDir: '/abs/pre', scaffoldingFile: '/abs/0000.sql' },
    }));
    expect(r.errors.length).toBe(0);
  });

  it('BACKWARD-COMPAT: existing relative-migrationsDir fixture (docs/migrations, no root) still has NO errors', () => {
    // This is the shape of 58+ existing fixtures — must not become an error.
    const r = validateDeployConfig(mk({
      migration: { roleId: 'zincdb-rw', migrationsDir: 'docs/migrations' },
    }));
    expect(r.errors.length).toBe(0); // warning is allowed; error is not
  });
});
