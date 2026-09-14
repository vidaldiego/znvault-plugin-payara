// Path: src/routes/lifecycle.ts
// Lifecycle routes - server start/stop/restart operations

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  BootReadinessAttestation,
  BootRecoveryAuthorization,
} from '../types.js';
import type { RouteContext } from './types.js';
import { getErrorMessage } from '../utils/error.js';

const FORWARDED_OPERATOR_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
  'via',
] as const;

/**
 * Operator assertions carry mutation authority and are never a remote agent
 * API. Use the kernel socket peer, not request.ip (which may trust proxy
 * headers), and reject every forwarding marker even for a loopback peer.
 */
function assertLocalOperatorRequest(request: FastifyRequest): void {
  const forwardedHeader = FORWARDED_OPERATOR_HEADERS.find(
    header => request.headers[header] !== undefined
  );
  const remoteAddress = request.raw.socket.remoteAddress ?? '';
  const loopback = remoteAddress === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(remoteAddress)
    || /^::ffff:127(?:\.\d{1,3}){3}$/i.test(remoteAddress);
  if (forwardedHeader || !loopback) {
    const error = new Error(
      'OPERATOR_ROUTE_LOCAL_ONLY: use a direct loopback connection through the audited SSH runbook'
    );
    error.name = 'OPERATOR_ROUTE_LOCAL_ONLY';
    throw error;
  }
}

const OPERATOR_CONFLICT_CODES = new Set([
  'BOOT_ATTESTATION_INVENTORY_MISMATCH',
  'BOOT_ATTESTATION_INVALID',
  'BOOT_ATTESTATION_OPERATION_UNSAFE',
  'BOOT_EPOCH_CHANGED',
  'BOOT_EPOCH_MISMATCH',
  'BOOT_MUTATION_ACTIVE',
  'BOOT_OWNER_CONFLICT',
  'BOOT_RECOVERY_AUTHORIZATION_CONSUMED',
  'BOOT_RECOVERY_AUTHORIZATION_INVALID',
  'BOOT_RECOVERY_ARTIFACT_ALREADY_PRESENT',
  'BOOT_RECOVERY_ARTIFACT_INVALID',
  'BOOT_RECOVERY_ARTIFACT_MISMATCH',
  'BOOT_RECOVERY_OWNER_INVALID',
  'BOOT_RECOVERY_PRE_DISPATCH_CHANGED',
  'BOOT_RECOVERY_STATE_INVALID',
  'BOOT_RUNTIME_IDENTITY_MISMATCH',
  'BOOT_STARTUP_ACTIVE',
  'OUTAGE_FENCE_ACTIVE',
  'OUTAGE_FENCE_CAPABILITY_MISMATCH',
  'OUTAGE_FENCE_NOT_ARMED',
  'OUTAGE_FENCE_OWNER_MISMATCH',
  'OUTAGE_FENCE_PHASE_INVALID',
  'OUTAGE_FENCE_PID0_REQUIRED',
  'OUTAGE_FENCE_RECOVERY_REQUIRED',
  'OUTAGE_FENCE_RELEASE_UNPROVEN',
  'OUTAGE_FENCE_FINALIZE_UNPROVEN',
  'OUTAGE_FENCE_HOLD_MISMATCH',
  'OUTAGE_FENCE_HOLD_MISSING',
  'OUTAGE_FENCE_ORPHANED_HOLD',
  'OUTAGE_FENCE_TARGET_MISMATCH',
]);

function operatorErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return '';
  if (error.name && error.name !== 'Error') return error.name;
  return error.message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] ?? '';
}

