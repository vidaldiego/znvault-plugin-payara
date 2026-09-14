import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface SchedulerDeploymentHold {
  version: 2;
  outageId: string;
  targetContentSha256: string;
  capabilitySha256: string;
}

function valid(value: unknown): value is SchedulerDeploymentHold {
  if (!value || typeof value !== 'object') return false;
  const hold = value as Record<string, unknown>;
  return Object.keys(hold).sort().join(',') === 'capabilitySha256,outageId,targetContentSha256,version'
    && hold.version === 2
    && typeof hold.outageId === 'string'
    && UUID_V4_PATTERN.test(hold.outageId)
    && typeof hold.targetContentSha256 === 'string'
    && SHA256_PATTERN.test(hold.targetContentSha256)
    && typeof hold.capabilitySha256 === 'string'
    && SHA256_PATTERN.test(hold.capabilitySha256);
}

/** Public, non-secret boot marker consumed by the WAR before arming schedulers. */
export class SchedulerDeploymentHoldStore {
  constructor(private readonly path: string) {}

  read(): SchedulerDeploymentHold | undefined {
    try {
      const stats = lstatSync(this.path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 4096) {
        throw new Error('SCHEDULER_DEPLOYMENT_HOLD_INVALID: marker must be a bounded regular file');
      }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (!valid(parsed)) {
        throw new Error('SCHEDULER_DEPLOYMENT_HOLD_INVALID: marker schema is invalid');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  arm(
    outageId: string,
    targetContentSha256: string,
    capabilitySha256: string,
  ): SchedulerDeploymentHold {
    const hold: SchedulerDeploymentHold = {
      version: 2,
      outageId,
      targetContentSha256,
      capabilitySha256,
    };
    if (!valid(hold)) throw new Error('SCHEDULER_DEPLOYMENT_HOLD_INVALID: invalid outage marker');
    const existing = this.read();
    if (existing) {
      if (
        existing.outageId !== outageId
        || existing.targetContentSha256 !== targetContentSha256
        || existing.capabilitySha256 !== capabilitySha256
      ) {
        throw new Error('SCHEDULER_DEPLOYMENT_HOLD_CONFLICT: another rollout owns the boot hold');
      }
      return existing;
    }
    this.persist(hold);
    return hold;
  }

  assert(
    outageId: string,
    targetContentSha256: string,
    capabilitySha256?: string,
  ): void {
    const hold = this.read();
    if (
      !hold
      || hold.outageId !== outageId
      || hold.targetContentSha256 !== targetContentSha256
      || (capabilitySha256 !== undefined && hold.capabilitySha256 !== capabilitySha256)
    ) {
      throw new Error('SCHEDULER_DEPLOYMENT_HOLD_MISMATCH: exact boot hold is not armed');
    }
  }

  clear(outageId: string, targetContentSha256: string): void {
    this.assert(outageId, targetContentSha256);
    rmSync(this.path);
    this.syncDirectory();
  }

  clearIfOwned(outageId: string, targetContentSha256: string): boolean {
    const hold = this.read();
    if (!hold) return false;
    if (hold.outageId !== outageId || hold.targetContentSha256 !== targetContentSha256) {
      throw new Error('SCHEDULER_DEPLOYMENT_HOLD_MISMATCH: exact boot hold is not armed');
    }
    rmSync(this.path);
    this.syncDirectory();
    return true;
  }

  /**
   * Make an already-observed absence durable before accepting recovery after
   * an API restart. A failed directory fsync leaves the caller fenced; the
   * exact releasing receipt can safely retry this operation later.
   */
  confirmAbsentDurably(): void {
    if (this.read()) {
      throw new Error('SCHEDULER_DEPLOYMENT_HOLD_PRESENT: marker is still armed');
    }
    this.syncDirectory();
    if (this.read()) {
      throw new Error('SCHEDULER_DEPLOYMENT_HOLD_PRESENT: marker reappeared during confirmation');
    }
  }

  private persist(hold: SchedulerDeploymentHold): void {
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o644);
      writeFileSync(descriptor, `${JSON.stringify(hold)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.path);
      this.syncDirectory();
      this.assert(hold.outageId, hold.targetContentSha256, hold.capabilitySha256);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporaryPath, { force: true });
    }
  }

  private syncDirectory(): void {
    const descriptor = openSync(dirname(this.path), 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
