import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveUnderRoot } from '../src/secrets-handler.js';

const ROOT = '/etc/zn-agent/node/';

describe('resolveUnderRoot', () => {
  it('resolves a relative path under the root', () => {
    expect(resolveUnderRoot('node-role', ROOT)).toBe(path.resolve(ROOT, 'node-role'));
  });
  it('accepts an absolute path that is under the root', () => {
    expect(resolveUnderRoot('/etc/zn-agent/node/node-role', ROOT))
      .toBe(path.resolve('/etc/zn-agent/node/node-role'));
  });
  it('rejects a relative path that escapes via ..', () => {
    expect(resolveUnderRoot('../../etc/shadow', ROOT)).toBeNull();
  });
  it('rejects an absolute path outside the root', () => {
    expect(resolveUnderRoot('/etc/shadow', ROOT)).toBeNull();
  });
  it('rejects the root\'s parent', () => {
    expect(resolveUnderRoot('/etc/zn-agent', ROOT)).toBeNull();
  });
});

import { fetchSecrets, DEFAULT_FILE_SOURCE_ROOT } from '../src/secrets-handler.js';

describe('file: secret source (fetchSecrets)', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'znfsrc-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  // Minimal fake ctx — file: branch never calls ctx.getSecret
  const ctx = { getSecret: async () => { throw new Error('not used'); } } as any;
  // Minimal silent logger stub
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;

  it('injects the trimmed file contents', async () => {
    fs.writeFileSync(path.join(root, 'node-role'), '  worker\n');
    const out = await fetchSecrets(ctx, { ZN_SCHEDULER_NODE_MODE: 'file:node-role' }, logger, undefined, undefined, root);
    expect(out.ZN_SCHEDULER_NODE_MODE).toBe('worker');
  });

  it('omits the env var when the file is missing', async () => {
    const out = await fetchSecrets(ctx, { ZN_SCHEDULER_NODE_MODE: 'file:node-role' }, logger, undefined, undefined, root);
    expect('ZN_SCHEDULER_NODE_MODE' in out).toBe(false);
  });

  it('omits the env var when the file is empty (whitespace-only)', async () => {
    fs.writeFileSync(path.join(root, 'node-role'), '   \n');
    const out = await fetchSecrets(ctx, { ZN_SCHEDULER_NODE_MODE: 'file:node-role' }, logger, undefined, undefined, root);
    expect('ZN_SCHEDULER_NODE_MODE' in out).toBe(false);
  });

  it('omits + does not throw when the path is outside the root', async () => {
    const out = await fetchSecrets(ctx, { X: 'file:/etc/shadow' }, logger, undefined, undefined, root);
    expect('X' in out).toBe(false);
  });

  it('defaults the root to /etc/zn-agent/node/ when fileSourceRoot is absent', () => {
    expect(DEFAULT_FILE_SOURCE_ROOT).toBe('/etc/zn-agent/node/');
  });

  it('back-compat: literal/alias unchanged; file:-omitted key absent in same call', async () => {
    // Own ctx for this test: resolves alias by returning { data: { value: 'from-alias' } }
    // which is what extractSecretValue picks up via the 'value' key (no field extraction).
    const aliasCtx = {
      getSecret: async (_ref: string) => ({ data: { value: 'from-alias' } }),
    } as any;

    // ROLE file is intentionally absent from `root` → should be omitted
    const out = await fetchSecrets(
      aliasCtx,
      {
        LIT: 'literal:hello',       // literal: branch
        ROLE: 'file:node-role',     // file: branch — file missing → omit
        DBPW: 'alias:db/prod',      // alias: branch
      },
      logger,
      undefined,
      undefined,
      root,
    );

    expect(out.LIT).toBe('hello');          // literal: unchanged
    expect('ROLE' in out).toBe(false);      // file: omitted (file missing)
    expect(out.DBPW).toBe('from-alias');    // alias: resolved via ctx.getSecret
  });
});
