// Path: test/deploy-class-resolve.test.ts
import { describe, it, expect } from 'vitest';
import { resolveClass } from '../src/cli/deploy-class.js';
import type { DeployConfig } from '../src/cli/types.js';

const base: DeployConfig = {
  name: 'staging',
  warPath: '/base.war',
  port: 9100,
  tunnel: true,
  healthCheck: { path: '/health' },
  haproxy: { hosts: ['lb'], backend: 'b', serverMap: { '.99': 'base99' } },
  strategy: '1+R',
};

describe('resolveClass', () => {
  it('inherits base fields when the class omits them', () => {
    const r = resolveClass(base, { name: 'api', hosts: ['.55'], haproxy: { hosts: ['lb'], backend: 'b', serverMap: { '.55': 's1' } } });
    expect(r.warPath).toBe('/base.war');
    expect(r.port).toBe(9100);
    expect(r.tunnel).toBe(true);
    expect(r.healthCheck).toEqual({ path: '/health' });
  });

  it('class field wins over base (warPath, strategy)', () => {
    const r = resolveClass(base, { name: 'worker', hosts: ['.58'], warPath: '/worker.war', strategy: 'parallel' });
    expect(r.warPath).toBe('/worker.war');
    expect(r.strategy).toBe('parallel');
  });

  it('haproxy replaces wholesale — base serverMap does NOT bleed through', () => {
    const r = resolveClass(base, { name: 'api', hosts: ['.55'], haproxy: { hosts: ['lb'], backend: 'b', serverMap: { '.55': 's1' } } });
    expect(r.haproxy!.serverMap).toEqual({ '.55': 's1' });
    expect(r.haproxy!.serverMap['.99']).toBeUndefined();
  });

  it('blocking defaults true when resolved haproxy has a non-empty serverMap', () => {
    const r = resolveClass(base, { name: 'api', hosts: ['.55'], haproxy: { hosts: ['lb'], backend: 'b', serverMap: { '.55': 's1' } } });
    expect(r.blocking).toBe(true);
  });

  it('blocking defaults false when the class has no haproxy', () => {
    const r = resolveClass({ ...base, haproxy: undefined }, { name: 'worker', hosts: ['.58'] });
    expect(r.blocking).toBe(false);
  });

  it('blocking defaults false when serverMap is empty (no drain)', () => {
    const r = resolveClass(base, { name: 'x', hosts: ['.1'], haproxy: { hosts: ['lb'], backend: 'b', serverMap: {} } });
    expect(r.blocking).toBe(false);
  });

  it('explicit blocking overrides the default', () => {
    const r = resolveClass(base, { name: 'worker', hosts: ['.58'], blocking: true });
    expect(r.blocking).toBe(true);
  });

  it('quiesce and hostConfigs do NOT inherit from the base', () => {
    const baseWithQuiesce: DeployConfig = { ...base, quiesce: { enabled: true } } as DeployConfig;
    const r = resolveClass(baseWithQuiesce, { name: 'api', hosts: ['.55'] });
    expect(r.quiesce).toBeUndefined();
  });
});
