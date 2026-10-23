import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const fail=()=>{throw Error('INCIDENT_STORAGE_CACHE_PROBE_REJECTED');};
const hash=b=>createHash('sha256').update(b).digest('hex');
const cacheStates=new Set(['HIT','MISS','DYNAMIC','BYPASS','EXPIRED','STALE','UPDATING','REVALIDATED','NONE']);
export function safeCacheHeaders(headers){
 const numeric=name=>{const s=headers.get(name);return /^\d{1,12}$/.test(s??'')?Number(s):null;};
 const state=name=>{const s=headers.get(name)?.toUpperCase();return cacheStates.has(s)?s:null;};
 const raw=headers.get('cache-control'),parts=(raw??'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean),accepted=parts.filter(x=>/^(?:public|private|no-store|no-cache|must-revalidate|proxy-revalidate|immutable|(?:max-age|s-maxage|stale-while-revalidate|stale-if-error)=\d{1,12})$/.test(x));
 return {cacheControl:accepted,unrecognizedCacheControlDirective:accepted.length!==parts.length,age:numeric('age'),cfCacheStatus:state('cf-cache-status'),xCache:state('x-cache')};
}
export async function probeStorageCache(input,fetcher=fetch){
 if(input.projectRef!=='ehnfrrmbkvlsbpvqcvkr'||input.baseUrl!=='https://ehnfrrmbkvlsbpvqcvkr.supabase.co'||input.bucket!=='meta-ads-phase08-isolated'||!input.publishableKey||hash(input.oldToken)!==input.oldTokenSha256||hash(input.newToken)!==input.newTokenSha256||input.oldToken===input.newToken||!/^[a-f0-9]{64}$/.test(input.sentinelHash??''))fail();
 const decode=t=>JSON.parse(Buffer.from(t.split('.')[1],'base64url'));const old=decode(input.oldToken),next=decode(input.newToken);if(old.role!=='phase08_storage_app'||next.role!==old.role||old.sub!==input.oldSubject||next.sub!==input.newSubject||old.sub===next.sub)fail();
 const base=`${input.baseUrl}/storage/v1/object/authenticated/${input.bucket}/health/readiness-sentinel`,nonce=randomUUID(),checks=[];
 for(const [name,token,cacheBusted]of [['old_bare_native_fetch',input.oldToken,false],['new_bare_native_fetch',input.newToken,false],['old_no_cache_unique_query',input.oldToken,true],['new_no_cache_unique_query',input.newToken,true]]){
  const headers={apikey:input.publishableKey,Authorization:`Bearer ${token}`};if(cacheBusted){headers['Cache-Control']='no-cache, no-store';headers.Pragma='no-cache';}
  const response=await fetcher(base+(cacheBusted?`?incident=${nonce}`:''),{method:'GET',headers,redirect:'manual',signal:AbortSignal.timeout(20000),...(cacheBusted?{cache:'no-store'}:{})});
  let bytes=null,contentMatchesExpectedSentinel=null;if(response.status===200){const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>4096))fail();const reader=response.body.getReader(),chunks=[];let size=0;try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>4096){await reader.cancel();fail();}chunks.push(r.value);}bytes=size;contentMatchesExpectedSentinel=hash(Buffer.concat(chunks))===input.sentinelHash;}finally{reader.releaseLock();}}else{await response.body?.cancel();}
  checks.push({name,status:response.status,cacheBusted,noCacheRequest:cacheBusted,cacheHeaders:safeCacheHeaders(response.headers),sentinelBytesWhen200:bytes,contentMatchesExpectedSentinel});
 }
 const bare=checks.find(x=>x.name==='old_bare_native_fetch'),busted=checks.find(x=>x.name==='old_no_cache_unique_query');
 return {kind:'INCIDENT_STORAGE_NATIVE_CACHE_DIAGNOSTIC',observedAt:new Date().toISOString(),checks,oldTokenHashMatchesPrepared:true,newTokenHashMatchesPrepared:true,oldTokenMatchesSentBearer:true,newTokenMatchesSentBearer:true,independentNativeFetchNoPowerShellSession:true,oldBareReadStillAllowed:bare.status===200,cacheBustedOldDenied:[400,401,403,404].includes(busted.status),fullOldBearerRevocationProven:false,diagnosticOnly:true,mutationRequests:0,customerObjectBodyReads:0,rawHeadersReturned:false,rawSecretsReturned:0,rawErrorSuppressed:true};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){try{let wire='';for await(const c of process.stdin){wire+=c;if(wire.length>262144)fail();}const input=JSON.parse(wire);wire='';process.stdout.write(JSON.stringify(await probeStorageCache(input)));}catch{process.stdout.write('{"kind":"INCIDENT_STORAGE_NATIVE_CACHE_DIAGNOSTIC","status":"FAIL","rawErrorSuppressed":true}');process.exitCode=1;}}
