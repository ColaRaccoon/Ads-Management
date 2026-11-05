import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncFoundationService} from '../../../apps/api/src/daily-sync/sync-foundation.service';
import {Prisma} from '@prisma/client';
import {metaSpendHierarchyEvidence,META_SPEND_WARNING} from '../../../apps/api/src/domain/meta-spend-reconciliation';

test('publish transaction preserves independent totals and persists the approved warning plus numeric evidence',async()=>{
 const keys=['DAILY_SYNC_FEATURE_ENABLED','DAILY_SYNC_ALLOWED_ACCOUNTS'];const before=keys.map(k=>process.env[k]);
 Object.assign(process.env,{DAILY_SYNC_FEATURE_ENABLED:'true',DAILY_SYNC_ALLOWED_ACCOUNTS:JSON.stringify(['META/123/default'])});
 try{
  const audits:any[]=[],coverage:any[]=[];const day=new Date('2026-10-14Z');
  const run:any={id:'run',connectionId:'connection',status:'RUNNING',deadlineAt:new Date(Date.now()+600000),actorUserId:null,requestKey:'synthetic',fromDate:day,toDate:day};
  const db:any={$queryRaw:async(q:any)=>q.sql.includes('access_state')?[{enabled:true,access_state:'READY',provider:'META',external_account_id:'123',shop_key:'default'}]:[{generation:1n,id:'connection'}],
   syncRun:{findUnique:async()=>run,update:async()=>({})},runUnit:{findUnique:async()=>({status:'RUNNING'}),upsert:async()=>({})},
   sourcePolicy:{findFirst:async()=>({version:1,primarySource:'API'})},
   sourceCoverage:{upsert:async(input:any)=>{coverage.push(input);}},securityAuditEvent:{create:async(input:any)=>{audits.push(input.data);return input.data;}}};
  db.$transaction=async(fn:any)=>fn(db);
  const row=(id:string,value:string,extra={})=>({id,amount_spent:{unit:'USD',value},...extra});
  const evidence=metaSpendHierarchyEvidence({ad:[row('3','106',{adset_id:'2',campaign_id:'1'})],adset:[row('2','100',{campaign_id:'1'})],campaign:[row('1','100')],ad_account:[row('0','100')]},'2026-10-14');
  await new SyncFoundationService(db,{} as any).publishUnit({runId:'run',generation:1n,unitKey:'2026-10-14',metricDate:day,metaSpendReconciliation:evidence,
   slices:[{dataKind:'META_AD',source:'API',policyVersion:1,fetchedCount:1,pageCount:4,complete:true,totalAmount:new Prisma.Decimal(106)},
    {dataKind:'META_ADSET',source:'API',policyVersion:1,fetchedCount:1,pageCount:4,complete:true,totalAmount:new Prisma.Decimal(100)}],writeRows:async()=>({META_AD:1,META_ADSET:1})});
  assert.equal(coverage.length,2);for(const c of coverage){assert.deepEqual(c.create.warningCodes,[META_SPEND_WARNING]);assert.deepEqual(c.update.warningCodes,[META_SPEND_WARNING]);}
  assert.equal(coverage[0].create.totalAmount.toString(),'106');assert.equal(coverage[1].create.totalAmount.toString(),'100');
  assert.deepEqual(audits[0].afterJson.metaSpendReconciliation,evidence);assert.deepEqual(audits[0].afterJson.warningCodes,[META_SPEND_WARNING]);
 }finally{keys.forEach((k,i)=>{if(before[i]===undefined)delete process.env[k];else process.env[k]=before[i];});}
});

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
