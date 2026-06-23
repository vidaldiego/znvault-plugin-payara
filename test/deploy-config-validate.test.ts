// Path: test/deploy-config-validate.test.ts
import { describe, it, expect } from 'vitest';
import { validateDeployConfig } from '../src/cli/deploy-config-validate.js';
import type { DeployConfig } from '../src/cli/types.js';

const validMultiClass: DeployConfig = {
  name: 'staging',
  warPath: '/app.war',
  port: 9100,
  classes: [
    { name: 'api', hosts: ['.55', '.56'], strategy: '1+R',
      haproxy: { hosts: ['lb'], backend: 'b', serverMap: { '.55': 's1', '.56': 's2' } } },
    { name: 'worker', hosts: ['.58'], strategy: 'parallel', blocking: false },
  ],
};

describe('validateDeployConfig', () => {
  it('passes a fully valid 2-class config', () => {
    const r = validateDeployConfig(validMultiClass);
    expect(r.errors).toEqual([]);
  });

  it('errors when both hosts and classes are present', () => {
    const r = validateDeployConfig({ ...validMultiClass, hosts: ['.99'] });
    expect(r.errors.some(e => /both .*hosts.* and .*classes/i.test(e))).toBe(true);
  });

  it('errors on an empty classes array', () => {
    const r = validateDeployConfig({ name: 'x', classes: [] });
    expect(r.errors.some(e => /empty classes/i.test(e))).toBe(true);
  });

  it('errors on top-level quiesce in a multi-class config', () => {
    const r = validateDeployConfig({ ...validMultiClass, quiesce: { enabled: true } });
    expect(r.errors.some(e => /quiesce.*per-class/i.test(e))).toBe(true);
  });

  it('errors on a duplicate class name', () => {
    const r = validateDeployConfig({ name: 'x', classes: [
      { name: 'api', hosts: ['.1'] }, { name: 'api', hosts: ['.2'] },
    ], warPath: '/a.war', port: 9100 });
    expect(r.errors.some(e => /duplicate class/i.test(e))).toBe(true);
  });

  it('errors when a host appears in two classes', () => {
    const r = validateDeployConfig({ name: 'x', warPath: '/a.war', port: 9100, classes: [
      { name: 'api', hosts: ['.55'] }, { name: 'worker', hosts: ['.55'] },
    ] });
    expect(r.errors.some(e => /\.55.*two classes|host.*\.55/i.test(e))).toBe(true);
  });

  it('errors when a serverMap key is not in the class hosts', () => {
    const r = validateDeployConfig({ name: 'x', warPath: '/a.war', port: 9100, classes: [
      { name: 'api', hosts: ['.55'], haproxy: { hosts: ['lb'], backend: 'b', serverMap: { '.55': 's1', '.99': 's9' } } },
    ] });
    expect(r.errors.some(e => /\.99/.test(e))).toBe(true);
  });

  it('warns when a class host is absent from its serverMap', () => {
    const r = validateDeployConfig({ name: 'x', warPath: '/a.war', port: 9100, classes: [
      { name: 'api', hosts: ['.55', '.56'], haproxy: { hosts: ['lb'], backend: 'b', serverMap: { '.55': 's1' } } },
    ] });
    expect(r.warnings.some(w => /\.56/.test(w))).toBe(true);
  });

  it('errors when a class resolves no warPath', () => {
    const r = validateDeployConfig({ name: 'x', port: 9100, classes: [ { name: 'api', hosts: ['.55'] } ] });
    expect(r.errors.some(e => /warPath/i.test(e))).toBe(true);
  });

  it('warns + does not error on an empty-hosts class', () => {
    const r = validateDeployConfig({ name: 'x', warPath: '/a.war', port: 9100, classes: [
      { name: 'api', hosts: ['.55'] }, { name: 'ai', hosts: [] },
    ] });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some(w => /ai.*no hosts/i.test(w))).toBe(true);
  });

  it('warns (not errors) on a blocking class with empty serverMap', () => {
    const r = validateDeployConfig({ name: 'x', warPath: '/a.war', port: 9100, classes: [
      { name: 'api', hosts: ['.55'], blocking: true, haproxy: { hosts: ['lb'], backend: 'b', serverMap: {} } },
    ] });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some(w => /blocking.*drain|no.*serverMap/i.test(w))).toBe(true);
  });

  it('does not flag a valid flat config', () => {
    const r = validateDeployConfig({ name: 'flat', hosts: ['.1'], warPath: '/a.war', port: 9100, parallel: false });
    expect(r.errors).toEqual([]);
  });
});
