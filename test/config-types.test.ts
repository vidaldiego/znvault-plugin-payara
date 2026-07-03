import { describe, it, expect } from 'vitest';
import type { MigrationConfig } from '../src/cli/types.js';

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
