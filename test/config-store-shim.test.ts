// Lock-in test for the config-store shim (src/cli/config-store.ts).
//
// The shim delegates the STORAGE mechanics to @zincapp/znvault-deploy-core but
// deliberately preserves payara's ORIGINAL public API — which differs from
// deploy-core's: (1) loadDeployConfigs() returns the WRAPPED { configs: {...} }
// (DeployConfigStore), not a flat Record; (2) getConfig() THROWS on miss, not
// returns undefined. ~54 payara call sites depend on both. This test pins them
// so a future "simplify the shim into a pure delegation" cannot silently break
// payara. See the final-review Minor #1.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the shim's config paths to a temp dir (constants are homedir-derived).
let base: string;
let configDir: string;
let configFile: string;

vi.mock('../src/cli/constants.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/constants.js')>('../src/cli/constants.js');
  return {
    ...actual,
    get PAYARA_CONFIG_DIR() { return configDir; },
    get CONFIG_FILE() { return configFile; },
    get LEGACY_CONFIG_FILE() { return join(base, 'no-legacy.json'); }, // absent → no migration
  };
});

import { loadDeployConfigs, saveDeployConfigs, getConfig, configExists, listConfigNames } from '../src/cli/config-store.js';

describe('config-store shim preserves payara original API', () => {
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'payara-cfgshim-'));
    configDir = join(base, 'payara');
    configFile = join(configDir, 'configs.json');
    await mkdir(configDir, { recursive: true });
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it('loadDeployConfigs() returns the WRAPPED { configs } shape (not a flat Record)', async () => {
    await writeFile(configFile, JSON.stringify({ configs: { staging: { name: 'staging' } } }));
    const store = await loadDeployConfigs();
    // The ~54 call sites read store.configs[name] — this shape is load-bearing.
    expect(store).toHaveProperty('configs');
    expect(store.configs).toHaveProperty('staging');
    expect((store.configs as Record<string, unknown>).staging).toMatchObject({ name: 'staging' });
    // must NOT be the flat Record deploy-core returns:
    expect(store).not.toHaveProperty('staging');
  });

  it('loadDeployConfigs() returns { configs: {} } when no file exists', async () => {
    const store = await loadDeployConfigs();
    expect(store).toEqual({ configs: {} });
  });

  it('getConfig() THROWS on a missing config (payara original behavior, not undefined)', async () => {
    await writeFile(configFile, JSON.stringify({ configs: {} }));
    await expect(getConfig('nope')).rejects.toThrow(/Config 'nope' not found/);
  });

  it('getConfig() returns the config when present', async () => {
    await writeFile(configFile, JSON.stringify({ configs: { prod: { name: 'prod' } } }));
    await expect(getConfig('prod')).resolves.toMatchObject({ name: 'prod' });
  });

  it('save → load round-trips through the wrapped shape', async () => {
    await saveDeployConfigs({ configs: { a: { name: 'a' } } } as never);
    const store = await loadDeployConfigs();
    expect(Object.keys(store.configs)).toEqual(['a']);
    expect(await configExists('a')).toBe(true);
    expect(await listConfigNames()).toEqual(['a']);
  });
});
