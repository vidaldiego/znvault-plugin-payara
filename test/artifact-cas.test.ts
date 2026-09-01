import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pino from 'pino';
import {
  WarDeployer,
  calculateWarContentSha256,
  readLocalWarArtifactSnapshot,
} from '../src/war-deployer.js';
import { PayaraManager } from '../src/payara-manager.js';
import { createMockPayara, type MockPayara } from './helpers/mock-payara.js';
import {
  cleanupTempDir,
  createTempDir,
  createTestWar,
} from './helpers/war-utils.js';

describe('artifact identity CAS', () => {
  let tempDir: string;
  let mockPayara: MockPayara;

  beforeEach(async () => {
    tempDir = createTempDir('artifact-cas');
    mockPayara = await createMockPayara({ baseDir: `${tempDir}/payara` });
    mockPayara.simulateStop();
  });

  afterEach(async () => {
    await mockPayara.cleanup();
    cleanupTempDir(tempDir);
  });

  function createDeployer(warPath: string): WarDeployer {
    const logger = pino({ level: 'silent' });
    const payara = new PayaraManager({
      payaraHome: mockPayara.payaraHome,
      domain: mockPayara.domain,
      user: process.env.USER || 'test',
      logger,
      runtimeIdentityProvider: async () => undefined,
      mutationQuarantinePath: `${tempDir}/mutation-quarantine/state.json`,
    });
    vi.spyOn(
      payara as unknown as { getPayaraProcessPidsStrict: () => Promise<number[]> },
      'getPayaraProcessPidsStrict'
    ).mockResolvedValue([]);
    return new WarDeployer({
      warPath,
      appName: 'TestApp',
      payara,
      logger,
      deploymentLockPath: `${tempDir}/deploy.lock`,
    });
  }

  function emptyEntryWar(entryNames: string[]): Buffer {
    const localRecords: Buffer[] = [];
    const centralRecords: Buffer[] = [];
    let localOffset = 0;

    for (const entryName of entryNames) {
      const name = Buffer.from(entryName, 'utf8');
      const local = Buffer.alloc(30 + name.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(name.length, 26);
      name.copy(local, 30);
      localRecords.push(local);

      const central = Buffer.alloc(46 + name.length);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(localOffset, 42);
      name.copy(central, 46);
      centralRecords.push(central);
      localOffset += local.length;
    }

    const centralDirectory = Buffer.concat(centralRecords);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entryNames.length, 8);
    end.writeUInt16LE(entryNames.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(localOffset, 16);
    return Buffer.concat([...localRecords, centralDirectory, end]);
  }

  function duplicateEmptyEntryWar(entryName: string): Buffer {
    return emptyEntryWar([entryName, entryName]);
  }

  it('rejects a stale second controller under the lock without changing the WAR', async () => {
    const warPath = createTestWar({
      path: `${tempDir}/app.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'v1' }],
    });
    const deployer = createDeployer(warPath);
    const base = await deployer.getCurrentArtifactReadback();
    expect(base).not.toBeNull();

    const v2Hash = createHash('sha256').update('v2').digest('hex');
    const v2Target = calculateWarContentSha256({
      ...base!.hashes,
      'version.txt': v2Hash,
    });
    await deployer.applyChangesWithoutDeploy(
      [{ path: 'version.txt', content: Buffer.from('v2') }],
      [],
      {
        expectedBaseSha256: base!.sha256,
        targetContentSha256: v2Target,
      }
    );
    const afterFirst = await deployer.getCurrentArtifactIdentity();
    expect(afterFirst?.contentSha256).toBe(v2Target);

    const v3Hash = createHash('sha256').update('v3').digest('hex');
    const v3Target = calculateWarContentSha256({
      ...base!.hashes,
      'version.txt': v3Hash,
    });
    await expect(deployer.applyChangesWithoutDeploy(
      [{ path: 'version.txt', content: Buffer.from('v3') }],
      [],
      {
        expectedBaseSha256: base!.sha256,
        targetContentSha256: v3Target,
      }
    )).rejects.toThrow('ARTIFACT_BASE_DRIFT');

    expect(await deployer.getCurrentArtifactIdentity()).toEqual(afterFirst);
  });

  it('rejects an expected-absent base when another controller created the WAR', async () => {
    const warPath = createTestWar({
      path: `${tempDir}/app.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'created-by-other-controller' }],
    });
    const deployer = createDeployer(warPath);
    const before = await deployer.getCurrentArtifactIdentity();
    const targetHash = createHash('sha256').update('ours').digest('hex');

    await expect(deployer.applyChangesWithoutDeploy(
      [{ path: 'version.txt', content: Buffer.from('ours') }],
      [],
      {
        expectedBaseSha256: null,
        targetContentSha256: calculateWarContentSha256({
          'version.txt': targetHash,
        }),
      }
    )).rejects.toThrow('ARTIFACT_BASE_DRIFT');

    expect(await deployer.getCurrentArtifactIdentity()).toEqual(before);
  });

  it('rejects a wrong target identity before replacing the WAR', async () => {
    const warPath = createTestWar({
      path: `${tempDir}/app.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'v1' }],
    });
    const deployer = createDeployer(warPath);
    const before = await deployer.getCurrentArtifactIdentity();

    await expect(deployer.applyChangesWithoutDeploy(
      [{ path: 'version.txt', content: Buffer.from('v2') }],
      [],
      {
        expectedBaseSha256: before!.sha256,
        targetContentSha256: 'f'.repeat(64),
      }
    )).rejects.toThrow('ARTIFACT_TARGET_MISMATCH');

    expect(await deployer.getCurrentArtifactIdentity()).toEqual(before);
  });

  it('rejects ambiguous duplicate ZIP names in local snapshots and binary uploads', async () => {
    const duplicateWar = duplicateEmptyEntryWar('duplicate.txt');
    const duplicatePath = `${tempDir}/duplicate.war`;
    await writeFile(duplicatePath, duplicateWar);
    await expect(readLocalWarArtifactSnapshot(duplicatePath)).rejects.toThrow(
      'WAR_ENTRY_DUPLICATE'
    );

    const warPath = createTestWar({
      path: `${tempDir}/app.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'v1' }],
    });
    const deployer = createDeployer(warPath);
    const payara = (deployer as unknown as { payara: PayaraManager }).payara;
    vi.spyOn(payara, 'assertArtifactMutationAllowed').mockResolvedValue('test-epoch');
    vi.spyOn(payara, 'assertArtifactMutationEpochCurrent').mockResolvedValue(undefined);
    const before = await deployer.getCurrentArtifactIdentity();
    const emptyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

    await expect(deployer.deployUploadedWar(
      duplicateWar,
      'artifact-upload-duplicate-0001',
      {
        expectedBaseSha256: before!.sha256,
        targetContentSha256: calculateWarContentSha256({
          'duplicate.txt': emptyHash,
        }),
      }
    )).rejects.toThrow('WAR_ENTRY_DUPLICATE');

    expect(await deployer.getCurrentArtifactIdentity()).toEqual(before);
  });

  it('rejects file/directory logical-name collisions in snapshots and uploads', async () => {
    const collidingWar = emptyEntryWar(['foo', 'foo/']);
    const collidingPath = `${tempDir}/file-directory-collision.war`;
    await writeFile(collidingPath, collidingWar);
    await expect(readLocalWarArtifactSnapshot(collidingPath)).rejects.toThrow(
      'WAR_ENTRY_DUPLICATE'
    );

    const warPath = createTestWar({
      path: `${tempDir}/app.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'v1' }],
    });
    const deployer = createDeployer(warPath);
    const payara = (deployer as unknown as { payara: PayaraManager }).payara;
    vi.spyOn(payara, 'assertArtifactMutationAllowed').mockResolvedValue('test-epoch');
    const before = await deployer.getCurrentArtifactIdentity();

    await expect(deployer.deployUploadedWar(
      collidingWar,
      'artifact-upload-collision-0001',
      {
        expectedBaseSha256: before!.sha256,
        targetContentSha256: calculateWarContentSha256({
          foo: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
        }),
      }
    )).rejects.toThrow('WAR_ENTRY_DUPLICATE');

    expect(await deployer.getCurrentArtifactIdentity()).toEqual(before);
  });

  it.each([
    ['duplicate entry', duplicateEmptyEntryWar('duplicate.txt'), 'WAR_ENTRY_DUPLICATE'],
    ['unsafe path', emptyEntryWar(['../escape.txt']), 'WAR_ENTRY_PATH_INVALID'],
  ])('rejects an invalid recovery WAR before lock or lifecycle: %s', async (
    _label,
    invalidWar,
    expectedCode
  ) => {
    const warPath = `${tempDir}/missing-recovery.war`;
    const deployer = createDeployer(warPath);
    const payara = (deployer as unknown as { payara: PayaraManager }).payara;
    const authorization = vi.spyOn(
      payara,
      'assertMissingRecoveryArtifactStageAllowed'
    );

    await expect(deployer.stageMissingRecoveryArtifact(
      invalidWar,
      'boot-epoch-invalid-artifact'
    )).rejects.toThrow(expectedCode);

    expect(authorization).not.toHaveBeenCalled();
    expect(await deployer.warExists()).toBe(false);
  });

  it('rechecks the exact base without yielding immediately before rename', async () => {
    const warPath = createTestWar({
      path: `${tempDir}/app.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'v1' }],
    });
    const deployer = createDeployer(warPath);
    const payara = (deployer as unknown as { payara: PayaraManager }).payara;
    const before = await deployer.getCurrentArtifactReadback();
    const v2Hash = createHash('sha256').update('v2').digest('hex');
    vi.spyOn(payara, 'assertArtifactMutationAllowed').mockResolvedValue('test-epoch');
    vi.spyOn(payara, 'assertArtifactMutationEpochCurrent').mockImplementation(async () => {
      createTestWar({
        path: warPath,
        appName: 'TestApp',
        files: [{ path: 'version.txt', content: 'external-writer' }],
      });
    });

    await expect(deployer.applyChangesWithoutDeploy(
      [{ path: 'version.txt', content: Buffer.from('v2') }],
      [],
      {
        expectedBaseSha256: before!.sha256,
        targetContentSha256: calculateWarContentSha256({
          ...before!.hashes,
          'version.txt': v2Hash,
        }),
      }
    )).rejects.toThrow('ARTIFACT_BASE_DRIFT');

    const after = await deployer.getCurrentArtifactReadback();
    expect(after?.sha256).not.toBe(before?.sha256);
    expect(after?.hashes['version.txt']).toBe(
      createHash('sha256').update('external-writer').digest('hex')
    );
  });

  it('rejects stale full redeploy identity before any lifecycle mutation', async () => {
    const warPath = createTestWar({
      path: `${tempDir}/app.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'v1' }],
    });
    const deployer = createDeployer(warPath);
    const before = await deployer.getCurrentArtifactIdentity();

    await expect(deployer.deployAuto(
      'artifact-full-stale-0001',
      {
        expectedBaseSha256: 'd'.repeat(64),
        targetContentSha256: before!.contentSha256,
      }
    )).rejects.toThrow('ARTIFACT_BASE_DRIFT');

    expect(await deployer.getCurrentArtifactIdentity()).toEqual(before);
  });

  it('rejects a stale binary-upload base without overwriting the current WAR', async () => {
    const warPath = createTestWar({
      path: `${tempDir}/app.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'v1' }],
    });
    const uploadPath = createTestWar({
      path: `${tempDir}/upload.war`,
      appName: 'TestApp',
      files: [{ path: 'version.txt', content: 'v2' }],
    });
    const deployer = createDeployer(warPath);
    const before = await deployer.getCurrentArtifactIdentity();
    const uploadBytes = await readFile(uploadPath);
    const uploadDeployer = createDeployer(uploadPath);
    const target = await uploadDeployer.getCurrentArtifactIdentity();

    await expect(deployer.deployUploadedWar(
      uploadBytes,
      'artifact-upload-stale-0001',
      {
        expectedBaseSha256: 'e'.repeat(64),
        targetContentSha256: target!.contentSha256,
      }
    )).rejects.toThrow('ARTIFACT_BASE_DRIFT');

    expect(await deployer.getCurrentArtifactIdentity()).toEqual(before);
  });
});
