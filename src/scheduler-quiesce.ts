// Path: src/scheduler-quiesce.ts
// Scheduler quiesce/poll/resume client for the znvault Payara plugin (Part 5a).
//
// Calls the agent's /scheduler/{quiesce,status,resume} routes, which in turn
// proxy the request to znapi's /internal/scheduler/* endpoint.
//
// Non-fatal contract: when the agent returns { available: false } (old znapi
// without the internal scheduler endpoint), or when the agent itself is
// unreachable / returns a non-2xx, ALL functions here treat that as
// "quiesce UNAVAILABLE — caller should proceed without quiescing".
// They NEVER throw for operational failures; they return a typed result.

import { agentGet, agentPost, resolveEndpoint } from './cli/http-client.js';

// ---------------------------------------------------------------------------
// Default config values
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 2000;
const DEFAULT_DRAIN_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Result types (exported for Task 5 + tests)
// ---------------------------------------------------------------------------

/** Scheduler endpoint is available on this agent/znapi pair. */
export interface QuiesceAvailable {
  available: true;
  /** Number of in-flight units at the moment quiesce was requested. */
  inFlightUnits: number;
}

/** Scheduler endpoint is not available (old znapi) or agent error occurred. */
export interface QuiesceUnavailable {
  available: false;
  /** Human-readable reason string (from agent or synthetic on error). */
  reason?: string;
}

/** Result of quiesceScheduler(). */
export type QuiesceResult = QuiesceAvailable | QuiesceUnavailable;

// ---------------------------------------------------------------------------

/** Scheduler is available and status is known. */
export interface StatusAvailable {
  available: true;
  quiesced: boolean;
  inFlightUnits: number;
}

/** Status endpoint unavailable or errored. */
export interface StatusUnavailable {
  available: false;
  reason?: string;
}

/** Result of schedulerStatus(). */
export type StatusResult = StatusAvailable | StatusUnavailable;

// ---------------------------------------------------------------------------

/** Result of pollUntilDrained(). Never throws. */
export interface PollResult {
  /** inFlightUnits reached 0 within the timeout. */
  drained: boolean;
  /** Timed out before inFlightUnits reached 0. Caller should proceed + warn. */
  timedOut: boolean;
  /** Status became unavailable mid-poll (old znapi). Caller should proceed. */
  available?: false;
}

// ---------------------------------------------------------------------------
// Internal: build the agent base URL (no /plugins/payara suffix — scheduler
// routes live at the agent root, not under the plugin prefix).
// ---------------------------------------------------------------------------

function buildAgentBaseUrl(host: string, port: number, useTLS = false): string {
  // If the host already has a protocol, use it as-is (strip trailing slash).
  // No override is applied to a pre-formed full URL (matches existing behavior).
  if (host.startsWith('http://') || host.startsWith('https://')) {
    return host.replace(/\/$/, '');
  }

  // Apply the SSH-tunnel endpoint override (if any) so quiesce/status/resume go
  // through the same forward the WAR transfer uses via buildPluginUrl. When an
  // override is active the request goes to a local plain-HTTP forward, so force
  // http regardless of useTLS — mirroring buildPluginUrl, which sets
  // useTLS=false when an override applies (the tunnel terminates at the
  // loopback HTTP agent).
  const ep = resolveEndpoint(host, port);
  const overridden = ep.host !== host || ep.port !== port;
  const protocol = !overridden && useTLS ? 'https' : 'http';

  return `${protocol}://${ep.host}:${ep.port}`;
}

// ---------------------------------------------------------------------------
// Internal: raw shapes returned by the agent routes
// ---------------------------------------------------------------------------

