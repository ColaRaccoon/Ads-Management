// Inline data-URI bootstrap for the reviewed v3 image. No app/snapshot mutation.
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
const requireImage=createRequire('/srv/app/package.json');
const ACCOUNT_QUERY='SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1';
const GOOGLE='1391592099', META='2138525300002203';
const fixedFailure=()=>{throw new Error('PHASE08_PORTABLE_SMOKE_REJECTED');};

export async function portableMetadata(env, services, {request=globalThis.fetch, now=()=>Date.now()}={}) {
  if(env.DAILY_SYNC_FEATURE_ENABLED!=='false'||env.DAILY_SYNC_SCHEDULE_ENABLED!=='false'||
    env.DAILY_SYNC_META_TRANSPORT!=='MCP'||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(env.PHASE08_META_CONNECTION_ID??'')) fixedFailure();
  const counts={googleAdsPost:0,metaGraphGet:0,googleSdkFetchObserved:0};
  const priorFetch=globalThis.fetch;
  let closed=false;
  const tracked=async(input,options={})=>{
    if(closed||options.signal?.aborted)fixedFailure();
    const url=new URL(typeof input==='string'?input:input.url??input.href);
    const method=options.method??'GET';
    if(url.hostname==='googleads.googleapis.com'&&method==='POST'&&url.pathname===`/v25/customers/${GOOGLE}/googleAds:search`) {
      const body=JSON.parse(options.body);if(body.query!==ACCOUNT_QUERY)fixedFailure();counts.googleAdsPost++;
    } else if(url.hostname==='graph.facebook.com'&&method==='GET'&&
      ['/v26.0/debug_token','/v26.0/me',`/v26.0/act_${META}`].includes(url.pathname)) counts.metaGraphGet++;
    else if(['oauth2.googleapis.com','iamcredentials.googleapis.com'].includes(url.hostname)) counts.googleSdkFetchObserved++;
    else fixedFailure();
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)fixedFailure();
    return request(input,{...options,redirect:'error'});
  };
  let googleState='GOOGLE_METADATA_FAILED',metaState='META_METADATA_FAILED',credential;
  try {
    globalThis.fetch=tracked;
    try {
      const client=new services.GoogleAdsClient(undefined,tracked);
      const result=await client.searchAll({customerId:GOOGLE,deadlineAt:now()+20_000,
        loginCustomerId:env.DAILY_SYNC_GOOGLE_LOGIN_CUSTOMER_ID??null},ACCOUNT_QUERY);
      const row=result.rows?.length===1?result.rows[0]?.customer:null;
      if(row?.id===GOOGLE&&row.currencyCode==='KRW'&&row.timeZone==='Asia/Seoul')googleState='GOOGLE_METADATA_VERIFIED';
    } catch { /* No raw diagnostics, account IDs, names, OAuth payloads or tokens. */ }
    try {
      credential=await services.resolveMetaCredential(services.configuredMetaCredentialResolver(env),{
        credentialRef:env.DAILY_SYNC_META_CREDENTIAL_REF,connectionId:env.PHASE08_META_CONNECTION_ID,accountId:META,transport:'MCP'},new Date(now()),20_000);
      if(credential?.accountId===META&&credential.connectionId===env.PHASE08_META_CONNECTION_ID&&
        credential.credentialRef===env.DAILY_SYNC_META_CREDENTIAL_REF&&credential.appId==='4474691502806219'&&
        credential.authClass==='SYSTEM_USER'&&credential.transport==='MCP'&&credential.currencyCode==='USD'&&
        credential.timeZone==='Asia/Seoul'&&credential.expiresAt instanceof Date&&credential.expiresAt.getTime()>now()+7*86400_000&&
        services.allowedMetaMcpScopes(credential.scopes))metaState='META_METADATA_VERIFIED';
    } catch { /* Fixed failure enum only. */ }
  } finally {closed=true;globalThis.fetch=priorFetch;if(credential)credential.token='';credential=null;}
  return {state:googleState==='GOOGLE_METADATA_VERIFIED'&&metaState==='META_METADATA_VERIFIED'?
    'PORTABLE_METADATA_VERIFIED':'PORTABLE_METADATA_PARTIAL',googleState,metaState,providerRequests:counts,
    googleSdkRequestsFullyObserved:false,datedStatsRequests:0,mcpInsightsRequests:0,dbWrites:0};
}

