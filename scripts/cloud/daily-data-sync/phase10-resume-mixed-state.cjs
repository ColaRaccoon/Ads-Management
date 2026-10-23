'use strict';
const assert=require('node:assert/strict');
function planStep(run,leaseExpiresAt,now,deadline){
  assert(Number.isFinite(now)&&Number.isFinite(deadline),'INVALID_STEP_CLOCK');
  assert(run&&Array.isArray(run.units)&&run.units.length>0,'MISSING_STEP_UNITS');
  if(run.status==='SUCCEEDED'){assert(run.units.every(u=>u.status==='SUCCEEDED'),'SUCCEEDED_WITH_PENDING_UNIT');return {kind:'COMPLETE'};}
  let leaseAt=now;if(leaseExpiresAt!==null&&leaseExpiresAt!==undefined){leaseAt=new Date(leaseExpiresAt).getTime();assert(Number.isFinite(leaseAt),'INVALID_STEP_TIMESTAMP');}
  if(run.units.every(u=>u.status==='SUCCEEDED'))return leaseAt>now?{kind:'WAIT',milliseconds:leaseAt-now}:{kind:'FINALIZE'};
  assert(now<deadline,'OCCURRENCE_DEADLINE_EXPIRED');
  assert.notEqual(run.status,'ACTION_REQUIRED','RUN_ACTION_REQUIRED');
  assert(run.units.some(u=>u.status!=='SUCCEEDED'&&u.attempts<3),'UNIT_ATTEMPTS_EXHAUSTED');
  let notBefore=now;
  for(const value of [leaseAt,run.nextAttemptAt])if(value!==null&&value!==undefined){const at=new Date(value).getTime();assert(Number.isFinite(at),'INVALID_STEP_TIMESTAMP');notBefore=Math.max(notBefore,at);}
  assert(notBefore<deadline,'BACKOFF_EXCEEDS_OCCURRENCE');
  return notBefore>now?{kind:'WAIT',milliseconds:notBefore-now}:{kind:'EXECUTE'};
}
async function advanceScheduledRun({snapshot,prepare,execute,deadline,now=Date.now,sleep,report=()=>{}}){
  for(let i=0;i<4000;i++){
    const state=await snapshot(),plan=planStep(state.run,state.leaseExpiresAt,now(),deadline);
    if(plan.kind==='COMPLETE')return {status:'SUCCEEDED',alreadyComplete:true};
    if(plan.kind==='WAIT'){report({kind:'SCHEDULED_BACKOFF_WAIT',milliseconds:plan.milliseconds});await sleep(Math.min(plan.milliseconds,1000));continue;}
    const ready=await prepare();
    if(ready){assert.equal(plan.kind,'EXECUTE','FINALIZE_RETURNED_READY');return execute();}
    const after=await snapshot(),afterPlan=planStep(after.run,after.leaseExpiresAt,now(),deadline);
    if(afterPlan.kind==='COMPLETE')return {status:'SUCCEEDED',completedFromDurableUnits:true};
    assert.equal(afterPlan.kind,'WAIT','UNEXPLAINED_PREPARE_REJECTION');
  }
  throw Error('STEP_OBSERVATION_LIMIT');
}
function measurementSnapshot({rows,collectionSpans,txSpans,resources,stage,complete=false}){
  assert(Array.isArray(rows)&&rows.length<=40,'INVALID_MEASUREMENT_COUNT');
  assert(new Set(rows.map(r=>r.index)).size===rows.length,'DUPLICATE_READ_INDEX');
  for(const r of rows){assert(Number.isInteger(r.index)&&r.index>=0&&r.index<40);assert(Number.isFinite(r.ms)&&r.ms>=0);assert(Number.isFinite(r.start)&&Number.isFinite(r.end)&&r.end>=r.start);}
  if(complete)assert.equal(rows.length,40,'INCOMPLETE_MEASUREMENT');
  const sorted=rows.map(r=>r.ms).sort((a,b)=>a-b);
  return {stage,complete,criteria:{requests:40,concurrency:4,p95Ms:5000,errors:0},rows:[...rows].sort((a,b)=>a.index-b.index),p95Ms:complete?sorted[Math.ceil(sorted.length*.95)-1]:null,collectionSpans:[...collectionSpans],txSpans:[...txSpans],resources:[...resources]};
}
module.exports={planStep,advanceScheduledRun,measurementSnapshot};
