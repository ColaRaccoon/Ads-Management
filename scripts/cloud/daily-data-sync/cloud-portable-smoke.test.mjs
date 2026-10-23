import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { portableMetadata, bootstrap, isolatedMetadata } from './cloud-portable-smoke.mjs';
const env=()=>({DAILY_SYNC_FEATURE_ENABLED:'false',DAILY_SYNC_SCHEDULE_ENABLED:'false',DAILY_SYNC_META_TRANSPORT:'MCP',
  DAILY_SYNC_META_CREDENTIAL_REF:'vault://meta/11111111-1111-1111-1111-111111111111',PHASE08_META_CONNECTION_ID:'22222222-2222-2222-2222-222222222222'});
const token='synthetic-secret-never-output-'.repeat(3);
function services(overrides={}) {
  return {GoogleAdsClient:class {
    constructor(_auth,request){this.request=request;}
    async searchAll(input,query){assert.equal(input.customerId,'1391592099');assert.ok(!query.includes('segments'));
      await this.request(`https://googleads.googleapis.com/v25/customers/${input.customerId}/googleAds:search`,{method:'POST',body:JSON.stringify({query})});
      return {rows:[{customer:{id:'1391592099',currencyCode:'KRW',timeZone:'Asia/Seoul'}}]};}},
    configuredMetaCredentialResolver:()=>({synthetic:true}),
    resolveMetaCredential:async(_resolver,input)=>{
      for(const path of ['debug_token','me',`act_${input.accountId}`])await globalThis.fetch(`https://graph.facebook.com/v26.0/${path}`);
      return {...input,token,appId:'4474691502806219',authClass:'SYSTEM_USER',scopes:['ads_read','ads_mcp_management'],
        currencyCode:'USD',timeZone:'Asia/Seoul',expiresAt:new Date(Date.now()+14*86400_000)};},
    allowedMetaMcpScopes:scopes=>scopes.includes('ads_read')&&scopes.includes('ads_mcp_management'),...overrides};
}
test('metadata only query counts exact Ads and Graph calls without raw output',async()=>{
  const result=await portableMetadata(env(),services(),{request:async()=>({synthetic:true})});
  assert.equal(result.state,'PORTABLE_METADATA_VERIFIED');assert.deepEqual(result.providerRequests,{googleAdsPost:1,metaGraphGet:3,googleSdkFetchObserved:0});
  assert.equal(result.datedStatsRequests,0);assert.equal(result.mcpInsightsRequests,0);assert.equal(JSON.stringify(result).includes(token),false);
});
test('provider failures remain independent fixed enums and restore global fetch',async()=>{
  const before=globalThis.fetch;
  const result=await portableMetadata(env(),services({GoogleAdsClient:class{async searchAll(){throw Error(token);}}}),{request:async()=>({})});
  assert.equal(result.googleState,'GOOGLE_METADATA_FAILED');assert.equal(result.metaState,'META_METADATA_VERIFIED');
  assert.equal(globalThis.fetch,before);assert.equal(JSON.stringify(result).includes(token),false);
});
test('feature or scheduler activation prevents metadata requests',async()=>{
  for(const key of ['DAILY_SYNC_FEATURE_ENABLED','DAILY_SYNC_SCHEDULE_ENABLED'])await assert.rejects(portableMetadata({...env(),[key]:'true'},services(),{request:()=>{throw Error('NETWORK_FORBIDDEN');}}));
});
test('invalid account currency and invalid Meta credential do not become verified',async()=>{
  const result=await portableMetadata(env(),services({GoogleAdsClient:class{async searchAll(){return {rows:[{customer:{id:'1391592099',currencyCode:'USD',timeZone:'Asia/Seoul'}}]};}},
    resolveMetaCredential:async()=>({token,accountId:'wrong'})}),{request:async()=>({})});
  assert.equal(result.googleState,'GOOGLE_METADATA_FAILED');assert.equal(result.metaState,'META_METADATA_FAILED');
});
test('bootstrap restores ordinary bundle after fixed metadata outcomes and cleanup',async()=>{
  const emitted=[];let cleanup=0,launched=0,cleared=0;
  const instance={platform:'linux',once(){},off(){},exit(){throw Error('UNEXPECTED_EXIT');},exitCode:0};
  await bootstrap({env:env(),emit:value=>emitted.push(value),processRef:instance,setTimer:()=>({synthetic:true}),clearTimer:()=>cleared++,
    loadRuntime:async()=>({preparePhase08Runtime:async source=>({env:{...source},directory:'C:/synthetic-never-created',cleanup:async()=>cleanup++})}),
    runMetadata:(source,loader)=>portableMetadata(source,loader()),
    loadServices:()=>services({GoogleAdsClient:class{async searchAll(){throw Error(token);}},resolveMetaCredential:async()=>{throw Error(token);}}),
    loadBundle:async()=>({launchBundle:()=>{launched++;return {completion:Promise.resolve()};}})});
  assert.equal(emitted[0].state,'PORTABLE_METADATA_PARTIAL');assert.equal(launched,1);assert.equal(cleanup,1);assert.equal(cleared,1);
  assert.equal(JSON.stringify(emitted).includes(token),false);
});
test('hung provider is terminated at the whole-bootstrap deadline and private directory is removed',()=>{
  const parent=mkdtempSync(join(tmpdir(),'phase08-smoke-test-'));
  const privateDir=join(parent,'private');
  const moduleUrl=new URL('./cloud-portable-smoke.mjs',import.meta.url).href;
  const code=`import {mkdirSync} from 'node:fs';
    import {bootstrap,portableMetadata} from ${JSON.stringify(moduleUrl)};
    mkdirSync(${JSON.stringify(privateDir)});
    await bootstrap({env:${JSON.stringify(env())},
      processRef:{platform:'linux',once:process.once.bind(process),off:process.off.bind(process),exit:process.exit.bind(process)},
      setTimer:(callback)=>setTimeout(callback,25),
      loadRuntime:async()=>({preparePhase08Runtime:async(source)=>({env:{...source},directory:${JSON.stringify(privateDir)},cleanup:async()=>{}})}),
      runMetadata:(source,loader)=>portableMetadata(source,loader()),
      loadServices:()=>({GoogleAdsClient:class{searchAll(){return new Promise(()=>{});}}}),
      loadBundle:()=>{throw Error('BUNDLE_MUST_NOT_START');}});`;
  try {
    const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,1);assert.equal(result.stderr,'');
    assert.deepEqual(JSON.parse(result.stdout),{state:'PORTABLE_SMOKE_TIMEOUT',fullAppBootStarted:false});
    assert.equal(existsSync(privateDir),false);
  } finally {rmSync(parent,{recursive:true,force:true});}
});
test('late client request is fenced after metadata closes even if auth ignores abort',async()=>{
  let lateRequest,sent=0;
  const result=await portableMetadata(env(),services({GoogleAdsClient:class {
    constructor(_auth,request){lateRequest=request;}
    async searchAll(){throw Error('SYNTHETIC_TIMEOUT');}
  }}),{request:async()=>{sent++;return {};}});
  assert.equal(result.googleState,'GOOGLE_METADATA_FAILED');assert.equal(sent,3);
  await assert.rejects(lateRequest('https://googleads.googleapis.com/v25/customers/1391592099/googleAds:search',{
    method:'POST',body:JSON.stringify({query:'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'})}));
  assert.equal(sent,3);
});
test('isolated worker copies only provider inputs and waits for exit before accepting fixed IPC',async()=>{
  const summary=await portableMetadata(env(),services(),{request:async()=>({})});
  const child=new EventEmitter();child.kill=()=>{};let exited=false;
  const promise=isolatedMetadata({...env(),AUTH_SECRET:token,DATABASE_URL:token,DAILY_SYNC_META_VAULT_KEY:token},null,()=>{},
    {spawnProcess:(_exe,_args,options)=>{assert.equal(options.env.AUTH_SECRET,undefined);assert.equal(options.env.DATABASE_URL,undefined);
      assert.equal(options.env.DAILY_SYNC_META_VAULT_KEY,token);assert.deepEqual(options.stdio,['ignore','ignore','ignore','ipc']);return child;}});
  promise.then(()=>{exited=true;});child.emit('message',{...summary,unsafe:token});await Promise.resolve();assert.equal(exited,false);
  child.emit('exit',0);const result=await promise;assert.equal(JSON.stringify(result).includes(token),false);assert.equal(exited,true);
});
