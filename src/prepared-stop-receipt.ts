// Durable proof and mutation fence for one intentional full-fleet outage. The
// record survives CLI/agent restarts, binds every host to one rollout owner and
// target, and stays armed until the complete rollout explicitly commits it.

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
import type { WarArtifactIdentity } from './types.js';

const RECEIPT_VERSION = 2;
const MAX_RECEIPT_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type PreparedStopPhase = 'arming' | 'prepared' | 'stopped' | 'rollout' | 'deployed' | 'releasing';

export interface PreparedStopScope {
  hostIdentity: string;
  domain: string;
  appName: string;
}

export interface PreparedStopReceipt extends PreparedStopScope {
  receiptId: string;
  /** One caller-owned UUID shared by the complete fleet rollout. */
  outageOwnerId: string;
  /** SHA-256 of the 32-byte base64url capability. The secret is never persisted. */
  outageCapabilitySha256: string;
  /** Immutable canonical identity of the WAR this outage is allowed to deploy. */
  targetContentSha256: string;
  /** Exact WAR present when the application reference was removed. */
  artifact: WarArtifactIdentity;
  phase: PreparedStopPhase;
  preparedAtMs: number;
  stoppedAtMs?: number;
  rolloutAtMs?: number;
  deployedAtMs?: number;
  deployedArtifact?: WarArtifactIdentity;
}

interface PreparedStopReceiptFile {
  version: typeof RECEIPT_VERSION;
  receipts: PreparedStopReceipt[];
}

