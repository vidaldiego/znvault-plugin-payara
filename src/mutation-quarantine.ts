// Durable write-ahead quarantine for ambiguous Payara application mutations.

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const QUARANTINE_VERSION = 1;
const MAX_QUARANTINE_BYTES = 64 * 1024;

export interface MutationQuarantineRecord {
  recordId: string;
  instanceId: string;
  domain: string;
  appName: string;
  runtimeIdentity: string | number;
  bootEpoch: string;
  operation: string;
  evidenceSource: string;
  armedAtMs: number;
}

interface MutationQuarantineFile {
  version: typeof QUARANTINE_VERSION;
  records: MutationQuarantineRecord[];
}

function quarantineError(code: string, message: string, cause?: unknown): Error {
  const error = new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause });
  error.name = code;
  return error;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function isValidRecord(value: unknown): value is MutationQuarantineRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<MutationQuarantineRecord>;
  return (
    typeof record.recordId === 'string'
    && record.recordId.length > 0
    && typeof record.instanceId === 'string'
    && /^[a-f0-9]{64}$/.test(record.instanceId)
    && typeof record.domain === 'string'
    && record.domain.length > 0
    && typeof record.appName === 'string'
    && record.appName.length > 0
    && (typeof record.runtimeIdentity === 'string' || typeof record.runtimeIdentity === 'number')
    && (typeof record.runtimeIdentity !== 'number' || Number.isSafeInteger(record.runtimeIdentity))
    && typeof record.bootEpoch === 'string'
    && record.bootEpoch.length > 0
    && typeof record.operation === 'string'
    && record.operation.length > 0
    && record.operation.length <= 256
    && typeof record.evidenceSource === 'string'
    && record.evidenceSource.length > 0
    && record.evidenceSource.length <= 256
    && typeof record.armedAtMs === 'number'
    && Number.isFinite(record.armedAtMs)
    && record.armedAtMs > 0
  );
}

/**
 * Stores an `armed` record before a destructive asadmin command. A surviving
 * record is UNKNOWN after timeout, crash, SIGKILL, or process replacement.
 * Callers serialize writes with the deployment lock; recordId is an additional
 * compare-and-set guard against deleting another writer's quarantine.
 */
export class MutationQuarantineStore {
  constructor(private readonly path: string) {}

  read(instanceId: string, appName: string): MutationQuarantineRecord | undefined {
    return this.readFile().records.find(record =>
      record.instanceId === instanceId && record.appName === appName
    );
  }

  arm(options: Omit<MutationQuarantineRecord, 'recordId' | 'armedAtMs'>): MutationQuarantineRecord {
    const file = this.readFile();
    const record: MutationQuarantineRecord = {
      ...options,
      recordId: randomUUID(),
      armedAtMs: Date.now(),
    };
    file.records = file.records.filter(existing =>
      existing.instanceId !== options.instanceId || existing.appName !== options.appName
    );
    file.records.push(record);
    this.persist(file);
    return record;
  }

  clear(instanceId: string, appName: string, expectedRecordId: string): void {
    const file = this.readFile();
    const current = file.records.find(record =>
      record.instanceId === instanceId && record.appName === appName
    );
    if (!current) {
      throw quarantineError(
        'BOOT_QUARANTINE_CAS_FAILED',
        `Durable quarantine disappeared before ${expectedRecordId} could be cleared`
      );
    }
    if (current.recordId !== expectedRecordId) {
      throw quarantineError(
        'BOOT_QUARANTINE_CAS_FAILED',
        `Refusing to clear replacement quarantine ${current.recordId}`
      );
    }

    file.records = file.records.filter(record => record.recordId !== expectedRecordId);
    if (file.records.length === 0) {
      try {
        rmSync(this.path);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
      this.syncDirectory();
      return;
    }
    this.persist(file);
  }

  private readFile(): MutationQuarantineFile {
    try {
      const linkStats = lstatSync(this.path);
      const stats = statSync(this.path);
      const effectiveUid = process.geteuid?.();
      if (
        linkStats.isSymbolicLink()
        || !stats.isFile()
        || stats.nlink !== 1
        || (stats.mode & 0o777) !== 0o600
        || (effectiveUid !== undefined && stats.uid !== effectiveUid)
        || stats.size > MAX_QUARANTINE_BYTES
      ) {
        throw quarantineError(
          'BOOT_QUARANTINE_INVALID',
          'Durable mutation quarantine is not a bounded regular file'
        );
      }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<MutationQuarantineFile>;
      if (
        parsed.version !== QUARANTINE_VERSION
        || !Array.isArray(parsed.records)
        || !parsed.records.every(isValidRecord)
      ) {
        throw quarantineError(
          'BOOT_QUARANTINE_INVALID',
          'Durable mutation quarantine has an invalid schema'
        );
      }
      return { version: QUARANTINE_VERSION, records: parsed.records };
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return { version: QUARANTINE_VERSION, records: [] };
      }
      if (error instanceof Error && error.name.startsWith('BOOT_QUARANTINE_')) {
        throw error;
      }
      throw quarantineError(
        'BOOT_QUARANTINE_UNREADABLE',
        'Cannot read the durable Payara mutation quarantine',
        error
      );
    }
  }

  private persist(file: MutationQuarantineFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const directoryStats = lstatSync(dirname(this.path));
    const effectiveUid = process.geteuid?.();
    if (
      !directoryStats.isDirectory()
      || directoryStats.isSymbolicLink()
      || (directoryStats.mode & 0o077) !== 0
      || (effectiveUid !== undefined && directoryStats.uid !== effectiveUid)
    ) {
      throw quarantineError(
        'BOOT_QUARANTINE_DIRECTORY_UNSAFE',
        'Mutation quarantine directory must be owned by the agent and inaccessible to group/other'
      );
    }
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(file)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.path);
      this.syncDirectory();
      const verified = this.readFile();
      if (JSON.stringify(verified) !== JSON.stringify(file)) {
        throw quarantineError(
          'BOOT_QUARANTINE_VERIFY_FAILED',
          'Durable mutation quarantine readback did not match the committed state'
        );
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the original persistence error.
        }
      }
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original persistence error.
      }
      throw quarantineError(
        'BOOT_QUARANTINE_PERSIST_FAILED',
        'Cannot persist the Payara mutation quarantine before mutation',
        error
      );
    }
  }

  private syncDirectory(): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(dirname(this.path), 'r');
      fsyncSync(descriptor);
    } catch (error) {
      // Darwin rejects directory fsync on some filesystems. Production support
      // is Linux; there, lack of directory durability must fail closed.
      if (!(process.platform === 'darwin' && isErrno(error, 'EINVAL'))) {
        throw error;
      }
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
  }
}
