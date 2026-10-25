import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { occurrence, schedules } from "../../../apps/api/src/daily-sync/scheduled-occurrence";
import { assertSyncRunScope, assertSyncRunShape } from "../../../apps/api/src/daily-sync/sync-contract";
import { assertGoogleMetaRunScope } from "../../../apps/api/src/daily-sync/provider-run-scope";
import { SyncFoundationService } from "../../../apps/api/src/daily-sync/sync-foundation.service";
import { ScheduledSyncService } from "../../../apps/api/src/daily-sync/scheduled-sync.service";
import { SyncRunsController } from "../../../apps/api/src/daily-sync/daily-sync.controller";
const id="2155a401-bd86-4111-9280-3c95ed207546";
const daily={key:"prod-meta-daily",connectionId:id,anchorAt:"2026-10-25T17:03:00.000Z",windowMinutes:100,kind:"META_DAILY" as const};
const weekly={key:"prod-meta",connectionId:id,anchorAt:"2026-10-30T17:02:00.000Z",windowMinutes:90};
const clock=new Date("2026-10-30T17:04:00Z");
async function env(fn:()=>Promise<void>){const before={...process.env};Object.assign(process.env,{DAILY_SYNC_FEATURE_ENABLED:"true",DAILY_SYNC_SCHEDULE_ENABLED:"true",DAILY_SYNC_SCHEDULES:JSON.stringify([weekly,daily]),DAILY_SYNC_ALLOWED_ACCOUNTS:'["META/2138525300002203/default"]'});try{await fn();}finally{process.env=before;}}
const connection={id,provider:"META",externalAccountId:"2138525300002203",shopKey:"default",currencyCode:"USD",timeZone:"Asia/Seoul",accessState:"READY",enabled:true,credentialExpiresAt:new Date("2027-01-01Z")};
function slot(kind:"daily"|"weekly"){return occurrence(kind==="daily"?daily:weekly,"META","Asia/Seoul",kind==="daily"?"2026-10-30T17:03:00.000Z":weekly.anchorAt,clock);}
function scope(kind:"daily"|"weekly"):any{return {...slot(kind),provider:"META",timeZone:"Asia/Seoul",connectionId:id,trigger:"SCHEDULED",actorUserId:null};}

