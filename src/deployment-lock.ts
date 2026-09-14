// Path: src/deployment-lock.ts
// File-based deployment lock with shutdown-signal deferral

import { randomUUID } from 'node:crypto';
import { link, open, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import {
  currentProcessOwnerEvidence,
  ProcessEpochMutex,
  processOwnerIsAlive,
  type ProcessEpochLease,
  type ProcessEpochMutexOptions,
} from './process-epoch-mutex.js';

export interface LockData {
  /** Version 2 binds automatic recovery to one exact Payara fleet outage. */
  lockVersion?: 2;
  pid: number;
  started: number;
  deploymentId: string;
  step: DeploymentStep;
  /** Unique acquisition identity. Absent only on legacy lock files. */
  ownerToken?: string;
  /** Distinguishes a recycled PID from the process that created this lock. */
  processInstanceId?: string;
  /** Linux boot-id plus /proc start ticks, when available. */
  processIdentity?: string;
  ownerKind?: 'general' | 'payara-outage';
  outageOwnerId?: string;
  targetContentSha256?: string;
  outageCapabilitySha256?: string;
  /** Durable fail-closed lifecycle quarantine metadata. */
  quarantined?: true;
  reason?: string;
  errorName?: string;
}

export interface DeploymentLockOutageScope {
  outageOwnerId: string;
  targetContentSha256: string;
  outageCapabilitySha256: string;
}

export interface DeploymentLockAcquireOptions {
  outageScope?: DeploymentLockOutageScope;
  authorizeStaleTakeover?: (staleLock: Readonly<LockData>) => void | Promise<void>;
}

export type DeploymentStep =
  | 'init'
  | 'war-update'
  | 'undeploy'
  | 'stop'
  | 'kill'
  | 'start'
  | 'deploy'
  | 'verify'
  | 'complete';

interface FileIdentity {
  dev: number;
  ino: number;
}

interface LockSnapshot {
  raw: string;
  data?: LockData;
  identity: FileIdentity;
  mtimeMs: number;
}

interface LockInspection {
  locked: boolean;
  stale: boolean;
  data?: LockData;
}

const ACQUIRE_ATTEMPTS = 8;
const ACQUIRE_RETRY_MS = 10;
const INCOMPLETE_LOCK_GRACE_MS = 1_000;
const MAX_LOCK_BYTES = 64 * 1024;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEFERRED_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const PROCESS_SIGNAL_DEFERRAL_KEY = Symbol.for(
  '@zincapp/znvault-mutation-signal-deferral/v1'
);
const PROCESS_SIGNAL_DEFERRAL_VERSION = 1 as const;

type DeferredSignal = typeof DEFERRED_SIGNALS[number];

interface ProcessSignalDeferralState {
  version: typeof PROCESS_SIGNAL_DEFERRAL_VERSION;
  participants: Set<symbol>;
  originalHandlers: Map<DeferredSignal, NodeJS.SignalsListener[]>;
  deferredHandlers: Map<DeferredSignal, NodeJS.SignalsListener>;
  pendingSignal: DeferredSignal | null;
  replayTimer: ReturnType<typeof setTimeout> | null;
  deferredSequence: number;
  shutdownRequested: boolean;
  replayed: boolean;
  logger?: unknown;
}

const getProcessSignalDeferralState = (): ProcessSignalDeferralState => {
  const globalRecord = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globalRecord[PROCESS_SIGNAL_DEFERRAL_KEY];
  if (existing !== undefined) {
    const candidate = existing as Partial<ProcessSignalDeferralState>;
    if (
      candidate.version !== PROCESS_SIGNAL_DEFERRAL_VERSION
      || !(candidate.participants instanceof Set)
      || !(candidate.originalHandlers instanceof Map)
      || !(candidate.deferredHandlers instanceof Map)
      || (candidate.pendingSignal !== null
        && !DEFERRED_SIGNALS.includes(candidate.pendingSignal as DeferredSignal))
      || !('replayTimer' in candidate)
      || !Number.isSafeInteger(candidate.deferredSequence)
      || (candidate.deferredSequence ?? -1) < 0
      || typeof candidate.shutdownRequested !== 'boolean'
      || typeof candidate.replayed !== 'boolean'
    ) {
      throw new Error('INCOMPATIBLE_PROCESS_SIGNAL_DEFERRAL_COORDINATOR');
    }
    return existing as ProcessSignalDeferralState;
  }

  const state: ProcessSignalDeferralState = {
    version: PROCESS_SIGNAL_DEFERRAL_VERSION,
    participants: new Set(),
    originalHandlers: new Map(),
    deferredHandlers: new Map(),
    pendingSignal: null,
    replayTimer: null,
    deferredSequence: 0,
    shutdownRequested: false,
    replayed: false,
  };
  globalRecord[PROCESS_SIGNAL_DEFERRAL_KEY] = state;
  return state;
};

const processSignalDeferral = getProcessSignalDeferralState();

const restoreProcessSignalHandlers = (state: ProcessSignalDeferralState): void => {
  for (const signal of DEFERRED_SIGNALS) {
    const gateHandler = state.deferredHandlers.get(signal);
    if (gateHandler) {
      process.removeListener(signal, gateHandler);
      state.deferredHandlers.delete(signal);
    }

    const currentHandlerCounts = new Map<NodeJS.SignalsListener, number>();
    for (const handler of process.listeners(signal) as NodeJS.SignalsListener[]) {
      currentHandlerCounts.set(handler, (currentHandlerCounts.get(handler) ?? 0) + 1);
    }

    const requiredHandlerCounts = new Map<NodeJS.SignalsListener, number>();
    for (const handler of state.originalHandlers.get(signal) ?? []) {
      const requiredCount = (requiredHandlerCounts.get(handler) ?? 0) + 1;
      requiredHandlerCounts.set(handler, requiredCount);
      const currentCount = currentHandlerCounts.get(handler) ?? 0;
      if (currentCount < requiredCount) {
        process.on(signal, handler);
        currentHandlerCounts.set(handler, currentCount + 1);
      }
    }
    state.originalHandlers.delete(signal);
  }
};

const enterProcessSignalDeferral = (participant: symbol): void => {
  const state = processSignalDeferral;
  if (state.participants.has(participant)) {
    throw new Error('PROCESS_SIGNAL_DEFERRAL_ALREADY_ENTERED');
  }
  if (state.shutdownRequested || state.pendingSignal || state.replayTimer) {
    throw new Error('DEPLOYMENT_SHUTDOWN_PENDING: refusing a new mutation');
  }

  if (state.participants.size === 0) {
    try {
      for (const signal of DEFERRED_SIGNALS) {
        const originalHandlers = process.listeners(signal) as NodeJS.SignalsListener[];
        state.originalHandlers.set(signal, originalHandlers);
        for (const handler of originalHandlers) {
          process.removeListener(signal, handler);
        }

        const gateHandler: NodeJS.SignalsListener = () => {
          state.deferredSequence += 1;
          state.shutdownRequested = true;
          state.pendingSignal ??= signal;
        };
        state.deferredHandlers.set(signal, gateHandler);
        process.on(signal, gateHandler);
      }
    } catch (error) {
      restoreProcessSignalHandlers(state);
      throw error;
    }
  }

  state.participants.add(participant);
};

const leaveProcessSignalDeferral = (participant: symbol): void => {
  const state = processSignalDeferral;
  if (!state.participants.delete(participant) || state.participants.size > 0) {
    return;
  }

  restoreProcessSignalHandlers(state);
  const pendingSignal = state.pendingSignal;
  if (!pendingSignal || state.replayed || state.replayTimer) {
    return;
  }

  state.replayTimer = setTimeout(() => {
    try {
      process.kill(process.pid, pendingSignal);
    } finally {
      // Sticky until process exit: replay authorization must never reopen the
      // mutation gate before restored shutdown listeners receive the signal.
      state.replayed = true;
      state.replayTimer = null;
    }
  }, 0);
};

const DEPLOYMENT_STEPS = new Set<DeploymentStep>([
  'init',
  'war-update',
  'undeploy',
  'stop',
  'kill',
  'start',
  'deploy',
  'verify',
  'complete',
]);

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
};

