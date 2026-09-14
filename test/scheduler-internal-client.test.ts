import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  finalizeSchedulerDeployment,
  getSchedulerDeploymentStatus,
} from '../src/scheduler-internal-client.js';

const OUTAGE_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_CONTENT_SHA256 = 'a'.repeat(64);
const OUTAGE_CAPABILITY = Buffer.alloc(32, 7).toString('base64url');

describe('exact scheduler deployment finalization client', () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  it('sends the exact identity to the atomic znapi endpoint and requires its final receipt', async () => {
    const requests: Array<{
      method?: string;
      url?: string;
      origin?: string;
      body: unknown;
    }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        requests.push({
          method: request.method,
          url: request.url,
          origin: request.headers['x-internal-origin'] as string | undefined,
          body: JSON.parse(body) as unknown,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          quiesced: false,
          inFlightUnits: 0,
          deploymentHold: false,
          holdValid: true,
          outageId: null,
          targetContentSha256: null,
        }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    closeServer = () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');

    await expect(finalizeSchedulerDeployment(
      `http://127.0.0.1:${address.port}`,
      OUTAGE_ID,
      TARGET_CONTENT_SHA256,
      OUTAGE_CAPABILITY,
    )).resolves.toEqual({
      quiesced: false,
      inFlightUnits: 0,
      deploymentHold: false,
      holdValid: true,
      outageId: null,
      targetContentSha256: null,
    });
    expect(requests).toEqual([{
      method: 'POST',
      url: '/internal/scheduler/finalize-deployment',
      origin: 'deploy',
      body: {
        outageId: OUTAGE_ID,
        targetContentSha256: TARGET_CONTENT_SHA256,
        capability: OUTAGE_CAPABILITY,
      },
    }]);
  });

  it('uses an identity-free GET only to prove an already-finalized reboot state', async () => {
    const requests: Array<{ method?: string; url?: string; origin?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        origin: request.headers['x-internal-origin'] as string | undefined,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        quiesced: false,
        inFlightUnits: 0,
        deploymentHold: false,
        holdValid: true,
        outageId: null,
        targetContentSha256: null,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    closeServer = () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');

    await expect(getSchedulerDeploymentStatus(
      `http://127.0.0.1:${address.port}`,
    )).resolves.toMatchObject({
      quiesced: false,
      deploymentHold: false,
      holdValid: true,
      outageId: null,
      targetContentSha256: null,
    });
    expect(requests).toEqual([{
      method: 'GET',
      url: '/internal/scheduler/status',
      origin: 'deploy',
    }]);
  });

  it('accepts work that legitimately entered after the atomic release commit', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        quiesced: false,
        inFlightUnits: 3,
        deploymentHold: false,
        holdValid: true,
        outageId: null,
        targetContentSha256: null,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    closeServer = () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');

    await expect(getSchedulerDeploymentStatus(
      `http://127.0.0.1:${address.port}`,
    )).resolves.toEqual({
      quiesced: false,
      inFlightUnits: 3,
      deploymentHold: false,
      holdValid: true,
      outageId: null,
      targetContentSha256: null,
    });
  });

  it('rejects a status readback that retains any deployment owner', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        quiesced: false,
        inFlightUnits: 0,
        deploymentHold: false,
        holdValid: true,
        outageId: OUTAGE_ID,
        targetContentSha256: TARGET_CONTENT_SHA256,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    closeServer = () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');

    await expect(getSchedulerDeploymentStatus(
      `http://127.0.0.1:${address.port}`,
    )).rejects.toThrow('SCHEDULER_DEPLOYMENT_STATUS_UNPROVEN');
  });

  it('rejects a non-loopback target before sending rollout identity', async () => {
    await expect(finalizeSchedulerDeployment(
      'https://znapi.example.test',
      OUTAGE_ID,
      TARGET_CONTENT_SHA256,
      OUTAGE_CAPABILITY,
    )).rejects.toThrow('SCHEDULER_DEPLOYMENT_FINALIZE_LOOPBACK_REQUIRED');
  });

  it('rejects a missing or malformed outage capability before any request', async () => {
    await expect(finalizeSchedulerDeployment(
      'http://127.0.0.1:1',
      OUTAGE_ID,
      TARGET_CONTENT_SHA256,
      '',
    )).rejects.toThrow('SCHEDULER_DEPLOYMENT_FINALIZE_IDENTITY_INVALID');
  });
});
