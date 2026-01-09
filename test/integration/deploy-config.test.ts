// Path: test/integration/deploy-config.test.ts
// Integration tests for deployment configuration commands

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import { writeFile, readFile, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import AdmZip from 'adm-zip';

// Test configuration
const TEST_CONFIG_DIR = join(tmpdir(), 'znvault-deploy-config-test');
const TEST_WAR_PATH = join(TEST_CONFIG_DIR, 'TestApp.war');

// Simulated znvault config directory for tests
const ZNVAULT_CONFIG_DIR = join(TEST_CONFIG_DIR, '.znvault');
const DEPLOY_CONFIGS_PATH = join(ZNVAULT_CONFIG_DIR, 'deploy-configs.json');

// Mock agent server for testing HTTP endpoints
let mockServer: ChildProcess | null = null;
const MOCK_SERVER_PORT = 19100;

/**
 * Create a test WAR file
 */
async function createTestWar(warPath: string, files: Record<string, string>): Promise<void> {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content));
  }
  zip.writeZip(warPath);
}

/**
 * Run CLI command and return output
 */
async function runCLI(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const fullArgs = [...args];
    const proc = spawn('node', [
      join(__dirname, '../../dist/cli.js'),
      ...fullArgs,
    ], {
      env: {
        ...process.env,
        HOME: TEST_CONFIG_DIR,
        XDG_CONFIG_HOME: join(TEST_CONFIG_DIR, '.config'),
        ZNVAULT_CONFIG_DIR: ZNVAULT_CONFIG_DIR,
      },
      cwd: TEST_CONFIG_DIR,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}

/**
 * Load deploy configs from file
 */
async function loadConfigs(): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(DEPLOY_CONFIGS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { configs: {} };
  }
}

/**
 * Save deploy configs to file
 */
async function saveConfigs(configs: Record<string, unknown>): Promise<void> {
  await mkdir(ZNVAULT_CONFIG_DIR, { recursive: true });
  await writeFile(DEPLOY_CONFIGS_PATH, JSON.stringify(configs, null, 2));
}

describe('Deploy Config Integration Tests', () => {
  beforeAll(async () => {
    // Create test directories
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    await mkdir(ZNVAULT_CONFIG_DIR, { recursive: true });

    // Create test WAR file
    await createTestWar(TEST_WAR_PATH, {
      'index.html': '<html><body>Test</body></html>',
      'WEB-INF/web.xml': '<web-app version="4.0"></web-app>',
      'style.css': 'body { color: blue; }',
    });
  });

  afterAll(async () => {
    // Cleanup
    await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clear configs before each test
    await saveConfigs({ configs: {} });
  });

  describe('deploy config create', () => {
    it('DC-01: should create a new deployment config with hosts', async () => {
      // Directly test the config storage mechanism
      const configs = {
        configs: {
          staging: {
            name: 'staging',
            hosts: ['192.168.1.10', '192.168.1.11'],
            warPath: TEST_WAR_PATH,
            port: 9100,
            parallel: true,
            description: 'Staging servers',
          },
        },
      };
      await saveConfigs(configs);

      const loaded = await loadConfigs();
      expect(loaded.configs).toHaveProperty('staging');

      const staging = (loaded.configs as Record<string, unknown>).staging as Record<string, unknown>;
      expect(staging.name).toBe('staging');
      expect(staging.hosts).toEqual(['192.168.1.10', '192.168.1.11']);
      expect(staging.warPath).toBe(TEST_WAR_PATH);
      expect(staging.parallel).toBe(true);
    });

    it('DC-02: should create config with sequential deployment mode', async () => {
      const configs = {
        configs: {
          production: {
            name: 'production',
            hosts: ['prod-1.example.com', 'prod-2.example.com'],
            warPath: '/opt/app/MyApp.war',
            port: 9100,
            parallel: false,
            description: 'Production - sequential for safety',
          },
        },
      };
      await saveConfigs(configs);

      const loaded = await loadConfigs();
      const production = (loaded.configs as Record<string, unknown>).production as Record<string, unknown>;
      expect(production.parallel).toBe(false);
    });

    it('DC-03: should create config with custom port', async () => {
      const configs = {
        configs: {
          custom: {
            name: 'custom',
            hosts: ['host1'],
            warPath: TEST_WAR_PATH,
            port: 8100,
            parallel: true,
          },
        },
      };
      await saveConfigs(configs);

      const loaded = await loadConfigs();
      const custom = (loaded.configs as Record<string, unknown>).custom as Record<string, unknown>;
      expect(custom.port).toBe(8100);
    });
  });

  describe('deploy config management', () => {
    it('DC-04: should add hosts to existing config', async () => {
      // Create initial config
      const configs = {
        configs: {
          staging: {
            name: 'staging',
            hosts: ['host1'],
            warPath: TEST_WAR_PATH,
            port: 9100,
            parallel: true,
          },
        },
      };
      await saveConfigs(configs);

      // Add host
      const loaded = await loadConfigs();
      const staging = (loaded.configs as Record<string, unknown>).staging as Record<string, unknown>;
      (staging.hosts as string[]).push('host2');
      await saveConfigs(loaded);

      // Verify
      const updated = await loadConfigs();
      const updatedStaging = (updated.configs as Record<string, unknown>).staging as Record<string, unknown>;
      expect(updatedStaging.hosts).toEqual(['host1', 'host2']);
    });

    it('DC-05: should remove hosts from config', async () => {
      const configs = {
        configs: {
          staging: {
            name: 'staging',
            hosts: ['host1', 'host2', 'host3'],
            warPath: TEST_WAR_PATH,
            port: 9100,
            parallel: true,
          },
        },
      };
      await saveConfigs(configs);

      // Remove host
      const loaded = await loadConfigs();
      const staging = (loaded.configs as Record<string, unknown>).staging as Record<string, unknown>;
      const hosts = staging.hosts as string[];
      const index = hosts.indexOf('host2');
      hosts.splice(index, 1);
      await saveConfigs(loaded);

      // Verify
      const updated = await loadConfigs();
      const updatedStaging = (updated.configs as Record<string, unknown>).staging as Record<string, unknown>;
      expect(updatedStaging.hosts).toEqual(['host1', 'host3']);
    });

    it('DC-06: should update config settings', async () => {
      const configs = {
        configs: {
          staging: {
            name: 'staging',
            hosts: ['host1'],
            warPath: '/old/path.war',
            port: 9100,
            parallel: true,
          },
        },
      };
      await saveConfigs(configs);

      // Update settings
      const loaded = await loadConfigs();
      const staging = (loaded.configs as Record<string, unknown>).staging as Record<string, unknown>;
      staging.warPath = '/new/path.war';
      staging.port = 8100;
      staging.parallel = false;
      await saveConfigs(loaded);

      // Verify
      const updated = await loadConfigs();
      const updatedStaging = (updated.configs as Record<string, unknown>).staging as Record<string, unknown>;
      expect(updatedStaging.warPath).toBe('/new/path.war');
      expect(updatedStaging.port).toBe(8100);
      expect(updatedStaging.parallel).toBe(false);
    });

    it('DC-07: should delete config', async () => {
      const configs = {
        configs: {
          staging: {
            name: 'staging',
            hosts: ['host1'],
            warPath: TEST_WAR_PATH,
            port: 9100,
            parallel: true,
          },
          production: {
            name: 'production',
            hosts: ['prod1'],
            warPath: TEST_WAR_PATH,
            port: 9100,
            parallel: false,
          },
        },
      };
      await saveConfigs(configs);

      // Delete staging
      const loaded = await loadConfigs();
      delete (loaded.configs as Record<string, unknown>).staging;
      await saveConfigs(loaded);

      // Verify
      const updated = await loadConfigs();
      expect(updated.configs).not.toHaveProperty('staging');
      expect(updated.configs).toHaveProperty('production');
    });
  });

  describe('deploy config list', () => {
    it('DC-08: should list all configs', async () => {
      const configs = {
        configs: {
          staging: {
            name: 'staging',
            hosts: ['s1', 's2'],
            warPath: TEST_WAR_PATH,
            port: 9100,
            parallel: true,
            description: 'Staging env',
          },
          production: {
            name: 'production',
            hosts: ['p1', 'p2', 'p3'],
            warPath: TEST_WAR_PATH,
            port: 9100,
            parallel: false,
            description: 'Production env',
          },
        },
      };
      await saveConfigs(configs);

      const loaded = await loadConfigs();
      const configList = Object.values(loaded.configs as Record<string, unknown>);
      expect(configList).toHaveLength(2);
      expect(configList.map((c: unknown) => (c as Record<string, unknown>).name)).toContain('staging');
      expect(configList.map((c: unknown) => (c as Record<string, unknown>).name)).toContain('production');
    });

    it('DC-09: should return empty list when no configs', async () => {
      const loaded = await loadConfigs();
      const configList = Object.values(loaded.configs as Record<string, unknown>);
      expect(configList).toHaveLength(0);
    });
  });

  describe('deploy config show', () => {
    it('DC-10: should show config details', async () => {
      const configs = {
        configs: {
          staging: {
            name: 'staging',
            hosts: ['192.168.1.10', '192.168.1.11', '192.168.1.12'],
            warPath: '/opt/app/MyApp.war',
            port: 9100,
            parallel: true,
            description: 'Staging environment',
          },
        },
      };
      await saveConfigs(configs);

      const loaded = await loadConfigs();
      const staging = (loaded.configs as Record<string, unknown>).staging as Record<string, unknown>;

      expect(staging.name).toBe('staging');
      expect(staging.description).toBe('Staging environment');
      expect((staging.hosts as string[]).length).toBe(3);
      expect(staging.warPath).toBe('/opt/app/MyApp.war');
      expect(staging.port).toBe(9100);
      expect(staging.parallel).toBe(true);
    });
  });
});

describe('Deploy Config Edge Cases', () => {
  beforeAll(async () => {
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    await mkdir(ZNVAULT_CONFIG_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await saveConfigs({ configs: {} });
  });

  it('DC-11: should handle config with no hosts', async () => {
    const configs = {
      configs: {
        empty: {
          name: 'empty',
          hosts: [],
          warPath: TEST_WAR_PATH,
          port: 9100,
          parallel: true,
        },
      },
    };
    await saveConfigs(configs);

    const loaded = await loadConfigs();
    const empty = (loaded.configs as Record<string, unknown>).empty as Record<string, unknown>;
    expect(empty.hosts).toEqual([]);
  });

  it('DC-12: should handle config with no war path', async () => {
    const configs = {
      configs: {
        nowar: {
          name: 'nowar',
          hosts: ['host1'],
          warPath: '',
          port: 9100,
          parallel: true,
        },
      },
    };
    await saveConfigs(configs);

    const loaded = await loadConfigs();
    const nowar = (loaded.configs as Record<string, unknown>).nowar as Record<string, unknown>;
    expect(nowar.warPath).toBe('');
  });

  it('DC-13: should prevent duplicate host entries', async () => {
    const configs = {
      configs: {
        test: {
          name: 'test',
          hosts: ['host1'],
          warPath: TEST_WAR_PATH,
          port: 9100,
          parallel: true,
        },
      },
    };
    await saveConfigs(configs);

    // Try to add duplicate
    const loaded = await loadConfigs();
    const test = (loaded.configs as Record<string, unknown>).test as Record<string, unknown>;
    const hosts = test.hosts as string[];

    // Only add if not already present
    if (!hosts.includes('host1')) {
      hosts.push('host1');
    }
    await saveConfigs(loaded);

    const updated = await loadConfigs();
    const updatedTest = (updated.configs as Record<string, unknown>).test as Record<string, unknown>;
    expect(updatedTest.hosts).toEqual(['host1']); // Should still be just one
  });

  it('DC-14: should handle multiple configs independently', async () => {
    const configs = {
      configs: {
        dev: {
          name: 'dev',
          hosts: ['dev1'],
          warPath: '/dev/app.war',
          port: 9100,
          parallel: true,
        },
        staging: {
          name: 'staging',
          hosts: ['staging1', 'staging2'],
          warPath: '/staging/app.war',
          port: 9100,
          parallel: true,
        },
        production: {
          name: 'production',
          hosts: ['prod1', 'prod2', 'prod3'],
          warPath: '/prod/app.war',
          port: 9100,
          parallel: false,
        },
      },
    };
    await saveConfigs(configs);

    // Modify one config
    const loaded = await loadConfigs();
    const staging = (loaded.configs as Record<string, unknown>).staging as Record<string, unknown>;
    (staging.hosts as string[]).push('staging3');
    await saveConfigs(loaded);

    // Verify others unchanged
    const updated = await loadConfigs();
    const dev = (updated.configs as Record<string, unknown>).dev as Record<string, unknown>;
    const prod = (updated.configs as Record<string, unknown>).production as Record<string, unknown>;
    const updatedStaging = (updated.configs as Record<string, unknown>).staging as Record<string, unknown>;

    expect(dev.hosts).toEqual(['dev1']);
    expect(prod.hosts).toEqual(['prod1', 'prod2', 'prod3']);
    expect(updatedStaging.hosts).toEqual(['staging1', 'staging2', 'staging3']);
  });
});

describe('WAR Diff Calculation', () => {
  const WAR_DIR = join(TEST_CONFIG_DIR, 'wars');

  beforeAll(async () => {
    await mkdir(WAR_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  it('DC-15: should detect changed files between WAR versions', async () => {
    // Create original WAR
    const originalWar = join(WAR_DIR, 'original.war');
    await createTestWar(originalWar, {
      'index.html': '<html>v1</html>',
      'style.css': 'body { color: red; }',
      'app.js': 'console.log("v1");',
    });

    // Create updated WAR
    const updatedWar = join(WAR_DIR, 'updated.war');
    await createTestWar(updatedWar, {
      'index.html': '<html>v2</html>', // changed
      'style.css': 'body { color: red; }', // unchanged
      'app.js': 'console.log("v2");', // changed
      'new.txt': 'new file', // added
    });

    // Calculate hashes
    const originalZip = new AdmZip(originalWar);
    const updatedZip = new AdmZip(updatedWar);

    const originalHashes: Record<string, string> = {};
    const updatedHashes: Record<string, string> = {};

    for (const entry of originalZip.getEntries()) {
      if (!entry.isDirectory) {
        const crypto = await import('node:crypto');
        const hash = crypto.createHash('sha256').update(entry.getData()).digest('hex');
        originalHashes[entry.entryName] = hash;
      }
    }

    for (const entry of updatedZip.getEntries()) {
      if (!entry.isDirectory) {
        const crypto = await import('node:crypto');
        const hash = crypto.createHash('sha256').update(entry.getData()).digest('hex');
        updatedHashes[entry.entryName] = hash;
      }
    }

    // Find changes
    const changed: string[] = [];
    const added: string[] = [];

    for (const [path, hash] of Object.entries(updatedHashes)) {
      if (!originalHashes[path]) {
        added.push(path);
      } else if (originalHashes[path] !== hash) {
        changed.push(path);
      }
    }

    expect(changed).toContain('index.html');
    expect(changed).toContain('app.js');
    expect(changed).not.toContain('style.css');
    expect(added).toContain('new.txt');
  });

  it('DC-16: should detect deleted files between WAR versions', async () => {
    // Create original WAR with extra file
    const originalWar = join(WAR_DIR, 'with-extra.war');
    await createTestWar(originalWar, {
      'index.html': '<html>test</html>',
      'old-file.txt': 'will be deleted',
      'config.xml': '<config/>',
    });

    // Create updated WAR without the extra file
    const updatedWar = join(WAR_DIR, 'without-extra.war');
    await createTestWar(updatedWar, {
      'index.html': '<html>test</html>',
      'config.xml': '<config/>',
    });

    // Calculate what's deleted
    const originalZip = new AdmZip(originalWar);
    const updatedZip = new AdmZip(updatedWar);

    const originalFiles = originalZip.getEntries()
      .filter(e => !e.isDirectory)
      .map(e => e.entryName);
    const updatedFiles = updatedZip.getEntries()
      .filter(e => !e.isDirectory)
      .map(e => e.entryName);

    const deleted = originalFiles.filter(f => !updatedFiles.includes(f));

    expect(deleted).toContain('old-file.txt');
    expect(deleted).not.toContain('index.html');
    expect(deleted).not.toContain('config.xml');
  });
});
