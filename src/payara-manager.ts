// Path: src/payara-manager.ts
// Payara application server process management

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  type Dirent,
} from 'node:fs';
import { access, constants, readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import type {
  BootDeploymentOwnership,
  BootDeploymentReadiness,
  BootDeploymentStatus,
  BootStartupReceipt,
  BootRecoveryAuthorization,
  BootRecoveryResult,
  BootReadinessAttestation,
  PayaraManagerOptions,
  PayaraStatus,
  PostStartDeploymentPolicy,
  PostStartDeploymentResult,
} from './types.js';
import { killProcessesByPid, killProcessesByPkill } from './utils/process-killer.js';
import { TtlCache } from './utils/ttl-cache.js';
import {
  buildPayaraProcessEnv,
  getSetenvPath,
  isValidUsername,
  validatePathArgument,
  validatePayaraIdentifier,
  writeSetenvConf,
} from './payara-env.js';
import {
  MutationQuarantineStore,
  type MutationQuarantineRecord,
} from './mutation-quarantine.js';

const DEFAULT_BOOT_OWNERSHIP_TIMEOUT_MS = 90000;
const DEFAULT_BOOT_OWNERSHIP_POLL_INTERVAL_MS = 2000;
const DEFAULT_BOOT_OWNERSHIP_ABSENCE_GRACE_MS = 20000;
const DEFAULT_MUTATION_QUARANTINE_PATH =
  '/var/lib/zn-vault-agent/payara-mutation-quarantine/state.json';
const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const COMMAND_TERMINATION_GRACE_MS = 250;
const COMMAND_TERMINAL_WAIT_MS = 1000;
const EXEC_WITH_SETENV_SCRIPT = [
  'set -euo pipefail',
  'setenv_path="$1"',
  'shift',
  'source "$setenv_path"',
  'exec "$@"',
].join('; ');

const EMPTY_LIST_MESSAGES = [
  /^Nothing to list\.?$/i,
  /^No applications are deployed(?: to this target server)?\.?$/i,
  /^No application references (?:exist|found)\.?$/i,
];

function bootOwnershipError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  error.name = code;
  return error;
}

function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasAuditControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

interface ProcessCommandError extends Error {
  code?: number | string | null;
  stdout?: string;
  stderr?: string;
}

/**
 * Run one executable with an argv vector in its own process group. No command
 * text is parsed by a shell. TERM/KILL is best-effort cleanup: when sudo crosses
 * from the Agent uid to the Payara uid, the caller cannot prove that every
 * descendant received the signal. Consequently, callers must treat every
 * post-dispatch timeout as UNKNOWN and retain the durable lifecycle/application
 * quarantine until exact runtime reconciliation proves a terminal state.
 */
function executeProcessCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  environment: NodeJS.ProcessEnv,
  acceptedExitCodes: readonly number[] = [0]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (command.includes('\0') || args.some(argument => argument.includes('\0'))) {
      rejectPromise(new Error('Process command and arguments cannot contain NUL bytes'));
      return;
    }
    const effectiveTimeoutMs = Math.max(1, Math.floor(timeoutMs));
    const gracefulTerminationMs = Math.min(
      COMMAND_TERMINATION_GRACE_MS,
      Math.max(0, effectiveTimeoutMs - 1)
    );
    const commandRunMs = Math.max(1, effectiveTimeoutMs - gracefulTerminationMs);
    const detached = process.platform !== 'win32';
    const child = spawn(command, [...args], {
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    });

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let terminationError: ProcessCommandError | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let terminalWaitTimer: NodeJS.Timeout | undefined;

    const signalProcessGroup = (signal: NodeJS.Signals): void => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
          // Fall back to the direct child if process-group signalling is not
          // available on this platform/user boundary.
        }
      }
      try {
        child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };

    const cleanup = (): void => {
      clearTimeout(terminationTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (terminalWaitTimer) clearTimeout(terminalWaitTimer);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
    };

    const finishReject = (error: ProcessCommandError): void => {
      if (settled) return;
      settled = true;
      error.stdout = stdout;
      error.stderr = stderr;
      cleanup();
      rejectPromise(error);
    };

    const beginTermination = (error: ProcessCommandError): void => {
      if (terminationError || settled) return;
      terminationError = error;
      signalProcessGroup('SIGTERM');
      forceKillTimer = setTimeout(() => {
        signalProcessGroup('SIGKILL');
        terminalWaitTimer = setTimeout(() => {
          const terminalError = new Error(
            `${error.message}; process group did not report a terminal close after SIGKILL`
          ) as ProcessCommandError;
          terminalError.name = error.name;
          terminalError.code = error.code;
          finishReject(terminalError);
        }, COMMAND_TERMINAL_WAIT_MS);
      }, gracefulTerminationMs);
    };

    const appendOutput = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > COMMAND_OUTPUT_LIMIT_BYTES) {
        const error = new Error(
          `COMMAND_OUTPUT_LIMIT_EXCEEDED: process command exceeded ${COMMAND_OUTPUT_LIMIT_BYTES} bytes`
        ) as ProcessCommandError;
        error.name = 'COMMAND_OUTPUT_LIMIT_EXCEEDED';
        error.code = 'ENOBUFS';
        beginTermination(error);
        return;
      }
      if (target === 'stdout') stdout += buffer.toString();
      else stderr += buffer.toString();
    };

    child.stdout?.on('data', chunk => appendOutput('stdout', chunk));
    child.stderr?.on('data', chunk => appendOutput('stderr', chunk));

    child.once('error', error => {
      finishReject(error as ProcessCommandError);
    });
    child.once('close', code => {
      if (settled) return;
      if (terminationError) {
        terminationError.code ??= code;
        finishReject(terminationError);
        return;
      }
      if (code !== null && acceptedExitCodes.includes(code)) {
        settled = true;
        cleanup();
        resolvePromise({ stdout, stderr });
        return;
      }
      const error = new Error(`Command failed with exit code ${String(code)}`) as ProcessCommandError;
      error.code = code;
      finishReject(error);
    });

    // The public timeout includes the TERM→KILL window. Starting graceful
    // termination before the hard edge prevents cleanup from silently adding
    // another quarter-second to a lifecycle deadline.
    const terminationTimer = setTimeout(() => {
      const error = new Error(
        `COMMAND_TIMEOUT: process command exceeded ${effectiveTimeoutMs}ms`
      ) as ProcessCommandError;
      error.name = 'COMMAND_TIMEOUT';
      error.code = 'ETIMEDOUT';
      beginTermination(error);
    }, commandRunMs);
  });
}

function lifecycleOutcomeUnknown(action: string, cause: unknown): Error {
  const error = bootOwnershipError(
    'BOOT_LIFECYCLE_OUTCOME_UNKNOWN',
    `${action} was dispatched but did not reach a verified terminal state; ` +
    'quiesce lifecycle entry points and reconcile the exact DAS before clearing the deployment lock'
  );
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

interface InternalBootDeploymentState {
  appName: string;
  bootEpoch: string;
  phase: BootDeploymentStatus['phase'];
  readiness: BootDeploymentReadiness;
  startupActive: boolean;
  startedAtMs: number;
  readyAtMs?: number;
  evidenceSource?: string;
  startupReceipt?: BootStartupReceipt;
  owner?: 'payara' | 'agent';
  runtimeListed?: boolean;
  mutationOutcomeUnknown: boolean;
  durableQuarantineRecordId?: string;
  startupToken?: symbol;
  reservationToken?: symbol;
}

type ExternalChildLifecycleEvent =
  | 'started'
  | 'stopped'
  | 'restarting'
  | 'crashed'
  | 'max_restarts';

interface ExternalRuntimeTransition {
  source: string;
  previousRuntimeIdentity?: string | number;
  startedObserved: boolean;
  exactAbsenceObserved: boolean;
}

/** Parse terse asadmin inventory without turning diagnostics into app names. */
function parseTerseApplicationNames(
  output: string,
  command: 'list-applications' | 'list-application-refs'
): string[] {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^Command .* executed successfully\.?$/i.test(line));

  if (lines.length === 0 || lines.every(line => EMPTY_LIST_MESSAGES.some(pattern => pattern.test(line)))) {
    return [];
  }

  const names = lines.map(line => {
    const match = command === 'list-applications'
      ? line.match(/^(\S+)\s+<[^<>]+>$/)
      : line.match(/^(\S+)$/);

    if (!match?.[1]) {
      throw bootOwnershipError(
        'BOOT_INVENTORY_UNPARSEABLE',
        `Unexpected output from ${command}`
      );
    }
    return match[1];
  });

  return [...new Set(names)];
}

/**
 * Manages Payara application server lifecycle
 */
export class PayaraManager {
  private readonly payaraHome: string;
  private readonly domainRoot: string;
  private readonly asadmin: string;
  readonly domain: string;
  private readonly user: string;
  private readonly healthEndpoint?: string;
  private readonly healthCheckTimeout: number;
  private readonly operationTimeout: number;
  private readonly deployTimeout: number;
  private readonly logger: Logger;
  private environment: Record<string, string>;
  private readonly passwordFile?: string;
  private readonly runtimeIdentityProvider: () => Promise<string | number | undefined>;
  private readonly runtimeIdentitySyncProvider: () => string | number | undefined;
  private readonly mutationQuarantineInstanceId: string;
  private readonly mutationQuarantine?: MutationQuarantineStore;
  private activeMutationQuarantine?: MutationQuarantineRecord;

  /** Status cache to reduce shell calls during frequent polling */
  private readonly statusCache: TtlCache<PayaraStatus>;

  /** Per-application single-writer state, bound to a unique domain boot epoch. */
  private readonly bootDeploymentStates = new Map<string, InternalBootDeploymentState>();
  private currentBootEpoch = randomUUID();
  private currentBootStartedAtMs = Date.now();
  private currentRuntimeIdentity?: string | number;
  private externalRuntimeTransition?: ExternalRuntimeTransition;
  /** One-shot operator recovery IDs, valid only inside the current boot epoch. */
  private readonly consumedBootRecoveryAuthorizations = new Map<string, Set<string>>();

  /** One re-entrant lease serializes startup, lifecycle, ownership, and deployment. */
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly mutationContext = new AsyncLocalStorage<symbol>();
  private activeMutationToken?: symbol;
  private mutationLeaseCount = 0;

  constructor(options: PayaraManagerOptions) {
    validatePathArgument(options.payaraHome, 'payaraHome');
    validatePayaraIdentifier(options.domain, 'Payara domain');
    if (options.user && !isValidUsername(options.user)) {
      throw new Error('Payara user has an invalid account-name format');
    }
    if (options.passwordFile !== undefined) {
      validatePathArgument(options.passwordFile, 'asadmin passwordFile');
    }
    const resolvedPayaraHome = resolve(options.payaraHome);
    let canonicalPayaraHome = resolvedPayaraHome;
    try {
      canonicalPayaraHome = realpathSync(resolvedPayaraHome);
    } catch {
      // validateAsadmin() remains the fail-closed existence gate. Resolving dot
      // segments here still prevents textual aliases in deferred/test setups.
    }
    this.payaraHome = canonicalPayaraHome;
    const resolvedDomainRoot = resolve(
      canonicalPayaraHome,
      'glassfish',
      'domains',
      options.domain
    );
    try {
      this.domainRoot = realpathSync(resolvedDomainRoot);
    } catch {
      this.domainRoot = resolvedDomainRoot;
    }
    this.domain = options.domain;
    this.user = options.user;
    this.healthEndpoint = options.healthEndpoint;
    this.healthCheckTimeout = options.healthCheckTimeout ?? 30000;
    this.operationTimeout = options.operationTimeout ?? 120000;
    // Deploy timeout should be longer than operation timeout (default 10 minutes)
    // Deployment can take a long time for large WARs
    this.deployTimeout = options.deployTimeout ?? 600000;
    this.logger = options.logger;
    this.environment = options.environment ?? {};
    this.passwordFile = options.passwordFile;
    this.runtimeIdentityProvider = options.runtimeIdentityProvider
      ?? (() => this.readRuntimeIdentity());
    this.runtimeIdentitySyncProvider = options.runtimeIdentitySyncProvider
      ?? (options.runtimeIdentityProvider
        ? () => {
            throw bootOwnershipError(
              'BOOT_RUNTIME_SYNC_IDENTITY_UNAVAILABLE',
              'A custom async runtime identity requires a matching synchronous recovery probe'
            );
          }
        : () => this.readRuntimeIdentitySync());
    // Namespace durable ambiguity by the canonical physical domain resource,
    // never by a textual user alias (`payara`, numeric UID, LDAP spelling).
    this.mutationQuarantineInstanceId = createHash('sha256')
      .update(this.domainRoot)
      .digest('hex');
    if (
      typeof options.mutationQuarantinePath === 'string'
      && !isAbsolute(options.mutationQuarantinePath)
    ) {
      throw bootOwnershipError(
        'BOOT_QUARANTINE_PATH_INVALID',
        'mutationQuarantinePath must be absolute'
      );
    }
    this.mutationQuarantine = options.mutationQuarantinePath === false
      ? undefined
      : new MutationQuarantineStore(
          options.mutationQuarantinePath ?? DEFAULT_MUTATION_QUARANTINE_PATH
        );

    // Initialize status cache with TTL
    this.statusCache = new TtlCache<PayaraStatus>({
      ttlMs: options.statusCacheTtlMs ?? 5000,
      logger: options.logger,
      name: 'payara-status',
    });

    // Path to asadmin command
    this.asadmin = join(this.payaraHome, 'bin', 'asadmin');
  }

  /** Register an application so every later domain start rotates its boot epoch. */
  registerApplication(appName: string): void {
    this.getOrCreateBootState(appName);
  }

  /**
   * Close the fence synchronously when the agent reports an externally managed
   * child-process lifecycle transition. The next read/mutation must bind this
   * new epoch to the observed DAS uptime before it can proceed.
   */
  fenceExternalRuntimeChange(
    source: string,
    eventType?: ExternalChildLifecycleEvent
  ): void {
    const previousBootEpoch = this.currentBootEpoch;
    const sourceEvent = /^child-process:(started|stopped|restarting|crashed|max_restarts)$/
      .exec(source)?.[1] as ExternalChildLifecycleEvent | undefined;
    const parsedEventType = eventType ?? sourceEvent;
    if (parsedEventType) {
      const pending = this.externalRuntimeTransition ?? {
        source,
        previousRuntimeIdentity: this.currentRuntimeIdentity,
        startedObserved: false,
        exactAbsenceObserved: false,
      };
      pending.source = source;
      if (parsedEventType === 'started') {
        pending.startedObserved = true;
      }
      this.externalRuntimeTransition = pending;
    }
    // Keep the last exact identity. Lifecycle notifications can arrive before
    // the old DAS exits; the next procfs probe must still distinguish the same
    // JVM from a genuinely new one before UNKNOWN may be cleared.
    this.beginBootEpoch(this.currentRuntimeIdentity, source);
    if (parsedEventType) {
      for (const state of this.bootDeploymentStates.values()) {
        state.phase = 'blocked';
        state.readiness = 'unverified';
        state.owner = undefined;
        state.runtimeListed = undefined;
        if (!state.mutationOutcomeUnknown) {
          state.evidenceSource = source;
        }
      }
    }
    this.logger.warn(
      { previousBootEpoch, bootEpoch: this.currentBootEpoch, source },
      'External Payara lifecycle event closed the deployment fence'
    );
  }

  /** Whether a lifecycle/deployment mutation currently owns or is waiting on the lease. */
  isMutationInProgress(): boolean {
    return this.mutationLeaseCount > 0;
  }

  /**
   * Serialize every agent-side lifecycle and deployment mutation.
   * Calls made from inside the same async lease are re-entrant.
   */
  async withMutationLease<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const inheritedToken = this.mutationContext.getStore();
    if (inheritedToken && inheritedToken === this.activeMutationToken) {
      return operation();
    }

    let release!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>(resolve => {
      release = resolve;
    });
    this.mutationLeaseCount += 1;
    await previous;

