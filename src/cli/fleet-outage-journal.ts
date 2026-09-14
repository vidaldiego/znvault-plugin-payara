import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  currentProcessOwnerEvidence,
  ProcessEpochMutex,
  processOwnerIsAlive,
} from '../process-epoch-mutex.js';

export interface FleetOutageJournalGroup {
  name: string;
  hosts: readonly string[];
  targetContentSha256: string;
}

export interface FleetOutageContext {
  outageOwnerId: string;
  outageCapability: string;
  manifestSha256: string;
  commitAuthorized?: boolean;
  resumeCommitOnly?: boolean;
  /** Hosts already proven live at the exact target with no active receipt. */
  alreadyFinalizedHosts?: readonly string[];
  /** Hosts whose owned receipt proves the exact target is already deployed. */
  alreadyDeployedHosts?: readonly string[];
}

interface JournalFile extends FleetOutageContext {
  version: 1;
  createdAtMs: number;
  phase: 'stopping' | 'post-complete';
}

interface ActiveLockRecord {
  version: 2;
  pid: number;
  processInstanceId: string;
  processIdentity?: string;
  outageOwnerId: string;
  manifestSha256: string;
  capabilitySha256: string;
  token: string;
}

interface ActiveLockSnapshot {
  record: ActiveLockRecord;
  dev: number;
  ino: number;
}

function stateDir(): string {
  return process.env.ZNVAULT_PAYARA_FLEET_OUTAGE_STATE_DIR || join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'znvault',
    'payara-fleet-outages',
  );
}

function manifest(groups: readonly FleetOutageJournalGroup[]): string {
  const canonical = groups
    .map(group => ({
      name: group.name,
      hosts: [...group.hosts].sort(),
      targetContentSha256: group.targetContentSha256,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function journalPath(id: string): string { return join(stateDir(), `${id}.json`); }
function lockPath(): string { return join(stateDir(), 'active.lock'); }

function withActiveLockCoordination<T>(label: string, operation: () => T): T {
  const mutex = new ProcessEpochMutex(lockPath());
  const lease = mutex.acquire(`fleet-outage:${label}`);
  try {
    return operation();
  } finally {
    mutex.release(lease);
  }
}

const OUTAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function capabilityCommitment(capability: string): string {
  const decoded = Buffer.from(capability, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== capability) {
    throw new Error('FLEET_OUTAGE_CAPABILITY_INVALID');
  }
  return createHash('sha256')
    .update('znvault-payara-outage/v1\0')
    .update(decoded)
    .digest('hex');
}

function ensureStateDirectory(): string {
  const directory = stateDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || stats.uid !== process.geteuid?.() || (stats.mode & 0o077) !== 0) {
    throw new Error('FLEET_OUTAGE_STATE_INVALID: state directory must be private and owned');
  }
  return directory;
}

function readJournalFile(outageOwnerId: string, expectedManifestSha256: string): JournalFile {
  const path = journalPath(outageOwnerId);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
    || stats.size > 16 * 1024
    || (stats.mode & 0o777) !== 0o600 || stats.uid !== process.geteuid?.()) {
    throw new Error('FLEET_OUTAGE_JOURNAL_INVALID: journal is not a bounded private owned regular file');
  }
  const file = JSON.parse(readFileSync(path, 'utf8')) as JournalFile;
  if (file.version !== 1 || file.outageOwnerId !== outageOwnerId
    || !OUTAGE_ID_PATTERN.test(file.outageOwnerId)
    || file.manifestSha256 !== expectedManifestSha256
    || (file.phase !== 'stopping' && file.phase !== 'post-complete')
    || !Number.isFinite(file.createdAtMs) || file.createdAtMs <= 0
    || !/^[A-Za-z0-9_-]{43}$/u.test(file.outageCapability)) {
    throw new Error('FLEET_OUTAGE_JOURNAL_INVALID: saved rollout does not match this fleet target');
  }
  return file;
}

function validActiveLock(value: unknown): value is ActiveLockRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ActiveLockRecord>;
  return record.version === 2
    && Number.isSafeInteger(record.pid) && (record.pid ?? 0) > 0
    && typeof record.processInstanceId === 'string'
    && /^[0-9a-f-]{36}$/u.test(record.processInstanceId)
    && (record.processIdentity === undefined
      || (typeof record.processIdentity === 'string' && record.processIdentity.length <= 256))
    && typeof record.outageOwnerId === 'string' && OUTAGE_ID_PATTERN.test(record.outageOwnerId)
    && typeof record.manifestSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.manifestSha256)
    && typeof record.capabilitySha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(record.capabilitySha256)
    && typeof record.token === 'string' && /^[0-9a-f-]{36}$/u.test(record.token);
}

