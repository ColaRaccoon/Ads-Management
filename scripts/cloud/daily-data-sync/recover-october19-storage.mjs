// Offline-only credential preparation. Protected caller captures stdout in memory.
import {createPrivateKey,createPublicKey,sign,verify,createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import Module from 'node:module';
const frozen='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261016-meta-history-v22';
const ref='ehnfrrmbkvlsbpvqcvkr';
const reject=()=>{throw Error('RECOVERY_INPUT_REJECTED');};
function checkedValidatorClosure(){
 const checkout='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance',seen=new Set(),hashes=[];
 function visit(name){if(seen.has(name))return;seen.add(name);const current=resolve(checkout,name),previous=resolve(frozen,name);if(!current.startsWith(resolve(checkout))||!previous.startsWith(resolve(frozen)))reject();
 const bytes=readFileSync(current),prior=readFileSync(previous);if(!bytes.equals(prior))reject();hashes.push([name,createHash('sha256').update(bytes).digest('hex')]);
 for(const m of bytes.toString('utf8').matchAll(/from\s*["'](\.{1,2}\/[^"']+)["']/g)){const base=resolve(dirname(current),m[1]);const file=[base,`${base}.ts`,`${base}.tsx`,`${base}/index.ts`].find(p=>existsSync(p)&&/\.(?:ts|tsx)$/.test(p));if(!file)reject();visit(relative(checkout,file).replaceAll('\\','/'));}}
 visit('apps/api/src/common/http-security.config.ts');return {files:hashes.length,sha256:createHash('sha256').update(JSON.stringify(hashes.sort())).digest('hex')};
}
const parse=t=>{if(typeof t!=='string'||t.length>16384)reject();const p=t.split('.');if(p.length!==3)reject();return {header:JSON.parse(Buffer.from(p[0],'base64url')),claims:JSON.parse(Buffer.from(p[1],'base64url')),parts:p};};
export function renewStorage(input,now=Math.floor(Date.now()/1000)){
 const env=input.env,old=parse(env?.SUPABASE_STORAGE_ACCESS_TOKEN);
 if(env.SUPABASE_URL!==`https://${ref}.supabase.co`||env.SUPABASE_DATABASE_PROJECT_REF!==ref||
 env.SUPABASE_DATABASE_SCHEMA!=='phase08_meta_ads'||env.SUPABASE_DATABASE_RUNTIME_USER!=='phase08_runtime'||
 env.SUPABASE_STORAGE_BUCKET!=='meta-ads-phase08-isolated'||env.SUPABASE_STORAGE_TOKEN_ROLE!=='phase08_storage_app'||
 old.header.alg!=='ES256'||old.header.kid!==input.jwk?.kid||input.jwk.kty!=='EC'||input.jwk.crv!=='P-256'||
 old.claims.iss!==`https://${ref}.supabase.co/auth/v1`||old.claims.aud!=='authenticated'||
 old.claims.role!=='phase08_storage_app'||old.claims.sub!==env.SUPABASE_STORAGE_TOKEN_SUBJECT||
 Object.keys(old.claims).sort().join(',')!=='aud,exp,iat,iss,role,sub'||!Number.isSafeInteger(old.claims.exp)||!Number.isSafeInteger(old.claims.iat))reject();
 const key=createPrivateKey({key:input.jwk,format:'jwk'}),pub=createPublicKey(key);
 const remote=input.publicJwks?.keys?.filter(k=>k.kid===old.header.kid);
 if(remote?.length!==1||['kty','crv','x','y'].some(k=>remote[0][k]!==input.jwk[k]))reject();
 if(!verify('sha256',Buffer.from(old.parts.slice(0,2).join('.')),{key:pub,dsaEncoding:'ieee-p1363'},Buffer.from(old.parts[2],'base64url')))reject();
 const claims={...old.claims,iat:now,exp:now+6*86400};
 const encoded=[old.header,claims].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
 const signature=sign('sha256',Buffer.from(encoded),{key,dsaEncoding:'ieee-p1363'});
 if(!verify('sha256',Buffer.from(encoded),{key:pub,dsaEncoding:'ieee-p1363'},signature))reject();
 return {token:`${encoded}.${signature.toString('base64url')}`,issuedAt:new Date(now*1000).toISOString(),expiresAt:new Date(claims.exp*1000).toISOString(),oldExpiresAt:new Date(old.claims.exp*1000).toISOString(),sameScope:true,signatureVerified:true};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 let stage='INPUT',beforeCode=null,afterFingerprint=null;
 try{
  let wire='';for await(const bytes of process.stdin){wire+=bytes;if(wire.length>1048576)reject();}
  const input=JSON.parse(wire);wire='';stage='CRYPTO';const result=renewStorage(input);
  const configFile=`${frozen}/apps/api/src/common/http-security.config.ts`;
  // Frozen sources have no node_modules. Resolve the existing checkout runtime
  // in this short-lived offline child without editing the frozen artifact.
  process.env.NODE_PATH='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance/node_modules;C:/Users/seong/Desktop/workspace/Meta-Ads-Performance/apps/api/node_modules';Module._initPaths();
  stage='CHECK_FROZEN_VALIDATOR_CLOSURE';const closure=checkedValidatorClosure();
  stage='IMPORT_FROZEN_VALIDATOR';const {validateRuntimeEnvironment}=await import('../../../apps/api/src/common/http-security.config.ts');
  const env={...input.env,IMAGE_RELEASE_GIT_SHA:input.env.RELEASE_GIT_SHA};
  stage='BEFORE_VALIDATOR';beforeCode='NONE';try{validateRuntimeEnvironment(env);}catch(e){beforeCode=e.message==='SUPABASE_STORAGE_ACCESS_TOKEN expires before the required deployment overlap window.'?'STORAGE_MINIMUM_OVERLAP_REJECTED':'OTHER_CONFIGURATION_REJECTED';}
  stage='AFTER_VALIDATOR';const after=validateRuntimeEnvironment({...env,SUPABASE_STORAGE_ACCESS_TOKEN:result.token});
  stage='FINGERPRINT';afterFingerprint=after.RUNTIME_CONFIG_FINGERPRINT;
  if(beforeCode!=='STORAGE_MINIMUM_OVERLAP_REJECTED'||after.RUNTIME_CONFIG_FINGERPRINT!=='a08ce01407eaa8070887c23195685f3d475674b89a0dc3bd2c7315bf404a0aa1')reject();
  process.stdout.write(JSON.stringify({...result,beforeValidation:beforeCode,afterValidation:'PASSED',runtimeConfigFingerprint:after.RUNTIME_CONFIG_FINGERPRINT,frozenValidatorSha256:createHash('sha256').update(readFileSync(configFile)).digest('hex'),frozenValidatorClosure:closure}));
 }catch(error){const code=['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND'].includes(error.code)?error.code:null;const missing=stage==='IMPORT_FROZEN_VALIDATOR'?/^Cannot find module '([@a-zA-Z0-9_./-]+)'/.exec(error.message)?.[1]??null:null;process.stdout.write(JSON.stringify({failedStage:stage,beforeValidation:beforeCode,afterFingerprint,dependencyCode:code,missingPackage:missing,decoratorTransformRejected:stage==='IMPORT_FROZEN_VALIDATOR'&&/Parameter decorators/.test(error.message),rawErrorSuppressed:true}));}
}
