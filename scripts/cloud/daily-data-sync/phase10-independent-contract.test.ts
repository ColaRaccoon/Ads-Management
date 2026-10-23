// Contract challenges only: synthetic clock, identity and provider metadata; no I/O.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Reflector} from '@nestjs/core';
import {SourceProvider,SyncTrigger,SyncRunStatus} from '@prisma/client';
import {assertSyncRunScope,assertSyncRunShape,assertScheduledWindowCadence} from '../../../apps/api/src/daily-sync/sync-contract';
import {occurrence} from '../../../apps/api/src/daily-sync/scheduled-occurrence';
import {allowedMetaScopesForTransport,resolveMetaCredential} from '../../../apps/api/src/daily-sync/meta-credential-resolver';
import {MachineSyncGuard,machineSecrets} from '../../../apps/api/src/auth/machine-sync.guard';
import {MACHINE_SYNC_ROUTE} from '../../../apps/api/src/auth/route-decorators';

function withEnv<T>(patch:Record<string,string|undefined>,action:()=>T):T {
 const before=Object.fromEntries(Object.keys(patch).map(k=>[k,process.env[k]]));
 try {for(const [k,v]of Object.entries(patch))v===undefined?delete process.env[k]:process.env[k]=v;return action();}
 finally{for(const[k,v]of Object.entries(before))v===undefined?delete process.env[k]:process.env[k]=v;}
}
const now=new Date('2026-10-01T00:30:00.000Z');
const input=(provider:SourceProvider,fromDate:string,toDate:string,trigger:SyncTrigger=SyncTrigger.SCHEDULED,timeZone='Asia/Seoul')=>({provider,fromDate,toDate,trigger,timeZone,actorUserId:null});
test('manual completed-day scope uses account local midnight, never the host date',()=>{
 assert.doesNotThrow(()=>assertSyncRunScope(input('CAFE24','2026-09-30','2026-09-30','MANUAL'),now));
 assert.throws(()=>assertSyncRunScope(input('CAFE24','2026-10-01','2026-10-01','MANUAL'),now));
 assert.throws(()=>assertSyncRunScope(input('GOOGLE','2026-09-30','2026-09-30','MANUAL','America/Los_Angeles'),now));
 assert.doesNotThrow(()=>assertSyncRunScope(input('GOOGLE','2026-09-29','2026-09-29','MANUAL','America/Los_Angeles'),now));
 assert.throws(()=>assertSyncRunScope(input('META','2026-09-28','2026-09-29','MANUAL'),now));
});
test('new weekly schedule rejects catch-up windows but an existing exact range remains resumable',()=>{
 for(const p of [SourceProvider.GOOGLE,SourceProvider.META]){
  assert.doesNotThrow(()=>assertSyncRunScope(input(p,'2026-09-24','2026-09-30'),now));
  assert.throws(()=>assertSyncRunScope(input(p,'2026-09-23','2026-09-29'),now));
  assert.throws(()=>assertSyncRunScope(input(p,'2026-09-01','2026-09-30'),now));
  assert.doesNotThrow(()=>assertSyncRunShape(input(p,'2026-09-23','2026-09-29'),now));
 }
 assert.throws(()=>assertSyncRunScope(input('CAFE24','2026-09-24','2026-09-30'),now));
});
test('only an identical FAILED scheduled window may be replaced; ACTION_REQUIRED cannot auto retry',()=>{
 const range={fromDate:'2026-09-24',toDate:'2026-09-30'};
 for(const status of Object.values(SyncRunStatus)){
  const old={fromDate:new Date(range.fromDate),toDate:new Date(range.toDate),status};
  if(status==='FAILED')assert.equal(assertScheduledWindowCadence(range,[old]),true);
  else assert.throws(()=>assertScheduledWindowCadence(range,[old]));
 }
});
test('real schedule formula crosses month end without adding old dates and reserves the Storage window',()=>{
 const c={key:'phase10-cafe',connectionId:'00000000-0000-4000-8000-000000000001',anchorAt:'2026-09-30T17:00:00.000Z',windowMinutes:110};
 const out=occurrence(c,SourceProvider.CAFE24,'Asia/Seoul',c.anchorAt,now);
 assert.equal(out.fromDate,'2026-09-30');assert.equal(out.toDate,'2026-09-30');
 assert.throws(()=>occurrence({...c,windowMinutes:120,anchorAt:'2026-09-30T17:01:00.000Z'},SourceProvider.CAFE24,'Asia/Seoul','2026-09-30T17:01:00.000Z',now));
 const m={...c,key:'phase10-meta',anchorAt:'2026-09-30T17:02:00.000Z',windowMinutes:90};
 const meta=occurrence(m,SourceProvider.META,'Asia/Seoul',m.anchorAt,now);
 assert.equal(meta.fromDate,'2026-09-24');assert.equal(meta.toDate,'2026-09-30');
 assert.throws(()=>occurrence(m,SourceProvider.META,'Asia/Seoul','2026-10-01T17:02:00.000Z',new Date('2026-10-01T18:00:00.000Z')));
});
test('past accelerated occurrence cannot open against a production target',()=>{
 const def={key:'phase08-meta',connectionId:'1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6',anchorAt:'2026-10-16T03:30:00.000Z',windowMinutes:90};
 withEnv({SUPABASE_URL:'https://iygjmosbelbosfxidqxv.supabase.co',SUPABASE_DATABASE_PROJECT_REF:'iygjmosbelbosfxidqxv'},()=>assert.throws(()=>occurrence(def,SourceProvider.META,'Asia/Seoul',def.anchorAt,new Date('2026-10-16T03:31:00.000Z'))));
});
test('MCP scopes cannot cross to Graph and credentials require strictly more than seven days',async()=>{
 assert.equal(allowedMetaScopesForTransport(['ads_read','ads_mcp_management'],'MCP'),true);
 assert.equal(allowedMetaScopesForTransport(['ads_read','ads_mcp_management'],'GRAPH'),false);
 assert.equal(allowedMetaScopesForTransport(['ads_read','ads_mcp_management','ads_management'],'MCP'),false);
 const binding={credentialRef:'vault://meta/00000000-0000-4000-8000-000000000001',connectionId:'00000000-0000-4000-8000-000000000002',accountId:'2138525300002203',transport:'MCP' as const};
 const meta={...binding,token:'SyntheticCredentialA1234567890'.repeat(3),appId:'4474691502806219',authClass:'SYSTEM_USER' as const,scopes:['ads_read','ads_mcp_management'],currencyCode:'USD',timeZone:'Asia/Seoul'};
 await assert.rejects(resolveMetaCredential({resolve:async()=>({...meta,expiresAt:new Date(now.getTime()+7*86400000)})},binding,now));
 const accepted=await resolveMetaCredential({resolve:async()=>({...meta,expiresAt:new Date(now.getTime()+7*86400000+1)})},binding,now);
 assert.equal(accepted.transport,'MCP');
 await assert.rejects(resolveMetaCredential({resolve:async()=>({...meta,accountId:'1',expiresAt:new Date(now.getTime()+8*86400000)})},binding,now));
});
test('machine token does not authorize the wrong target, a disabled collector, or a shared secret',()=>{
 const secret='SYNTHETIC-aA0bB1cC2dD3eE4fF5gG6hH7iI8jJ9kK-LmnOpqRstUvWxyz';
 const env={DAILY_SYNC_MACHINE_TOKEN:secret,DAILY_SYNC_FEATURE_ENABLED:'true',RUNTIME_API_TARGET_ID:'phase10-isolated',INTERNAL_PROBE_TOKEN:undefined};
 const guard=new MachineSyncGuard({get:()=>MACHINE_SYNC_ROUTE} as unknown as Reflector);
 const context=(target:string)=>({getHandler:()=>()=>{},switchToHttp:()=>({getRequest:()=>({get:(k:string)=>k==='x-daily-sync-token'?secret:k==='x-daily-sync-target'?target:undefined})})} as any);
 withEnv(env,()=>{assert.equal(guard.canActivate(context('phase10-isolated')),true);assert.throws(()=>guard.canActivate(context('production')));});
 withEnv({...env,DAILY_SYNC_FEATURE_ENABLED:'false'},()=>assert.throws(()=>guard.canActivate(context('phase10-isolated'))));
 assert.equal(machineSecrets({...env,INTERNAL_PROBE_TOKEN:secret}),null);
 assert.equal(machineSecrets({...env,DAILY_SYNC_MACHINE_TOKEN_PREVIOUS:secret+'Unique',DAILY_SYNC_MACHINE_PREVIOUS_EXPIRES_AT:new Date(now.getTime()+86400001).toISOString()},now.getTime())!.previous,null);
});