function operatorErrorStatus(error: unknown): 400 | 403 | 409 | 500 | 503 {
  const code = operatorErrorCode(error);
  if (code === 'OPERATOR_ROUTE_LOCAL_ONLY') return 403;
  if (
    code === 'OUTAGE_FENCE_OWNER_INVALID'
    || code === 'OUTAGE_FENCE_CAPABILITY_INVALID'
    || code === 'OUTAGE_FENCE_AUTHORIZATION_INCOMPLETE'
    || code === 'OUTAGE_FENCE_TARGET_INVALID'
    || code === 'OUTAGE_FENCE_RECOVERY_REASON_INVALID'
  ) return 400;
  if (OPERATOR_CONFLICT_CODES.has(code)) return 409;
  if (
    code === 'BOOT_MUTATION_OUTCOME_UNKNOWN'
    || code === 'BOOT_LIFECYCLE_OUTCOME_UNKNOWN'
    || code.startsWith('BOOT_QUARANTINE_')
    || code.startsWith('DEPLOYMENT_LOCK_')
    || code === 'PAYARA_OPERATION_DEADLINE_EXCEEDED'
  ) {
    return 503;
  }
  return 500;
}

/**
 * Register lifecycle routes
 *
 * Routes:
 * - POST /restart - Restart Payara domain
 * - POST /start - Start Payara domain
 * - POST /stop - Stop Payara domain
 * - POST /stop-for-deployment - Remove boot ownership, then stop Payara
 * - POST /stop-for-deployment/release - Commit a proven owned rollout
 * - POST /stop-for-deployment/recover - Explicit loopback-only fence recovery
 * - POST /undeploy - Undeploy the application
 * - POST /boot-deployment/attest-ready - Attest external readiness for one boot epoch
 * - POST /boot-deployment/stage-artifact - Store a missing WAR without deploying it
 * - POST /boot-deployment/recover - Consume one-shot authority for a stuck boot
 */