const isErrno = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === code;

const identityOf = (stats: Stats): FileIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const parseLockData = (raw: string): LockData | undefined => {
  try {
    const value = JSON.parse(raw) as Partial<LockData>;
    if (
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.started !== 'number' ||
      !Number.isFinite(value.started) ||
      value.started <= 0 ||
      typeof value.deploymentId !== 'string' ||
      value.deploymentId.length === 0 ||
      typeof value.step !== 'string' ||
      !DEPLOYMENT_STEPS.has(value.step as DeploymentStep) ||
      (value.lockVersion !== undefined && value.lockVersion !== 2) ||
      (value.ownerToken !== undefined &&
        (typeof value.ownerToken !== 'string' || value.ownerToken.length === 0)) ||
      (value.processInstanceId !== undefined &&
        (typeof value.processInstanceId !== 'string'
          || !/^[0-9a-f-]{36}$/u.test(value.processInstanceId))) ||
      (value.processIdentity !== undefined &&
        (typeof value.processIdentity !== 'string' || value.processIdentity.length > 256)) ||
      (value.ownerKind !== undefined
        && value.ownerKind !== 'general' && value.ownerKind !== 'payara-outage') ||
      (value.outageOwnerId !== undefined
        && (typeof value.outageOwnerId !== 'string' || !UUID_V4_PATTERN.test(value.outageOwnerId))) ||
      (value.targetContentSha256 !== undefined
        && (typeof value.targetContentSha256 !== 'string'
          || !SHA256_PATTERN.test(value.targetContentSha256))) ||
      (value.outageCapabilitySha256 !== undefined
        && (typeof value.outageCapabilitySha256 !== 'string'
          || !SHA256_PATTERN.test(value.outageCapabilitySha256))) ||
      (value.quarantined !== undefined && value.quarantined !== true) ||
      (value.reason !== undefined &&
        (typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 512)) ||
      (value.errorName !== undefined &&
        (typeof value.errorName !== 'string' || value.errorName.length === 0 || value.errorName.length > 128))
    ) {
      return undefined;
    }

    if (value.lockVersion === 2) {
      if (!value.processInstanceId
        || !value.ownerToken || !/^[0-9a-f-]{36}$/u.test(value.ownerToken)
        || (value.ownerKind !== 'general' && value.ownerKind !== 'payara-outage')) {
        return undefined;
      }
      if (value.ownerKind === 'general') {
        if (value.outageOwnerId || value.targetContentSha256 || value.outageCapabilitySha256) {
          return undefined;
        }
      } else if (!value.outageOwnerId
        || !value.targetContentSha256
        || !value.outageCapabilitySha256) {
        return undefined;
      }
    } else if (value.ownerKind || value.outageOwnerId
      || value.targetContentSha256 || value.outageCapabilitySha256) {
      return undefined;
    }

    return value as LockData;
  } catch {
    return undefined;
  }
};

