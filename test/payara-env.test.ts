import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { writeSetenvConf } from '../src/payara-env.js';

const execFileAsync = promisify(execFile);

describe('atomic setenv.conf replacement', () => {
  let stdin = '';

  beforeEach(() => {
    stdin = '';
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        stdin: {
          write: (data: string) => void;
          end: () => void;
        };
      };
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: (data: string) => {
          stdin += data;
        },
        end: () => {
          queueMicrotask(() => proc.emit('close', 0));
        },
      };
      return proc;
    });
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses the existing sudo-as-Payara capability and keeps secrets off argv', async () => {
    const secret = 'must-not-appear-in-process-arguments';
    const payaraHome = '/opt/payara home;$(touch-owned)';

    await writeSetenvConf(
      { ZINC_SECRET: secret },
      {
        payaraHome,
        domain: 'zincapi',
        user: 'payara',
        logger: pino({ level: 'silent' }),
      }
    );

    expect(spawnMock).toHaveBeenCalledOnce();
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe('sudo');
    expect(args.slice(0, 4)).toEqual(['-u', 'payara', '/usr/bin/bash', '-c']);
    expect(args[4]).toContain('/usr/bin/sync -f "$temp_path"');
    expect(args[4]).toContain('/usr/bin/mv -f -- "$temp_path" "$target_path"');
    expect(args[7]).toBe(
      `${payaraHome}/glassfish/domains/zincapi/config/setenv.conf`
    );
    expect(args.join(' ')).not.toContain(secret);
    expect(stdin).toContain(secret);
  });

  it('writes shell literals that preserve expansion syntax, quotes, and newlines', async () => {
    const value = "dollar:$HOME backtick:`id` subshell:$(id) double:\" single:' newline:\nnext";

    await writeSetenvConf(
      { ZINC_LITERAL: value },
      {
        payaraHome: '/opt/payara',
        domain: 'zincapi',
        user: 'payara',
        logger: pino({ level: 'silent' }),
      }
    );

    expect(stdin).toContain(
      "export ZINC_LITERAL='dollar:$HOME backtick:`id` subshell:$(id) double:\" single:'\\'' newline:\nnext'\n"
    );

    const tempDir = await mkdtemp(join(tmpdir(), 'znvault-setenv-test-'));
    const setenvPath = join(tempDir, 'setenv.conf');
    try {
      await writeFile(setenvPath, stdin, { mode: 0o600 });
      const { stdout } = await execFileAsync(
        '/bin/bash',
        [
          '-c',
          'set -eu; source "$1"; printf \'%s\' "$ZINC_LITERAL"',
          'znvault-setenv-test',
          setenvPath,
        ],
        { encoding: 'utf8' }
      );
      expect(stdout).toBe(value);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each(['BAD-NAME', '1BAD', 'BAD$(id)'])(
    'rejects invalid environment variable name %s before spawning',
    async (key) => {
      await expect(
        writeSetenvConf(
          { [key]: 'value' },
          {
            payaraHome: '/opt/payara',
            domain: 'zincapi',
            user: 'payara',
            logger: pino({ level: 'silent' }),
          }
        )
      ).rejects.toThrow(`Invalid environment variable name: ${key}`);

      expect(spawnMock).not.toHaveBeenCalled();
    }
  );

  it('includes TERM-to-KILL escalation inside the remaining startup deadline', async () => {
    vi.useFakeTimers();
    const proc = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr: EventEmitter;
      stdin: { write: (data: string) => void; end: () => void };
      kill: (signal: NodeJS.Signals) => boolean;
    };
    proc.pid = 424_242;
    proc.stderr = new EventEmitter();
    proc.stdin = { write: () => undefined, end: () => undefined };
    proc.kill = vi.fn(() => true);
    spawnMock.mockReturnValue(proc);
    const signals: NodeJS.Signals[] = [];
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      signals.push(signal as NodeJS.Signals);
      if (signal === 'SIGKILL') queueMicrotask(() => proc.emit('close', null));
      return true;
    });

    const write = writeSetenvConf(
      { ZINC_SECRET: 'deadline-test' },
      {
        payaraHome: '/opt/payara',
        domain: 'zincapi',
        user: 'payara',
        logger: pino({ level: 'silent' }),
        deadlineMs: performance.now() + 50,
      }
    );
    const rejection = expect(write).rejects.toThrow(
      'PLUGIN_OPERATION_DEADLINE_EXCEEDED: setenv helper process'
    );

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
