// Run after: node node_modules/typescript/bin/tsc -p apps/api/tsconfig.build.json --incremental false
// Actual compiled client, injected synthetic ADC and HTTP only. No credentials or network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {GoogleAdsClient}=require('../../../apps/api/dist/daily-sync/google-ads.client.js');
const input=deadlineAt=>({customerId:'1391592099',day:'2026-09-29',deadlineAt});
test('actual compiled client makes no late Ads POST after non-abortable ADC settles',async()=>{
  let release,calls=0;
  const auth={getAccessToken:()=>new Promise(resolve=>{release=resolve;})};
  const client=new GoogleAdsClient(auth,async()=>{calls++;throw Error('NETWORK_FORBIDDEN');});
  await assert.rejects(client.fetchDay(input(Date.now()+25)),error=>error.safeCode==='RUN_LIMIT_EXCEEDED');
  release('synthetic-token-not-output');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,0);
});
test('absolute deadline fences POST even when token resolution finishes before abort timer',async()=>{
  const originalNow=Date.now,start=originalNow();let late=false,calls=0;
  Date.now=()=>start+(late?1000:0);
  try {
    const client=new GoogleAdsClient({getAccessToken:async()=>{late=true;return 'synthetic-token';}},async()=>{calls++;throw Error('NETWORK_FORBIDDEN');});
    await assert.rejects(client.fetchDay(input(start+500)),error=>error.safeCode==='RUN_LIMIT_EXCEEDED');
    assert.equal(calls,0);
  } finally {Date.now=originalNow;}
});
test('valid deadline preserves the normal three-query completed-day snapshot',async()=>{
  const queries=[];
  const client=new GoogleAdsClient({getAccessToken:async()=> 'synthetic-token'},async(_url,options)=>{
    queries.push(JSON.parse(options.body).query);assert.equal(options.signal.aborted,false);
    return new Response(JSON.stringify(queries.length===1?{results:[{customer:{id:'1391592099',currencyCode:'KRW',timeZone:'Asia/Seoul'}}]}:{results:[]}),{status:200});
  });
  const snapshot=await client.fetchDay(input(Date.now()+5000));
  assert.equal(queries.length,3);assert.equal(snapshot.accountCostMicros,0n);assert.equal(snapshot.currencyCode,'KRW');assert.equal(snapshot.rows.length,0);
});
