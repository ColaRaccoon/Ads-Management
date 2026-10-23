import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {acceleratedDefinitions,EXTRA_TEST_OCCURRENCES} from './accelerated-october15-profile.mjs';
import {assertSchedule,jobPlan,occurrence} from './core.mjs';
import {acceleratedRelaySource} from './accelerated-october15-relay.mjs';
import {buildAcceleratedProfileBatch} from './accelerated-october15-batch.mjs';
import {relayTransportPatchSql} from './relay-transport-patch.mjs';
const hash=s=>createHash('md5').update(s).digest('hex');
test('profiles are fixed real-clock only; no next-day recurring accelerated occurrence',()=>{
 for(const phase of ['outage','collection','normal']){const defs=acceleratedDefinitions(phase);assert.equal(defs.length,3);assert.equal(defs[1].anchorAt,'2026-10-14T17:01:00.000Z');for(const row of defs)assertSchedule(row);}
 for(const row of EXTRA_TEST_OCCURRENCES){const d={...row,timeZone:'Asia/Seoul',targetId:'phase08-full-app'};assertSchedule(d);assert.equal(occurrence(d,Date.parse(d.anchorAt)-1),null);assert.equal(occurrence(d,Date.parse(d.anchorAt)+864000000).scheduledFor,d.anchorAt);assert.throws(()=>assertSchedule({...d,targetId:'foreign'}));assert.throws(()=>assertSchedule({...d,anchorAt:'2026-10-16'+d.anchorAt.slice(10)}));}
 assert.equal(acceleratedDefinitions('outage').flatMap(jobPlan).length,138);assert.equal(acceleratedDefinitions('collection').flatMap(jobPlan).length,149);assert.throws(()=>acceleratedDefinitions('arbitrary'));
});
test('separate relay artifact exact future/test single occurrence, expired status, redirect and unchanged normal behavior',async()=>{
 const source=await acceleratedRelaySource(),{createRelayHandler}=await import('data:text/javascript;base64,'+Buffer.from(source.relay).toString('base64'));assert.equal(source.remoteChanges,0);
 const password=Buffer.alloc(32,7).toString('base64'),machine=Buffer.alloc(32,8).toString('base64');
 for(const row of EXTRA_TEST_OCCURRENCES){let calls=0;const due=Date.parse(row.anchorAt);let now=due+1000;const handler=createRelayHandler({env:{basicPassword:password,machineToken:machine},now:()=>now,request:async(url,o)=>{calls++;assert.equal(o.redirect,'manual');assert.equal(o.headers['x-daily-sync-token'],machine);const last='2026-10-14',days=row.provider==='CAFE24'?1:7;return Response.json({scheduleKey:row.key,scheduledFor:row.anchorAt,fromDate:days===1?last:'2026-10-08',toDate:last,status:now>due+row.windowMinutes*60000?'EXPIRED':'PARTIAL',completedUnits:0,totalUnits:days});}});
 const req=(at,mode)=>new Request('https://ehnfrrmbkvlsbpvqcvkr.supabase.co/functions/v1/phase08-scheduled-relay',{method:'POST',headers:{authorization:'Basic '+btoa('phase08-scheduler:'+password),'content-type':'application/json'},body:JSON.stringify({scheduleKey:row.key,scheduledFor:at,...(mode?{mode}: {})})});
 assert.equal((await handler(req(row.anchorAt))).status,200);now=due+(row.windowMinutes+5)*60000;assert.equal((await handler(req(row.anchorAt))).status,400);assert.equal((await handler(req(row.anchorAt,'status'))).status,200);now=due-1;assert.equal((await handler(req(row.anchorAt))).status,400);now=due+8*86400000;assert.equal((await handler(req(new Date(due+7*86400000).toISOString()))).status,400);assert.equal(calls,2);
 }
});
test('single batch derives approved function only, preserves history and uses all149 supported cron APIs',async()=>{
 const base=await relayTransportPatchSql({expectedProsrcMd5:'a'.repeat(32),reviewedRelaySourceSha256:'b'.repeat(64)}),start=base.indexOf('CREATE OR REPLACE FUNCTION daily_data_sync_ops.call('),end=base.indexOf('\nREVOKE ALL ON FUNCTION',start),fn=base.slice(start,end).trim(),body=fn.match(/AS \$\$([\s\S]*)\$\$;/)[1];
 const input={phase:'outage',currentCallDefinition:fn,expectedCallMd5:hash(body),expectedState:{settingsMd5:'a'.repeat(32),schedulesMd5:'b'.repeat(32),jobsMd5:'c'.repeat(32)},actorId:'11111111-1111-4111-8111-111111111111',authId:'22222222-2222-4222-8222-222222222222'};
 const first=buildAcceleratedProfileBatch(input);assert.equal(first.activeJobs,138);assert.equal((first.sql.match(/SELECT cron.alter_job/g)||[]).length,149);assert.match(first.sql,/singleton AND stopped/);assert.match(first.sql,/email_confirmed_at IS NOT NULL/);assert.match(first.sql,/WHEN query_canceled THEN/);assert.match(first.sql,/2026-10-15T05:58:00Z/);assert.doesNotMatch(first.sql,/UPDATE cron.job|UPDATE daily_data_sync_ops.attempts|DELETE FROM|TRUNCATE|INSERT INTO vault/);
 const nextFn=first.sql.slice(first.sql.indexOf('CREATE OR REPLACE FUNCTION daily_data_sync_ops.call(')).match(/^[\s\S]*?AS (\$\$|\$function\$)[\s\S]*?\1;/)[0];
 const second=buildAcceleratedProfileBatch({...input,phase:'collection',currentCallDefinition:nextFn,expectedCallMd5:first.resultCallMd5});assert.equal(second.activeJobs,149);
 const normal=buildAcceleratedProfileBatch({...input,phase:'normal',currentCallDefinition:nextFn,expectedCallMd5:first.resultCallMd5});assert.equal(normal.resultCallMd5,'0f11e36961a628ab665302b950d0b9aa');
 for(const bad of [{...input,phase:'any'},{...input,expectedState:{...input.expectedState,extra:'private'}},{...input,expectedCallMd5:'0'.repeat(32)}])assert.throws(()=>buildAcceleratedProfileBatch(bad));
});
