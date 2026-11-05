import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncFoundationService} from '../../../apps/api/src/daily-sync/sync-foundation.service';

test('actual failUnit persists bounded check evidence and retry decision in the audit transaction',async()=>{
 const before=process.env.DAILY_SYNC_FEATURE_ENABLED;process.env.DAILY_SYNC_FEATURE_ENABLED='true';
 try{for(const malformed of [false,true]){
  const audits:any[]=[],coverage:any[]=[];
  const run:any={id:'run',connectionId:'connection',status:'RUNNING',actorUserId:null,requestKey:'synthetic-request',fromDate:new Date('2026-10-14Z'),toDate:new Date('2026-10-14Z')};
  const db:any={$queryRaw:async()=>[{generation:1n}],syncRun:{findUnique:async()=>run,update:async()=>({})},
   runUnit:{findUnique:async()=>({status:'RUNNING'}),upsert:async()=>({})},sourceConnection:{findUnique:async()=>({provider:'META'})},
   sourceCoverage:{upsert:async(input:any)=>{coverage.push(input);}},securityAuditEvent:{create:async(input:any)=>{audits.push(input.data);return input.data;}}};
  db.$transaction=async(fn:any)=>fn(db);
  const proof={version:1,check:{condition:'HIERARCHY_METRIC_TOTAL',level:'ad_account',metric:'impressions',expected:'10',observed:'9',delta:'-1'}};
  await new SyncFoundationService(db,{} as any).failUnit({runId:'run',generation:1n,unitKey:'2026-10-14',metricDate:new Date('2026-10-14Z'),
   dataKinds:['META_AD','META_ADSET'],source:'API',code:'RECONCILIATION_FAILED',actionRequired:false,
   diagnosticCode:'META_NORMALIZE_PROVIDER_BASIC_TOTALS',metaEvidence:malformed?{...proof,privateText:'SYNTHETIC_PRIVATE'}:proof,metaAttempt:1,metaRetryDecision:'RETRY_SCHEDULED'});
  assert.equal(coverage.length,2);assert.equal(audits.length,1);
  assert.equal(audits[0].action,'SYNC_UNIT_FAILED');assert.equal(audits[0].afterJson.retryDecision,'RETRY_SCHEDULED');
  assert.equal(audits[0].afterJson.attempt,1);assert.equal(audits[0].afterJson.maxAttempts,3);
  if(malformed)assert.equal(audits[0].afterJson.metaEvidence,undefined);else assert.deepEqual(audits[0].afterJson.metaEvidence,proof);
  assert(!JSON.stringify(audits).includes('SYNTHETIC_PRIVATE'));
 }}finally{if(before===undefined)delete process.env.DAILY_SYNC_FEATURE_ENABLED;else process.env.DAILY_SYNC_FEATURE_ENABLED=before;}
});
