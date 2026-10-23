import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {scanDeployment,scanKnownSecrets} from './scan-deployment-secrets.mjs';
import {sealMetaVaultRecord} from '../../../apps/api/src/daily-sync/meta-protected-credential-resolver.ts';
const id='0c35defe-45fc-4a54-bc79-704df7bca5b1',key=Buffer.alloc(32,5);
const tokens=['SYNTHETIC_ACCESS_ONLY_123','SYNTHETIC_REFRESH_ONLY_456'];
const rows=tokens.map((token,i)=>{const kind=i?'CAFE24_REFRESH':'CAFE24_ACCESS',iv=Buffer.alloc(12,i+1),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(`${id}:${kind}:1`));return{connectionId:id,kind,keyVersion:1,iv,ciphertext:Buffer.concat([cipher.update(token),cipher.final()]),authTag:cipher.getAuthTag()};});
const meta={credentialRef:'vault://meta/11111111-1111-4111-8111-111111111111',connectionId:'1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6',accountId:'2138525300002203',transport:'MCP',token:'SYNTHETIC_META_ACCESS_ONLY_'+'a'.repeat(40),inspectorToken:'SYNTHETIC_META_INSPECTOR_ONLY_'+'b'.repeat(40)};
const metaEnv={DAILY_SYNC_META_TRANSPORT:'MCP',PHASE08_META_REF_UUID:'11111111-1111-4111-8111-111111111111',DAILY_SYNC_META_CREDENTIAL_REF:meta.credentialRef,DAILY_SYNC_META_VAULT_KEY:key.toString('base64'),PHASE08_META_RECORD_B64:Buffer.from(sealMetaVaultRecord(meta,key)).toString('base64')};
const input=logs=>({projectRef:'ehnfrrmbkvlsbpvqcvkr',connectionId:id,logsComplete:true,logs,env:{...metaEnv,SUPABASE_DATABASE_SCHEMA:'phase08_meta_ads',SUPABASE_DATABASE_RUNTIME_USER:'phase08_runtime',DAILY_SYNC_CREDENTIAL_KEY_V1:key.toString('base64'),INTERNAL_PROBE_TOKEN:'SYNTHETIC_PROBE_ONLY_789',DATABASE_URL:'postgresql://phase08_runtime.ehnfrrmbkvlsbpvqcvkr:SYNTHETIC_PASSWORD_ONLY_123@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?schema=phase08_meta_ads&sslmode=verify-full'}});
function mock(changes={}){const calls=[];const tx={$executeRawUnsafe:async sql=>calls.push(sql),$queryRawUnsafe:async sql=>{calls.push(sql);return [{database:'postgres',role:'phase08_runtime',schema:'phase08_meta_ads',readonly:'on',...changes.identity}];},sourceCredential:{findMany:async query=>{calls.push(query);return changes.rows??rows;}}};return{calls,$transaction:async cb=>cb(tx),$disconnect:async()=>calls.push('disconnect')};}
test('actual AES-GCM fixture is read only/exact own UUID and clear logs return fixed summary',async()=>{
 const db=mock(),material=input([{message:'safe startup'}]);const out=await scanDeployment(material,()=>db);
 assert.equal(out.state,'PHASE08_SECRET_SCAN_COMPLETE');assert.equal(out.cafeCredentialsDecrypted,2);assert.equal(out.providerRequests,0);assert.equal(out.databaseWrites,0);assert.equal(material.env,undefined);assert.equal(material.logs,undefined);
 assert.equal(db.calls[0],'SET TRANSACTION READ ONLY');assert.deepEqual(db.calls[2].where,{connectionId:id});assert.equal(db.calls.at(-1),'disconnect');assert(!JSON.stringify(out).includes(tokens[0]));
});
test('raw token, attribute token and URL/base64 escaped exposure are detected without values',async()=>{
 for(const value of [tokens[0],Buffer.from(tokens[1]).toString('base64'),'SYNTHETIC_PROBE_ONLY_789','SYNTHETIC_PASSWORD_ONLY_123',meta.token,meta.inspectorToken]){
  const out=await scanDeployment(input([{attributes:[{key:'unknown',value}]}]),()=>mock());assert.equal(out.matchDetected,true);assert(!JSON.stringify(out).includes(value));
 }
});
test('public storage role/subject metadata does not mask actual signed token detection',async()=>{
 const role='phase08_storage_app',subject='SYNTHETIC_STORAGE_SUBJECT_ONLY';
 const storageToken='SYNTHETIC_SIGNED_STORAGE_TOKEN_ONLY_'+ 's'.repeat(40);
 const material=logs=>{const value=input(logs);Object.assign(value.env,{SUPABASE_STORAGE_TOKEN_ROLE:role,SUPABASE_STORAGE_TOKEN_SUBJECT:subject,SUPABASE_STORAGE_TOKEN:storageToken});return value;};
 const safe=await scanDeployment(material([{message:role,attributes:[{key:'subject',value:subject}]}]),()=>mock());
 assert.equal(safe.matchDetected,false);assert.equal(safe.complete,true);
 for(const value of [storageToken,Buffer.from(storageToken).toString('base64')]){
  const found=await scanDeployment(material([{message:role,attributes:[{key:'subject',value:subject},{key:'authorization',value}]}]),()=>mock());
  assert.equal(found.matchDetected,true);assert(!JSON.stringify(found).includes(value));
 }
});
test('original Meta seal contract binds current UUID/ref/account/transport and decrypts without HTTP; foreign AAD/key/record rejects',async()=>{
 const good=await scanDeployment(input([]),()=>mock());assert.equal(good.metaCredentialsDecrypted,2);
 for(const field of ['connectionId','accountId','transport','credentialRef']) {
  const material=input([]);material.env.PHASE08_META_RECORD_B64=Buffer.from(sealMetaVaultRecord({...meta,[field]:field==='transport'?'GRAPH':field==='accountId'?'123':field==='connectionId'?'11111111-1111-4111-8111-111111111111':'vault://meta/22222222-2222-4222-8222-222222222222'},key)).toString('base64');
  await assert.rejects(scanDeployment(material,()=>mock()));assert.equal(material.env,undefined);
 }
 for(const change of [env=>env.DAILY_SYNC_META_VAULT_KEY=Buffer.alloc(32,9).toString('base64'),env=>env.PHASE08_META_RECORD_B64+='\n']) {
  const material=input([]);change(material.env);await assert.rejects(scanDeployment(material,()=>mock()));assert.equal(material.logs,undefined);
 }
});
test('wrong identity, foreign AAD, truncated/capped logs and invalid inputs fail closed',async()=>{
 const bad=input([]);bad.connectionId='foreign';await assert.rejects(scanDeployment(bad,()=>{throw new Error('factory must not run');}));assert.equal(bad.env,undefined);assert.equal(bad.logs,undefined);
 const factoryBad=input([]);await assert.rejects(scanDeployment(factoryBad,()=>{throw new Error('SYNTHETIC_PRIVATE');}));assert.equal(factoryBad.env,undefined);assert.equal(factoryBad.logs,undefined);
 await assert.rejects(scanDeployment(input([]),()=>mock({identity:{role:'foreign'}})));
 const altered=rows.map(row=>({...row,authTag:Buffer.alloc(16)}));await assert.rejects(scanDeployment(input([]),()=>mock({rows:altered})));
 assert.equal(scanKnownSecrets([],[],false).complete,false);assert.equal(scanKnownSecrets(Array(5000).fill({}),[],true).complete,false);
 assert.throws(()=>scanKnownSecrets(Array(5001).fill({}),[],true));assert.throws(()=>scanKnownSecrets([{}],[],[true]));
});
