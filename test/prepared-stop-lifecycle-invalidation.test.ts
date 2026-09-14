import Fastify from 'fastify';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { registerLifecycleRoutes } from '../src/routes/lifecycle.js';
import type { RouteContext } from '../src/routes/types.js';

describe('durable outage fence on ordinary lifecycle routes', () => {
  it.each([
    ['start', 'start'],
    ['stop', 'stop'],
  ] as const)('preserves the historical /%s lifecycle mutation when no fence exists', async (route, method) => {
    const events: string[] = [];
    const app = Fastify({ logger: false });
    const payara = {
      [method]: vi.fn(async () => { events.push(method); }),
    };
    const deployer = {
      getAppName: () => 'ZincAPI',
      withDeploymentLock: vi.fn(async (
        _label: string,
        _step: string,
        operation: () => Promise<unknown>,
      ) => operation()),
    };

    try {
      await registerLifecycleRoutes(app, {
        payara,
        deployer,
        sessionStore: {},
        logger: pino({ level: 'silent' }),
        pluginVersion: 'test',
      } as unknown as RouteContext);
      await app.ready();

      const response = await app.inject({ method: 'POST', url: `/${route}` });

      expect(response.statusCode, response.body).toBe(200);
      expect(events).toEqual([method]);
    } finally {
      await app.close();
    }
  });

  it.each(['restart', 'start', 'stop'] as const)(
    'returns 409 and does not execute /%s while another rollout owns the outage',
    async route => {
      const app = Fastify({ logger: false });
      const payara = {
        restart: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      const fenceError = new Error(
        'OUTAGE_FENCE_ACTIVE: Payara mutations are reserved by an active full-fleet rollout',
      );
      fenceError.name = 'OUTAGE_FENCE_ACTIVE';
      const deployer = {
        getAppName: () => 'ZincAPI',
        withDeploymentLock: vi.fn(async () => {
          throw fenceError;
        }),
      };

      try {
        await registerLifecycleRoutes(app, {
          payara,
          deployer,
          sessionStore: {},
          logger: pino({ level: 'silent' }),
          pluginVersion: 'test',
        } as unknown as RouteContext);
        await app.ready();

        const response = await app.inject({ method: 'POST', url: `/${route}` });

        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toMatchObject({
          message: expect.stringContaining('OUTAGE_FENCE_ACTIVE'),
        });
        expect(payara.restart).not.toHaveBeenCalled();
        expect(payara.start).not.toHaveBeenCalled();
        expect(payara.stop).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});
