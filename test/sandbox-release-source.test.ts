import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertReviewedSandboxSource } from '../src/cli/commands/deploy-run.js';
import { sha256, type SandboxArtifactManifest } from '../src/cli/sandbox-target.js';
import type { DeployConfig } from '../src/cli/types.js';
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'sandbox-release-source-'));
 const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 git('init');git('config','user.email','synthetic@example.invalid');git('config','user.name','Synthetic fixture');
 const original='# stable config\nversion.major=14\nversion.minor=7\nversion.patch=1\nversion.build=25\n';
 const release=original.replace('version.build=25','version.build=26');
 writeFileSync(join(root,'gradle.properties'),original);mkdirSync(join(root,'e2e/.runtime'),{recursive:true});
 writeFileSync(join(root,'e2e/fast-suite.txt'),'synthetic-suite\n');writeFileSync(join(root,'.gitignore'),'e2e/.runtime/\n');
 git('add','.');git('commit','-m','Synthetic source');const source=git('rev-parse','HEAD');
 const receipt=`version=1\nresult=pass\ncommit=${source}\nruntime_commit=${source}\nsuite_sha256=${sha256('synthetic-suite\n')}\nduration_seconds=1\ntests=1\nfailures=0\nerrors=0\nskipped=0\ncompleted_at_epoch=${Math.floor(Date.now()/1000)}\n`;
 writeFileSync(join(root,'e2e/.runtime/e2e-fast-pass.properties'),receipt);
 const manifest={gitSha:source,releaseReceiptSha256:sha256(receipt),releasePropertiesSha256:sha256(release)} as unknown as SandboxArtifactManifest;
 return {root,git,original,release,manifest,config:{rootDir:root} as DeployConfig,dispose:()=>rmSync(root,{recursive:true,force:true})};
}
it('accepts only the supported post-receipt Gradle version bump before source deployment',()=>{
 const f=fixture();try {
  writeFileSync(join(f.root,'gradle.properties'),f.release);
  expect(()=>assertReviewedSandboxSource(f.config,f.manifest)).not.toThrow();
  writeFileSync(join(f.root,'unreviewed-source.kt'),'unreviewed');
  expect(()=>assertReviewedSandboxSource(f.config,f.manifest)).toThrow();
 }finally{f.dispose();}
});
it('scoped recovery accepts an exact clean one-parent version-only release commit',()=>{
 const f=fixture();try {
  writeFileSync(join(f.root,'gradle.properties'),f.release);f.git('add','gradle.properties');f.git('commit','-m','Synthetic version bump');
  expect(()=>assertReviewedSandboxSource(f.config,f.manifest)).not.toThrow();
  writeFileSync(join(f.root,'business.kt'),'changed');f.git('add','.');f.git('commit','-m','Synthetic unreviewed business change');
  expect(()=>assertReviewedSandboxSource(f.config,f.manifest)).toThrow();
 }finally{f.dispose();}
});
it('refuses configuration changes hidden beside a valid bump and mismatched release properties',()=>{
 const f=fixture();try {
  writeFileSync(join(f.root,'gradle.properties'),f.release+'org.gradle.offline=true\n');
  expect(()=>assertReviewedSandboxSource(f.config,{...f.manifest,releasePropertiesSha256:sha256(f.release+'org.gradle.offline=true\n')} as SandboxArtifactManifest)).toThrow();
  writeFileSync(join(f.root,'gradle.properties'),f.original.replace('version.build=25','version.build=99'));
  expect(()=>assertReviewedSandboxSource(f.config,f.manifest)).toThrow();
 }finally{f.dispose();}
});