function readActiveLock(): ActiveLockSnapshot | undefined {
  const path = lockPath();
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (stats.nlink === 2) {
    const publishedStats = stats;
    const directory = ensureStateDirectory();
    const temporaryPattern = /^\.active\.\d+\.[0-9a-f-]{36}\.tmp$/u;
    const matchingTemporaryLinks = readdirSync(directory).filter(entry => {
      if (!temporaryPattern.test(entry)) return false;
      try {
        const candidate = lstatSync(join(directory, entry));
        return candidate.isFile() && !candidate.isSymbolicLink()
          && candidate.dev === publishedStats.dev && candidate.ino === publishedStats.ino;
      } catch {
        return false;
      }
    });
    if (matchingTemporaryLinks.length === 1) {
      rmSync(join(directory, matchingTemporaryLinks[0]!), { force: true });
      syncDirectory(directory);
      stats = lstatSync(path);
    }
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
    || stats.size < 1 || stats.size > 4_096
    || (stats.mode & 0o777) !== 0o600 || stats.uid !== process.geteuid?.()) {
    throw new Error('FLEET_OUTAGE_LOCK_INVALID: active lock is not a private owned regular file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error(
      'FLEET_OUTAGE_LOCK_LEGACY_RECOVERY_REQUIRED: active lock lacks exact v2 recovery evidence',
    );
  }
  if (!validActiveLock(parsed)) {
    throw new Error(
      'FLEET_OUTAGE_LOCK_LEGACY_RECOVERY_REQUIRED: active lock lacks exact v2 recovery evidence',
    );
  }
  return { record: parsed, dev: stats.dev, ino: stats.ino };
}

function sameActiveLock(
  observed: ActiveLockSnapshot | undefined,
  expected: ActiveLockSnapshot,
): observed is ActiveLockSnapshot {
  return Boolean(observed
    && observed.dev === expected.dev
    && observed.ino === expected.ino
    && observed.record.token === expected.record.token);
}

function newActiveLockRecord(context: FleetOutageContext): ActiveLockRecord {
  if (!OUTAGE_ID_PATTERN.test(context.outageOwnerId)
    || !/^[a-f0-9]{64}$/u.test(context.manifestSha256)) {
    throw new Error('FLEET_OUTAGE_LOCK_INVALID: rollout identity is malformed');
  }
  return {
    version: 2,
    ...currentProcessOwnerEvidence(),
    outageOwnerId: context.outageOwnerId,
    manifestSha256: context.manifestSha256,
    capabilitySha256: capabilityCommitment(context.outageCapability),
    token: randomUUID(),
  };
}

