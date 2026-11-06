import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@zincapp/zn-vault-agent/plugins';
import createPayaraPlugin from '../src/index.js';
import { PayaraManager } from '../src/payara-manager.js';
import { WarDeployer } from '../src/war-deployer.js';
import { DeploymentLock } from '../src/deployment-lock.js';
import { MutationQuarantineStore } from '../src/mutation-quarantine.js';

const logger = pino({ level: 'silent' });
const managerPrototype = PayaraManager.prototype as unknown as {
  readExactDasProcessIdentity(): Promise<string | undefined>;
  getPayaraProcessPidsStrict(): Promise<number[]>;
  asadminCommand(args: string[], timeout?: number): Promise<string>;
  waitForStopped(timeout: number): Promise<void>;
};

describe('agent shutdown through the real lock coordinator', () => {
  const roots: string[] = [];
  const originalTokenPath = process.env.ZNVAULT_CONTROL_TOKEN_FILE;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalTokenPath === undefined) delete process.env.ZNVAULT_CONTROL_TOKEN_FILE;
    else process.env.ZNVAULT_CONTROL_TOKEN_FILE = originalTokenPath;
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  async function fixture(beforeAdmission: () => void = () => undefined, unknownMutation = false) {
    const root = await mkdtemp(join(tmpdir(), 'agent-shutdown-wrapper-'));
    roots.push(root);
    const token = join(root, 'control-token');
    await writeFile(token, 'disposable-control-token-for-wrapper-test-only', { mode: 0o600 });
    process.env.ZNVAULT_CONTROL_TOKEN_FILE = token;
    const quarantine = new MutationQuarantineStore(join(root, 'quarantine.json'));
    const originalLock = WarDeployer.prototype.withDeploymentLock;
    vi.spyOn(WarDeployer.prototype, 'withDeploymentLock').mockImplementation(async function (
      this: WarDeployer, label, step, operation,
    ) {
      const internals = this as unknown as {
        fileLock: DeploymentLock;
        payara: { mutationQuarantine: MutationQuarantineStore; mutationQuarantineInstanceId: string };
      };
      // Relocate only host resources; execute the real admission, coordinator,
      // mutation lease and callback. Durable quarantine remains enabled.
      internals.fileLock = new DeploymentLock(logger, join(root, 'deploy.lock'));
      internals.payara.mutationQuarantine = quarantine;
      if (unknownMutation) quarantine.arm({
        instanceId: internals.payara.mutationQuarantineInstanceId,
        domain: 'production', appName: 'TestApp', runtimeIdentity: 'exact-das',
        bootEpoch: 'failed-epoch', operation: 'undeploy', evidenceSource: 'unknown-dispatch',
      });
      beforeAdmission();
      return originalLock.call(this, label, step, operation);
    });
    vi.spyOn(managerPrototype, 'readExactDasProcessIdentity').mockResolvedValue('exact-das');
    vi.spyOn(managerPrototype, 'getPayaraProcessPidsStrict').mockResolvedValue([101]);
    const command = vi.spyOn(managerPrototype, 'asadminCommand')
      .mockImplementation(async args => args[0] === 'uptime' ? '1000' : '');
    const plugin = createPayaraPlugin({
      payaraHome: root, domain: 'production', user: 'payara', warPath: join(root, 'app.war'),
      appName: 'TestApp', mutationAuthTokenFile: token,
    });
    const context = { logger, config: {} } as unknown as PluginContext;
    await plugin.onInit!(context);
    return { plugin, context, command, root };
  }
  it('waits for a draining exact JVM when uptime is unavailable, under real quarantine coordination', async () => {
    const { plugin, context, command } = await fixture();
    vi.spyOn(PayaraManager.prototype, 'isRunningStrict').mockResolvedValue(false);
    command.mockRejectedValue(new Error('admin listener already closed'));
    let enterWait!: () => void;
    let finishExit!: () => void;
    const entered = new Promise<void>(resolve => { enterWait = resolve; });
    const exited = new Promise<void>(resolve => { finishExit = resolve; });
    vi.spyOn(managerPrototype, 'waitForStopped').mockImplementation(async () => {
      enterWait();
      await exited;
    });
    let finished = false;
    const shutdown = plugin.onStop!(context).then(() => { finished = true; });
    try {
      await Promise.race([entered, shutdown]);
      expect(finished).toBe(false);
      expect(command).not.toHaveBeenCalled();
    } finally {
      finishExit();
      await shutdown;
    }
    expect(finished).toBe(true);
  });
  it('retains a durable unknown mutation and sends no shutdown command', async () => {
    const { plugin, context, command, root } = await fixture(() => undefined, true);
    vi.spyOn(PayaraManager.prototype, 'isRunningStrict').mockResolvedValue(false);
    const wait = vi.spyOn(managerPrototype, 'waitForStopped').mockResolvedValue();
    await expect(plugin.onStop!(context)).rejects.toThrow('BOOT_MUTATION_OUTCOME_UNKNOWN');
    expect(command).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(join(root, 'quarantine.json'), 'utf8'));
    expect(persisted.records).toMatchObject([{ appName: 'TestApp', operation: 'undeploy' }]);
  });
  it('passes only the original remaining deadline from admission into dispatch and exit confirmation', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { plugin, context, command } = await fixture(() => { now = 20000; });
    vi.spyOn(PayaraManager.prototype, 'isRunningStrict').mockResolvedValue(true);
    command.mockImplementation(async () => { now = 42000; return 'stopped'; });
    const wait = vi.spyOn(managerPrototype, 'waitForStopped').mockResolvedValue();
    await plugin.onStop!(context);
    expect(command).toHaveBeenCalledWith(['stop-domain', '--timeout=10', 'production'], 15000);
    expect(wait).toHaveBeenCalledWith(3000);
  });
  it('charges admission against the original hook deadline and dispatches nothing after expiry', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { plugin, context, command } = await fixture(() => { now = 46000; });
    vi.spyOn(PayaraManager.prototype, 'isRunningStrict').mockResolvedValue(true);
    vi.spyOn(managerPrototype, 'waitForStopped').mockResolvedValue();
    await expect(plugin.onStop!(context)).rejects.toThrow(/deadline expired/i);
    expect(command).not.toHaveBeenCalled();
  });
});
