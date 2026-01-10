// Path: test/cli.test.ts
// Tests for CLI plugin

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { createPayaraCLIPlugin } from '../src/cli.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Read version from package.json dynamically
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };
const EXPECTED_VERSION = pkg.version;

// Mock CLI context
const mockContext = {
  client: {
    get: vi.fn(),
    post: vi.fn(),
  },
  output: {
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    table: vi.fn(),
    keyValue: vi.fn(),
  },
  getConfig: () => ({ url: 'https://vault.example.com' }),
  isPlainMode: () => false,
};

describe('createPayaraCLIPlugin', () => {
  it('should create plugin with correct metadata', () => {
    const plugin = createPayaraCLIPlugin();

    expect(plugin.name).toBe('payara');
    expect(plugin.version).toBe(EXPECTED_VERSION);
    expect(plugin.description).toContain('Payara');
  });

  it('should have registerCommands function', () => {
    const plugin = createPayaraCLIPlugin();
    expect(typeof plugin.registerCommands).toBe('function');
  });

  describe('registerCommands', () => {
    it('should register deploy command group', () => {
      const program = new Command();
      const plugin = createPayaraCLIPlugin();

      plugin.registerCommands(program, mockContext as any);

      const deployCmd = program.commands.find(cmd => cmd.name() === 'deploy');
      expect(deployCmd).toBeDefined();
      expect(deployCmd?.description()).toContain('WAR');
    });

    it('should register deploy war subcommand', () => {
      const program = new Command();
      const plugin = createPayaraCLIPlugin();

      plugin.registerCommands(program, mockContext as any);

      const deployCmd = program.commands.find(cmd => cmd.name() === 'deploy');
      const warCmd = deployCmd?.commands.find(cmd => cmd.name() === 'war');
      expect(warCmd).toBeDefined();
    });

    it('should register deploy restart subcommand', () => {
      const program = new Command();
      const plugin = createPayaraCLIPlugin();

      plugin.registerCommands(program, mockContext as any);

      const deployCmd = program.commands.find(cmd => cmd.name() === 'deploy');
      const restartCmd = deployCmd?.commands.find(cmd => cmd.name() === 'restart');
      expect(restartCmd).toBeDefined();
    });

    it('should register deploy status subcommand', () => {
      const program = new Command();
      const plugin = createPayaraCLIPlugin();

      plugin.registerCommands(program, mockContext as any);

      const deployCmd = program.commands.find(cmd => cmd.name() === 'deploy');
      const statusCmd = deployCmd?.commands.find(cmd => cmd.name() === 'status');
      expect(statusCmd).toBeDefined();
    });

    it('should register deploy applications subcommand', () => {
      const program = new Command();
      const plugin = createPayaraCLIPlugin();

      plugin.registerCommands(program, mockContext as any);

      const deployCmd = program.commands.find(cmd => cmd.name() === 'deploy');
      const appsCmd = deployCmd?.commands.find(cmd => cmd.name() === 'applications');
      expect(appsCmd).toBeDefined();
    });

    it('should have apps alias for applications', () => {
      const program = new Command();
      const plugin = createPayaraCLIPlugin();

      plugin.registerCommands(program, mockContext as any);

      const deployCmd = program.commands.find(cmd => cmd.name() === 'deploy');
      const appsCmd = deployCmd?.commands.find(cmd => cmd.name() === 'applications');
      expect(appsCmd?.aliases()).toContain('apps');
    });
  });
});

describe('CLI command options', () => {
  it('war command should have target option', () => {
    const program = new Command();
    const plugin = createPayaraCLIPlugin();
    plugin.registerCommands(program, mockContext as any);

    const deployCmd = program.commands.find(cmd => cmd.name() === 'deploy');
    const warCmd = deployCmd?.commands.find(cmd => cmd.name() === 'war');

    const options = warCmd?.options.map(o => o.name());
    expect(options).toContain('target');
    expect(options).toContain('port');
    expect(options).toContain('force');
    expect(options).toContain('dry-run');
  });

  it('restart command should have target option', () => {
    const program = new Command();
    const plugin = createPayaraCLIPlugin();
    plugin.registerCommands(program, mockContext as any);

    const deployCmd = program.commands.find(cmd => cmd.name() === 'deploy');
    const restartCmd = deployCmd?.commands.find(cmd => cmd.name() === 'restart');

    const options = restartCmd?.options.map(o => o.name());
    expect(options).toContain('target');
    expect(options).toContain('port');
  });
});
