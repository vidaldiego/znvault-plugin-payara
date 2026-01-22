// Path: test/cli-strategy.test.ts
// Tests for deployment strategy parsing and execution

import { describe, it, expect, vi } from 'vitest';
import {
  parseDeploymentStrategy,
  getStrategyDisplayName,
} from '../src/cli/types.js';
import {
  executeStrategy,
  resolveStrategy,
} from '../src/cli/strategy-executor.js';

describe('Deployment Strategy Parsing', () => {
  describe('parseDeploymentStrategy', () => {
    it('should parse "sequential" strategy', () => {
      const strategy = parseDeploymentStrategy('sequential');
      expect(strategy.name).toBe('sequential');
      expect(strategy.isCanary).toBe(false);
      expect(strategy.batches).toEqual([{ count: 1, label: '1' }]);
    });

    it('should parse "parallel" strategy', () => {
      const strategy = parseDeploymentStrategy('parallel');
      expect(strategy.name).toBe('parallel');
      expect(strategy.isCanary).toBe(false);
      expect(strategy.batches).toEqual([{ count: 'rest', label: 'all' }]);
    });

    it('should parse "1+R" canary strategy', () => {
      const strategy = parseDeploymentStrategy('1+R');
      expect(strategy.name).toBe('1+R');
      expect(strategy.isCanary).toBe(true);
      expect(strategy.batches).toEqual([
        { count: 1, label: '1' },
        { count: 'rest', label: 'rest' },
      ]);
    });

    it('should parse "1+rest" canary strategy (lowercase)', () => {
      const strategy = parseDeploymentStrategy('1+rest');
      expect(strategy.name).toBe('1+rest');
      expect(strategy.isCanary).toBe(true);
      expect(strategy.batches).toEqual([
        { count: 1, label: '1' },
        { count: 'rest', label: 'rest' },
      ]);
    });

    it('should parse "1+2" canary strategy', () => {
      const strategy = parseDeploymentStrategy('1+2');
      expect(strategy.name).toBe('1+2');
      expect(strategy.isCanary).toBe(true);
      expect(strategy.batches).toEqual([
        { count: 1, label: '1' },
        { count: 2, label: '2' },
      ]);
    });

    it('should parse "2+3+R" canary strategy', () => {
      const strategy = parseDeploymentStrategy('2+3+R');
      expect(strategy.name).toBe('2+3+R');
      expect(strategy.isCanary).toBe(true);
      expect(strategy.batches).toEqual([
        { count: 2, label: '2' },
        { count: 3, label: '3' },
        { count: 'rest', label: 'rest' },
      ]);
    });

    it('should handle case insensitivity', () => {
      const strategy = parseDeploymentStrategy('SEQUENTIAL');
      expect(strategy.name).toBe('sequential');
    });

    it('should handle whitespace', () => {
      const strategy = parseDeploymentStrategy('  1 + R  ');
      expect(strategy.batches).toHaveLength(2);
    });

    it('should throw on invalid strategy', () => {
      expect(() => parseDeploymentStrategy('invalid')).toThrow();
    });

    it('should throw on R in middle of strategy', () => {
      expect(() => parseDeploymentStrategy('1+R+2')).toThrow(/only appear at the end/);
    });

    it('should throw on invalid batch count', () => {
      expect(() => parseDeploymentStrategy('1+abc')).toThrow(/Invalid batch count/);
    });

    it('should throw on zero batch count', () => {
      expect(() => parseDeploymentStrategy('0+1')).toThrow(/positive number/);
    });
  });

  describe('getStrategyDisplayName', () => {
    it('should return name for non-canary strategy', () => {
      const strategy = parseDeploymentStrategy('sequential');
      expect(getStrategyDisplayName(strategy)).toBe('sequential');
    });

    it('should return "canary (X)" for canary strategy', () => {
      const strategy = parseDeploymentStrategy('1+R');
      expect(getStrategyDisplayName(strategy)).toBe('canary (1+R)');
    });
  });
});

describe('Strategy Resolution', () => {
  describe('resolveStrategy', () => {
    it('should prioritize explicit --strategy flag', () => {
      expect(resolveStrategy({
        strategy: '1+R',
        sequential: true,
        configStrategy: 'parallel',
        configParallel: true,
      })).toBe('1+R');
    });

    it('should use --sequential flag over config', () => {
      expect(resolveStrategy({
        sequential: true,
        configStrategy: 'parallel',
        configParallel: true,
      })).toBe('sequential');
    });

    it('should use config.strategy over config.parallel', () => {
      expect(resolveStrategy({
        configStrategy: '1+R',
        configParallel: true,
      })).toBe('1+R');
    });

    it('should convert config.parallel=true to "parallel"', () => {
      expect(resolveStrategy({
        configParallel: true,
      })).toBe('parallel');
    });

    it('should convert config.parallel=false to "sequential"', () => {
      expect(resolveStrategy({
        configParallel: false,
      })).toBe('sequential');
    });

    it('should default to "sequential"', () => {
      expect(resolveStrategy({})).toBe('sequential');
    });
  });
});

