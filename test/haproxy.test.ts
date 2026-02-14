// Path: test/haproxy.test.ts
// Unit tests for HAProxy drain/ready module

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HAProxyConfig } from '../src/cli/types.js';

// Mock child_process.execFile
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Import after mocking
const {
  sshExec,
  setServerState,
  drainServer,
  readyServer,
  testHAProxyConnectivity,
  getUnmappedHosts,
} = await import('../src/cli/haproxy.js');

function makeConfig(overrides: Partial<HAProxyConfig> = {}): HAProxyConfig {
  return {
    hosts: ['172.16.220.20', '172.16.220.21', '172.16.220.23'],
    backend: 'api_servers',
    serverMap: {
      '172.16.211.10': 'server1',
      '172.16.211.11': 'server2',
    },
    ...overrides,
  };
}

describe('sshExec', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('should execute SSH command and return success', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, 'ok\n', '');
      return { on: vi.fn() };
    });

    const result = await sshExec('1.2.3.4', 'admin', 22, 'echo ok', 5000);

    expect(result.success).toBe(true);
    expect(result.host).toBe('1.2.3.4');
    expect(result.stdout).toBe('ok');
  });

  it('should return error on SSH failure', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('Connection refused'), '', 'ssh: connect to host 1.2.3.4 port 22: Connection refused');
      return { on: vi.fn() };
    });

    const result = await sshExec('1.2.3.4', 'admin', 22, 'echo ok', 5000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Connection refused');
  });

  it('should pass correct SSH arguments', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });

    await sshExec('10.0.0.1', 'myuser', 2222, 'ls', 8000);

    expect(mockExecFile).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining([
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', '2222',
        'myuser@10.0.0.1',
        'ls',
      ]),
      expect.objectContaining({ timeout: 8000 }),
      expect.any(Function),
    );
  });

  it('should use stderr for error message when available', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('exit code 1'), '', 'Permission denied (publickey)');
      return { on: vi.fn() };
    });

    const result = await sshExec('1.2.3.4', 'admin', 22, 'echo ok', 5000);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Permission denied (publickey)');
  });
});

describe('setServerState', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('should run drain command on all HAProxy hosts in parallel', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });

    const config = makeConfig();
    const result = await setServerState(config, '172.16.211.10', 'drain');

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(3);
    // Verify the socat command was constructed correctly
    expect(mockExecFile).toHaveBeenCalledTimes(3);
    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).toContain('set server api_servers/server1 state drain');
    expect(command).toContain('sudo socat stdio /run/haproxy/admin.sock');
  });

  it('should use sudo by default', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });

    const config = makeConfig();
    await setServerState(config, '172.16.211.10', 'drain');

    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).toContain('| sudo socat stdio');
  });

  it('should skip sudo when sudo is false', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });

    const config = makeConfig({ sudo: false });
    await setServerState(config, '172.16.211.10', 'drain');

    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).not.toContain('sudo');
    expect(command).toContain('| socat stdio');
  });

  it('should return failure if host not in serverMap', async () => {
    const config = makeConfig();
    const result = await setServerState(config, '10.0.0.99', 'drain');

    expect(result.success).toBe(false);
    expect(result.results[0]!.error).toContain('No HAProxy server mapping');
  });

  it('should return failure if any HAProxy host fails', async () => {
    let callIndex = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      callIndex++;
      if (callIndex === 2) {
        cb(new Error('timeout'), '', 'Connection timed out');
      } else {
        cb(null, '', '');
      }
      return { on: vi.fn() };
    });

    const config = makeConfig();
    const result = await setServerState(config, '172.16.211.10', 'drain');

    expect(result.success).toBe(false);
    expect(result.results.filter(r => r.success)).toHaveLength(2);
    expect(result.results.filter(r => !r.success)).toHaveLength(1);
  });

  it('should use custom config values', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });

    const config = makeConfig({
      user: 'root',
      sshPort: 2222,
      socketPath: '/var/run/haproxy.sock',
      sshTimeout: 20000,
    });

    await setServerState(config, '172.16.211.10', 'ready');

    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    expect(firstCallArgs).toContain('-p');
    expect(firstCallArgs).toContain('2222');
    expect(firstCallArgs).toContain('root@172.16.220.20');
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).toContain('/var/run/haproxy.sock');
    expect(command).toContain('state ready');
  });
});

describe('drainServer / readyServer', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });
  });

  it('drainServer should call setServerState with drain', async () => {
    const config = makeConfig();
    const result = await drainServer(config, '172.16.211.10');

    expect(result.success).toBe(true);
    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).toContain('state drain');
  });

  it('readyServer should call setServerState with ready', async () => {
    const config = makeConfig();
    const result = await readyServer(config, '172.16.211.11');

    expect(result.success).toBe(true);
    const firstCallArgs = mockExecFile.mock.calls[0]![1] as string[];
    const command = firstCallArgs[firstCallArgs.length - 1];
    expect(command).toContain('state ready');
    expect(command).toContain('server2');
  });
});

describe('testHAProxyConnectivity', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('should SSH to all HAProxy hosts and check connectivity', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, 'ok', '');
      return { on: vi.fn() };
    });

    const config = makeConfig();
    const result = await testHAProxyConnectivity(config);

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('should report failure when a host is unreachable', async () => {
    let callIndex = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      callIndex++;
      if (callIndex === 3) {
        cb(new Error('timeout'), '', 'Connection timed out');
      } else {
        cb(null, 'ok', '');
      }
      return { on: vi.fn() };
    });

    const config = makeConfig();
    const result = await testHAProxyConnectivity(config);

    expect(result.success).toBe(false);
    expect(result.results.filter(r => !r.success)).toHaveLength(1);
  });
});

describe('getUnmappedHosts', () => {
  it('should return hosts without serverMap entries', () => {
    const config = makeConfig();
    const unmapped = getUnmappedHosts(config, [
      '172.16.211.10', // mapped
      '172.16.211.11', // mapped
      '172.16.211.12', // NOT mapped
    ]);

    expect(unmapped).toEqual(['172.16.211.12']);
  });

  it('should return empty array when all hosts are mapped', () => {
    const config = makeConfig();
    const unmapped = getUnmappedHosts(config, ['172.16.211.10', '172.16.211.11']);

    expect(unmapped).toEqual([]);
  });

  it('should return all hosts when serverMap is empty', () => {
    const config = makeConfig({ serverMap: {} });
    const unmapped = getUnmappedHosts(config, ['172.16.211.10', '172.16.211.11']);

    expect(unmapped).toEqual(['172.16.211.10', '172.16.211.11']);
  });
});
