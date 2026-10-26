import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { occurrence, schedules } from "../../../apps/api/src/daily-sync/scheduled-occurrence";
import { assertSyncRunScope, assertSyncRunShape } from "../../../apps/api/src/daily-sync/sync-contract";
import { assertGoogleMetaRunScope } from "../../../apps/api/src/daily-sync/provider-run-scope";
import { SyncFoundationService } from "../../../apps/api/src/daily-sync/sync-foundation.service";
import { ScheduledSyncService } from "../../../apps/api/src/daily-sync/scheduled-sync.service";

const id = "21b811a6-b9d7-44f5-8167-ce40198947b5";
const daily = {key:"prod-google-daily",connectionId:id,anchorAt:"2026-10-26T17:01:00.000Z",windowMinutes:90,kind:"GOOGLE_DAILY" as const};
const recheck = {key:"prod-google-recheck-d7",connectionId:id,anchorAt:"2026-10-26T17:04:00.000Z",windowMinutes:90,kind:"GOOGLE_RECHECK_D7" as const};
const connection = {id,provider:"GOOGLE",externalAccountId:"1391592099",shopKey:"default",currencyCode:"KRW",timeZone:"Asia/Seoul",accessState:"READY",enabled:true};
const clock = new Date("2026-10-26T17:05:00Z");
async function env(work:()=>Promise<void>) {
  const before={...process.env};
  Object.assign(process.env,{DAILY_SYNC_FEATURE_ENABLED:"true",DAILY_SYNC_SCHEDULE_ENABLED:"true",DAILY_SYNC_SCHEDULES:JSON.stringify([daily,recheck]),DAILY_SYNC_ALLOWED_ACCOUNTS:'["GOOGLE/1391592099/default"]'});
  try {await work();} finally {process.env=before;}
}
function scope(d=daily as typeof daily | typeof recheck, at=d.anchorAt, now=clock) {
  return {...occurrence(d,"GOOGLE","Asia/Seoul",at,now),provider:"GOOGLE" as const,timeZone:"Asia/Seoul",connectionId:id,trigger:"SCHEDULED" as const,actorUserId:null};
}

test("Google collects two exact days daily, not a seven-day range; UTC/KST and calendar boundaries",async()=>env(async()=>{
  const a=scope(),b=scope(recheck);
  assert.deepEqual([a.fromDate,a.toDate,a.totalUnits],["2026-10-26","2026-10-26",1]);
  assert.deepEqual([b.fromDate,b.toDate,b.totalUnits],["2026-10-20","2026-10-20",1]);
  for (const [at,expected] of [["2026-10-31T17:04:00.000Z","2026-10-25"],["2026-12-31T17:04:00.000Z","2026-12-25"],["2028-03-06T17:04:00.000Z","2028-02-29"]]) {
    const s=scope(recheck,at,new Date(at));assert.equal(s.fromDate,expected);assert.equal(s.toDate,expected);
  }
  for(const d of [daily,recheck]) assert.throws(()=>occurrence(d,"META","Asia/Seoul",d.anchorAt,clock));
  assert.throws(()=>schedules({DAILY_SYNC_SCHEDULES:JSON.stringify([daily,{...daily,key:"duplicate-daily"}])}));
  assert.notEqual(a.requestKey,b.requestKey);
}));

test("queue scope and provider units reject expanded ranges, swapped dates and foreign identities; retries remain resumable",async()=>env(async()=>{
  for(const d of [daily,recheck]) {
    const s=scope(d);assert.doesNotThrow(()=>assertSyncRunScope(s,clock));
    assert.throws(()=>assertSyncRunScope({...s,fromDate:"2026-10-20",toDate:"2026-10-26"},clock));
    assert.throws(()=>assertSyncRunScope({...s,fromDate:d===daily?"2026-10-20":"2026-10-26",toDate:d===daily?"2026-10-20":"2026-10-26"},clock));
    assert.throws(()=>assertSyncRunScope({...s,connectionId:"foreign"},clock));
    const run={...s,fromDate:new Date(s.fromDate+"Z"),toDate:new Date(s.toDate+"Z"),connection,units:[{unitKey:s.fromDate}]};
    assert.doesNotThrow(()=>assertGoogleMetaRunScope(run,clock));
    assert.throws(()=>assertGoogleMetaRunScope({...run,units:[...run.units,...run.units]},clock));
    assert.doesNotThrow(()=>assertSyncRunShape(s,new Date("2026-10-28T17:05:00Z")));
    assert.doesNotThrow(()=>assertGoogleMetaRunScope(run,new Date("2026-10-28T17:05:00Z")));
  }
}));

