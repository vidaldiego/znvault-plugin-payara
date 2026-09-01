import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { PayaraManager } from '../src/payara-manager.js';

interface CommandInternals {
  execCommand: (
    command: string,
    args: readonly string[],
    timeoutMs?: number
  ) => Promise<{ stdout: string; stderr: string }>;
}

describe('Payara command target-user environment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
  });

  it('sets HOME to the Payara account before invoking its admin CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'payara-command-home-'));
    const targetUser = userInfo().username === 'payara' ? 'payara-alt' : 'payara';
    try {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (signal?: NodeJS.Signals) => boolean;
      };
      child.pid = 424_242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => true);
      spawnMock.mockImplementation(() => {
        queueMicrotask(() => child.emit('close', 0));
        return child;
      });

      const manager = new PayaraManager({
        payaraHome: root,
        domain: 'production',
        user: targetUser,
        logger: pino({ level: 'silent' }),
        runtimeIdentityProvider: async () => undefined,
        mutationQuarantinePath: false,
      });

      await (manager as unknown as CommandInternals).execCommand(
        join(root, 'bin', 'asadmin'),
        ['list-domains'],
        1000
      );

      expect(spawnMock).toHaveBeenCalledOnce();
      const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(command).toBe('/usr/bin/sudo');
      expect(args.slice(0, 5)).toEqual([
        '-H',
        '-u',
        targetUser,
        '/usr/bin/env',
        expect.stringMatching(/^JAVA_HOME=\//),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
