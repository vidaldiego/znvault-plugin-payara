// Path: test/integration/routes.test.ts
// HTTP routes integration tests

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { PayaraManager } from '../../src/payara-manager.js';
import { WarDeployer } from '../../src/war-deployer.js';
import { registerRoutes } from '../../src/routes.js';
import { SessionStore } from '../../src/session-store.js';
import { createMockPayara, MockPayara } from '../helpers/mock-payara.js';
import {
  createTestWar,
  createTempDir,
  cleanupTempDir,
} from '../helpers/war-utils.js';
import pino from 'pino';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const MUTATION_AUTH_TOKEN = 'test-payara-mutation-token-0123456789abcdef';
const MUTATION_AUTHORIZATION = `Bearer ${MUTATION_AUTH_TOKEN}`;
const ARTIFACT_EXPECTATION = {
  expectedBaseSha256: 'a'.repeat(64),
  targetContentSha256: 'b'.repeat(64),
};
const ARTIFACT_IDENTITY = {
  size: 9,
  sha256: 'c'.repeat(64),
  contentSha256: ARTIFACT_EXPECTATION.targetContentSha256,
};

function addAuthorizedTestRequests(app: FastifyInstance): void {
  app.addHook('onRequest', async request => {
    if (request.headers['x-test-omit-payara-auth'] !== 'true') {
      request.headers.authorization ??= MUTATION_AUTHORIZATION;
    }
  });
}

