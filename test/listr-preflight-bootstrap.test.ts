import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkHostReachable: vi.fn(),
  checkPluginVersions: vi.fn(),
  triggerPluginUpdate: vi.fn(),
  agentGet: vi.fn(),
  analyzeHost: vi.fn(),
}));

vi.mock('@zincapp/znvault-deploy-core', async importActual => {
  const actual = await importActual<typeof import('@zincapp/znvault-deploy-core')>();
  return {
    ...actual,
    checkHostReachable: mocks.checkHostReachable,
    checkPluginVersions: mocks.checkPluginVersions,
    triggerPluginUpdate: mocks.triggerPluginUpdate,
    agentGet: mocks.agentGet,
  };
});

vi.mock('../src/cli/commands/deploy.js', async importActual => {
  const actual = await importActual<typeof import('../src/cli/commands/deploy.js')>();
  return { ...actual, analyzeHost: mocks.analyzeHost };
});

import {
  assertHostControlPlaneCompatible,
  executePluginUpdates,
  executePreflightChecks,
  PAYARA_PLUGIN_PACKAGE,
} from '../src/cli/listr-preflight.js';

const HOST = 'agent-bootstrap.example.test';
const COMPATIBLE_HOST = 'agent-compatible.example.test';
const TOKEN = 'bootstrap-control-token-0123456789abcdef';
const CURRENT = '2.7.2';
const TARGET = '3.0.0';

function versionReceipt(current = CURRENT, latest = TARGET, updateAvailable = true) {
  return {
    success: true,
    response: {
      hasUpdates: updateAvailable,
      versions: [{
        package: PAYARA_PLUGIN_PACKAGE,
        current,
        latest,
        updateAvailable,
        channel: 'dr-m4',
        targetVersion: latest,
        updaterReady: true,
      }],
      timestamp: new Date(0).toISOString(),
    },
  };
}