/**
 * File-based deployment lock with shutdown-signal deferral.
 *
 * Acquisition is a single create-exclusive operation. The instance retains the
 * resulting file handle and a random owner token, so later updates target the
 * inode it acquired instead of whichever file happens to exist at the path.
 */
export class DeploymentLock {
  private readonly lockPath: string;
  private readonly logger: Logger;
  private readonly signalDeferralParticipant = Symbol('payara-deployment-lock');
  private signalDeferralActive = false;
  private acquired = false;
  private currentDeploymentId: string | null = null;
  private ownedData: LockData | null = null;
  private ownedIdentity: FileIdentity | null = null;
  private ownedHandle: FileHandle | null = null;
  private readonly coordinationMutex: ProcessEpochMutex;
  private readonly processOwnerOptions: ProcessEpochMutexOptions;
  private coordinationLease: ProcessEpochLease | null = null;

  constructor(
    logger: Logger,
    lockPath = '/var/lib/zn-vault-agent/znvault-deploy.lock',
    coordinationOptions: ProcessEpochMutexOptions = {},
  ) {
    this.lockPath = lockPath;
    this.logger = logger;
    this.processOwnerOptions = coordinationOptions;
    this.coordinationMutex = new ProcessEpochMutex(lockPath, coordinationOptions);
  }

