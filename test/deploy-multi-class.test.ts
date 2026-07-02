// Path: test/deploy-multi-class.test.ts
import { describe, it, expect, vi } from 'vitest';
import { executeMultiClassDeployment, classGateFailed } from '../src/cli/multi-class-deploy.js';
import type { ResolvedClass } from '../src/cli/deploy-class.js';
import type { DeployContext } from '../src/cli/listr-deploy.js';

function ctx(partial: Partial<DeployContext>): DeployContext {
  return { results: new Map(), aborted: false, skipped: 0, successful: 0, failed: 0, healthCheckFailed: 0, workerFailed: 0, ...partial };
}
// runClass now resolves to { ctx, coverageOk }; these tests exercise the gate,
// not coverage, so wrap the DeployContext with coverageOk:true.
function run1(partial: Partial<DeployContext>) {
  return { ctx: ctx(partial), coverageOk: true };
}
function rc(name: string, blocking: boolean, hosts = ['.1']): ResolvedClass {
  return { name, hosts, blocking } as ResolvedClass;
}
const log = () => ({ warn: vi.fn(), info: vi.fn() });

describe('classGateFailed', () => {
  it('fails on failed>0, aborted, or healthCheckFailed>0; NOT on workerFailed', () => {
    expect(classGateFailed(ctx({ failed: 1 }))).toBe(true);
    expect(classGateFailed(ctx({ aborted: true }))).toBe(true);
    expect(classGateFailed(ctx({ healthCheckFailed: 1 }))).toBe(true);
    expect(classGateFailed(ctx({ workerFailed: 1 }))).toBe(false);
    expect(classGateFailed(ctx({ successful: 3 }))).toBe(false);
  });
});

describe('executeMultiClassDeployment', () => {
  it('runs classes in order and records every ran class', async () => {
    const order: string[] = [];
    const run = vi.fn(async (c: ResolvedClass) => { order.push(c.name); return run1({ successful: 1 }); });
    const result = await executeMultiClassDeployment([rc('api', true), rc('worker', false)], run, log());
    expect(order).toEqual(['api', 'worker']);
    expect(result.abortedAt).toBeUndefined();
    expect(result.classes.map(c => [c.name, c.ran])).toEqual([['api', true], ['worker', true]]);
  });

  it('blocking failure aborts downstream; worker never runs; recorded upstream-abort', async () => {
    const run = vi.fn(async (c: ResolvedClass) => c.name === 'api' ? run1({ failed: 1 }) : run1({ successful: 1 }));
    const result = await executeMultiClassDeployment([rc('api', true), rc('worker', false)], run, log());
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.abortedAt).toBe('api');
    const worker = result.classes.find(c => c.name === 'worker')!;
    expect(worker.ran).toBe(false);
    expect(worker.skippedReason).toBe('upstream-abort');
  });

  it('blocking gate FAILS on healthCheckFailed (parallel-strategy serving health fail)', async () => {
    const run = vi.fn(async (c: ResolvedClass) => c.name === 'api' ? run1({ healthCheckFailed: 1 }) : run1({ successful: 1 }));
    const result = await executeMultiClassDeployment([rc('api', true), rc('worker', false)], run, log());
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.abortedAt).toBe('api');
  });

  it('non-blocking failure continues; overall not aborted; warns', async () => {
    const l = log();
    const run = vi.fn(async (c: ResolvedClass) => c.name === 'worker' ? run1({ failed: 1 }) : run1({ successful: 1 }));
    const result = await executeMultiClassDeployment([rc('api', true), rc('worker', false)], run, l);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.abortedAt).toBeUndefined();
    expect(l.warn).toHaveBeenCalled();
  });

  it('blocking class passes the gate despite internal workerFailed', async () => {
    const run = vi.fn(async (c: ResolvedClass) => c.name === 'api' ? run1({ failed: 0, aborted: false, healthCheckFailed: 0, workerFailed: 1 }) : run1({ successful: 1 }));
    const result = await executeMultiClassDeployment([rc('api', true), rc('worker', false)], run, log());
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.abortedAt).toBeUndefined();
  });

  it('empty-hosts class is skipped (no-hosts), never gates, downstream still runs', async () => {
    const run = vi.fn(async () => run1({ successful: 1 }));
    const result = await executeMultiClassDeployment([rc('ai', true, []), rc('api', true)], run, log());
    expect(run).toHaveBeenCalledTimes(1); // only api ran
    const ai = result.classes.find(c => c.name === 'ai')!;
    expect(ai.ran).toBe(false);
    expect(ai.skippedReason).toBe('no-hosts');
    expect(result.abortedAt).toBeUndefined();
  });
});
