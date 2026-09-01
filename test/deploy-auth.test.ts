import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import type { CLIPluginContext } from '../src/cli/types.js';
import type { ProgressReporter } from '../src/cli/progress.js';

const mocks = vi.hoisted(() => ({
  agentFetch: vi.fn(),
  agentGet: vi.fn(),
  agentPost: vi.fn(),
  agentPostWithStatus: vi.fn(),
  pollDeploymentStatus: vi.fn(),
  calculateWarHashes: vi.fn(),
}));

vi.mock('@zincapp/znvault-deploy-core', async importActual => {
  const actual = await importActual<typeof import('@zincapp/znvault-deploy-core')>();
  return {
    ...actual,
    agentFetch: mocks.agentFetch,
    agentGet: mocks.agentGet,
    agentPost: mocks.agentPost,
    agentPostWithStatus: mocks.agentPostWithStatus,
    pollDeploymentStatus: mocks.pollDeploymentStatus,
    buildPluginUrl: vi.fn(
      (host: string, port: number) => `http://${host}:${port}/plugins/payara`
    ),
  };
});

vi.mock('../src/war-deployer.js', async importActual => {
  const actual = await importActual<typeof import('../src/war-deployer.js')>();
  return { ...actual, calculateWarHashes: mocks.calculateWarHashes };
});

import {
  analyzeHost,
  deployToHost,
  deployChunked,
  uploadFullWar,
} from '../src/cli/commands/deploy.js';
import {
  calculateWarContentSha256,
  readLocalWarArtifactSnapshot,
} from '../src/war-deployer.js';
import type {
  DeploymentArtifactExpectation,
  LocalWarArtifactSnapshot,
  WarFileHashes,
} from '../src/types.js';

const TOKEN = 'deploy-control-token-0123456789abcdef';
let tempDirectory: string;

function remoteArtifact(hashes: WarFileHashes, sha = 'a'.repeat(64)) {
  return {
    size: 1,
    sha256: sha,
    contentSha256: calculateWarContentSha256(hashes),
  };
}

async function createLocalWar(): Promise<{
  warPath: string;
  snapshot: LocalWarArtifactSnapshot;
  expectation: DeploymentArtifactExpectation;
}> {
  const warPath = join(tempDirectory, 'app.war');
  const zip = new AdmZip();
  zip.addFile('WEB-INF/web.xml', Buffer.from('<web-app/>'));
  zip.writeZip(warPath);
  const snapshot = await readLocalWarArtifactSnapshot(warPath);
  return {
    warPath,
    snapshot,
    expectation: {
      expectedBaseSha256: null,
      targetContentSha256: snapshot.contentSha256,
    },
  };
}

function context(): CLIPluginContext {
  return {
    client: { get: vi.fn(), post: vi.fn() },
    output: {
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      table: vi.fn(),
      keyValue: vi.fn(),
    },
    getConfig: () => ({ url: 'http://127.0.0.1:9100' }),
    isPlainMode: () => true,
  };
}

function progress(): ProgressReporter {
  return {
    uploadingFullWar: vi.fn(),
    uploadBytesProgress: vi.fn(),
    uploadComplete: vi.fn(),
    deploymentTimedOut: vi.fn(),
    deploymentInProgress: vi.fn(),
    clearWaitingLine: vi.fn(),
    deploying: vi.fn(),
    diff: vi.fn(),
    uploadProgress: vi.fn(),
    remoteHasNoWar: vi.fn(),
    hashFetchFailed: vi.fn(),
    isSilent: vi.fn(() => true),
  } as unknown as ProgressReporter;
}

