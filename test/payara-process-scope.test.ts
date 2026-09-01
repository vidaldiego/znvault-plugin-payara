import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { PayaraManager } from '../src/payara-manager.js';

interface ProcessInternals {
  execCommand: (
    command: string,
    args: readonly string[],
    timeoutMs?: number,
    acceptedExitCodes?: readonly number[]
  ) => Promise<{
    stdout: string;
    stderr: string;
  }>;
  needsSudo: () => boolean;
  getPayaraProcessPidsStrict: () => Promise<number[]>;
  getPayaraProcessSnapshotStrict: () => Promise<Map<number, string>>;
  killPayaraProcessesUnlocked: () => Promise<void>;
  killAllJavaProcessesUnlocked: () => Promise<void>;
  hasJavaProcessesStrict: () => Promise<boolean>;
  getJavaProcessPidsStrict: () => Promise<number[]>;
  processCommandLineMatchesDomain: (commandLine: string) => boolean;
  readProcessCommandLine: (pid: number) => Promise<string>;
  readProcessStat: (pid: number) => Promise<string>;
}

describe('exact Payara DAS process scope', () => {
  const logger = pino({ level: 'silent' });

  function fixture(): {
    manager: PayaraManager;
    internals: ProcessInternals;
    root: string;
    productionRoot: string;
    otherRoot: string;
  } {
    const root = mkdtempSync(join(tmpdir(), 'payara process scope-'));
    const productionRoot = join(root, 'glassfish', 'domains', 'production');
    const otherRoot = join(root, 'glassfish', 'domains', 'production-old');
    mkdirSync(productionRoot, { recursive: true });
    mkdirSync(otherRoot, { recursive: true });
    const manager = new PayaraManager({
      payaraHome: root,
      domain: 'production',
      user: 'payara',
      logger,
      runtimeIdentityProvider: async () => undefined,
      mutationQuarantinePath: false,
    });
    return {
      manager,
      internals: manager as unknown as ProcessInternals,
      root,
      productionRoot,
      otherRoot,
    };
  }

  it('PPS-01: selects only the exact instanceRoot among same-UID Java domains', async () => {
    const { internals, root, productionRoot, otherRoot } = fixture();
    try {
      vi.spyOn(internals, 'execCommand').mockResolvedValue({
        stdout: ' 101 java\n 102 java\n 103 node\n',
        stderr: '',
      });
      vi.spyOn(internals, 'readProcessCommandLine').mockImplementation(async pid => {
        const instanceRoot = pid === 101 ? productionRoot : otherRoot;
        return `java\0-Dcom.sun.aas.instanceRoot=${instanceRoot}\0com.sun.enterprise.glassfish.bootstrap.ASMain\0`;
      });

      await expect(internals.getPayaraProcessPidsStrict()).resolves.toEqual([101]);
      expect(internals.execCommand).toHaveBeenCalledWith(
        '/bin/ps',
        ['-ww', '-axo', 'pid=', '-o', 'comm='],
        5000
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PPS-02: rejects prefix and keyword-only command lines but supports spaces', () => {
    const { internals, root, productionRoot, otherRoot } = fixture();
    try {
      expect(internals.processCommandLineMatchesDomain(
        `java\0-Dcom.sun.aas.instanceRoot=${productionRoot}\0`
      )).toBe(true);
      expect(internals.processCommandLineMatchesDomain(
        `java\0-Dcom.sun.aas.instanceRoot=${otherRoot}\0`
      )).toBe(false);
      expect(internals.processCommandLineMatchesDomain(
        'java\0payara\0glassfish\0production\0'
      )).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PPS-03: spoofed USER cannot bypass the effective-account privilege drop', () => {
    const root = mkdtempSync(join(tmpdir(), 'payara effective user-'));
    const targetUser = userInfo().username === 'payara' ? 'payara-alt' : 'payara';
    const previousUser = process.env.USER;
    const previousLogname = process.env.LOGNAME;
    try {
      const manager = new PayaraManager({
        payaraHome: root,
        domain: 'production',
        user: targetUser,
        logger,
        runtimeIdentityProvider: async () => undefined,
        mutationQuarantinePath: false,
      });
      process.env.USER = targetUser;
      process.env.LOGNAME = targetUser;

      expect((manager as unknown as ProcessInternals).needsSudo()).toBe(true);
    } finally {
      if (previousUser === undefined) delete process.env.USER;
      else process.env.USER = previousUser;
      if (previousLogname === undefined) delete process.env.LOGNAME;
      else process.env.LOGNAME = previousLogname;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PPS-04: malformed ps rows and unreadable procfs fail closed', async () => {
    const malformed = fixture();
    try {
      vi.spyOn(malformed.internals, 'execCommand').mockResolvedValue({
        stdout: 'not-a-process-row\n',
        stderr: '',
      });
      await expect(malformed.internals.getPayaraProcessPidsStrict())
        .rejects.toThrow('BOOT_PROCESS_INVENTORY_UNPARSEABLE');
    } finally {
      rmSync(malformed.root, { recursive: true, force: true });
    }

    const unreadable = fixture();
    try {
      vi.spyOn(unreadable.internals, 'execCommand').mockResolvedValue({
        stdout: ' 101 java\n',
        stderr: '',
      });
      vi.spyOn(unreadable.internals, 'readProcessCommandLine')
        .mockRejectedValue(Object.assign(new Error('hidepid'), { code: 'EACCES' }));
      await expect(unreadable.internals.getPayaraProcessPidsStrict())
        .rejects.toThrow('BOOT_PROCESS_IDENTITY_UNAVAILABLE');
    } finally {
      rmSync(unreadable.root, { recursive: true, force: true });
    }
  });

  it('PPS-05: PID reuse between inventory and TERM fails before signal dispatch', async () => {
    const { internals, root, productionRoot } = fixture();
    const stat = (startTicks: string) =>
      `101 (java) ${['S', ...Array(18).fill('0'), startTicks].join(' ')}`;
    try {
      vi.spyOn(internals, 'execCommand').mockResolvedValue({
        stdout: ' 101 java\n',
        stderr: '',
      });
      vi.spyOn(internals, 'readProcessCommandLine').mockResolvedValue(
        `java\0-Dcom.sun.aas.instanceRoot=${productionRoot}\0` +
        'com.sun.enterprise.glassfish.bootstrap.ASMain\0'
      );
      vi.spyOn(internals, 'readProcessStat')
        .mockResolvedValueOnce(stat('1000'))
        .mockResolvedValueOnce(stat('2000'));
      await expect(internals.killPayaraProcessesUnlocked())
        .rejects.toThrow('BOOT_RUNTIME_PROCESS_CHANGED');
      expect(internals.execCommand).not.toHaveBeenCalledWith(
        expect.stringMatching(/^kill /),
        expect.anything()
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PPS-06: exact PID signals are dispatched through the Payara-user executor', async () => {
    const { internals, root } = fixture();
    vi.useFakeTimers();
    try {
      vi.spyOn(internals, 'getPayaraProcessSnapshotStrict')
        .mockResolvedValueOnce(new Map([[101, '1000']]))
        .mockResolvedValueOnce(new Map([[101, '1000']]));
      vi.spyOn(internals, 'getPayaraProcessPidsStrict').mockResolvedValue([]);
      const payaraExec = vi.spyOn(internals, 'execCommand').mockResolvedValue({
        stdout: '',
        stderr: '',
      });

      const cleanup = internals.killPayaraProcessesUnlocked();
      await vi.runAllTimersAsync();
      await cleanup;

      expect(payaraExec).toHaveBeenCalledWith('/bin/kill', ['-TERM', '101'], 5000);
      expect(payaraExec).not.toHaveBeenCalledWith(
        '/usr/bin/sudo',
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PPS-07: legacy pkill also uses the Payara-user executor', async () => {
    const { internals, root } = fixture();
    vi.useFakeTimers();
    try {
      vi.spyOn(internals, 'hasJavaProcessesStrict').mockResolvedValue(false);
      vi.spyOn(internals, 'getJavaProcessPidsStrict').mockResolvedValue([]);
      const payaraExec = vi.spyOn(internals, 'execCommand').mockResolvedValue({
        stdout: '',
        stderr: '',
      });

      const cleanup = internals.killAllJavaProcessesUnlocked();
      await vi.runAllTimersAsync();
      await cleanup;

      expect(payaraExec).toHaveBeenCalledWith(
        '/usr/bin/pkill',
        ['-u', 'payara', 'java'],
        5000,
        [0, 1]
      );
      expect(payaraExec).not.toHaveBeenCalledWith(
        '/usr/bin/sudo',
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PPS-08: same-uid timeout best-effort kills a TERM-resistant descendant before rejecting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'payara-command-timeout-'));
    const marker = join(root, 'late-side-effect');
    const manager = new PayaraManager({
      payaraHome: root,
      domain: 'production',
      logger,
      runtimeIdentityProvider: async () => undefined,
      mutationQuarantinePath: false,
    });
    const internals = manager as unknown as ProcessInternals;

    try {
      const startedAt = performance.now();
      await expect(internals.execCommand(
        '/bin/bash',
        [
          '-c',
          'trap "" TERM; /bin/sleep 1; /usr/bin/touch -- "$1"',
          'znvault-timeout-test',
          marker,
        ],
        50
      )).rejects.toMatchObject({ name: 'COMMAND_TIMEOUT', code: 'ETIMEDOUT' });
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeLessThan(800);
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
