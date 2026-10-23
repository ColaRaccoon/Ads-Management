import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {diagnosePhase10ArchivedCafe} from './phase10-api-cafe-diagnostic.mjs';
const id='0c35defe-45fc-4a54-bc79-704df7bca5b1',run='a4f7bcea-bfa8-4699-b3f0-34e118889710',day='2026-10-17';
function challenge({statePatch={},expiry=new Date(Date.now()+3600000),response}={}){
 const env={SUPABASE_DATABASE_PROJECT_REF:'ehnfrrmbkvlsbpvqcvkr',SUPABASE_DATABASE_SCHEMA:'phase08_meta_ads',SUPABASE_DATABASE_RUNTIME_USER:'phase08_runtime',DAILY_SYNC_CHECKPOINT_KEY_B64:Buffer.alloc(32,7).toString('base64'),DAILY_SYNC_CREDENTIAL_KEY_V1:Buffer.alloc(32,8).toString('base64'),DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES:'["N00"]',DAILY_SYNC_CAFE24_APP_API_VERSION:'2026-09-01',DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT:'2026-10-01',DAILY_SYNC_CAFE24_SELLER_DROPDOWN:'true',DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT:'2026-10-01'};
 const seal=(text,key,aad)=>{const iv=Buffer.alloc(12,3),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'base64'),iv);cipher.setAAD(Buffer.from(aad));return {iv,ciphertext:Buffer.concat([cipher.update(text),cipher.final()]),auth_tag:cipher.getAuthTag()};};
 const state={version:1,connectionId:id,day,startedAt:'2026-10-18T01:00:00.000Z',stage:'ITEMS_FIRST',count:1,pages:1,first:[{order_id:'SYNTHETIC-PRIVATE-ORDER',shop_no:1,order_date:'2026-10-17T12:00:00+09:00',payment_amount:'100',currency:'KRW',order_status:'N00'}],second:[],items:[],cursor:0,verifiedItems:0,...statePatch};
 let calls=0,credentialReads=0;
 const tx={$executeRawUnsafe:async s=>assert.match(s,/^SET /),$queryRawUnsafe:async s=>{
  if(s.startsWith('SELECT current_database'))return[{database:'postgres',role:'phase08_runtime',schema:'phase08_meta_ads',readonly:'on'}];
  if(s.includes('FROM sync_runs'))return[{revision:6,expires_at:new Date('2026-10-17T19:00:19.119Z'),...seal(JSON.stringify(state).padEnd(126852,' '),env.DAILY_SYNC_CHECKPOINT_KEY_B64,`${id}:${run}:${day}`)}];
  assert(s.includes("kind='CAFE24_ACCESS'"));credentialReads++;return[{key_version:1,expires_at:expiry,...seal('SYNTHETIC-PRIVATE-TOKEN-12345678901234567890',env.DAILY_SYNC_CREDENTIAL_KEY_V1,`${id}:CAFE24_ACCESS:1`)}];
 }};
 return {input:{projectRef:'ehnfrrmbkvlsbpvqcvkr',classification:'CURRENT_SINGLE_ITEM_READONLY',env,databaseUrl:'postgresql://phase08_runtime.ehnfrrmbkvlsbpvqcvkr:synthetic@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?schema=phase08_meta_ads&sslmode=verify-full'},options:{factory:()=>({$transaction:fn=>fn(tx),$disconnect:async()=>{}}),request:async()=>{calls++;return response();}},calls:()=>calls,credentialReads:()=>credentialReads};
}
const safeFailure=error=>{assert(!JSON.stringify(error.safeDiagnostic).includes('SYNTHETIC-PRIVATE'));assert.equal(error.safeDiagnostic.databaseWrites,0);return true;};
test('independent diagnostic rejects arbitrary output stage before reading any credential',async()=>{
 const f=challenge({statePatch:{stage:'SYNTHETIC-PRIVATE-OUTPUT'}});await assert.rejects(diagnosePhase10ArchivedCafe(f.input,f.options),safeFailure);assert.equal(f.calls(),0);assert.equal(f.credentialReads(),0);
});
test('independent diagnostic rejects null and invalid access expiry without a provider call',async()=>{
 for(const expiry of [null,new Date(NaN),new Date(Date.now()+119000)]){const f=challenge({expiry});await assert.rejects(diagnosePhase10ArchivedCafe(f.input,f.options),safeFailure);assert.equal(f.calls(),0);}
});
test('independent diagnostic cancels an oversized body while streaming',async()=>{
 let cancelled=false;
 const f=challenge({response:()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(2097153));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});
 await assert.rejects(diagnosePhase10ArchivedCafe(f.input,f.options),safeFailure);assert.equal(f.calls(),1);assert.equal(cancelled,true);
});
test('independent diagnostic cancels tiny unbounded chunks at the fixed chunk limit',async()=>{
 let cancelled=false;
 const f=challenge({response:()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([32]));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});
 await assert.rejects(diagnosePhase10ArchivedCafe(f.input,f.options),safeFailure);assert.equal(f.calls(),1);assert.equal(cancelled,true);
});