function imageServices() {
  return {...requireImage('./apps/api/dist/daily-sync/google-ads.client.js'),
    ...requireImage('./apps/api/dist/daily-sync/meta-protected-credential-resolver.js'),
    ...requireImage('./apps/api/dist/daily-sync/meta-credential-resolver.js')};
}
function safeSummary(value) {
  if(!value||!['PORTABLE_METADATA_VERIFIED','PORTABLE_METADATA_PARTIAL'].includes(value.state)||
    !['GOOGLE_METADATA_VERIFIED','GOOGLE_METADATA_FAILED'].includes(value.googleState)||
    !['META_METADATA_VERIFIED','META_METADATA_FAILED'].includes(value.metaState)||
    value.googleSdkRequestsFullyObserved!==false||value.datedStatsRequests!==0||value.mcpInsightsRequests!==0||value.dbWrites!==0)fixedFailure();
  const providerRequests={};
  for(const key of ['googleAdsPost','metaGraphGet','googleSdkFetchObserved']) {
    const count=value.providerRequests?.[key];if(!Number.isSafeInteger(count)||count<0||count>1000)fixedFailure();providerRequests[key]=count;
  }
  return {state:value.state,googleState:value.googleState,metaState:value.metaState,providerRequests,
    googleSdkRequestsFullyObserved:false,datedStatsRequests:0,mcpInsightsRequests:0,dbWrites:0};
}
// A short-lived process terminates ADC SDK requests which do not honor AbortSignal.
export function isolatedMetadata(env,_services,onChild=()=>{},{spawnProcess=spawn}={}) {
  const childEnv={PHASE08_PORTABLE_METADATA_WORKER:'true'};
  for(const key of ['PATH','NODE_ENV','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','GCLOUD_PROJECT',
    'DAILY_SYNC_FEATURE_ENABLED','DAILY_SYNC_SCHEDULE_ENABLED','DAILY_SYNC_GOOGLE_LOGIN_CUSTOMER_ID',
    'DAILY_SYNC_META_TRANSPORT','DAILY_SYNC_META_CREDENTIAL_REF','PHASE08_META_CONNECTION_ID',
    'DAILY_SYNC_META_VAULT_BACKEND','DAILY_SYNC_META_VAULT_DIRECTORY','DAILY_SYNC_META_VAULT_KEY'])
    if(env[key]!==undefined)childEnv[key]=env[key];
  return new Promise((resolve,reject)=>{
    const child=spawnProcess(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(import.meta.url)})`],
      {env:childEnv,stdio:['ignore','ignore','ignore','ipc']});onChild(child);
    let summary,invalid=false;
    child.on('message',value=>{try{if(summary)fixedFailure();summary=safeSummary(value);}catch{invalid=true;child.kill('SIGKILL');}});
    child.once('error',()=>reject(new Error('PHASE08_PORTABLE_WORKER_FAILED')));
    child.once('exit',code=>code===0&&summary&&!invalid?resolve(summary):reject(new Error('PHASE08_PORTABLE_WORKER_FAILED')));
  });
}

export async function bootstrap({env=process.env,emit=value=>console.log(JSON.stringify(value)),
  loadRuntime=()=>import('file:///srv/app/deploy/cloud/phase08-launch.mjs'),
  loadBundle=()=>import('file:///srv/app/deploy/launch-bundle.mjs'),
  loadServices=imageServices,runMetadata=isolatedMetadata,
  processRef=process,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  let prepared,timer,worker;
  const cleanupSync=()=>{if(prepared)rmSync(prepared.directory,{recursive:true,force:true});};
  try {
    if(processRef.platform!=='linux'||env.DAILY_SYNC_FEATURE_ENABLED!=='false'||env.DAILY_SYNC_SCHEDULE_ENABLED!=='false')fixedFailure();
    timer=setTimer(()=>{emit({state:'PORTABLE_SMOKE_TIMEOUT',fullAppBootStarted:false});worker?.kill('SIGKILL');cleanupSync();processRef.exit(1);},60_000);
    prepared=await(await loadRuntime()).preparePhase08Runtime(env);
    processRef.once('exit',cleanupSync);
    Object.assign(env,prepared.env);
    const summary=await runMetadata(prepared.env,loadServices,child=>{worker=child;});worker=null;
    clearTimer(timer);timer=null;emit(summary);
    const bundle=await loadBundle();
    const instance=bundle.launchBundle({env:prepared.env,logError:()=>emit({state:'PORTABLE_BUNDLE_FAILED'})});
    await instance.completion;
  } catch {emit({state:'PORTABLE_BOOTSTRAP_FAILED'});processRef.exitCode=1;}
  finally {worker?.kill('SIGKILL');if(timer)clearTimer(timer);if(prepared)await prepared.cleanup();processRef.off('exit',cleanupSync);}
}
// The root inline startCommand imports this file as a data URI; tests import the file URI.
if(process.env.PHASE08_PORTABLE_METADATA_WORKER==='true') {
  try {process.send(safeSummary(await portableMetadata(process.env,imageServices())),()=>process.exit(0));}
  catch {process.exit(1);}
} else if(import.meta.url.startsWith('data:')||process.argv[1]?.replaceAll('\\','/').endsWith('/cloud-portable-smoke.mjs'))await bootstrap();
