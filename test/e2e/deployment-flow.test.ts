// Path: test/e2e/deployment-flow.test.ts
// End-to-end deployment flow tests (WAR diff logic)

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import createPayaraPlugin from '../../src/index.js';
import { PayaraManager } from '../../src/payara-manager.js';
import { WarDeployer, calculateDiff } from '../../src/war-deployer.js';
import { registerRoutes } from '../../src/routes.js';
import { createMockPayara, MockPayara } from '../helpers/mock-payara.js';
import {
  createTestWar,
  createComplexTestWar,
  createModifiedWar,
  createTempDir,
  cleanupTempDir,
  getWarHashes,
  getWarFile,
  listWarFiles,
} from '../helpers/war-utils.js';
import pino from 'pino';
import AdmZip from 'adm-zip';

describe('E2E: WAR Diff Deployment Flow', () => {
  let mockPayara: MockPayara;
  let fastify: FastifyInstance;
  let tempDir: string;
  let serverWarPath: string;
  let localWarPath: string;
  let logger: pino.Logger;
  let warDeployer: WarDeployer;

  beforeAll(async () => {
    logger = pino({ level: 'silent' });
  });

  beforeEach(async () => {
    tempDir = createTempDir('e2e-deployment');
    serverWarPath = `${tempDir}/server/app.war`;
    localWarPath = `${tempDir}/local/app.war`;

    // Setup mock Payara
    mockPayara = await createMockPayara({ baseDir: `${tempDir}/payara` });
    mockPayara.simulateStart();
    await mockPayara.startHealthServer();

    // Create initial WAR on "server"
    createComplexTestWar(serverWarPath);

    // Setup managers and routes
    const payaraManager = new PayaraManager({
      payaraHome: mockPayara.payaraHome,
      domain: mockPayara.domain,
      user: process.env.USER || 'test',
      healthEndpoint: mockPayara.healthEndpoint,
      logger,
    });

    warDeployer = new WarDeployer({
      warPath: serverWarPath,
      appName: 'TestApp',
      payara: payaraManager,
      logger,
    });

    fastify = Fastify({ logger: false });
    await registerRoutes(fastify, payaraManager, warDeployer, logger);
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
    await mockPayara.cleanup();
    cleanupTempDir(tempDir);
  });

  /**
   * Simulate CLI diff calculation (without actual deployment)
   */
  async function calculateDeploymentDiff(localWar: string): Promise<{
    changed: string[];
    deleted: string[];
    files: Array<{ path: string; content: string }>;
  }> {
    // 1. Calculate local hashes
    const localHashes = getWarHashes(localWar);

    // 2. Get remote hashes via API
    const hashResponse = await fastify.inject({
      method: 'GET',
      url: '/hashes',
    });
    const remoteHashes = hashResponse.json<{ hashes: Record<string, string> }>().hashes;

    // 3. Calculate diff
    const { changed, deleted } = calculateDiff(localHashes, remoteHashes);

    // 4. Prepare files for transfer
    const zip = new AdmZip(localWar);
    const files = changed.map(path => ({
      path,
      content: zip.getEntry(path)!.getData().toString('base64'),
    }));

    return { changed, deleted, files };
  }

  /**
   * Apply changes using applyChangesWithoutDeploy (avoids Payara lifecycle)
   */
  async function applyChangesToWar(
    files: Array<{ path: string; content: string }>,
    deletions: string[]
  ): Promise<void> {
    const changedFiles = files.map(f => ({
      path: f.path,
      content: Buffer.from(f.content, 'base64'),
    }));

    await warDeployer.applyChangesWithoutDeploy(changedFiles, deletions);
  }

  describe('Diff Calculation', () => {
    it('E2E-01: should detect changed files', async () => {
      createModifiedWar(serverWarPath, localWarPath, {
        update: [{ path: 'js/app.js', content: 'console.log("v2");' }],
      });

      const diff = await calculateDeploymentDiff(localWarPath);

      expect(diff.changed).toContain('js/app.js');
      expect(diff.changed).toHaveLength(1);
      expect(diff.deleted).toHaveLength(0);
    });

    it('E2E-02: should detect added files', async () => {
      createModifiedWar(serverWarPath, localWarPath, {
        add: [
          { path: 'js/new-module.js', content: 'export function newFeature() {}' },
          { path: 'css/new-style.css', content: '.new { color: blue; }' },
        ],
      });

      const diff = await calculateDeploymentDiff(localWarPath);

      expect(diff.changed).toContain('js/new-module.js');
      expect(diff.changed).toContain('css/new-style.css');
      expect(diff.changed).toHaveLength(2);
    });

    it('E2E-03: should detect deleted files', async () => {
      createModifiedWar(serverWarPath, localWarPath, {
        delete: ['css/components.css', 'js/utils.js'],
      });

      const diff = await calculateDeploymentDiff(localWarPath);

      expect(diff.deleted).toContain('css/components.css');
      expect(diff.deleted).toContain('js/utils.js');
    });

    it('E2E-04: should detect complex changes', async () => {
      createModifiedWar(serverWarPath, localWarPath, {
        add: [{ path: 'js/v2-feature.js', content: 'const v2 = true;' }],
        update: [
          { path: 'index.html', content: '<html><body>v2</body></html>' },
          { path: 'WEB-INF/classes/config.properties', content: 'version=2.0.0' },
        ],
        delete: ['WEB-INF/views/home.jsp'],
      });

      const diff = await calculateDeploymentDiff(localWarPath);

      expect(diff.changed).toContain('js/v2-feature.js');
      expect(diff.changed).toContain('index.html');
      expect(diff.changed).toContain('WEB-INF/classes/config.properties');
      expect(diff.deleted).toContain('WEB-INF/views/home.jsp');
    });

    it('E2E-05: should detect no changes when WARs are identical', async () => {
      createModifiedWar(serverWarPath, localWarPath, {});

      const diff = await calculateDeploymentDiff(localWarPath);

      expect(diff.changed).toHaveLength(0);
      expect(diff.deleted).toHaveLength(0);
    });
  });

  describe('WAR Modification', () => {
    it('E2E-06: should apply file modifications', async () => {
      createModifiedWar(serverWarPath, localWarPath, {
        update: [{ path: 'js/app.js', content: 'console.log("updated");' }],
      });

      const diff = await calculateDeploymentDiff(localWarPath);
      await applyChangesToWar(diff.files, diff.deleted);

      // Verify change was applied
      const content = getWarFile(serverWarPath, 'js/app.js');
      expect(content?.toString()).toBe('console.log("updated");');
    });

    it('E2E-07: should apply file additions', async () => {
      createModifiedWar(serverWarPath, localWarPath, {
        add: [{ path: 'new-file.txt', content: 'new content' }],
      });

      const diff = await calculateDeploymentDiff(localWarPath);
      await applyChangesToWar(diff.files, diff.deleted);

      const serverFiles = listWarFiles(serverWarPath);
      expect(serverFiles).toContain('new-file.txt');
    });

    it('E2E-08: should apply file deletions', async () => {
      createModifiedWar(serverWarPath, localWarPath, {
        delete: ['css/components.css'],
      });

      const diff = await calculateDeploymentDiff(localWarPath);
      await applyChangesToWar(diff.files, diff.deleted);

      const serverFiles = listWarFiles(serverWarPath);
      expect(serverFiles).not.toContain('css/components.css');
    });

    it('E2E-09: should result in matching WARs after sync', async () => {
      createModifiedWar(serverWarPath, localWarPath, {
        update: [{ path: 'js/app.js', content: 'updated' }],
        add: [{ path: 'new.txt', content: 'new' }],
        delete: ['css/style.css'],
      });

      const diff = await calculateDeploymentDiff(localWarPath);
      await applyChangesToWar(diff.files, diff.deleted);

      // After sync, hashes should match
      const serverHashes = getWarHashes(serverWarPath);
      const localHashes = getWarHashes(localWarPath);

      expect(serverHashes).toEqual(localHashes);
    });
  });

  describe('Binary Files', () => {
    it('E2E-10: should handle binary file updates', async () => {
      const newBinary = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE]);

      createModifiedWar(serverWarPath, localWarPath, {
        update: [{ path: 'images/logo.png', content: newBinary }],
      });

      const diff = await calculateDeploymentDiff(localWarPath);
      await applyChangesToWar(diff.files, diff.deleted);

      const content = getWarFile(serverWarPath, 'images/logo.png');
      expect(content).toEqual(newBinary);
    });

    it('E2E-11: should handle JAR file updates', async () => {
      const newJar = Buffer.alloc(2000, 0x50);

      createModifiedWar(serverWarPath, localWarPath, {
        update: [{ path: 'WEB-INF/lib/util-1.0.jar', content: newJar }],
      });

      const diff = await calculateDeploymentDiff(localWarPath);
      await applyChangesToWar(diff.files, diff.deleted);

      const content = getWarFile(serverWarPath, 'WEB-INF/lib/util-1.0.jar');
      expect(content).toEqual(newJar);
    });
  });

  describe('Sequential Syncs', () => {
    it('E2E-12: should handle multiple sequential syncs', async () => {
      // First sync
      createModifiedWar(serverWarPath, localWarPath, {
        update: [{ path: 'js/app.js', content: 'v1' }],
      });
      let diff = await calculateDeploymentDiff(localWarPath);
      await applyChangesToWar(diff.files, diff.deleted);
      expect(getWarFile(serverWarPath, 'js/app.js')?.toString()).toBe('v1');

      // Second sync
      createModifiedWar(serverWarPath, localWarPath, {
        update: [{ path: 'js/app.js', content: 'v2' }],
      });
      diff = await calculateDeploymentDiff(localWarPath);
      await applyChangesToWar(diff.files, diff.deleted);
      expect(getWarFile(serverWarPath, 'js/app.js')?.toString()).toBe('v2');

      // Third sync
      createModifiedWar(serverWarPath, localWarPath, {
        update: [{ path: 'js/app.js', content: 'v3' }],
      });
      diff = await calculateDeploymentDiff(localWarPath);
      await applyChangesToWar(diff.files, diff.deleted);
      expect(getWarFile(serverWarPath, 'js/app.js')?.toString()).toBe('v3');
    });

    it('E2E-13: should skip sync when already synchronized', async () => {
      // Initial sync
      createModifiedWar(serverWarPath, localWarPath, {
        update: [{ path: 'js/app.js', content: 'synced' }],
      });
      let diff = await calculateDeploymentDiff(localWarPath);
      await applyChangesToWar(diff.files, diff.deleted);

      // Second sync with no changes
      diff = await calculateDeploymentDiff(localWarPath);

      expect(diff.changed).toHaveLength(0);
      expect(diff.deleted).toHaveLength(0);
    });
  });
});

