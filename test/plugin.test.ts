// Path: test/plugin.test.ts
// Tests for Payara plugin factory

import { describe, it, expect, vi } from 'vitest';
import createPayaraPlugin from '../src/index.js';
import type { PayaraPluginConfig } from '../src/types.js';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};

// Mock plugin context
const mockContext = {
  logger: mockLogger,
  config: {},
  vaultUrl: 'https://vault.example.com',
  tenantId: 'test-tenant',
  getSecret: vi.fn(),
  restartChild: vi.fn(),
  emit: vi.fn(),
  on: vi.fn(),
};

// Valid plugin config
const validConfig: PayaraPluginConfig = {
  payaraHome: '/opt/payara',
  domain: 'domain1',
  user: 'payara',
  warPath: '/opt/app/Test.war',
  appName: 'TestApp',
  healthEndpoint: 'http://localhost:8080/health',
};

describe('createPayaraPlugin', () => {
  it('should create a plugin with correct metadata', () => {
    const plugin = createPayaraPlugin(validConfig);

    expect(plugin.name).toBe('payara');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/); // Valid semver
    expect(plugin.description).toContain('Payara');
  });

  it('should have all required lifecycle methods', () => {
    const plugin = createPayaraPlugin(validConfig);

    expect(plugin.onInit).toBeDefined();
    expect(plugin.onStart).toBeDefined();
    expect(plugin.onStop).toBeDefined();
    expect(plugin.routes).toBeDefined();
    expect(plugin.healthCheck).toBeDefined();
    expect(plugin.onCertificateDeployed).toBeDefined();
  });

  describe('onInit', () => {
    it('should throw if payaraHome is missing', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        payaraHome: '',
      } as PayaraPluginConfig);

      await expect(plugin.onInit?.(mockContext as any)).rejects.toThrow('payaraHome is required');
    });

    it('should throw if domain is missing', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        domain: '',
      } as PayaraPluginConfig);

      await expect(plugin.onInit?.(mockContext as any)).rejects.toThrow('domain is required');
    });

    it('should throw if user is missing', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        user: '',
      } as PayaraPluginConfig);

      await expect(plugin.onInit?.(mockContext as any)).rejects.toThrow('user is required');
    });

    it('should throw if warPath is missing', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        warPath: '',
      } as PayaraPluginConfig);

      await expect(plugin.onInit?.(mockContext as any)).rejects.toThrow('warPath is required');
    });

    it('should throw if appName is missing', async () => {
      const plugin = createPayaraPlugin({
        ...validConfig,
        appName: '',
      } as PayaraPluginConfig);

      await expect(plugin.onInit?.(mockContext as any)).rejects.toThrow('appName is required');
    });

    it('should initialize successfully with valid config', async () => {
      const plugin = createPayaraPlugin(validConfig);

      await expect(plugin.onInit?.(mockContext as any)).resolves.not.toThrow();
      expect(mockLogger.info).toHaveBeenCalled();
    });
  });

  describe('healthCheck', () => {
    it('should return unhealthy status on error', async () => {
      const plugin = createPayaraPlugin(validConfig);
      await plugin.onInit?.(mockContext as any);

      // Health check will fail because we're not actually running Payara
      const status = await plugin.healthCheck?.(mockContext as any);

      expect(status?.name).toBe('payara');
      expect(status?.status).toBe('unhealthy');
      expect(status?.details).toBeDefined();
      expect(status?.details?.domain).toBe('domain1');
    });
  });
});

describe('Plugin exports', () => {
  it('should export PayaraManager', async () => {
    const { PayaraManager } = await import('../src/index.js');
    expect(PayaraManager).toBeDefined();
  });

  it('should export WarDeployer', async () => {
    const { WarDeployer } = await import('../src/index.js');
    expect(WarDeployer).toBeDefined();
  });

  it('should export calculateDiff', async () => {
    const { calculateDiff } = await import('../src/index.js');
    expect(calculateDiff).toBeDefined();
    expect(typeof calculateDiff).toBe('function');
  });

  it('should export createPayaraCLIPlugin', async () => {
    const { createPayaraCLIPlugin } = await import('../src/index.js');
    expect(createPayaraCLIPlugin).toBeDefined();
    expect(typeof createPayaraCLIPlugin).toBe('function');
  });
});
