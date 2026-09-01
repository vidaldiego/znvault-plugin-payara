#!/usr/bin/env node

import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PACKAGE_NAME = '@zincapp/znvault-plugin-payara';
const REQUIRED_FILES = [
  'package/LICENSE',
  'package/README.md',
  'package/package.json',
  'package/dist/index.js',
  'package/dist/index.d.ts',
  'package/dist/cli.js',
  'package/dist/cli.d.ts',
];

function fail(message) {
  throw new Error(`Release artifact verification failed: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
  return result.stdout;
}

const [tarballArgument, expectedVersion] = process.argv.slice(2);
if (!tarballArgument || !expectedVersion) {
  console.error('Usage: verify-release-tarball.mjs <package.tgz> <expected-version>');
  process.exit(2);
}

const tarballInputStat = lstatSync(tarballArgument);
if (!tarballInputStat.isFile() || tarballInputStat.isSymbolicLink()) {
  fail(`${tarballArgument} is not a regular non-symlink file`);
}
const tarballPath = realpathSync(tarballArgument);

const entries = run('tar', ['-tzf', tarballPath])
  .split('\n')
  .filter(Boolean);
if (entries.length === 0) {
  fail('tarball is empty');
}
if (new Set(entries).size !== entries.length) {
  fail('tarball contains duplicate paths');
}

for (const entry of entries) {
  const segments = entry.split('/');
  if (
    !entry.startsWith('package/')
    || entry.includes('\\')
    || /[\x00-\x1f\x7f]/u.test(entry)
    || segments.includes('')
    || segments.includes('.')
    || segments.includes('..')
  ) {
    fail(`unsafe archive path: ${JSON.stringify(entry)}`);
  }
  if (
    entry !== 'package/package.json'
    && entry !== 'package/README.md'
    && entry !== 'package/LICENSE'
    && !entry.startsWith('package/dist/')
  ) {
    fail(`unexpected package content: ${entry}`);
  }
  if (entry.endsWith('.map')) {
    fail(`production tarball contains a source map: ${entry}`);
  }
  if (
    entry.startsWith('package/dist/')
    && !entry.endsWith('.js')
    && !entry.endsWith('.d.ts')
  ) {
    fail(`unexpected compiled artifact type: ${entry}`);
  }
}

const verboseEntries = run('tar', ['-tvzf', tarballPath])
  .split('\n')
  .filter(Boolean);
if (verboseEntries.length !== entries.length) {
  fail('archive listing changed between content checks');
}
for (const entry of verboseEntries) {
  const archiveType = entry[0];
  if (archiveType !== '-' && archiveType !== 'd') {
    fail(`tarball contains a link or special archive entry: ${entry}`);
  }
}

for (const requiredFile of REQUIRED_FILES) {
  if (!entries.includes(requiredFile)) {
    fail(`required file is missing: ${requiredFile}`);
  }
}

const packedManifestText = run('tar', ['-xOzf', tarballPath, 'package/package.json']);
const packedManifest = JSON.parse(packedManifestText);
if (packedManifest.name !== PACKAGE_NAME) {
  fail(`package name is ${JSON.stringify(packedManifest.name)}, expected ${PACKAGE_NAME}`);
}
if (packedManifest.version !== expectedVersion) {
  fail(`package version is ${JSON.stringify(packedManifest.version)}, expected ${expectedVersion}`);
}
if (
  packedManifest.main !== 'dist/index.js'
  || packedManifest.types !== 'dist/index.d.ts'
  || packedManifest.exports?.['.']?.import !== './dist/index.js'
  || packedManifest.exports?.['./cli']?.import !== './dist/cli.js'
) {
  fail('package entrypoints do not match the verified dist files');
}
if (packedManifest.engines?.node !== '>=22.13.0') {
  fail('package must preserve the Node.js >=22.13.0 runtime floor');
}
if (packedManifest.dependencies?.['@zincapp/znvault-deploy-core'] !== '^0.2.4') {
  fail('package must depend on the authenticated deploy-core ^0.2.4 rail');
}
if (packedManifest.peerDependencies?.['@zincapp/zn-vault-agent'] !== '>=2.0.0 <3') {
  fail('package must require the coordinated Agent >=2.0.0 <3 protocol');
}
if (packedManifest.peerDependenciesMeta?.['@zincapp/zn-vault-agent']?.optional !== true) {
  fail('Agent peer dependency must remain optional for standalone direct API use');
}

const smokeDir = mkdtempSync(join(tmpdir(), 'znvault-plugin-payara-artifact-'));
try {
  writeFileSync(join(smokeDir, 'package.json'), '{"private":true,"type":"module"}\n', { mode: 0o600 });
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--no-save',
    tarballPath,
  ], { cwd: smokeDir, stdio: 'inherit' });

  const installedManifestPath = join(
    smokeDir,
    'node_modules',
    '@zincapp',
    'znvault-plugin-payara',
    'package.json',
  );
  const installedManifest = JSON.parse(readFileSync(installedManifestPath, 'utf8'));
  if (installedManifest.version !== expectedVersion) {
    fail(`installed version is ${JSON.stringify(installedManifest.version)}, expected ${expectedVersion}`);
  }

  const smokeScriptPath = join(smokeDir, 'smoke.mjs');
  writeFileSync(smokeScriptPath, `
    import createPayaraPlugin from '${PACKAGE_NAME}';
    import createPayaraCliPlugin from '${PACKAGE_NAME}/cli';

    if (typeof createPayaraPlugin !== 'function') {
      throw new Error('root import does not expose the plugin factory');
    }
    if (typeof createPayaraCliPlugin !== 'function') {
      throw new Error('CLI import does not expose the CLI plugin factory');
    }
    const cliPlugin = createPayaraCliPlugin();
    if (cliPlugin.name !== 'payara' || cliPlugin.version !== ${JSON.stringify(expectedVersion)}) {
      throw new Error('CLI import returned unexpected release metadata');
    }
  `, { mode: 0o600 });
  run(process.execPath, [smokeScriptPath], { cwd: smokeDir, stdio: 'inherit' });
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

console.log(`Verified exact release artifact ${basename(tarballPath)} (${PACKAGE_NAME}@${expectedVersion})`);