describe('E2E: Plugin Factory', () => {
  let mockPayara: MockPayara;
  let tempDir: string;
  let logger: pino.Logger;
  let mockContext: any;

  beforeAll(async () => {
    logger = pino({ level: 'silent' });
  });

  beforeEach(async () => {
    tempDir = createTempDir('e2e-plugin');
    mockPayara = await createMockPayara({ baseDir: `${tempDir}/payara` });
    mockContext = {
      logger: logger.child({ plugin: 'test' }),
      config: {},
      vaultUrl: 'https://vault.example.com',
      tenantId: 'test-tenant',
      getSecret: async () => 'secret',
      restartChild: async () => {},
      emit: () => {},
      on: () => {},
    };
  });

  afterEach(async () => {
    await mockPayara.cleanup();
    cleanupTempDir(tempDir);
  });

  it('E2E-14: should create plugin with valid configuration', () => {
    const warPath = createTestWar({ path: `${tempDir}/app.war`, appName: 'Test' });

    const plugin = createPayaraPlugin({
      payaraHome: mockPayara.payaraHome,
      domain: mockPayara.domain,
      user: 'test',
      warPath,
      appName: 'TestApp',
    });

    expect(plugin.name).toBe('payara');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/); // Valid semver
    expect(plugin.onInit).toBeDefined();
    expect(plugin.routes).toBeDefined();
    expect(plugin.healthCheck).toBeDefined();
  });

  it('E2E-15: should initialize plugin successfully', async () => {
    const warPath = createTestWar({ path: `${tempDir}/app.war`, appName: 'Test' });

    const plugin = createPayaraPlugin({
      payaraHome: mockPayara.payaraHome,
      domain: mockPayara.domain,
      user: 'test',
      warPath,
      appName: 'TestApp',
    });

    await expect(plugin.onInit?.(mockContext as any)).resolves.not.toThrow();
  });

  it('E2E-16: should report health status', async () => {
    const healthPort = await mockPayara.startHealthServer();
    mockPayara.simulateStart();

    const warPath = createTestWar({ path: `${tempDir}/app.war`, appName: 'Test' });

    const plugin = createPayaraPlugin({
      payaraHome: mockPayara.payaraHome,
      domain: mockPayara.domain,
      user: 'test',
      warPath,
      appName: 'TestApp',
      healthEndpoint: `http://localhost:${healthPort}/health`,
    });

    await plugin.onInit?.(mockContext as any);
    const health = await plugin.healthCheck?.(mockContext as any);

    expect(health?.name).toBe('payara');
    // Status is "degraded" because domain is running but app is not deployed
    // Healthy requires: running + app deployed + health endpoint responding
    expect(health?.status).toBe('degraded');
    expect(health?.details?.domain).toBe(mockPayara.domain);
    expect(health?.details?.running).toBe(true);
    expect(health?.details?.appDeployed).toBe(false);
  });

  it('E2E-17: should register routes on Fastify', async () => {
    const warPath = createTestWar({ path: `${tempDir}/app.war`, appName: 'Test' });

    const plugin = createPayaraPlugin({
      payaraHome: mockPayara.payaraHome,
      domain: mockPayara.domain,
      user: 'test',
      warPath,
      appName: 'TestApp',
    });

    await plugin.onInit?.(mockContext as any);

    const fastify = Fastify({ logger: false });
    await plugin.routes?.(fastify, mockContext as any);
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/hashes',
    });

    expect(response.statusCode).toBe(200);

    await fastify.close();
  });
});