  /** Check whether the lock exists and is valid. */
  async isLocked(): Promise<{
    locked: boolean;
    data?: LockData;
    stale?: boolean;
  }> {
    try {
      const snapshot = await this.readSnapshot();
      if (!snapshot) {
        return { locked: false };
      }

      const inspection = this.inspectSnapshot(snapshot);
      return {
        locked: inspection.locked,
        ...(inspection.data ? { data: inspection.data } : {}),
        ...(inspection.stale ? { stale: true } : {}),
      };
    } catch (error) {
      // A lock that exists but cannot be inspected must fail closed.
      this.logger.warn({ err: error, lockPath: this.lockPath }, 'Failed to inspect deployment lock');
      return { locked: true };
    }
  }

  /** Get the age of the current lock file in seconds. */
  async getLockAge(): Promise<number | null> {
    try {
      const stats = await stat(this.lockPath);
      return (Date.now() - stats.mtimeMs) / 1000;
    } catch {
      return null;
    }
  }

  /**
   * Acquire the deployment lock atomically.
   * Throws if another deployment is in progress or contention cannot be
   * resolved within a bounded number of retries.
   */
  async acquire(
    deploymentId: string,
    options: DeploymentLockAcquireOptions = {},
  ): Promise<void> {
    if (this.acquired || this.ownedHandle || this.currentDeploymentId !== null) {
      throw new Error(`Deployment lock instance already acquired by ${this.currentDeploymentId}`);
    }
    if (options.authorizeStaleTakeover && !options.outageScope) {
      throw new Error('DEPLOYMENT_LOCK_RECOVERY_SCOPE_REQUIRED');
    }
    if (options.outageScope && (
      !UUID_V4_PATTERN.test(options.outageScope.outageOwnerId)
      || !SHA256_PATTERN.test(options.outageScope.targetContentSha256)
      || !SHA256_PATTERN.test(options.outageScope.outageCapabilitySha256)
    )) {
      throw new Error('DEPLOYMENT_LOCK_OUTAGE_SCOPE_INVALID');
    }

    const lockData: LockData = {
      lockVersion: 2,
      ...currentProcessOwnerEvidence(this.processOwnerOptions.processIdentity),
      pid: process.pid,
      started: Date.now(),
      deploymentId,
      step: 'init',
      ownerToken: randomUUID(),
      ownerKind: options.outageScope ? 'payara-outage' : 'general',
      ...(options.outageScope ?? {}),
    };

    // Install the shutdown fence before the first asynchronous filesystem
    // operation. Once O_EXCL creates the pathname, normal shutdown must not run
    // until initialization either proves ownership or removes/retains the path.
    this.currentDeploymentId = deploymentId;

    try {
      this.registerSignalHandlers();
      try {
        this.coordinationLease = this.coordinationMutex.acquire(
          `deployment-lock:${deploymentId}`,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('PROCESS_EPOCH_ACTIVE:')) {
          throw new Error(`Deployment already in progress: ${error.message}`);
        }
        throw error;
      }
      for (let attempt = 1; attempt <= ACQUIRE_ATTEMPTS; attempt += 1) {
        let handle = await this.createFreshLock(lockData);
        if (!handle) {
          const replacement = await this.replaceStaleLock(
            lockData,
            options,
          );
          if (replacement) {
            handle = replacement;
          } else if (attempt < ACQUIRE_ATTEMPTS) {
            await delay(ACQUIRE_RETRY_MS);
            continue;
          } else {
            throw new Error(
              `Unable to acquire deployment lock after ${ACQUIRE_ATTEMPTS} attempts: ` +
              `${this.lockPath} remained contended`
            );
          }
        }

        let identity: FileIdentity | undefined;
        let retryInitialization = false;
        try {
          identity = identityOf(await handle.stat());
          const pathSnapshot = await this.readSnapshot();
          if (
            !pathSnapshot ||
            !sameIdentity(pathSnapshot.identity, identity) ||
            pathSnapshot.data?.ownerToken !== lockData.ownerToken
          ) {
            retryInitialization = attempt < ACQUIRE_ATTEMPTS;
            throw new Error('Deployment lock ownership changed while it was being initialized');
          }

          // Persist the pathname itself, not only its contents. A successful
          // acquire must remain authoritative across a power loss.
          await this.syncLockDirectory();

          this.acquired = true;
          this.ownedData = lockData;
          this.ownedIdentity = identity;
          this.ownedHandle = handle;

          this.logger.info({ deploymentId, lockPath: this.lockPath }, 'Deployment lock acquired');
          return;
        } catch (error) {
          await handle.close().catch(() => undefined);
          if (identity) {
            // Initialization may fail before valid JSON exists, so inode
            // identity is the only ownership proof available for cleanup.
            await this.removeOwnedPath(identity, undefined);
          }
          if (retryInitialization) {
            await delay(ACQUIRE_RETRY_MS);
            continue;
          }
          throw error;
        }
      }

      throw new Error(`Unable to acquire deployment lock: ${this.lockPath}`);
    } catch (error) {
      this.releaseCoordinationLease();
      this.currentDeploymentId = null;
      this.finishSignalDeferral();
      throw error;
    }
  }

