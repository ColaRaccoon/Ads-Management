import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import {cafe24ScheduledDayActivated,reconcileCafe24ScheduledDay} from "../../../apps/api/src/daily-sync/cafe24-scheduled-activation";
import {SourceConnectionsService} from "../../../apps/api/src/daily-sync/source-connections.service";
import {ScheduledSyncService} from "../../../apps/api/src/daily-sync/scheduled-sync.service";
const id="0c35defe-45fc-4a54-bc79-704df7bca5b1",runId="29c80f73-2f63-43fb-9524-1a4fa82f24bb",day="2026-10-14",date=new Date(`${day}T00:00:00Z`);
function mock() {
  const state:any={policy:{primarySource:"API",version:2,fromDate:date,toDate:new Date("2026-10-15Z"),couponInputSource:"UNKNOWN",reason:"CAFE24_SCHEDULED_API_ONLY"},coverage:{source:"API",state:"COMPLETE_NONZERO",rowCount:2,lastSuccessRunId:runId,lastAttemptRunId:runId,lastSuccessAt:new Date(),warningCodes:[],reconciliationStatus:"CAFE24_API_ONLY_VERIFIED"},valid:2n,version:1,promotions:0};
  const run={id:runId,connectionId:id,trigger:"SCHEDULED",status:"SUCCEEDED",fromDate:date,toDate:date,units:[{status:"SUCCEEDED",unitKey:day,publishedCount:2}]};
  const db:any={sourcePolicy:{findMany:async()=>[state.policy]},sourceCoverage:{findUnique:async()=>state.coverage},securityAuditEvent:{findMany:async()=>[{afterJson:{sourcePolicyVersion:state.version}}]},syncRun:{findUnique:async()=>run},$queryRaw:async()=>[{rows:2n,valid:state.valid,versions:2n}],$executeRaw:async()=>0};db.$transaction=async(fn:any)=>fn(db);
  return {db,state};
}
test("scheduled API success requires exact committed policy/coverage/unit/current links; shadow never reports success",async()=>{
  for(const mode of ["success","shadow","wrong-run","broken-links","policy-version","warning","wide-policy"]) {
    const {db,state}=mock();
    if(mode==="shadow"){state.policy.primarySource="CSV";state.coverage.reconciliationStatus="CAFE24_SOURCE_ACTIVATION_REQUIRED";}
    if(mode==="wrong-run")state.coverage.lastSuccessRunId="foreign";
    if(mode==="broken-links")state.valid=1n;
    if(mode==="policy-version")state.version=3;
    if(mode==="warning")state.coverage.warningCodes=["CAFE24_SHADOW_NOT_PRIMARY"];
    if(mode==="wide-policy")state.policy.toDate=null;
    assert.equal(await cafe24ScheduledDayActivated(db,id,day,runId),mode==="success");
  }
});
test("expired successful shadow reconciles only stored same-day promotion, response loss preserves success and stale policy cannot promote",async t=>{
  t.mock.timers.enable({apis:["Date"],now:new Date("2026-10-15T04:00:00Z").getTime()});
  const before={...process.env};Object.assign(process.env,{DAILY_SYNC_FEATURE_ENABLED:"true",DAILY_SYNC_SCHEDULE_ENABLED:"true",DAILY_SYNC_CAFE24_SCHEDULED_API_ONLY_ACTIVATION_ENABLED:"true",DAILY_SYNC_CAFE24_SCHEDULED_COUPON_INPUT_SOURCE:"UNKNOWN",DAILY_SYNC_ALLOWED_ACCOUNTS:'["CAFE24/didadi0729/shop1"]',DAILY_SYNC_SCHEDULES:JSON.stringify([{key:"cafe24-real",connectionId:id,anchorAt:"2026-10-14T17:00:00.000Z",windowMinutes:90}])});
  try {
    const {db,state}=mock();state.policy.primarySource="CSV";state.policy.version=1;state.coverage.reconciliationStatus="CAFE24_SOURCE_ACTIVATION_REQUIRED";
    db.sourceConnection={findUnique:async()=>({id,provider:"CAFE24",externalAccountId:"didadi0729",shopKey:"shop1",timeZone:"Asia/Seoul"})};
    let provider=0;
    t.mock.method(SourceConnectionsService.prototype,"activateCafe24Day",async(_id:any,input:any)=>{
      state.promotions++;assert.equal(input.day,day);assert.equal(input.expectedPolicyVersion,1);state.policy.primarySource="API";state.policy.version=2;state.coverage.reconciliationStatus="CAFE24_API_ONLY_VERIFIED";throw new Error("SYNTHETIC_RESPONSE_LOSS");
    });
    const service=new ScheduledSyncService(db,{queueRun:async()=>{throw new Error("NO_QUEUE");}} as any,{execute:async()=>{provider++;}} as any,{execute:async()=>{provider++;}} as any,{execute:async()=>{provider++;}} as any);
    const result=await service.step({scheduleKey:"cafe24-real",scheduledFor:"2026-10-14T17:00:00.000Z"});assert.equal(result.status,"SUCCEEDED");assert.equal(provider,0);assert.equal(state.promotions,1);
    state.policy.primarySource="CSV";state.policy.version=3;state.coverage.reconciliationStatus="CAFE24_SOURCE_ACTIVATION_REQUIRED";
    assert.equal(await reconcileCafe24ScheduledDay(db,id,day,runId),false);assert.equal(state.promotions,1);
    const failure=await service.status({scheduleKey:"cafe24-real",scheduledFor:"2026-10-14T17:00:00.000Z"});assert.equal(failure.status,"ACTION_REQUIRED");assert.equal(failure.safeErrorCode,"SOURCE_SELECTION_REQUIRED");
  } finally {process.env=before;}
});
