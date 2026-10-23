import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Prisma} from '@prisma/client';
import {safeMetaRuntimeFailureDiagnostic,markMetaFailureStage} from '../../../apps/api/src/daily-sync/meta-failure-diagnostic';
import {MetaMcpWireFailure} from '../../../apps/api/src/daily-sync/meta-mcp-wire-reader';
import {MetaSyncRunnerService} from '../../../apps/api/src/daily-sync/meta-sync-runner.service';
const known=(code:string)=>new Prisma.PrismaClientKnownRequestError('SYNTHETIC_PRIVATE',{code,clientVersion:'synthetic',meta:{secret:'SYNTHETIC_PRIVATE'}});
test('only typed provider/Prisma exceptions and closed stages emit diagnostics, never raw text or counterfeit properties',()=>{
 assert.equal(safeMetaRuntimeFailureDiagnostic(new Error('SYNTHETIC_PRIVATE'),'SYNTHETIC_PRIVATE' as any),'META_BINDING_OTHER');
 assert.equal(safeMetaRuntimeFailureDiagnostic(new Prisma.PrismaClientValidationError('SYNTHETIC_PRIVATE',{clientVersion:'synthetic'}),'META_PUBLISH'),'META_PUBLISH_PRISMA_VALIDATION');
 assert.equal(safeMetaRuntimeFailureDiagnostic(known('P2028'),'META_PUBLISH'),'META_PUBLISH_PRISMA_P2028');
 assert.equal(safeMetaRuntimeFailureDiagnostic(new Prisma.PrismaClientInitializationError('SYNTHETIC_PRIVATE','synthetic','P1011'),'META_BINDING'),'META_BINDING_PRISMA_P1011');
 for(const error of [{code:'P2028',message:'SYNTHETIC_PRIVATE'},{safeCode:'HTTP_UNAVAILABLE'},known('P9999'),new Error('SYNTHETIC_PRIVATE'),null])assert.equal(safeMetaRuntimeFailureDiagnostic(error,'META_PUBLISH'),'META_PUBLISH_OTHER');
 const wire=new MetaMcpWireFailure('HTTP_UNAVAILABLE',4);assert.equal(safeMetaRuntimeFailureDiagnostic(wire,'META_FETCH'),'META_FETCH_WIRE_HTTP_UNAVAILABLE');
 markMetaFailureStage(wire,'META_NORMALIZE');assert.equal(safeMetaRuntimeFailureDiagnostic(wire,'META_FETCH'),'META_NORMALIZE_WIRE_HTTP_UNAVAILABLE');
 assert(!JSON.stringify(wire).includes('SYNTHETIC_PRIVATE'));
});
test('actual runner distinguishes wire read versus canonical publish failures without re-reading successful units',async()=>{
 const original={...process.env};const id='11111111-1111-4111-8111-111111111111',ref='vault://meta/22222222-2222-4222-8222-222222222222',expiresAt=new Date(Date.now()+20*86400000);
 Object.assign(process.env,{DAILY_SYNC_FEATURE_ENABLED:'true',DAILY_SYNC_META_TRANSPORT:'MCP',DAILY_SYNC_META_MCP_USE_CASE:'OWN_ACCOUNT_INTERNAL_REPORTING',DAILY_SYNC_META_CREDENTIAL_REF:ref,DAILY_SYNC_ALLOWED_ACCOUNTS:JSON.stringify(['META/123/default'])});
 try{for(const mode of ['wire','publish','normalization']){
 let fetches=0,publishes=0,fail:any,started=0,released=0;
 const connection={provider:'META',externalAccountId:'123',shopKey:'default',timeZone:'Asia/Seoul',currencyCode:'USD',credentialRef:ref,credentialExpiresAt:expiresAt,accessState:'READY',enabled:true};
 const units=Array.from({length:7},(_,i)=>({unitKey:`2026-10-${String(8+i).padStart(2,'0')}`,status:i===6?'QUEUED':'SUCCEEDED',attempts:i===6?0:1}));
 const run={id:'run',connectionId:id,connection,trigger:'SCHEDULED',status:'PARTIAL',fromDate:new Date('2026-10-08Z'),toDate:new Date('2026-10-14Z'),units};
 const prisma:any={syncRun:{findUnique:async()=>run,findUniqueOrThrow:async()=>({status:'FAILED'})},sourceConnection:{findUnique:async()=>connection},sourcePolicy:{findMany:async()=>[{dataKind:'META_AD',primarySource:'API',version:1},{dataKind:'META_ADSET',primarySource:'API',version:1}]}};
 const foundation:any={claimRun:async()=>({connectionId:id,generation:1n,release:()=>{released++;}}),beginScheduledUnit:async()=>{started++;},failUnit:async(x:any)=>{fail=x;},finishRun:async()=>{}};
 const client:any={transport:'MCP',fetchDay:async()=>{fetches++;if(mode==='wire')throw new MetaMcpWireFailure('HTTP_UNAVAILABLE',9);if(mode==='normalization'){const e=known('P2028');markMetaFailureStage(e,'META_NORMALIZE');throw e;}return {ads:[],adsets:[],currencyCode:'USD',timeZone:'Asia/Seoul',transport:'MCP',protocolVersion:'2025-06-18',settings:{actionReportTime:'MCP_PROVIDER_DEFAULT_UNVERIFIED',attributionWindows:[]},pageCount:1};}};
 const writer:any={publishMetaDay:async()=>{publishes++;throw known('P2028');}};
 const resolver:any={resolve:async()=>({token:'x'.repeat(50),credentialRef:ref,connectionId:id,accountId:'123',appId:'4474691502806219',authClass:'SYSTEM_USER',scopes:['ads_read','ads_mcp_management'],expiresAt,transport:'MCP',currencyCode:'USD',timeZone:'Asia/Seoul'})};
 await new MetaSyncRunnerService(prisma,foundation,client,writer,resolver).execute('run',{maxUnits:1,deadlineAt:Date.now()+55000});
 assert.equal(fetches,1);assert.equal(started,1);assert.equal(released,1);assert.equal(publishes,mode==='publish'?1:0);assert.equal(fail.unitKey,'2026-10-14');assert.equal(fail.code,'PROVIDER_UNAVAILABLE');
 assert.equal(fail.diagnosticCode,mode==='wire'?'META_FETCH_WIRE_HTTP_UNAVAILABLE':mode==='publish'?'META_PUBLISH_PRISMA_P2028':'META_NORMALIZE_PRISMA_P2028');assert(!JSON.stringify(fail,(_,v)=>typeof v==='bigint'?String(v):v).includes('SYNTHETIC_PRIVATE'));
 }}finally{for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);}
});
