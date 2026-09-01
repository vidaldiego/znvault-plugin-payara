import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentLock, type LockData } from '../src/deployment-lock.js';

describe('DeploymentLock', () => {
  const logger = pino({ level: 'silent' });
  let testDir: string;
  let lockPath: string;
  let locks: DeploymentLock[];

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'znvault-deployment-lock-'));
    lockPath = join(testDir, 'deploy.lock');
    locks = [];
  });

  afterEach(async () => {
    for (const lock of locks) {
      await lock.release();
    }
    // Production keeps shutdown intent sticky for the process lifetime. Tests
    // share one worker process, so reset only after every participant released.
    const coordinator = (
      globalThis as typeof globalThis & Record<symbol, {
        participants: Set<symbol>;
        pendingSignal: NodeJS.Signals | null;
        replayTimer: ReturnType<typeof setTimeout> | null;
        shutdownRequested: boolean;
        replayed: boolean;
      } | undefined>
    )[Symbol.for('@zincapp/znvault-mutation-signal-deferral/v1')];
    if (coordinator?.replayTimer) clearTimeout(coordinator.replayTimer);
    if (coordinator && coordinator.participants.size === 0) {
      coordinator.pendingSignal = null;
      coordinator.replayTimer = null;
      coordinator.shutdownRequested = false;
      coordinator.replayed = false;
    }
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  const makeLock = (): DeploymentLock => {
    const lock = new DeploymentLock(logger, lockPath);
    locks.push(lock);
    return lock;
  };

  const readLock = async (): Promise<LockData> =>
    JSON.parse(await readFile(lockPath, 'utf8')) as LockData;

  const makeGate = (): {
    entered: Promise<void>;
    markEntered: () => void;
    resume: Promise<void>;
    release: () => void;
  } => {
    let markEntered = (): void => undefined;
    let release = (): void => undefined;
    return {
      entered: new Promise<void>(resolve => { markEntered = resolve; }),
      markEntered: () => markEntered(),
      resume: new Promise<void>(resolve => { release = resolve; }),
      release: () => release(),
    };
  };

  it('allows exactly one winner when two processes contend for an empty path', async () => {
    const first = makeLock();
    const second = makeLock();

    const results = await Promise.allSettled([
      first.acquire('deployment-a'),
      second.acquire('deployment-b'),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect([first.isAcquired(), second.isAcquired()].filter(Boolean)).toHaveLength(1);

    const stored = await readLock();
    expect(stored.ownerToken).toEqual(expect.any(String));
    expect(stored.deploymentId).toBe(first.isAcquired() ? 'deployment-a' : 'deployment-b');
  });

  it('does not evict a live deployment solely because it is older than ten minutes', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        started: Date.now() - 700_000,
        deploymentId: 'long-running-deployment',
        step: 'deploy',
      } satisfies LockData)
    );

    const first = makeLock();
    const second = makeLock();
    const results = await Promise.allSettled([
      first.acquire('replacement-a'),
      second.acquire('replacement-b'),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(0);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(2);
    const stored = await readLock();
    expect(stored.deploymentId).toBe('long-running-deployment');
    const inspection = await first.isLocked();
    expect(inspection).toMatchObject({ locked: true });
    expect(inspection).not.toHaveProperty('stale');
  });

  it('reports a dead-owner lock as stale but refuses automatic takeover', async () => {
    const deadPid = 987654321;
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid && signal === 0) {
        throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      }
      return true;
    });
    const stale: LockData = {
      pid: deadPid,
      started: Date.now() - 700_000,
      deploymentId: 'dead-owner-deployment',
      step: 'deploy',
      ownerToken: 'dead-owner-token',
    };
    await writeFile(lockPath, JSON.stringify(stale));

    const contender = makeLock();

    await expect(contender.isLocked()).resolves.toMatchObject({
      locked: false,
      stale: true,
      data: stale,
    });
    await expect(contender.acquire('replacement'))
      .rejects.toThrow('STALE_DEPLOYMENT_LOCK');
    expect(await readLock()).toEqual(stale);
  });

  it('updates the acquired inode and removes it on a normal release', async () => {
    const lock = makeLock();
    await lock.acquire('owned-deployment');
    const ownerToken = (await readLock()).ownerToken;

    await lock.updateStep('verify');

    expect(await readLock()).toMatchObject({
      deploymentId: 'owned-deployment',
      ownerToken,
      step: 'verify',
    });

    await lock.release();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite a successor lock when the old owner updates its step', async () => {
    const oldOwner = makeLock();
    await oldOwner.acquire('same-deployment-id');

    await rm(lockPath);
    const successor: LockData = {
      pid: process.pid,
      started: Date.now(),
      deploymentId: 'same-deployment-id',
      step: 'start',
      ownerToken: 'successor-owner-token',
    };
    await writeFile(lockPath, JSON.stringify(successor));

    await expect(oldOwner.updateStep('verify'))
      .rejects.toThrow('DEPLOYMENT_LOCK_LOST');
    await expect(oldOwner.release()).rejects.toThrow('DEPLOYMENT_LOCK_LOST');

    expect(await readLock()).toEqual(successor);
  });

  it('does not delete a successor lock when the old owner releases', async () => {
    const oldOwner = makeLock();
    await oldOwner.acquire('same-deployment-id');

    await rm(lockPath);
    const successor: LockData = {
      pid: process.pid,
      started: Date.now(),
      deploymentId: 'same-deployment-id',
      step: 'start',
      ownerToken: 'successor-owner-token',
    };
    await writeFile(lockPath, JSON.stringify(successor));

    await expect(oldOwner.release()).rejects.toThrow('DEPLOYMENT_LOCK_LOST');

    expect(await readLock()).toEqual(successor);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'defers %s and restores every previous listener before re-sending it',
    async signal => {
      const firstHandler = vi.fn();
      const secondHandler = vi.fn();
      process.on(signal, firstHandler);
      process.on(signal, secondHandler);
      const beforeAcquire = process.listeners(signal);
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      const lock = makeLock();

      try {
        await lock.acquire('signal-safe-deployment');
        process.emit(signal, signal);

        expect(lock.isPendingShutdown()).toBe(true);
        expect(firstHandler).not.toHaveBeenCalled();
        expect(secondHandler).not.toHaveBeenCalled();

        await lock.release();
        expect(process.listeners(signal)).toEqual(beforeAcquire);

        await new Promise(resolve => setTimeout(resolve, 120));
        expect(killSpy).toHaveBeenCalledWith(process.pid, signal);
      } finally {
        process.removeListener(signal, firstHandler);
        process.removeListener(signal, secondHandler);
      }
    }
  );

  it.each(['release', 'quarantine'] as const)(
    'defers SIGTERM after O_EXCL during initialization, then %ss safely and replays once',
    async completion => {
      const originalHandler = vi.fn();
      process.on('SIGTERM', originalHandler);
      const beforeAcquire = process.listeners('SIGTERM');
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      const lock = makeLock();
      const gate = makeGate();
      const internals = lock as unknown as {
        writeHandle(handle: unknown, data: LockData): Promise<void>;
      };
      const originalWrite = internals.writeHandle.bind(lock);
      vi.spyOn(internals, 'writeHandle').mockImplementation(async (handle, data) => {
        gate.markEntered();
        await gate.resume;
        await originalWrite(handle, data);
      });

      try {
        const acquisition = lock.acquire(`initializing-${completion}`);
        await gate.entered;
        await expect(stat(lockPath)).resolves.toBeDefined();

        process.emit('SIGTERM', 'SIGTERM');
        expect(lock.isPendingShutdown()).toBe(true);
        expect(originalHandler).not.toHaveBeenCalled();
        expect(killSpy).not.toHaveBeenCalled();

        gate.release();
        await acquisition;
        if (completion === 'release') {
          await lock.release();
          await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          await lock.quarantine('deterministic initialization signal test');
          await expect(readLock()).resolves.toMatchObject({
            deploymentId: 'initializing-quarantine',
            quarantined: true,
          });
        }

        expect(originalHandler).not.toHaveBeenCalled();
        expect(process.listeners('SIGTERM')).toEqual(beforeAcquire);
        await new Promise(resolve => setTimeout(resolve, 120));
        expect(killSpy).toHaveBeenCalledTimes(1);
        expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      } finally {
        gate.release();
        process.removeListener('SIGTERM', originalHandler);
      }
    }
  );

  it('cleans a failed initialization before replaying its deferred SIGTERM once', async () => {
    const originalHandler = vi.fn();
    process.on('SIGTERM', originalHandler);
    const beforeAcquire = process.listeners('SIGTERM');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const lock = makeLock();
    const gate = makeGate();
    const internals = lock as unknown as {
      writeHandle(handle: unknown, data: LockData): Promise<void>;
    };
    vi.spyOn(internals, 'writeHandle').mockImplementation(async () => {
      gate.markEntered();
      await gate.resume;
      throw new Error('injected initialization failure');
    });

    try {
      const acquisition = lock.acquire('failed-initialization');
      await gate.entered;
      process.emit('SIGTERM', 'SIGTERM');
      expect(originalHandler).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();

      gate.release();
      await expect(acquisition).rejects.toThrow('injected initialization failure');
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(process.listeners('SIGTERM')).toEqual(beforeAcquire);

      await new Promise(resolve => setTimeout(resolve, 120));
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      gate.release();
      process.removeListener('SIGTERM', originalHandler);
    }
  });

  it('restores handlers and replays once when EEXIST rejects acquisition', async () => {
    const existing: LockData = {
      pid: process.pid,
      started: Date.now(),
      deploymentId: 'existing-live-owner',
      step: 'deploy',
      ownerToken: 'existing-live-owner-token',
    };
    await writeFile(lockPath, JSON.stringify(existing));
    const originalHandler = vi.fn();
    process.on('SIGTERM', originalHandler);
    const beforeAcquire = process.listeners('SIGTERM');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const lock = makeLock();
    const gate = makeGate();
    const internals = lock as unknown as {
      handleExistingLock(attempt: number): Promise<boolean>;
    };
    const originalHandleExisting = internals.handleExistingLock.bind(lock);
    vi.spyOn(internals, 'handleExistingLock').mockImplementation(async attempt => {
      gate.markEntered();
      await gate.resume;
      return originalHandleExisting(attempt);
    });

    try {
      const acquisition = lock.acquire('contender');
      await gate.entered;
      process.emit('SIGTERM', 'SIGTERM');
      expect(originalHandler).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();

      gate.release();
      await expect(acquisition).rejects.toThrow('Deployment already in progress');
      expect(await readLock()).toEqual(existing);
      expect(process.listeners('SIGTERM')).toEqual(beforeAcquire);

      await new Promise(resolve => setTimeout(resolve, 120));
      // The liveness inspection also probes the recorded PID with signal 0.
      const replayCalls = killSpy.mock.calls.filter(([, signal]) => signal === 'SIGTERM');
      expect(replayCalls).toEqual([[process.pid, 'SIGTERM']]);
    } finally {
      gate.release();
      process.removeListener('SIGTERM', originalHandler);
    }
  });

  it('keeps one process-wide gate across release-to-successor handoff', async () => {
    const originalHandler = vi.fn();
    process.on('SIGTERM', originalHandler);
    const beforeAcquire = process.listeners('SIGTERM');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const first = makeLock();
    const second = makeLock();
    await first.acquire('handoff-first');
    const gate = makeGate();
    const internals = first as unknown as {
      readSnapshotAt(filePath: string): Promise<unknown>;
    };
    const originalReadSnapshotAt = internals.readSnapshotAt.bind(first);
    vi.spyOn(internals, 'readSnapshotAt').mockImplementation(async filePath => {
      if (filePath.includes('.released-')) {
        gate.markEntered();
        await gate.resume;
      }
      return originalReadSnapshotAt(filePath);
    });

    try {
      const firstRelease = first.release();
      await gate.entered;
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await second.acquire('handoff-second');
      process.emit('SIGTERM', 'SIGTERM');
      expect(originalHandler).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();

      gate.release();
      await firstRelease;
      expect(process.listeners('SIGTERM')).not.toContain(originalHandler);
      expect(killSpy).not.toHaveBeenCalled();

      await second.release();
      expect(process.listeners('SIGTERM')).toEqual(beforeAcquire);
      expect(process.listeners('SIGTERM').filter(listener => listener === originalHandler))
        .toHaveLength(1);

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      gate.release();
      process.removeListener('SIGTERM', originalHandler);
    }
  });

  it('rejects a new acquisition while deferred shutdown awaits replay', async () => {
    const originalHandler = vi.fn();
    process.on('SIGTERM', originalHandler);
    const beforeAcquire = process.listeners('SIGTERM');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const first = makeLock();
    const contender = makeLock();

    try {
      await first.acquire('shutdown-first');
      process.emit('SIGTERM', 'SIGTERM');
      await first.release();

      const contenderAcquisition = contender.acquire('shutdown-contender');
      expect(killSpy).not.toHaveBeenCalled();
      await expect(contenderAcquisition)
        .rejects.toThrow('DEPLOYMENT_SHUTDOWN_PENDING');
      expect(contender.isAcquired()).toBe(false);
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(process.listeners('SIGTERM')).toEqual(beforeAcquire);

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');

      await Promise.resolve();
      const afterReplay = makeLock();
      await expect(afterReplay.acquire('after-replay-contender'))
        .rejects.toThrow('DEPLOYMENT_SHUTDOWN_PENDING');
      expect(afterReplay.isAcquired()).toBe(false);
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(killSpy).toHaveBeenCalledTimes(1);
    } finally {
      process.removeListener('SIGTERM', originalHandler);
    }
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'preserves %s listeners added while acquired and restores originals without duplicates',
    async signal => {
      const originalHandler = vi.fn();
      const laterHandler = vi.fn();
      process.on(signal, originalHandler);
      const lock = makeLock();

      try {
        await lock.acquire('listener-race-deployment');
        process.on(signal, laterHandler);
        // Simulate another component independently restoring the same original
        // while this lock still owns its deferral listener.
        process.on(signal, originalHandler);

        await lock.release();

        const listeners = process.listeners(signal);
        expect(listeners.filter(listener => listener === originalHandler)).toHaveLength(1);
        expect(listeners.filter(listener => listener === laterHandler)).toHaveLength(1);
      } finally {
        process.removeListener(signal, originalHandler);
        process.removeListener(signal, laterHandler);
      }
    }
  );

  it('retains lifecycle quarantine but still restores and re-sends deferred SIGTERM', async () => {
    const originalHandler = vi.fn();
    process.on('SIGTERM', originalHandler);
    const beforeAcquire = process.listeners('SIGTERM');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const lock = makeLock();

    try {
      await lock.acquire('ambiguous-lifecycle');
      await lock.updateStep('deploy');
      process.emit('SIGTERM', 'SIGTERM');
      expect(lock.isPendingShutdown()).toBe(true);

      await lock.quarantine('start-domain timed out after dispatch');
      expect(lock.isAcquired()).toBe(false);
      expect(process.listeners('SIGTERM')).toEqual(beforeAcquire);
      await expect(readLock()).resolves.toMatchObject({
        deploymentId: 'ambiguous-lifecycle',
        step: 'deploy',
      });

      await new Promise(resolve => setTimeout(resolve, 120));
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      process.removeListener('SIGTERM', originalHandler);
    }
  });
});