beforeEach(async () => {
  vi.clearAllMocks();
  tempDirectory = await mkdtemp(join(tmpdir(), 'payara-deploy-auth-'));
  mocks.calculateWarHashes.mockResolvedValue({ 'WEB-INF/web.xml': 'abc' });
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('deploy request authorization', () => {
  it('authenticates the protected hashes readback', async () => {
    mocks.agentGet
      .mockResolvedValueOnce({
        healthy: true,
        running: true,
        appDeployed: true,
        bootDeployment: { phase: 'ready', mutationOutcomeUnknown: false },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        hashes: { 'WEB-INF/web.xml': 'abc' },
        artifact: remoteArtifact({ 'WEB-INF/web.xml': 'abc' }),
      });

    const result = await analyzeHost(
      '127.0.0.1',
      9100,
      { 'WEB-INF/web.xml': 'abc' },
      false,
      TOKEN
    );

    expect(result.success).toBe(true);
    expect(mocks.agentGet).toHaveBeenCalledWith(
      'http://127.0.0.1:9100/plugins/payara/hashes',
      undefined,
      { bearerToken: TOKEN }
    );
  });

  it('forces repair when the authenticated runtime has no deployed application', async () => {
    mocks.agentGet.mockResolvedValueOnce({
      healthy: false,
      running: true,
      appDeployed: false,
      bootDeployment: { phase: 'ready', mutationOutcomeUnknown: false },
    });

    const result = await analyzeHost(
      '127.0.0.1',
      9100,
      { 'WEB-INF/web.xml': 'abc' },
      false,
      TOKEN
    );

    expect(result).toMatchObject({
      success: true,
      isFullUpload: true,
      filesChanged: 1,
    });
    expect(mocks.agentGet).toHaveBeenCalledOnce();
    expect(mocks.agentGet.mock.calls[0]?.[0]).toContain('/status');
  });

  it('uses agentFetch for binary upload without constructing Authorization itself', async () => {
    const { warPath, snapshot, expectation } = await createLocalWar();
    mocks.agentFetch.mockImplementation(async (_url, init: RequestInit) => {
      const deploymentId = new Headers(init.headers).get('x-znvault-deployment-id');
      return new Response(JSON.stringify({
        status: 'deployed',
        deployed: true,
        deploymentId,
        message: 'ok',
        appName: 'ZincAPI',
        artifact: snapshot,
        targetContentSha256: snapshot.contentSha256,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await uploadFullWar(
      context(),
      'http://127.0.0.1:9100/plugins/payara',
      warPath,
      progress(),
      TOKEN,
      expectation,
      snapshot
    );

    expect(result.success).toBe(true);
    expect(mocks.agentFetch).toHaveBeenCalledOnce();
    const [url, init, auth] = mocks.agentFetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:9100/plugins/payara/deploy/upload');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(new Headers(init.headers).get('x-znvault-deployment-id')).toMatch(
      /^[0-9a-f-]{36}$/
    );
    expect(new Headers(init.headers).get('x-znvault-expected-base-sha256')).toBe('none');
    expect(new Headers(init.headers).get('x-znvault-target-content-sha256')).toBe(
      snapshot.contentSha256
    );
    expect(auth).toEqual({ bearerToken: TOKEN });
  });

  it('authenticates the committing chunk request', async () => {
    const zip = new AdmZip();
    zip.addFile('WEB-INF/web.xml', Buffer.from('<web-app/>'));
    const hashes = {
      'WEB-INF/web.xml': await (async () => {
        const tempWar = join(tempDirectory, 'chunk.war');
        zip.writeZip(tempWar);
        return (await readLocalWarArtifactSnapshot(tempWar)).hashes['WEB-INF/web.xml']!;
      })(),
    };
    const targetContentSha256 = calculateWarContentSha256(hashes);
    const expectation = {
      expectedBaseSha256: 'b'.repeat(64),
      targetContentSha256,
    };
    mocks.agentPostWithStatus.mockImplementation(
      async (_url, body: { deploymentId: string }) => ({
        ok: true,
        data: {
          deploymentId: body.deploymentId,
          sessionId: 'session-1',
          filesReceived: 1,
          committed: true,
          result: {
            success: true,
            filesChanged: 1,
            filesDeleted: 0,
            message: 'ok',
            deploymentTime: 1,
            appName: 'ZincAPI',
            deployed: true,
            artifact: {
              size: 1,
              sha256: 'c'.repeat(64),
              contentSha256: targetContentSha256,
            },
            targetContentSha256,
          },
        },
      })
    );

    const result = await deployChunked(
      context(),
      'http://127.0.0.1:9100/plugins/payara',
      zip,
      ['WEB-INF/web.xml'],
      [],
      progress(),
      TOKEN,
      expectation
    );

    expect(result.success).toBe(true);
    expect(mocks.agentPostWithStatus).toHaveBeenCalledWith(
      'http://127.0.0.1:9100/plugins/payara/deploy/chunk',
      expect.objectContaining({ commit: true, artifact: expectation }),
      undefined,
      { bearerToken: TOKEN },
      expect.any(String)
    );
    const chunkCall = mocks.agentPostWithStatus.mock.calls[0]!;
    expect(chunkCall[1].deploymentId).toBe(chunkCall[4]);
  });

  it('fails a binary-upload 409 owned by another deployment without polling', async () => {
    const { warPath, snapshot, expectation } = await createLocalWar();
    mocks.agentFetch.mockResolvedValue(new Response(JSON.stringify({
      error: 'Deployment in progress',
      deploymentId: 'different-operation-0001',
    }), { status: 409 }));

    const result = await uploadFullWar(
      context(),
      'http://127.0.0.1:9100/plugins/payara',
      warPath,
      progress(),
      TOKEN,
      expectation,
      snapshot
    );

    expect(result).toEqual({
      success: false,
      error: 'Another deployment is already in progress',
    });
    expect(mocks.pollDeploymentStatus).not.toHaveBeenCalled();
  });

  it('reconciles a timed-out upload success using the exact header identity', async () => {
    const { warPath, snapshot, expectation } = await createLocalWar();
    let submittedDeploymentId: string | null = null;
    mocks.agentFetch.mockImplementation(async (_url, init: RequestInit) => {
      submittedDeploymentId = new Headers(init.headers).get('x-znvault-deployment-id');
      throw new Error('request aborted by timeout');
    });
    mocks.pollDeploymentStatus.mockResolvedValue({
      success: true,
      result: {
        success: true,
        filesChanged: 1,
        filesDeleted: 0,
        message: 'exact completion',
        deploymentTime: 1,
        appName: 'ZincAPI',
        deployed: true,
        artifact: snapshot,
        targetContentSha256: snapshot.contentSha256,
      },
    });

    const result = await uploadFullWar(
      context(),
      'http://127.0.0.1:9100/plugins/payara',
      warPath,
      progress(),
      TOKEN,
      expectation,
      snapshot
    );

    expect(result.success).toBe(true);
    expect(submittedDeploymentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.pollDeploymentStatus.mock.calls[0]?.[1]).toBe(submittedDeploymentId);
  });

  it('rejects a binary upload receipt whose persisted raw WAR differs from the snapshot', async () => {
    const { warPath, snapshot, expectation } = await createLocalWar();
    mocks.agentFetch.mockImplementation(async (_url, init: RequestInit) => {
      const deploymentId = new Headers(init.headers).get('x-znvault-deployment-id');
      return new Response(JSON.stringify({
        status: 'deployed',
        deployed: true,
        deploymentId,
        message: 'claimed completion',
        appName: 'ZincAPI',
        artifact: {
          size: snapshot.size,
          sha256: 'd'.repeat(64),
          contentSha256: snapshot.contentSha256,
        },
        targetContentSha256: snapshot.contentSha256,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await uploadFullWar(
      context(),
      'http://127.0.0.1:9100/plugins/payara',
      warPath,
      progress(),
      TOKEN,
      expectation,
      snapshot
    );

    expect(result).toEqual({
      success: false,
      error: 'claimed completion',
    });
  });

  it('rejects a logical deploy receipt that omits the full persisted WAR identity', async () => {
    const zip = new AdmZip();
    zip.addFile('WEB-INF/web.xml', Buffer.from('<web-app/>'));
    const targetContentSha256 = calculateWarContentSha256({
      'WEB-INF/web.xml': createHash('sha256').update('<web-app/>').digest('hex'),
    });
    mocks.agentPostWithStatus.mockImplementation(
      async (_url, body: { deploymentId: string }) => ({
        ok: true,
        data: {
          deploymentId: body.deploymentId,
          sessionId: 'session-incomplete-receipt',
          filesReceived: 1,
          committed: true,
          result: {
            success: true,
            deployed: true,
            artifact: { contentSha256: targetContentSha256 },
            targetContentSha256,
          },
        },
      })
    );

    const result = await deployChunked(
      context(),
      'http://127.0.0.1:9100/plugins/payara',
      zip,
      ['WEB-INF/web.xml'],
      [],
      progress(),
      TOKEN,
      { expectedBaseSha256: 'b'.repeat(64), targetContentSha256 }
    );

    expect(result).toEqual({
      success: false,
      error: 'Chunked deployment did not complete',
    });
  });

  it('returns the exact timed-out operation failure without accepting runtime health', async () => {
    const { warPath, snapshot, expectation } = await createLocalWar();
    mocks.agentFetch.mockRejectedValue(new Error('request timeout'));
    mocks.pollDeploymentStatus.mockResolvedValue({
      success: false,
      error: 'exact deployment failed',
      result: { success: false, deployed: false },
    });

    const result = await uploadFullWar(
      context(),
      'http://127.0.0.1:9100/plugins/payara',
      warPath,
      progress(),
      TOKEN,
      expectation,
      snapshot
    );

    expect(result).toEqual({ success: false, error: 'exact deployment failed' });
    expect(mocks.pollDeploymentStatus).toHaveBeenCalledOnce();
  });

  it('redeploys and verifies an empty diff instead of emitting a no-op receipt', async () => {
    const { warPath, snapshot } = await createLocalWar();
    mocks.agentGet
      .mockResolvedValueOnce({
        healthy: true,
        running: true,
        appDeployed: true,
        bootDeployment: { phase: 'ready', mutationOutcomeUnknown: false },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        hashes: snapshot.hashes,
        artifact: {
          ...remoteArtifact(snapshot.hashes),
          contentSha256: snapshot.contentSha256,
        },
      });
    mocks.agentPostWithStatus.mockImplementation(
      async (_url, body: { deploymentId: string }) => ({
        ok: true,
        data: {
          status: 'deployed',
          deploymentId: body.deploymentId,
          success: true,
          filesChanged: 0,
          filesDeleted: 0,
          deployed: true,
          applications: ['ZincAPI'],
          appName: 'ZincAPI',
          artifact: snapshot,
          targetContentSha256: snapshot.contentSha256,
        },
      })
    );

    const result = await deployToHost(
      context(),
      '127.0.0.1',
      9100,
      warPath,
      snapshot.hashes,
      false,
      progress(),
      TOKEN,
      false,
      snapshot
    );

    expect(result.success).toBe(true);
    expect(mocks.agentPostWithStatus).toHaveBeenCalledWith(
      'http://127.0.0.1:9100/plugins/payara/deploy',
      expect.objectContaining({
        deploymentId: expect.any(String),
        artifact: {
          expectedBaseSha256: 'a'.repeat(64),
          targetContentSha256: snapshot.contentSha256,
        },
        files: [],
        deletions: [],
      }),
      undefined,
      { bearerToken: TOKEN },
      expect.any(String)
    );
    const deployCall = mocks.agentPostWithStatus.mock.calls[0]!;
    expect(deployCall[1].deploymentId).toBe(deployCall[4]);
  });

  it('deploys the immutable preflight snapshot when the source WAR changes later', async () => {
    const { warPath, snapshot } = await createLocalWar();
    const replacement = new AdmZip();
    replacement.addFile('WEB-INF/web.xml', Buffer.from('<changed-after-preflight/>'));
    replacement.writeZip(warPath);

    mocks.agentGet.mockResolvedValueOnce({
      status: 'no_war',
      hashes: {},
      artifact: null,
    });
    let uploaded: Buffer | undefined;
    mocks.agentFetch.mockImplementation(async (_url, init: RequestInit) => {
      uploaded = Buffer.from(init.body as Buffer);
      const deploymentId = new Headers(init.headers).get('x-znvault-deployment-id');
      return new Response(JSON.stringify({
        status: 'deployed',
        deployed: true,
        deploymentId,
        message: 'ok',
        appName: 'ZincAPI',
        artifact: {
          size: snapshot.size,
          sha256: snapshot.sha256,
          contentSha256: snapshot.contentSha256,
        },
        targetContentSha256: snapshot.contentSha256,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await deployToHost(
      context(),
      '127.0.0.1',
      9100,
      warPath,
      snapshot.hashes,
      true,
      progress(),
      TOKEN,
      false,
      snapshot
    );

    expect(result.success).toBe(true);
    expect(uploaded).toEqual(snapshot.getBytes());
    expect(uploaded).not.toEqual(replacement.toBuffer());
  });
});
