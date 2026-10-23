// No network. Caller captures protected stdout in memory; no tokens in diagnostics.
import {readFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {AuthCookieService} from '../../../apps/api/src/auth/cookie.service.ts';
const fail=()=>{throw Error('INCIDENT_AUTH_VECTOR_REJECTED');};
const hash=b=>createHash('sha256').update(b).digest('hex');
const names=['AUTH_SESSION_HANDLE_SECRET','AUTH_AUTHORIZATION_VERSION_SECRET','AUTH_CSRF_SECRET'];
function config(secrets){for(const k of names)if(typeof secrets?.[k]!=='string'||secrets[k].length<32)fail();return {production:true,cookieNamespace:'phase08',cookieSecure:true,csrfTtlMs:28_800_000,sessionHandleSecret:secrets.AUTH_SESSION_HANDLE_SECRET,authorizationVersionSecret:secrets.AUTH_AUTHORIZATION_VERSION_SECRET,csrfSecret:secrets.AUTH_CSRF_SECRET};}
export function makeIncidentAuthVectors(input){
 const current=new AuthCookieService(config(input.current)),old=new AuthCookieService(config(input.old));
 if(names.some(k=>input.current[k]===input.old[k])||new Set(names.flatMap(k=>[input.current[k],input.old[k]])).size!==6)fail();
 const sessionId=current.verifySessionHandle(input.freshSessionHandle);if(!sessionId||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.appId??''))fail();
 const oldSessionHandle=`${sessionId}.${old.mac('session',sessionId,input.old.AUTH_SESSION_HANDLE_SECRET)}`;
 if(old.verifySessionHandle(oldSessionHandle)!==sessionId||current.verifySessionHandle(oldSessionHandle)!==null||old.verifySessionHandle(input.freshSessionHandle)!==null)fail();
 const now=Math.floor(Date.now()/1000),value=`${now}.${randomBytes(32).toString('base64url')}`;
 const oldCsrf=`${value}.${old.mac('csrf',value,input.old.AUTH_CSRF_SECRET)}`,newCsrf=`${value}.${current.mac('csrf',value,input.current.AUTH_CSRF_SECRET)}`;
 if(!old.verifyCsrfToken(oldCsrf,oldCsrf)||current.verifyCsrfToken(oldCsrf,oldCsrf)||!current.verifyCsrfToken(newCsrf,newCsrf)||old.verifyCsrfToken(newCsrf,newCsrf))fail();
 // Pure method verification; this does not claim remote role/version mutation.
 const version=7,oldAuthz=old.authorizationVersion(input.appId,version),newAuthz=current.authorizationVersion(input.appId,version);
 if(oldAuthz===newAuthz||oldAuthz!==old.mac('authz',`${input.appId}:${version}`,input.old.AUTH_AUTHORIZATION_VERSION_SECRET)||newAuthz!==current.mac('authz',`${input.appId}:${version}`,input.current.AUTH_AUTHORIZATION_VERSION_SECRET))fail();
 return {oldSessionHandle,oldCsrf,newCsrf,proof:{actualCookieService:true,sameValidSessionId:true,sameCsrfNonceAndTime:true,oldSessionSignatureRejected:true,oldCsrfSignatureRejected:true,authzActualMethodPureTest:true,authzOutputsDiffer:true,previousKeyFallback:false,dbRoleMutation:false}};
}
export function checkedCookieSource(){
 const relative='apps/api/src/auth/cookie.service.ts',authRelative='apps/api/src/auth/auth.config.ts';
 const checkout='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance',frozen='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261016-meta-history-v22';
 const result={};for(const p of [relative,authRelative]){const bytes=readFileSync(`${checkout}/${p}`);if(!bytes.equals(readFileSync(`${frozen}/${p}`)))fail();result[p]=hash(bytes);}return result;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){try{let wire='';for await(const c of process.stdin){wire+=c;if(wire.length>262144)fail();}const input=JSON.parse(wire);wire='';const source=checkedCookieSource();if(input.operation!=='vectors')fail();const result=makeIncidentAuthVectors(input);process.stdout.write(JSON.stringify({...result,source}));}catch{process.stdout.write('{"safeCode":"INCIDENT_AUTH_VECTOR_REJECTED","rawErrorSuppressed":true}');process.exitCode=1;}}
