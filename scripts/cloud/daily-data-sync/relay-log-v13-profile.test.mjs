import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {ISOLATED_IDENTITY} from './deployment-evidence.mjs';import {V13_LOG_SOURCE_SHA,LEGACY_OCTOBER15_DEPLOYMENTS,REVIEWED_V13_DEPLOYMENTS,v13LogDeploymentProfile} from './relay-log-v13-profile.mjs';
const input=()=>({sourceSha:V13_LOG_SOURCE_SHA,deploymentId:'4a6e678e-437e-41d8-830d-f1f642b07bb5',identity:{...ISOLATED_IDENTITY}});
test('all original seven deployments remain in order and only root-confirmed v13 is appended',async()=>{
 const old=await readFile(new URL('./scan-relay-live-logs.ps1',import.meta.url),'utf8');const line=old.split('\n').find(s=>s.includes("$deployments=@('e71e73ea-838f-45d3-a19d-32033d3d7391'"));assert(line);const legacy=[...line.matchAll(/'([a-f0-9-]{36})'/g)].map(m=>m[1]);assert.deepEqual([...LEGACY_OCTOBER15_DEPLOYMENTS],legacy);
 const out=v13LogDeploymentProfile(input());assert.equal(out.totalDeployments,10);assert.deepEqual(out.deployments,[...legacy,'4a6e678e-437e-41d8-830d-f1f642b07bb5','ea783d17-095b-4dee-86cc-5d6dc7820ce9','5886c332-9751-4ba5-a650-b9ebd19e0be4']);assert.equal(out.remoteCalls,0);
 assert.equal(v13LogDeploymentProfile({...input(),deploymentId:'ea783d17-095b-4dee-86cc-5d6dc7820ce9'}).currentDeploymentId,'ea783d17-095b-4dee-86cc-5d6dc7820ce9');
});
test('future IDs, legacy current/source and caller history injection fail before any remote operation',()=>{
 for(const bad of [{...input(),deploymentId:'11111111-1111-4111-8111-111111111111'},{...input(),deploymentId:LEGACY_OCTOBER15_DEPLOYMENTS[6]},{...input(),sourceSha:'d1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21'},{...input(),deployments:['SYNTHETIC_PRIVATE']},{...input(),identity:{...ISOLATED_IDENTITY,serviceId:'foreign'}}])assert.throws(()=>v13LogDeploymentProfile(bad));
});
test('returned profile mutations cannot change the fixed reviewed history',()=>{const a=v13LogDeploymentProfile(input());a.deployments.length=0;assert.equal(v13LogDeploymentProfile(input()).totalDeployments,10);assert(Object.isFrozen(LEGACY_OCTOBER15_DEPLOYMENTS));assert(Object.isFrozen(REVIEWED_V13_DEPLOYMENTS));});