test("Meta daily and legacy weekly coexist with distinct exact scopes and stable weekly hashes",async()=>env(async()=>{
 assert.equal(schedules().length,2);const d=slot("daily"),w=slot("weekly");assert.equal(d.totalUnits,1);assert.equal(d.fromDate,"2026-10-30");assert.equal(d.toDate,"2026-10-30");assert.equal(w.totalUnits,7);assert.equal(w.fromDate,"2026-10-24");assert.equal(w.toDate,"2026-10-30");assert.notEqual(d.requestKey,w.requestKey);
 for(const invalid of [[daily,daily],[weekly,weekly],[{...daily,kind:"UNKNOWN"}], [{...daily,extra:true}]])assert.throws(()=>schedules({DAILY_SYNC_SCHEDULES:JSON.stringify(invalid)}));
 assert.throws(()=>occurrence(daily,"GOOGLE","Asia/Seoul","2026-10-30T17:03:00.000Z",clock));
 assert.throws(()=>occurrence(weekly,"META","Asia/Seoul","2026-10-31T17:02:00.000Z",new Date("2026-10-31T17:04Z")));
}));
test("queue and provider guards accept one daily or seven weekly dates; exchanged keys, foreign identities and malformed windows reject",async()=>env(async()=>{
 for(const kind of ["daily","weekly"] as const){const s=scope(kind);assert.doesNotThrow(()=>assertSyncRunScope(s,clock));const from=new Date(s.fromDate+"Z"),to=new Date(s.toDate+"Z");const days=kind==="daily"?1:7;
  const run:any={...s,fromDate:from,toDate:to,connection,units:Array.from({length:days},(_,i)=>({unitKey:new Date(from.getTime()+i*86400000).toISOString().slice(0,10)}))};assert.doesNotThrow(()=>assertGoogleMetaRunScope(run,clock));assert.throws(()=>assertGoogleMetaRunScope({...run,units:[]},clock));
 }
 assert.throws(()=>assertSyncRunShape({...scope("daily"),fromDate:"2026-10-24"},clock));
 assert.throws(()=>assertSyncRunShape({...scope("daily"),connectionId:"foreign"},clock));
 assert.throws(()=>assertSyncRunScope({...scope("daily"),toDate:"2026-10-31"},clock));
 assert.throws(()=>assertSyncRunShape({...scope("weekly"),fromDate:"2026-10-30"},clock));
}));
test("actual foundation permits cross-purpose overlap but rejects duplicate same-purpose success",async t=>env(async()=>{
 t.mock.timers.enable({apis:["Date"],now:clock.getTime()});try{for(const kind of ["daily","weekly"] as const){const other=scope(kind==="daily"?"weekly":"daily");let includeSame=false;
 const rows=()=>[other,...(includeSame?[scope(kind)]:[])].map(s=>({fromDate:new Date(s.fromDate+"Z"),toDate:new Date(s.toDate+"Z"),requestKey:s.requestKey,status:"SUCCEEDED"}));
 const db:any={sourceConnection:{findUnique:async()=>connection},syncRun:{findUnique:async()=>null,findMany:async()=>rows(),create:async({data}:any)=>({id:"new-run",...data})},runUnit:{createMany:async()=>{}},securityAuditEvent:{create:async()=>{}},$queryRaw:async()=>[{id}],$transaction:async(fn:any)=>fn(db)};
 const foundation=new SyncFoundationService(db,{}as any);await foundation.queueRun(scope(kind));includeSame=true;await assert.rejects(foundation.queueRun(scope(kind)));
 }}finally{t.mock.timers.reset();}
}));
test("scheduled status reports daily one unit and weekly seven without provider execution",async t=>env(async()=>{
 t.mock.timers.enable({apis:["Date"],now:clock.getTime()});try{for(const kind of ["daily","weekly"] as const){const s=slot(kind);const db:any={sourceConnection:{findUnique:async()=>connection},syncRun:{findUnique:async()=>({id:"run",status:"SUCCEEDED",units:Array.from({length:s.totalUnits},()=>({status:"SUCCEEDED"}))})}};const svc=new ScheduledSyncService(db,{}as any,{}as any,{}as any,{}as any,{}as any);const result=await svc.status({scheduleKey:s.definition.key,scheduledFor:s.scheduledFor});assert.equal(result.totalUnits,s.totalUnits);assert.equal(result.completedUnits,s.totalUnits);}}
 finally{t.mock.timers.reset();}
}));
test("manual Meta collection resolves dated FX before provider and FX failure never fetches ads",async()=>env(async()=>{
 const calls:string[]=[];const run:any={...scope("daily"),trigger:"MANUAL",fromDate:new Date("2026-10-24Z"),toDate:new Date("2026-10-24Z"),connection,units:[{unitKey:"2026-10-24",status:"QUEUED"}]};const db:any={syncRun:{findUnique:async()=>run}};
 const controller=new SyncRunsController({}as any,db,{}as any,{}as any,{execute:async()=>{calls.push("META");return{};}}as any,{ensureUsdKrwRatesForDates:async(dates:Date[])=>{assert.equal(dates[0].toISOString().slice(0,10),"2026-10-24");calls.push("FX");}}as any);
 await controller.executeMeta({id:"run"});assert.deepEqual(calls,["FX","META"]);
 calls.length=0;const failed=new SyncRunsController({}as any,db,{}as any,{}as any,{execute:async()=>calls.push("META")}as any,{ensureUsdKrwRatesForDates:async()=>{throw Error("synthetic FX failure");}}as any);await assert.rejects(failed.executeMeta({id:"run"}));assert.deepEqual(calls,[]);
}));

test("weekly success cannot hide missing daily executions in schedule warnings",async t=>env(async()=>{
 t.mock.timers.enable({apis:["Date"],now:Date.parse("2026-10-30T19:00:00Z")});try{
  const w=slot("weekly"),days=Array.from({length:7},(_,i)=>new Date(Date.parse(w.fromDate+"Z")+i*86400000).toISOString().slice(0,10));
  const db:any={sourceConnection:{findUnique:async()=>connection},syncRun:{findMany:async({where}:any)=>where.requestKey.in.includes(w.requestKey)?[{id:"weekly-run",requestKey:w.requestKey,status:"SUCCEEDED",units:days.map(unitKey=>({unitKey,status:"SUCCEEDED"}))}]:[]},sourceCoverage:{findMany:async()=>days.flatMap(day=>["META_AD","META_ADSET"].map(dataKind=>({dataKind,source:"API",metricDate:new Date(day+"Z"),state:"COMPLETE_NONZERO",lastSuccessRunId:"weekly-run",lastSuccessAt:new Date("2026-10-30T18:59Z")})))}};
  const svc=new ScheduledSyncService(db,{}as any,{}as any,{}as any,{}as any,{}as any);const result=await svc.warnings();
  assert(result.items.some(i=>i.scheduleKey===daily.key&&i.missingDates.includes("2026-10-30")));assert.equal(result.items.some(i=>i.scheduleKey===weekly.key),false);
 }finally{t.mock.timers.reset();}
}));
