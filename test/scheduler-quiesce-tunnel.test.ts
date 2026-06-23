// Path: test/scheduler-quiesce-tunnel.test.ts
// Tests that the scheduler quiesce/status/resume client honors the SSH-tunnel
// endpoint override — so on a tunneled deploy the calls reach the forwarded
// loopback endpoint (like the WAR transfer does via buildPluginUrl), not the
// raw, loopback-only-bound host IP.
//
// Unlike scheduler-quiesce.test.ts (which fully mocks http-client to test the
// result-handling contract), this file uses the REAL http-client — real
// setEndpointOverride + the real resolveEndpoint used by buildAgentBaseUrl —
// and mocks global fetch so we can assert the exact URL the client builds.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { quiesceScheduler, schedulerStatus, resumeScheduler } from '../src/scheduler-quiesce.js';
import { setEndpointOverride, clearAllEndpointOverrides } from '../src/cli/http-client.js';

const REAL_HOST = '172.16.220.58'; // a loopback-only-bound production worker
const AGENT_PORT = 9100;
const LOCAL_PORT = 54321; // the SSH forward's local port

/** Capture the URL passed to fetch and return a canned 200 JSON response. */
function mockFetch(jsonBody: unknown): { calledUrls: string[] } {
  const calledUrls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    calledUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody),
    } as Response;
  }));
  return { calledUrls };
}

beforeEach(() => {
  clearAllEndpointOverrides();
});

afterEach(() => {
  clearAllEndpointOverrides();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('scheduler client honors the SSH-tunnel endpoint override', () => {
  // -------------------------------------------------------------------------
  // REGRESSION (the bug): with an override set, quiesce must hit the forward.
  // -------------------------------------------------------------------------
  it('quiesceScheduler — override set → fetches the forwarded loopback URL, NOT the raw IP', async () => {
    setEndpointOverride(REAL_HOST, '127.0.0.1', LOCAL_PORT);
    const { calledUrls } = mockFetch({ quiesced: true, inFlightUnits: 0 });

    const result = await quiesceScheduler(REAL_HOST, AGENT_PORT);

    expect(result).toEqual({ available: true, inFlightUnits: 0 });
    expect(calledUrls).toHaveLength(1);
    expect(calledUrls[0]).toBe(`http://127.0.0.1:${LOCAL_PORT}/scheduler/quiesce`);
    expect(calledUrls[0]).not.toContain(REAL_HOST);
  });

  it('schedulerStatus — override set → fetches the forwarded loopback URL', async () => {
    setEndpointOverride(REAL_HOST, '127.0.0.1', LOCAL_PORT);
    const { calledUrls } = mockFetch({ quiesced: false, inFlightUnits: 3 });

    const result = await schedulerStatus(REAL_HOST, AGENT_PORT);

    expect(result).toEqual({ available: true, quiesced: false, inFlightUnits: 3 });
    expect(calledUrls[0]).toBe(`http://127.0.0.1:${LOCAL_PORT}/scheduler/status`);
  });

  it('resumeScheduler — override set → fetches the forwarded loopback URL', async () => {
    setEndpointOverride(REAL_HOST, '127.0.0.1', LOCAL_PORT);
    const { calledUrls } = mockFetch({ quiesced: false });

    await resumeScheduler(REAL_HOST, AGENT_PORT);

    expect(calledUrls[0]).toBe(`http://127.0.0.1:${LOCAL_PORT}/scheduler/resume`);
  });

  // -------------------------------------------------------------------------
  // useTLS forced to http under an override (tunnel is local-plain) —
  // mirrors buildPluginUrl, which sets useTLS=false when an override applies.
  // -------------------------------------------------------------------------
  it('quiesceScheduler — override set + useTLS=true → still http to the forward', async () => {
    setEndpointOverride(REAL_HOST, '127.0.0.1', LOCAL_PORT);
    const { calledUrls } = mockFetch({ quiesced: true, inFlightUnits: 0 });

    await quiesceScheduler(REAL_HOST, AGENT_PORT, /* useTLS */ true);

    expect(calledUrls[0]).toBe(`http://127.0.0.1:${LOCAL_PORT}/scheduler/quiesce`);
    expect(calledUrls[0]).not.toContain('https://');
  });

  // -------------------------------------------------------------------------
  // No override (non-tunneled) — today's behavior: raw host:port.
  // -------------------------------------------------------------------------
  it('quiesceScheduler — no override → fetches the raw host:port (unchanged)', async () => {
    const { calledUrls } = mockFetch({ quiesced: true, inFlightUnits: 0 });

    await quiesceScheduler(REAL_HOST, AGENT_PORT);

    expect(calledUrls[0]).toBe(`http://${REAL_HOST}:${AGENT_PORT}/scheduler/quiesce`);
  });

  it('quiesceScheduler — no override + useTLS=true → https raw host:port', async () => {
    const { calledUrls } = mockFetch({ quiesced: true, inFlightUnits: 0 });

    await quiesceScheduler(REAL_HOST, AGENT_PORT, /* useTLS */ true);

    expect(calledUrls[0]).toBe(`https://${REAL_HOST}:${AGENT_PORT}/scheduler/quiesce`);
  });

  // -------------------------------------------------------------------------
  // Full-URL host passthrough — unchanged existing branch.
  // -------------------------------------------------------------------------
  it('quiesceScheduler — host is already a full URL → used as-is (no override applied)', async () => {
    const { calledUrls } = mockFetch({ quiesced: true, inFlightUnits: 0 });

    await quiesceScheduler('http://example.test:1', AGENT_PORT);

    expect(calledUrls[0]).toBe('http://example.test:1/scheduler/quiesce');
  });
});