    const token = Symbol(label);
    this.activeMutationToken = token;
    try {
      return await this.mutationContext.run(token, operation);
    } finally {
      this.activeMutationToken = undefined;
      release();
      this.mutationLeaseCount -= 1;
    }
  }

  /**
   * Fence the complete plugin onStart hook, including attach-to-running-server.
   * A failed or unclassified startup remains blocked until a new epoch is observed.
   */
  async withStartupFence<T>(appName: string, operation: () => Promise<T>): Promise<T> {
    this.registerApplication(appName);
    return this.withMutationLease(`plugin-startup:${appName}`, async () => {
      let runtimeRunning = true;
      try {
        await this.synchronizeRuntimeEpochUnlocked();
      } catch (err) {
        if (err instanceof Error && err.name === 'BOOT_RUNTIME_NOT_RUNNING') {
          runtimeRunning = false;
        } else {
          throw err;
        }
      }
      const previous = this.getOrCreateBootState(appName);
      if (runtimeRunning && previous.mutationOutcomeUnknown) {
        throw bootOwnershipError(
          'BOOT_MUTATION_OUTCOME_UNKNOWN',
          `A prior mutation of ${appName} has unknown outcome for the current runtime; ` +
          'observe an exact replacement DAS or a confirmed stopped state with zero JVMs'
        );
      }

      this.beginBootEpoch();
      const state = this.getOrCreateBootState(appName);
      state.startupActive = true;
      state.startupToken = this.requireActiveMutationToken();
      if (!state.mutationOutcomeUnknown) {
        state.phase = 'startup';
        state.readiness = 'unverified';
      }

      try {
        const result = await operation();
        const current = this.getOrCreateBootState(appName);
        current.startupActive = false;
        current.startupToken = undefined;
        if (current.phase === 'startup') {
          current.evidenceSource = 'startup-unclassified';
        }
        return result;
      } catch (err) {
        const current = this.getOrCreateBootState(appName);
        current.startupActive = false;
        current.startupToken = undefined;
        current.phase = 'blocked';
        current.readiness = 'unverified';
        current.owner = undefined;
        current.runtimeListed = undefined;
        if (!current.mutationOutcomeUnknown) {
          current.evidenceSource = 'startup-failed';
        }
        throw err;
      }
    });
  }

  /** Epoch-bound readback used by health automation and explicit attestations. */
  getBootDeploymentStatus(appName: string): BootDeploymentStatus {
    const state = this.getOrCreateBootState(appName);
    const runtimeFingerprint = this.runtimeFingerprint();
    return {
      appName: state.appName,
      bootEpoch: state.bootEpoch,
      ...(runtimeFingerprint ? { runtimeFingerprint } : {}),
      phase: state.phase,
      readiness: state.readiness,
      ...(state.owner ? { owner: state.owner } : {}),
      ...(state.runtimeListed !== undefined ? { runtimeListed: state.runtimeListed } : {}),
      mutationOutcomeUnknown: state.mutationOutcomeUnknown,
      startupActive: state.startupActive,
      startedAt: new Date(state.startedAtMs).toISOString(),
      ...(state.readyAtMs ? { readyAt: new Date(state.readyAtMs).toISOString() } : {}),
      ...(state.evidenceSource ? { evidenceSource: state.evidenceSource } : {}),
      ...(state.startupReceipt
        ? { startupReceipt: { ...state.startupReceipt } }
        : {}),
    };
  }

  /** Opaque, stable readback for binding operator authority to one exact DAS. */
  private runtimeFingerprint(): string | undefined {
    if (this.currentRuntimeIdentity === undefined) return undefined;
    return this.fingerprintRuntimeIdentity(this.currentRuntimeIdentity);
  }

  private fingerprintRuntimeIdentity(identity: string | number): string {
    return createHash('sha256')
      .update(`${typeof identity}:${String(identity)}`)
      .digest('hex');
  }

  /** Refresh the runtime-bound epoch before returning operator readback. */
  async readBootDeploymentStatus(appName: string): Promise<BootDeploymentStatus> {
    return this.withMutationLease(`read-boot-status:${appName}`, async () => {
      this.registerApplication(appName);
      let runtimeRunning = true;
      try {
        await this.synchronizeRuntimeEpochUnlocked();
      } catch (err) {
        if (!(err instanceof Error) || err.name !== 'BOOT_RUNTIME_NOT_RUNNING') {
          throw err;
        }
        runtimeRunning = false;
      }
      const state = this.getOrCreateBootState(appName);
      if (
        runtimeRunning
        && state.phase === 'payara-booting'
        && state.owner === 'payara'
        && !state.startupActive
        && !state.mutationOutcomeUnknown
      ) {
        await this.tryPromoteWithConfiguredHealth(appName, state);
      }
      return this.getBootDeploymentStatus(appName);
    });
  }

  private getOrCreateBootState(appName: string): InternalBootDeploymentState {
    validatePayaraIdentifier(appName, 'Payara application name');
    const existing = this.bootDeploymentStates.get(appName);
    if (existing) {
      return existing;
    }

    const runtimeKnown = this.currentRuntimeIdentity !== undefined;
    const state: InternalBootDeploymentState = {
      appName,
      bootEpoch: this.currentBootEpoch,
      phase: runtimeKnown ? 'startup' : 'unfenced',
      readiness: runtimeKnown ? 'unverified' : 'not_applicable',
      mutationOutcomeUnknown: false,
      startupActive: false,
      startedAtMs: this.currentBootStartedAtMs,
      ...(runtimeKnown ? { evidenceSource: 'late-registration' } : {}),
    };
    this.bootDeploymentStates.set(appName, state);
    return state;
  }

  /** Rotate before start-domain, never after it returns. */
  private beginBootEpoch(
    runtimeIdentity?: string | number,
    evidenceSource?: string,
    clearMutationOutcomeUnknown = false
  ): void {
    this.currentBootEpoch = randomUUID();
    this.currentBootStartedAtMs = Date.now();
    this.currentRuntimeIdentity = runtimeIdentity;
    // A boot epoch is the lifetime of recovery authority. Old IDs and requests
    // cannot be carried into a replacement or newly fenced DAS.
    this.consumedBootRecoveryAuthorizations.clear();
    const token = this.activeMutationToken;

    for (const state of this.bootDeploymentStates.values()) {
      const startupActive = state.startupActive;
      const preserveUnknownOutcome =
        state.mutationOutcomeUnknown && !clearMutationOutcomeUnknown;
      state.bootEpoch = this.currentBootEpoch;
      state.phase = preserveUnknownOutcome ? 'blocked' : 'startup';
      state.readiness = 'unverified';
      state.startedAtMs = this.currentBootStartedAtMs;
      state.readyAtMs = undefined;
      state.startupReceipt = undefined;
      if (!preserveUnknownOutcome) {
        state.evidenceSource = evidenceSource;
      }
      state.owner = undefined;
      state.runtimeListed = undefined;
      state.mutationOutcomeUnknown = preserveUnknownOutcome;
      state.reservationToken = undefined;
      state.startupActive = startupActive;
      state.startupToken = startupActive ? token : undefined;
    }
  }

  /**
   * Read the DAS start-time estimate reported by its documented uptime command.
   * The estimate is used as a liveness/parse gate; exact epoch identity comes
   * from the Linux boot ID and JVM procfs start ticks below.
   */
  private async readRuntimeStartedAtMs(): Promise<number | undefined> {
    const beforeMs = Date.now();
    let output: string;
    try {
      // Payara 7 renders the default duration as a localized terse string
      // (for example, "Up 14 hrs 58 mins"). Request the command's stable
      // machine-readable form instead of parsing presentation text.
      output = await this.asadminCommand(['uptime', '--milliseconds=true'], 10000);
    } catch (err) {
      if (!(await this.isRunningStrict())) {
        return undefined;
      }
      throw err;
    }
    const afterMs = Date.now();
    const uptimeLine = output
      .split(/\r?\n/u)
      .map(line => line.trim())
      .find(Boolean);
    const legacyMilliseconds = output.match(/Total milliseconds:\s*(\d+)/iu)?.[1];
    const uptimeToken = uptimeLine && /^\d+$/u.test(uptimeLine)
      ? uptimeLine
      : legacyMilliseconds;
    if (!uptimeToken) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_IDENTITY_UNPARSEABLE',
        'Unexpected output from uptime'
      );
    }
    const uptimeMs = Number(uptimeToken);
    if (!Number.isSafeInteger(uptimeMs) || uptimeMs < 0) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_IDENTITY_UNPARSEABLE',
        'Invalid total milliseconds from uptime'
      );
    }
    return Math.round((beforeMs + afterMs) / 2) - uptimeMs;
  }

  /**
   * Build an exact Linux process identity for the DAS. Uptime proves that the
   * administration endpoint belongs to a live domain; boot_id + PID + procfs
   * start ticks distinguish even a sub-second crash/restart and PID reuse.
   */
  private async readRuntimeIdentity(): Promise<string | undefined> {
    const beforeIdentity = await this.readExactDasProcessIdentity();
    const startedAtMs = await this.readRuntimeStartedAtMs();
    const afterIdentity = await this.readExactDasProcessIdentity();

    if (!Object.is(beforeIdentity, afterIdentity)) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_IDENTITY_CHANGED_DURING_PROBE',
        `Payara runtime changed while identifying ${this.domain}`
      );
    }
    if (startedAtMs === undefined && beforeIdentity === undefined) {
      return undefined;
    }
    if (startedAtMs === undefined || beforeIdentity === undefined) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_STATE_CONTRADICTORY',
        `Payara uptime and exact process identity disagree for ${this.domain}`
      );
    }
    return beforeIdentity;
  }

  /**
   * Final no-yield identity probe for destructive operator recovery.
   *
   * The regular identity probe deliberately uses asadmin uptime as an
   * additional liveness gate. Immediately before dispatch, however, another
   * awaited command would reopen the race. This synchronous Linux /proc scan
   * proves there is exactly one JVM for the canonical instanceRoot and binds it
   * to boot-id/PID/startticks in the same JavaScript turn as WAL arm + exec.
   */
  private readRuntimeIdentitySync(): string | undefined {
    let entries: Dirent[];
    try {
      entries = readdirSync('/proc', { withFileTypes: true });
    } catch (err) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_SYNC_IDENTITY_UNAVAILABLE',
        `Cannot enumerate system-wide procfs for ${this.domain}: ${getErrorText(err)}`
      );
    }

    const matchingPids: number[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number.parseInt(entry.name, 10);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;

      let commandName: string;
      try {
        commandName = readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw bootOwnershipError(
          'BOOT_RUNTIME_SYNC_IDENTITY_UNAVAILABLE',
          `Cannot read system-wide procfs command identity for PID ${pid}`
        );
      }
      if (!commandName.includes('java')) continue;

      let commandLine: string;
      try {
        commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw bootOwnershipError(
          'BOOT_RUNTIME_SYNC_IDENTITY_UNAVAILABLE',
          `Cannot read system-wide procfs argv for Java PID ${pid}`
        );
      }
      if (this.processCommandLineMatchesDomain(commandLine)) {
        matchingPids.push(pid);
      }
    }

    if (matchingPids.length === 0) return undefined;
    if (matchingPids.length !== 1) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_PROCESS_AMBIGUOUS',
        `Expected exactly one Payara DAS JVM, observed [${matchingPids.join(', ')}]`
      );
    }

    const pid = matchingPids[0]!;
    let bootId: string;
    let processStat: string;
    let processCommandLine: string;
    try {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');
      processStat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      processCommandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch (err) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_SYNC_IDENTITY_UNAVAILABLE',
        `Cannot revalidate exact procfs identity for Payara PID ${pid}: ${getErrorText(err)}`
      );
    }

    const commandEnd = processStat.lastIndexOf(')');
    const remainingFields = commandEnd >= 0
      ? processStat.slice(commandEnd + 1).trim().split(/\s+/)
      : [];
    const startTicks = remainingFields[19];
    const normalizedBootId = bootId.trim();
    if (
      !normalizedBootId
      || !startTicks
      || !/^\d+$/.test(startTicks)
      || !this.processCommandLineMatchesDomain(processCommandLine)
    ) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_SYNC_IDENTITY_UNPARSEABLE',
        `Cannot parse exact synchronous procfs identity for Payara PID ${pid}`
      );
    }
    return `${normalizedBootId}:${pid}:${startTicks}`;
  }

  /** Final exact runtime comparison with no await before the caller dispatches. */
  private assertRuntimeIdentityCurrentSync(
    requestedRuntimeFingerprint: string
  ): void {
    let observed: string | number | undefined;
    try {
      observed = this.runtimeIdentitySyncProvider();
    } catch (err) {
      if (err instanceof Error && err.name.startsWith('BOOT_RUNTIME_')) throw err;
      throw bootOwnershipError(
        'BOOT_RUNTIME_SYNC_IDENTITY_UNAVAILABLE',
        `Cannot synchronously revalidate ${this.domain}: ${getErrorText(err)}`
      );
    }
    const observedFingerprint = observed === undefined
      ? undefined
      : this.fingerprintRuntimeIdentity(observed);
    if (
      observed === undefined
      || !Object.is(observed, this.currentRuntimeIdentity)
      || observedFingerprint !== requestedRuntimeFingerprint
    ) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_IDENTITY_MISMATCH',
        `Recovery authority no longer matches the exact ${this.domain} DAS runtime`
      );
    }
  }

  /**
   * Bind recovery authority to the exact staged WAR immediately before the
   * first remote mutation. O_NOFOLLOW rejects a path-level symlink and the
   * synchronous read leaves no JavaScript scheduling gap before WAL arm and
   * asadmin dispatch.
   */
  private assertRecoveryArtifactCurrentSync(
    warPath: string,
    expectedArtifactSha256: string
  ): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        warPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      );
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.size <= 0) {
        throw new Error('staged artifact is not a non-empty regular file');
      }

      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      for (;;) {
        const bytesRead = readSync(
          descriptor,
          buffer,
          0,
          buffer.byteLength,
          position
        );
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = fstatSync(descriptor);
      const observedArtifactSha256 = hash.digest('hex');
      if (
        before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
        || position !== after.size
        || observedArtifactSha256 !== expectedArtifactSha256
      ) {
        throw new Error('staged WAR identity changed or does not match authorization');
      }
    } catch (err) {
      throw bootOwnershipError(
        'BOOT_RECOVERY_ARTIFACT_MISMATCH',
        `Recovery authority does not match the exact staged WAR: ${getErrorText(err)}`
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  /** Read one exact DAS token, anchored by strict JVM inventory and cmdline. */
  private async readExactDasProcessIdentity(): Promise<string | undefined> {
    const pids = await this.getPayaraProcessPidsStrict();
    if (pids.length === 0) {
      return undefined;
    }
    if (pids.length !== 1) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_PROCESS_AMBIGUOUS',
        `Expected exactly one Payara DAS JVM, observed [${pids.join(', ')}]`
      );
    }
    const pid = pids[0]!;

    let bootId: string;
    let processStat: string;
    let processCommandLine: string;
    try {
      [bootId, processStat, processCommandLine] = await Promise.all([
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile(`/proc/${pid}/cmdline`, 'utf8'),
      ]);
    } catch (err) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_IDENTITY_UNAVAILABLE',
        `Cannot read exact procfs identity for Payara PID ${pid}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }

    // /proc/<pid>/stat field 2 is parenthesized and may contain spaces. The
    // remaining token index 19 is field 22 (process start time in clock ticks).
    const commandEnd = processStat.lastIndexOf(')');
    const remainingFields = commandEnd >= 0
      ? processStat.slice(commandEnd + 1).trim().split(/\s+/)
      : [];
    const startTicks = remainingFields[19];
    const normalizedBootId = bootId.trim();
    if (
      !normalizedBootId
      || !startTicks
      || !/^\d+$/.test(startTicks)
      || !this.processCommandLineMatchesDomain(processCommandLine)
    ) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_IDENTITY_UNPARSEABLE',
        `Cannot parse exact procfs identity for Payara PID ${pid}`
      );
    }

    return `${normalizedBootId}:${pid}:${startTicks}`;
  }

  /**
   * Bind the in-memory epoch to the currently observed DAS. If Payara was
   * restarted by systemd/exec/a crash outside this manager, rotate every app
   * back behind the startup fence before any mutation is considered.
   */
  private async synchronizeRuntimeEpochUnlocked(): Promise<boolean> {
    let observedRuntimeIdentity: string | number | undefined;
    try {
      observedRuntimeIdentity = await this.runtimeIdentityProvider();
    } catch (err) {
      for (const state of this.bootDeploymentStates.values()) {
        state.phase = 'blocked';
        state.readiness = 'unverified';
        state.owner = undefined;
        state.runtimeListed = undefined;
        if (!state.mutationOutcomeUnknown) {
          state.evidenceSource = 'runtime-identity-unavailable';
        }
      }
      throw bootOwnershipError(
        'BOOT_RUNTIME_IDENTITY_UNKNOWN',
        `Could not identify the current ${this.domain} runtime: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    const externalTransition = this.externalRuntimeTransition;
    if (externalTransition) {
      if (observedRuntimeIdentity === undefined) {
        externalTransition.exactAbsenceObserved = true;
        for (const state of this.bootDeploymentStates.values()) {
          state.phase = 'blocked';
          state.readiness = 'unverified';
          state.owner = undefined;
          state.runtimeListed = undefined;
          if (!state.mutationOutcomeUnknown) {
            state.evidenceSource = `${externalTransition.source}:exact-absence`;
          }
        }
        throw bootOwnershipError(
          'BOOT_RUNTIME_NOT_RUNNING',
          `External lifecycle transition for ${this.domain} reached exact absence`
        );
      }

      const replacementObserved =
        externalTransition.previousRuntimeIdentity === undefined
        || !Object.is(
          observedRuntimeIdentity,
          externalTransition.previousRuntimeIdentity
        );
      const completionAuthorized = replacementObserved
        && (
          externalTransition.startedObserved
          || externalTransition.exactAbsenceObserved
        );
      if (!completionAuthorized) {
        for (const state of this.bootDeploymentStates.values()) {
          state.phase = 'blocked';
          state.readiness = 'unverified';
          state.owner = undefined;
          state.runtimeListed = undefined;
          if (!state.mutationOutcomeUnknown) {
            state.evidenceSource = `${externalTransition.source}:transition-pending`;
          }
        }
        throw bootOwnershipError(
          'BOOT_EXTERNAL_TRANSITION_PENDING',
          `External lifecycle transition for ${this.domain} still observes the prior DAS`
        );
      }

      const previousBootEpoch = this.currentBootEpoch;
      this.externalRuntimeTransition = undefined;
      this.beginBootEpoch(
        observedRuntimeIdentity,
        `${externalTransition.source}:replacement-observed`,
        true
      );
      this.reconcileDurableMutationQuarantines(observedRuntimeIdentity);
      this.logger.warn(
        {
          previousBootEpoch,
          bootEpoch: this.currentBootEpoch,
          observedRuntimeIdentity,
          source: externalTransition.source,
        },
        'External Payara lifecycle transition completed with an exact replacement DAS'
      );
      return true;
    }

    if (observedRuntimeIdentity === undefined) {
      if (this.currentRuntimeIdentity !== undefined) {
        // Retain the last exact identity through the stopped interval so an
        // externally started successor can be proven different rather than
        // merely adopted as the first observed runtime.
        this.beginBootEpoch(this.currentRuntimeIdentity, 'runtime-not-running');
      }
      throw bootOwnershipError(
        'BOOT_RUNTIME_NOT_RUNNING',
        `Cannot establish a boot epoch because ${this.domain} is not running`
      );
    }

    if (this.currentRuntimeIdentity === undefined) {
      this.currentRuntimeIdentity = observedRuntimeIdentity;
      this.reconcileDurableMutationQuarantines(observedRuntimeIdentity);
      return false;
    }

    if (Object.is(observedRuntimeIdentity, this.currentRuntimeIdentity)) {
      this.reconcileDurableMutationQuarantines(observedRuntimeIdentity);
      return false;
    }

    const previousBootEpoch = this.currentBootEpoch;
    this.beginBootEpoch(observedRuntimeIdentity, 'external-runtime-change', true);
    this.reconcileDurableMutationQuarantines(observedRuntimeIdentity);
    this.logger.warn(
      {
        previousBootEpoch,
        bootEpoch: this.currentBootEpoch,
        observedRuntimeIdentity,
      },
      'Detected a Payara runtime restart outside the plugin; boot fence rotated'
    );
    return true;
  }

  /** Restore or resolve write-ahead quarantine using only exact runtime identity. */
  private reconcileDurableMutationQuarantines(
    observedRuntimeIdentity: string | number
  ): void {
    if (!this.mutationQuarantine) return;

    for (const state of this.bootDeploymentStates.values()) {
      const record = this.mutationQuarantine.read(
        this.mutationQuarantineInstanceId,
        state.appName
      );
      if (
        record
        && this.activeMutationQuarantine?.recordId === record.recordId
      ) {
        if (!Object.is(record.runtimeIdentity, observedRuntimeIdentity)) {
          throw bootOwnershipError(
            'BOOT_EPOCH_CHANGED',
            `Runtime changed while durable mutation ${record.operation} was armed`
          );
        }
        continue;
      }

      // A replacement DAS does not prove which runtime received the command.
      // The admin port is not PID-bound, so a successor may have been mutated
      // after the last procfs CAS. Preserve every surviving WAL as UNKNOWN
      // until a later reconciliation proves domain stopped + exact PID0.
      if (record) {
        state.phase = 'blocked';
        state.readiness = 'unverified';
        state.owner = undefined;
        state.runtimeListed = undefined;
        state.mutationOutcomeUnknown = true;
        state.durableQuarantineRecordId = record.recordId;
        state.evidenceSource = Object.is(record.runtimeIdentity, observedRuntimeIdentity)
          ? record.evidenceSource
          : `${record.evidenceSource}:runtime-replaced-still-unknown`;
        continue;
      }

      if (state.durableQuarantineRecordId) {
        state.durableQuarantineRecordId = undefined;
        state.mutationOutcomeUnknown = false;
        state.phase = 'startup';
        state.readiness = 'unverified';
        state.owner = undefined;
        state.runtimeListed = undefined;
        state.evidenceSource = record
          ? 'durable-quarantine-resolved-runtime-replacement'
          : 'durable-quarantine-completed';
      }
    }
  }

  private requireActiveMutationToken(): symbol {
    const token = this.mutationContext.getStore();
    if (!token || token !== this.activeMutationToken) {
      throw new Error('MUTATION_LEASE_REQUIRED: no active Payara mutation lease');
    }
    return token;
  }

  /**
   * Validate that asadmin binary exists and is accessible.
   * Call this during plugin initialization for early failure detection.
   */
  async validateAsadmin(): Promise<void> {
    if (process.platform !== 'linux') {
      throw bootOwnershipError(
        'BOOT_RUNTIME_PLATFORM_UNSUPPORTED',
        'production lifecycle safety requires Linux procfs runtime identity'
      );
    }
    try {
      await access(this.asadmin, constants.X_OK);
    } catch {
      throw new Error(
        `asadmin not found or not executable at ${this.asadmin}. ` +
        `Check payaraHome configuration (current: ${this.payaraHome})`
      );
    }
  }

  /**
   * Update environment variables (e.g., after secret refresh)
   */
  setEnvironment(env: Record<string, string>): void {
    this.environment = env;
    this.logger.debug({ count: Object.keys(env).length }, 'Environment updated');
  }

  /**
   * Update environment and write to setenv.conf
   * Use this when secrets have been refreshed and need to be persisted
   * even if Payara isn't being restarted
   */
  async updateEnvironment(env: Record<string, string>, deadlineMs?: number): Promise<void> {
    return this.withMutationLease('update-environment', async () => {
      this.environment = { ...env };
      this.logger.debug({ count: Object.keys(env).length }, 'Environment updated');
      await this.writeSetenvConfInternal(deadlineMs);
    });
  }


  /**
   * Check if we need to use sudo to run commands as the target user.
   * Returns true if a user is specified and we're not already that user.
   */
  private needsSudo(): boolean {
    if (!this.user) return false;

    // USER/LOGNAME are caller-controlled environment variables and cannot
    // prove the effective account. If the OS identity cannot be read, retain
    // the privilege drop instead of risking execution as the agent/root user.
    try {
      return userInfo().username !== this.user;
    } catch {
      return true;
    }
  }

  /**
   * Execute one binary with an argv vector, optionally as a different user.
   * Config values are never reparsed as command text.
   */
  private async execCommand(
    command: string,
    args: readonly string[],
    timeout?: number,
    acceptedExitCodes: readonly number[] = [0]
  ): Promise<{ stdout: string; stderr: string }> {
    const effectiveTimeout = timeout ?? this.operationTimeout;
    const processEnvironment = buildPayaraProcessEnv();
    const javaHome = processEnvironment.JAVA_HOME;
    if (!javaHome) {
      throw new Error('JAVA_HOME is unavailable for Payara command execution');
    }
    const executable = this.needsSudo() ? '/usr/bin/sudo' : command;
    const commandArgs = this.needsSudo()
      ? [
          '-u',
          this.user,
          '/usr/bin/env',
          `JAVA_HOME=${javaHome}`,
          command,
          ...args,
        ]
      : [...args];

    this.logger.debug({
      executable: command,
      argumentCount: args.length,
      hasEnv: Object.keys(this.environment).length > 0,
    }, 'Executing command');

    try {
      return await executeProcessCommand(
        executable,
        commandArgs,
        effectiveTimeout,
        processEnvironment,
        acceptedExitCodes
      );
    } catch (err) {
      const error = err as ProcessCommandError;
      // SECURITY: Don't log argv or stdout/stderr. Password-file paths and
      // process output may carry operationally sensitive data.
      this.logger.error({
        executable: command,
        code: error.code,
      }, 'Command failed');
      throw err;
    }
  }

  /**
   * Run asadmin command with optional authentication for Payara 7+
   *
   * For start-domain commands, a fixed shell helper sources setenv.conf and
   * receives every pathname/asadmin argument positionally. No config value is
   * interpolated into shell program text.
   */
  private async asadminCommand(args: string[], timeout?: number): Promise<string> {
    // Build auth arguments if password file is configured
    const authArgs = this.passwordFile
      ? ['--user', 'admin', '--passwordfile', this.passwordFile]
      : [];

    const asadminArgs = [...authArgs, ...args];

    // For start-domain, source setenv.conf first so env vars are inherited by domain JVM
    // Payara doesn't automatically source domain-specific setenv files, so we do it here
    const isStartCommand = args[0] === 'start-domain';
    if (isStartCommand && Object.keys(this.environment).length > 0) {
      const setenvPath = getSetenvPath(this.payaraHome, this.domain);
      validatePathArgument(setenvPath, 'setenv path');
      const result = await this.execCommand(
        '/bin/bash',
        [
          '-c',
          EXEC_WITH_SETENV_SCRIPT,
          'znvault-payara-asadmin',
          setenvPath,
          this.asadmin,
          ...asadminArgs,
        ],
        timeout
      );
      return result.stdout;
    }

    const result = await this.execCommand(this.asadmin, asadminArgs, timeout);
    return result.stdout;
  }

  /**
   * Check if Payara domain is running
   */
  async isRunning(timeoutMs = 10000): Promise<boolean> {
    try {
      return await this.isRunningStrict(timeoutMs);
    } catch {
      return false;
    }
  }

  /** Domain-state probe for safety decisions; command errors are never absence. */
  async isRunningStrict(timeoutMs = 10000): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Payara running-state timeout must be a positive finite number');
    }
    const output = await this.asadminCommand(['list-domains'], Math.min(10000, timeoutMs));
    const lines = output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !/^Command .* executed successfully\.?$/i.test(line));
    const simpleLine = lines.find(line =>
      line === `${this.domain} running` || line === `${this.domain} not running`
    );
    if (simpleLine) {
      return simpleLine === `${this.domain} running`;
    }

    const officialLine = lines.find(line => {
      const match = line.match(/^Name:\s*(\S+)\s+Status:\s*(Running|Not Running)$/i);
      return match?.[1] === this.domain;
    });
    if (officialLine) {
      return /Status:\s*Running$/i.test(officialLine);
    }

    throw bootOwnershipError(
      'PAYARA_RUNNING_PROBE_UNKNOWN',
      `list-domains did not report an exact state for ${this.domain}`
    );
  }

  /**
   * Check if Payara is healthy via health endpoint
   */
  async isHealthy(timeoutMs?: number): Promise<boolean> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error('Payara health-check timeout must be a positive finite number');
    }

    if (!this.healthEndpoint) {
      // No health endpoint configured, just check if running
      return timeoutMs === undefined ? this.isRunning() : this.isRunning(timeoutMs);
    }

    return this.checkConfiguredApplicationHealth(timeoutMs);
  }

  /** A 2xx from the configured application endpoint is positive boot-readiness evidence. */
  private async checkConfiguredApplicationHealth(timeoutMs?: number): Promise<boolean> {
    if (!this.healthEndpoint) {
      return false;
    }

    const effectiveTimeoutMs = Math.max(
      1,
      Math.floor(Math.min(this.healthCheckTimeout, timeoutMs ?? this.healthCheckTimeout))
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);

    try {
      const response = await fetch(this.healthEndpoint, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        this.logger.warn({ status: response.status }, 'Health check returned non-OK status');
        return false;
      }

      return true;
    } catch (err) {
      this.logger.debug({ err, endpoint: this.healthEndpoint }, 'Health check failed');
      return false;
    } finally {
      // Always clear timeout to prevent memory leak
      clearTimeout(timeout);
    }
  }

  /**
   * Write environment variables to domain's setenv.conf
   * This ensures the Payara JVM receives the env vars on startup
   */
  private async writeSetenvConfInternal(deadlineMs?: number): Promise<void> {
    await writeSetenvConf(this.environment, {
      payaraHome: this.payaraHome,
      domain: this.domain,
      user: this.user,
      logger: this.logger,
      deadlineMs,
    });
  }

  /**
   * Start Payara domain
   */
  async start(
    options: {
      waitForApplicationHealth?: boolean;
      timeoutMs?: number;
      deadlineMs?: number;
    } = {}
  ): Promise<void> {
    return this.withMutationLease('start-domain', () => this.startUnlocked(options));
  }

  private async startUnlocked(
    options: {
      waitForApplicationHealth?: boolean;
      timeoutMs?: number;
      deadlineMs?: number;
    } = {}
  ): Promise<void> {
    const waitForApplicationHealth = options.waitForApplicationHealth ?? true;
    const lifecycleTimeoutMs = options.timeoutMs ?? this.operationTimeout;
    if (!Number.isFinite(lifecycleTimeoutMs) || lifecycleTimeoutMs <= 0) {
      throw new Error('Lifecycle timeout must be a positive finite number');
    }

    const localDeadlineMs = this.monotonicNowMs() + lifecycleTimeoutMs;
    const deadlineMs = options.deadlineMs === undefined
      ? localDeadlineMs
      : Math.min(localDeadlineMs, options.deadlineMs);

    if (await this.isRunningStrict(
      this.remainingLifecycleBudget(deadlineMs, 'initial running-state probe')
    )) {
      if (this.bootDeploymentStates.size > 0) {
        await this.synchronizeRuntimeEpochUnlocked();
      }
      this.logger.info({ domain: this.domain }, 'Domain already running');
      return;
    }

    await this.assertStoppedStartAllowed('start-domain', deadlineMs);

    // Write environment to setenv.conf before starting
    await this.writeSetenvConfInternal(deadlineMs);

    // setenv.conf replacement may involve sudo/fsync and therefore yields long
    // enough for systemd or another controller to start a DAS. Re-prove exact
    // stopped+PID0 immediately before dispatching our own start-domain.
    await this.assertStoppedStartAllowed('start-domain final pre-dispatch', deadlineMs);

    this.logger.info({ domain: this.domain }, 'Starting Payara domain');

    // Deadline expiry before this point is known-not-dispatched. Compute the
    // command budget before rotating the epoch or entering the ambiguity catch.
    const startCommandTimeoutMs = this.remainingLifecycleBudget(
      deadlineMs,
      'start-domain command'
    );
    this.beginBootEpoch(undefined, 'confirmed-stopped-start', true);
    try {
      await this.asadminCommand(
        ['start-domain', this.domain],
        startCommandTimeoutMs
      );
    } catch (err) {
      this.logger.error({ err, domain: this.domain }, 'start-domain dispatch outcome is unknown');
      throw lifecycleOutcomeUnknown('start-domain', err);
    }

    let runtimeWaitError: unknown;
    try {
      await this.waitForRunning(
        this.remainingLifecycleBudget(deadlineMs, 'start-domain runtime verification')
      );
    } catch (err) {
      runtimeWaitError = err;
    }
    try {
      // An exact identity can recover a polling-edge timeout after the asadmin
      // command itself completed, but an identity error is never retried and
      // adopted inside the same decision.
      await this.synchronizeRuntimeEpochUnlocked();
    } catch (identityError) {
      this.logger.error(
        { err: runtimeWaitError, identityError, domain: this.domain },
        'Started DAS did not reach a verified exact runtime identity'
      );
      throw lifecycleOutcomeUnknown('start-domain', identityError);
    }

    // Application health is not a lifecycle terminal-state proof. A 503 after
    // an exact running DAS is an ordinary readiness failure and must not retain
    // the lifecycle quarantine lock that a deployment needs to remediate it.
    if (waitForApplicationHealth) {
      await this.waitForHealthy(
        this.remainingLifecycleBudget(deadlineMs, 'start-domain health verification')
      );
    }

    if (waitForApplicationHealth) {
      await this.classifyRegisteredBootOwnership();
    }

    // Invalidate status cache after state change
    this.invalidateStatusCache();

    this.logger.info({ domain: this.domain }, 'Payara domain started');
  }

  /**
   * Stop Payara domain
   */
  async stop(): Promise<void> {
    return this.withMutationLease('stop-domain', () => this.stopUnlocked());
  }

  private async stopUnlocked(): Promise<void> {
    // A status-probe error is UNKNOWN, not evidence that the domain stopped.
    // This path returns an operator-visible success, so it must be strict.
    if (!(await this.isRunningStrict())) {
      const remainingPids = await this.getPayaraProcessPidsStrict();
      if (remainingPids.length === 0) {
        this.logger.info({ domain: this.domain }, 'Domain not running');
        return;
      }
      throw bootOwnershipError(
        'BOOT_STOP_INCOMPLETE',
        `Admin listener is down but Payara JVMs remain: ${remainingPids.join(', ')}`
      );
    }

    await this.assertLifecycleMutationAllowed('stop-domain');

    this.logger.info({ domain: this.domain }, 'Stopping Payara domain');

    try {
      await this.asadminCommand(['stop-domain', this.domain]);
    } catch (err) {
      // A rejected client can still complete remotely, so even a momentary
      // stopped observation cannot authorize a successor DAS under this lock.
      this.logger.error({ err, domain: this.domain }, 'stop-domain dispatch outcome is unknown');
      throw lifecycleOutcomeUnknown('stop-domain', err);
    }

    try {
      await this.waitForStopped(30000);
    } catch (err) {
      let stoppedExactly = false;
      try {
        stoppedExactly = !(await this.isRunningStrict())
          && (await this.getPayaraProcessPidsStrict()).length === 0;
      } catch (probeError) {
        this.logger.error({ err, probeError }, 'Final stop verification failed');
      }
      if (!stoppedExactly) {
        throw lifecycleOutcomeUnknown('stop-domain', err);
      }
      this.logger.warn({ err }, 'Stop polling timed out at the edge; strict final state is stopped');
    }

    // Invalidate status cache after state change
    this.invalidateStatusCache();

    this.logger.info({ domain: this.domain }, 'Payara domain stopped');
  }

  /**
   * Restart Payara domain
   */
  async restart(): Promise<void> {
    return this.withMutationLease('restart-domain', async () => {
      this.logger.info({ domain: this.domain }, 'Restarting Payara domain');
      if (await this.isRunning()) {
        await this.assertLifecycleMutationAllowed('restart-domain');
        await this.stopUnlocked();
      } else {
        await this.assertStoppedStartAllowed('restart-domain');
      }
      await this.startUnlocked();
      this.logger.info({ domain: this.domain }, 'Payara domain restarted');
    });
  }

  private buildDeployArgs(
    warPath: string,
    appName: string,
    contextRoot?: string,
    force = true
  ): string[] {
    validatePathArgument(warPath, 'WAR path');
    validatePayaraIdentifier(appName, 'Payara application name');
    if (contextRoot) {
      if (!contextRoot.startsWith('/')) {
        throw new Error(`contextRoot must start with '/': ${contextRoot}`);
      }
      if (/\s/u.test(contextRoot) || hasAuditControlCharacters(contextRoot)) {
        throw new Error(`contextRoot cannot contain whitespace or control characters: ${contextRoot}`);
      }
    }

    const args = ['deploy'];
    if (force) {
      args.push('--force=true');
    }
    args.push(`--name=${appName}`);
    if (contextRoot) {
      args.push(`--contextroot=${contextRoot}`);
    }
    args.push(warPath);
    return args;
  }

  /**
   * Deploy a WAR file to Payara.
   *
   * Handles "virtual server already has web module" errors by undeploying first.
   */
  async deploy(warPath: string, appName: string, contextRoot?: string): Promise<void> {
    return this.withMutationLease(`deploy:${appName}`, () =>
      this.deployUnlocked(warPath, appName, contextRoot)
    );
  }

  private async deployUnlocked(
    warPath: string,
    appName: string,
    contextRoot?: string
  ): Promise<void> {
    this.logger.info({ warPath, appName, contextRoot }, 'Deploying application');
    const args = this.buildDeployArgs(warPath, appName, contextRoot, false);

    // A replace is destructive. If this manager just started the domain, prove
    // first that Payara is not restoring this target from its persistent ref.
    await this.assertTargetMutationAllowed(appName);
    const expectedBootEpoch = this.getOrCreateBootState(appName).bootEpoch;
    const targetPresent = await this.inspectApplicationPresenceStrict(
      appName,
      expectedBootEpoch,
      'replace deploy inventory'
    );
    await this.assertTargetMutationAllowed(appName);
    await this.assertBootEpochCurrent(appName, expectedBootEpoch, 'replace deploy WAL preflight');

    await this.withDurableApplicationMutation(
      appName,
      expectedBootEpoch,
      'deploy-replace',
      'agent-deploy-outcome-unknown',
      async () => {
        // Every fallible inventory/fence precheck is complete before the WAL is
        // armed. The callback's first awaited remote operation is destructive.
        if (targetPresent) {
          await this.asadminCommand(['undeploy', appName]);
          await this.assertApplicationAbsent(appName, 'UNDEPLOY_NOT_CONFIRMED');
          await this.assertBootEpochCurrent(appName, expectedBootEpoch, 'deploy after undeploy');
          await this.assertTargetMutationAllowed(appName);
          await this.assertBootEpochCurrent(appName, expectedBootEpoch, 'deploy command');
        }

        try {
          // Use longer deploy timeout (default 10 minutes) as deployment can take a while
          await this.asadminCommand(args, this.deployTimeout);
          await this.assertBootEpochCurrent(appName, expectedBootEpoch, 'deploy completion');
          this.logger.info({ appName }, 'Application deployed');
        } catch (err) {
          const error = err as Error & { stderr?: string };
          // Check for "already has web module" error
          if (error.stderr?.includes('already has a web module') ||
              error.message?.includes('already has a web module')) {
            // Last resort: aggressive undeploy with cascade, still under the same epoch CAS.
            this.logger.warn({ appName }, 'Deploy conflict detected, trying aggressive undeploy');
            await this.assertBootEpochCurrent(
              appName,
              expectedBootEpoch,
              'deploy conflict cleanup'
            );
            await this.assertTargetMutationAllowed(appName);
            await this.assertBootEpochCurrent(
              appName,
              expectedBootEpoch,
              'deploy conflict undeploy command'
            );
            await this.asadminCommand(['undeploy', '--cascade=true', appName], 30000);
            await this.assertApplicationAbsent(appName, 'UNDEPLOY_NOT_CONFIRMED');
            await this.assertBootEpochCurrent(
              appName,
              expectedBootEpoch,
              'deploy conflict absence confirmation'
            );
            await this.assertTargetMutationAllowed(appName);
            await this.assertBootEpochCurrent(
              appName,
              expectedBootEpoch,
              'deploy conflict retry command'
            );
            await this.asadminCommand(args, this.deployTimeout);
            await this.assertBootEpochCurrent(
              appName,
              expectedBootEpoch,
              'deploy conflict retry completion'
            );
            this.logger.info({ appName }, 'Application deployed after aggressive cleanup');
          } else {
            throw err;
          }
        }

        this.markApplicationReady(
          appName,
          'not_applicable',
          'agent-deploy',
          'agent',
          true,
          expectedBootEpoch
        );
      }
    );
  }

  /**
   * Deploy only when both runtime state and persistent boot ownership are absent.
   * Unlike deploy(), this method never undeploys an application that appeared
   * between the ownership fence and the actual command.
   */
  async deployFresh(warPath: string, appName: string, contextRoot?: string): Promise<void> {
    return this.withMutationLease(`deploy-fresh:${appName}`, () =>
      this.deployFreshUnlocked(warPath, appName, contextRoot)
    );
  }

  private async deployFreshUnlocked(
    warPath: string,
    appName: string,
    contextRoot?: string
  ): Promise<void> {
    this.logger.info({ warPath, appName, contextRoot }, 'Deploying fresh application');
    // Fresh ownership must never replace a target that appears after inventory.
    const args = this.buildDeployArgs(warPath, appName, contextRoot, false);

    await this.assertTargetMutationAllowed(appName);
    const expectedBootEpoch = this.getOrCreateBootState(appName).bootEpoch;
    const refs = await this.listApplicationRefs();
    const apps = await this.listApplications();
    await this.assertBootEpochCurrent(appName, expectedBootEpoch, 'fresh deploy inventory');
    if (refs.includes(appName) || apps.includes(appName)) {
      throw bootOwnershipError(
        'FRESH_DEPLOY_RACE',
        `Application ${appName} appeared after the ownership fence; refusing to mutate it`
      );
    }

    await this.assertTargetMutationAllowed(appName);
    await this.assertBootEpochCurrent(appName, expectedBootEpoch, 'fresh deploy WAL preflight');
    await this.withDurableApplicationMutation(
      appName,
      expectedBootEpoch,
      'deploy-fresh',
      'agent-fresh-deploy-outcome-unknown',
      async () => {
        await this.asadminCommand(args, this.deployTimeout);
        await this.assertBootEpochCurrent(appName, expectedBootEpoch, 'fresh deploy completion');
        this.markApplicationReady(
          appName,
          'not_applicable',
          'agent-fresh-deploy',
          'agent',
          true,
          expectedBootEpoch
        );
      }
    );
    this.logger.info({ appName }, 'Fresh application deployed');
  }

  /**
   * Undeploy an application from Payara
   */
  async undeploy(appName: string): Promise<void> {
    return this.withMutationLease(`undeploy:${appName}`, () => this.undeployUnlocked(appName));
  }

  private async undeployUnlocked(appName: string): Promise<void> {
    this.logger.info({ appName }, 'Undeploying application');
    await this.assertTargetMutationAllowed(appName);
    const expectedBootEpoch = this.getOrCreateBootState(appName).bootEpoch;
    await this.assertBootEpochCurrent(appName, expectedBootEpoch, 'undeploy WAL preflight');
    await this.withDurableApplicationMutation(
      appName,
      expectedBootEpoch,
      'undeploy',
      'agent-undeploy-outcome-unknown',
      async () => {
        await this.asadminCommand(['undeploy', appName]);
        await this.assertApplicationAbsent(appName, 'UNDEPLOY_NOT_CONFIRMED');
        await this.assertBootEpochCurrent(appName, expectedBootEpoch, 'undeploy completion');
        this.markApplicationReady(
          appName,
          'not_applicable',
          'agent-undeploy',
          'agent',
          false,
          expectedBootEpoch
        );
      }
    );
    this.logger.info({ appName }, 'Application undeployed');
  }

  private async inspectApplicationPresenceStrict(
    appName: string,
    expectedBootEpoch: string,
    operation: string
  ): Promise<boolean> {
    const refs = await this.listApplicationRefs();
    const apps = await this.listApplications();
    await this.assertBootEpochCurrent(appName, expectedBootEpoch, operation);
    const referenced = refs.includes(appName);
    const deployed = apps.includes(appName);

    if (referenced !== deployed) {
      this.markApplicationBlocked(appName, expectedBootEpoch, 'contradictory-inventory');
      throw bootOwnershipError(
        'BOOT_STATE_CONTRADICTORY',
        `Application ${appName} has inconsistent runtime and boot-reference state`
      );
    }
    return deployed;
  }

  /** Remove a stable application and prove that its runtime and boot refs are gone. */
  async undeployIfPresentStrict(appName: string): Promise<boolean> {
    return this.withMutationLease(`undeploy-strict:${appName}`, () =>
      this.undeployIfPresentStrictUnlocked(appName)
    );
  }

  /**
   * Remove the persistent ref before an aggressive restart, or prove that no
   * runtime exists and therefore no remote undeploy is possible or required.
   */
  async prepareAggressiveRestart(appName: string): Promise<boolean> {
    return this.withMutationLease(`prepare-aggressive-restart:${appName}`, async () => {
      this.registerApplication(appName);
      await this.reconcileDurableMutationQuarantine(appName);
      if (await this.isRunningStrict()) {
        return this.undeployIfPresentStrictUnlocked(appName);
      }

      const pids = await this.getPayaraProcessPidsStrict();
      if (pids.length > 0) {
        throw bootOwnershipError(
          'BOOT_STOPPED_RECOVERY_UNSAFE',
          `Cannot prepare aggressive restart while Payara JVMs remain: ${pids.join(', ')}`
        );
      }
      const state = this.getOrCreateBootState(appName);
      this.markApplicationReady(
        appName,
        'not_applicable',
        'aggressive-restart-confirmed-stopped',
        'agent',
        false,
        state.bootEpoch
      );
      return false;
    });
  }

  private async undeployIfPresentStrictUnlocked(appName: string): Promise<boolean> {
    await this.assertTargetMutationAllowed(appName);
    const expectedBootEpoch = this.getOrCreateBootState(appName).bootEpoch;

    const deployed = await this.inspectApplicationPresenceStrict(
      appName,
      expectedBootEpoch,
      'strict undeploy inventory'
    );
    if (!deployed) {
      this.markApplicationReady(
        appName,
        'not_applicable',
        'target-absent',
        'agent',
        false,
        expectedBootEpoch
      );
      return false;
    }

    await this.undeployUnlocked(appName);
    await this.assertBootEpochCurrent(appName, expectedBootEpoch, 'strict undeploy completion');
    this.markApplicationReady(
      appName,
      'not_applicable',
      'undeploy-confirmed',
      'agent',
      false,
      expectedBootEpoch
    );
    return true;
  }

  /**
   * List deployed applications
   */
  async listApplications(timeoutMs = 10000): Promise<string[]> {
    const output = await this.asadminCommand(
      ['--terse=true', 'list-applications'],
      Math.min(10000, timeoutMs)
    );
    return parseTerseApplicationNames(output, 'list-applications');
  }

  /** List persistent application references for the standalone server target. */
  async listApplicationRefs(timeoutMs = 10000): Promise<string[]> {
    const output = await this.asadminCommand(
      ['--terse=true', 'list-application-refs', 'server'],
      Math.min(10000, timeoutMs)
    );
    return parseTerseApplicationNames(output, 'list-application-refs');
  }

  /** Fence an on-disk WAR replacement against Payara-owned boot restoration. */
  async assertArtifactMutationAllowed(appName: string): Promise<string> {
    return this.withMutationLease(`artifact-mutation-fence:${appName}`, () =>
      this.assertArtifactMutationAllowedUnlocked(appName)
    );
  }

  /**
   * Authorize one create-only recovery artifact commit for an operator-supplied
   * boot epoch. This is intentionally narrower than ordinary WAR mutation:
   * Payara must still own a persistent ref, the runtime app must be absent, and
   * no ambiguous mutation may exist. Callers run it once before writing the
   * temporary file and again as the final CAS immediately before commit.
   */
  async assertMissingRecoveryArtifactStageAllowed(
    appName: string,
    expectedBootEpoch: string
  ): Promise<void> {
    return this.withMutationLease(`recovery-artifact-stage-cas:${appName}`, async () => {
      this.registerApplication(appName);
      await this.synchronizeRuntimeEpochUnlocked();
      let state = this.getOrCreateBootState(appName);
      this.assertMissingRecoveryArtifactStageState(
        appName,
        state,
        expectedBootEpoch
      );

      const refs = await this.listApplicationRefs();
      const apps = await this.listApplications();
      state = await this.assertBootEpochCurrent(
        appName,
        expectedBootEpoch,
        'missing recovery artifact staging'
      );
      this.assertMissingRecoveryArtifactStageState(
        appName,
        state,
        expectedBootEpoch
      );
      if (!refs.includes(appName) || apps.includes(appName)) {
        throw bootOwnershipError(
          'BOOT_RECOVERY_STATE_INVALID',
          `Recovery artifact staging requires ref=true and app=false for ${appName}`
        );
      }
    });
  }

  private assertMissingRecoveryArtifactStageState(
    appName: string,
    state: InternalBootDeploymentState,
    expectedBootEpoch: string
  ): void {
    if (!expectedBootEpoch || state.bootEpoch !== expectedBootEpoch) {
      throw bootOwnershipError(
        'BOOT_EPOCH_MISMATCH',
        `Recovery artifact staging epoch does not match current epoch ${state.bootEpoch}`
      );
    }
    if (state.startupActive) {
      throw bootOwnershipError(
        'BOOT_STARTUP_ACTIVE',
        `Startup is still active for ${appName} in epoch ${state.bootEpoch}`
      );
    }
    const durableRecord = this.mutationQuarantine?.read(
      this.mutationQuarantineInstanceId,
      appName
    );
    if (
      state.mutationOutcomeUnknown
      || state.durableQuarantineRecordId
      || durableRecord
    ) {
      throw bootOwnershipError(
        'BOOT_MUTATION_OUTCOME_UNKNOWN',
        `Recovery artifact staging cannot cross an ambiguous mutation of ${appName}`
      );
    }
    if (this.activeMutationQuarantine) {
      throw bootOwnershipError(
        'BOOT_QUARANTINE_ACTIVE',
        `A durable mutation is armed while staging the recovery artifact for ${appName}`
      );
    }
    if (state.phase !== 'payara-booting' || state.owner !== 'payara') {
      throw bootOwnershipError(
        'BOOT_RECOVERY_OWNER_INVALID',
        'Recovery artifact staging requires exact phase=payara-booting and owner=payara'
      );
    }
  }

  private async assertArtifactMutationAllowedUnlocked(appName: string): Promise<string> {
    this.registerApplication(appName);
    if (!(await this.isRunningStrict())) {
      const pids = await this.getPayaraProcessPidsStrict();
      if (pids.length > 0) {
        throw bootOwnershipError(
          'BOOT_ARTIFACT_MUTATION_UNSAFE',
          `Cannot replace the WAR while orphan Payara JVMs remain: ${pids.join(', ')}`
        );
      }
      return `stopped:${this.getOrCreateBootState(appName).bootEpoch}`;
    }
    await this.assertTargetMutationAllowed(appName);
    return this.getOrCreateBootState(appName).bootEpoch;
  }

  /** Final exact-runtime CAS immediately before the atomic WAR rename. */
  async assertArtifactMutationEpochCurrent(
    appName: string,
    expectedBootEpoch: string
  ): Promise<void> {
    return this.withMutationLease(`artifact-commit-cas:${appName}`, async () => {
      if (expectedBootEpoch.startsWith('stopped:')) {
        const expectedStateEpoch = expectedBootEpoch.slice('stopped:'.length);
        const state = this.getOrCreateBootState(appName);
        if (state.bootEpoch !== expectedStateEpoch || await this.isRunningStrict()) {
          throw bootOwnershipError(
            'BOOT_EPOCH_CHANGED',
            `Stopped-runtime WAR artifact fence changed for ${appName}`
          );
        }
        const pids = await this.getPayaraProcessPidsStrict();
        if (pids.length > 0) {
          throw bootOwnershipError(
            'BOOT_ARTIFACT_MUTATION_UNSAFE',
            `Cannot commit WAR while Payara JVMs exist: ${pids.join(', ')}`
          );
        }
        return;
      }
      await this.assertBootEpochCurrent(appName, expectedBootEpoch, 'WAR artifact commit');
      await this.assertTargetMutationAllowed(appName);
      const state = this.getOrCreateBootState(appName);
      if (state.bootEpoch !== expectedBootEpoch || state.mutationOutcomeUnknown) {
        throw bootOwnershipError(
          'BOOT_EPOCH_CHANGED',
          `WAR artifact commit fence changed for ${appName}`
        );
      }
    });
  }

  /**
   * Reconcile a stale durable record while the caller owns the cross-process
   * deployment lock. Status reads deliberately never remove pathname state.
   */
  async reconcileDurableMutationQuarantine(appName: string): Promise<void> {
    const quarantine = this.mutationQuarantine;
    if (!quarantine) return;
    return this.withMutationLease(`quarantine-reconcile:${appName}`, async () => {
      this.registerApplication(appName);
      let confirmedStopped = false;
      try {
        await this.synchronizeRuntimeEpochUnlocked();
      } catch (err) {
        if (!(err instanceof Error) || err.name !== 'BOOT_RUNTIME_NOT_RUNNING') {
          throw err;
        }
        if (await this.isRunningStrict()) throw err;
        const pids = await this.getPayaraProcessPidsStrict();
        if (pids.length > 0) throw err;
        confirmedStopped = true;
      }

      const record = quarantine.read(
        this.mutationQuarantineInstanceId,
        appName
      );
      if (!record) {
        this.reconcileDurableMutationQuarantines(
          this.currentRuntimeIdentity ?? 'confirmed-stopped'
        );
        return;
      }
      if (!confirmedStopped) {
        return;
      }

      quarantine.clear(
        this.mutationQuarantineInstanceId,
        appName,
        record.recordId
      );
      const state = this.getOrCreateBootState(appName);
      if (state.durableQuarantineRecordId === record.recordId) {
        state.durableQuarantineRecordId = undefined;
        state.mutationOutcomeUnknown = false;
        state.phase = 'unfenced';
        state.readiness = 'not_applicable';
        state.evidenceSource = 'durable-quarantine-resolved-confirmed-stopped';
      }
    });
  }

  /**
   * Determine which controller owns the target immediately after start-domain.
   *
   * A persistent application ref is authoritative evidence that Payara may be
   * restoring the target, even before list-applications exposes it. The agent
   * may claim ownership only after a continuous window of successful reads in
   * which both the ref and runtime target remain absent.
   */
  async classifyBootOwnership(
    appName: string,
    options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      absenceGraceMs?: number;
    } = {}
  ): Promise<BootDeploymentOwnership> {
    return this.withMutationLease(`classify-boot-owner:${appName}`, () =>
      this.classifyBootOwnershipUnlocked(appName, options)
    );
  }

  /**
   * Observe a running boot when no local WAR artifact exists. A persistent ref
   * is still Payara-owned and may become health-verified; an empty target stays
   * unfenced so any later artifact mutation must perform the full continuous
   * absence proof instead of inheriting a one-shot empty observation.
   */
  async observeBootOwnership(
    appName: string,
    deadlineMs?: number
  ): Promise<BootDeploymentStatus> {
    return this.withMutationLease(`observe-boot-owner:${appName}`, async () => {
      this.registerApplication(appName);
      this.requireLifecycleBudget(deadlineMs, 25000, 'startup runtime identity observation');
      await this.synchronizeRuntimeEpochUnlocked();
      const state = this.getOrCreateBootState(appName);
      if (state.mutationOutcomeUnknown) {
        throw bootOwnershipError(
          'BOOT_MUTATION_OUTCOME_UNKNOWN',
          `A prior mutation of ${appName} has unknown outcome in boot epoch ${state.bootEpoch}`
        );
      }
      const expectedBootEpoch = state.bootEpoch;
      const inventoryTimeoutMs = deadlineMs === undefined
        ? 10000
        : this.remainingLifecycleBudget(deadlineMs, 'startup application inventory');
      const [refs, apps] = await Promise.all([
        this.listApplicationRefs(inventoryTimeoutMs),
        this.listApplications(inventoryTimeoutMs),
      ]);
      if (state.bootEpoch !== expectedBootEpoch) {
        throw bootOwnershipError(
          'BOOT_EPOCH_CHANGED',
          `Boot epoch changed during read-only ownership observation for ${appName}`
        );
      }
      const referenced = refs.includes(appName);
      const runtimeListed = apps.includes(appName);

      if (referenced) {
        const runtimeFingerprint = this.runtimeFingerprint();
        if (!runtimeFingerprint) {
          throw bootOwnershipError(
            'BOOT_RUNTIME_IDENTITY_UNKNOWN',
            `Cannot record startup ownership without the exact ${this.domain} DAS identity`
          );
        }
        state.phase = 'payara-booting';
        state.readiness = 'unverified';
        state.owner = 'payara';
        state.runtimeListed = runtimeListed;
        state.reservationToken = undefined;
        state.evidenceSource = 'startup-persistent-reference-observed';
        state.startupReceipt = {
          outcome: 'boot-owned-skip',
          deploymentAttempted: false,
          bootEpoch: expectedBootEpoch,
          runtimeFingerprint,
          runtimeListed,
          observedAt: new Date().toISOString(),
        };
        return this.getBootDeploymentStatus(appName);
      }

      if (runtimeListed) {
        state.phase = 'blocked';
        state.readiness = 'unverified';
        state.owner = undefined;
        state.runtimeListed = true;
        state.evidenceSource = 'contradictory-inventory';
        throw bootOwnershipError(
          'BOOT_STATE_CONTRADICTORY',
          `Application ${appName} is runtime-listed without a persistent server reference`
        );
      }

      state.phase = 'unfenced';
      state.readiness = 'not_applicable';
      state.owner = undefined;
      state.runtimeListed = false;
      state.evidenceSource = 'no-local-war-empty-observation';
      return this.getBootDeploymentStatus(appName);
    });
  }

  /** @deprecated Use observeBootOwnership(); retained for source compatibility. */
  async reconcileBootOwnershipWithoutArtifact(
    appName: string
  ): Promise<BootDeploymentStatus> {
    return this.observeBootOwnership(appName);
  }

  private async classifyBootOwnershipUnlocked(
    appName: string,
    options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      absenceGraceMs?: number;
    } = {}
  ): Promise<BootDeploymentOwnership> {
    this.registerApplication(appName);
    await this.synchronizeRuntimeEpochUnlocked();
    const state = this.getOrCreateBootState(appName);
    if (state.mutationOutcomeUnknown) {
      throw bootOwnershipError(
        'BOOT_MUTATION_OUTCOME_UNKNOWN',
        `A prior mutation of ${appName} has unknown outcome in boot epoch ${state.bootEpoch}; ` +
        'restart the runtime before another mutation'
      );
    }
    if (state.phase === 'ready' && state.owner) {
      if (state.owner === 'payara') {
        return {
          owner: 'payara',
          bootEpoch: state.bootEpoch,
          runtimeListed: state.runtimeListed ?? false,
          readiness: state.readiness === 'not_applicable'
            ? 'unverified'
            : state.readiness,
        };
      }
      return {
        owner: 'agent',
        bootEpoch: state.bootEpoch,
        runtimeListed: state.runtimeListed ?? false,
        readiness: 'not_applicable',
      };
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_BOOT_OWNERSHIP_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_BOOT_OWNERSHIP_POLL_INTERVAL_MS;
    const minimumAbsenceGraceMs = this.minimumBootOwnershipAbsenceGraceMs();
    const absenceGraceMs = options.absenceGraceMs ?? DEFAULT_BOOT_OWNERSHIP_ABSENCE_GRACE_MS;
    if (
      !Number.isFinite(timeoutMs)
      || timeoutMs <= 0
      || !Number.isFinite(pollIntervalMs)
      || pollIntervalMs <= 0
      || !Number.isFinite(absenceGraceMs)
      || absenceGraceMs < minimumAbsenceGraceMs
      || timeoutMs < absenceGraceMs
    ) {
      throw bootOwnershipError(
        'BOOT_OWNERSHIP_TIMING_INVALID',
        `Ownership timing requires timeout >= absence grace >= ${minimumAbsenceGraceMs}ms ` +
        'and a positive poll interval'
      );
    }
    const startedAt = this.monotonicNowMs();
    // One ownership decision may never span two DAS epochs. In particular, an
    // absence window accumulated before a child-process/restart event must not
    // be inherited by the new runtime after the polling sleep returns.
    const classificationBootEpoch = state.bootEpoch;
    let absenceStartedAt: number | null = null;
    let lastReadFailed = false;

    this.logger.info(
      { appName, timeoutMs, pollIntervalMs, absenceGraceMs },
      'Classifying post-start application deployment ownership'
    );

    while (this.monotonicNowMs() - startedAt <= timeoutMs) {
      try {
        const refs = await this.listApplicationRefs();
        const apps = await this.listApplications();
        await this.assertBootEpochCurrent(
          appName,
          classificationBootEpoch,
          'boot ownership inventory'
        );
        const referenced = refs.includes(appName);
        const runtimeListed = apps.includes(appName);

        if (referenced) {
          state.phase = 'payara-booting';
          state.readiness = 'unverified';
          state.owner = 'payara';
          state.runtimeListed = runtimeListed;
          state.reservationToken = undefined;
          const healthVerified = await this.tryPromoteWithConfiguredHealth(
            appName,
            state,
            refs,
            apps
          );
          const readiness = healthVerified ? 'health-verified' : 'unverified';
          this.logger.warn(
            {
              appName,
              bootEpoch: state.bootEpoch,
              runtimeListed,
              readiness,
            },
            healthVerified
              ? 'Payara boot deployment is health-verified'
              : 'Payara owns boot deployment; explicit deployment is fenced'
          );
          return {
            owner: 'payara',
            bootEpoch: state.bootEpoch,
            runtimeListed,
            readiness,
          };
        }

        if (runtimeListed) {
          state.phase = 'blocked';
          state.owner = undefined;
          state.runtimeListed = true;
          state.evidenceSource = 'contradictory-inventory';
          throw bootOwnershipError(
            'BOOT_STATE_CONTRADICTORY',
            `Application ${appName} is runtime-listed without a persistent server reference`
          );
        }

        if (absenceStartedAt === null || lastReadFailed) {
          absenceStartedAt = this.monotonicNowMs();
        }
        lastReadFailed = false;

        if (this.monotonicNowMs() - absenceStartedAt >= absenceGraceMs) {
          this.markApplicationReady(
            appName,
            'not_applicable',
            'continuous-absence',
            'agent',
            false,
            classificationBootEpoch
          );
          this.logger.info(
            {
              appName,
              bootEpoch: state.bootEpoch,
              waitedMs: this.monotonicNowMs() - startedAt,
            },
            'Agent owns deployment; target ref and runtime state remained absent'
          );
          return {
            owner: 'agent',
            bootEpoch: state.bootEpoch,
            runtimeListed: false,
            readiness: 'not_applicable',
          };
        }
      } catch (err) {
        if (
          err instanceof Error
          && (err.name === 'BOOT_STATE_CONTRADICTORY' || err.name === 'BOOT_EPOCH_CHANGED')
        ) {
          throw err;
        }
        lastReadFailed = true;
        absenceStartedAt = null;
        this.logger.debug({ err, appName }, 'Boot ownership inventory read failed; retrying');
      }

      await this.sleep(pollIntervalMs);
    }

    await this.assertBootEpochCurrent(
      appName,
      classificationBootEpoch,
      'boot ownership timeout'
    );
    state.phase = 'blocked';
    state.readiness = 'unverified';
    state.owner = undefined;
    state.runtimeListed = undefined;
    state.evidenceSource = 'inventory-timeout';
    throw bootOwnershipError(
      'BOOT_OWNERSHIP_UNKNOWN',
      `Could not prove safe deployment ownership for ${appName} within ${timeoutMs}ms`
    );
  }

  private async classifyRegisteredBootOwnership(): Promise<void> {
    for (const appName of this.bootDeploymentStates.keys()) {
      await this.classifyBootOwnershipUnlocked(appName);
    }
  }

  /**
   * Atomically classify ownership and, only for an agent-owned empty target,
   * perform the final absence check and fresh deployment under the same lease.
   */
  async reconcilePostStartDeployment(
    warPath: string,
    appName: string,
    contextRoot: string | undefined,
    policy: PostStartDeploymentPolicy
  ): Promise<PostStartDeploymentResult> {
    return this.withMutationLease(`post-start-deploy:${appName}`, async () => {
      const ownership = await this.classifyBootOwnershipUnlocked(appName);
      if (ownership.owner === 'payara') {
        if (policy === 'require-agent-owned') {
          throw bootOwnershipError(
            'BOOT_OWNER_CONFLICT',
            `Payara owns boot epoch ${ownership.bootEpoch} for ${appName}`
          );
        }

        return {
          outcome: 'boot-owned-skip',
          bootEpoch: ownership.bootEpoch,
          deploymentAttempted: false,
          deployedObserved: ownership.runtimeListed,
          readiness: ownership.readiness,
        };
      }

      if (ownership.runtimeListed) {
        return {
          outcome: 'already-reconciled-skip',
          bootEpoch: ownership.bootEpoch,
          deploymentAttempted: false,
          deployedObserved: true,
          owner: 'agent',
        };
      }

      const state = this.getOrCreateBootState(appName);
      state.phase = 'agent-reserved';
      state.reservationToken = this.requireActiveMutationToken();
      try {
        await this.deployFreshUnlocked(warPath, appName, contextRoot);
        const applications = await this.listApplications();
        await this.assertBootEpochCurrent(
          appName,
          ownership.bootEpoch,
          'post-start deployment verification'
        );
        const deployed = applications.includes(appName);
        if (!deployed) {
          throw bootOwnershipError(
            'DEPLOYMENT_VERIFICATION_FAILED',
            `${appName} not in application list after fresh deployment`
          );
        }
        this.markApplicationReady(
          appName,
          'not_applicable',
          'agent-fresh-deploy',
          'agent',
          true,
          ownership.bootEpoch
        );
        return {
          outcome: 'agent-deployed',
          bootEpoch: ownership.bootEpoch,
          deploymentAttempted: true,
          deployed,
          applications,
        };
      } catch (err) {
        if (
          state.bootEpoch === ownership.bootEpoch
          && !state.mutationOutcomeUnknown
        ) {
          state.phase = 'blocked';
          state.readiness = 'unverified';
          state.owner = undefined;
          state.runtimeListed = undefined;
          state.evidenceSource = 'agent-deploy-failed';
        }
        throw err;
      } finally {
        state.reservationToken = undefined;
      }
    });
  }

  /**
   * Accept explicit, audited readiness evidence for the exact current boot epoch.
   * The containing agent must keep this operation inside its local/SSH trust
   * boundary; this manager validates epoch, timing, inventory, and evidence.
   */
  async attestBootReady(
    appName: string,
    attestation: BootReadinessAttestation
  ): Promise<BootDeploymentStatus> {
    const requestedBootEpoch = typeof attestation?.bootEpoch === 'string'
      ? attestation.bootEpoch
      : '';
    const beforeLease = this.getOrCreateBootState(appName);
    if (beforeLease.startupActive) {
      throw bootOwnershipError(
        'BOOT_STARTUP_ACTIVE',
        `Startup is still active for ${appName} in epoch ${beforeLease.bootEpoch}`
      );
    }
    if (this.isMutationInProgress()) {
      throw bootOwnershipError(
        'BOOT_MUTATION_ACTIVE',
        `Another Payara mutation is active for ${this.domain}`
      );
    }
    if (requestedBootEpoch !== beforeLease.bootEpoch) {
      throw bootOwnershipError(
        'BOOT_EPOCH_MISMATCH',
        `Attestation epoch does not match current epoch ${beforeLease.bootEpoch}`
      );
    }

    return this.withMutationLease(`attest-boot-ready:${appName}`, async () => {
      const reason = typeof attestation?.reason === 'string' ? attestation.reason.trim() : '';
      const source = typeof attestation?.source === 'string' ? attestation.source.trim() : '';
      if (!reason || reason.length > 512 || !source || source.length > 128) {
        throw bootOwnershipError(
          'BOOT_ATTESTATION_INVALID',
          'reason and source are required and must fit their audit bounds'
        );
      }

      await this.synchronizeRuntimeEpochUnlocked();
      const state = this.getOrCreateBootState(appName);
      if (requestedBootEpoch !== state.bootEpoch) {
        throw bootOwnershipError(
          'BOOT_EPOCH_MISMATCH',
          `Attestation epoch does not match current epoch ${state.bootEpoch}`
        );
      }
      if (state.startupActive) {
        throw bootOwnershipError(
          'BOOT_STARTUP_ACTIVE',
          `Startup is still active for ${appName} in epoch ${state.bootEpoch}`
        );
      }
      if (state.phase === 'ready') {
        return this.getBootDeploymentStatus(appName);
      }
      if (
        state.phase !== 'payara-booting'
        && state.phase !== 'startup'
        && state.phase !== 'blocked'
      ) {
        throw bootOwnershipError(
          'BOOT_ATTESTATION_STATE_INVALID',
          `Cannot attest ${appName} while boot state is ${state.phase}`
        );
      }

      const refs = await this.listApplicationRefs();
      const apps = await this.listApplications();
      await this.assertBootEpochCurrent(
        appName,
        requestedBootEpoch,
        'readiness attestation inventory'
      );
      if (!refs.includes(appName) || !apps.includes(appName)) {
        throw bootOwnershipError(
          'BOOT_ATTESTATION_INVENTORY_MISMATCH',
          `Both the persistent ref and runtime application must exist for ${appName}`
        );
      }

      // Attestation can release ordinary Payara-owned readiness only. It may
      // never resolve an ambiguous application command in the same runtime.
      if (state.mutationOutcomeUnknown) {
        this.clearDurableMutationQuarantineByAttestation(appName, state);
        throw bootOwnershipError(
          'BOOT_ATTESTATION_OPERATION_UNSAFE',
          'Same-runtime attestation cannot resolve an ambiguous application mutation'
        );
      }
      this.markApplicationReady(
        appName,
        'externally-attested',
        source,
        'payara',
        true,
        requestedBootEpoch
      );
      this.logger.warn(
        { appName, bootEpoch: state.bootEpoch, reason, source },
        'Payara boot readiness explicitly attested'
      );
      return this.getBootDeploymentStatus(appName);
    });
  }

  /**
   * Consume explicit operator authority by immediately replacing one broken
   * Payara-owned boot deployment. The caller must already hold the shared
   * cross-process deployment lock; this method retains the same Payara mutation
   * lease from authorization validation through the final verification.
   */
  async recoverBootDeployment(
    warPath: string,
    appName: string,
    contextRoot: string | undefined,
    authorization: BootRecoveryAuthorization
  ): Promise<BootRecoveryResult> {
    return this.withMutationLease(`recover-boot-deployment:${appName}`, async () => {
      const requestedBootEpoch = typeof authorization?.bootEpoch === 'string'
        ? authorization.bootEpoch
        : '';
      const requestedRuntimeFingerprint =
        typeof authorization?.runtimeFingerprint === 'string'
          ? authorization.runtimeFingerprint
          : '';
      const expectedArtifactSha256 =
        typeof authorization?.expectedArtifactSha256 === 'string'
          ? authorization.expectedArtifactSha256
          : '';
      const authorizationId = typeof authorization?.authorizationId === 'string'
        ? authorization.authorizationId.trim()
        : '';
      const reason = typeof authorization?.reason === 'string'
        ? authorization.reason.trim()
        : '';
      const source = typeof authorization?.source === 'string'
        ? authorization.source.trim()
        : '';
      const expectedRuntimeListed = authorization?.expectedRuntimeListed;
      if (
        !requestedBootEpoch
        || !/^[a-f0-9]{64}$/.test(requestedRuntimeFingerprint)
        || !/^[a-f0-9]{64}$/.test(expectedArtifactSha256)
        || !authorizationId
        || authorizationId.length > 128
        || hasAuditControlCharacters(authorizationId)
        || typeof expectedRuntimeListed !== 'boolean'
        || !reason
        || reason.length > 512
        || hasAuditControlCharacters(reason)
        || !source
        || source.length > 128
        || hasAuditControlCharacters(source)
      ) {
        throw bootOwnershipError(
          'BOOT_RECOVERY_AUTHORIZATION_INVALID',
          'bootEpoch, runtimeFingerprint, expectedArtifactSha256, authorizationId, ' +
          'expectedRuntimeListed, reason, and source are required within their audit bounds'
        );
      }

      this.registerApplication(appName);
      await this.synchronizeRuntimeEpochUnlocked();
      const state = this.getOrCreateBootState(appName);
      if (state.startupActive) {
        throw bootOwnershipError(
          'BOOT_STARTUP_ACTIVE',
          `Startup is still active for ${appName} in epoch ${state.bootEpoch}`
        );
      }
      if (state.mutationOutcomeUnknown) {
        throw bootOwnershipError(
          'BOOT_MUTATION_OUTCOME_UNKNOWN',
          `Recovery cannot clear an ambiguous mutation of ${appName} in the current runtime`
        );
      }
      if (requestedBootEpoch !== state.bootEpoch) {
        throw bootOwnershipError(
          'BOOT_EPOCH_MISMATCH',
          `Recovery epoch does not match current epoch ${state.bootEpoch}`
        );
      }
      if (requestedRuntimeFingerprint !== this.runtimeFingerprint()) {
        throw bootOwnershipError(
          'BOOT_RUNTIME_IDENTITY_MISMATCH',
          `Recovery authority does not match the exact ${this.domain} DAS runtime`
        );
      }

      const authorizationKey =
        `${requestedRuntimeFingerprint}:${expectedArtifactSha256}:${authorizationId}`;
      const consumedForEpoch = this.consumedBootRecoveryAuthorizations
        .get(requestedBootEpoch);
      if (consumedForEpoch?.has(authorizationKey)) {
        throw bootOwnershipError(
          'BOOT_RECOVERY_AUTHORIZATION_CONSUMED',
          `Recovery authorization ${authorizationId} was already consumed in this boot epoch`
        );
      }
      if (
        state.phase !== 'payara-booting'
        || state.owner !== 'payara'
      ) {
        throw bootOwnershipError(
          'BOOT_RECOVERY_OWNER_INVALID',
          'Recovery is limited to a Payara-owned boot deployment'
        );
      }

      // This dedicated operation is intentionally narrower than readiness or
      // ordinary deployment: the persistent ref must exist and runtime
      // inventory must exactly match what the operator authorized.
      const refs = await this.listApplicationRefs();
      const apps = await this.listApplications();
      await this.assertBootEpochCurrent(
        appName,
        requestedBootEpoch,
        'operator boot recovery inventory'
      );
      if (requestedRuntimeFingerprint !== this.runtimeFingerprint()) {
        throw bootOwnershipError(
          'BOOT_RUNTIME_IDENTITY_MISMATCH',
          `Recovery authority expired while inspecting ${this.domain}`
        );
      }
      const runtimeListed = apps.includes(appName);
      // Refresh operator readback even when the authorized expectation is now
      // stale. This does not grant authority; a mismatch still fails before
      // reservation, consumption, WAL, or any remote command.
      state.runtimeListed = runtimeListed;
      if (!refs.includes(appName) || runtimeListed !== expectedRuntimeListed) {
        throw bootOwnershipError(
          'BOOT_RECOVERY_STATE_INVALID',
          `Recovery requires a persistent ${appName} reference and runtimeListed=` +
          `${String(expectedRuntimeListed)} exactly as authorized`
        );
      }

      const token = this.requireActiveMutationToken();
      state.phase = 'agent-reserved';
      state.readiness = 'unverified';
      state.owner = 'agent';
      state.runtimeListed = runtimeListed;
      state.readyAtMs = undefined;
      state.reservationToken = token;
      state.evidenceSource = `operator-recovery:${source}`;

      try {
        const deployArgs = this.buildDeployArgs(warPath, appName, contextRoot, false);
        // Complete every awaited read before arming the WAL. Inventory drift
        // here is known-not-dispatched and must not strand a false UNKNOWN.
        await this.assertBootEpochCurrent(
          appName,
          requestedBootEpoch,
          'operator boot recovery pre-dispatch'
        );
        if (requestedRuntimeFingerprint !== this.runtimeFingerprint()) {
          throw bootOwnershipError(
            'BOOT_RUNTIME_IDENTITY_MISMATCH',
            `Recovery authority expired before mutating ${this.domain}`
          );
        }
        const dispatchRefs = await this.listApplicationRefs();
        const dispatchApps = await this.listApplications();
        const dispatchState = this.getOrCreateBootState(appName);
        const dispatchRuntimeListed = dispatchApps.includes(appName);
        if (
          dispatchState.bootEpoch !== requestedBootEpoch
          || requestedRuntimeFingerprint !== this.runtimeFingerprint()
          || !dispatchRefs.includes(appName)
          || dispatchRuntimeListed !== expectedRuntimeListed
        ) {
          throw bootOwnershipError(
            'BOOT_RECOVERY_PRE_DISPATCH_CHANGED',
            'Boot recovery state changed after authorization and before dispatch'
          );
        }

        // Bind one-shot consumption to both exact bytes and the exact DAS.
        // Runtime identity is checked after the potentially long synchronous
        // hash; each remote command repeats that final ordering inside the WAL.
        this.assertRecoveryArtifactCurrentSync(warPath, expectedArtifactSha256);
        this.assertRuntimeIdentityCurrentSync(requestedRuntimeFingerprint);
        const epochAuthorizations = consumedForEpoch ?? new Set<string>();
        epochAuthorizations.add(authorizationKey);
        this.consumedBootRecoveryAuthorizations.set(requestedBootEpoch, epochAuthorizations);
        this.logger.warn(
          {
            appName,
            bootEpoch: requestedBootEpoch,
            runtimeFingerprint: requestedRuntimeFingerprint,
            expectedArtifactSha256,
            authorizationId,
            expectedRuntimeListed,
            reason,
            source,
          },
          'Consuming one-shot authority for a stuck Payara boot deployment'
        );

        let verifiedApplications: string[] = [];
        await this.withDurableApplicationMutation(
          appName,
          requestedBootEpoch,
          `boot-recovery:${authorizationId}`,
          `operator-boot-recovery:${source}`,
          async () => {
            // The durable WAL is armed before this first remote mutation. One
            // record spans ref removal and the fresh deploy, so a crash or lost
            // response cannot turn a replay into implicit authority.
            this.assertRuntimeIdentityCurrentSync(requestedRuntimeFingerprint);
            await this.asadminCommand(['undeploy', appName]);
            await this.assertApplicationAbsent(appName, 'BOOT_RECOVERY_UNDEPLOY_NOT_CONFIRMED');
            await this.assertBootEpochCurrent(
              appName,
              requestedBootEpoch,
              'operator boot recovery after undeploy'
            );
            // Re-bind the deploy command to the exact authorized bytes after
            // every awaited undeploy/absence/epoch check. asadmin is spawned
            // synchronously by asadminCommand before its returned promise can
            // yield, so a pathname substitution observed here cannot reach
            // deploy. Because the WAL is already armed, a mismatch is retained
            // as UNKNOWN rather than being misclassified as known-not-dispatched.
            this.assertRecoveryArtifactCurrentSync(
              warPath,
              expectedArtifactSha256
            );
            // Hashing a large WAR can outlast a DAS replacement. The exact
            // procfs identity must therefore be the final synchronous CAS,
            // with no JavaScript yield before asadmin is spawned.
            this.assertRuntimeIdentityCurrentSync(requestedRuntimeFingerprint);
            await this.asadminCommand(deployArgs, this.deployTimeout);
            // A mutation while asadmin was consuming the pathname makes the
            // command outcome ambiguous even if asadmin reported success.
            this.assertRecoveryArtifactCurrentSync(
              warPath,
              expectedArtifactSha256
            );
            await this.assertBootEpochCurrent(
              appName,
              requestedBootEpoch,
              'operator boot recovery deploy completion'
            );
            const deployedRefs = await this.listApplicationRefs();
            const deployedApps = await this.listApplications();
            await this.assertBootEpochCurrent(
              appName,
              requestedBootEpoch,
              'operator boot recovery verification'
            );
            if (!deployedRefs.includes(appName) || !deployedApps.includes(appName)) {
              throw bootOwnershipError(
                'BOOT_RECOVERY_VERIFICATION_FAILED',
                `${appName} was not present in both persistent and runtime inventory after recovery`
              );
            }
            verifiedApplications = [...deployedApps];
            this.markApplicationReady(
              appName,
              'not_applicable',
              `operator-recovery:${source}`,
              'agent',
              true,
              requestedBootEpoch
            );
          }
        );

        return {
          // Use the exact list captured before the WAL was cleared. No remote
          // await may turn a completed recovery into a false absent-state restore.
          applications: verifiedApplications,
          bootDeployment: this.getBootDeploymentStatus(appName),
        };
      } catch (err) {
        const current = this.getOrCreateBootState(appName);
        if (
          current.bootEpoch === requestedBootEpoch
          && !current.mutationOutcomeUnknown
        ) {
          // WAL persistence failed before any remote mutation. Restore the
          // narrow stuck state so a newly authorized attempt can be evaluated.
          current.phase = 'payara-booting';
          current.readiness = 'unverified';
          current.owner = 'payara';
          current.runtimeListed = expectedRuntimeListed;
          current.evidenceSource = 'operator-recovery-not-dispatched';
        }
        throw err;
      } finally {
        const current = this.getOrCreateBootState(appName);
        if (current.reservationToken === token) {
          current.reservationToken = undefined;
        }
      }
    });
  }

  private async assertTargetMutationAllowed(appName: string): Promise<void> {
    this.registerApplication(appName);
    await this.synchronizeRuntimeEpochUnlocked();
    let state = this.getOrCreateBootState(appName);
    const token = this.mutationContext.getStore();
    if (
      state.phase === 'agent-reserved' &&
      token &&
      token === state.reservationToken &&
      token === this.activeMutationToken
    ) {
      return;
    }

    if (state.phase === 'ready') {
      return;
    }

    if (
      state.phase === 'unfenced'
      || (state.phase === 'startup' && !state.startupActive)
      || state.phase === 'blocked'
    ) {
      const ownership = await this.classifyBootOwnershipUnlocked(appName);
      if (ownership.owner === 'agent') {
        return;
      }
      state = this.getOrCreateBootState(appName);
    }

    if (state.phase === 'payara-booting') {
      if (await this.tryPromoteWithConfiguredHealth(appName, state)) {
        return;
      }
      const ownership = await this.classifyBootOwnershipUnlocked(appName);
      if (ownership.owner === 'agent') {
        return;
      }
      state = this.getOrCreateBootState(appName);
    }

    throw bootOwnershipError(
      'BOOT_READINESS_ATTESTATION_REQUIRED',
      `Boot epoch ${state.bootEpoch} for ${appName} is ${state.phase}; ` +
      'configure healthEndpoint or attest readiness explicitly'
    );
  }

  /** A stopped domain with no surviving JVM is a finite, safe recovery point. */
  private async assertStoppedStartAllowed(action: string, deadlineMs?: number): Promise<void> {
    // A startup token authorizes the lifecycle operation but is not evidence
    // that the prior DAS is gone. Always require both strict probes before any
    // start-domain path, including plugin onStart and unregistered managers.
    const stateTimeoutMs = deadlineMs === undefined
      ? 10000
      : this.remainingLifecycleBudget(deadlineMs, `${action} running-state probe`);
    if (await this.isRunningStrict(stateTimeoutMs)) {
      throw bootOwnershipError(
        'BOOT_STOPPED_RECOVERY_UNSAFE',
        `${action} requires a stopped domain, but ${this.domain} is running`
      );
    }

    const pids = await this.getPayaraProcessPidsStrict(
      deadlineMs === undefined
        ? 5000
        : this.remainingLifecycleBudget(deadlineMs, `${action} process inventory`)
    );
    if (pids.length === 0) {
      return;
    }

    throw bootOwnershipError(
      'BOOT_STOPPED_RECOVERY_UNSAFE',
      `${action} is fenced while Payara JVMs still exist: ${pids.join(', ')}`
    );
  }

  private async assertLifecycleMutationAllowed(action: string): Promise<void> {
    const token = this.mutationContext.getStore();
    const states = [...this.bootDeploymentStates.values()];
    if (states.length === 0) {
      throw bootOwnershipError(
        'BOOT_APPLICATION_NOT_REGISTERED',
        `Register an application before ${action}`
      );
    }

    const startupLeaseOwnsAll = states.every(state =>
      state.startupActive
      && token !== undefined
      && token === state.startupToken
      && token === this.activeMutationToken
    );
    if (!startupLeaseOwnsAll) {
      await this.synchronizeRuntimeEpochUnlocked();
    }

    for (let state of states) {
      if (
        state.startupActive &&
        token &&
        token === state.startupToken &&
        token === this.activeMutationToken
      ) {
        continue;
      }
      if (
        state.phase === 'agent-reserved' &&
        token &&
        token === state.reservationToken &&
        token === this.activeMutationToken
      ) {
        continue;
      }
      if (state.phase === 'ready') {
        continue;
      }
      if (
        state.phase === 'unfenced'
        || (state.phase === 'startup' && !state.startupActive)
        || state.phase === 'blocked'
      ) {
        const ownership = await this.classifyBootOwnershipUnlocked(state.appName);
        if (ownership.owner === 'agent') {
          continue;
        }
        state = this.getOrCreateBootState(state.appName);
      }
      if (state.phase === 'payara-booting') {
        if (await this.tryPromoteWithConfiguredHealth(state.appName, state)) {
          continue;
        }
        const ownership = await this.classifyBootOwnershipUnlocked(state.appName);
        if (ownership.owner === 'agent') {
          continue;
        }
      }

      throw bootOwnershipError(
        'BOOT_LIFECYCLE_FENCED',
        `${action} is fenced while ${state.appName} is ${state.phase} ` +
        `in boot epoch ${state.bootEpoch}`
      );
    }
  }

  /** Permit targeted orphan cleanup only while the registered target owns the lease. */
  private assertProcessCleanupLease(action: string): void {
    const token = this.requireActiveMutationToken();
    const states = [...this.bootDeploymentStates.values()];
    if (states.length === 0) {
      throw bootOwnershipError(
        'BOOT_APPLICATION_NOT_REGISTERED',
        `Register an application before ${action}`
      );
    }
    const authorized = states.every(state =>
      (
        state.startupActive
        && state.startupToken === token
        && token === this.activeMutationToken
      )
      || state.phase === 'ready'
      || (
        state.phase === 'agent-reserved'
        && state.reservationToken === token
        && token === this.activeMutationToken
      )
    );
    if (!authorized) {
      throw bootOwnershipError(
        'BOOT_PROCESS_CLEANUP_FENCED',
        `${action} requires the startup owner or a ready agent-owned target`
      );
    }
  }

  private async tryPromoteWithConfiguredHealth(
    appName: string,
    state: InternalBootDeploymentState,
    refs?: string[],
    apps?: string[]
  ): Promise<boolean> {
    if (!this.healthEndpoint) {
      return false;
    }

    const expectedBootEpoch = state.bootEpoch;
    const currentRefs = refs ?? await this.listApplicationRefs();
    const currentApps = apps ?? await this.listApplications();
    await this.assertBootEpochCurrent(
      appName,
      expectedBootEpoch,
      'configured health inventory'
    );
    if (!currentRefs.includes(appName) || !currentApps.includes(appName)) {
      return false;
    }
    const healthVerified = await this.checkConfiguredApplicationHealth();
    await this.assertBootEpochCurrent(
      appName,
      expectedBootEpoch,
      'configured health verification'
    );
    if (!healthVerified) {
      return false;
    }

    this.markApplicationReady(
      appName,
      'health-verified',
      this.healthEndpoint,
      'payara',
      true,
      expectedBootEpoch
    );
    this.logger.info(
      { appName, bootEpoch: state.bootEpoch, healthEndpoint: this.healthEndpoint },
      'Payara boot readiness verified by configured application health endpoint'
    );
    return true;
  }

  private markApplicationReady(
    appName: string,
    readiness: BootDeploymentReadiness,
    evidenceSource: string,
    owner: 'payara' | 'agent',
    runtimeListed: boolean,
    expectedBootEpoch: string
  ): void {
    const state = this.getOrCreateBootState(appName);
    if (state.bootEpoch !== expectedBootEpoch) {
      throw bootOwnershipError(
        'BOOT_EPOCH_CHANGED',
        `Refusing stale readiness commit for ${appName}: expected epoch ` +
        `${expectedBootEpoch}, current epoch ${state.bootEpoch}`
      );
    }
    if (state.mutationOutcomeUnknown) {
      throw bootOwnershipError(
        'BOOT_MUTATION_OUTCOME_UNKNOWN',
        `Refusing readiness commit for ${appName}: a mutation has unknown outcome ` +
        `in boot epoch ${state.bootEpoch}`
      );
    }
    state.phase = 'ready';
    state.readiness = readiness;
    state.readyAtMs = Date.now();
    state.evidenceSource = evidenceSource;
    state.owner = owner;
    state.runtimeListed = runtimeListed;
    state.reservationToken = undefined;
  }

  /** Close the current epoch after any ambiguous mutation result. */
  private markApplicationBlocked(
    appName: string,
    expectedBootEpoch: string,
    evidenceSource: string,
    mutationOutcomeUnknown = false
  ): void {
    const state = this.getOrCreateBootState(appName);
    if (state.bootEpoch !== expectedBootEpoch) {
      return;
    }
    state.phase = 'blocked';
    state.readiness = 'unverified';
    state.owner = undefined;
    state.runtimeListed = undefined;
    if (mutationOutcomeUnknown) {
      state.mutationOutcomeUnknown = true;
      state.evidenceSource = evidenceSource;
    } else if (!state.mutationOutcomeUnknown) {
      state.evidenceSource = evidenceSource;
    }
    state.reservationToken = undefined;
  }

  /**
   * Persist an armed record before the first destructive application command.
   * A process death or ambiguous return leaves the record for the next process.
   */
  private async withDurableApplicationMutation<T>(
    appName: string,
    expectedBootEpoch: string,
    operation: string,
    evidenceSource: string,
    mutate: () => Promise<T>
  ): Promise<T> {
    // A cached 2xx from the pre-deploy application must never survive across a
    // mutation boundary and make the replacement appear healthy.
    this.invalidateStatusCache();
    try {
      return await this.withArmedDurableApplicationMutation(
        appName,
        expectedBootEpoch,
        operation,
        evidenceSource,
        mutate
      );
    } finally {
      this.invalidateStatusCache();
    }
  }

  private async withArmedDurableApplicationMutation<T>(
    appName: string,
    expectedBootEpoch: string,
    operation: string,
    evidenceSource: string,
    mutate: () => Promise<T>
  ): Promise<T> {
    const quarantine = this.mutationQuarantine;
    if (!quarantine) {
      try {
        return await mutate();
      } catch (err) {
        this.markApplicationBlocked(appName, expectedBootEpoch, evidenceSource, true);
        throw err;
      }
    }

    if (this.activeMutationQuarantine) {
      if (
        this.activeMutationQuarantine.appName !== appName
        || this.activeMutationQuarantine.bootEpoch !== expectedBootEpoch
        || !Object.is(
          this.activeMutationQuarantine.runtimeIdentity,
          this.currentRuntimeIdentity
        )
      ) {
        throw bootOwnershipError(
          'BOOT_QUARANTINE_ACTIVE',
          `A durable mutation is armed for a different target or runtime in ${this.domain}`
        );
      }
      return mutate();
    }

    const state = this.getOrCreateBootState(appName);
    if (state.bootEpoch !== expectedBootEpoch) {
      throw bootOwnershipError(
        'BOOT_EPOCH_CHANGED',
        `Boot epoch changed before durable ${operation} arm for ${appName}`
      );
    }
    if (state.mutationOutcomeUnknown) {
      throw bootOwnershipError(
        'BOOT_MUTATION_OUTCOME_UNKNOWN',
        `Refusing ${operation}: ${appName} has a durable ambiguous mutation outcome`
      );
    }
    const runtimeIdentity = this.currentRuntimeIdentity;
    if (runtimeIdentity === undefined) {
      throw bootOwnershipError(
        'BOOT_RUNTIME_IDENTITY_UNKNOWN',
        `Cannot durably arm ${operation} without an exact runtime identity`
      );
    }

    const record = quarantine.arm({
      instanceId: this.mutationQuarantineInstanceId,
      domain: this.domain,
      appName,
      runtimeIdentity,
      bootEpoch: expectedBootEpoch,
      operation,
      evidenceSource,
    });
    this.activeMutationQuarantine = record;

    try {
      const result = await mutate();
      quarantine.clear(
        this.mutationQuarantineInstanceId,
        appName,
        record.recordId
      );
      state.durableQuarantineRecordId = undefined;
      return result;
    } catch (err) {
      const current = this.getOrCreateBootState(appName);
      if (Object.is(record.runtimeIdentity, this.currentRuntimeIdentity)) {
        current.durableQuarantineRecordId = record.recordId;
        this.markApplicationBlocked(appName, current.bootEpoch, evidenceSource, true);
      }
      throw err;
    } finally {
      if (this.activeMutationQuarantine?.recordId === record.recordId) {
        this.activeMutationQuarantine = undefined;
      }
    }
  }

  /** Reject attestation whenever the current runtime carries durable UNKNOWN. */
  private clearDurableMutationQuarantineByAttestation(
    appName: string,
    state: InternalBootDeploymentState
  ): void {
    if (!this.mutationQuarantine || !state.durableQuarantineRecordId) return;

    const record = this.mutationQuarantine.read(
      this.mutationQuarantineInstanceId,
      appName
    );
    if (!record || record.recordId !== state.durableQuarantineRecordId) {
      throw bootOwnershipError(
        'BOOT_QUARANTINE_CAS_FAILED',
        `Durable quarantine changed before readiness attestation for ${appName}`
      );
    }
    if (!Object.is(record.runtimeIdentity, this.currentRuntimeIdentity)) {
      throw bootOwnershipError(
        'BOOT_QUARANTINE_IDENTITY_MISMATCH',
        `Durable quarantine does not belong to the current ${this.domain} runtime`
      );
    }
    throw bootOwnershipError(
      'BOOT_ATTESTATION_OPERATION_UNSAFE',
      `Same-runtime attestation cannot resolve ambiguous ${record.operation}; ` +
      'observe an exact replacement DAS or confirmed stopped state with zero JVMs'
    );
  }

  /**
   * Compare-and-set precondition for every readiness or mutation commit.
   * The runtime probe catches unreported DAS replacement; the epoch comparison
   * catches synchronous child-process events that occurred during an await.
   */
  private async assertBootEpochCurrent(
    appName: string,
    expectedBootEpoch: string,
    operation: string
  ): Promise<InternalBootDeploymentState> {
    await this.synchronizeRuntimeEpochUnlocked();
    const state = this.getOrCreateBootState(appName);
    if (state.bootEpoch !== expectedBootEpoch) {
      throw bootOwnershipError(
        'BOOT_EPOCH_CHANGED',
        `Boot epoch changed during ${operation} for ${appName}: expected ` +
        `${expectedBootEpoch}, current ${state.bootEpoch}`
      );
    }
    return state;
  }

  private async assertApplicationAbsent(appName: string, code: string): Promise<void> {
    const refs = await this.listApplicationRefs();
    const apps = await this.listApplications();
    if (refs.includes(appName) || apps.includes(appName)) {
      throw bootOwnershipError(
        code,
        `Application ${appName} is still present after undeploy`
      );
    }
  }

  /**
   * Get Payara status with optional caching.
   *
   * @param forceRefresh - If true, bypasses cache and fetches fresh status
   * @returns Current Payara status
   *
   * Caching reduces shell calls during frequent polling (health checks, status endpoints).
   * Cache TTL is configurable via statusCacheTtlMs (default: 5 seconds).
   */
  async getStatus(forceRefresh = false): Promise<PayaraStatus> {
    // Return cached status if valid and not forcing refresh
    const cached = this.statusCache.get(forceRefresh);
    if (cached) {
      return cached;
    }

    // Fetch fresh status
    const running = await this.isRunningStrict();
    const healthy = running ? await this.isHealthy() : false;
    const processPids = await this.getPayaraProcessPids();

    const status: PayaraStatus = {
      healthy,
      running,
      domain: this.domain,
      processCount: processPids.length,
      processPids,
    };

    // Update cache
    this.statusCache.set(status);

    return status;
  }

  /**
   * Invalidate the status cache.
   * Call this after operations that change Payara state (start, stop, restart).
   */
  invalidateStatusCache(): void {
    this.statusCache.invalidate();
  }

  /**
   * Ensure exactly ONE Payara process is running.
   * If multiple processes detected, kills all and restarts fresh.
   * Returns true if safe (0 or 1 process), false if had to fix duplicates.
   */
  async ensureSingleProcess(
    deadlineMs?: number
  ): Promise<{ ok: boolean; fixed: boolean; previousCount: number }> {
    return this.withMutationLease('ensure-single-payara-process', () =>
      this.ensureSingleProcessUnlocked(deadlineMs)
    );
  }

  private async ensureSingleProcessUnlocked(deadlineMs?: number): Promise<{
    ok: boolean;
    fixed: boolean;
    previousCount: number;
  }> {
    await this.assertLifecycleMutationAllowed('ensure-single-payara-process');
    const pids = await this.getPayaraProcessPidsStrict(
      deadlineMs === undefined
        ? 5000
        : this.remainingLifecycleBudget(deadlineMs, 'single-DAS process inventory')
    );

    if (pids.length <= 1) {
      return { ok: true, fixed: false, previousCount: pids.length };
    }

    // CRITICAL: Multiple Payara processes detected - this causes Hazelcast cluster issues
    this.logger.error({
      pids,
      count: pids.length,
      domain: this.domain,
    }, 'CRITICAL: Multiple Payara processes detected - will cause cluster issues');

    // Automatic duplicate cleanup used to perform a stop/kill/start sequence
    // inside plugin onStart and could outlive the agent's hook timeout. Multiple
    // DAS identities are now an explicit fail-closed operator condition.
    return { ok: false, fixed: false, previousCount: pids.length };
  }

  /**
   * Wait for Payara to become healthy
   */
  private async waitForHealthy(timeoutMs: number): Promise<void> {
    await this.waitForWithMonotonicDeadline(
      remainingMs => this.isHealthy(remainingMs),
      timeoutMs,
      2000,
      `Payara did not become healthy within ${timeoutMs}ms`
    );
  }

  /** Wait for the domain administration plane, without requiring an app. */
  private async waitForRunning(timeoutMs: number): Promise<void> {
    await this.waitForWithMonotonicDeadline(
      remainingMs => this.isRunning(remainingMs),
      timeoutMs,
      1000,
      `Payara domain did not become ready within ${timeoutMs}ms`
    );
  }

  /**
   * Poll within one monotonic deadline. Every probe receives only the current
   * remaining budget, and the interval is shortened at the deadline edge.
   */
  private async waitForWithMonotonicDeadline(
    condition: (remainingMs: number) => Promise<boolean>,
    timeoutMs: number,
    intervalMs: number,
    timeoutMessage: string
  ): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Polling timeout must be a positive finite number');
    }

    const deadlineMs = this.monotonicNowMs() + timeoutMs;

    while (true) {
      const remainingForProbeMs = Math.floor(deadlineMs - this.monotonicNowMs());
      if (remainingForProbeMs <= 0) break;

      const conditionMet = await condition(remainingForProbeMs);
      const afterProbeMs = this.monotonicNowMs();
      if (conditionMet && afterProbeMs <= deadlineMs) return;

      const remainingForSleepMs = Math.floor(deadlineMs - afterProbeMs);
      if (remainingForSleepMs <= 0) break;
      await this.sleep(Math.min(intervalMs, remainingForSleepMs));
    }

    throw new Error(timeoutMessage);
  }

  /**
   * Wait for Payara to stop.
   *
   * Waits for BOTH conditions:
   *  1. `asadmin list-domains` reports the domain "not running" (admin port down).
   *  2. No Payara JVM process remains for the domain user.
   *
   * Condition 2 is essential: `stop-domain` closes the admin port (so #1 passes)
   * well BEFORE the JVM has fully exited and released its heap. Returning on #1
   * alone means a subsequent start-domain spawns a new heap while the old one is
   * still resident — a transient 2×heap overlap that fails as
   * "Failed to commit memory ... Could not create the JVM" on memory-constrained
   * or overcommit-limited hosts (INC-2026-06-22, payara-staging-worker-1). Waiting
   * for the process to drain frees the memory before the new JVM starts.
   */
  private async waitForStopped(timeoutMs: number): Promise<void> {
    await this.waitForWithMonotonicDeadline(
      async remainingMs => {
        const probeDeadlineMs = this.monotonicNowMs() + remainingMs;
        try {
          if (await this.isRunningStrict(Math.max(1, remainingMs))) return false;
          const remainingForInventoryMs = Math.floor(
            probeDeadlineMs - this.monotonicNowMs()
          );
          if (remainingForInventoryMs <= 0) return false;
          const pids = await this.getPayaraProcessPidsStrict(
            remainingForInventoryMs
          );
          return pids.length === 0;
        } catch {
          return false;
        }
      },
      timeoutMs,
      1000,
      `Payara did not fully stop (process still resident) within ${timeoutMs}ms`
    );
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private monotonicNowMs(): number {
    return performance.now();
  }

  private remainingLifecycleBudget(deadlineMs: number, stage: string): number {
    const remainingMs = Math.floor(deadlineMs - this.monotonicNowMs());
    if (remainingMs <= 0) {
      throw new Error(`Lifecycle deadline expired before ${stage}`);
    }
    return remainingMs;
  }

  private requireLifecycleBudget(
    deadlineMs: number | undefined,
    requiredMs: number,
    stage: string
  ): void {
    if (deadlineMs === undefined) return;
    const remainingMs = Math.floor(deadlineMs - this.monotonicNowMs());
    if (remainingMs < requiredMs) {
      throw new Error(
        `PLUGIN_STARTUP_DEADLINE_EXCEEDED: ${remainingMs}ms remain before ${stage}; ` +
        `${requiredMs}ms required`
      );
    }
  }

  /** Production invariant; tests may replace this private seam with zero. */
  private minimumBootOwnershipAbsenceGraceMs(): number {
    return DEFAULT_BOOT_OWNERSHIP_ABSENCE_GRACE_MS;
  }

  // ============================================================================
  // AGGRESSIVE MODE: Ensures only ONE Java process runs at a time
  // ============================================================================

  /**
   * Kill Payara-related Java processes only.
   * Filters by cmdline containing 'payara', 'glassfish', or the domain name.
   *
   * This is safer than killAllJavaProcesses() as it won't kill unrelated Java apps.
   */
  async killPayaraProcesses(): Promise<void> {
    return this.withMutationLease('kill-payara-processes', async () => {
      await this.assertLifecycleMutationAllowed('kill-payara-processes');
      await this.killPayaraProcessesUnlocked();
    });
  }

  private async killPayaraProcessesUnlocked(onKillDispatched?: () => void): Promise<void> {
    this.logger.warn({ user: this.user, domain: this.domain }, 'Killing Payara Java processes');

    const initialProcesses = await this.getPayaraProcessSnapshotStrict();
    const pids = [...initialProcesses.keys()];
    await killProcessesByPid(
      pids,
      'Payara',
      // Revalidate exact domain membership immediately before each signal. A
      // recycled PID or externally replaced DAS fails closed instead of being
      // signalled through a stale inventory snapshot.
      async (command, commandArgs, timeout) => {
        const signal = commandArgs[0];
        const pidArgs = commandArgs.slice(1);
        if (
          command !== '/bin/kill'
          || (signal !== '-TERM' && signal !== '-KILL')
          || pidArgs.length === 0
          || pidArgs.some(value => !/^[1-9]\d*$/u.test(value))
        ) {
          throw bootOwnershipError(
            'BOOT_KILL_COMMAND_UNPARSEABLE',
            'Refusing an unexpected process cleanup command'
          );
        }
        const expectedPids = pidArgs
          .map(value => Number.parseInt(value, 10))
          .sort((left, right) => left - right);
        const exactProcesses = await this.getPayaraProcessSnapshotStrict();
        const exactPids = [...exactProcesses.keys()]
          .sort((left, right) => left - right);
        if (
          expectedPids.length !== exactPids.length
          || expectedPids.some((pid, index) => pid !== exactPids[index])
          || expectedPids.some(
            pid => initialProcesses.get(pid) !== exactProcesses.get(pid)
          )
        ) {
          throw bootOwnershipError(
            'BOOT_RUNTIME_PROCESS_CHANGED',
            'Exact Payara DAS process identity changed before signal dispatch'
          );
        }
        onKillDispatched?.();
        // Signal only through the configured Payara account. A matching DAS
        // owned by another UID remains visible to the system-wide inventory,
        // but the signal cannot be delivered and the final liveness probe
        // fails closed. The plugin never acquires root process authority.
        return this.execCommand(command, commandArgs, timeout);
      },
      this.logger,
      () => this.getPayaraProcessPidsStrict()
    );
  }

  /** Get exact DAS PIDs for this configured domain and no other same-UID JVM. */
  async getPayaraProcessPids(): Promise<number[]> {
    try {
      return await this.getPayaraProcessPidsStrict();
    } catch {
      // Status/telemetry remains best effort. Safety fences call the strict probe.
      return [];
    }
  }

  /** Process inventory for safety decisions; errors are never zero processes. */
  private async getPayaraProcessPidsStrict(timeoutMs = 5000): Promise<number[]> {
    // Enumerate system-wide: a root/manual DAS using the same domainRoot must
    // never be invisible merely because it has a different UID. Exact domain
    // membership still comes only from NUL-delimited procfs argv and the
    // canonical instanceRoot JVM argument.
    const { stdout } = await this.execCommand(
      '/bin/ps',
      ['-ww', '-axo', 'pid=', '-o', 'comm='],
      Math.min(5000, timeoutMs)
    );
    const pids = new Set<number>();
    for (const line of stdout.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      // BSD/macOS `comm` may contain an executable path with spaces. The PID
      // remains a strict leading integer; exact target authority still comes
      // only from NUL-delimited procfs argv on supported Linux production.
      const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
      if (!match?.[1] || !match[2]) {
        throw bootOwnershipError(
          'BOOT_PROCESS_INVENTORY_UNPARSEABLE',
          `Cannot parse strict process inventory row for ${this.domain}`
        );
      }
      const commandName = match[2].toLowerCase();
      if (!commandName.includes('java')) {
        continue;
      }
      const pid = Number.parseInt(match[1], 10);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw bootOwnershipError(
          'BOOT_PROCESS_INVENTORY_UNPARSEABLE',
          `Invalid PID in strict process inventory for ${this.domain}`
        );
      }
      let commandLine: string;
      try {
        commandLine = await this.readProcessCommandLine(pid);
      } catch (err) {
        // A candidate that exited after ps is absent. Every other procfs error
        // is UNKNOWN and therefore cannot authorize start or process cleanup.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw bootOwnershipError(
          'BOOT_PROCESS_IDENTITY_UNAVAILABLE',
          `Cannot read procfs argv for Java PID ${pid}`
        );
      }
      if (this.processCommandLineMatchesDomain(commandLine)) {
        pids.add(pid);
      }
    }
    return [...pids];
  }

  /**
   * Capture the exact procfs start token for every selected DAS PID. The token
   * is compared again immediately before TERM/KILL so PID reuse cannot turn a
   * stale numeric inventory into authority over a successor process.
   */
  private async getPayaraProcessSnapshotStrict(): Promise<Map<number, string>> {
    const pids = await this.getPayaraProcessPidsStrict();
    const snapshot = new Map<number, string>();
    for (const pid of pids) {
      let processStat: string;
      let processCommandLine: string;
      try {
        [processStat, processCommandLine] = await Promise.all([
          this.readProcessStat(pid),
          this.readProcessCommandLine(pid),
        ]);
      } catch (err) {
        throw bootOwnershipError(
          'BOOT_PROCESS_IDENTITY_UNAVAILABLE',
          `Cannot read exact procfs identity for Payara PID ${pid}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
      const startTicks = this.parseProcessStartTicks(processStat);
      if (!startTicks || !this.processCommandLineMatchesDomain(processCommandLine)) {
        throw bootOwnershipError(
          'BOOT_PROCESS_IDENTITY_UNPARSEABLE',
          `Cannot parse exact procfs identity for Payara PID ${pid}`
        );
      }
      snapshot.set(pid, startTicks);
    }
    return snapshot;
  }

  private async readProcessCommandLine(pid: number): Promise<string> {
    return readFile(`/proc/${pid}/cmdline`, 'utf8');
  }

  private async readProcessStat(pid: number): Promise<string> {
    return readFile(`/proc/${pid}/stat`, 'utf8');
  }

  private parseProcessStartTicks(processStat: string): string | undefined {
    // /proc/<pid>/stat field 2 is parenthesized and may contain spaces. The
    // remaining token index 19 is field 22 (process start time in clock ticks).
    const commandEnd = processStat.lastIndexOf(')');
    const remainingFields = commandEnd >= 0
      ? processStat.slice(commandEnd + 1).trim().split(/\s+/)
      : [];
    const startTicks = remainingFields[19];
    return startTicks && /^\d+$/.test(startTicks) ? startTicks : undefined;
  }

  private processCommandLineMatchesDomain(commandLine: string): boolean {
    const argv = commandLine.split('\0').filter(Boolean);
    const prefix = '-Dcom.sun.aas.instanceRoot=';
    const instanceRootArg = argv.find(argument => argument.startsWith(prefix));
    if (!instanceRootArg) {
      return false;
    }
    const instanceRoot = instanceRootArg.slice(prefix.length);
    if (!instanceRoot || !isAbsolute(instanceRoot)) {
      return false;
    }
    let canonicalInstanceRoot: string;
    try {
      canonicalInstanceRoot = realpathSync(instanceRoot);
    } catch {
      return false;
    }
    return canonicalInstanceRoot === this.domainRoot;
  }

  /**
   * Check if any Payara-related Java processes are running
   */
  async hasPayaraProcesses(): Promise<boolean> {
    const pids = await this.getPayaraProcessPidsStrict();
    return pids.length > 0;
  }

  /**
   * Kill ALL Java processes for the configured user.
   * This is the legacy "aggressive mode" that ensures a clean slate.
   *
   * WARNING: This kills ALL Java processes for the user, not just Payara.
   * Prefer killPayaraProcesses() unless you specifically need to kill all Java.
   *
   * @deprecated Use killPayaraProcesses() instead for targeted cleanup
   */
  async killAllJavaProcesses(): Promise<void> {
    return this.withMutationLease('kill-all-java-processes', async () => {
      await this.assertLifecycleMutationAllowed('kill-all-java-processes');
      await this.killAllJavaProcessesUnlocked();
    });
  }

  private async killAllJavaProcessesUnlocked(): Promise<void> {
    this.logger.warn({ user: this.user }, 'Killing ALL Java processes (legacy mode)');

    await killProcessesByPkill(
      ['-u', this.user, 'java'],
      'Java',
      // Even this deprecated broad cleanup runs as the configured Payara
      // account. It must never acquire root process authority.
      (command, commandArgs, timeout, acceptedExitCodes) =>
        this.execCommand(command, commandArgs, timeout, acceptedExitCodes),
      this.logger,
      () => this.hasJavaProcessesStrict(),
      () => this.getJavaProcessPidsStrict()
    );
  }

  /** Java inventory used by destructive safety decisions; probe errors propagate. */
  private async getJavaProcessPidsStrict(): Promise<number[]> {
    const { stdout } = await this.execCommand(
      '/bin/ps',
      ['-u', this.user, '-o', 'pid=', '-o', 'comm='],
      5000
    );
    const pids = new Set<number>();
    for (const line of stdout.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\S+)\s*$/);
      if (!match?.[1] || !match[2]?.toLowerCase().includes('java')) {
        continue;
      }
      const pid = Number.parseInt(match[1], 10);
      if (Number.isSafeInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
    return [...pids];
  }

  private async hasJavaProcessesStrict(): Promise<boolean> {
    return (await this.getJavaProcessPidsStrict()).length > 0;
  }

  /**
   * Check if any Java processes are running for the configured user
   */
  async hasJavaProcesses(): Promise<boolean> {
    try {
      const result = await this.execCommand(
        '/usr/bin/pgrep',
        ['-u', this.user, 'java'],
        3000
      );
      return result.stdout.trim().length > 0;
    } catch {
      // pgrep returns exit code 1 when no processes found
      return false;
    }
  }

  /**
   * Get list of Java process PIDs for the configured user
   */
  async getJavaProcessPids(): Promise<number[]> {
    try {
      const result = await this.execCommand(
        '/usr/bin/pgrep',
        ['-u', this.user, 'java'],
        3000
      );
      return result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(pid => parseInt(pid, 10));
    } catch {
      return [];
    }
  }

  /**
   * Ensure NO Payara Java processes are running before starting.
   * Returns true if safe to start, throws if processes couldn't be killed.
   */
  async ensureNoJavaRunning(killIfRunning = true): Promise<boolean> {
    return this.withMutationLease('ensure-no-java-running', async () => {
      await this.assertLifecycleMutationAllowed('ensure-no-java-running');
      return this.ensureNoJavaRunningUnlocked(killIfRunning);
    });
  }

  private async ensureNoJavaRunningUnlocked(
    killIfRunning = true,
    onKillDispatched?: () => void
  ): Promise<boolean> {
    // This result authorizes start-domain, so UNKNOWN must never collapse to an
    // empty list as it may for best-effort status telemetry.
    const pids = await this.getPayaraProcessPidsStrict();

    if (pids.length === 0) {
      this.logger.debug('No Payara Java processes running - safe to start');
      return true;
    }

    if (!killIfRunning) {
      throw new Error(`Payara Java processes already running: ${pids.join(', ')}. Cannot start safely.`);
    }

    this.logger.warn({ pids }, 'Found existing Payara processes, killing them');
    await this.killPayaraProcessesUnlocked(onKillDispatched);

    return true;
  }

  /**
   * Aggressive stop: stop domain + kill Payara Java processes + verify
   *
   * Use this instead of stop() when you need to guarantee no Payara processes remain.
   */
  async aggressiveStop(): Promise<void> {
    return this.withMutationLease('aggressive-stop', () => this.aggressiveStopUnlocked());
  }

  private async aggressiveStopUnlocked(): Promise<void> {
    const running = await this.isRunningStrict();
    if (running) {
      await this.assertLifecycleMutationAllowed('aggressive-stop');
    } else {
      this.assertProcessCleanupLease('aggressive-stop');
    }
    this.logger.info({ domain: this.domain }, 'Aggressive stop: stopping domain and killing Payara Java');

    let gracefulStopError: unknown;
    let destructiveCommandDispatched = false;
    try {
      // Step 1: Try graceful stop. A rejected asadmin client is remembered
      // even if process cleanup succeeds: the remote request may complete late.
      if (running) {
        try {
          destructiveCommandDispatched = true;
          await this.asadminCommand(['stop-domain', this.domain], 30000);
          await this.sleep(2000);
        } catch (err) {
          gracefulStopError = err;
          this.logger.warn({ err }, 'Graceful stop outcome unknown; cleaning up without restart');
        }
      }

      // Step 2: Kill all remaining Payara Java processes (filtered by cmdline)
      await this.killPayaraProcessesUnlocked(() => {
        destructiveCommandDispatched = true;
      });

      // Step 3: Verify
      const remainingPids = await this.getPayaraProcessPidsStrict();
      if (remainingPids.length > 0) {
        throw new Error('Failed to stop all Payara processes');
      }

      if (gracefulStopError) {
        throw lifecycleOutcomeUnknown('aggressive stop-domain', gracefulStopError);
      }
    } catch (err) {
      if (
        err instanceof Error
        && err.name === 'BOOT_LIFECYCLE_OUTCOME_UNKNOWN'
      ) {
        throw err;
      }
      if (destructiveCommandDispatched) {
        this.logger.error({ err, domain: this.domain }, 'Aggressive stop outcome could not be verified');
        throw lifecycleOutcomeUnknown('aggressive-stop', err);
      }
      throw err;
    }

    // Invalidate status cache after state change
    this.invalidateStatusCache();

    this.logger.info({ domain: this.domain }, 'Aggressive stop completed - no Payara processes running');
  }

  /**
   * Safe start: ensures no Java processes are running before starting Payara.
   *
   * This is the recommended way to start Payara in aggressive mode.
   */
  async safeStart(
    options: { waitForApplicationHealth?: boolean; timeoutMs?: number } = {}
  ): Promise<void> {
    return this.withMutationLease('safe-start', () => this.safeStartUnlocked(options));
  }

  private async safeStartUnlocked(
    options: { waitForApplicationHealth?: boolean; timeoutMs?: number } = {}
  ): Promise<void> {
    const waitForApplicationHealth = options.waitForApplicationHealth ?? true;
    const lifecycleTimeoutMs = options.timeoutMs ?? this.operationTimeout;
    if (!Number.isFinite(lifecycleTimeoutMs) || lifecycleTimeoutMs <= 0) {
      throw new Error('Lifecycle timeout must be a positive finite number');
    }

    if (await this.isRunningStrict()) {
      await this.assertLifecycleMutationAllowed('safe-start');
    } else {
      this.assertProcessCleanupLease('safe-start');
    }

    this.logger.info({ domain: this.domain }, 'Safe start: verifying clean state before starting');

    // Ensure no Java processes running
    let cleanupCommandDispatched = false;
    try {
      await this.ensureNoJavaRunningUnlocked(true, () => {
        cleanupCommandDispatched = true;
      });
    } catch (err) {
      if (cleanupCommandDispatched) {
        this.logger.error({ err, domain: this.domain }, 'Safe-start cleanup outcome is unknown');
        throw lifecycleOutcomeUnknown('safe-start cleanup', err);
      }
      throw err;
    }
    await this.assertStoppedStartAllowed('safe-start');

    // Write environment to setenv.conf
    await this.writeSetenvConfInternal();

    // Close the external-start window created by the setenv write before this
    // aggressive path dispatches a successor DAS.
    await this.assertStoppedStartAllowed('safe-start final pre-dispatch');

    // Start domain
    this.logger.info({ domain: this.domain }, 'Starting Payara domain (aggressive mode)');
    const deadlineMs = this.monotonicNowMs() + lifecycleTimeoutMs;
    const startCommandTimeoutMs = this.remainingLifecycleBudget(
      deadlineMs,
      'safe start-domain command'
    );
    this.beginBootEpoch(undefined, 'confirmed-stopped-start', true);
    try {
      await this.asadminCommand(
        ['start-domain', this.domain],
        startCommandTimeoutMs
      );
    } catch (err) {
      this.logger.error({ err, domain: this.domain }, 'safe start-domain dispatch outcome is unknown');
      throw lifecycleOutcomeUnknown('safe start-domain', err);
    }

    let runtimeWaitError: unknown;
    try {
      await this.waitForRunning(
        this.remainingLifecycleBudget(deadlineMs, 'safe start-domain runtime verification')
      );
    } catch (err) {
      runtimeWaitError = err;
    }
    try {
      await this.synchronizeRuntimeEpochUnlocked();
    } catch (identityError) {
      this.logger.error(
        { err: runtimeWaitError, identityError, domain: this.domain },
        'Safe-started DAS did not reach a verified exact runtime identity'
      );
      throw lifecycleOutcomeUnknown('safe start-domain', identityError);
    }

    if (waitForApplicationHealth) {
      await this.waitForHealthy(
        this.remainingLifecycleBudget(deadlineMs, 'safe start-domain health verification')
      );
    }

    if (waitForApplicationHealth) {
      await this.classifyRegisteredBootOwnership();
    }

    // Invalidate status cache after state change
    this.invalidateStatusCache();

    this.logger.info({ domain: this.domain }, 'Payara domain started successfully');
  }

  /**
   * @deprecated Stable list-applications snapshots are not a deployment fence.
   * This compatibility method now returns only when the target has remained
   * entirely absent; a Payara-owned boot deployment fails closed.
   */
  async waitForBootDeploySettled(
    appName: string,
    timeoutMs = DEFAULT_BOOT_OWNERSHIP_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_BOOT_OWNERSHIP_POLL_INTERVAL_MS
  ): Promise<void> {
    const ownership = await this.classifyBootOwnership(appName, {
      timeoutMs,
      pollIntervalMs,
    });
    if (ownership.owner === 'payara') {
      throw bootOwnershipError(
        'BOOT_OWNER_CONFLICT',
        `Payara owns the current boot deployment of ${appName}; refusing redeploy`
      );
    }
  }

  /**
   * Full restart with aggressive cleanup:
   * 1. Stop domain gracefully
   * 2. Kill ALL Java processes
   * 3. Verify no Java running
   * 4. Start fresh
   */
  async aggressiveRestart(): Promise<void> {
    return this.withMutationLease('aggressive-restart', async () => {
      this.logger.info({ domain: this.domain }, 'Aggressive restart: full stop → kill → start cycle');
      if (await this.isRunning()) {
        await this.assertLifecycleMutationAllowed('aggressive-restart');
      } else {
        await this.assertStoppedStartAllowed('aggressive-restart');
      }
      await this.aggressiveStopUnlocked();
      await this.safeStartUnlocked();
      this.logger.info({ domain: this.domain }, 'Aggressive restart completed');
    });
  }
}
