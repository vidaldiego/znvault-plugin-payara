import { describe, it, expect } from 'vitest';
import { validateSandboxManifest, verifySandboxReceipt, verifyProductionReadback } from '../src/cli/sandbox-target.js';
const sha='a'.repeat(64), uuid='73c096e8-fc98-49b2-a327-c45da5c1c0df';
export const manifest={version:1,runtimeId:'partner-sandbox',gitSha:'b'.repeat(40),warSha256:sha,image:'registry.example/zincapi@sha256:'+sha,bundlePath:'/tmp/runtime.tgz',bundleSha256:sha,driverSha256:sha,files:{'compose.json':sha,'private-service.json':sha,'deploy-runtime.py':sha,'nginx.conf':sha,'public-proxy.conf':sha,'private-mtls.rendered.conf':sha,'authority-relay.rendered.conf':sha},preMigrations:[],postMigrations:[],production:[{className:'api',host:'172.16.220.55',warContentSha256:sha}],releaseReceiptSha256:sha};
describe('sandbox exact artifact receipt',()=>{
 it('rejects mutable images, path traversal and a production secret bundle',()=>{
  expect(()=>validateSandboxManifest({...manifest,image:'zincapi:latest'})).toThrow(/digest/);
  expect(()=>validateSandboxManifest({...manifest,files:{...manifest.files,'../application.json':sha}})).toThrow(/file/);
  expect(()=>validateSandboxManifest({...manifest,files:{...manifest.files,'application.json':sha}})).toThrow(/file/);
  expect(validateSandboxManifest(manifest).runtimeId).toBe('partner-sandbox');
 });
 it('tampered image or wrong runtime fails readback',()=>{
  const receipt={deploymentId:uuid,status:'complete',runtimeId:'partner-sandbox',host:'172.16.221.80',gitSha:manifest.gitSha,warSha256:sha,image:manifest.image,imageId:'sha256:'+sha,files:manifest.files,preMigrations:[],postMigrations:[],environment:'SANDBOX',tenantId:99007,loaded:true};
  expect(()=>verifySandboxReceipt(receipt,manifest,uuid)).not.toThrow();
  expect(()=>verifySandboxReceipt({...receipt,environment:'PRODUCTION'},manifest,uuid)).toThrow(/runtime/);
  expect(()=>verifySandboxReceipt({...receipt,warSha256:'c'.repeat(64)},manifest,uuid)).toThrow(/artifact/);
 });
 it('resume sandbox requires the same current production operation and exact persisted artifact',()=>{
  const readback={isDeploying:false,lastDeploymentId:uuid,lastResult:{success:true,deployed:true,artifact:{sha256:sha,contentSha256:sha,size:3}}};
  const hashes={status:'ok',artifact:readback.lastResult.artifact};
  expect(verifyProductionReadback(readback,hashes,sha).deploymentId).toBe(uuid);
  expect(()=>verifyProductionReadback({...readback,lastDeploymentId:'bad'},hashes,sha)).toThrow();
  expect(()=>verifyProductionReadback(readback,{...hashes,artifact:{...hashes.artifact,sha256:'c'.repeat(64)}},sha)).toThrow();
 });
});
