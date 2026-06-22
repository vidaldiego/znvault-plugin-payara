// Path: test/scheduler-quiesce.test.ts
// Tests for the scheduler quiesce/poll/resume client (Part 5a)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We mock fetch globally since http-client.ts uses native fetch
// The scheduler-quiesce module uses agentGet/agentPost from http-client.ts
// which ultimately call fetch. We mock fetch to control agent responses.

import {
  quiesceScheduler,
  schedulerStatus,
  resumeScheduler,
  pollUntilDrained,
} from '../src/scheduler-quiesce.js';

// Mock agentGet and agentPost from http-client so we don't need a real agent
vi.mock('../src/cli/http-client.js', () => ({
  agentGet: vi.fn(),
  agentPost: vi.fn(),
  agentPostWithStatus: vi.fn(),
  buildPluginUrl: vi.fn((host: string, port: number) => `http://${host}:${port}/plugins/payara`),
  setEndpointOverride: vi.fn(),
  clearEndpointOverride: vi.fn(),
  clearAllEndpointOverrides: vi.fn(),
  configureTLS: vi.fn(),
  getTLSConfig: vi.fn(() => ({ verify: true })),
}));

import * as httpClient from '../src/cli/http-client.js';

const HOST = '172.16.220.10';
const PORT = 9100;

describe('quiesceScheduler', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('returns available:true + inFlightUnits on success', async () => {
    vi.mocked(httpClient.agentPost).mockResolvedValue({
      quiesced: true,
      inFlightUnits: 3,
    });

    const result = await quiesceScheduler(HOST, PORT);

    expect(result).toEqual({ available: true, inFlightUnits: 3 });
  });

  it('returns available:false when agent reports available:false (old znapi)', async () => {
    vi.mocked(httpClient.agentPost).mockResolvedValue({
      available: false,
      reason: 'znapi-internal-scheduler-not-found',
    });

    const result = await quiesceScheduler(HOST, PORT);

    expect(result.available).toBe(false);
    expect(() => { /* no throw */ }).not.toThrow();
  });

  it('returns available:false on agent 502 / network error (no throw)', async () => {
    vi.mocked(httpClient.agentPost).mockRejectedValue(new Error('Agent request failed: 502'));

    const result = await quiesceScheduler(HOST, PORT);

    expect(result.available).toBe(false);
    // Must not throw — the test itself reaching this line proves it
  });

  it('returns available:false on connection refused (no throw)', async () => {
    vi.mocked(httpClient.agentPost).mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const result = await quiesceScheduler(HOST, PORT);

    expect(result.available).toBe(false);
  });
});

describe('schedulerStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns available:true with quiesced + inFlightUnits on success', async () => {
    vi.mocked(httpClient.agentGet).mockResolvedValue({
      quiesced: true,
      inFlightUnits: 5,
    });

    const result = await schedulerStatus(HOST, PORT);

    expect(result).toEqual({ available: true, quiesced: true, inFlightUnits: 5 });
  });

  it('returns available:false when agent reports available:false', async () => {
    vi.mocked(httpClient.agentGet).mockResolvedValue({
      available: false,
      reason: 'znapi-internal-scheduler-not-found',
    });

    const result = await schedulerStatus(HOST, PORT);

    expect(result.available).toBe(false);
  });

  it('returns available:false on network error (no throw)', async () => {
    vi.mocked(httpClient.agentGet).mockRejectedValue(new Error('timeout'));

    const result = await schedulerStatus(HOST, PORT);

    expect(result.available).toBe(false);
  });
});

describe('resumeScheduler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('completes without throwing on success', async () => {
    vi.mocked(httpClient.agentPost).mockResolvedValue({ quiesced: false });

    await expect(resumeScheduler(HOST, PORT)).resolves.toBeUndefined();
  });

  it('swallows agent errors (no throw)', async () => {
    vi.mocked(httpClient.agentPost).mockRejectedValue(new Error('Agent request failed: 503'));

    await expect(resumeScheduler(HOST, PORT)).resolves.toBeUndefined();
  });

  it('swallows available:false from agent (no throw)', async () => {
    vi.mocked(httpClient.agentPost).mockResolvedValue({
      available: false,
      reason: 'znapi-internal-scheduler-not-found',
    });

    await expect(resumeScheduler(HOST, PORT)).resolves.toBeUndefined();
  });
});

describe('pollUntilDrained', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves drained:true when inFlightUnits reaches 0', async () => {
    let callCount = 0;
    vi.mocked(httpClient.agentGet).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { quiesced: true, inFlightUnits: 3 };
      if (callCount === 2) return { quiesced: true, inFlightUnits: 2 };
      return { quiesced: true, inFlightUnits: 0 };
    });

    const result = await pollUntilDrained(HOST, PORT, { pollMs: 1, timeoutMs: 5000 });

    expect(result).toEqual({ drained: true, timedOut: false });
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('resolves timedOut:true when inFlightUnits never reaches 0 (no throw)', async () => {
    vi.mocked(httpClient.agentGet).mockResolvedValue({ quiesced: true, inFlightUnits: 99 });

    // Use a tiny timeout so the test is fast
    const result = await pollUntilDrained(HOST, PORT, { pollMs: 1, timeoutMs: 20 });

    // Must NOT throw — the test reaching this point proves it
    expect(result.timedOut).toBe(true);
    expect(result.drained).toBe(false);
  });

  it('resolves unavailable:true (no throw) when agent reports unavailable mid-poll', async () => {
    vi.mocked(httpClient.agentGet).mockResolvedValue({
      available: false,
      reason: 'znapi-internal-scheduler-not-found',
    });

    const result = await pollUntilDrained(HOST, PORT, { pollMs: 1, timeoutMs: 5000 });

    expect(result.available).toBe(false);
    expect(result.drained).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('uses default pollMs/timeoutMs when not provided', async () => {
    // Should not throw even with missing options
    vi.mocked(httpClient.agentGet).mockResolvedValue({ quiesced: true, inFlightUnits: 0 });

    const result = await pollUntilDrained(HOST, PORT, {});

    expect(result.drained).toBe(true);
  });
});
