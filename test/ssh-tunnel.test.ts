// Path: test/ssh-tunnel.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExistsSync = vi.fn();
vi.mock('node:fs', () => ({ existsSync: (...a: unknown[]) => mockExistsSync(...a) }));

const { resolveZnvaultBin } = await import('../src/cli/ssh-tunnel.js');

describe('resolveZnvaultBin', () => {
  const origEnv = process.env.ZNVAULT_BIN;
  beforeEach(() => { vi.clearAllMocks(); delete process.env.ZNVAULT_BIN; });
  afterEach(() => { if (origEnv === undefined) delete process.env.ZNVAULT_BIN; else process.env.ZNVAULT_BIN = origEnv; });

  it('prefers ZNVAULT_BIN when set and existing', () => {
    process.env.ZNVAULT_BIN = '/custom/znvault';
    mockExistsSync.mockImplementation((p: string) => p === '/custom/znvault');
    expect(resolveZnvaultBin()).toBe('/custom/znvault');
  });

  it('falls back to bare "znvault" when nothing else resolves', () => {
    mockExistsSync.mockReturnValue(false);
    expect(resolveZnvaultBin()).toBe('znvault');
  });
});