  /** Update only the inode acquired by this instance. */
  async updateStep(step: DeploymentStep): Promise<void> {
    if (!this.acquired || !this.ownedHandle || !this.ownedData || !this.ownedIdentity) {
      throw new Error('Cannot update step: lock not acquired');
    }

    try {
      const pathSnapshot = await this.readSnapshot();
      if (!this.isOwnedSnapshot(pathSnapshot)) {
        throw new Error(
          `DEPLOYMENT_LOCK_LOST: cannot enter ${step}; lock path no longer belongs to ` +
          `${this.currentDeploymentId}`
        );
      }

      const handleData = parseLockData(await this.readHandle(this.ownedHandle));
      if (handleData?.ownerToken !== this.ownedData.ownerToken) {
        throw new Error(
          `DEPLOYMENT_LOCK_LOST: owned lock content changed before ${step} for ` +
          `${this.currentDeploymentId}`
        );
      }

      const updated: LockData = { ...this.ownedData, step };
      await this.writeHandle(this.ownedHandle, updated);
      this.ownedData = updated;

      const afterUpdate = await this.readSnapshot();
      if (this.isOwnedSnapshot(afterUpdate)) {
        this.logger.debug({ step, deploymentId: this.currentDeploymentId }, 'Deployment step updated');
      } else {
        throw new Error(
          `DEPLOYMENT_LOCK_LOST: lock ownership changed while entering ${step} for ` +
          `${this.currentDeploymentId}`
        );
      }
    } catch (error) {
      this.logger.error({ err: error, step }, 'Failed to retain deployment lock ownership');
      throw error;
    }
  }

