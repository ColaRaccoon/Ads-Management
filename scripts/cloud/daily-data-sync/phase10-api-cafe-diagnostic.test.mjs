import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {diagnosePhase10ArchivedCafe} from './phase10-api-cafe-diagnostic.mjs';
const ID='0c35defe-45fc-4a54-bc79-704df7bca5b1',RUN='a4f7bcea-bfa8-4699-b3f0-34e118889710',DAY='2026-10-17';
const env={SUPABASE_DATABASE_PROJECT_REF:'ehnfrrmbkvlsbpvqcvkr',SUPABASE_DATABASE_SCHEMA:'phase08_meta_ads',SUPABASE_DATABASE_RUNTIME_USER:'phase08_runtime',
 DAILY_SYNC_CHECKPOINT_KEY_B64:Buffer.alloc(32,7).toString('base64'),DAILY_SYNC_CREDENTIAL_KEY_V1:Buffer.alloc(32,8).toString('base64'),
 DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES:'["N00","N20"]',DAILY_SYNC_CAFE24_APP_API_VERSION:'2026-09-01',DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT:'2026-10-01',DAILY_SYNC_CAFE24_SELLER_DROPDOWN:'true',DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT:'2026-10-01'};
function encrypt(text,key,aad){const iv=Buffer.alloc(12,4),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'base64'),iv);cipher.setAAD(Buffer.from(aad));return{ciphertext:Buffer.concat([cipher.update(text),cipher.final()]),iv,auth_tag:cipher.getAuthTag()};}
function fixture(mode='ARCHIVED_CHECKPOINT_READONLY',bad=false){
 const order={order_id:'PRIVATE-ORDER',shop_no:1,order_date:'2026-10-17T12:00:00+09:00',payment_amount:'100',currency:'KRW',order_status:'N00'};
 const saved={version:1,connectionId:ID,day:DAY,startedAt:'2026-10-18T01:00:00.000Z',stage:'ITEMS_FIRST',count:1,pages:1,first:[order],second:[],items:[],cursor:0,verifiedItems:0};
 const access='PRIVATE_ACCESS_TOKEN_12345678901234567890123456789';let active=false,calls=0,credentialReads=0;
 const tx={$executeRawUnsafe:async sql=>assert.match(sql,/^SET (TRANSACTION READ ONLY|LOCAL statement_timeout)/),$queryRawUnsafe:async sql=>{
  if(sql.startsWith('SELECT current_database'))return[{database:'postgres',role:bad?'foreign':'phase08_runtime',schema:'phase08_meta_ads',readonly:'on'}];
  if(sql.includes('FROM sync_runs'))return[{revision:6,expires_at:new Date('2026-10-17T19:00:19.119Z'),...encrypt(JSON.stringify(saved).padEnd(126852,' '),env.DAILY_SYNC_CHECKPOINT_KEY_B64,`${ID}:${RUN}:${DAY}`)}];
  assert(sql.includes("kind='CAFE24_ACCESS'"));assert(!sql.includes('REFRESH'));credentialReads++;return[{key_version:1,expires_at:new Date(Date.now()+3600000),...encrypt(access,env.DAILY_SYNC_CREDENTIAL_KEY_V1,`${ID}:CAFE24_ACCESS:1`)}];}};
 const factory=()=>({$transaction:async fn=>{active=true;try{return await fn(tx);}finally{active=false;}},$disconnect:async()=>{}});
 const request=async(url,options)=>{assert.equal(active,false);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,`Bearer ${access}`);assert.match(String(url),/\/orders\/PRIVATE-ORDER\/items\?/);calls++;
  return Response.json({items:[{order_item_code:'PRIVATE-LINE',product_no:'1',product_name:'PRIVATE-NAME',option_value:'PRIVATE-OPTION',quantity:'1',product_price:'100',order_status:'N10'}]});};
 const input={projectRef:'ehnfrrmbkvlsbpvqcvkr',classification:mode,env:{...env},databaseUrl:'postgresql://phase08_runtime.ehnfrrmbkvlsbpvqcvkr:synthetic@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?schema=phase08_meta_ads&sslmode=verify-full'};
 return{input,factory,request,calls:()=>calls,credentialReads:()=>credentialReads};
}
test('archived expired checkpoint diagnosis never reads credentials or resumes a checkpoint',async()=>{
 const f=fixture(),out=await diagnosePhase10ArchivedCafe(f.input,f);assert.equal(out.archivedCheckpoint.expired,true);assert.equal(out.checkpointResumed,false);assert.equal(f.calls(),0);assert.equal(f.credentialReads(),0);assert.equal(out.databaseWrites,0);assert(!JSON.stringify(out).includes('PRIVATE'));assert.equal(f.input.env,undefined);
});
test('current manual observation performs exactly one GET outside READ ONLY transaction and emits only fixed/count evidence',async()=>{
 const f=fixture('CURRENT_SINGLE_ITEM_READONLY'),out=await diagnosePhase10ArchivedCafe(f.input,f);assert.equal(f.calls(),1);assert.equal(f.credentialReads(),1);assert.equal(out.currentObservation.failedPredicate,'CAFE24_STATUS_APPROVAL_MISMATCH');assert.deepEqual(out.currentObservation.statusCounts,{N10:1});assert.equal(out.originalFailureReproduced,false);assert.equal(out.credentialRefreshes,0);assert(!JSON.stringify(out).includes('PRIVATE'));
});
test('foreign database role fails before credential reads and network',async()=>{const f=fixture('CURRENT_SINGLE_ITEM_READONLY',true);await assert.rejects(diagnosePhase10ArchivedCafe(f.input,f));assert.equal(f.calls(),0);assert.equal(f.credentialReads(),0);assert.equal(f.input.env,undefined);});
test('unrecognized classification fails before opening a database or network',async()=>{const f=fixture('RESUME_EXPIRED');await assert.rejects(diagnosePhase10ArchivedCafe(f.input,f));assert.equal(f.calls(),0);assert.equal(f.credentialReads(),0);});
