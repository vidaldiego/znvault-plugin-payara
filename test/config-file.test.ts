import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfigFromFile } from '@zincapp/znvault-deploy-core';

function tmpJson(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cfgfile-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

describe('loadConfigFromFile', () => {
  it('reads a config object from the file', () => {
    const p = tmpJson({ name: 'stg', warPath: 'w.war' });
    const c = loadConfigFromFile(p);
    expect(c.name).toBe('stg');
    expect(c.warPath).toBe('w.war');
  });

  it('--with-root . sets rootDir to cwd-absolute (overriding any file rootDir)', () => {
    const p = tmpJson({ name: 'stg', rootDir: '/old/root', warPath: 'w.war' });
    const c = loadConfigFromFile(p, '.');
    expect(c.rootDir).toBe(resolve('.')); // process.cwd()
  });

  it('--with-root ~/x expands the leading tilde', () => {
    const p = tmpJson({ name: 'stg' });
    const c = loadConfigFromFile(p, '~/base');
    expect(c.rootDir).toBe(join(homedir(), 'base'));
  });

  it('--with-root absolute is used as-is', () => {
    const p = tmpJson({ name: 'stg' });
    const c = loadConfigFromFile(p, '/abs/root');
    expect(c.rootDir).toBe('/abs/root');
  });

  it('no --with-root keeps the file rootDir', () => {
    const p = tmpJson({ name: 'stg', rootDir: '/file/root' });
    expect(loadConfigFromFile(p).rootDir).toBe('/file/root');
  });

  it('no --with-root and no file rootDir leaves rootDir undefined', () => {
    const p = tmpJson({ name: 'stg' });
    expect(loadConfigFromFile(p).rootDir).toBeUndefined();
  });

  it('empty-string --with-root is treated as absent (does not set rootDir)', () => {
    const p = tmpJson({ name: 'stg', rootDir: '/file/root' });
    expect(loadConfigFromFile(p, '').rootDir).toBe('/file/root');
  });

  it('missing file throws a clear error', () => {
    expect(() => loadConfigFromFile('/no/such/file.json')).toThrow(/config file not found/);
  });

  it('invalid JSON throws a clear error', () => {
    const p = tmpJson('{ not json');
    expect(() => loadConfigFromFile(p)).toThrow(/not valid JSON/);
  });

  it('non-object payload throws a clear error', () => {
    const p = tmpJson('[1,2,3]');
    expect(() => loadConfigFromFile(p)).toThrow(/single DeployConfig object/);
  });
});
