import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { PayaraManager } from '../src/payara-manager.js';

interface CommandInternals {
  asadminCommand: (args: string[], timeoutMs?: number) => Promise<string>;
  buildDeployArgs: (
    warPath: string,
    appName: string,
    contextRoot?: string,
    force?: boolean
  ) => string[];
}

const logger = pino({ level: 'silent' });

function installCapturingAsadmin(payaraHome: string): {
  capturePath: string;
  javaHomeCapturePath: string;
} {
  const binDir = join(payaraHome, 'bin');
  mkdirSync(binDir, { recursive: true });
  const capturePath = join(tmpdir(), `znvault-asadmin-argv-${randomUUID()}`);
  const javaHomeCapturePath = join(tmpdir(), `znvault-java-home-${randomUUID()}`);
  const script = [
    '#!/bin/sh',
    'set -eu',
    'printf \'%s\\n\' "$@" > "$ZNVAULT_TEST_ARGV_CAPTURE"',
    'printf \'%s\' "$JAVA_HOME" > "$ZNVAULT_TEST_JAVA_HOME_CAPTURE"',
    'printf \'%s\\n\' "production not running"',
  ].join('\n');
  const asadmin = join(binDir, 'asadmin');
  writeFileSync(asadmin, script, { mode: 0o700 });
  chmodSync(asadmin, 0o700);
  process.env.ZNVAULT_TEST_ARGV_CAPTURE = capturePath;
  process.env.ZNVAULT_TEST_JAVA_HOME_CAPTURE = javaHomeCapturePath;
  return { capturePath, javaHomeCapturePath };
}

function manager(
  payaraHome: string,
  passwordFile?: string,
  environment?: Record<string, string>
): PayaraManager {
  return new PayaraManager({
    payaraHome,
    domain: 'production',
    user: userInfo().username,
    passwordFile,
    environment,
    logger,
    mutationQuarantinePath: false,
  });
}

describe('Payara command argument isolation', () => {
  const roots: string[] = [];
  const captures: string[] = [];
  const originalJavaHome = process.env.JAVA_HOME;

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    for (const capture of captures.splice(0)) {
      rmSync(capture, { force: true });
    }
    delete process.env.ZNVAULT_TEST_ARGV_CAPTURE;
    delete process.env.ZNVAULT_TEST_JAVA_HOME_CAPTURE;
    if (originalJavaHome === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = originalJavaHome;
  });

  it('executes a payaraHome containing shell syntax as one literal executable path', async () => {
    const markerName = `znvault-shell-marker-${randomUUID()}`;
    const markerPath = join(process.cwd(), markerName);
    const root = mkdtempSync(join(tmpdir(), 'znvault-payara-shell-path-'));
    roots.push(root);
    captures.push(markerPath);
    const payaraHome = join(root, `payara $(touch\${IFS}${markerName})`);
    const capture = installCapturingAsadmin(payaraHome);
    captures.push(capture.capturePath, capture.javaHomeCapturePath);
    const configDir = join(
      payaraHome,
      'glassfish',
      'domains',
      'production',
      'config'
    );
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'setenv.conf'),
      "export ZNVAULT_LITERAL='literal;$(touch-must-not-run)'\n",
      { mode: 0o600 }
    );
    const instance = manager(payaraHome, undefined, {
      ZNVAULT_LITERAL: 'literal;$(touch-must-not-run)',
    });

    await expect(
      (instance as unknown as CommandInternals).asadminCommand([
        'start-domain',
        'production',
      ])
    ).resolves.toContain('production not running');

    expect(existsSync(markerPath)).toBe(false);
    expect(readFileSync(capture.capturePath, 'utf8')).toContain('start-domain\n');
  });

  it('keeps passwordFile, WAR path, context root, and JAVA_HOME out of shell parsing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'znvault-payara-shell-args-'));
    roots.push(root);
    const payaraHome = join(root, 'payara home;literal');
    const capture = installCapturingAsadmin(payaraHome);
    captures.push(capture.capturePath, capture.javaHomeCapturePath);
    const marker = join(root, 'injected');
    const passwordFile = `/tmp/admin"; /usr/bin/touch "${marker}"; #`;
    const warPath = `/tmp/app.war; /usr/bin/touch "${marker}"; #`;
    const contextRoot = '/safe;still-literal';
    const javaHome = `/tmp/java"; /usr/bin/touch "${marker}"; #`;
    process.env.JAVA_HOME = javaHome;
    const instance = manager(payaraHome, passwordFile);
    const internals = instance as unknown as CommandInternals;

    const deployArgs = internals.buildDeployArgs(
      warPath,
      'SafeApp',
      contextRoot,
      false
    );
    await internals.asadminCommand(deployArgs);

    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(capture.capturePath, 'utf8').split('\n')).toEqual([
      '--user',
      'admin',
      '--passwordfile',
      passwordFile,
      'deploy',
      '--name=SafeApp',
      `--contextroot=${contextRoot}`,
      warPath,
      '',
    ]);
    expect(readFileSync(capture.javaHomeCapturePath, 'utf8')).toBe(javaHome);
  });

  it.each([
    ['domain', () => new PayaraManager({
      payaraHome: '/tmp/payara',
      domain: 'production;touch-owned',
      user: userInfo().username,
      logger,
      mutationQuarantinePath: false,
    })],
    ['application name', () => manager('/tmp/payara').registerApplication('App$(touch-owned)')],
  ])('rejects shell metacharacters in the Payara %s identifier', (_label, create) => {
    expect(create).toThrow(/must match/u);
  });
});
