import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {restore02Sql,restoredRelay02Source,NORMAL_02_DEFINITIONS,TEST_10_DEFINITIONS} from './restore-02.mjs';
import {relayTransportPatchSql} from './relay-transport-patch.mjs';
import {reanchorOctober15Sql} from './reanchor-october15.mjs';
import {operatorRetryOctober15Sql} from './operator-retry-october15.mjs';
const extract=sql=>sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION daily_data_sync_ops.call(')).match(/^[\s\S]*?AS (\$\$|\$function\$)([\s\S]*?)\1;?/)[0];
const body=sql=>sql.match(/AS (\$\$|\$function\$)([\s\S]*?)\1/)[2];
const md5=s=>createHash('md5').update(body(s)).digest('hex');
async function actualShape(){const normal=extract(await relayTransportPatchSql({expectedProsrcMd5:'a'.repeat(32),reviewedRelaySourceSha256:'b'.repeat(64)}));const clock=extract(reanchorOctober15Sql({currentCallDefinition:normal,expectedProsrcMd5:md5(normal)}));return {normal,fn:extract(operatorRetryOctober15Sql({callDefinition:clock,sourceSha:'a986132a8f70757ca67ae93b54ce378926166da30ec9817378f206062e214097',actorId:'11111111-1111-4111-8111-111111111111',authId:'22222222-2222-4222-8222-222222222222'}))};}
test('restoration reverses reviewed clock and retry exceptions only; full history/checkpoints preserved with 149 supported APIs',async()=>{
 const {normal,fn}=await actualShape();assert.equal(md5(fn),'3c965ba93beb63a64819ba1bce36ba8f');
 const sql=await restore02Sql({currentCallDefinition:fn,expectedProsrcMd5:md5(fn)});assert.equal(body(extract(sql)),body(normal));assert.equal(md5(extract(sql)),'0f11e36961a628ab665302b950d0b9aa');
 assert.equal((sql.match(/SELECT cron\.alter_job\(jobid,schedule:=/g)||[]).length,149);assert.equal((sql.match(/UPDATE daily_data_sync_ops.schedules SET anchor_at=/g)||[]).length,3);
 assert.match(sql,/expires_at>clock_timestamp\(\)/);assert.match(sql,/RESTORE_02_OCCURRENCE_ACTIVE/);assert.match(sql,/restore_business_digest/);assert.match(sql,/vaultCiphertext/);assert.match(sql,/RESTORE_02_HISTORY_CHANGED/);
 assert.doesNotMatch(extract(sql),/OPERATOR_RETRY_APPROVED|2026-10-15T03:00:00Z/);assert.doesNotMatch(sql.replace(extract(sql),''),/UPDATE cron\.job|DELETE FROM|TRUNCATE|UPDATE phase08_meta_ads|INSERT INTO vault|INSERT INTO daily_data_sync_ops/);
 const pg=fn.replaceAll('$$','$function$').replace(/;$/,'');assert.equal(body(extract(await restore02Sql({currentCallDefinition:pg,expectedProsrcMd5:md5(fn)}))),body(normal));
});
test('unreviewed body edits, wrong fingerprints and pre-retry body cannot bypass exact function provenance',async()=>{
 const {normal,fn}=await actualShape();for(const [candidate,hash] of [[fn,'a'.repeat(32)],[fn.replace('CURLOPT_USERPWD','CURLOPT_USERPWD '),md5(fn.replace('CURLOPT_USERPWD','CURLOPT_USERPWD '))],[normal,md5(normal)]])await assert.rejects(restore02Sql({currentCallDefinition:candidate,expectedProsrcMd5:hash}),/RESTORE_02_REJECTED/);
});
test('separate relay v3 source restores daily/weekly normal clock and keeps exact October15 diagnostic status only',async()=>{
 const prepared=await restoredRelay02Source();assert.equal(prepared.remoteChanges,0);const mod=await import('data:text/javascript;base64,'+Buffer.from(prepared.relay).toString('base64'));
 assert.deepEqual(mod.SCHEDULES.map(x=>x.anchor),NORMAL_02_DEFINITIONS.map(x=>x.anchorAt));const env={basicPassword:Buffer.alloc(32,1).toString('base64'),machineToken:Buffer.alloc(32,2).toString('base64')};let calls=0;
 const req=(row,date,mode)=>new Request('https://ehnfrrmbkvlsbpvqcvkr.supabase.co/functions/v1/phase08-scheduled-relay',{method:'POST',headers:{Authorization:'Basic '+btoa('phase08-scheduler:'+env.basicPassword),'Content-Type':'application/json'},body:JSON.stringify({scheduleKey:row.key,scheduledFor:date,...(mode?{mode}:{})})});
 for(const row of mod.SCHEDULES){const next=new Date(Date.parse(row.anchor)+row.days*86400000).toISOString();const last=new Date(Date.parse(next)+9*3600000-86400000).toISOString().slice(0,10),from=new Date(Date.parse(last)-(row.days-1)*86400000).toISOString().slice(0,10);
 const handler=mod.createRelayHandler({env,now:()=>Date.parse(next)+60000,request:async(url,options)=>{calls++;assert.equal(options.redirect,'manual');assert(!url.endsWith('/status'));return Response.json({scheduleKey:row.key,scheduledFor:next,fromDate:from,toDate:last,status:'SUCCEEDED',completedUnits:row.days,totalUnits:row.days});}});
 assert.equal((await handler(req(row,next))).status,200);
 }
 for(const row of TEST_10_DEFINITIONS){const normal=mod.SCHEDULES.find(x=>x.key===row.key),last='2026-10-14',from=normal.days===1?last:'2026-10-08';const handler=mod.createRelayHandler({env,now:()=>Date.parse('2026-10-23T05:00:00Z'),request:async(url)=>{calls++;assert(url.endsWith('/status'));return Response.json({scheduleKey:row.key,scheduledFor:row.anchorAt,fromDate:from,toDate:last,status:'EXPIRED',completedUnits:0,totalUnits:normal.days});}});
 assert.equal((await handler(req(row,row.anchorAt,'status'))).status,200);assert.equal((await handler(req(row,row.anchorAt))).status,400);assert.equal((await handler(req(row,new Date(Date.parse(row.anchorAt)+normal.days*86400000).toISOString(),'status'))).status,400);
 }
 assert.equal(calls,6);
});
