import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderFailure} from '../../../apps/api/src/daily-sync/bounded-request';
import {markMetaFailureStage} from '../../../apps/api/src/daily-sync/meta-failure-diagnostic';
import {MetaSyncRunnerService} from '../../../apps/api/src/daily-sync/meta-sync-runner.service';

test('scheduled MCP reconciliation retries fresh reads twice, then requires action; publish/auth/manual remain terminal',async()=>{
 const prior={...process.env},id='11111111-1111-4111-8111-111111111111',ref='vault://meta/22222222-2222-4222-8222-222222222222',expiresAt=new Date(Date.now()+20*86400000);
 Object.assign(process.env,{DAILY_SYNC_FEATURE_ENABLED:'true',DAILY_SYNC_META_TRANSPORT:'MCP',DAILY_SYNC_META_MCP_USE_CASE:'OWN_ACCOUNT_INTERNAL_REPORTING',DAILY_SYNC_META_CREDENTIAL_REF:ref,DAILY_SYNC_ALLOWED_ACCOUNTS:JSON.stringify(['META/123/default'])});
 const cases=[
  {attempts:0,stage:'META_NORMALIZE',code:'RECONCILIATION_FAILED',trigger:'SCHEDULED',retry:false,reason:'CAPTURE_INVALID'},
  {attempts:0,stage:'META_NORMALIZE',code:'RECONCILIATION_FAILED',trigger:'SCHEDULED',retry:false,reason:'NORMALIZATION_INVALID'},
  {attempts:0,stage:'META_NORMALIZE',code:'RECONCILIATION_FAILED',trigger:'SCHEDULED',retry:true},
  {attempts:1,stage:'META_NORMALIZE',code:'RECONCILIATION_FAILED',trigger:'SCHEDULED',retry:true},
  {attempts:2,stage:'META_NORMALIZE',code:'RECONCILIATION_FAILED',trigger:'SCHEDULED',retry:false},
  {attempts:0,stage:'META_PUBLISH',code:'RECONCILIATION_FAILED',trigger:'SCHEDULED',retry:false},
  {attempts:0,stage:'META_NORMALIZE',code:'PROVIDER_AUTH_REQUIRED',trigger:'SCHEDULED',retry:false},
  {attempts:0,stage:'META_NORMALIZE',code:'RECONCILIATION_FAILED',trigger:'MANUAL',retry:false}
 ];
 try{for(const c of cases){
  let failure:any,fetches=0,publishes=0,released=0;
  const connection={provider:'META',externalAccountId:'123',shopKey:'default',timeZone:'Asia/Seoul',currencyCode:'USD',credentialRef:ref,credentialExpiresAt:expiresAt,accessState:'READY',enabled:true};
  const units=c.trigger==='MANUAL'?[{unitKey:'2026-10-14',status:'QUEUED',attempts:c.attempts}]:Array.from({length:7},(_,i)=>({unitKey:`2026-10-${String(8+i).padStart(2,'0')}`,status:i===6?'QUEUED':'SUCCEEDED',attempts:c.attempts}));
  const run={id:'run',connectionId:id,connection,trigger:c.trigger,status:'PARTIAL',fromDate:new Date(c.trigger==='MANUAL'?'2026-10-14Z':'2026-10-08Z'),toDate:new Date('2026-10-14Z'),units};
  const prisma:any={syncRun:{findUnique:async()=>run,findUniqueOrThrow:async()=>run},sourceConnection:{findUnique:async()=>connection},sourcePolicy:{findMany:async()=>[{dataKind:'META_AD',primarySource:'API',version:1},{dataKind:'META_ADSET',primarySource:'API',version:1}]}};
  const foundation:any={claimRun:async()=>({connectionId:id,generation:1n,release:()=>released++}),beginScheduledUnit:async()=>{},failUnit:async(x:any)=>{failure=x;},finishRun:async()=>{}};
  const error=new ProviderFailure(c.code,false,null,null,c.reason??'BASIC_TOTALS');markMetaFailureStage(error,c.stage as any);
  const client:any={transport:'MCP',fetchDay:async()=>{fetches++;if(c.stage!=='META_PUBLISH')throw error;return {ads:[],adsets:[],currencyCode:'USD',timeZone:'Asia/Seoul',transport:'MCP',protocolVersion:'2025-06-18',settings:{actionReportTime:'MCP_PROVIDER_DEFAULT_UNVERIFIED',attributionWindows:[]},pageCount:4};}};
  const writer:any={publishMetaDay:async()=>{publishes++;throw error;}};
  const resolver:any={resolve:async()=>({token:'x'.repeat(50),credentialRef:ref,connectionId:id,accountId:'123',appId:'4474691502806219',authClass:'SYSTEM_USER',scopes:['ads_read','ads_mcp_management'],expiresAt,transport:'MCP',currencyCode:'USD',timeZone:'Asia/Seoul'})};
  await new MetaSyncRunnerService(prisma,foundation,client,writer,resolver).execute('run',c.trigger==='MANUAL'?undefined:{maxUnits:1,deadlineAt:Date.now()+65000});
  assert.equal(failure.actionRequired,!c.retry,JSON.stringify(c));assert.equal(failure.code,c.code);
  assert.equal(fetches,1);assert.equal(publishes,c.stage==='META_PUBLISH'?1:0);assert.equal(released,1);
 }}finally{for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);}
});