describe('Strategy Execution', () => {
  describe('executeStrategy', () => {
    it('should execute sequential strategy one at a time', async () => {
      const strategy = parseDeploymentStrategy('sequential');
      const hosts = ['host1', 'host2', 'host3'];
      const callOrder: string[] = [];

      const deployFn = vi.fn(async (host: string) => {
        callOrder.push(host);
        return { success: true };
      });

      const result = await executeStrategy(strategy, hosts, deployFn);

      expect(result.successful).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(callOrder).toEqual(['host1', 'host2', 'host3']);
    });

    it('should execute parallel strategy all at once', async () => {
      const strategy = parseDeploymentStrategy('parallel');
      const hosts = ['host1', 'host2', 'host3'];

      const deployFn = vi.fn(async () => ({ success: true }));

      const result = await executeStrategy(strategy, hosts, deployFn);

      expect(result.successful).toBe(3);
      expect(result.failed).toBe(0);
      expect(deployFn).toHaveBeenCalledTimes(3);
    });

    it('should execute 1+R canary: first one, then rest', async () => {
      const strategy = parseDeploymentStrategy('1+R');
      const hosts = ['host1', 'host2', 'host3'];
      const batchCalls: number[][] = [];
      let currentBatch = 0;

      const deployFn = vi.fn(async (host: string) => {
        const hostIndex = hosts.indexOf(host);
        if (!batchCalls[currentBatch]) batchCalls[currentBatch] = [];
        batchCalls[currentBatch].push(hostIndex);
        return { success: true };
      });

      // Mock progress to track batch boundaries
      const progress = {
        showBatchHeader: vi.fn(() => { currentBatch++; }),
        showBatchResult: vi.fn(),
        showCanaryAbort: vi.fn(),
      };

      const result = await executeStrategy(strategy, hosts, deployFn, { progress: progress as any });

      expect(result.successful).toBe(3);
      expect(result.failed).toBe(0);
      // First batch should have 1 host, second batch should have 2
      expect(batchCalls[1]).toHaveLength(1); // First host
      expect(batchCalls[2]).toHaveLength(2); // Remaining hosts
    });

    it('should abort canary on failure and skip remaining hosts', async () => {
      const strategy = parseDeploymentStrategy('1+R');
      const hosts = ['host1', 'host2', 'host3'];

      const deployFn = vi.fn(async (host: string) => {
        if (host === 'host1') {
          return { success: false, error: 'Test failure' };
        }
        return { success: true };
      });

      const result = await executeStrategy(strategy, hosts, deployFn, { abortOnFailure: true });

      expect(result.successful).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(2);
      expect(result.aborted).toBe(true);
      expect(result.failedBatch).toBe(1);
      // Should only deploy to host1
      expect(deployFn).toHaveBeenCalledTimes(1);
    });

    it('should continue non-canary strategy on failure', async () => {
      const strategy = parseDeploymentStrategy('sequential');
      const hosts = ['host1', 'host2', 'host3'];

      const deployFn = vi.fn(async (host: string) => {
        if (host === 'host2') {
          return { success: false, error: 'Test failure' };
        }
        return { success: true };
      });

      // For non-canary, abortOnFailure is typically false
      const result = await executeStrategy(strategy, hosts, deployFn, { abortOnFailure: false });

      expect(result.successful).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.aborted).toBe(false);
      // Should deploy to all hosts
      expect(deployFn).toHaveBeenCalledTimes(3);
    });

    it('should handle 2+3+R strategy correctly', async () => {
      const strategy = parseDeploymentStrategy('2+3+R');
      const hosts = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'];
      let batchNumber = 0;
      const batchSizes: number[] = [];

      const progress = {
        showBatchHeader: vi.fn((_, __, hostCount) => {
          batchNumber++;
          batchSizes.push(hostCount);
        }),
        showBatchResult: vi.fn(),
        showCanaryAbort: vi.fn(),
      };

      const deployFn = vi.fn(async () => ({ success: true }));

      await executeStrategy(strategy, hosts, deployFn, { progress: progress as any });

      // Should have 3 batches: 2, 3, and rest (3)
      expect(batchSizes).toEqual([2, 3, 3]);
      expect(deployFn).toHaveBeenCalledTimes(8);
    });

    it('should handle more batches than hosts', async () => {
      const strategy = parseDeploymentStrategy('2+3+R');
      const hosts = ['h1', 'h2']; // Only 2 hosts

      const deployFn = vi.fn(async () => ({ success: true }));

      const result = await executeStrategy(strategy, hosts, deployFn);

      // First batch takes all 2 hosts, other batches have 0 hosts
      expect(result.successful).toBe(2);
      expect(deployFn).toHaveBeenCalledTimes(2);
    });
  });
});