function options() {
  return {
    hosts: [HOST],
    port: 9100,
    localHashes: { 'WEB-INF/web.xml': 'a'.repeat(64) },
    force: false,
    isPlain: true,
    useTLS: false,
    mutationAuthTokens: new Map([[HOST, TOKEN]]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkHostReachable.mockResolvedValue({
    host: HOST,
    reachable: true,
    agentVersion: '2.0.0',
    pluginVersion: CURRENT,
    pluginRunning: true,
  });
  mocks.checkPluginVersions.mockResolvedValue(versionReceipt());
  mocks.agentGet.mockResolvedValue({ pluginVersion: TARGET });
  mocks.analyzeHost.mockResolvedValue({
    host: HOST,
    success: true,
    filesChanged: 1,
    filesDeleted: 0,
    bytesToUpload: 1,
    isFullUpload: false,
  });
  mocks.triggerPluginUpdate.mockImplementation(async (
    _host: string,
    _port: number,
    _useTLS: boolean,
    _namespace: string,
    request: {
      requestId: string;
      package: string;
      expectedCurrentVersion: string;
      expectedVersion: string;
    }
  ) => ({
    success: true,
    response: {
      requestId: request.requestId,
      updated: 1,
      willRestart: true,
      message: 'updated',
      timestamp: new Date(0).toISOString(),
      results: [{
        package: request.package,
        previousVersion: request.expectedCurrentVersion,
        newVersion: request.expectedVersion,
        success: true,
      }],
    },
  }));
});

describe('Payara 2 -> 3 control-plane bootstrap', () => {
  it('rejects Plugin 2 on migration-only/standalone gates without calling its routes', async () => {
    await expect(assertHostControlPlaneCompatible(
      HOST,
      9100,
      false,
      TOKEN
    )).rejects.toThrow('CONTROL_PLANE_VERSION_INCOMPATIBLE');

    expect(mocks.agentGet).not.toHaveBeenCalled();
    expect(mocks.checkPluginVersions).not.toHaveBeenCalled();
    expect(mocks.analyzeHost).not.toHaveBeenCalled();
  });

  it('requires exact authenticated updater metadata on standalone Plugin 3 gates', async () => {
    mocks.checkHostReachable.mockResolvedValueOnce({
      host: HOST,
      reachable: true,
      agentVersion: '2.0.0',
      pluginVersion: TARGET,
      pluginRunning: true,
    });
    const receipt = versionReceipt(TARGET, TARGET, false);
    receipt.response.versions[0]!.updaterReady = false;
    mocks.checkPluginVersions.mockResolvedValueOnce(receipt);

    await expect(assertHostControlPlaneCompatible(
      HOST,
      9100,
      false,
      TOKEN
    )).rejects.toThrow('CONTROL_PLANE_UPDATE_UPDATER_RAIL_INVALID');

    expect(mocks.checkPluginVersions).toHaveBeenCalledWith(
      HOST,
      9100,
      false,
      'payara',
      { bearerToken: TOKEN }
    );
    expect(mocks.agentGet).toHaveBeenCalledOnce();
    expect(mocks.analyzeHost).not.toHaveBeenCalled();
  });

  it('accepts standalone Plugin 3 only after metadata and loaded status agree exactly', async () => {
    mocks.checkHostReachable.mockResolvedValueOnce({
      host: HOST,
      reachable: true,
      agentVersion: '2.0.0',
      pluginVersion: TARGET,
      pluginRunning: true,
    });
    mocks.checkPluginVersions.mockResolvedValueOnce(
      versionReceipt(TARGET, TARGET, false)
    );

    await expect(assertHostControlPlaneCompatible(
      HOST,
      9100,
      false,
      TOKEN
    )).resolves.toMatchObject({
      agentVersion: '2.0.0',
      pluginVersion: TARGET,
    });

    expect(mocks.checkPluginVersions.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.agentGet.mock.invocationCallOrder[0]!);
    expect(mocks.analyzeHost).not.toHaveBeenCalled();
  });

  it('updates an exact Plugin 2 receipt before any Plugin 3 status or WAR analysis', async () => {
    const initial = await executePreflightChecks(options());

    expect(initial.bootstrapUpdateHosts).toEqual([HOST]);
    expect(initial.updateTargets).toHaveLength(1);
    expect(initial.analysisMap.size).toBe(0);
    expect(mocks.agentGet).not.toHaveBeenCalled();
    expect(mocks.analyzeHost).not.toHaveBeenCalled();

    await executePluginUpdates(
      initial.updateTargets,
      9100,
      true,
      false,
      new Map([[HOST, TOKEN]])
    );
    expect(mocks.triggerPluginUpdate).toHaveBeenCalledOnce();
    const request = mocks.triggerPluginUpdate.mock.calls[0]?.[4];
    expect(request).toMatchObject({
      package: PAYARA_PLUGIN_PACKAGE,
      expectedCurrentVersion: CURRENT,
      expectedVersion: TARGET,
    });
    expect(request.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );

    mocks.checkHostReachable.mockResolvedValue({
      host: HOST,
      reachable: true,
      agentVersion: '2.0.0',
      pluginVersion: TARGET,
      pluginRunning: true,
    });
    mocks.checkPluginVersions.mockResolvedValue(
      versionReceipt(TARGET, TARGET, false)
    );
    const refreshed = await executePreflightChecks(options());

    expect(refreshed.bootstrapUpdateHosts).toEqual([]);
    expect(refreshed.analysisMap.get(HOST)?.success).toBe(true);
    expect(mocks.agentGet).toHaveBeenCalledOnce();
    expect(mocks.analyzeHost).toHaveBeenCalledOnce();
    expect(
      mocks.triggerPluginUpdate.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.analyzeHost.mock.invocationCallOrder[0]!);
  });

  it.each([
    ['metadata current mismatch', versionReceipt('2.7.1', TARGET, true), 'CURRENT_MISMATCH'],
    ['target is not Plugin 3', versionReceipt(CURRENT, '2.9.0', true), 'TARGET_INVALID'],
    ['target is not offered', versionReceipt(CURRENT, TARGET, false), 'TARGET_INVALID'],
  ])('fails closed when Plugin 2 lacks an exact target: %s', async (
    _label,
    receipt,
    code
  ) => {
    mocks.checkPluginVersions.mockResolvedValueOnce(receipt);

    await expect(executePreflightChecks(options())).rejects.toThrow(code);

    expect(mocks.triggerPluginUpdate).not.toHaveBeenCalled();
    expect(mocks.agentGet).not.toHaveBeenCalled();
    expect(mocks.analyzeHost).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong release channel', { channel: 'latest' }],
    ['updater not ready', { updaterReady: false }],
    ['target receipt drift', { targetVersion: '3.0.1' }],
  ])('rejects Plugin 2 without an exact dr-m4 updater rail: %s', async (
    _label,
    override
  ) => {
    const receipt = versionReceipt();
    Object.assign(receipt.response.versions[0]!, override);
    mocks.checkPluginVersions.mockResolvedValueOnce(receipt);

    await expect(executePreflightChecks(options())).rejects.toThrow(
      'CONTROL_PLANE_BOOTSTRAP_UPDATER_RAIL_INVALID'
    );

    expect(mocks.triggerPluginUpdate).not.toHaveBeenCalled();
    expect(mocks.agentGet).not.toHaveBeenCalled();
    expect(mocks.analyzeHost).not.toHaveBeenCalled();
  });

  it('requires exact authenticated updater metadata on an already-compatible Plugin 3 host', async () => {
    mocks.checkHostReachable.mockResolvedValueOnce({
      host: HOST,
      reachable: true,
      agentVersion: '2.0.0',
      pluginVersion: TARGET,
      pluginRunning: true,
    });
    const receipt = versionReceipt(TARGET, TARGET, false);
    receipt.response.versions[0]!.channel = 'latest';
    mocks.checkPluginVersions.mockResolvedValueOnce(receipt);

    await expect(executePreflightChecks(options())).rejects.toThrow(
      'CONTROL_PLANE_UPDATE_UPDATER_RAIL_INVALID'
    );

    expect(mocks.agentGet).toHaveBeenCalledOnce();
    expect(mocks.analyzeHost).not.toHaveBeenCalled();
  });

  it('analyzes only Plugin 3 members during a mixed Plugin 2/3 initial preflight', async () => {
    mocks.checkHostReachable.mockImplementation(async (host: string) => ({
      host,
      reachable: true,
      agentVersion: '2.0.0',
      pluginVersion: host === HOST ? CURRENT : TARGET,
      pluginRunning: true,
    }));
    mocks.checkPluginVersions.mockImplementation(async (host: string) =>
      host === HOST
        ? versionReceipt()
        : versionReceipt(TARGET, TARGET, false)
    );
    mocks.agentGet.mockResolvedValue({ pluginVersion: TARGET });

    const mixed = await executePreflightChecks({
      ...options(),
      hosts: [HOST, COMPATIBLE_HOST],
      mutationAuthTokens: new Map([
        [HOST, TOKEN],
        [COMPATIBLE_HOST, TOKEN],
      ]),
    });

    expect(mixed.bootstrapUpdateHosts).toEqual([HOST]);
    expect(mixed.analysisMap.has(HOST)).toBe(false);
    expect(mixed.analysisMap.get(COMPATIBLE_HOST)?.success).toBe(true);
    expect(mocks.agentGet).toHaveBeenCalledOnce();
    expect(mocks.analyzeHost).toHaveBeenCalledOnce();
    expect(mocks.analyzeHost.mock.calls[0]?.[0]).toBe(COMPATIBLE_HOST);
  });

  it('rejects an update receipt that is not bound to the generated request ID', async () => {
    const initial = await executePreflightChecks(options());
    mocks.triggerPluginUpdate.mockResolvedValueOnce({
      success: true,
      response: {
        requestId: '00000000-0000-4000-8000-000000000000',
        updated: 1,
        willRestart: true,
        results: [{
          package: PAYARA_PLUGIN_PACKAGE,
          previousVersion: CURRENT,
          newVersion: TARGET,
          success: true,
        }],
      },
    });

    await expect(executePluginUpdates(
      initial.updateTargets,
      9100,
      true,
      false,
      new Map([[HOST, TOKEN]])
    )).rejects.toThrow('Plugin update failed');
  });
});
