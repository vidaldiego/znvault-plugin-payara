import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { Command } from 'commander';
import { registerDeployRunCommand } from '../src/cli/commands/deploy-run.js';
import { sha256 } from '../src/cli/sandbox-target.js';
import { readLocalWarArtifactSnapshot } from '../src/war-deployer.js';
import type { CLIPluginContext } from '../src/cli/types.js';
it('real command dry-run shows production restore before owned S, with zero host credential calls',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sandbox-deploy-dryrun-')),infos:string[]=[],errors:string[]=[];
 const exit=vi.spyOn(process,'exit').mockImplementation(()=>{throw Error('exit');});
 try {
  const war=join(dir,'znapi.war'),zip=new AdmZip();zip.addFile('WEB-INF/web.xml',Buffer.from('<web-app/>'));zip.writeZip(war);
  const identity=await readLocalWarArtifactSnapshot(war),sha='a'.repeat(64),bundle=join(dir,'release.tgz');writeFileSync(bundle,'local-dry-run-fixture');
  const manifest={version:1,runtimeId:'partner-sandbox',gitSha:'b'.repeat(40),warSha256:sha,image:'registry.example/zincapi@sha256:'+sha,bundlePath:bundle,bundleSha256:sha256(readFileSync(bundle)),driverSha256:sha,files:Object.fromEntries(['compose.json','private-service.json','deploy-runtime.py','nginx.conf','public-proxy.conf','private-mtls.rendered.conf','authority-relay.rendered.conf'].map(p=>[p,sha])),preMigrations:[],postMigrations:[],production:[{className:'api',host:'172.16.220.55',warContentSha256:identity.contentSha256}],releaseReceiptSha256:sha};
  writeFileSync(join(dir,'release.json'),JSON.stringify(manifest));
  const config={name:'release',port:9100,rootDir:dir,warPath:'znapi.war',classes:[{name:'api',hosts:['172.16.220.55'],strategy:'1+R'}, {name:'sandbox',hosts:['172.16.221.80'],target:{kind:'partner-sandbox-compose',runtimeId:'partner-sandbox',host:'172.16.221.80',project:'zincapp-partner-sandbox',directory:'/srv/zincapp/partner-sandbox',manifestPath:'release.json',ssh:{user:'zn-vault-agent'}}}]};
  writeFileSync(join(dir,'config.json'),JSON.stringify(config));
  const ctx={output:{info:(s:string)=>infos.push(s),error:(s:string)=>errors.push(s),warn:vi.fn(),success:vi.fn(),table:vi.fn(),keyValue:vi.fn()},client:{get:vi.fn(),post:vi.fn()},getConfig:()=>({url:'https://localhost'}),isPlainMode:()=>true} as CLIPluginContext;
  const program=new Command();program.exitOverride();registerDeployRunCommand(program.command('payara').command('deploy'),ctx);
  try{await program.parseAsync(['node','znvault','payara','deploy','run',join(dir,'config.json'),'--dry-run','--yes']);}catch(e){throw Error(errors.join(' | ') || String(e));}
  expect(errors).toEqual([]);expect(exit).not.toHaveBeenCalled();
  expect(infos.join('\n')).toContain('production post/traffic restore → S own pre/schema/Compose/readback/post');
  expect(infos.join('\n')).toContain('owned database partner_sandbox_zincdb');
  expect(ctx.client.post).not.toHaveBeenCalled();
 }finally{exit.mockRestore();rmSync(dir,{recursive:true,force:true});}
});
