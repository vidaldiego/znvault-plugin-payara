import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let TMP: string;
let legacyPath: string;
let newDir: string;
let newPath: string;

// Because vi.mock is hoisted and static, we instead import the store dynamically
// after setting env-derived paths. Simplest robust approach: mock the module with
// getters reading module-level vars.
vi.doMock('../src/cli/constants.js', () => ({
  get CONFIG_DIR() { return TMP; },
  get PAYARA_CONFIG_DIR() { return newDir; },
  get CONFIG_FILE() { return newPath; },
  get LEGACY_CONFIG_FILE() { return legacyPath; },
}));

async function freshStore() {
  vi.resetModules();
  return await import('../src/cli/config-store.js');
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'cfgmig-'));
  legacyPath = join(TMP, 'deploy-configs.json');
  newDir = join(TMP, 'payara');
  newPath = join(newDir, 'configs.json');
});
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

describe('config-store auto-migration', () => {
  it('migrates legacy → new when new is absent and legacy exists (non-destructive)', async () => {
    writeFileSync(legacyPath, JSON.stringify({ configs: { staging: { name: 'staging', hosts: ['h1'] } } }));
    const store = await freshStore();
    const loaded = await store.loadDeployConfigs();
    expect(loaded.configs.staging).toBeDefined();
    expect(existsSync(newPath)).toBe(true);         // new file created
    expect(existsSync(legacyPath)).toBe(true);       // legacy left intact
    expect(JSON.parse(readFileSync(newPath, 'utf-8')).configs.staging.name).toBe('staging');
  });

  it('does NOT re-migrate when the new file already exists', async () => {
    mkdirSync(newDir, { recursive: true });
    writeFileSync(newPath, JSON.stringify({ configs: { fromNew: { name: 'fromNew' } } }));
    writeFileSync(legacyPath, JSON.stringify({ configs: { fromLegacy: { name: 'fromLegacy' } } }));
    const store = await freshStore();
    const loaded = await store.loadDeployConfigs();
    expect(loaded.configs.fromNew).toBeDefined();    // read the new file
    expect(loaded.configs.fromLegacy).toBeUndefined(); // legacy ignored
  });

  it('returns empty store when neither file exists', async () => {
    const store = await freshStore();
    const loaded = await store.loadDeployConfigs();
    expect(loaded).toEqual({ configs: {} });
    expect(existsSync(newPath)).toBe(false);
  });

  it('saveDeployConfigs writes to the new path (creating the payara dir)', async () => {
    const store = await freshStore();
    await store.saveDeployConfigs({ configs: { s: { name: 's' } } as any });
    expect(existsSync(newPath)).toBe(true);
    expect(JSON.parse(readFileSync(newPath, 'utf-8')).configs.s.name).toBe('s');
  });
});
