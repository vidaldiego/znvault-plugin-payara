import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR, PAYARA_CONFIG_DIR, CONFIG_FILE, LEGACY_CONFIG_FILE } from '../src/cli/constants.js';

describe('config path constants', () => {
  it('CONFIG_DIR is ~/.znvault', () => {
    expect(CONFIG_DIR).toBe(join(homedir(), '.znvault'));
  });
  it('PAYARA_CONFIG_DIR is ~/.znvault/payara', () => {
    expect(PAYARA_CONFIG_DIR).toBe(join(homedir(), '.znvault', 'payara'));
  });
  it('CONFIG_FILE is ~/.znvault/payara/configs.json', () => {
    expect(CONFIG_FILE).toBe(join(homedir(), '.znvault', 'payara', 'configs.json'));
  });
  it('LEGACY_CONFIG_FILE is the old ~/.znvault/deploy-configs.json', () => {
    expect(LEGACY_CONFIG_FILE).toBe(join(homedir(), '.znvault', 'deploy-configs.json'));
  });
});
