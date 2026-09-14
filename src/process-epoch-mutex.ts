import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const PROCESS_INSTANCE_ID = randomUUID();
const RECORD_PATTERN = /^epoch-(\d{16})\.json$/u;
const MAX_RECORD_BYTES = 4_096;

export interface ProcessOwnerEvidence {
  pid: number;
  processInstanceId: string;
  processIdentity?: string;
}

interface EpochRecord extends ProcessOwnerEvidence {
  version: 1;
  epoch: number;
  token: string;
  label: string;
  createdAtMs: number;
  state: 'active' | 'released';
}

export interface ProcessEpochLease {
  epoch: number;
  token: string;
}

export interface ProcessEpochMutexOptions {
  processIdentity?: (pid: number) => string | undefined;
  processProbe?: (pid: number) => void;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function linuxProcessIdentity(pid: number): string | undefined {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (!bootId || closeParen < 0) return undefined;
    const fieldsAfterComm = stat.slice(closeParen + 1).trim().split(/\s+/u);
    // /proc/<pid>/stat field 22 is process start time. The first entry after
    // the parenthesized command is field 3, so its zero-based index is 19.
    const startTicks = fieldsAfterComm[19];
    return startTicks && /^\d+$/u.test(startTicks)
      ? `${bootId}:${startTicks}`
      : undefined;
  } catch {
    return undefined;
  }
}

export function currentProcessOwnerEvidence(
  processIdentity: (pid: number) => string | undefined = linuxProcessIdentity,
): ProcessOwnerEvidence {
  const identity = processIdentity(process.pid);
  return {
    pid: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    ...(identity ? { processIdentity: identity } : {}),
  };
}

