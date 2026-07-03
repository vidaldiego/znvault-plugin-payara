// Path: test/deploy-config-set-migration.test.ts
// Tests for migration config validation (set-migration T9 wiring).
// The set-migration command action is only reachable via commander, so we test
// the pure validation logic in validateDeployConfig exhaustively here.

import { describe, it, expect } from 'vitest';
import { validateDeployConfig } from '../src/cli/deploy-config-validate.js';
import type { DeployConfig } from '../src/cli/types.js';

// ── Flat config fixtures ──

const flatBase: DeployConfig = {
  name: 'production',
  hosts: ['.55'],
  warPath: '/app.war',
  port: 9100,
};

// ── Validation tests ──

describe('validateDeployConfig — migration config', () => {
  it('passes when no migration config is set (flat)', () => {
    const r = validateDeployConfig(flatBase);
    expect(r.errors).toEqual([]);
  });

  it('errors when migration.roleId is empty (flat)', () => {
    const r = validateDeployConfig({
      ...flatBase,
      migration: { roleId: '', migrationsDir: 'docs/migrations' },
    });
    expect(r.errors.some(e => /migration.*missing roleId|roleId.*migration/i.test(e))).toBe(true);
  });

  it('errors when migration.roleId is whitespace-only (flat)', () => {
    const r = validateDeployConfig({
      ...flatBase,
      migration: { roleId: '   ', migrationsDir: 'docs/migrations' },
    });
    expect(r.errors.some(e => /migration.*missing roleId|roleId.*migration/i.test(e))).toBe(true);
  });

  it('errors when migration.migrationsDir is empty (flat)', () => {
    const r = validateDeployConfig({
      ...flatBase,
      migration: { roleId: 'zincdb-rw', migrationsDir: '' },
    });
    expect(r.errors.some(e => /migration.*missing migrationsDir|migrationsDir.*migration/i.test(e))).toBe(true);
  });

  it('errors when migration.migrationsDir is whitespace-only (flat)', () => {
    const r = validateDeployConfig({
      ...flatBase,
      migration: { roleId: 'zincdb-rw', migrationsDir: '  ' },
    });
    expect(r.errors.some(e => /migration.*missing migrationsDir|migrationsDir.*migration/i.test(e))).toBe(true);
  });

  it('errors on both missing fields simultaneously (flat)', () => {
    const r = validateDeployConfig({
      ...flatBase,
      migration: { roleId: '', migrationsDir: '' },
    });
    expect(r.errors.filter(e => /migration/i.test(e)).length).toBeGreaterThanOrEqual(2);
  });

  it('passes and emits an info line for a valid migration config (flat)', () => {
    const r = validateDeployConfig({
      ...flatBase,
      migration: { roleId: 'zincdb-rw', migrationsDir: 'docs/migrations' },
    });
    expect(r.errors).toEqual([]);
    expect(r.info.some(i => /zincdb-rw/.test(i) && /docs\/migrations/.test(i))).toBe(true);
    expect(r.info.some(i => /Vault dynamic-secrets/i.test(i))).toBe(true);
  });

  it('passes with optional database override in migration config (flat)', () => {
    const r = validateDeployConfig({
      ...flatBase,
      migration: { roleId: 'zincdb-rw', migrationsDir: 'docs/migrations', database: 'zincdb' },
    });
    expect(r.errors).toEqual([]);
    expect(r.info.some(i => /zincdb-rw/.test(i))).toBe(true);
  });

  it('passes and emits an info line for a valid migration config (multi-class)', () => {
    const multiClass: DeployConfig = {
      name: 'staging',
      warPath: '/app.war',
      port: 9100,
      classes: [
        { name: 'api', hosts: ['.55'], strategy: 'sequential' },
        { name: 'worker', hosts: ['.58'], strategy: 'parallel', blocking: false },
      ],
      migration: { roleId: 'zincdb-rw', migrationsDir: 'docs/migrations' },
    };
    const r = validateDeployConfig(multiClass);
    expect(r.errors).toEqual([]);
    expect(r.info.some(i => /zincdb-rw/.test(i) && /docs\/migrations/.test(i))).toBe(true);
  });

  it('errors on missing roleId in a multi-class config', () => {
    const multiClass: DeployConfig = {
      name: 'staging',
      warPath: '/app.war',
      port: 9100,
      classes: [
        { name: 'api', hosts: ['.55'], strategy: 'sequential' },
      ],
      migration: { roleId: '', migrationsDir: 'docs/migrations' },
    };
    const r = validateDeployConfig(multiClass);
    expect(r.errors.some(e => /migration.*missing roleId|roleId.*migration/i.test(e))).toBe(true);
  });
});
