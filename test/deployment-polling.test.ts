import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { createHash } from 'node:crypto';
import { pollDeploymentStatus } from '@zincapp/znvault-deploy-core';
import { registerRoutes } from '../src/routes.js';
import {
  WarDeployer,
  calculateWarContentSha256,
} from '../src/war-deployer.js';
import type { PayaraManager } from '../src/payara-manager.js';
import type {
  DeploymentArtifactExpectation,
  DeployResult,
} from '../src/types.js';
import {
  cleanupTempDir,
  createTempDir,
  createTestWar,
} from './helpers/war-utils.js';

const AUTH_TOKEN = 'polling-test-payara-token-0123456789abcdef';
const AUTHORIZATION = `Bearer ${AUTH_TOKEN}`;
const logger = pino({ level: 'silent' });

const readyBoot = {
  appName: 'TestApp',
  bootEpoch: 'polling-test-boot',
  phase: 'ready' as const,
  readiness: 'health-verified' as const,
  owner: 'agent' as const,
  runtimeListed: true,
  mutationOutcomeUnknown: false,
  startupActive: false,
  startedAt: '2026-09-01T00:00:00.000Z',
};

function createPayara(): PayaraManager {
  return {
    registerApplication: vi.fn(),
    withMutationLease: vi.fn(
      async (_label: string, operation: () => Promise<unknown>) => operation()
    ),
    reconcileDurableMutationQuarantine: vi.fn(async () => undefined),
    assertArtifactMutationAllowed: vi.fn(async () => readyBoot.bootEpoch),
    assertArtifactMutationEpochCurrent: vi.fn(async () => undefined),
    listApplications: vi.fn(async () => ['TestApp']),
    getStatus: vi.fn(async () => ({
      healthy: true,
      running: true,
      domain: 'domain1',
      processCount: 1,
      processPids: [1234],
    })),
    readBootDeploymentStatus: vi.fn(async () => readyBoot),
    getBootDeploymentStatus: vi.fn(() => readyBoot),
    isMutationInProgress: vi.fn(() => false),
    prepareAggressiveRestart: vi.fn(async () => true),
    aggressiveStop: vi.fn(async () => undefined),
    safeStart: vi.fn(async () => undefined),
    reconcilePostStartDeployment: vi.fn(async () => ({
      outcome: 'agent-deployed' as const,
      bootEpoch: readyBoot.bootEpoch,
      deploymentAttempted: true as const,
      deployed: true,
      applications: ['TestApp'],
    })),
  } as unknown as PayaraManager;
}

function trackingSpies(deployer: WarDeployer): {
  started: ReturnType<typeof vi.fn>;
  completed: ReturnType<typeof vi.fn>;
} {
  const tracker = (deployer as unknown as {
    statusTracker: {
      markStarted(deploymentId: string): void;
      markCompleted(deploymentId: string, result: DeployResult): void;
    };
  }).statusTracker;
  return {
    started: vi.spyOn(tracker, 'markStarted'),
    completed: vi.spyOn(tracker, 'markCompleted'),
  };
}

