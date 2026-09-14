import {
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentProcessOwnerEvidence,
  ProcessEpochMutex,
} from '../src/process-epoch-mutex.js';

describe('ProcessEpochMutex', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function resource(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'process-epoch-mutex-'));
    directories.push(directory);
    return join(directory, 'resource.lock');
  }

  it('publishes one valid epoch and permits the next owner after release', async () => {
    const path = await resource();
    const mutex = new ProcessEpochMutex(path);

    const first = mutex.acquire('first');
    mutex.release(first);
    const second = mutex.acquire('second');

    expect(second.epoch).toBe(first.epoch + 1);
    mutex.release(second);
  });

  it('ignores a private temp left before the canonical link was published', async () => {
    const path = await resource();
    const directory = `${path}.coordination`;
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(
      join(directory, '.epoch-0000000000000001.123.11111111-1111-4111-8111-111111111111.tmp'),
      '{"partial":true}\n',
      { mode: 0o600 },
    );

    const mutex = new ProcessEpochMutex(path);
    const lease = mutex.acquire('after-private-temp-crash');

    expect(lease.epoch).toBe(1);
    mutex.release(lease);
  });

  it('repairs the exact second temp link left after canonical publication', async () => {
    const path = await resource();
    const directory = `${path}.coordination`;
    mkdirSync(directory, { mode: 0o700 });
    const epoch = '0000000000000001';
    const temporary = join(
      directory,
      `.epoch-${epoch}.123.11111111-1111-4111-8111-111111111111.tmp`,
    );
    const canonical = join(directory, `epoch-${epoch}.json`);
    const record = {
      version: 1,
      epoch: 1,
      token: '22222222-2222-4222-8222-222222222222',
      label: 'crashed-after-link',
      createdAtMs: Date.now(),
      state: 'released',
      ...currentProcessOwnerEvidence(),
    };
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    linkSync(temporary, canonical);

    const mutex = new ProcessEpochMutex(path);
    const lease = mutex.acquire('after-linked-temp-crash');

    expect(lease.epoch).toBe(2);
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(readFileSync(
      join(directory, 'epoch-0000000000000002.json'),
      'utf8',
    ))).toMatchObject({ token: lease.token, state: 'active' });
    mutex.release(lease);
  });

  it('fails closed on a malformed canonical epoch', async () => {
    const path = await resource();
    const directory = `${path}.coordination`;
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, 'epoch-0000000000000001.json'), '{}\n', { mode: 0o600 });

    expect(() => new ProcessEpochMutex(path).acquire('must-not-reclaim'))
      .toThrow('PROCESS_EPOCH_RECORD_INVALID');
  });
});
