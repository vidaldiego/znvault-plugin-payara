import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import Fastify from 'fastify';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { PayaraManager } from '../src/payara-manager.js';
import { registerRoutes } from '../src/routes.js';
import { outageCapabilitySha256, WarDeployer } from '../src/war-deployer.js';

const MUTATION_TOKEN = 'fleet-stop-test-token-0123456789abcdef';
const APP_NAME = 'ZincAPI';
const OUTAGE_OWNER = '11111111-1111-4111-8111-111111111111';
const OUTAGE_CAPABILITY = Buffer.alloc(32, 7).toString('base64url');

interface ManagerInternals {
  asadminCommand(args: string[], timeoutMs?: number): Promise<string>;
  checkConfiguredApplicationHealth(timeoutMs?: number): Promise<boolean>;
  getPayaraProcessPidsStrict(timeoutMs?: number): Promise<number[]>;
  minimumBootOwnershipAbsenceGraceMs(): number;
  monotonicNowMs(): number;
  sleep(ms: number): Promise<void>;
  writeSetenvConfInternal(deadlineMs?: number): Promise<void>;
}

/** Render the strict terse inventory shape consumed by PayaraManager itself. */
function applicationInventory(applications: ReadonlySet<string>): string {
  return [
    ...[...applications].map(application => `${application} <web>`),
    'Command list-applications executed successfully.',
  ].join('\n');
}

function referenceInventory(references: ReadonlySet<string>): string {
  return [
    ...references,
    'Command list-application-refs executed successfully.',
  ].join('\n');
}

