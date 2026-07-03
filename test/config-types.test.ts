import { describe, it, expect } from 'vitest';
import type { MigrationConfig } from '../src/cli/types.js';

// NOTE: tsconfig.json excludes `test/**` from `tsc --noEmit`, so these are
// runtime shape checks only — they do NOT fail if `scaffoldingFile` is removed
// from `MigrationConfig` (TS types erase at runtime; an extra object-literal
// property isn't a runtime error). The actual regression guard against removal
// is the `_AssertMigrationConfigHasScaffoldingFile` type assertion in
// `src/cli/types.ts`, which IS covered by `npm run typecheck`.
describe('MigrationConfig.scaffoldingFile', () => {
  it('accepts a scaffoldingFile filename alongside the required fields', () => {
    const cfg: MigrationConfig = {
      roleId: 'dbr_x',
      migrationsDir: '/repo/docs/migrations',
      scaffoldingFile: 'migration_utils.sql',
    };
    expect(cfg.scaffoldingFile).toBe('migration_utils.sql');
  });

  it('is optional (omittable)', () => {
    const cfg: MigrationConfig = { roleId: 'dbr_x', migrationsDir: '/repo/docs/migrations' };
    expect(cfg.scaffoldingFile).toBeUndefined();
  });
});
