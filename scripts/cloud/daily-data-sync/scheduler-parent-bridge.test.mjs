import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {parentBridge,checkedDefinitions} from './scheduler-parent-bridge.mjs';
import {FIXED_CONNECTIONS,ISOLATED_IDENTITY} from './deployment-evidence.mjs';
import {jobPlan} from './core.mjs';
const defs=FIXED_CONNECTIONS.map((r,i)=>({key:`phase08-${r.provider.toLowerCase()}`,connectionId:r.connectionId,provider:r.provider,timeZone:r.timeZone,anchorAt:`2026-10-14T17:0${i}:00.000Z`,windowMinutes:r.provider==='CAFE24'?110:90,targetId:ISOLATED_IDENTITY.targetId}));
test('parent definitions preserve 7-field contract, 149 finite jobs and real next range without date override',async()=>{
 const out=await parentBridge({action:'definitions',definitions:defs,observedAt:'2026-10-14T01:00:00.000Z'});
 assert.deepEqual(out.definitions,defs);assert.equal(out.managementDefinitions[1].cadenceDays,7);
 assert.equal(checkedDefinitions(defs).flatMap(jobPlan).length,149);
 assert.deepEqual(out.ranges.map(({fromDate,toDate})=>[fromDate,toDate]),[['2026-10-14','2026-10-14'],['2026-10-08','2026-10-14'],['2026-10-08','2026-10-14']]);
 for(const value of [[...defs.slice(0,2)],defs.map((r,i)=>i? r:{...r,account:'foreign'}),defs.map((r,i)=>i? r:{...r,targetId:'foreign'})])assert.throws(()=>checkedDefinitions(value));
});
test('metadata compression comparison uses complete exact bytes and rejects dual/foreign/noncanonical input',async()=>{
 const original=Buffer.from(JSON.stringify({nested:'한글',values:Array(100).fill(5)}));
 const value={original:original.toString('base64'),gzip:gzipSync(original).toString('base64')};
 assert.equal((await parentBridge({action:'metadata',values:[value,value]})).state,'PHASE08_METADATA_BYTES_VERIFIED');
 for(const bad of [{...value,json:value.original},{...value,original:Buffer.from('{}').toString('base64')},{...value,gzip:value.gzip+'\n'}])await assert.rejects(parentBridge({action:'metadata',values:[bad,value]}));
});
test('snapshot readback compares exact three definitions/149 jobs and preservation, paused then enabled',async()=>{
 const rows=checkedDefinitions(defs),jobs=rows.flatMap(jobPlan).map(j=>({...j,active:false,database:'postgres',username:'postgres'}));
 const before={other_cron_digest:'a'.repeat(32),preserved_schema_digest:'b'.repeat(32)};
 const after={...before,snapshot:{installed:true,settings:[{stopped:true,targetId:ISOLATED_IDENTITY.targetId,origin:ISOLATED_IDENTITY.origin}],schedules:rows.map(r=>({...r,paused:true})),jobs}};
 assert.equal((await parentBridge({action:'snapshot',mode:'configure',definitions:defs,before,after})).state,'PHASE08_BATCH_READBACK_VERIFIED');
 for(const mutate of [a=>a.other_cron_digest='c'.repeat(32),a=>a.snapshot.jobs[0].command='SELECT foreign()',a=>a.snapshot.schedules[0].paused=false,a=>a.snapshot.jobs.pop()]){
  const copy=structuredClone(after);mutate(copy);await assert.rejects(parentBridge({action:'snapshot',mode:'configure',definitions:defs,before,after:copy}));
 }
 const enabled=structuredClone(after);enabled.snapshot.settings[0].stopped=false;enabled.snapshot.schedules.forEach(r=>r.paused=false);enabled.snapshot.jobs.forEach(r=>r.active=true);
 assert.equal((await parentBridge({action:'snapshot',mode:'enable',definitions:defs,before,after:enabled})).state,'PHASE08_BATCH_READBACK_VERIFIED');
});
test('parent execution refuses unsigned evidence with no SQL returned',async()=>{
 await assert.rejects(parentBridge({action:'validate',envelope:{}}));await assert.rejects(parentBridge({action:'build',mode:'configure',definitions:defs,envelope:{}}));
});
test('loaded empty install definitions and typed exact application/management definitions are accepted; unknown keys rejected',async()=>{
 const prepared=await parentBridge({action:'definitions',definitions:defs,observedAt:'2026-10-14T01:00:00.000Z'});
 for(const loaded of [{appSchedules:[],managementSchedules:[]},{appSchedules:defs.map(({key,connectionId,anchorAt,windowMinutes})=>({key,connectionId,anchorAt,windowMinutes})),managementSchedules:prepared.managementDefinitions}])assert.equal((await parentBridge({action:'loaded',definitions:defs,...loaded})).state,'PHASE08_LOADED_DEFINITIONS_VERIFIED');
 const app=defs.map(({key,connectionId,anchorAt,windowMinutes})=>({key,connectionId,anchorAt,windowMinutes}));app[0].extra='SYNTHETIC_PRIVATE';
 await assert.rejects(parentBridge({action:'loaded',definitions:defs,appSchedules:app,managementSchedules:[]}));
});