interface AgentQuiesceResponse {
  /** Present on success path: always true */
  quiesced?: boolean;
  /** Present on success path */
  inFlightUnits?: number;
  /** Present on "old znapi" path: false */
  available?: boolean;
  /** Present on "old znapi" path */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * POST /scheduler/quiesce on the agent.
 *
 * Returns { available: true, inFlightUnits: N } on success.
 * Returns { available: false, reason } when the agent proxies an old znapi
 * (404 → the agent returns HTTP 200 with { available: false }), or when the
 * agent itself is unreachable / returns non-2xx.
 *
 * @param host  Hostname or IP of the target agent.
 * @param port  Agent HTTP port (e.g. 9100).
 * @param useTLS  If true, use HTTPS. Default: false.
 */
export async function quiesceScheduler(
  host: string,
  port: number,
  useTLS = false,
): Promise<QuiesceResult> {
  const url = `${buildAgentBaseUrl(host, port, useTLS)}/scheduler/quiesce`;
  try {
    const body = await agentPost<AgentQuiesceResponse>(url, {});

    // Agent proxied an old znapi: { available: false, reason: '...' }
    if (body.available === false) {
      return { available: false, reason: body.reason };
    }

    // Success path: { quiesced: true, inFlightUnits: N }
    return {
      available: true,
      inFlightUnits: body.inFlightUnits ?? 0,
    };
  } catch (err) {
    // Agent unreachable, 502, timeout, etc. — non-fatal.
    const reason = err instanceof Error ? err.message : String(err);
    return { available: false, reason };
  }
}

/**
 * GET /scheduler/status on the agent.
 *
 * Returns { available: true, quiesced, inFlightUnits } on success.
 * Returns { available: false, reason } on agent error or old znapi.
 *
 * @param host  Hostname or IP of the target agent.
 * @param port  Agent HTTP port.
 * @param useTLS  If true, use HTTPS.
 */
export async function schedulerStatus(
  host: string,
  port: number,
  useTLS = false,
): Promise<StatusResult> {
  const url = `${buildAgentBaseUrl(host, port, useTLS)}/scheduler/status`;
  try {
    const body = await agentGet<AgentQuiesceResponse>(url);

    if (body.available === false) {
      return { available: false, reason: body.reason };
    }

    return {
      available: true,
      quiesced: body.quiesced ?? false,
      inFlightUnits: body.inFlightUnits ?? 0,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { available: false, reason };
  }
}

/**
 * POST /scheduler/resume on the agent.
 *
 * Best-effort: swallows ALL errors and never throws. The engine's quiesceTtl
 * auto-resume is the backstop if this call fails.
 *
 * @param host  Hostname or IP of the target agent.
 * @param port  Agent HTTP port.
 * @param useTLS  If true, use HTTPS.
 */
export async function resumeScheduler(
  host: string,
  port: number,
  useTLS = false,
): Promise<void> {
  const url = `${buildAgentBaseUrl(host, port, useTLS)}/scheduler/resume`;
  try {
    await agentPost<AgentQuiesceResponse>(url, {});
  } catch (err) {
    // Intentionally swallowed — auto-resume is the backstop.
    console.warn(`[scheduler-quiesce] resume failed for ${host}:${port} — relying on auto-resume backstop: ${err}`);
  }
}

/**
 * Poll /scheduler/status until inFlightUnits === 0 or timeout.
 *
 * Resolution semantics (NEVER throws):
 *  - { drained: true, timedOut: false }               — inFlightUnits reached 0
 *  - { drained: false, timedOut: true }               — timeout before drain
 *  - { drained: false, timedOut: false, available: false } — status became unavailable mid-poll
 *
 * @param host       Hostname or IP of the target agent.
 * @param port       Agent HTTP port.
 * @param opts.pollMs      Interval between polls in ms (default: 2000).
 * @param opts.timeoutMs   Max wall-clock wait in ms (default: 120000).
 * @param useTLS     If true, use HTTPS.
 */
export async function pollUntilDrained(
  host: string,
  port: number,
  opts: { pollMs?: number; timeoutMs?: number },
  useTLS = false,
): Promise<PollResult> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await schedulerStatus(host, port, useTLS);

    if (!status.available) {
      // Agent or znapi unavailable mid-poll — caller proceeds.
      return { drained: false, timedOut: false, available: false };
    }

    if (status.inFlightUnits === 0) {
      return { drained: true, timedOut: false };
    }

    // Still draining — wait and retry.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await new Promise<void>(resolve =>
      setTimeout(resolve, Math.min(pollMs, remaining)),
    );
  }

  return { drained: false, timedOut: true };
}