test("D-7 can recheck a successful D-1 day, but duplicate same-purpose success remains rejected",async t=>env(async()=>{
  t.mock.timers.enable({apis:["Date"],now:Date.parse("2026-11-01T17:05:00Z")});
  try {
    const earlier=scope(daily),later=scope(recheck,"2026-11-01T17:04:00.000Z",new Date());
    assert.equal(earlier.toDate,later.toDate);
    let duplicate=false;let units:any[]=[];
    const rows=()=>[earlier,...(duplicate?[later]:[])].map(s=>({fromDate:new Date(s.fromDate+"Z"),toDate:new Date(s.toDate+"Z"),requestKey:s.requestKey,status:"SUCCEEDED"}));
    const db:any={sourceConnection:{findUnique:async()=>connection},syncRun:{findUnique:async()=>null,findMany:async()=>rows(),create:async({data}:any)=>({id:"new-run",...data})},runUnit:{createMany:async({data}:any)=>{units=data;}},securityAuditEvent:{create:async()=>{}},$queryRaw:async()=>[{id}],$transaction:async(fn:any)=>fn(db)};
    const service=new SyncFoundationService(db,{}as any);
    await service.queueRun(later);assert.deepEqual(units.map(u=>u.unitKey),["2026-10-26"]);
    duplicate=true;await assert.rejects(service.queueRun(later));
  } finally {t.mock.timers.reset();}
}));

test("scheduled service sends one unit to Google and reports the exact D-7 date",async t=>env(async()=>{
  t.mock.timers.enable({apis:["Date"],now:clock.getTime()});
  try {
    const s=scope(recheck);let queued:any;let executed=0;
    const db:any={sourceConnection:{findUnique:async()=>connection},syncRun:{findUnique:async()=>queued?{id:"new",status:"SUCCEEDED",units:[{unitKey:s.fromDate,status:"SUCCEEDED"}]}:null}};
    const foundation:any={queueRun:async(input:any)=>{queued=input;return{id:"new",status:"QUEUED"};},prepareScheduledRetry:async()=>true};
    const google:any={execute:async(runId:string,options:any)=>{executed++;assert.equal(runId,"new");assert.equal(options.maxUnits,1);}};
    const svc=new ScheduledSyncService(db,foundation,google,{}as any,{}as any,{}as any);
    const out=await svc.step({scheduleKey:recheck.key,scheduledFor:recheck.anchorAt});
    assert.equal(executed,1);assert.equal(queued.fromDate,"2026-10-20");assert.equal(queued.toDate,"2026-10-20");
    assert.equal(out.totalUnits,1);assert.equal(out.completedUnits,1);assert.equal(out.status,"SUCCEEDED");
  } finally {t.mock.timers.reset();}
}));

test("D-7 success cannot hide a missing earlier D-1 occurrence",async t=>env(async()=>{
  t.mock.timers.enable({apis:["Date"],now:Date.parse("2026-11-01T19:00:00Z")});
  try {
    const s=scope(recheck,"2026-11-01T17:04:00.000Z",new Date());
    const db:any={sourceConnection:{findUnique:async()=>connection},syncRun:{findMany:async({where}:any)=>where.requestKey.in.includes(s.requestKey)?[{id:"recheck",requestKey:s.requestKey,status:"SUCCEEDED",units:[{unitKey:s.fromDate,status:"SUCCEEDED"}]}]:[]},sourceCoverage:{findMany:async()=>[{source:"API",dataKind:"GOOGLE_CAMPAIGN",metricDate:new Date(s.fromDate+"Z"),lastSuccessRunId:"recheck",lastSuccessAt:new Date("2026-11-01T18:00:00Z"),state:"COMPLETE_NONZERO"}]}};
    const out=await new ScheduledSyncService(db,{}as any,{}as any,{}as any,{}as any,{}as any).warnings();
    assert(out.items.some(i=>i.scheduleKey===daily.key&&i.missingDates.includes("2026-10-26")));
    assert(!out.items.some(i=>i.scheduleKey===recheck.key&&i.scheduledFor===s.scheduledFor));
  } finally {t.mock.timers.reset();}
}));
