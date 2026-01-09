// Path: test/integration/routes.test.ts
// HTTP routes integration tests

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { PayaraManager } from '../../src/payara-manager.js';
import { WarDeployer } from '../../src/war-deployer.js';
import { registerRoutes } from '../../src/routes.js';
import { createMockPayara, MockPayara } from '../helpers/mock-payara.js';
import {
  createTestWar,
  createTempDir,
  cleanupTempDir,
} from '../helpers/war-utils.js';
import pino from 'pino';

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
    });

    warDeployer = new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara: payaraManager,
      logger,
    });

    // Setup Fastify
    fastify = Fastify({ logger: false });
    await registerRoutes(fastify, payaraManager, warDeployer, logger);
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
    await mockPayara.cleanup();
    cleanupTempDir(tempDir);
  });

  describe('GET /hashes', () => {
    it('RT-01: should return hashes for all WAR files', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/hashes',
      });

      expect(response.statusCode).toBe(200);

      const body = response.json<{ hashes: Record<string, string> }>();
      expect(body.hashes).toBeDefined();
      expect(body.hashes['WEB-INF/web.xml']).toBeDefined();
      expect(body.hashes['test.txt']).toBeDefined();

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
      });

      const emptyFastify = Fastify({ logger: false });
      await registerRoutes(emptyFastify, payaraManager, emptyDeployer, logger);
      await emptyFastify.ready();

      const response = await emptyFastify.inject({
        method: 'GET',
        url: '/hashes',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ hashes: Record<string, string> }>().hashes).toEqual({});

      await emptyFastify.close();
    });
  });

  describe('POST /deploy validation', () => {
    it('RT-03: should reject invalid request (files not array)', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/deploy',
        payload: {
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
          files: [],
          deletions: 'not-an-array',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe('Invalid request');
    });
  });

  describe('GET /status', () => {
    it('RT-05: should return Payara status', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/status',
      });

      expect(response.statusCode).toBe(200);

      const body = response.json<{ running: boolean; healthy: boolean; domain: string }>();
      expect(body).toHaveProperty('running');
      expect(body).toHaveProperty('healthy');
      expect(body).toHaveProperty('domain');
      expect(body.domain).toBe(mockPayara.domain);
    });

    it('RT-06: should reflect actual Payara state', async () => {
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

      response = await fastify.inject({
        method: 'GET',
        url: '/status',
      });
      body = response.json<{ running: boolean; healthy: boolean }>();
      expect(body.running).toBe(false);
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
