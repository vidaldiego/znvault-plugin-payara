// Path: src/scheduler-internal-client.ts
// Exact, loopback-only scheduler deployment-finalization client used by the
// Payara outage route. Agent 2.x's generic scheduler proxy discards POST
// bodies, so the plugin must preserve the rollout identity itself.

const DEFAULT_ZNAPI_BASE_URL = 'http://127.0.0.1:8080';
const SCHEDULER_REQUEST_TIMEOUT_MS = 15_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface SchedulerDeploymentFinalizeReceipt {
  quiesced: false;
  inFlightUnits: 0;
  deploymentHold: false;
  outageId: null;
  targetContentSha256: null;
  holdValid: true;
}

export interface SchedulerDeploymentStatusReceipt {
  quiesced: false;
  inFlightUnits: number;
  deploymentHold: false;
  outageId: null;
  targetContentSha256: null;
  holdValid: true;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/u.test(normalized);
}

function parseLoopbackBaseUrl(
  configuredBaseUrl: string | undefined,
  operation: 'FINALIZE' | 'STATUS',
): URL {
  let baseUrl: URL;
  try {
    baseUrl = new URL(configuredBaseUrl ?? DEFAULT_ZNAPI_BASE_URL);
  } catch {
    throw new Error(`SCHEDULER_DEPLOYMENT_${operation}_URL_INVALID`);
  }
  if (
    (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:')
    || !isLoopbackHostname(baseUrl.hostname)
    || baseUrl.username !== ''
    || baseUrl.password !== ''
  ) {
    throw new Error(`SCHEDULER_DEPLOYMENT_${operation}_LOOPBACK_REQUIRED`);
  }
  return baseUrl;
}

/**
 * Atomically remove one durable marker and release its in-memory scheduler
 * latch through znapi's loopback-only endpoint. The API owns both operations
 * under its deployment-hold lock; Payara must never unlink the marker first.
 */
export async function finalizeSchedulerDeployment(
  configuredBaseUrl: string | undefined,
  outageId: string,
  targetContentSha256: string,
  outageCapability: string,
): Promise<SchedulerDeploymentFinalizeReceipt> {
  if (
    !UUID_V4_PATTERN.test(outageId)
    || !SHA256_PATTERN.test(targetContentSha256)
    || !CAPABILITY_PATTERN.test(outageCapability)
    || Buffer.from(outageCapability, 'base64url').toString('base64url') !== outageCapability
  ) {
    throw new Error('SCHEDULER_DEPLOYMENT_FINALIZE_IDENTITY_INVALID');
  }

  const baseUrl = parseLoopbackBaseUrl(configuredBaseUrl, 'FINALIZE');

  const endpoint = new URL('/internal/scheduler/finalize-deployment', baseUrl);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Internal-Origin': 'deploy',
    },
    body: JSON.stringify({
      outageId,
      targetContentSha256,
      capability: outageCapability,
    }),
    signal: AbortSignal.timeout(SCHEDULER_REQUEST_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`SCHEDULER_DEPLOYMENT_FINALIZE_REJECTED: HTTP ${response.status}`);
  }

  const receipt = await response.json() as Partial<SchedulerDeploymentFinalizeReceipt>;
  if (
    receipt.quiesced !== false
    || receipt.inFlightUnits !== 0
    || receipt.deploymentHold !== false
    || receipt.holdValid !== true
    || receipt.outageId !== null
    || receipt.targetContentSha256 !== null
  ) {
    throw new Error('SCHEDULER_DEPLOYMENT_FINALIZE_UNPROVEN');
  }
  return {
    quiesced: false,
    inFlightUnits: 0,
    deploymentHold: false,
    outageId: null,
    targetContentSha256: null,
    holdValid: true,
  };
}

/**
 * Prove the scheduler is already fully released after an agent reboot. This
 * readback is intentionally identity-free: callers may use it only after the
 * exact releasing receipt was validated and its durable hold was already
 * absent before the current finalization attempt.
 */
export async function getSchedulerDeploymentStatus(
  configuredBaseUrl: string | undefined,
): Promise<SchedulerDeploymentStatusReceipt> {
  const baseUrl = parseLoopbackBaseUrl(configuredBaseUrl, 'STATUS');
  const endpoint = new URL('/internal/scheduler/status', baseUrl);
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'X-Internal-Origin': 'deploy',
    },
    signal: AbortSignal.timeout(SCHEDULER_REQUEST_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`SCHEDULER_DEPLOYMENT_STATUS_REJECTED: HTTP ${response.status}`);
  }

  const receipt = await response.json() as Partial<SchedulerDeploymentStatusReceipt>;
  if (
    receipt.quiesced !== false
    || !Number.isInteger(receipt.inFlightUnits)
    || (receipt.inFlightUnits ?? -1) < 0
    || receipt.deploymentHold !== false
    || receipt.holdValid !== true
    || receipt.outageId !== null
    || receipt.targetContentSha256 !== null
  ) {
    throw new Error('SCHEDULER_DEPLOYMENT_STATUS_UNPROVEN');
  }
  return {
    quiesced: false,
    inFlightUnits: receipt.inFlightUnits as number,
    deploymentHold: false,
    outageId: null,
    targetContentSha256: null,
    holdValid: true,
  };
}
