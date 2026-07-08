// Path: test/config-template-roundtrip.test.ts
// Proves export → import round-trips losslessly and portably: a config with an
// absolute rootDir, exported (rootDir stripped) and re-loaded with --with-root
// pointing at that same root, resolves to IDENTICAL absolute paths.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFromFile } from '@zincapp/znvault-deploy-core';
import { resolveConfigPaths } from '@zincapp/znvault-deploy-core';
import type { DeployConfig } from '../src/cli/types.js';

describe('config template round-trip equivalence', () => {
  it('export(strip rootDir) → import(--with-root=same root) resolves identically', () => {
    const ROOT = '/Users/diegovidal/Drive/zincapi-parent';
    const original: DeployConfig = {
      name: 'staging', rootDir: ROOT,
      warPath: 'znapi/build/libs/zincapi-staging.war',
      migration: { roleId: 'r', migrationsDir: 'docs/migrations/pre', scaffoldingFile: 'docs/migrations/0000_migration-helpers.sql' },
      postMigration: { roleId: 'r', migrationsDir: 'docs/migrations/post', scaffoldingFile: 'docs/migrations/0000_migration-helpers.sql' },
    } as unknown as DeployConfig;

    // export: strip rootDir, write to file.
    const exported = { ...original };
    delete exported.rootDir;
    const dir = mkdtempSync(join(tmpdir(), 'roundtrip-'));
    const file = join(dir, 'tmpl.json');
    writeFileSync(file, JSON.stringify(exported, null, 2));

    // import with --with-root pointing at the original root.
    const reimported = loadConfigFromFile(file, ROOT);

    // Both resolve to identical absolute paths.
    const a = resolveConfigPaths(original);
    const b = resolveConfigPaths(reimported);
    expect(b.warPath).toBe(a.warPath);
    expect(b.migration).toEqual(a.migration);
    expect(b.postMigration).toEqual(a.postMigration);
  });
});
