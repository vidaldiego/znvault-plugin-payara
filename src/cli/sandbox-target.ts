// Final Docker target: production rollout completes, including post gates and traffic restore, before S.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { SandboxDeployTarget } from '@zincapp/znvault-deploy-core';
import type { DeployConfig } from './types.js';
export type { SandboxDeployTarget };
const SHA=/^[a-f0-9]{64}$/, UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OWNED_FILES=new Set(['compose.json','private-service.json','deploy-runtime.py','nginx.conf','public-proxy.conf','private-mtls.rendered.conf','authority-relay.rendered.conf','deployment.json','redis-start.sh','minio-init.sh','preflight.py']);
export interface ProductionArtifact {className:string;host:string;warContentSha256:string}
export interface SandboxArtifactManifest {
 version:1;runtimeId:string;gitSha:string;warSha256:string;image:string;
 bundlePath:string;bundleSha256:string;driverSha256:string;files:Record<string,string>;
 preMigrations:string[];postMigrations:string[];production:ProductionArtifact[];releaseReceiptSha256:string;releasePropertiesSha256?:string;
}
export interface ProductionReceipt extends ProductionArtifact {deploymentId:string;warSha256:string}
export interface SandboxDeploymentReceipt {
 deploymentId:string;status:'complete';runtimeId:string;host:string;gitSha:string;warSha256:string;image:string;imageId:string;
 files:Record<string,string>;preMigrations:string[];postMigrations:string[];environment:'SANDBOX';tenantId:99007;loaded:true;
}
export function validateSandboxManifest(value:unknown):SandboxArtifactManifest {
 const m=value as SandboxArtifactManifest;
 if(!m || m.version!==1 || m.runtimeId!=='partner-sandbox' || !/^[a-f0-9]{40}$/.test(m.gitSha)) throw Error('Sandbox manifest runtime/reviewed Git identity invalid');
 if(!/^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(m.image))throw Error('Immutable sandbox image digest required');
 if(m.releasePropertiesSha256!==undefined&&!SHA.test(m.releasePropertiesSha256))throw Error('Invalid release metadata digest');
 for(const digest of [m.warSha256,m.bundleSha256,m.driverSha256,m.releaseReceiptSha256])if(!SHA.test(digest))throw Error('Sandbox digest required');
 if(typeof m.bundlePath!=='string'||!m.bundlePath.startsWith('/')||!m.files||Array.isArray(m.files))throw Error('Owned sandbox bundle/file manifest required');
 for(const [file,digest] of Object.entries(m.files))if((!OWNED_FILES.has(file)&&!/^migrations\/(pre|post)\/[a-z0-9][a-z0-9._-]*\.sql$/.test(file))||!SHA.test(digest))throw Error('Unowned sandbox file or digest');
 for(const file of ['compose.json','private-service.json','deploy-runtime.py','nginx.conf','public-proxy.conf','private-mtls.rendered.conf','authority-relay.rendered.conf'])if(!m.files[file])throw Error('Missing owned sandbox file');
 if(m.files['deploy-runtime.py']!==m.driverSha256)throw Error('Owned driver digest mismatch');
 for(const phase of ['pre','post'] as const){const paths=phase==='pre'?m.preMigrations:m.postMigrations;if(!Array.isArray(paths)||new Set(paths).size!==paths.length||paths.some(p=>!p.startsWith(`migrations/${phase}/`)||!m.files[p]))throw Error('Owned sandbox schema migration manifest required');}
 if(!Array.isArray(m.production)||m.production.length===0||new Set(m.production.map(p=>p.host)).size!==m.production.length||m.production.some(p=>!p.className||!p.host||p.host==='172.16.221.80'||!SHA.test(p.warContentSha256)))throw Error('Complete serving artifact manifest required');
 return m;
}
export function loadSandboxManifest(target:SandboxDeployTarget):SandboxArtifactManifest {
 const m=validateSandboxManifest(JSON.parse(readFileSync(target.manifestPath,'utf8')));
 if(sha256(readFileSync(m.bundlePath))!==m.bundleSha256)throw Error('Sandbox bundle digest mismatch');
 return m;
}
export function sha256(bytes:Buffer|string):string{return createHash('sha256').update(bytes).digest('hex');}
export function splitSandboxComposition(config:DeployConfig,flags:{class?:string[];host?:string[];only?:string[];strategy?:string;resumeSandbox?:string;skipMigrations?:boolean;skipPre?:boolean;skipPost?:boolean;skipDrain?:boolean}) {
 const targets=config.classes?.filter(c=>c.target)??[];
 if(targets.length===0){if(flags.resumeSandbox)throw Error('No sandbox target to resume');return {production:config,target:undefined};}
 if(targets.length!==1||config.classes?.at(-1)!==targets[0]||config.classes!.length<2)throw Error('Sandbox requires a distinct final target after serving classes');
 const cls=targets[0]!,target=cls.target!;
 if(target.kind!=='partner-sandbox-compose'||target.host!=='172.16.221.80'||target.runtimeId!=='partner-sandbox'||target.directory!=='/srv/zincapp/partner-sandbox'||target.project!=='zincapp-partner-sandbox'||cls.hosts.length!==1||cls.hosts[0]!==target.host)throw Error('Unowned sandbox target');
 if(flags.skipMigrations||flags.skipPre||flags.skipPost||flags.skipDrain)throw Error('1+R+S requires all production gates');
 if(flags.host?.length||flags.only?.length||flags.strategy)throw Error('1+R+S requires complete serving coverage');
 if(flags.resumeSandbox){if(!UUID.test(flags.resumeSandbox)||flags.class?.length!==1||flags.class[0]!==cls.name)throw Error('Scoped sandbox retry requires its original deployment UUID and only --class sandbox');}
 else if(flags.class?.length)throw Error('1+R+S requires complete target coverage; use scoped sandbox recovery with original receipt');
 return {production:{...config,classes:config.classes!.filter(c=>!c.target)},target,targetClassName:cls.name};
}
export async function executeSandboxComposition<P,S>(production:()=>Promise<P>,sandbox:(receipt:P)=>Promise<S>):Promise<S>{return sandbox(await production());}
export function verifyProductionReadback(status:unknown,hashes:unknown,expectedContent:string):{deploymentId:string;warSha256:string}{
 const s=status as {deploying?:boolean;isDeploying?:boolean;lastDeploymentId?:string;lastResult?:{success?:boolean;deployed?:boolean;artifact?:{sha256:string;contentSha256:string}}};
 const h=hashes as {status?:string;artifact?:{sha256:string;contentSha256:string}};
 if(s.deploying||s.isDeploying||!s.lastDeploymentId||!UUID.test(s.lastDeploymentId)||s.lastResult?.success!==true||s.lastResult.deployed!==true||h.status!=='ok'||!h.artifact||!SHA.test(h.artifact.sha256)||h.artifact.contentSha256!==expectedContent||s.lastResult.artifact?.sha256!==h.artifact.sha256||s.lastResult.artifact.contentSha256!==expectedContent)throw Error('Current production operation/artifact receipt unverified');
 return {deploymentId:s.lastDeploymentId,warSha256:h.artifact.sha256};
}
export function verifySandboxReceipt(value:unknown,m:SandboxArtifactManifest,id:string):asserts value is SandboxDeploymentReceipt {
 const r=value as SandboxDeploymentReceipt;
 if(!r||r.deploymentId!==id||r.status!=='complete'||r.runtimeId!==m.runtimeId||r.host!=='172.16.221.80'||r.environment!=='SANDBOX'||r.tenantId!==99007||r.loaded!==true)throw Error('Sandbox runtime receipt mismatch');
 if(r.gitSha!==m.gitSha||r.warSha256!==m.warSha256||r.image!==m.image||!/^sha256:[a-f0-9]{64}$/.test(r.imageId)||JSON.stringify(r.preMigrations)!==JSON.stringify(m.preMigrations)||JSON.stringify(r.postMigrations)!==JSON.stringify(m.postMigrations)||Object.keys(r.files??{}).length!==Object.keys(m.files).length||Object.entries(m.files).some(([p,h])=>r.files[p]!==h))throw Error('Sandbox installed artifact/schema receipt mismatch');
}
// Commands contain only allowlisted owners, UUIDs and digests. Tokens/passwords never appear in argv.
function quote(s:string):string{return "'"+s.replaceAll("'","'\\''")+"'";}
async function ownedSsh(target:SandboxDeployTarget,args:string[],input?:Buffer):Promise<unknown>{
 if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(target.ssh.user))throw Error('Invalid sandbox SSH owner');
 const driver=target.directory+'/deploy-runtime.py';
 const expected=args[args.indexOf('--driver-sha256')+1];
 if(!expected||!SHA.test(expected))throw Error('Reviewed driver identity required');
 const command='test '+quote(expected)+' = "$(sudo -n sha256sum '+quote(driver)+' | cut -d \' \' -f1)" && exec '+['sudo','-n',...args].map(quote).join(' ');
 return new Promise((resolveResult,reject)=>{
  const child=spawn('znvault',['--quiet','ssh','-T',`${target.ssh.user}@${target.host}`,'--',command],{stdio:['pipe','pipe','pipe'],detached:true});
  let bytes=0,stdout='',timedOut=false;let kill:NodeJS.Timeout|undefined;
  const terminate=()=>{try{process.kill(-child.pid!,'SIGTERM');}catch{/* The process group may already have exited. */}kill=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{/* The process group may already have exited. */}},2000);kill.unref();};
  const timeout=setTimeout(()=>{timedOut=true;terminate();},15*60_000);
  child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>256*1024)terminate();else stdout+=b.toString();});
  child.stderr.on('data',()=>{/* Runtime errors may contain secret paths; surface only a bounded action error. */});
  child.on('error',()=>{clearTimeout(timeout);if(kill)clearTimeout(kill);reject(Error('Owned sandbox SSH transport unavailable'));});
  child.on('close',code=>{clearTimeout(timeout);if(kill)clearTimeout(kill);if(code!==0||timedOut||bytes>256*1024)return reject(Error('Sandbox target incomplete; recover with the original deployment UUID'));try{resolveResult(JSON.parse(stdout));}catch{reject(Error('Sandbox returned no exact receipt'));}});
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
export async function deploySandboxTarget(target:SandboxDeployTarget,m:SandboxArtifactManifest,id:string):Promise<SandboxDeploymentReceipt>{
 if(!UUID.test(id))throw Error('Invalid deployment UUID');
 const bundle=readFileSync(m.bundlePath);if(bundle.length>64*1024*1024||sha256(bundle)!==m.bundleSha256)throw Error('Sandbox bundle changed');
 const result=await ownedSsh(target,['python3',target.directory+'/deploy-runtime.py','--phase','deploy','--deployment-id',id,'--bundle-sha256',m.bundleSha256,'--driver-sha256',m.driverSha256],bundle);
 verifySandboxReceipt(result,m,id);return result;
}
export async function preflightSandboxTarget(target:SandboxDeployTarget,m:SandboxArtifactManifest):Promise<void>{
 const r=await ownedSsh(target,['python3',target.directory+'/deploy-runtime.py','--phase','preflight','--driver-sha256',m.driverSha256]) as {runtimeId?:string;host?:string;database?:string;driverSha256?:string};
 if(r.runtimeId!==m.runtimeId||r.host!==target.host||r.database!=='partner_sandbox_zincdb'||r.driverSha256!==m.driverSha256)throw Error('Sandbox deployment owner/preflight mismatch');
}
export interface CompositionJournal {version:1;deploymentId:string;manifestSha256:string;productionConfigSha256:string;production:ProductionReceipt[];status:'production_complete'|'sandbox_incomplete'|'complete';sandbox?:SandboxDeploymentReceipt}
export function writeCompositionJournal(path:string,j:CompositionJournal):void{mkdirSync(dirname(path),{recursive:true,mode:0o700});const tmp=path+'.'+randomUUID();writeFileSync(tmp,JSON.stringify(j),{mode:0o600,flag:'wx'});renameSync(tmp,path);}
export function readCompositionJournal(path:string):CompositionJournal{if(statSync(path).mode&0o077)throw Error('Composition journal must be private');const j=JSON.parse(readFileSync(path,'utf8')) as CompositionJournal;if(j.version!==1||!UUID.test(j.deploymentId)||!SHA.test(j.manifestSha256)||!SHA.test(j.productionConfigSha256)||!Array.isArray(j.production))throw Error('Invalid composition recovery journal');return j;}
export function journalPath(target:SandboxDeployTarget,id:string):string{if(!UUID.test(id))throw Error('Invalid deployment UUID');return resolve(dirname(target.manifestPath),'sandbox-receipts',id+'.json');}
