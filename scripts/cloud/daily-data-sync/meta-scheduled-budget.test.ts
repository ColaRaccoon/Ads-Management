import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduledUnitDeadline,ScheduledSyncService} from '../../../apps/api/src/daily-sync/scheduled-sync.service';

test('Meta65s keeps original occurrence ten-second closing reserve and other providers55s',()=>{
 const now=100000;for(const provider of ['META','GOOGLE','CAFE24'] as const){
  assert.equal(scheduledUnitDeadline(provider,new Date(now+900000),now),now+(provider==='META'?65000:55000));
  assert.equal(scheduledUnitDeadline(provider,new Date(now+40000),now),now+30000);
  assert.equal(scheduledUnitDeadline(provider,new Date(now+10000),now),now);
 }
});
test('real scheduled step supplies one Meta unit65s and skips execution inside closing reserve',async t=>{
 const prior={...process.env};const now=new Date('2026-10-15T07:20:00Z');t.mock.timers.enable({apis:['Date'],now});
 const def={key:'phase08-meta',connectionId:'1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6',anchorAt:'2026-10-15T07:00:00.000Z',windowMinutes:90};
 Object.assign(process.env,{DAILY_SYNC_FEATURE_ENABLED:'true',DAILY_SYNC_SCHEDULE_ENABLED:'true',DAILY_SYNC_ALLOWED_ACCOUNTS:JSON.stringify(['META/2138525300002203/default']),DAILY_SYNC_SCHEDULES:JSON.stringify([def]),SUPABASE_URL:'https://ehnfrrmbkvlsbpvqcvkr.supabase.co',SUPABASE_DATABASE_PROJECT_REF:'ehnfrrmbkvlsbpvqcvkr',SUPABASE_DATABASE_SCHEMA:'phase08_meta_ads',SUPABASE_DATABASE_RUNTIME_USER:'phase08_runtime',DEPLOYMENT_ENVIRONMENT_ID:'phase08-daily-data-sync-08',RUNTIME_API_TARGET_ID:'phase08-full-app'});
 try{
 let options:any,calls=0;const run={id:'run',status:'PARTIAL',units:[]};const prisma:any={sourceConnection:{findUnique:async()=>({id:def.connectionId,provider:'META',externalAccountId:'2138525300002203',shopKey:'default',timeZone:'Asia/Seoul'})},syncRun:{findUnique:async()=>run}};
 const service=new ScheduledSyncService(prisma,{prepareScheduledRetry:async()=>true}as any,{}as any,{}as any,{execute:async(_id:any,o:any)=>{calls++;options=o;}}as any);
 await service.step({scheduleKey:def.key,scheduledFor:def.anchorAt});assert.equal(calls,1);assert.deepEqual(options,{maxUnits:1,deadlineAt:now.getTime()+65000});
 t.mock.timers.setTime(new Date('2026-10-15T08:29:55Z').getTime());await service.step({scheduleKey:def.key,scheduledFor:def.anchorAt});assert.equal(calls,1);
 t.mock.timers.setTime(new Date('2026-10-15T08:31:00Z').getTime());await service.step({scheduleKey:def.key,scheduledFor:def.anchorAt});assert.equal(calls,1);
 }finally{process.env=prior;t.mock.timers.reset();}
});
