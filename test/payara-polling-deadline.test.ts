import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayaraManager } from '../src/payara-manager.js';

const logger = pino({ level: 'silent' });

interface PollingInternals {
  monotonicNowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  waitForHealthy: (timeoutMs: number) => Promise<void>;
  waitForRunning: (timeoutMs: number) => Promise<void>;
}

function makeManager(options: { healthEndpoint?: string; healthCheckTimeout?: number } = {}): PayaraManager {
  return new PayaraManager({
    payaraHome: '/tmp/payara-polling-deadline-test',
    domain: 'production',
    user: process.env.USER ?? 'test',
    logger,
    runtimeIdentityProvider: async () => 1000,
    runtimeIdentitySyncProvider: () => 1000,
    mutationQuarantinePath: false,
    ...options,
  });
}

function internals(manager: PayaraManager): PollingInternals {
  return manager as unknown as PollingInternals;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Payara lifecycle polling deadlines', () => {
  it('POLL-01: running probes and sleeps share one monotonic deadline', async () => {
    const manager = makeManager();
    let monotonicMs = 100;
    let wallClockMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wallClockMs);
    vi.spyOn(internals(manager), 'monotonicNowMs').mockImplementation(() => monotonicMs);
    const running = vi.spyOn(manager, 'isRunning').mockImplementation(async () => {
      wallClockMs += 10_000_000;
      return false;
    });
    const sleep = vi.spyOn(internals(manager), 'sleep').mockImplementation(async ms => {
      monotonicMs += ms;
    });

    await expect(internals(manager).waitForRunning(2501))
      .rejects.toThrow('Payara domain did not become ready within 2501ms');

    expect(running.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([2501, 1501, 501]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 1000, 501]);
    expect(monotonicMs).toBe(2601);
  });

  it('POLL-02: a final 1ms budget is slept exactly once and never starts another probe', async () => {
    const manager = makeManager();
    let monotonicMs = 0;
    vi.spyOn(internals(manager), 'monotonicNowMs').mockImplementation(() => monotonicMs);
    const healthy = vi.spyOn(manager, 'isHealthy').mockImplementation(async () => {
      monotonicMs += 2;
      return false;
    });
    const sleep = vi.spyOn(internals(manager), 'sleep').mockImplementation(async ms => {
      monotonicMs += ms;
    });

    await expect(internals(manager).waitForHealthy(3))
      .rejects.toThrow('Payara did not become healthy within 3ms');

    expect(healthy).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledWith(3);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1);
    expect(monotonicMs).toBe(3);
  });

  it('POLL-03: a condition that reports success after the deadline is rejected', async () => {
    const manager = makeManager();
    let monotonicMs = 0;
    vi.spyOn(internals(manager), 'monotonicNowMs').mockImplementation(() => monotonicMs);
    const running = vi.spyOn(manager, 'isRunning').mockImplementation(async () => {
      monotonicMs = 11;
      return true;
    });
    const sleep = vi.spyOn(internals(manager), 'sleep');

    await expect(internals(manager).waitForRunning(10))
      .rejects.toThrow('Payara domain did not become ready within 10ms');

    expect(running).toHaveBeenCalledWith(10);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('POLL-04: a health HTTP probe aborts at the caller remaining budget', async () => {
    vi.useFakeTimers();
    const manager = makeManager({
      healthEndpoint: 'http://127.0.0.1:1/health',
      healthCheckTimeout: 30_000,
    });
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      observedSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          'abort',
          () => reject(new Error('aborted at polling deadline')),
          { once: true }
        );
      });
    });

    const probe = manager.isHealthy(7);
    await vi.advanceTimersByTimeAsync(6);
    expect(observedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(probe).resolves.toBe(false);
    expect(observedSignal?.aborted).toBe(true);
  });
});