  /** Release this instance's lock without removing a replacement. */
  async release(): Promise<void> {
    if (!this.acquired) {
      return;
    }

    const deploymentId = this.currentDeploymentId;
    const handle = this.ownedHandle;
    let releaseError: Error | undefined;
    try {
      if (this.ownedIdentity && this.ownedData?.ownerToken) {
        const removed = await this.removeOwnedPath(
          this.ownedIdentity,
          this.ownedData.ownerToken,
          () => this.releaseCoordinationLease(),
        );
        if (removed) {
          this.logger.info({ deploymentId }, 'Deployment lock released');
        } else {
          releaseError = new Error(
            `DEPLOYMENT_LOCK_LOST: lock ownership changed during release for ${deploymentId}`
          );
          this.logger.error({ deploymentId }, releaseError.message);
        }
      } else {
        releaseError = new Error(
          `DEPLOYMENT_LOCK_LOST: lock no longer belongs to ${deploymentId}`
        );
        this.logger.error({ deploymentId }, releaseError.message);
      }
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err: error }, 'Failed to remove deployment lock');
    } finally {
      if (handle) {
        await handle.close().catch(error => {
          this.logger.warn({ err: error }, 'Failed to close deployment lock handle');
        });
      }

      this.acquired = false;
      this.currentDeploymentId = null;
      this.ownedData = null;
      this.ownedIdentity = null;
      this.ownedHandle = null;
      try {
        this.releaseCoordinationLease();
      } catch (error) {
        releaseError ??= error instanceof Error ? error : new Error(String(error));
      }
      this.finishSignalDeferral();
    }

    if (releaseError) {
      throw releaseError;
    }
  }

  /** Check if this instance holds the lock. */
  isAcquired(): boolean {
    return this.acquired;
  }

  getCurrentStep(): DeploymentStep | undefined {
    return this.ownedData?.step;
  }

  /**
   * Close this process's handle but deliberately leave the owned lock path as
   * a durable lifecycle quarantine. Recovery requires an explicitly quiesced
   * operator action; automatic stale reaping remains forbidden.
   */
  async quarantine(
    reason: string,
    errorName = 'BOOT_LIFECYCLE_OUTCOME_UNKNOWN'
  ): Promise<void> {
    if (!this.acquired || !this.ownedHandle || !this.ownedIdentity || !this.ownedData) {
      throw new Error('DEPLOYMENT_LOCK_NOT_OWNED: cannot quarantine lifecycle failure');
    }
    const snapshot = await this.readSnapshot();
    if (!this.isOwnedSnapshot(snapshot)) {
      throw new Error('DEPLOYMENT_LOCK_LOST: cannot retain lifecycle quarantine');
    }
    const quarantinedData: LockData = {
      ...this.ownedData,
      quarantined: true,
      reason,
      errorName,
    };
    await this.writeHandle(this.ownedHandle, quarantinedData);
    this.ownedData = quarantinedData;
    const persisted = await this.readSnapshot();
    if (!this.isOwnedSnapshot(persisted) || !persisted?.data?.quarantined) {
      throw new Error('DEPLOYMENT_LOCK_LOST: lifecycle quarantine metadata was not persisted');
    }
    const deploymentId = this.currentDeploymentId;
    await this.ownedHandle.close();
    this.acquired = false;
    this.currentDeploymentId = null;
    this.ownedData = null;
    this.ownedIdentity = null;
    this.ownedHandle = null;
    this.releaseCoordinationLease();
    this.finishSignalDeferral();
    this.logger.error(
      { deploymentId, lockPath: this.lockPath, reason },
      'Lifecycle outcome is ambiguous; deployment lock retained as quarantine'
    );
  }

  /** Check if a shutdown signal is pending. */
  isPendingShutdown(): boolean {
    return processSignalDeferral.pendingSignal !== null;
  }

  private async replaceStaleLock(
    replacementData: LockData,
    options: DeploymentLockAcquireOptions,
  ): Promise<FileHandle | undefined> {
    const snapshot = await this.readSnapshot();
    if (!snapshot) {
      return undefined;
    }

    const inspection = this.inspectSnapshot(snapshot);
    if (inspection.locked) {
      if (inspection.data) {
        const quarantine = inspection.data.quarantined
          ? `, quarantined: ${inspection.data.errorName ?? 'unknown'} ` +
            `(${inspection.data.reason ?? 'no reason'})`
          : '';
        throw new Error(
          `Deployment already in progress: ${inspection.data.deploymentId} ` +
          `(started ${Math.round((Date.now() - inspection.data.started) / 1000)}s ago, ` +
          `step: ${inspection.data.step}${quarantine})`
        );
      }

      return undefined;
    }

    if (!inspection.stale) {
      return undefined;
    }
    const staleData = inspection.data;
    if (staleData?.quarantined) {
      throw new Error(
        'STALE_DEPLOYMENT_LOCK_QUARANTINED: explicit lifecycle reconciliation is required for ' +
        `${staleData.deploymentId}`,
      );
    }
    const scope = options.outageScope;
    const scopedOutageLock = Boolean(
      staleData
      && staleData.lockVersion === 2
      && staleData.ownerKind === 'payara-outage'
      && scope
      && staleData.outageOwnerId === scope.outageOwnerId
      && staleData.targetContentSha256 === scope.targetContentSha256
      && staleData.outageCapabilitySha256 === scope.outageCapabilitySha256,
    );
    if (!scopedOutageLock || !staleData || !options.authorizeStaleTakeover) {
      throw new Error(
        'STALE_DEPLOYMENT_LOCK_SCOPE_MISMATCH: automatic takeover is limited to an exact ' +
        `Payara outage lock; observed ${staleData?.deploymentId ?? this.lockPath}`,
      );
    }
    await options.authorizeStaleTakeover(staleData);
    const revalidated = await this.readSnapshot();
    if (!revalidated
      || !sameIdentity(revalidated.identity, snapshot.identity)
      || revalidated.raw !== snapshot.raw) {
      throw new Error('STALE_DEPLOYMENT_LOCK_CHANGED: stale lock changed during fenced takeover');
    }

    // Write the successor first, then atomically replace the exact revalidated
    // stale pathname. There is no O_EXCL gap in which an older plugin that does
    // not know the coordination epochs could acquire the deployment lock.
    const replacementPath = `${this.lockPath}.takeover-${randomUUID()}`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(replacementPath, 'wx+', 0o644);
      await this.writeHandle(handle, replacementData);
      const replacementIdentity = identityOf(await handle.stat());
      const beforeRename = await this.readSnapshot();
      if (!beforeRename
        || !sameIdentity(beforeRename.identity, snapshot.identity)
        || beforeRename.raw !== snapshot.raw) {
        throw new Error('STALE_DEPLOYMENT_LOCK_CHANGED: stale lock changed before atomic takeover');
      }
      await rename(replacementPath, this.lockPath);
      await this.syncLockDirectory();
      const installed = await this.readSnapshot();
      if (!installed
        || !sameIdentity(installed.identity, replacementIdentity)
        || installed.data?.ownerToken !== replacementData.ownerToken) {
        throw new Error('STALE_DEPLOYMENT_LOCK_CHANGED: successor lock was not installed exactly');
      }
      this.logger.warn(
        { previousDeploymentId: staleData.deploymentId, lockPath: this.lockPath },
        'Recovered deployment lock from a proven dead process owner',
      );
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(replacementPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Publish a fully written inode with a no-replace hard link. */
  private async createFreshLock(lockData: LockData): Promise<FileHandle | undefined> {
    const temporaryPath = `${this.lockPath}.acquiring-${randomUUID()}`;
    let handle: FileHandle | undefined;
    let publishedIdentity: FileIdentity | undefined;
    try {
      handle = await open(temporaryPath, 'wx+', 0o644);
      await this.writeHandle(handle, lockData);
      publishedIdentity = identityOf(await handle.stat());
      try {
        await link(temporaryPath, this.lockPath);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
        await handle.close();
        handle = undefined;
        return undefined;
      }
      await rm(temporaryPath);
      await this.syncLockDirectory();
      return handle;
    } catch (error) {
      if (publishedIdentity) {
        await this.removeOwnedPath(publishedIdentity, lockData.ownerToken);
      }
      await handle?.close().catch(() => undefined);
      throw error;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async syncLockDirectory(): Promise<void> {
    const directory = await open(dirname(this.lockPath), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private inspectSnapshot(snapshot: LockSnapshot): LockInspection {
    const data = snapshot.data;
    if (!data) {
      const incompleteAgeMs = Date.now() - snapshot.mtimeMs;
      return incompleteAgeMs >= INCOMPLETE_LOCK_GRACE_MS
        ? { locked: false, stale: true }
        : { locked: true, stale: false };
    }

    if (data.processInstanceId) {
      return processOwnerIsAlive({
        pid: data.pid,
        processInstanceId: data.processInstanceId,
        ...(data.processIdentity ? { processIdentity: data.processIdentity } : {}),
      }, this.processOwnerOptions)
        ? { locked: true, stale: false, data }
        : { locked: false, stale: true, data };
    }

    try {
      process.kill(data.pid, 0);
      return { locked: true, stale: false, data };
    } catch (error) {
      if (isErrno(error, 'EPERM')) return { locked: true, stale: false, data };
      if (isErrno(error, 'ESRCH')) return { locked: false, stale: true, data };
      return { locked: true, stale: false, data };
    }
  }

  private async readSnapshot(): Promise<LockSnapshot | null> {
    return this.readSnapshotAt(this.lockPath);
  }

  private async readSnapshotAt(path: string): Promise<LockSnapshot | null> {
    let handle: FileHandle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return null;
      }
      throw error;
    }

    try {
      const stats = await handle.stat();
      const raw = stats.size <= MAX_LOCK_BYTES ? await this.readHandle(handle) : '';
      return {
        raw,
        data: parseLockData(raw),
        identity: identityOf(stats),
        mtimeMs: stats.mtimeMs,
      };
    } finally {
      await handle.close();
    }
  }

  private async readHandle(handle: FileHandle): Promise<string> {
    const stats = await handle.stat();
    if (stats.size > MAX_LOCK_BYTES || stats.size === 0) {
      return '';
    }

    const buffer = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
  }

  private async writeHandle(handle: FileHandle, data: LockData): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(data, null, 2));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
      if (bytesWritten === 0) {
        throw new Error('Unable to write deployment lock');
      }
      offset += bytesWritten;
    }
    await handle.truncate(buffer.length);
    await handle.sync();
  }

  private isOwnedSnapshot(snapshot: LockSnapshot | null): snapshot is LockSnapshot {
    return Boolean(
      snapshot &&
      this.ownedIdentity &&
      this.ownedData?.ownerToken &&
      sameIdentity(snapshot.identity, this.ownedIdentity) &&
      snapshot.data?.ownerToken === this.ownedData.ownerToken
    );
  }

  /**
   * Move an owned pathname to a unique tombstone before deleting it. Once the
   * rename succeeds, a successor may claim lockPath without being targeted by
   * this cleanup. Stale/unowned locks are never removed by this method.
   */
  private async removeOwnedPath(
    identity: FileIdentity,
    ownerToken: string | undefined,
    onPathDetached?: () => void,
  ): Promise<boolean> {
    const tombstonePath = `${this.lockPath}.released-${randomUUID()}`;
    try {
      const snapshot = await this.readSnapshot();
      if (!snapshot || !sameIdentity(snapshot.identity, identity)) {
        return false;
      }
      if (ownerToken && snapshot.data?.ownerToken !== ownerToken) {
        return false;
      }

      await rename(this.lockPath, tombstonePath);
      await this.syncLockDirectory();
      onPathDetached?.();
      const moved = await this.readSnapshotAt(tombstonePath);
      if (
        !moved
        || !sameIdentity(moved.identity, identity)
        || (ownerToken && moved.data?.ownerToken !== ownerToken)
      ) {
        this.logger.error(
          { tombstonePath },
          'Deployment lock identity changed during release; quarantined path preserved'
        );
        return false;
      }

      await rm(tombstonePath);
      await this.syncLockDirectory();
      return true;
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        this.logger.warn({ err: error }, 'Failed to remove owned deployment lock');
      }
      return false;
    }
  }

  /** Join the process-wide gate shared with every agent/plugin lock instance. */
  private registerSignalHandlers(): void {
    if (this.signalDeferralActive) {
      throw new Error('PROCESS_SIGNAL_DEFERRAL_ALREADY_ENTERED');
    }
    enterProcessSignalDeferral(this.signalDeferralParticipant);
    this.signalDeferralActive = true;
  }

  /** Restore peer listeners, then replay at most the first deferred signal. */
  private finishSignalDeferral(): void {
    if (!this.signalDeferralActive) return;
    this.signalDeferralActive = false;
    leaveProcessSignalDeferral(this.signalDeferralParticipant);
  }

  private releaseCoordinationLease(): void {
    const lease = this.coordinationLease;
    if (!lease) return;
    this.coordinationLease = null;
    this.coordinationMutex.release(lease);
  }
}