export async function registerLifecycleRoutes(
  fastify: FastifyInstance,
  ctx: RouteContext
): Promise<void> {
  const { payara, deployer, logger } = ctx;

  /**
   * POST /restart
   * Restart Payara domain
   */
  fastify.post('/restart', async (request, reply) => {
    try {
      logger.info('Restarting Payara');
      await deployer.withDeploymentLock(
        `route-restart:${deployer.getAppName()}`,
        'start',
        () => payara.restart()
      );
      return {
        status: 'restarted',
        message: 'Payara restarted successfully',
      };
    } catch (err) {
      logger.error({ err }, 'Restart failed');
      return reply.code(operatorErrorStatus(err)).send({
        error: 'Restart failed',
        message: getErrorMessage(err),
      });
    }
  });

  /**
   * POST /start
   * Start Payara domain
   */
  fastify.post('/start', async (request, reply) => {
    try {
      logger.info('Starting Payara');
      await deployer.withDeploymentLock(
        `route-start:${deployer.getAppName()}`,
        'start',
        () => payara.start()
      );
      return {
        status: 'started',
        message: 'Payara started successfully',
      };
    } catch (err) {
      logger.error({ err }, 'Start failed');
      return reply.code(operatorErrorStatus(err)).send({
        error: 'Start failed',
        message: getErrorMessage(err),
      });
    }
  });

  /**
   * POST /stop
   * Stop Payara domain
   */
  fastify.post('/stop', async (request, reply) => {
    try {
      logger.info('Stopping Payara');
      await deployer.withDeploymentLock(
        `route-stop:${deployer.getAppName()}`,
        'stop',
        () => payara.stop()
      );
      return {
        status: 'stopped',
        message: 'Payara stopped successfully',
      };
    } catch (err) {
      logger.error({ err }, 'Stop failed');
      return reply.code(operatorErrorStatus(err)).send({
        error: 'Stop failed',
        message: getErrorMessage(err),
      });
    }
  });

  /**
   * POST /stop-for-deployment
   *
   * Prepare one intentional cold deployment while the domain is still
   * running, then stop it. A plain stop deliberately preserves Payara's
   * persistent application reference so an ordinary restart can restore the
   * application. That historical behaviour is unsafe for a pre-migration
   * outage: the subsequent deploy would start Payara, observe that retained
   * reference, and correctly reject the agent-owned deployment.
   *
   * The shared deployment lock also owns one re-entrant Payara mutation lease,
   * so application-ref removal and lifecycle stop cannot interleave with any
   * other plugin mutation. Before stopping, the agent atomically persists a
   * receipt bound to host/domain/application and the exact previous WAR. An
   * already-stopped domain is accepted only when that receipt still matches;
   * otherwise it fails closed because asadmin cannot reconstruct the missing
   * application-reference evidence while Payara is down.
   */
  fastify.post<{
    Body: { outageOwnerId?: string; targetContentSha256?: string; outageCapability?: string };
  }>('/stop-for-deployment', async (request, reply) => {
    const appName = deployer.getAppName();
    try {
      logger.info({ appName }, 'Preparing Payara for a cold deployment stop');
      const preparedStop = await deployer.stopForDeployment(
        request.body?.outageOwnerId ?? '',
        request.body?.targetContentSha256 ?? '',
        request.body?.outageCapability ?? '',
      );
      return {
        status: 'stopped-for-deployment',
        message: 'Payara application reference removed and domain stopped successfully',
        appName,
        applicationAbsent: true,
        receiptId: preparedStop.receiptId,
        outageOwnerId: preparedStop.outageOwnerId,
        targetContentSha256: preparedStop.targetContentSha256,
        artifact: preparedStop.artifact,
      };
    } catch (err) {
      logger.error({ err, appName }, 'Deployment stop failed');
      return reply.code(operatorErrorStatus(err)).send({
        error: 'Deployment stop failed',
        message: getErrorMessage(err),
        appName,
      });
    }
  });

  /** Persist release intent, then atomically release marker and scheduler latch. */
  fastify.post<{
    Body: { outageOwnerId?: string; targetContentSha256?: string; outageCapability?: string };
  }>('/stop-for-deployment/release', async (request, reply) => {
    try {
      assertLocalOperatorRequest(request);
      const outageOwnerId = request.body?.outageOwnerId ?? '';
      const targetContentSha256 = request.body?.targetContentSha256 ?? '';
      const outageCapability = request.body?.outageCapability ?? '';
      const result = await deployer.prepareOutageRelease(
        outageOwnerId,
        targetContentSha256,
        outageCapability,
      );
      const preparation = await deployer.inspectOutageReleaseState(
        outageOwnerId,
        targetContentSha256,
        outageCapability,
      );
      let schedulerResumeRecovered = false;
      if (preparation.markerAlreadyAbsent) {
        // A prior atomic call may have deleted the marker before its ACK or
        // before directory-sync completion. Retry the exact API transaction
        // first; if it was already fully committed (including across reboot),
        // the strict status readback is the only accepted fallback.
        try {
          await ctx.finalizeSchedulerDeployment(
            outageOwnerId,
            targetContentSha256,
            outageCapability,
          );
        } catch {
          await deployer.inspectOutageReleaseState(
            outageOwnerId,
            targetContentSha256,
            outageCapability,
            true,
          );
          await ctx.getSchedulerDeploymentStatus();
        }
        schedulerResumeRecovered = true;
      } else {
        // znapi validates this owner/target, fsync-removes the marker, and
        // lowers its in-memory latch under one deploymentHoldLock transaction.
        await ctx.finalizeSchedulerDeployment(
          outageOwnerId,
          targetContentSha256,
          outageCapability,
        );
      }
      const committed = await deployer.inspectOutageReleaseState(
        outageOwnerId,
        targetContentSha256,
        outageCapability,
      );
      if (!committed.markerAlreadyAbsent) {
        throw new Error(
          'OUTAGE_FENCE_RELEASE_UNPROVEN: atomic scheduler finalization retained the marker',
        );
      }
      return {
        status: 'outage-release-prepared',
        appName: deployer.getAppName(),
        ...result,
        schedulerResumed: true,
        schedulerResumeRecovered,
      };
    } catch (err) {
      logger.error({ err }, 'Fleet outage fence release rejected');
      return reply.code(operatorErrorStatus(err)).send({
        error: 'Fleet outage fence release rejected',
        message: getErrorMessage(err),
      });
    }
  });

  /** After fleet publication, verify the live target and clear local state. */
  fastify.post<{
    Body: { outageOwnerId?: string; targetContentSha256?: string; outageCapability?: string };
  }>('/stop-for-deployment/finalize', async (request, reply) => {
    try {
      assertLocalOperatorRequest(request);
      const result = await deployer.finalizeOutageFence(
        request.body?.outageOwnerId ?? '',
        request.body?.targetContentSha256 ?? '',
        request.body?.outageCapability ?? '',
      );
      return {
        status: 'outage-fence-finalized',
        appName: deployer.getAppName(),
        ...result,
        schedulerResumed: true,
      };
    } catch (err) {
      logger.error({ err }, 'Fleet outage fence finalization rejected');
      return reply.code(operatorErrorStatus(err)).send({
        error: 'Fleet outage fence finalization rejected',
        message: getErrorMessage(err),
      });
    }
  });

  /** Explicit direct-loopback recovery when automatic success cannot be proven. */
  fastify.post<{
    Body: {
      outageOwnerId?: string;
      targetContentSha256?: string;
      outageCapability?: string;
      reason?: string;
    };
  }>('/stop-for-deployment/recover', async (request, reply) => {
    try {
      assertLocalOperatorRequest(request);
      const result = await deployer.recoverOutageFence(
        request.body?.outageOwnerId ?? '',
        request.body?.targetContentSha256 ?? '',
        request.body?.outageCapability ?? '',
        request.body?.reason ?? '',
        ctx.finalizeSchedulerDeployment,
        ctx.getSchedulerDeploymentStatus,
      );
      return {
        status: 'outage-fence-recovered',
        appName: deployer.getAppName(),
        ...result,
      };
    } catch (err) {
      logger.error({ err }, 'Fleet outage fence recovery rejected');
      return reply.code(operatorErrorStatus(err)).send({
        error: 'Fleet outage fence recovery rejected',
        message: getErrorMessage(err),
      });
    }
  });

  /** Durable recovery state used by the fleet barrier before scheduler I/O. */
  fastify.get('/stop-for-deployment/status', async (request, reply) => {
    try {
      return await deployer.getPreparedStopStatus();
    } catch (err) {
      logger.error({ err }, 'Prepared deployment-stop status failed');
      return reply.code(503).send({
        error: 'Prepared deployment-stop status failed',
        message: getErrorMessage(err),
      });
    }
  });

  /**
   * POST /undeploy
   * Undeploy the application
   */
  fastify.post('/undeploy', async (request, reply) => {
    try {
      logger.info({ appName: deployer.getAppName() }, 'Undeploying application');
      await deployer.undeploy();
      return {
        status: 'undeployed',
        message: 'Application undeployed successfully',
        appName: deployer.getAppName(),
      };
    } catch (err) {
      logger.error({ err }, 'Undeploy failed');
      return reply.code(operatorErrorStatus(err)).send({
        error: 'Undeploy failed',
        message: getErrorMessage(err),
      });
    }
  });

  /**
   * POST /boot-deployment/attest-ready
   * Release a Payara-owned boot fence using explicit, epoch-bound evidence.
   * The kernel socket peer must be direct loopback with no proxy headers.
   */
  fastify.post<{ Body: BootReadinessAttestation }>(
    '/boot-deployment/attest-ready',
    async (request, reply) => {
      try {
        assertLocalOperatorRequest(request);
        const appName = deployer.getAppName();
        const bootDeployment = await deployer.withDeploymentFileLock(
          `readiness-attestation:${appName}`,
          'verify',
          () => payara.attestBootReady(appName, request.body)
        );
        return {
          status: 'attested',
          appName,
          bootDeployment,
        };
      } catch (err) {
        logger.error({ err }, 'Boot readiness attestation rejected');
        const statusCode = operatorErrorStatus(err);
        const bootDeployment = statusCode >= 500
          ? payara.getBootDeploymentStatus(deployer.getAppName())
          : undefined;
        return reply.code(statusCode).send({
          error: 'Boot readiness attestation rejected',
          message: getErrorMessage(err),
          ...(bootDeployment
            ? {
                recoveryRequired: bootDeployment.mutationOutcomeUnknown,
                bootDeployment,
              }
            : {}),
        });
      }
    }
  );

  /**
   * POST /boot-deployment/stage-artifact
   * Store only a missing WAR under the shared file lock. This is the narrow
   * escape from ENOENT while a persistent Payara ref keeps ordinary upload
   * fenced. Recovery remains a separate, hash-bound one-shot operation.
   */
  fastify.post<{ Body: Buffer; Querystring: { bootEpoch?: string } }>(
    '/boot-deployment/stage-artifact',
    async (request, reply) => {
      try {
        assertLocalOperatorRequest(request);
        if (!request.body || request.body.length === 0) {
          const error = new Error(
            'BOOT_RECOVERY_ARTIFACT_INVALID: no WAR bytes were provided'
          );
          error.name = 'BOOT_RECOVERY_ARTIFACT_INVALID';
          throw error;
        }
        const bootEpoch = typeof request.query.bootEpoch === 'string'
          ? request.query.bootEpoch.trim()
          : '';
        if (!bootEpoch) {
          const error = new Error(
            'BOOT_EPOCH_MISMATCH: explicit bootEpoch query parameter is required'
          );
          error.name = 'BOOT_EPOCH_MISMATCH';
          throw error;
        }
        const artifact = await deployer.stageMissingRecoveryArtifact(
          request.body,
          bootEpoch
        );
        return {
          status: 'staged',
          appName: deployer.getAppName(),
          artifact,
          deploymentAttempted: false,
        };
      } catch (err) {
        logger.error({ err }, 'Boot recovery artifact staging rejected');
        return reply.code(operatorErrorStatus(err)).send({
          error: 'Boot recovery artifact staging rejected',
          message: getErrorMessage(err),
        });
      }
    }
  );

  /**
   * POST /boot-deployment/recover
   * Recover only a Payara-owned boot whose persistent ref and exact runtime
   * inventory match the operator authorization. Validation and the complete
   * undeploy/fresh-deploy operation execute under one file lock + mutation lease.
   */
  fastify.post<{ Body: BootRecoveryAuthorization }>(
    '/boot-deployment/recover',
    async (request, reply) => {
      try {
        assertLocalOperatorRequest(request);
        const appName = deployer.getAppName();
        const result = await deployer.recoverBootDeployment(request.body);
        return {
          status: 'recovered',
          appName,
          ...result,
        };
      } catch (err) {
        logger.error({ err }, 'Boot deployment recovery rejected or failed');
        const currentBootDeployment = payara.getBootDeploymentStatus(
          deployer.getAppName()
        );
        const baseStatusCode = operatorErrorStatus(err);
        // The same digest mismatch is a known 409 before WAL arm, but becomes
        // an operationally ambiguous 503 after undeploy/deploy dispatch. State,
        // not the original validation code, is authoritative at this boundary.
        const statusCode = baseStatusCode !== 403
          && currentBootDeployment.mutationOutcomeUnknown
          ? 503
          : baseStatusCode;
        const bootDeployment = statusCode >= 500
          ? currentBootDeployment
          : undefined;
        return reply.code(statusCode).send({
          error: 'Boot deployment recovery rejected or failed',
          message: getErrorMessage(err),
          ...(bootDeployment
            ? {
                recoveryRequired: bootDeployment.mutationOutcomeUnknown,
                bootDeployment,
              }
            : {}),
        });
      }
    }
  );
}
