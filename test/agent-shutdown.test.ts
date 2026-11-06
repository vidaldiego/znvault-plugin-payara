import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayaraManager } from '../src/payara-manager.js';

describe('managed agent shutdown', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'agent-shutdown-'));
    roots.push(root);
    const manager = new PayaraManager({
      payaraHome: root, domain: 'production', logger: pino({ level: 'silent' }),
      runtimeIdentityProvider: async () => 'owned-runtime', mutationQuarantinePath: false,
    });
    manager.registerApplication('TestApp');
    const internals = manager as unknown as {
      monotonicNowMs(): number;
      isRunningStrict(timeout?: number): Promise<boolean>;
      asadminCommand(args: string[], timeout?: number): Promise<string>;
      waitForStopped(timeout: number): Promise<void>;
      getPayaraProcessPidsStrict(): Promise<number[]>;
      bootDeploymentStates: Map<string, { mutationOutcomeUnknown: boolean }>;
    };
    vi.spyOn(internals, 'monotonicNowMs').mockReturnValue(0);
    vi.spyOn(internals, 'isRunningStrict').mockResolvedValue(true);
    const command = vi.spyOn(internals, 'asadminCommand').mockResolvedValue('stopped');
    const wait = vi.spyOn(internals, 'waitForStopped').mockResolvedValue();
    return { manager, internals, command, wait };
  }
  it('gracefully stops an owned domain while application readiness is still fenced', async () => {
    const { manager, command, wait } = fixture();
    await expect(manager.stop({ agentShutdown: true, timeoutMs: 45000 })).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledWith(['stop-domain', '--timeout=30', 'production'], 35000);
    expect(wait).toHaveBeenCalledWith(30000);
    expect(manager.getBootDeploymentStatus('TestApp').phase).not.toBe('ready');
  });
  it('refuses shutdown mutation when a prior application mutation has unknown outcome', async () => {
    const { manager, internals, command } = fixture();
    internals.bootDeploymentStates.get('TestApp')!.mutationOutcomeUnknown = true;
    await expect(manager.stop({ agentShutdown: true, timeoutMs: 45000 }))
      .rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
    expect(command).not.toHaveBeenCalled();
  });
  it('caps final process confirmation to the remaining shutdown budget', async () => {
    const { manager, internals, command, wait } = fixture();
    let now = 0;
    vi.spyOn(internals, 'monotonicNowMs').mockImplementation(() => now);
    command.mockImplementation(async () => { now = 42000; return 'stopped'; });
    await manager.stop({ agentShutdown: true, timeoutMs: 45000 });
    expect(wait).toHaveBeenCalledWith(3000);
  });
  it('does not report an unknown mutation when the dispatch budget expires before sending stop', async () => {
    const { manager, command } = fixture();
    const failure = await manager.stop({ agentShutdown: true, timeoutMs: 1000 })
      .catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Insufficient agent shutdown dispatch budget');
    expect(failure.name).toBe('Error');
    expect(command).not.toHaveBeenCalled();
  });

  it('waits for an already stopping JVM without issuing a second stop command', async () => {
    const { manager, internals, command, wait } = fixture();
    vi.spyOn(internals, 'isRunningStrict').mockResolvedValue(false);
    vi.spyOn(internals, 'getPayaraProcessPidsStrict').mockResolvedValue([101]);
    await expect(manager.stop({ agentShutdown: true, timeoutMs: 45000 })).resolves.toBeUndefined();
    expect(command).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalled();
  });
});