describe('strict fleet-stop cold deployment ownership', () => {
  it('persists a re-entrant prepared stop across an agent restart so the real cold deploy can claim the next boot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payara-fleet-stop-owner-'));
    const warPath = join(directory, 'ZincAPI.war');
    const receiptPath = join(directory, 'prepared-stop', 'state.json');
    const schedulerHoldPath = join(directory, '.znvault-scheduler-deployment-hold.json');
    const war = new AdmZip();
    war.addFile('WEB-INF/web.xml', Buffer.from('<web-app/>'));
    const previousWar = war.toBuffer();
    await writeFile(warPath, previousWar);

    let running = true;
    let runtimeGeneration = 1;
    let clockMs = 0;
    const references = new Set([APP_NAME]);
    const applications = new Set([APP_NAME]);
    const mutationCommands: string[] = [];
    const logger = pino({ level: 'silent' });
    const manager = new PayaraManager({
      payaraHome: directory,
      domain: 'production',
      user: process.env.USER ?? 'test',
      healthEndpoint: 'http://127.0.0.1/unused-test-health',
      operationTimeout: 30_000,
      runtimeIdentityProvider: async () =>
        running ? `simulated-das-${runtimeGeneration}` : undefined,
      runtimeIdentitySyncProvider: () =>
        running ? `simulated-das-${runtimeGeneration}` : undefined,
      mutationQuarantinePath: false,
      logger,
    });
    const internals = manager as unknown as ManagerInternals;

    // Keep OS and asadmin at the test boundary. The ownership classifier,
    // prepareAggressiveRestart, stop/start, fresh-deploy reconciliation, route,
    // and WarDeployer cold path below are the production implementations.
    vi.spyOn(internals, 'minimumBootOwnershipAbsenceGraceMs').mockReturnValue(0);
    vi.spyOn(internals, 'monotonicNowMs').mockImplementation(() => clockMs);
    vi.spyOn(internals, 'sleep').mockImplementation(async milliseconds => {
      clockMs += milliseconds;
    });
    const setenvWriter = vi.spyOn(internals, 'writeSetenvConfInternal').mockResolvedValue();
    vi.spyOn(internals, 'getPayaraProcessPidsStrict').mockImplementation(
      async () => running ? [4242] : []
    );
    vi.spyOn(internals, 'checkConfiguredApplicationHealth').mockResolvedValue(true);
    vi.spyOn(internals, 'asadminCommand').mockImplementation(async args => {
      const command = args.find(argument => [
        'list-domains',
        'list-application-refs',
        'list-applications',
        'undeploy',
        'stop-domain',
        'start-domain',
        'deploy',
      ].includes(argument));

      switch (command) {
        case 'list-domains':
          return `production ${running ? 'running' : 'not running'}\n`;
        case 'list-application-refs':
          return referenceInventory(references);
        case 'list-applications':
          return applicationInventory(applications);
        case 'undeploy':
          mutationCommands.push('undeploy');
          references.delete(APP_NAME);
          applications.delete(APP_NAME);
          return 'Command undeploy executed successfully.\n';
        case 'stop-domain':
          mutationCommands.push('stop-domain');
          running = false;
          applications.clear();
          return 'Command stop-domain executed successfully.\n';
        case 'start-domain':
          mutationCommands.push('start-domain');
          runtimeGeneration += 1;
          running = true;
          applications.clear();
          for (const reference of references) applications.add(reference);
          return 'Command start-domain executed successfully.\n';
        case 'deploy':
          mutationCommands.push('deploy');
          references.add(APP_NAME);
          applications.add(APP_NAME);
          return 'Command deploy executed successfully.\n';
        default:
          throw new Error(`Unexpected asadmin command: ${args.join(' ')}`);
      }
    });

    const deployer = new WarDeployer({
      warPath,
      appName: APP_NAME,
      domain: 'production',
      hostIdentity: 'api-a.example.test',
      preparedStopReceiptPath: receiptPath,
      schedulerDeploymentHoldPath: schedulerHoldPath,
      payara: manager,
      logger,
      deploymentLockPath: join(directory, 'deployment.lock'),
    });
    const app = Fastify({ logger: false });
    const schedulerFinalize = vi.fn(async () => {
      await rm(schedulerHoldPath);
      return {
        quiesced: false as const,
        inFlightUnits: 0 as const,
        deploymentHold: false as const,
        holdValid: true as const,
        outageId: null,
        targetContentSha256: null,
      };
    });
    const schedulerStatus = vi.fn(async () => ({
      quiesced: false as const,
      inFlightUnits: 0 as const,
      deploymentHold: false as const,
      holdValid: true as const,
      outageId: null,
      targetContentSha256: null,
    }));

    try {
      // Model the stable pre-rollout runtime: Payara owns the persistent app,
      // and its configured health endpoint has already made that ownership
      // safe for an intentional undeploy.
      await expect(manager.classifyBootOwnership(APP_NAME, {
        timeoutMs: 10,
        pollIntervalMs: 1,
        absenceGraceMs: 0,
      })).resolves.toMatchObject({ owner: 'payara', runtimeListed: true });

      await registerRoutes(
        app,
        manager,
        deployer,
        logger,
        MUTATION_TOKEN,
        undefined,
        'test',
        schedulerFinalize,
        schedulerStatus,
      );
      await app.ready();
      const previousArtifact = await deployer.getCurrentArtifactIdentity();
      expect(previousArtifact).not.toBeNull();
      const targetContentSha256 = previousArtifact!.contentSha256;
      const artifactExpectation = {
        expectedBaseSha256: previousArtifact!.sha256,
        targetContentSha256,
      };

      // Fault injection at the first durable boundary: a receipt EIO occurs
      // before either the scheduler hold or Payara ownership is changed.
      const receiptStore = (deployer as unknown as {
        preparedStopStore: {
          arm: (...args: unknown[]) => unknown;
          markReleasing: (...args: unknown[]) => unknown;
        };
      }).preparedStopStore;
      vi.spyOn(receiptStore, 'arm').mockImplementationOnce(() => {
        throw new Error('simulated receipt fsync failure');
      });
      const failedArm = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(failedArm.statusCode).toBe(500);
      expect(mutationCommands).toEqual([]);
      expect(references).toEqual(new Set([APP_NAME]));
      await expect(readFile(schedulerHoldPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      // If marker persistence fails after the receipt commits, the public
      // status must still classify the exact running/base-artifact state as a
      // pending stop. The CLI reads this before retrying POST, so a crash at
      // this boundary must not require aborting the outage first.
      const holdStore = (deployer as unknown as {
        schedulerDeploymentHoldStore: { arm: (...args: unknown[]) => unknown };
      }).schedulerDeploymentHoldStore;
      vi.spyOn(holdStore, 'arm').mockImplementationOnce(() => {
        throw new Error('simulated scheduler marker fsync failure');
      });
      const failedMarker = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(failedMarker.statusCode).toBe(500);
      expect(mutationCommands).toEqual([]);
      expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toEqual(
        expect.objectContaining({ receipts: [expect.objectContaining({ phase: 'arming' })] }),
      );
      await expect(readFile(schedulerHoldPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const receiptOnlyStatus = await app.inject({
        method: 'GET',
        url: '/stop-for-deployment/status',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
      });
      expect(receiptOnlyStatus.statusCode, receiptOnlyStatus.body).toBe(200);
      expect(receiptOnlyStatus.json()).toMatchObject({
        outageFenced: true,
        preparedStopped: false,
        running: true,
        receiptPhase: 'arming',
        outageOwnerId: OUTAGE_OWNER,
        targetContentSha256,
        schedulerDeploymentHold: false,
      });
      expect(schedulerFinalize).not.toHaveBeenCalled();
      expect(schedulerStatus).not.toHaveBeenCalled();

      // The exact owner/capability/target retry republishes the missing hold
      // under the deployment lock before removing the application reference.
      const stop = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });

      expect(stop.statusCode, stop.body).toBe(200);
      expect(stop.json()).toMatchObject({
        status: 'stopped-for-deployment',
        appName: APP_NAME,
        applicationAbsent: true,
        receiptId: expect.any(String),
        outageOwnerId: OUTAGE_OWNER,
        targetContentSha256,
        artifact: {
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      expect(running).toBe(false);
      expect(references).toEqual(new Set());
      expect(applications).toEqual(new Set());
      expect(JSON.parse(await readFile(
        schedulerHoldPath,
        'utf8',
      ))).toEqual({
        version: 2,
        outageId: OUTAGE_OWNER,
        targetContentSha256,
        capabilitySha256: outageCapabilitySha256(OUTAGE_CAPABILITY),
      });
      expect(await readFile(receiptPath, 'utf8')).not.toContain(OUTAGE_CAPABILITY);

      const mutationsAfterFirstStop = [...mutationCommands];
      const otherWar = new AdmZip();
      otherWar.addFile('WEB-INF/web.xml', Buffer.from('<web-app changed="true"/>'));
      await writeFile(warPath, otherWar.toBuffer());
      const stale = await app.inject({
        method: 'GET',
        url: '/stop-for-deployment/status',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
      });
      expect(stale.statusCode).toBe(503);
      expect(stale.json()).toMatchObject({
        message: expect.stringContaining('PREPARED_STOP_RECEIPT_STALE'),
      });
      expect(mutationCommands).toEqual(mutationsAfterFirstStop);
      await writeFile(warPath, previousWar);

      const retry = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({
        status: 'stopped-for-deployment',
        receiptId: stop.json().receiptId,
        outageOwnerId: OUTAGE_OWNER,
        targetContentSha256,
        artifact: stop.json().artifact,
      });
      expect(mutationCommands).toEqual(mutationsAfterFirstStop);

      // An authenticated but unrelated lifecycle or deploy request must not
      // cross the durable outage boundary after the CLI moves on to pre-DDL.
      const restart = await app.inject({
        method: 'POST',
        url: '/restart',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
      });
      expect(restart.statusCode, restart.body).toBe(409);
      expect(restart.json()).toMatchObject({
        message: expect.stringContaining('OUTAGE_FENCE_ACTIVE'),
      });

      const unrelatedDeployment = await app.inject({
        method: 'POST',
        url: '/deploy/full',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          deploymentId: '22222222-2222-4222-8222-222222222222',
          artifact: artifactExpectation,
        },
      });
      expect(unrelatedDeployment.statusCode, unrelatedDeployment.body).toBe(409);
      expect(unrelatedDeployment.json()).toMatchObject({
        message: expect.stringContaining('OUTAGE_FENCE_ACTIVE'),
      });

      const wrongTarget = await app.inject({
        method: 'POST',
        url: '/deploy/full',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          deploymentId: '44444444-4444-4444-8444-444444444444',
          artifact: {
            ...artifactExpectation,
            targetContentSha256: 'd'.repeat(64),
          },
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
        },
      });
      expect(wrongTarget.statusCode, wrongTarget.body).toBe(409);
      expect(wrongTarget.json()).toMatchObject({
        message: expect.stringContaining('OUTAGE_FENCE_TARGET_MISMATCH'),
      });
      expect(running).toBe(false);
      expect(mutationCommands).toEqual(mutationsAfterFirstStop);

      const wrongHostDeployer = new WarDeployer({
        warPath,
        appName: APP_NAME,
        domain: 'production',
        hostIdentity: 'api-b.example.test',
        preparedStopReceiptPath: receiptPath,
        schedulerDeploymentHoldPath: join(directory, 'wrong-host-hold.json'),
        payara: manager,
        logger,
        deploymentLockPath: join(directory, 'wrong-host-deployment.lock'),
      });
      await expect(wrongHostDeployer.getPreparedStopStatus()).resolves.toEqual({
        outageFenced: false,
        preparedStopped: false,
        running: false,
        processCount: 0,
      });

      // A fresh deployer models a restarted agent: the only state carried
      // across the restart is the fsync-backed receipt and the stopped runtime.
      const recoveredDeployer = new WarDeployer({
        warPath,
        appName: APP_NAME,
        domain: 'production',
        hostIdentity: 'api-a.example.test',
        preparedStopReceiptPath: receiptPath,
        schedulerDeploymentHoldPath: schedulerHoldPath,
        payara: manager,
        logger,
        aggressiveMode: true,
        deploymentLockPath: join(directory, 'recovered-deployment.lock'),
      });
      await expect(recoveredDeployer.getPreparedStopStatus()).resolves.toMatchObject({
        preparedStopped: true,
        outageFenced: true,
        running: false,
        processCount: 0,
        receiptId: stop.json().receiptId,
        artifact: stop.json().artifact,
      });

      // The same owner can re-enter after an agent restart and perform only the
      // exact target bound before pre-DDL.
      await expect(recoveredDeployer.applyChangesAuto(
        [],
        [],
        '33333333-3333-4333-8333-333333333333',
        artifactExpectation,
        OUTAGE_OWNER,
        OUTAGE_CAPABILITY,
      )).resolves.toMatchObject({
        deployed: true,
        applications: [APP_NAME],
      });

      expect(mutationCommands).toEqual([
        'undeploy',
        'stop-domain',
        'start-domain',
        'deploy',
      ]);
      expect(references).toEqual(new Set([APP_NAME]));
      expect(applications).toEqual(new Set([APP_NAME]));
      expect(manager.getBootDeploymentStatus(APP_NAME)).toMatchObject({
        phase: 'ready',
        owner: 'agent',
        runtimeListed: true,
      });
      await expect(recoveredDeployer.getPreparedStopStatus()).resolves.toMatchObject({
        outageFenced: true,
        preparedStopped: false,
        receiptPhase: 'deployed',
        outageOwnerId: OUTAGE_OWNER,
        targetContentSha256,
        running: true,
        processCount: 1,
      });

      const publicStatus = await app.inject({
        method: 'GET',
        url: '/stop-for-deployment/status',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
      });
      expect(publicStatus.statusCode).toBe(200);
      expect(publicStatus.json()).not.toHaveProperty('outageCapability');
      expect(publicStatus.json()).not.toHaveProperty('outageCapabilitySha256');

      const leakedOwnerCannotRestop = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: { outageOwnerId: OUTAGE_OWNER, targetContentSha256 },
      });
      expect(leakedOwnerCannotRestop.statusCode).toBe(400);

      const deployedCannotRestop = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(deployedCannotRestop.statusCode, deployedCannotRestop.body).toBe(409);
      expect(running).toBe(true);

      const unrelatedRelease = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/release',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: '55555555-5555-4555-8555-555555555555',
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(unrelatedRelease.statusCode, unrelatedRelease.body).toBe(409);
      await expect(recoveredDeployer.getPreparedStopStatus()).resolves.toMatchObject({
        outageFenced: true,
        outageOwnerId: OUTAGE_OWNER,
        receiptPhase: 'deployed',
      });

      vi.spyOn(receiptStore, 'markReleasing').mockImplementationOnce(() => {
        throw new Error('simulated releasing receipt fsync failure');
      });
      const interruptedRelease = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/release',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(interruptedRelease.statusCode).toBe(500);
      await expect(recoveredDeployer.getPreparedStopStatus()).resolves.toMatchObject({
        outageFenced: true,
        outageOwnerId: OUTAGE_OWNER,
        targetContentSha256,
        receiptPhase: 'deployed',
        schedulerDeploymentHold: true,
      });
      expect(JSON.parse(await readFile(schedulerHoldPath, 'utf8'))).toMatchObject({
        outageId: OUTAGE_OWNER,
        targetContentSha256,
      });
      expect(schedulerFinalize).not.toHaveBeenCalled();
      expect(schedulerStatus).not.toHaveBeenCalled();

      const capabilitylessRetry = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/release',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          targetContentSha256,
        },
      });
      expect(capabilitylessRetry.statusCode).toBe(400);
      expect(schedulerFinalize).not.toHaveBeenCalled();

      // A rejected atomic API operation leaves the marker and newly persisted
      // releasing receipt intact. The scheduler marker is canonical at the
      // Payara domain path, so outage recovery must never rewrite setenv from
      // the restarted agent's empty in-memory secret map.
      const setenvWritesBeforeRelease = setenvWriter.mock.calls.length;
      // The only write is the legitimate cold start. Arming, rollout and
      // release never rewrite setenv merely to publish the canonical marker.
      expect(setenvWritesBeforeRelease).toBe(1);
      schedulerFinalize.mockRejectedValueOnce(new Error('simulated atomic finalize rejection'));
      const rejectedRelease = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/release',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(rejectedRelease.statusCode).toBe(500);
      expect(schedulerFinalize).toHaveBeenCalledWith(
        OUTAGE_OWNER,
        targetContentSha256,
        OUTAGE_CAPABILITY,
      );
      expect(schedulerStatus).not.toHaveBeenCalled();
      expect(setenvWriter).toHaveBeenCalledTimes(setenvWritesBeforeRelease);
      expect(await readFile(schedulerHoldPath, 'utf8')).toContain(OUTAGE_OWNER);
      await expect(recoveredDeployer.getPreparedStopStatus()).resolves.toMatchObject({
        outageFenced: true,
        preparedStopped: false,
        running: true,
        processCount: 1,
        receiptPhase: 'releasing',
        schedulerDeploymentHold: true,
      });

      // Model an atomic API commit whose HTTP acknowledgement is lost. The API
      // removes the marker, but this request still must retain the local receipt
      // and must not fall back within the same attempt.
      schedulerFinalize.mockImplementationOnce(async () => {
        await rm(schedulerHoldPath);
        throw new Error('simulated crash after atomic commit before ACK');
      });
      const lostAckRelease = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/release',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(lostAckRelease.statusCode).toBe(500);
      expect(schedulerFinalize).toHaveBeenCalledTimes(2);
      expect(schedulerStatus).not.toHaveBeenCalled();
      expect(setenvWriter).toHaveBeenCalledTimes(setenvWritesBeforeRelease);
      await expect(readFile(schedulerHoldPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(recoveredDeployer.getPreparedStopStatus()).resolves.toMatchObject({
        outageFenced: true,
        receiptPhase: 'releasing',
        schedulerDeploymentHold: false,
      });

      // A different owner cannot exploit the identity-free recovery path.
      const unrelatedReleaseRetry = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/release',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: '55555555-5555-4555-8555-555555555555',
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(unrelatedReleaseRetry.statusCode, unrelatedReleaseRetry.body).toBe(409);
      expect(schedulerStatus).not.toHaveBeenCalled();

      // Model a restarted API after the unlink: the exact POST can no longer
      // recover its in-memory owner. If the agent cannot fsync the marker's
      // parent directory, it must remain fenced and must not accept the
      // identity-free scheduler status as proof.
      const schedulerHoldStore = (deployer as unknown as {
        schedulerDeploymentHoldStore: { confirmAbsentDurably: () => void };
      }).schedulerDeploymentHoldStore;
      const durableAbsence = vi.spyOn(schedulerHoldStore, 'confirmAbsentDurably')
        .mockImplementationOnce(() => {
          throw new Error('simulated marker directory fsync failure after API restart');
        });
      const uncertainRestartRelease = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/release',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(uncertainRestartRelease.statusCode).toBe(500);
      expect(schedulerFinalize).toHaveBeenCalledTimes(3);
      expect(durableAbsence).toHaveBeenCalledOnce();
      expect(schedulerStatus).not.toHaveBeenCalled();
      await expect(recoveredDeployer.getPreparedStopStatus()).resolves.toMatchObject({
        outageFenced: true,
        receiptPhase: 'releasing',
        schedulerDeploymentHold: false,
      });

      // On a later attempt, exact local receipt validation happens before an
      // exact API retry. The local directory fsync must succeed before an
      // already-completed/rebooted API may use the marker-absent status
      // fallback.
      const recoveredRelease = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/release',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(recoveredRelease.statusCode, recoveredRelease.body).toBe(200);
      expect(recoveredRelease.json()).toMatchObject({
        status: 'outage-release-prepared',
        releasePrepared: true,
        alreadyPrepared: true,
        schedulerResumed: true,
        schedulerResumeRecovered: true,
      });
      expect(schedulerFinalize).toHaveBeenCalledTimes(4);
      expect(schedulerStatus).toHaveBeenCalledOnce();
      expect(durableAbsence).toHaveBeenCalledTimes(2);
      expect(setenvWriter).toHaveBeenCalledTimes(setenvWritesBeforeRelease);
      await expect(recoveredDeployer.getPreparedStopStatus()).resolves.toMatchObject({
        outageFenced: true,
        receiptPhase: 'releasing',
        schedulerDeploymentHold: false,
      });

      const unrelatedFinalize = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/finalize',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: '55555555-5555-4555-8555-555555555555',
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(unrelatedFinalize.statusCode, unrelatedFinalize.body).toBe(409);

      const finalize = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/finalize',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(finalize.statusCode, finalize.body).toBe(200);
      expect(finalize.json()).toMatchObject({
        status: 'outage-fence-finalized',
        finalized: true,
        schedulerResumed: true,
      });
      expect(schedulerFinalize).toHaveBeenCalledTimes(4);
      expect(schedulerStatus).toHaveBeenCalledOnce();
      expect(setenvWriter).toHaveBeenCalledTimes(setenvWritesBeforeRelease);
      await expect(recoveredDeployer.getPreparedStopStatus()).resolves.toMatchObject({
        outageFenced: false,
      });

      // The only non-success cleanup is an explicit, owner-matched loopback
      // recovery with an audit reason. A wrong owner cannot clear it.
      const recoveryOwner = '66666666-6666-4666-8666-666666666666';
      const recoveryStop = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: recoveryOwner,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
        },
      });
      expect(recoveryStop.statusCode, recoveryStop.body).toBe(200);

      const wrongRecovery = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/recover',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: OUTAGE_OWNER,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
          reason: 'Operator investigated the interrupted fleet rollout.',
        },
      });
      expect(wrongRecovery.statusCode, wrongRecovery.body).toBe(409);

      const recovery = await app.inject({
        method: 'POST',
        url: '/stop-for-deployment/recover',
        headers: { authorization: `Bearer ${MUTATION_TOKEN}` },
        payload: {
          outageOwnerId: recoveryOwner,
          outageCapability: OUTAGE_CAPABILITY,
          targetContentSha256,
          reason: 'Operator investigated the interrupted fleet rollout.',
        },
      });
      expect(recovery.statusCode, recovery.body).toBe(200);
      expect(recovery.json()).toMatchObject({
        status: 'outage-fence-recovered',
        recovered: true,
      });
      await expect(recoveredDeployer.getPreparedStopStatus()).resolves.toMatchObject({
        outageFenced: false,
        preparedStopped: false,
        running: false,
        processCount: 0,
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
