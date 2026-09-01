import { describe, expect, it } from 'vitest';
import { buildHealthStatus } from '../src/plugin-health.js';
import type {
  BootDeploymentStatus,
  PayaraPluginConfig,
  PayaraStatus,
} from '../src/types.js';

const config: PayaraPluginConfig = {
  payaraHome: '/opt/payara',
  domain: 'production',
  user: 'payara',
  warPath: '/opt/zincapi/ZincAPI.war',
  appName: 'ZincAPI',
};

const runtime: PayaraStatus = {
  domain: 'production',
  running: true,
  healthy: true,
  processCount: 1,
  processPids: [5700],
};

const baseBoot: BootDeploymentStatus = {
  appName: 'ZincAPI',
  bootEpoch: 'epoch-1',
  runtimeFingerprint: 'a'.repeat(64),
  phase: 'ready',
  readiness: 'health-verified',
  owner: 'payara',
  runtimeListed: true,
  mutationOutcomeUnknown: false,
  startupActive: false,
  startedAt: new Date(0).toISOString(),
  startupReceipt: {
    outcome: 'boot-owned-skip',
    deploymentAttempted: false,
    bootEpoch: 'epoch-1',
    runtimeFingerprint: 'a'.repeat(64),
    runtimeListed: true,
    observedAt: '2026-09-01T10:00:00.000Z',
  },
};

const healthyEvaluation = {
  status: 'healthy' as const,
  keySyncValid: true,
  hasDuplicateProcesses: false,
};

describe('plugin health deployment fence', () => {
  it('PH-01: reports UNKNOWN as unhealthy even when the JVM and endpoint are green', () => {
    const result = buildHealthStatus(
      config,
      runtime,
      true,
      {
        ...baseBoot,
        phase: 'startup',
        readiness: 'unverified',
        mutationOutcomeUnknown: true,
      },
      healthyEvaluation
    );
    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('Deployment outcome is unknown');
    expect(result.details?.bootDeployment).toMatchObject({
      bootEpoch: 'epoch-1',
      mutationOutcomeUnknown: true,
    });
  });

  it('PH-02: reports a blocked fence as unhealthy', () => {
    const result = buildHealthStatus(
      config,
      runtime,
      true,
      { ...baseBoot, phase: 'blocked', readiness: 'unverified' },
      healthyEvaluation
    );
    expect(result.status).toBe('unhealthy');
  });

  it('PH-03: an inconclusive startup cannot be promoted above degraded', () => {
    const result = buildHealthStatus(
      config,
      runtime,
      true,
      { ...baseBoot, phase: 'startup', readiness: 'unverified' },
      healthyEvaluation
    );
    expect(result.status).toBe('degraded');
  });

  it('PH-04: a pre-existing critical runtime failure remains unhealthy', () => {
    const result = buildHealthStatus(
      config,
      { ...runtime, running: false, healthy: false },
      false,
      { ...baseBoot, phase: 'startup', readiness: 'unverified' },
      {
        ...healthyEvaluation,
        status: 'unhealthy',
        criticalError: 'Payara is stopped',
      }
    );
    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('Payara is stopped');
  });

  it('PH-05: exposes the exact startup skip receipt in plugin health details', () => {
    const result = buildHealthStatus(
      config,
      runtime,
      true,
      baseBoot,
      healthyEvaluation
    );
    expect(result.details?.bootDeployment?.startupReceipt).toEqual({
      outcome: 'boot-owned-skip',
      deploymentAttempted: false,
      bootEpoch: 'epoch-1',
      runtimeFingerprint: 'a'.repeat(64),
      runtimeListed: true,
      observedAt: '2026-09-01T10:00:00.000Z',
    });
  });
});