function receiptError(code: string, message: string, cause?: unknown): Error {
  const error = new Error(
    `${code}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
  error.name = code;
  return error;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function isNonEmptyBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function isArtifactIdentity(value: unknown): value is WarArtifactIdentity {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Partial<WarArtifactIdentity>;
  return (
    Number.isSafeInteger(artifact.size)
    && Number(artifact.size) > 0
    && typeof artifact.sha256 === 'string'
    && SHA256_PATTERN.test(artifact.sha256)
    && typeof artifact.contentSha256 === 'string'
    && SHA256_PATTERN.test(artifact.contentSha256)
  );
}

function isReceipt(value: unknown): value is PreparedStopReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<PreparedStopReceipt>;
  return (
    typeof receipt.receiptId === 'string'
    && UUID_V4_PATTERN.test(receipt.receiptId)
    && typeof receipt.outageOwnerId === 'string'
    && UUID_V4_PATTERN.test(receipt.outageOwnerId)
    && typeof receipt.targetContentSha256 === 'string'
    && SHA256_PATTERN.test(receipt.targetContentSha256)
    && isNonEmptyBoundedString(receipt.hostIdentity)
    && isNonEmptyBoundedString(receipt.domain)
    && isNonEmptyBoundedString(receipt.appName)
    && isArtifactIdentity(receipt.artifact)
    && (
      receipt.phase === 'arming'
      || receipt.phase === 'prepared'
      || receipt.phase === 'stopped'
      || receipt.phase === 'rollout'
      || receipt.phase === 'deployed'
      || receipt.phase === 'releasing'
    )
    && typeof receipt.preparedAtMs === 'number'
    && typeof receipt.outageCapabilitySha256 === 'string'
    && SHA256_PATTERN.test(receipt.outageCapabilitySha256)
    && Number.isFinite(receipt.preparedAtMs)
    && receipt.preparedAtMs > 0
    && (
      receipt.stoppedAtMs === undefined
      || (
        typeof receipt.stoppedAtMs === 'number'
        && Number.isFinite(receipt.stoppedAtMs)
        && receipt.stoppedAtMs >= receipt.preparedAtMs
      )
    )
    && (
      receipt.rolloutAtMs === undefined
      || (
        typeof receipt.rolloutAtMs === 'number'
        && Number.isFinite(receipt.rolloutAtMs)
        && receipt.rolloutAtMs >= receipt.preparedAtMs
      )
    )
    && (
      receipt.deployedAtMs === undefined
      || (
        typeof receipt.deployedAtMs === 'number'
        && Number.isFinite(receipt.deployedAtMs)
        && receipt.deployedAtMs >= receipt.preparedAtMs
      )
    )
    && (
      receipt.deployedArtifact === undefined
      || isArtifactIdentity(receipt.deployedArtifact)
    )
    && (receipt.phase === 'arming' || receipt.phase === 'prepared' || receipt.stoppedAtMs !== undefined)
    && (
      receipt.phase === 'arming'
      || receipt.phase === 'prepared'
      || receipt.phase === 'stopped'
      || receipt.rolloutAtMs !== undefined
    )
    && (
      (receipt.phase !== 'deployed' && receipt.phase !== 'releasing')
      || (
        receipt.deployedAtMs !== undefined
        && receipt.deployedArtifact !== undefined
        && receipt.deployedArtifact.contentSha256 === receipt.targetContentSha256
      )
    )
  );
}

function sameScope(receipt: PreparedStopScope, scope: PreparedStopScope): boolean {
  return (
    receipt.hostIdentity === scope.hostIdentity
    && receipt.domain === scope.domain
    && receipt.appName === scope.appName
  );
}

/** Atomic, fsync-backed storage for prepared deployment-stop receipts. */
export class PreparedStopReceiptStore {
  constructor(private readonly path: string) {}

  read(scope: PreparedStopScope): PreparedStopReceipt | undefined {
    return this.readFile().receipts.find(receipt => sameScope(receipt, scope));
  }

  arm(
    scope: PreparedStopScope,
    artifact: WarArtifactIdentity,
    outageOwnerId: string,
    targetContentSha256: string,
    outageCapabilitySha256: string,
  ): PreparedStopReceipt {
    if (!isArtifactIdentity(artifact)) {
      throw receiptError(
        'PREPARED_STOP_ARTIFACT_INVALID',
        'A complete previous WAR identity is required before stopping Payara',
      );
    }
    if (!UUID_V4_PATTERN.test(outageOwnerId)) {
      throw receiptError(
        'OUTAGE_FENCE_OWNER_INVALID',
        'A caller-owned lowercase UUIDv4 is required for the fleet outage',
      );
    }
    if (!SHA256_PATTERN.test(targetContentSha256)) {
      throw receiptError(
        'OUTAGE_FENCE_TARGET_INVALID',
        'A lowercase target content SHA-256 is required for the fleet outage',
      );
    }
    if (!SHA256_PATTERN.test(outageCapabilitySha256)) {
      throw receiptError(
        'OUTAGE_FENCE_CAPABILITY_INVALID',
        'A SHA-256 capability commitment is required for the fleet outage',
      );
    }
    const file = this.readFile();
    const receipt: PreparedStopReceipt = {
      ...scope,
      receiptId: randomUUID(),
      outageOwnerId,
      outageCapabilitySha256,
      targetContentSha256,
      artifact: { ...artifact },
      phase: 'arming',
      preparedAtMs: Date.now(),
    };
    file.receipts = file.receipts.filter(existing => !sameScope(existing, scope));
    file.receipts.push(receipt);
    this.persist(file);
    return receipt;
  }

  markPrepared(scope: PreparedStopScope, expectedReceiptId: string): PreparedStopReceipt {
    const file = this.readFile();
    const receipt = file.receipts.find(existing => sameScope(existing, scope));
    if (!receipt || receipt.receiptId !== expectedReceiptId) {
      throw receiptError(
        'PREPARED_STOP_RECEIPT_CAS_FAILED',
        'Arming receipt changed before application ownership preparation completed',
      );
    }
    if (receipt.phase !== 'arming' && receipt.phase !== 'prepared') {
      throw receiptError(
        'OUTAGE_FENCE_PHASE_INVALID',
        `Cannot commit application ownership preparation from phase '${receipt.phase}'`,
      );
    }
    if (receipt.phase === 'arming') {
      receipt.phase = 'prepared';
      this.persist(file);
    }
    return receipt;
  }

  rearm(
    scope: PreparedStopScope,
    expectedOutageOwnerId: string,
    artifact: WarArtifactIdentity,
  ): PreparedStopReceipt {
    if (!isArtifactIdentity(artifact)) {
      throw receiptError(
        'PREPARED_STOP_ARTIFACT_INVALID',
        'A complete current WAR identity is required before stopping Payara',
      );
    }
    const file = this.readFile();
    const receipt = this.requireOwnedReceipt(
      file,
      scope,
      expectedOutageOwnerId,
    );
    receipt.artifact = { ...artifact };
    receipt.phase = 'prepared';
    receipt.preparedAtMs = Date.now();
    delete receipt.stoppedAtMs;
    delete receipt.rolloutAtMs;
    delete receipt.deployedAtMs;
    delete receipt.deployedArtifact;
    this.persist(file);
    return receipt;
  }

  markStopped(scope: PreparedStopScope, expectedReceiptId: string): PreparedStopReceipt {
    const file = this.readFile();
    const receipt = file.receipts.find(existing => sameScope(existing, scope));
    if (!receipt || receipt.receiptId !== expectedReceiptId) {
      throw receiptError(
        'PREPARED_STOP_RECEIPT_CAS_FAILED',
        'Prepared-stop receipt changed before the stopped state could be committed',
      );
    }
    if (receipt.phase !== 'prepared' && receipt.phase !== 'stopped') {
      throw receiptError(
        'OUTAGE_FENCE_PHASE_INVALID',
        `Cannot commit stopped state from phase '${receipt.phase}'`,
      );
    }
    if (receipt.phase === 'stopped') return receipt;
    receipt.phase = 'stopped';
    receipt.stoppedAtMs = Date.now();
    this.persist(file);
    return receipt;
  }

  markRollout(
    scope: PreparedStopScope,
    expectedOutageOwnerId: string,
    targetContentSha256: string,
  ): PreparedStopReceipt {
    const file = this.readFile();
    const receipt = this.requireOwnedReceipt(
      file,
      scope,
      expectedOutageOwnerId,
    );
    if (receipt.targetContentSha256 !== targetContentSha256) {
      throw receiptError(
        'OUTAGE_FENCE_TARGET_MISMATCH',
        'The deployment target does not match the target bound to the outage',
      );
    }
    if (receipt.phase !== 'stopped' && receipt.phase !== 'rollout') {
      throw receiptError(
        'OUTAGE_FENCE_PHASE_INVALID',
        `Cannot begin rollout from phase '${receipt.phase}'`,
      );
    }
    if (receipt.phase === 'stopped') {
      receipt.phase = 'rollout';
      receipt.rolloutAtMs = Date.now();
      this.persist(file);
    }
    return receipt;
  }

  markDeployed(
    scope: PreparedStopScope,
    expectedOutageOwnerId: string,
    artifact: WarArtifactIdentity,
  ): PreparedStopReceipt {
    const file = this.readFile();
    const receipt = this.requireOwnedReceipt(
      file,
      scope,
      expectedOutageOwnerId,
    );
    if (
      receipt.phase !== 'rollout'
      && receipt.phase !== 'deployed'
    ) {
      throw receiptError(
        'OUTAGE_FENCE_PHASE_INVALID',
        `Cannot commit deployment from phase '${receipt.phase}'`,
      );
    }
    if (
      !isArtifactIdentity(artifact)
      || artifact.contentSha256 !== receipt.targetContentSha256
    ) {
      throw receiptError(
        'OUTAGE_FENCE_TARGET_MISMATCH',
        'The deployed WAR does not match the target bound to the outage',
      );
    }
    receipt.phase = 'deployed';
    receipt.deployedAtMs = Date.now();
    receipt.deployedArtifact = { ...artifact };
    this.persist(file);
    return receipt;
  }

  markReleasing(
    scope: PreparedStopScope,
    expectedOutageOwnerId: string,
  ): PreparedStopReceipt {
    const file = this.readFile();
    const receipt = this.requireOwnedReceipt(file, scope, expectedOutageOwnerId);
    if (receipt.phase !== 'deployed' && receipt.phase !== 'releasing') {
      throw receiptError(
        'OUTAGE_FENCE_PHASE_INVALID',
        `Cannot prepare outage release from phase '${receipt.phase}'`,
      );
    }
    if (receipt.phase === 'deployed') {
      receipt.phase = 'releasing';
      this.persist(file);
    }
    return receipt;
  }

  clearOwned(scope: PreparedStopScope, expectedOutageOwnerId: string): void {
    const file = this.readFile();
    this.requireOwnedReceipt(file, scope, expectedOutageOwnerId);
    const remaining = file.receipts.filter(receipt => !sameScope(receipt, scope));
    if (remaining.length === file.receipts.length) return;
    if (remaining.length === 0) {
      try {
        rmSync(this.path);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) {
          throw receiptError(
            'PREPARED_STOP_RECEIPT_CLEAR_FAILED',
            'Cannot remove the durable prepared-stop receipt',
            error,
          );
        }
      }
      this.syncDirectory();
      return;
    }
    this.persist({ version: RECEIPT_VERSION, receipts: remaining });
  }

  private requireOwnedReceipt(
    file: PreparedStopReceiptFile,
    scope: PreparedStopScope,
    expectedOutageOwnerId: string,
  ): PreparedStopReceipt {
    if (!UUID_V4_PATTERN.test(expectedOutageOwnerId)) {
      throw receiptError(
        'OUTAGE_FENCE_OWNER_INVALID',
        'A caller-owned lowercase UUIDv4 is required for the fleet outage',
      );
    }
    const receipt = file.receipts.find(existing => sameScope(existing, scope));
    if (!receipt) {
      throw receiptError(
        'OUTAGE_FENCE_NOT_ARMED',
        'No durable outage fence exists for this application',
      );
    }
    if (receipt.outageOwnerId !== expectedOutageOwnerId) {
      throw receiptError(
        'OUTAGE_FENCE_OWNER_MISMATCH',
        'The active outage belongs to a different rollout owner',
      );
    }
    return receipt;
  }

  private readFile(): PreparedStopReceiptFile {
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
        || stats.size > MAX_RECEIPT_BYTES
      ) {
        throw receiptError(
          'PREPARED_STOP_RECEIPT_INVALID',
          'Prepared-stop receipt is not a bounded private regular file',
        );
      }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PreparedStopReceiptFile>;
      if (
        parsed.version !== RECEIPT_VERSION
        || !Array.isArray(parsed.receipts)
        || !parsed.receipts.every(isReceipt)
      ) {
        throw receiptError(
          'PREPARED_STOP_RECEIPT_INVALID',
          'Prepared-stop receipt has an invalid schema',
        );
      }
      return { version: RECEIPT_VERSION, receipts: parsed.receipts };
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return { version: RECEIPT_VERSION, receipts: [] };
      }
      if (error instanceof Error && error.name.startsWith('PREPARED_STOP_')) {
        throw error;
      }
      throw receiptError(
        'PREPARED_STOP_RECEIPT_UNREADABLE',
        'Cannot read the durable prepared-stop receipt',
        error,
      );
    }
  }

  private persist(file: PreparedStopReceiptFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const directoryStats = lstatSync(dirname(this.path));
    const effectiveUid = process.geteuid?.();
    if (
      !directoryStats.isDirectory()
      || directoryStats.isSymbolicLink()
      || (directoryStats.mode & 0o077) !== 0
      || (effectiveUid !== undefined && directoryStats.uid !== effectiveUid)
    ) {
      throw receiptError(
        'PREPARED_STOP_RECEIPT_DIRECTORY_UNSAFE',
        'Prepared-stop receipt directory must be private and owned by the agent',
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
        throw receiptError(
          'PREPARED_STOP_RECEIPT_VERIFY_FAILED',
          'Prepared-stop receipt readback did not match the committed state',
        );
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the original persistence failure.
        }
      }
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original persistence failure.
      }
      if (error instanceof Error && error.name.startsWith('PREPARED_STOP_')) {
        throw error;
      }
      throw receiptError(
        'PREPARED_STOP_RECEIPT_PERSIST_FAILED',
        'Cannot persist the prepared-stop receipt atomically',
        error,
      );
    }
  }

  private syncDirectory(): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(dirname(this.path), 'r');
      fsyncSync(descriptor);
    } catch (error) {
      if (!(process.platform === 'darwin' && isErrno(error, 'EINVAL'))) {
        throw error;
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}