function writePrivateRecord(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publishActiveLockIfAbsent(record: ActiveLockRecord): boolean {
  const directory = ensureStateDirectory();
  const temporary = join(directory, `.active.${process.pid}.${randomUUID()}.tmp`);
  try {
    writePrivateRecord(temporary, record);
    try {
      // Publish an already durable inode without ever exposing partial JSON.
      linkSync(temporary, lockPath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    rmSync(temporary);
    syncDirectory(directory);
    return true;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function installActiveLockOver(
  stale: ActiveLockSnapshot,
  record: ActiveLockRecord,
): ActiveLockSnapshot {
  const directory = ensureStateDirectory();
  if (!sameActiveLock(readActiveLock(), stale)) {
    throw new Error('FLEET_OUTAGE_LOCK_CHANGED: active lock changed during fenced takeover');
  }
  const temporary = join(directory, `.active.takeover.${process.pid}.${randomUUID()}.tmp`);
  try {
    writePrivateRecord(temporary, record);
    const successor = lstatSync(temporary);
    if (!sameActiveLock(readActiveLock(), stale)) {
      throw new Error('FLEET_OUTAGE_LOCK_CHANGED: active lock changed before atomic takeover');
    }
    renameSync(temporary, lockPath());
    syncDirectory(directory);
    const installed = readActiveLock();
    if (!installed || installed.dev !== successor.dev || installed.ino !== successor.ino
      || installed.record.token !== record.token) {
      throw new Error('FLEET_OUTAGE_LOCK_CHANGED: successor lock was not installed exactly');
    }
    return installed;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function activeLockMatchesContext(record: ActiveLockRecord, context: FleetOutageContext): boolean {
  return record.outageOwnerId === context.outageOwnerId
    && record.manifestSha256 === context.manifestSha256
    && record.capabilitySha256 === capabilityCommitment(context.outageCapability);
}

/** Called only while the process-epoch coordination lease is held. */
function acquireLockUnlocked(context: FleetOutageContext): ActiveLockSnapshot {
  const replacement = newActiveLockRecord(context);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (publishActiveLockIfAbsent(replacement)) {
      const installed = readActiveLock();
      if (installed?.record.token === replacement.token) return installed;
      throw new Error('FLEET_OUTAGE_LOCK_CHANGED: newly published lock was replaced');
    }

    const observed = readActiveLock();
    if (!observed) continue;
    const exactBinding = activeLockMatchesContext(observed.record, context);
    if (processOwnerIsAlive(observed.record)) {
      if (exactBinding
        && observed.record.pid === process.pid
        && observed.record.processInstanceId === currentProcessOwnerEvidence().processInstanceId) {
        return observed;
      }
      throw new Error(
        `FLEET_OUTAGE_ALREADY_ACTIVE: rollout ${observed.record.outageOwnerId} ` +
        `is owned by PID ${observed.record.pid}`,
      );
    }
    if (!exactBinding) {
      throw new Error(
        'FLEET_OUTAGE_LOCK_MISMATCH: a stale lock belongs to a different private rollout journal',
      );
    }
    return installActiveLockOver(observed, replacement);
  }
  throw new Error(`FLEET_OUTAGE_LOCK_FAILED: cannot lock rollout ${context.outageOwnerId}`);
}

function removeOwnedActiveLock(owned: ActiveLockSnapshot): void {
  if (!sameActiveLock(readActiveLock(), owned)) {
    throw new Error('FLEET_OUTAGE_LOCK_CHANGED: active lock changed before completion');
  }
  const tombstone = `${lockPath()}.completed-${randomUUID()}`;
  renameSync(lockPath(), tombstone);
  const moved = lstatSync(tombstone);
  const movedRecord = JSON.parse(readFileSync(tombstone, 'utf8')) as unknown;
  if (moved.dev !== owned.dev || moved.ino !== owned.ino
    || !validActiveLock(movedRecord) || movedRecord.token !== owned.record.token) {
    throw new Error('FLEET_OUTAGE_LOCK_CHANGED: completed lock identity is ambiguous');
  }
  rmSync(tombstone);
  syncDirectory(stateDir());
}

function persist(file: JournalFile): void {
  const path = journalPath(file.outageOwnerId);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(file)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  syncDirectory(stateDir());
}

function contextFromFile(file: JournalFile): FleetOutageContext {
  return {
    outageOwnerId: file.outageOwnerId,
    outageCapability: file.outageCapability,
    manifestSha256: file.manifestSha256,
    commitAuthorized: file.phase === 'post-complete',
  };
}

export function openFleetOutageJournal(
  groups: readonly FleetOutageJournalGroup[],
  existingOutageOwnerId?: string,
): FleetOutageContext {
  const manifestSha256 = manifest(groups);
  ensureStateDirectory();
  return withActiveLockCoordination(
    `open:${existingOutageOwnerId ?? manifestSha256}`,
    () => {
      let file: JournalFile;
      if (existingOutageOwnerId) {
        try {
          file = readJournalFile(existingOutageOwnerId, manifestSha256);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          throw new Error(
            `FLEET_OUTAGE_CAPABILITY_MISSING: private journal for ` +
            `${existingOutageOwnerId} is unavailable`,
          );
        }
      } else {
        const active = readActiveLock();
        if (active && processOwnerIsAlive(active.record)) {
          throw new Error(
            `FLEET_OUTAGE_ALREADY_ACTIVE: rollout ${active.record.outageOwnerId} ` +
            `is owned by PID ${active.record.pid}`,
          );
        }

        if (active) {
          try {
            file = readJournalFile(active.record.outageOwnerId, manifestSha256);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            throw new Error(
              `FLEET_OUTAGE_CAPABILITY_MISSING: private journal for ` +
              `${active.record.outageOwnerId} is unavailable`,
            );
          }
        } else {
          const matches = findJournalsForManifest(manifestSha256);
          if (matches.length > 1) {
            throw new Error(
              'FLEET_OUTAGE_JOURNAL_AMBIGUOUS: several incomplete journals match this fleet target',
            );
          }
          file = matches[0] ?? {
            version: 1,
            outageOwnerId: randomUUID(),
            outageCapability: randomBytes(32).toString('base64url'),
            manifestSha256,
            createdAtMs: Date.now(),
            phase: 'stopping',
          };
          if (matches.length === 0) persist(file);
        }
      }

      const context = contextFromFile(file);
      acquireLockUnlocked(context);
      return context;
    },
  );
}

function findJournalsForManifest(manifestSha256: string): JournalFile[] {
  const entries = readdirSync(ensureStateDirectory());
  return entries.flatMap(entry => {
    const matched = entry.match(/^([0-9a-f-]+)\.json$/u);
    if (!matched || !OUTAGE_ID_PATTERN.test(matched[1]!)) return [];
    try {
      return [readJournalFile(matched[1]!, manifestSha256)];
    } catch (error) {
      if (getJournalManifest(entry) !== manifestSha256) return [];
      throw error;
    }
  });
}

/**
 * Recover the final local commit after every host already cleared its receipt.
 * This is the only crash window in which no server can return the outage owner,
 * so discovery is restricted to one exact private post-complete manifest.
 */
export function openFinalizedFleetOutageJournal(
  groups: readonly FleetOutageJournalGroup[],
): FleetOutageContext | undefined {
  const directory = stateDir();
  const manifestSha256 = manifest(groups);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const matches = entries.flatMap(entry => {
    const matched = entry.match(/^([0-9a-f-]+)\.json$/u);
    if (!matched || !OUTAGE_ID_PATTERN.test(matched[1]!)) return [];
    let file: JournalFile;
    try {
      file = readJournalFile(matched[1]!, manifestSha256);
    } catch (error) {
      if (getJournalManifest(entry) !== manifestSha256) return [];
      throw error;
    }
    return file.phase === 'post-complete' ? [file] : [];
  });
  if (matches.length > 1) {
    throw new Error(
      'FLEET_OUTAGE_JOURNAL_AMBIGUOUS: several post-complete journals match this fleet target',
    );
  }
  const match = matches[0];
  if (!match) return undefined;
  const context = openFleetOutageJournal(groups, match.outageOwnerId);
  if (!context.commitAuthorized) {
    throw new Error('FLEET_OUTAGE_JOURNAL_INVALID: recovered rollout is not post-complete');
  }
  return context;
}

function getJournalManifest(entry: string): unknown {
  try {
    const path = join(stateDir(), entry);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 16 * 1024) {
      return undefined;
    }
    return (JSON.parse(readFileSync(path, 'utf8')) as { manifestSha256?: unknown }).manifestSha256;
  } catch {
    return undefined;
  }
}

/** Durably authorize only the final release commit after rollout and post succeeded. */
export function markFleetOutageCommitAuthorized(context: FleetOutageContext): FleetOutageContext {
  ensureStateDirectory();
  return withActiveLockCoordination(`authorize:${context.outageOwnerId}`, () => {
    const file = readJournalFile(context.outageOwnerId, context.manifestSha256);
    if (file.outageCapability !== context.outageCapability) {
      throw new Error('FLEET_OUTAGE_JOURNAL_INVALID: cannot authorize a different rollout');
    }
    acquireLockUnlocked(context);
    file.phase = 'post-complete';
    persist(file);
    return contextFromFile(file);
  });
}

export function completeFleetOutageJournal(context: FleetOutageContext): void {
  const directory = ensureStateDirectory();
  withActiveLockCoordination(`complete:${context.outageOwnerId}`, () => {
    const file = readJournalFile(context.outageOwnerId, context.manifestSha256);
    if (file.outageCapability !== context.outageCapability || file.phase !== 'post-complete') {
      throw new Error('FLEET_OUTAGE_JOURNAL_INVALID: cannot complete a different rollout');
    }
    const ownedLock = acquireLockUnlocked(context);
    const completePath = join(directory, `${context.outageOwnerId}.complete.json`);
    const temporaryPath = `${completePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writePrivateRecord(temporaryPath, {
        version: 1,
        outageOwnerId: context.outageOwnerId,
        manifestSha256: context.manifestSha256,
        completedAtMs: Date.now(),
      });
      renameSync(temporaryPath, completePath);
      syncDirectory(directory);
    } finally {
      rmSync(temporaryPath, { force: true });
    }

    // Retire the exact active lock first. If the process dies here, the
    // post-complete journal remains sufficient to reacquire and finish.
    removeOwnedActiveLock(ownedLock);
    rmSync(journalPath(context.outageOwnerId));
    syncDirectory(directory);
  });
}
