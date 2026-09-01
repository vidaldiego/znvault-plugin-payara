import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import type { PluginContext } from '@zincapp/zn-vault-agent/plugins';
import {
  assertApiKeyPermissionContract,
  fetchSecrets,
  writeApiKeyToFile,
} from '../src/secrets-handler.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'payara-api-key-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true })
    )
  );
  vi.clearAllMocks();
});

describe('writeApiKeyToFile', () => {
  it('atomically replaces the key with durable permissions and no temp residue', async () => {
    const directory = await createTemporaryDirectory();
    const keyPath = join(directory, 'nested', 'api-key.txt');
    const account = userInfo().username;

    await writeApiKeyToFile(keyPath, 'first-secret-value', logger as never, account);
    await writeApiKeyToFile(keyPath, 'second-secret-value', logger as never, account);

    expect(await readFile(keyPath, 'utf8')).toBe('second-secret-value');
    expect((await stat(keyPath)).mode & 0o777).toBe(0o640);
    expect((await stat(join(directory, 'nested'))).mode & 0o7777).toBe(0o2750);
    expect(await readdir(join(directory, 'nested'))).toEqual(['api-key.txt']);
  });

  it('models distinct Agent and Payara users over one read-only shared group', () => {
    const agent = { uid: 1001, primaryGid: 1001, gids: [1001, 2000] };
    const payara = { uid: 1002, primaryGid: 2000, gids: [2000] };

    expect(() => assertApiKeyPermissionContract(
      { uid: 1001, gid: 2000, mode: 0o2750 },
      { uid: 1001, gid: 2000, mode: 0o640 },
      agent,
      payara
    )).not.toThrow();
  });

  it('fails closed when Agent or Payara is outside the shared group contract', () => {
    const directory = { uid: 1001, gid: 2000, mode: 0o2750 };
    const file = { uid: 1001, gid: 2000, mode: 0o640 };

    expect(() => assertApiKeyPermissionContract(
      directory,
      file,
      { uid: 1001, primaryGid: 1001, gids: [1001] },
      { uid: 1002, primaryGid: 2000, gids: [2000] }
    )).toThrow(/Agent process is not a member/);

    expect(() => assertApiKeyPermissionContract(
      directory,
      file,
      { uid: 1001, primaryGid: 1001, gids: [1001, 2000] },
      { uid: 1002, primaryGid: 3000, gids: [3000] }
    )).toThrow(/directory group is not Payara primary group/);
  });

  it('rejects group-write or missing-setgid permission drift', () => {
    const agent = { uid: 1001, primaryGid: 1001, gids: [1001, 2000] };
    const payara = { uid: 1002, primaryGid: 2000, gids: [2000] };

    expect(() => assertApiKeyPermissionContract(
      { uid: 1001, gid: 2000, mode: 0o2770 },
      { uid: 1001, gid: 2000, mode: 0o660 },
      agent,
      payara
    )).toThrow(/directory mode must be exactly 2750/);
  });

  it('rejects unsafe ownership input before creating the target directory', async () => {
    const directory = await createTemporaryDirectory();
    const keyPath = join(directory, 'not-created', 'api-key.txt');

    await expect(
      writeApiKeyToFile(keyPath, 'secret', logger as never, 'payara;id')
    ).rejects.toThrow('Invalid Payara Unix account name');

    await expect(readdir(join(directory, 'not-created'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('concurrent readers observe only the complete old or new key', async () => {
    const directory = await createTemporaryDirectory();
    const keyPath = join(directory, 'api-key.txt');
    const oldKey = `old-${'a'.repeat(32 * 1024)}`;
    const newKey = `new-${'b'.repeat(32 * 1024)}`;
    const account = userInfo().username;
    await writeApiKeyToFile(keyPath, oldKey, logger as never, account);

    let reading = true;
    const observed = new Set<string>();
    const reader = (async () => {
      while (reading) {
        observed.add(await readFile(keyPath, 'utf8'));
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      observed.add(await readFile(keyPath, 'utf8'));
    })();

    await writeApiKeyToFile(keyPath, newKey, logger as never, account);
    reading = false;
    await reader;

    expect([...observed].every(value => value === oldKey || value === newKey)).toBe(true);
    expect(await readFile(keyPath, 'utf8')).toBe(newKey);
  });

  it('times out a Vault read without later writing a resolved API key', async () => {
    const directory = await createTemporaryDirectory();
    const keyPath = join(directory, 'api-key.txt');
    let finishSecretRead!: (value: { data: { value: string } }) => void;
    const delayedSecret = new Promise<{ data: { value: string } }>(resolve => {
      finishSecretRead = resolve;
    });
    const ctx = {
      config: {
        auth: { apiKey: 'managed-key-value' },
        managedKey: { name: 'managed-key' },
      },
      getSecret: vi.fn(() => delayedSecret),
    } as unknown as PluginContext;

    await expect(fetchSecrets(
      ctx,
      {
        ZINC_CONFIG_VAULT_API_KEY: 'api-key:managed-key',
        DATABASE_PASSWORD: 'alias:example/database-password',
      },
      logger as never,
      keyPath,
      userInfo().username,
      undefined,
      performance.now() + 20
    )).rejects.toThrow('exceeded its deadline');

    await expect(stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    finishSecretRead({ data: { value: 'eventually-resolved' } });
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