export function processOwnerIsAlive(
  owner: Pick<ProcessOwnerEvidence, 'pid' | 'processInstanceId' | 'processIdentity'>,
  options: ProcessEpochMutexOptions = {},
): boolean {
  if (owner.pid === process.pid) {
    return owner.processInstanceId === PROCESS_INSTANCE_ID;
  }
  const processIdentity = options.processIdentity ?? linuxProcessIdentity;
  const observedIdentity = processIdentity(owner.pid);
  if (owner.processIdentity && observedIdentity) {
    return owner.processIdentity === observedIdentity;
  }
  try {
    (options.processProbe ?? ((pid: number) => process.kill(pid, 0)))(owner.pid);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

function validRecord(value: unknown, expectedEpoch: number): value is EpochRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<EpochRecord>;
  return record.version === 1
    && record.epoch === expectedEpoch
    && Number.isSafeInteger(record.epoch)
    && expectedEpoch > 0
    && Number.isSafeInteger(record.pid)
    && (record.pid ?? 0) > 0
    && typeof record.processInstanceId === 'string'
    && /^[0-9a-f-]{36}$/u.test(record.processInstanceId)
    && (record.processIdentity === undefined
      || (typeof record.processIdentity === 'string' && record.processIdentity.length <= 256))
    && typeof record.token === 'string'
    && /^[0-9a-f-]{36}$/u.test(record.token)
    && typeof record.label === 'string'
    && record.label.length > 0
    && record.label.length <= 256
    && typeof record.createdAtMs === 'number'
    && Number.isFinite(record.createdAtMs)
    && record.createdAtMs > 0
    && (record.state === 'active' || record.state === 'released');
}

/**
 * Tiny crash-recoverable election used while creating or retiring pathname
 * locks. Every takeover appends one immutable, monotonically numbered epoch;
 * contenders can never delete or overwrite the current owner's election.
 */
export class ProcessEpochMutex {
  private readonly directory: string;

  constructor(
    resourcePath: string,
    private readonly options: ProcessEpochMutexOptions = {},
  ) {
    this.directory = `${resourcePath}.coordination`;
  }

  acquire(label: string): ProcessEpochLease {
    if (!label || label.length > 256) throw new Error('PROCESS_EPOCH_LABEL_INVALID');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directoryStats = lstatSync(this.directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()
      || (directoryStats.mode & 0o077) !== 0
      || directoryStats.uid !== process.geteuid?.()) {
      throw new Error('PROCESS_EPOCH_DIRECTORY_INVALID');
    }

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const latest = this.latest();
      if (latest?.record.state === 'active'
        && processOwnerIsAlive(latest.record, this.options)) {
        throw new Error(`PROCESS_EPOCH_ACTIVE: ${latest.record.label}`);
      }
      const epoch = (latest?.record.epoch ?? 0) + 1;
      if (!Number.isSafeInteger(epoch)) throw new Error('PROCESS_EPOCH_EXHAUSTED');
      const token = randomUUID();
      const record: EpochRecord = {
        version: 1,
        epoch,
        token,
        label,
        createdAtMs: Date.now(),
        state: 'active',
        ...currentProcessOwnerEvidence(this.options.processIdentity),
      };
      const path = this.recordPath(epoch);
      const temporary = join(
        this.directory,
        `.epoch-${String(epoch).padStart(16, '0')}.${process.pid}.${randomUUID()}.tmp`,
      );
      let descriptor: number | undefined;
      let published = false;
      try {
        // The canonical epoch name must never expose a partially written
        // record. Publish the already fsynced private inode with link(2), whose
        // existing-destination failure gives contenders a portable no-replace
        // election primitive.
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        linkSync(temporary, path);
        published = true;
        rmSync(temporary);
        syncDirectory(this.directory);
      } catch (error) {
        if (descriptor !== undefined) {
          closeSync(descriptor);
          descriptor = undefined;
        }
        rmSync(temporary, { force: true });
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        rmSync(temporary, { force: true });
      }
      if (!published) continue;
      const elected = this.latest();
      if (elected?.record.epoch === epoch && elected.record.token === token) {
        this.removeOlderEpochs(epoch);
        return { epoch, token };
      }
    }
    throw new Error('PROCESS_EPOCH_ACQUIRE_FAILED');
  }

  release(lease: ProcessEpochLease): void {
    const latest = this.latest();
    if (!latest || latest.record.epoch !== lease.epoch || latest.record.token !== lease.token
      || latest.record.state !== 'active') {
      throw new Error('PROCESS_EPOCH_OWNERSHIP_LOST');
    }
    const released: EpochRecord = { ...latest.record, state: 'released' };
    const temporary = `${latest.path}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(released)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, latest.path);
      syncDirectory(this.directory);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }

  private latest(): { path: string; record: EpochRecord } | undefined {
    const candidates = readdirSync(this.directory).flatMap(name => {
      const match = name.match(RECORD_PATTERN);
      if (!match) return [];
      const epoch = Number(match[1]);
      return Number.isSafeInteger(epoch) && epoch > 0 ? [{ name, epoch }] : [];
    }).sort((left, right) => right.epoch - left.epoch);
    const candidate = candidates[0];
    if (!candidate) return undefined;
    const path = join(this.directory, candidate.name);
    let stats = lstatSync(path);
    if (stats.nlink === 2) {
      const escapedEpoch = String(candidate.epoch).padStart(16, '0');
      const temporaryPattern = new RegExp(
        `^\\.epoch-${escapedEpoch}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`,
        'u',
      );
      const matchingTemporaryLinks = readdirSync(this.directory).filter(name => {
        if (!temporaryPattern.test(name)) return false;
        try {
          const temporaryStats = lstatSync(join(this.directory, name));
          return temporaryStats.isFile()
            && !temporaryStats.isSymbolicLink()
            && temporaryStats.dev === stats.dev
            && temporaryStats.ino === stats.ino;
        } catch {
          return false;
        }
      });
      if (matchingTemporaryLinks.length === 1) {
        rmSync(join(this.directory, matchingTemporaryLinks[0]!), { force: true });
        syncDirectory(this.directory);
        stats = lstatSync(path);
      }
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || stats.size < 1 || stats.size > MAX_RECORD_BYTES
      || (stats.mode & 0o777) !== 0o600 || stats.uid !== process.geteuid?.()) {
      throw new Error('PROCESS_EPOCH_RECORD_INVALID');
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!validRecord(parsed, candidate.epoch)) {
      throw new Error('PROCESS_EPOCH_RECORD_INVALID');
    }
    return { path, record: parsed };
  }

  private recordPath(epoch: number): string {
    return join(this.directory, `epoch-${String(epoch).padStart(16, '0')}.json`);
  }

  private removeOlderEpochs(currentEpoch: number): void {
    let removed = false;
    for (const name of readdirSync(this.directory)) {
      const match = name.match(RECORD_PATTERN);
      if (!match || Number(match[1]) >= currentEpoch) continue;
      try {
        rmSync(join(this.directory, name), { force: true });
        removed = true;
      } catch {
        // Historical epochs are not authoritative once a newer valid epoch is
        // elected. Cleanup must not turn a held mutex into an unreturnable one.
      }
    }
    if (removed) {
      try { syncDirectory(this.directory); } catch { /* best-effort cleanup */ }
    }
  }
}