describe('deployment timeout polling receipts', () => {
  let tempDir: string;
  let payara: PayaraManager;
  let deployer: WarDeployer;
  let app: FastifyInstance;
  let warPath: string;
  let artifactExpectation: DeploymentArtifactExpectation;

  beforeEach(async () => {
    tempDir = createTempDir('deployment-polling');
    warPath = createTestWar({
      path: `${tempDir}/app.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'before' }],
    });
    payara = createPayara();
    deployer = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara,
      logger,
      deploymentLockPath: `${tempDir}/deploy.lock`,
    });
    const base = await deployer.getCurrentArtifactReadback();
    artifactExpectation = {
      expectedBaseSha256: base!.sha256,
      targetContentSha256: calculateWarContentSha256({
        ...base!.hashes,
        'version.txt': createHash('sha256').update('after').digest('hex'),
      }),
    };
    app = Fastify({ logger: false });
    await registerRoutes(app, payara, deployer, logger, AUTH_TOKEN);
    await app.ready();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const rawUrl = input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl);
      const response = await app.inject({
        method: 'GET',
        url: `${url.pathname}${url.search}`,
        headers: { authorization: AUTHORIZATION },
      });
      return new Response(response.rawPayload, {
        status: response.statusCode,
        headers: response.headers as HeadersInit,
      });
    }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await app.close();
    cleanupTempDir(tempDir);
  });

  async function pollAfter(deploymentId: string) {
    return pollDeploymentStatus(
      'http://127.0.0.1:9100',
      deploymentId,
      { waitingForDeployment: vi.fn() },
      100,
      { bearerToken: AUTH_TOKEN }
    );
  }

  it('records one diff success that a timed-out client can reconcile', async () => {
    const tracking = trackingSpies(deployer);
    vi.spyOn(deployer, 'deploy').mockResolvedValue({
      deployed: true,
      applications: ['TestApp'],
    });
    const deploymentId = 'polling-diff-success-0001';

    const result = await deployer.applyChanges(
      [{ path: 'version.txt', content: Buffer.from('after') }],
      [],
      deploymentId
    );
    const polled = await pollAfter(deploymentId);

    expect(result.success).toBe(true);
    expect(polled).toMatchObject({ success: true, result: { success: true } });
    expect(deployer.getDeploymentStatus().lastDeploymentId).toBe(deploymentId);
    expect(tracking.started).toHaveBeenCalledOnce();
    expect(tracking.completed).toHaveBeenCalledOnce();
  });

  it('records one chunk-commit failure that polling returns as failure', async () => {
    const tracking = trackingSpies(deployer);
    vi.spyOn(deployer, 'deploy').mockRejectedValue(new Error('asadmin deploy failed'));
    const deploymentId = '00000000-0000-4000-8000-000000000101';

    await app.inject({
      method: 'POST',
      url: '/deploy/chunk',
      headers: { authorization: AUTHORIZATION },
      payload: {
        deploymentId,
        artifact: artifactExpectation,
        files: [{
          path: 'version.txt',
          content: Buffer.from('after').toString('base64'),
        }],
        deletions: [],
        expectedFiles: 1,
        commit: true,
      },
    });
    const polled = await pollAfter(deploymentId);

    expect(polled).toMatchObject({
      success: false,
      result: {
        success: false,
        message: 'asadmin deploy failed',
      },
    });
    expect(tracking.started).toHaveBeenCalledOnce();
    expect(tracking.completed).toHaveBeenCalledOnce();
  });

  it('records one aggressive diff success without nested completion', async () => {
    const aggressive = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara,
      logger,
      aggressiveMode: true,
      deploymentLockPath: `${tempDir}/aggressive.lock`,
    });
    vi.spyOn(aggressive, 'applyChangesWithoutDeploy').mockResolvedValue();
    const journal = (aggressive as unknown as {
      journal: {
        start(): Promise<void>;
        updateStep(): Promise<void>;
        complete(): Promise<void>;
      };
    }).journal;
    vi.spyOn(journal, 'start').mockResolvedValue();
    vi.spyOn(journal, 'updateStep').mockResolvedValue();
    vi.spyOn(journal, 'complete').mockResolvedValue();
    const tracking = trackingSpies(aggressive);

    const result = await aggressive.applyChangesAuto(
      [{ path: 'version.txt', content: Buffer.from('after') }],
      [],
      'polling-aggressive-success-0001'
    );

    expect(result.success).toBe(true);
    expect(aggressive.getDeploymentStatus().lastResult).toMatchObject({
      success: true,
      aggressiveMode: true,
    });
    expect(tracking.started).toHaveBeenCalledOnce();
    expect(tracking.completed).toHaveBeenCalledOnce();
  });

  it('records one aggressive diff failure for later polling', async () => {
    vi.mocked(payara.prepareAggressiveRestart).mockRejectedValue(
      new Error('aggressive undeploy failed')
    );
    const aggressive = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara,
      logger,
      aggressiveMode: true,
      deploymentLockPath: `${tempDir}/aggressive-failure.lock`,
    });
    vi.spyOn(aggressive, 'applyChangesWithoutDeploy').mockResolvedValue();
    const journal = (aggressive as unknown as {
      journal: {
        start(): Promise<void>;
        updateStep(): Promise<void>;
      };
    }).journal;
    vi.spyOn(journal, 'start').mockResolvedValue();
    vi.spyOn(journal, 'updateStep').mockResolvedValue();
    const tracking = trackingSpies(aggressive);

    const result = await aggressive.applyChangesAuto(
      [],
      [],
      'polling-aggressive-failure-0001'
    );

    expect(result).toMatchObject({
      success: false,
      message: 'aggressive undeploy failed',
      aggressiveMode: true,
    });
    expect(aggressive.getDeploymentStatus().lastResult).toMatchObject({
      success: false,
      message: 'aggressive undeploy failed',
    });
    expect(tracking.started).toHaveBeenCalledOnce();
    expect(tracking.completed).toHaveBeenCalledOnce();
  });

  it('does not publish auto/full/upload terminal receipt before lock cleanup', async () => {
    const tracking = trackingSpies(deployer);
    vi.spyOn(deployer, 'deploy').mockResolvedValue({
      deployed: true,
      applications: ['TestApp'],
    });
    let allowCleanup!: () => void;
    const cleanupGate = new Promise<void>(resolve => {
      allowCleanup = resolve;
    });
    const closeLock = vi.spyOn(
      deployer as unknown as { closeDeploymentLock(error?: unknown): Promise<void> },
      'closeDeploymentLock'
    ).mockImplementation(async () => cleanupGate);
    const deploymentId = 'polling-auto-cleanup-order-0001';

    const pending = deployer.deployAuto(deploymentId);
    await vi.waitFor(() => expect(closeLock).toHaveBeenCalledOnce());

    expect(deployer.getDeploymentStatus()).toMatchObject({
      deploying: true,
      deploymentId,
      lastDeploymentId: undefined,
    });

    allowCleanup();
    await expect(pending).resolves.toMatchObject({ deployed: true });
    expect(deployer.getDeploymentStatus()).toMatchObject({
      deploying: false,
      lastDeploymentId: deploymentId,
      lastResult: { success: true, deployed: true },
    });
    expect(tracking.started).toHaveBeenCalledOnce();
    expect(tracking.completed).toHaveBeenCalledOnce();
  });

  it('returns 409 identity evidence that distinguishes same and other operations', async () => {
    const activeDeploymentId = '00000000-0000-4000-8000-000000000102';
    const otherDeploymentId = '00000000-0000-4000-8000-000000000103';
    const tracker = (deployer as unknown as {
      statusTracker: { markStarted(deploymentId: string): void };
    }).statusTracker;
    tracker.markStarted(activeDeploymentId);
    vi.spyOn(deployer, 'isDeploying').mockReturnValue(true);

    const other = await app.inject({
      method: 'POST',
      url: '/deploy',
      headers: { authorization: AUTHORIZATION },
      payload: {
        deploymentId: otherDeploymentId,
        artifact: artifactExpectation,
        files: [],
        deletions: [],
      },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({
      deploymentId: activeDeploymentId,
      requestedDeploymentId: otherDeploymentId,
      sameOperation: false,
    });

    const same = await app.inject({
      method: 'POST',
      url: '/deploy',
      headers: { authorization: AUTHORIZATION },
      payload: {
        deploymentId: activeDeploymentId,
        artifact: artifactExpectation,
        files: [],
        deletions: [],
      },
    });
    expect(same.statusCode).toBe(409);
    expect(same.json()).toMatchObject({
      deploymentId: activeDeploymentId,
      requestedDeploymentId: activeDeploymentId,
      sameOperation: true,
    });
  });

  it('fails a chunk commit closed when the WAR base changes after session creation', async () => {
    const deploymentId = '00000000-0000-4000-8000-000000000104';
    const first = await app.inject({
      method: 'POST',
      url: '/deploy/chunk',
      headers: { authorization: AUTHORIZATION },
      payload: {
        deploymentId,
        artifact: artifactExpectation,
        files: [{
          path: 'version.txt',
          content: Buffer.from('after').toString('base64'),
        }],
        deletions: [],
        expectedFiles: 1,
        commit: false,
      },
    });
    expect(first.statusCode).toBe(200);
    const sessionId = first.json<{ sessionId: string }>().sessionId;

    createTestWar({
      path: warPath,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'intervening-controller' }],
    });
    const intervening = await deployer.getCurrentArtifactIdentity();

    const committed = await app.inject({
      method: 'POST',
      url: '/deploy/chunk',
      headers: { authorization: AUTHORIZATION },
      payload: {
        deploymentId,
        sessionId,
        artifact: artifactExpectation,
        files: [],
        commit: true,
      },
    });

    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toMatchObject({
      committed: true,
      result: {
        success: false,
        message: expect.stringContaining('ARTIFACT_BASE_DRIFT'),
      },
    });
    expect(await deployer.getCurrentArtifactIdentity()).toEqual(intervening);
  });

  it('rejects cross-operation reuse of a chunk session before commit', async () => {
    const firstDeploymentId = '00000000-0000-4000-8000-000000000105';
    const otherDeploymentId = '00000000-0000-4000-8000-000000000106';
    const first = await app.inject({
      method: 'POST',
      url: '/deploy/chunk',
      headers: { authorization: AUTHORIZATION },
      payload: {
        deploymentId: firstDeploymentId,
        artifact: artifactExpectation,
        files: [],
        deletions: [],
        expectedFiles: 2,
        commit: false,
      },
    });
    expect(first.statusCode).toBe(200);
    const sessionId = first.json<{ sessionId: string }>().sessionId;

    const crossed = await app.inject({
      method: 'POST',
      url: '/deploy/chunk',
      headers: { authorization: AUTHORIZATION },
      payload: {
        deploymentId: otherDeploymentId,
        sessionId,
        files: [],
        commit: true,
      },
    });

    expect(crossed.statusCode).toBe(409);
    expect(crossed.json()).toMatchObject({
      deploymentId: firstDeploymentId,
      requestedDeploymentId: otherDeploymentId,
      sameOperation: false,
    });
    expect(deployer.getDeploymentStatus().deploymentId).toBeUndefined();
  });

  it('rejects a chunk continuation that omits its caller-owned deployment UUID', async () => {
    const deploymentId = '00000000-0000-4000-8000-000000000107';
    const first = await app.inject({
      method: 'POST',
      url: '/deploy/chunk',
      headers: { authorization: AUTHORIZATION },
      payload: {
        deploymentId,
        artifact: artifactExpectation,
        files: [],
        deletions: [],
        expectedFiles: 1,
        commit: false,
      },
    });
    expect(first.statusCode).toBe(200);
    const sessionId = first.json<{ sessionId: string }>().sessionId;
    const applyChangesAuto = vi.spyOn(deployer, 'applyChangesAuto');

    const continuation = await app.inject({
      method: 'POST',
      url: '/deploy/chunk',
      headers: { authorization: AUTHORIZATION },
      payload: {
        sessionId,
        files: [{
          path: 'version.txt',
          content: Buffer.from('after').toString('base64'),
        }],
        commit: true,
      },
    });

    expect(continuation.statusCode).toBe(400);
    expect(continuation.json()).toMatchObject({
      error: 'Missing deployment ID',
    });
    expect(applyChangesAuto).not.toHaveBeenCalled();
    expect(deployer.getDeploymentStatus().deploymentId).toBeUndefined();
  });
});
