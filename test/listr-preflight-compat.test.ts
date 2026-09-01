import { describe, expect, it } from 'vitest';
import { assertSupportedControlPlaneVersions } from '../src/cli/listr-preflight.js';

describe('control-plane compatibility gate', () => {
  it.each([
    ['2.0.0', '3.0.0'],
    ['v2.9.4', 'v3.7.1'],
    ['2.1.0-rc.1', '3.0.0-dr.4'],
  ])('accepts the coordinated Agent 2 / Payara 3 pair (%s, %s)', (
    agentVersion,
    pluginVersion
  ) => {
    expect(() => assertSupportedControlPlaneVersions(
      'agent.example.test',
      agentVersion,
      pluginVersion
    )).not.toThrow();
  });

  it.each([
    ['1.24.0', '3.0.0', 'Agent'],
    ['3.0.0', '3.0.0', 'Agent'],
    ['2.0.0', '2.9.9', 'Payara plugin'],
    ['2.0.0', '4.0.0', 'Payara plugin'],
    [undefined, '3.0.0', 'Agent'],
    ['2.0.0', undefined, 'Payara plugin'],
  ])('rejects an unsupported or unknown runtime (%s, %s)', (
    agentVersion,
    pluginVersion,
    component
  ) => {
    expect(() => assertSupportedControlPlaneVersions(
      'agent.example.test',
      agentVersion,
      pluginVersion
    )).toThrow(
      new RegExp(`CONTROL_PLANE_VERSION_INCOMPATIBLE:.*${component}`, 'u')
    );
  });
});
