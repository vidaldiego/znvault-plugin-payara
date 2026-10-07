import { describe,it,expect } from 'vitest';
import { splitSandboxComposition, executeSandboxComposition } from '../src/cli/sandbox-target.js';
const target={kind:'partner-sandbox-compose' as const,runtimeId:'partner-sandbox',host:'172.16.221.80',project:'zincapp-partner-sandbox',directory:'/srv/zincapp/partner-sandbox',manifestPath:'/tmp/release.json',ssh:{user:'zn-vault-agent'}};
const config={name:'release',warPath:'/api.war',classes:[{name:'api',hosts:['172.16.220.55'],strategy:'1+R'},{name:'sandbox',hosts:[target.host],target}]};
describe('1+R+S outer composition',()=>{
 it('serving canary and production ownership never include sandbox',()=>{
  const result=splitSandboxComposition(config,{});
  expect(result.production.classes?.map(c=>c.name)).toEqual(['api']);
  expect(result.production.classes?.[0].strategy).toBe('1+R');
  expect(result.target).toEqual(target);
  expect(config.classes).toHaveLength(2);
 });
 it('rejects incomplete selections and skips; legacy remains compatible',()=>{
  expect(()=>splitSandboxComposition(config,{class:['api']})).toThrow(/complete/);
  expect(()=>splitSandboxComposition(config,{skipPost:true})).toThrow(/gate/);
  const legacy={...config,classes:[config.classes[0]]};
  expect(splitSandboxComposition(legacy,{}).production).toBe(legacy);
 });
 it('sandbox runs only after serving post gates and traffic restore pass',async()=>{
  const order:string[]=[];
  await executeSandboxComposition(async()=>{order.push('api','post','restore');return 'receipt';},async receipt=>{expect(receipt).toBe('receipt');order.push('sandbox');});
  expect(order).toEqual(['api','post','restore','sandbox']);
 });
 it('serving failure leaves sandbox untouched and S failure never rolls back production',async()=>{
  const order:string[]=[];
  await expect(executeSandboxComposition(async()=>{throw Error('serving');},async()=>{order.push('sandbox');})).rejects.toThrow('serving');
  await expect(executeSandboxComposition(async()=>{order.push('api');},async()=>{throw Error('sandbox');})).rejects.toThrow('sandbox');
  expect(order).toEqual(['api']);
 });
});
