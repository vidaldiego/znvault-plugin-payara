import { describe, expect, it } from 'vitest';
import {
  getPayaraUpdate,
  PAYARA_PLUGIN_PACKAGE,
} from '../src/cli/listr-preflight.js';
import type { PluginVersionCheckResult } from '../src/cli/types.js';

function versionResult(
  versions: NonNullable<PluginVersionCheckResult['response']>['versions']
): PluginVersionCheckResult {
  return {
    success: true,
    response: {
      hasUpdates: versions.some(version => version.updateAvailable),
      versions,
      timestamp: new Date(0).toISOString(),
    },
  };
}

describe('Payara update selection', () => {
  it('ignores an unrelated plugin update', () => {
    expect(getPayaraUpdate(versionResult([{
      package: '@scope/unrelated',
      current: '1.0.0',
      latest: '1.0.1',
      updateAvailable: true,
    }]))).toBeUndefined();
  });

  it('selects only the exact Payara package and target version', () => {
    expect(getPayaraUpdate(versionResult([
      {
        package: '@scope/unrelated',
        current: '1.0.0',
        latest: '1.0.1',
        updateAvailable: true,
      },
      {
        package: PAYARA_PLUGIN_PACKAGE,
        current: '3.0.0',
        latest: '3.0.1',
        updateAvailable: true,
      },
    ]))).toMatchObject({
      package: PAYARA_PLUGIN_PACKAGE,
      latest: '3.0.1',
    });
  });

  it('fails closed on duplicate Payara metadata', () => {
    const duplicate = {
      package: PAYARA_PLUGIN_PACKAGE,
      current: '3.0.0',
      latest: '3.0.1',
      updateAvailable: true,
    };
    expect(() => getPayaraUpdate(versionResult([duplicate, duplicate])))
      .toThrow('duplicate Payara');
  });
});