describe('HTTP Routes Integration', () => {
  let mockPayara: MockPayara;
  let payaraManager: PayaraManager;
  let warDeployer: WarDeployer;
  let fastify: FastifyInstance;
  let tempDir: string;
  let warPath: string;
  let logger: pino.Logger;

  beforeAll(async () => {
    logger = pino({ level: 'silent' });
  });

  beforeEach(async () => {
    tempDir = createTempDir('routes-test');
    warPath = `${tempDir}/app.war`;

    // Setup mock Payara
    mockPayara = await createMockPayara({ baseDir: `${tempDir}/payara` });
    mockPayara.simulateStart();
    await mockPayara.startHealthServer();

    // Create test WAR
    createTestWar({
      path: warPath,
      appName: 'TestApp',
      files: [
        { path: 'test.txt', content: 'test content' },
        { path: 'data/config.json', content: '{"key": "value"}' },
      ],
    });

    // Setup managers
    payaraManager = new PayaraManager({
      payaraHome: mockPayara.payaraHome,
      domain: mockPayara.domain,
      user: process.env.USER || 'test',
      healthEndpoint: mockPayara.healthEndpoint,
      logger,
      runtimeIdentityProvider: async () => 'routes-test-runtime',
    });

    warDeployer = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: payaraManager,
      logger,
      deploymentLockPath: `${tempDir}/deploy.lock`,
    });

    // Setup Fastify
    fastify = Fastify({ logger: false });
    addAuthorizedTestRequests(fastify);
    await registerRoutes(
      fastify,
      payaraManager,
      warDeployer,
      logger,
      MUTATION_AUTH_TOKEN,
      undefined,
      '3.0.0-test'
    );
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
    await mockPayara.cleanup();
    cleanupTempDir(tempDir);
  });

  describe('Payara namespace authorization', () => {
    it.each(['/hashes', '/status', '/file/test.txt'])(
      'AUTH-01: rejects unauthenticated GET %s',
      async url => {
        const response = await fastify.inject({
          method: 'GET',
          url,
          headers: { 'x-test-omit-payara-auth': 'true' },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'Unauthorized' });
      }
    );

    it('AUTH-02: rejects an incorrect token', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/hashes',
        headers: {
          'x-test-omit-payara-auth': 'true',
          authorization: 'Bearer definitely-not-the-right-token',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('AUTH-03: accepts the exact token', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/hashes',
        headers: { authorization: MUTATION_AUTHORIZATION },
      });

      expect(response.statusCode).toBe(200);
    });

    it('AUTH-04: rejects before malformed JSON parsing or chunk-session creation', async () => {
      const createSession = vi.spyOn(SessionStore.prototype, 'create');
      try {
        const response = await fastify.inject({
          method: 'POST',
          url: '/deploy/chunk',
          headers: {
            'content-type': 'application/json',
            'x-test-omit-payara-auth': 'true',
          },
          payload: '{not-json',
        });

        expect(response.statusCode).toBe(401);
        expect(createSession).not.toHaveBeenCalled();
      } finally {
        createSession.mockRestore();
      }
    });

    it('AUTH-05: rejects lifecycle mutation before any Payara side effect', async () => {
      const restart = vi.spyOn(payaraManager, 'restart');
      try {
        const response = await fastify.inject({
          method: 'POST',
          url: '/restart',
          headers: { 'x-test-omit-payara-auth': 'true' },
        });

        expect(response.statusCode).toBe(401);
        expect(restart).not.toHaveBeenCalled();
      } finally {
        restart.mockRestore();
      }
    });
  });

  describe('GET /hashes', () => {
    it('RT-01: should return hashes for all WAR files', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/hashes',
      });

      expect(response.statusCode).toBe(200);

      const body = response.json<{
        hashes: Record<string, string>;
        artifact: { size: number; sha256: string; contentSha256: string };
      }>();
      expect(body.hashes).toBeDefined();
      expect(body.hashes['WEB-INF/web.xml']).toBeDefined();
      expect(body.hashes['test.txt']).toBeDefined();
      const artifact = readFileSync(warPath);
      expect(body.artifact).toEqual({
        size: artifact.byteLength,
        sha256: createHash('sha256').update(artifact).digest('hex'),
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      // Verify hash format
      for (const hash of Object.values(body.hashes)) {
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    it('RT-02: should return empty hashes when WAR does not exist', async () => {
      const emptyDeployer = new WarDeployer({
        warPath: `${tempDir}/nonexistent.war`,
        appName: 'TestApp',
        payara: payaraManager,
        logger,
        deploymentLockPath: `${tempDir}/empty-deploy.lock`,
      });

      const emptyFastify = Fastify({ logger: false });
      addAuthorizedTestRequests(emptyFastify);
      await registerRoutes(
        emptyFastify,
        payaraManager,
        emptyDeployer,
        logger,
        MUTATION_AUTH_TOKEN
      );
      await emptyFastify.ready();

      const response = await emptyFastify.inject({
        method: 'GET',
        url: '/hashes',
      });

      expect(response.statusCode).toBe(200);
      expect(
        response.json<{ hashes: Record<string, string>; artifact: null }>(),
      ).toMatchObject({ hashes: {}, artifact: null });

      await emptyFastify.close();
    });
  });

  describe('GET /readback', () => {
    it('RT-02a: should return bounded runtime and exact whole-WAR identity', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/readback',
      });

      expect(response.statusCode).toBe(200);
      const artifact = readFileSync(warPath);
      const body = response.json<{
        appDeployed: boolean;
        appName: string;
        artifact: { size: number; sha256: string; contentSha256: string };
        dispatchAllowed: boolean;
        domain: string;
        healthy: boolean;
        observedAtUtc: string;
        processCount: number;
        running: boolean;
        schema: string;
        status: string;
        statusOnly: boolean;
        warPath: string;
      }>();
      expect(body).toEqual({
        appDeployed: false,
        appName: 'TestApp',
        artifact: {
          size: artifact.byteLength,
          sha256: createHash('sha256').update(artifact).digest('hex'),
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        dispatchAllowed: false,
        domain: mockPayara.domain,
        healthy: true,
        observedAtUtc: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        ),
        processCount: 0,
        running: true,
        schema: 'zincapp.payara.deployment-readback/v1',
        status: 'ok',
        statusOnly: true,
        warPath,
      });
      expect(body).not.toHaveProperty('hashes');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Number.isNaN(Date.parse(body.observedAtUtc))).toBe(false);
    });

    it('RT-02b: should report no_war without inventing an artifact', async () => {
      const emptyDeployer = new WarDeployer({
        warPath: `${tempDir}/nonexistent.war`,
        appName: 'TestApp',
        payara: payaraManager,
        logger,
        deploymentLockPath: `${tempDir}/empty-deploy.lock`,
      });
      const emptyFastify = Fastify({ logger: false });
      addAuthorizedTestRequests(emptyFastify);
      await registerRoutes(
        emptyFastify,
        payaraManager,
        emptyDeployer,
        logger,
        MUTATION_AUTH_TOKEN
      );
      await emptyFastify.ready();

      const response = await emptyFastify.inject({
        method: 'GET',
        url: '/readback',
      });

      expect(response.statusCode).toBe(200);
      expect(
        response.json<{
          artifact: null;
          dispatchAllowed: boolean;
          observedAtUtc: string;
          schema: string;
          status: string;
          statusOnly: boolean;
        }>(),
      ).toMatchObject({
        artifact: null,
        dispatchAllowed: false,
        observedAtUtc: expect.any(String),
        schema: 'zincapp.payara.deployment-readback/v1',
        status: 'no_war',
        statusOnly: true,
      });
      expect(response.headers['cache-control']).toBe('no-store');
      await emptyFastify.close();
    });
  });

  describe('POST /deploy validation', () => {
    it('rejects a body/header deployment ID mismatch before decode or mutation', async () => {
      const applyChangesAuto = vi.spyOn(warDeployer, 'applyChangesAuto');
      const response = await fastify.inject({
        method: 'POST',
        url: '/deploy',
        headers: {
          'x-znvault-deployment-id': '00000000-0000-4000-8000-000000000202',
        },
        payload: {
          deploymentId: '00000000-0000-4000-8000-000000000201',
          artifact: ARTIFACT_EXPECTATION,
          files: [{ path: 'version.txt', content: 'not-base64***' }],
          deletions: [],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'Deployment ID mismatch' });
      expect(applyChangesAuto).not.toHaveBeenCalled();
    });

    it('RT-03: should reject invalid request (files not array)', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/deploy',
        payload: {
          deploymentId: '00000000-0000-4000-8000-000000000001',
          files: 'not-an-array',
          deletions: [],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe('Invalid request');
    });

    it('RT-04: should reject invalid request (deletions not array)', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/deploy',
        payload: {
          deploymentId: '00000000-0000-4000-8000-000000000002',
          files: [],
          deletions: 'not-an-array',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe('Invalid request');
    });
  });

  describe('Mutation route wiring', () => {
    it('RT-04a: dispatches an empty diff and reports the exact deployment stats', async () => {
      const deploymentId = '00000000-0000-4000-8000-000000000003';
      const applyChangesAuto = vi.spyOn(warDeployer, 'applyChangesAuto').mockResolvedValue({
        success: true,
        filesChanged: 0,
        filesDeleted: 0,
        message: 'Deployment successful',
        deploymentTime: 12,
        appName: 'TestApp',
        deployed: true,
        applications: ['TestApp'],
        artifact: ARTIFACT_IDENTITY,
        targetContentSha256: ARTIFACT_EXPECTATION.targetContentSha256,
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/deploy',
        payload: {
          deploymentId,
          artifact: ARTIFACT_EXPECTATION,
          files: [],
          deletions: [],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'deployed',
        deploymentId,
        success: true,
        filesChanged: 0,
        filesDeleted: 0,
        message: 'Deployment successful',
        appName: 'TestApp',
        deployed: true,
      });
      expect(response.json()).toHaveProperty('completedAt');
      expect(applyChangesAuto).toHaveBeenCalledOnce();
      expect(applyChangesAuto).toHaveBeenCalledWith(
        [],
        [],
        deploymentId,
        ARTIFACT_EXPECTATION
      );
    });

    it('RT-04a1: rejects a nominal success when deployment was not verified', async () => {
      vi.spyOn(warDeployer, 'applyChangesAuto').mockResolvedValue({
        success: true,
        filesChanged: 0,
        filesDeleted: 0,
        message: 'Deployment successful',
        deploymentTime: 12,
        appName: 'TestApp',
        deployed: false,
        applications: [],
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/deploy',
        payload: {
          deploymentId: '00000000-0000-4000-8000-000000000004',
          artifact: ARTIFACT_EXPECTATION,
          files: [],
          deletions: [],
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        status: 'failed',
        deployed: false,
      });
    });

    it('RT-04a2: full deployment returns 500 when application verification fails', async () => {
      const deploymentId = '00000000-0000-4000-8000-000000000005';
      const deployAuto = vi.spyOn(warDeployer, 'deployAuto').mockResolvedValue({
        deployed: false,
        applications: [],
        deploymentTime: 12,
        aggressiveMode: false,
        artifact: ARTIFACT_IDENTITY,
        targetContentSha256: ARTIFACT_EXPECTATION.targetContentSha256,
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/deploy/full',
        payload: { deploymentId, artifact: ARTIFACT_EXPECTATION },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        status: 'failed',
        deploymentId,
        deployed: false,
      });
      expect(deployAuto).toHaveBeenCalledWith(deploymentId, ARTIFACT_EXPECTATION);
    });

    it('RT-04a3: binds a binary upload header to the deployment and response', async () => {
      const deploymentId = '00000000-0000-4000-8000-000000000006';
      const deployUploadedWar = vi.spyOn(warDeployer, 'deployUploadedWar').mockResolvedValue({
        deployed: true,
        applications: ['TestApp'],
        deploymentTime: 12,
        aggressiveMode: false,
        artifact: ARTIFACT_IDENTITY,
        targetContentSha256: ARTIFACT_EXPECTATION.targetContentSha256,
      });
      const payload = Buffer.from('war-bytes');

      const response = await fastify.inject({
        method: 'POST',
        url: '/deploy/upload',
        headers: {
          'content-type': 'application/octet-stream',
          'x-znvault-deployment-id': deploymentId,
          'x-znvault-expected-base-sha256': ARTIFACT_EXPECTATION.expectedBaseSha256,
          'x-znvault-target-content-sha256': ARTIFACT_EXPECTATION.targetContentSha256,
        },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'deployed',
        deploymentId,
        deployed: true,
      });
      expect(deployUploadedWar).toHaveBeenCalledWith(
        payload,
        deploymentId,
        ARTIFACT_EXPECTATION
      );
    });

    it('RT-04a4: rejects every deploy mutation without a caller UUID before lock or mutation', async () => {
      const applyChangesAuto = vi.spyOn(warDeployer, 'applyChangesAuto');
      const deployAuto = vi.spyOn(warDeployer, 'deployAuto');
      const deployUploadedWar = vi.spyOn(warDeployer, 'deployUploadedWar');
      const withDeploymentLock = vi.spyOn(warDeployer, 'withDeploymentLock');
      const createSession = vi.spyOn(SessionStore.prototype, 'create');

      const responses = await Promise.all([
        fastify.inject({
          method: 'POST',
          url: '/deploy',
          payload: { artifact: ARTIFACT_EXPECTATION, files: [], deletions: [] },
        }),
        fastify.inject({
          method: 'POST',
          url: '/deploy/full',
          payload: { artifact: ARTIFACT_EXPECTATION },
        }),
        fastify.inject({
          method: 'POST',
          url: '/deploy/upload',
          headers: {
            'content-type': 'application/octet-stream',
            'x-znvault-expected-base-sha256': ARTIFACT_EXPECTATION.expectedBaseSha256,
            'x-znvault-target-content-sha256': ARTIFACT_EXPECTATION.targetContentSha256,
          },
          payload: Buffer.from('not-decoded-or-written'),
        }),
        fastify.inject({
          method: 'POST',
          url: '/deploy/chunk',
          payload: { artifact: ARTIFACT_EXPECTATION, files: [], deletions: [] },
        }),
      ]);

      expect(responses.map(response => response.statusCode)).toEqual([
        400, 400, 400, 400,
      ]);
      for (const response of responses) {
        expect(response.json()).toMatchObject({ error: 'Missing deployment ID' });
      }
      expect(applyChangesAuto).not.toHaveBeenCalled();
      expect(deployAuto).not.toHaveBeenCalled();
      expect(deployUploadedWar).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(withDeploymentLock).not.toHaveBeenCalled();
    });

    it('RT-04a5: rejects a legacy readable operation ID instead of accepting a guessable receipt key', async () => {
      const applyChangesAuto = vi.spyOn(warDeployer, 'applyChangesAuto');
      const response = await fastify.inject({
        method: 'POST',
        url: '/deploy',
        payload: {
          deploymentId: 'routes-legacy-operation-0001',
          artifact: ARTIFACT_EXPECTATION,
          files: [],
          deletions: [],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'Invalid deployment ID' });
      expect(applyChangesAuto).not.toHaveBeenCalled();
    });

    it('RT-04b: executes restart under the shared deployment lock', async () => {
      const withDeploymentLock = vi.spyOn(warDeployer, 'withDeploymentLock');
      const reconcileQuarantine = vi
        .spyOn(payaraManager, 'reconcileDurableMutationQuarantine')
        .mockResolvedValue();
      const restart = vi.spyOn(payaraManager, 'restart').mockImplementation(async () => {
        const lock = await warDeployer.getDeploymentLockStatus();
        expect(lock.locked).toBe(true);
        expect(lock.data?.step).toBe('start');
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/restart',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: 'restarted',
        message: 'Payara restarted successfully',
      });
      expect(withDeploymentLock).toHaveBeenCalledOnce();
      expect(withDeploymentLock.mock.calls[0]?.[0]).toBe('route-restart:TestApp');
      expect(withDeploymentLock.mock.calls[0]?.[1]).toBe('start');
      expect(withDeploymentLock.mock.calls[0]?.[2]).toEqual(expect.any(Function));
      expect(reconcileQuarantine).toHaveBeenCalledWith('TestApp');
      expect(restart).toHaveBeenCalledOnce();
      expect((await warDeployer.getDeploymentLockStatus()).locked).toBe(false);
    });
  });

  describe('GET /status', () => {
    it('RT-05: should return Payara status', async () => {
      const bootDeployment = {
        appName: 'TestApp',
        bootEpoch: 'boot-epoch-status',
        phase: 'payara-booting' as const,
        readiness: 'unverified' as const,
        mutationOutcomeUnknown: false,
        startupActive: false,
        startedAt: '2026-08-31T10:00:00.000Z',
        evidenceSource: 'persistent-application-ref',
      };
      vi.spyOn(payaraManager, 'readBootDeploymentStatus').mockResolvedValue(
        bootDeployment,
      );
      vi.spyOn(payaraManager, 'getBootDeploymentStatus').mockReturnValue(
        bootDeployment,
      );

      const response = await fastify.inject({
        method: 'GET',
        url: '/status',
      });

      expect(response.statusCode).toBe(200);

      const body = response.json<{
        pluginVersion: string;
        running: boolean;
        healthy: boolean;
        domain: string;
        bootDeployment: typeof bootDeployment;
      }>();
      expect(body).toHaveProperty('running');
      expect(body).toHaveProperty('healthy');
      expect(body).toHaveProperty('domain');
      expect(body.pluginVersion).toBe('3.0.0-test');
      expect(body.domain).toBe(mockPayara.domain);
      expect(body.bootDeployment).toEqual(bootDeployment);
      expect(payaraManager.readBootDeploymentStatus).toHaveBeenCalledWith(
        'TestApp',
      );
    });

    it('RT-06: should reflect actual Payara state', async () => {
      const bootDeployment = {
        appName: 'TestApp',
        bootEpoch: 'boot-epoch-ready',
        phase: 'ready' as const,
        readiness: 'health-verified' as const,
        owner: 'payara' as const,
        runtimeListed: true,
        mutationOutcomeUnknown: false,
        startupActive: false,
        startedAt: '2026-08-31T10:00:00.000Z',
      };
      vi.spyOn(payaraManager, 'readBootDeploymentStatus').mockResolvedValue(bootDeployment);
      vi.spyOn(payaraManager, 'getBootDeploymentStatus').mockReturnValue(bootDeployment);
      vi.spyOn(warDeployer, 'isAppDeployed').mockResolvedValue(true);

      // Running state
      let response = await fastify.inject({
        method: 'GET',
        url: '/status',
      });
      let body = response.json<{ running: boolean; healthy: boolean }>();
      expect(body.running).toBe(true);
      expect(body.healthy).toBe(true);

      // Stop Payara
      mockPayara.simulateStop();
      payaraManager.invalidateStatusCache();

      response = await fastify.inject({
        method: 'GET',
        url: '/status',
      });
      body = response.json<{ running: boolean; healthy: boolean }>();
      expect(body.running).toBe(false);
      expect(body.healthy).toBe(false);
    });

    it('RT-06c: a blocked or UNKNOWN deployment fence is never reported healthy', async () => {
      const bootDeployment = {
        appName: 'TestApp',
        bootEpoch: 'boot-epoch-unknown',
        phase: 'blocked' as const,
        readiness: 'unverified' as const,
        mutationOutcomeUnknown: true,
        startupActive: false,
        startedAt: '2026-08-31T10:00:00.000Z',
      };
      vi.spyOn(payaraManager, 'readBootDeploymentStatus').mockResolvedValue(bootDeployment);
      vi.spyOn(payaraManager, 'getBootDeploymentStatus').mockReturnValue(bootDeployment);
      vi.spyOn(warDeployer, 'isAppDeployed').mockResolvedValue(true);

      const response = await fastify.inject({ method: 'GET', url: '/status' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        running: true,
        healthy: false,
        appDeployed: true,
        bootDeployment: {
          phase: 'blocked',
          mutationOutcomeUnknown: true,
        },
      });
    });

    it('RT-06d: deployment polling never reports UNKNOWN as healthy', async () => {
      const bootDeployment = {
        appName: 'TestApp',
        bootEpoch: 'boot-epoch-deploy-unknown',
        phase: 'blocked' as const,
        readiness: 'unverified' as const,
        mutationOutcomeUnknown: true,
        startupActive: false,
        startedAt: '2026-08-31T10:00:00.000Z',
      };
      vi.spyOn(payaraManager, 'readBootDeploymentStatus').mockResolvedValue(bootDeployment);
      vi.spyOn(payaraManager, 'getBootDeploymentStatus').mockReturnValue(bootDeployment);
      vi.spyOn(warDeployer, 'isAppDeployed').mockResolvedValue(true);

      const response = await fastify.inject({ method: 'GET', url: '/deploy/status' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        deploying: false,
        appDeployed: true,
        healthy: false,
        bootDeployment: {
          phase: 'blocked',
          mutationOutcomeUnknown: true,
        },
      });
    });

    it('RT-06f: a second process holding the shared lock yields a conservative busy snapshot', async () => {
      const secondDeployer = new WarDeployer({
        warPath,
        appName: 'TestApp',
        payara: payaraManager,
        logger,
        deploymentLockPath: `${tempDir}/deploy.lock`,
      });
      let enterLock!: () => void;
      let releaseLock!: () => void;
      const entered = new Promise<void>(resolve => {
        enterLock = resolve;
      });
      const blocked = new Promise<void>(resolve => {
        releaseLock = resolve;
      });
      const holding = secondDeployer.withDeploymentLock(
        'other-process-deploy',
        'deploy',
        async () => {
          enterLock();
          await blocked;
        }
      );
      await entered;

      try {
        const response = await fastify.inject({ method: 'GET', url: '/deploy/status' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          deploying: true,
          appDeployed: false,
          healthy: false,
          running: false,
          deploymentLock: {
            locked: true,
            stale: false,
            step: 'deploy',
          },
        });
      } finally {
        releaseLock();
        await holding;
      }
    });

    it('RT-06e: an unannounced DAS replacement during inventory cannot reuse old readiness', async () => {
      const oldReady = {
        appName: 'TestApp',
        bootEpoch: 'boot-epoch-old-ready',
        phase: 'ready' as const,
        readiness: 'health-verified' as const,
        owner: 'payara' as const,
        runtimeListed: true,
        mutationOutcomeUnknown: false,
        startupActive: false,
        startedAt: '2026-08-31T10:00:00.000Z',
      };
      const replacementStarting = {
        appName: 'TestApp',
        bootEpoch: 'boot-epoch-replacement-starting',
        phase: 'startup' as const,
        readiness: 'unverified' as const,
        mutationOutcomeUnknown: false,
        startupActive: true,
        startedAt: '2026-08-31T10:01:00.000Z',
      };
      let currentBoot: typeof oldReady | typeof replacementStarting = oldReady;
      vi.spyOn(payaraManager, 'readBootDeploymentStatus')
        .mockImplementation(async () => currentBoot);
      vi.spyOn(payaraManager, 'getBootDeploymentStatus')
        .mockImplementation(() => currentBoot);
      vi.spyOn(warDeployer, 'isAppDeployed').mockImplementation(async () => {
        currentBoot = replacementStarting;
        return true;
      });

      const response = await fastify.inject({ method: 'GET', url: '/status' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        running: true,
        appDeployed: true,
        healthy: false,
        bootDeployment: {
          bootEpoch: 'boot-epoch-replacement-starting',
          phase: 'startup',
          readiness: 'unverified',
        },
      });
      expect(payaraManager.readBootDeploymentStatus).toHaveBeenCalledWith(
        'TestApp',
      );
    });
  });

  describe('POST /boot-deployment/attest-ready', () => {
    it('RT-06a: should attest readiness for the requested boot epoch', async () => {
      const attestation = {
        bootEpoch: 'boot-epoch-attested',
        reason: 'ZincAPI readiness probe and smoke test passed',
        source: 'prod-release-runbook',
      };
      const bootDeployment = {
        appName: 'TestApp',
        bootEpoch: attestation.bootEpoch,
        phase: 'ready' as const,
        readiness: 'externally-attested' as const,
        startupActive: false,
        startedAt: '2026-08-31T10:00:00.000Z',
        readyAt: '2026-08-31T10:01:00.000Z',
        evidenceSource: attestation.source,
      };
      const attestBootReady = vi
        .spyOn(payaraManager, 'attestBootReady')
        .mockResolvedValue(bootDeployment);

      const response = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/attest-ready',
        payload: attestation,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: 'attested',
        appName: 'TestApp',
        bootDeployment,
      });
      expect(attestBootReady).toHaveBeenCalledOnce();
      expect(attestBootReady).toHaveBeenCalledWith('TestApp', attestation);
    });

    it('RT-06b: should return conflict when the attestation is rejected', async () => {
      const attestation = {
        bootEpoch: 'stale-boot-epoch',
        reason: 'Stale external check',
        source: 'prod-release-runbook',
      };
      const rejection = new Error(
        'Attestation epoch does not match current epoch boot-epoch-current'
      );
      rejection.name = 'BOOT_EPOCH_MISMATCH';
      const attestBootReady = vi
        .spyOn(payaraManager, 'attestBootReady')
        .mockRejectedValue(rejection);

      const response = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/attest-ready',
        payload: attestation,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Boot readiness attestation rejected',
        message:
          'Attestation epoch does not match current epoch boot-epoch-current',
      });
      expect(attestBootReady).toHaveBeenCalledOnce();
      expect(attestBootReady).toHaveBeenCalledWith('TestApp', attestation);
    });

    it('RT-06b2: rejects readiness authority from a remote socket', async () => {
      const attestBootReady = vi.spyOn(payaraManager, 'attestBootReady');
      const response = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/attest-ready',
        remoteAddress: '192.0.2.40',
        payload: {
          bootEpoch: 'remote-epoch',
          reason: 'Untrusted remote assertion',
          source: 'remote-client',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json<{ message: string }>().message)
        .toContain('OPERATOR_ROUTE_LOCAL_ONLY');
      expect(attestBootReady).not.toHaveBeenCalled();
    });
  });

  describe('POST /boot-deployment/recover', () => {
    const authorization = {
      bootEpoch: 'boot-epoch-stuck',
      runtimeFingerprint: 'a'.repeat(64),
      expectedArtifactSha256: 'b'.repeat(64),
      authorizationId: 'GO-API-57-RECOVERY-001',
      expectedRuntimeListed: false,
      reason: 'Persistent ref exists but the runtime application is absent',
      source: 'prod-recovery-runbook',
    };

    it('RT-06c: consumes authority and recovery in one deployer call', async () => {
      const result = {
        applications: ['TestApp'],
        bootDeployment: {
          appName: 'TestApp',
          bootEpoch: authorization.bootEpoch,
          runtimeFingerprint: authorization.runtimeFingerprint,
          phase: 'ready' as const,
          readiness: 'not_applicable' as const,
          owner: 'agent' as const,
          runtimeListed: true,
          mutationOutcomeUnknown: false,
          startupActive: false,
          startedAt: '2026-08-31T10:00:00.000Z',
          readyAt: '2026-08-31T10:01:00.000Z',
          evidenceSource: authorization.source,
        },
      };
      const recover = vi
        .spyOn(warDeployer, 'recoverBootDeployment')
        .mockResolvedValue(result);

      const response = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/recover',
        payload: authorization,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: 'recovered',
        appName: 'TestApp',
        ...result,
      });
      expect(recover).toHaveBeenCalledOnce();
      expect(recover).toHaveBeenCalledWith(authorization);
    });

    it('RT-06d: stale recovery authority is a conflict and never falls back', async () => {
      const recover = vi
        .spyOn(warDeployer, 'recoverBootDeployment')
        .mockRejectedValue(new Error('BOOT_EPOCH_MISMATCH: stale authority'));

      const response = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/recover',
        payload: authorization,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Boot deployment recovery rejected or failed',
        message: 'BOOT_EPOCH_MISMATCH: stale authority',
      });
      expect(recover).toHaveBeenCalledOnce();
    });

    it('RT-06d2: ambiguous recovery is 503 with an explicit recovery-required state', async () => {
      const error = new Error('BOOT_MUTATION_OUTCOME_UNKNOWN: deploy response was lost');
      error.name = 'BOOT_MUTATION_OUTCOME_UNKNOWN';
      vi.spyOn(warDeployer, 'recoverBootDeployment').mockRejectedValue(error);
      const current = payaraManager.getBootDeploymentStatus('TestApp');
      vi.spyOn(payaraManager, 'getBootDeploymentStatus').mockReturnValue({
        ...current,
        phase: 'blocked',
        readiness: 'unverified',
        owner: undefined,
        runtimeListed: undefined,
        mutationOutcomeUnknown: true,
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/recover',
        payload: authorization,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: 'Boot deployment recovery rejected or failed',
        recoveryRequired: true,
        bootDeployment: {
          phase: 'blocked',
          mutationOutcomeUnknown: true,
        },
      });
    });

    it('RT-06d3: unexpected recovery I/O failures are 500, not safe conflicts', async () => {
      vi.spyOn(warDeployer, 'recoverBootDeployment')
        .mockRejectedValue(new Error('asadmin connection reset'));

      const response = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/recover',
        payload: authorization,
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        error: 'Boot deployment recovery rejected or failed',
        recoveryRequired: false,
      });
    });

    it('RT-06e: rejects recovery through a forwarded or remote connection', async () => {
      const recover = vi.spyOn(warDeployer, 'recoverBootDeployment');
      const remote = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/recover',
        remoteAddress: '192.0.2.40',
        payload: authorization,
      });
      const forwarded = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/recover',
        headers: { forwarded: 'for=192.0.2.40' },
        payload: authorization,
      });

      expect(remote.statusCode).toBe(403);
      expect(forwarded.statusCode).toBe(403);
      expect(remote.json<{ message: string }>().message)
        .toContain('OPERATOR_ROUTE_LOCAL_ONLY');
      expect(forwarded.json<{ message: string }>().message)
        .toContain('OPERATOR_ROUTE_LOCAL_ONLY');
      expect(recover).not.toHaveBeenCalled();
    });
  });

  describe('POST /boot-deployment/stage-artifact', () => {
    it('RT-06f: stages an absent WAR without Payara mutation, then recovery can bind its hash', async () => {
      const artifact = readFileSync(warPath);
      const sha256 = createHash('sha256').update(artifact).digest('hex');
      rmSync(warPath);
      const deploy = vi.spyOn(payaraManager, 'deploy');
      const undeploy = vi.spyOn(payaraManager, 'undeploy');
      const stageFence = vi.spyOn(
        payaraManager,
        'assertMissingRecoveryArtifactStageAllowed'
      ).mockResolvedValue();

      const staged = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/stage-artifact?bootEpoch=boot-epoch-stuck',
        headers: { 'content-type': 'application/octet-stream' },
        payload: artifact,
      });

      expect(staged.statusCode).toBe(200);
      expect(staged.json()).toMatchObject({
        status: 'staged',
        appName: 'TestApp',
        artifact: { size: artifact.byteLength, sha256 },
        deploymentAttempted: false,
      });
      expect(readFileSync(warPath)).toEqual(artifact);
      expect(deploy).not.toHaveBeenCalled();
      expect(undeploy).not.toHaveBeenCalled();
      expect(stageFence).toHaveBeenNthCalledWith(1, 'TestApp', 'boot-epoch-stuck');
      expect(stageFence).toHaveBeenNthCalledWith(2, 'TestApp', 'boot-epoch-stuck');

      const authorization = {
        bootEpoch: 'boot-epoch-stuck',
        runtimeFingerprint: 'a'.repeat(64),
        expectedArtifactSha256: sha256,
        authorizationId: 'GO-STAGED-RECOVERY-001',
        expectedRuntimeListed: false,
        reason: 'Recover the persistent reference using the staged artifact',
        source: 'prod-recovery-runbook',
      };
      const recover = vi.spyOn(warDeployer, 'recoverBootDeployment')
        .mockResolvedValue({
          applications: ['TestApp'],
          bootDeployment: {
            appName: 'TestApp',
            bootEpoch: authorization.bootEpoch,
            runtimeFingerprint: authorization.runtimeFingerprint,
            phase: 'ready',
            readiness: 'not_applicable',
            owner: 'agent',
            runtimeListed: true,
            mutationOutcomeUnknown: false,
            startupActive: false,
            startedAt: '2026-08-31T10:00:00.000Z',
          },
        });
      const recovered = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/recover',
        payload: authorization,
      });

      expect(recovered.statusCode).toBe(200);
      expect(recover).toHaveBeenCalledWith(authorization);
    });

    it('RT-06g: staging is loopback-only and cannot overwrite an existing WAR', async () => {
      const artifact = readFileSync(warPath);
      vi.spyOn(payaraManager, 'assertMissingRecoveryArtifactStageAllowed')
        .mockResolvedValue();
      const remote = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/stage-artifact',
        remoteAddress: '192.0.2.40',
        headers: { 'content-type': 'application/octet-stream' },
        payload: artifact,
      });
      const overwrite = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/stage-artifact?bootEpoch=boot-epoch-stuck',
        headers: { 'content-type': 'application/octet-stream' },
        payload: artifact,
      });

      expect(remote.statusCode).toBe(403);
      expect(overwrite.statusCode).toBe(409);
      expect(overwrite.json<{ message: string }>().message)
        .toContain('BOOT_RECOVERY_ARTIFACT_ALREADY_PRESENT');
    });

    it('RT-06h: staging rechecks the operator epoch immediately before commit', async () => {
      const artifact = readFileSync(warPath);
      rmSync(warPath);
      const epochChanged = new Error('BOOT_EPOCH_MISMATCH: epoch changed during staging');
      epochChanged.name = 'BOOT_EPOCH_MISMATCH';
      const stageFence = vi.spyOn(
        payaraManager,
        'assertMissingRecoveryArtifactStageAllowed'
      )
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(epochChanged);

      const response = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/stage-artifact?bootEpoch=operator-observed-epoch',
        headers: { 'content-type': 'application/octet-stream' },
        payload: artifact,
      });

      expect(response.statusCode).toBe(409);
      expect(stageFence).toHaveBeenCalledTimes(2);
      expect(() => readFileSync(warPath)).toThrow();
    });

    it('RT-06i: concurrent target creation is never overwritten at staging commit', async () => {
      const artifact = readFileSync(warPath);
      rmSync(warPath);
      const competingBytes = Buffer.from('concurrent-owner-war');
      vi.spyOn(payaraManager, 'assertMissingRecoveryArtifactStageAllowed')
        .mockResolvedValueOnce()
        .mockImplementationOnce(async () => {
          writeFileSync(warPath, competingBytes);
        });

      const response = await fastify.inject({
        method: 'POST',
        url: '/boot-deployment/stage-artifact?bootEpoch=operator-observed-epoch',
        headers: { 'content-type': 'application/octet-stream' },
        payload: artifact,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json<{ message: string }>().message)
        .toContain('BOOT_RECOVERY_ARTIFACT_ALREADY_PRESENT');
      expect(readFileSync(warPath)).toEqual(competingBytes);
    });
  });

  describe('GET /applications', () => {
    it('RT-07: should list deployed applications', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/applications',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ applications: string[] }>().applications).toBeDefined();
    });
  });

  describe('GET /file/*', () => {
    it('RT-08: should return file content', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/file/test.txt',
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('test content');
    });

    it('RT-09: should return nested file', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/file/data/config.json',
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"key": "value"}');
    });

    it('RT-10: should return 404 for non-existent file', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/file/nonexistent.txt',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: string }>().error).toBe('Not found');
    });

    it('RT-11: should return 400 for missing path', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/file/',
      });

      expect(response.statusCode).toBe(400);
    });

    it('RT-12: should set correct content type for XML', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/file/WEB-INF/web.xml',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/xml');
    });

    it('RT-13: should set correct content type for HTML', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/file/index.html',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    });

    it('RT-14: should set correct content type for JSON', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/file/data/config.json',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
    });
  });
});
