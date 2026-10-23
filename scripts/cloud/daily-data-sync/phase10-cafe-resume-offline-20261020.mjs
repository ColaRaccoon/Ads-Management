// Offline protected checkpoint replay. No database/provider/runtime imports.
import {createDecipheriv,createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire,Module} from 'node:module';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import ts from 'typescript';
import {cafe24Chunk} from '../../../apps/api/src/daily-sync/cafe24-scheduled-chunk.ts';
import {normalizeCafe24Order} from '../../../apps/api/src/daily-sync/cafe24-order-adapter.ts';
import {cafe24PaymentMethodCsvMap,verifiedCafe24V1Statuses} from '../../../apps/api/src/daily-sync/sync-contract.ts';
const frozen='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261016-meta-history-v22';
const fail=()=>{throw Error('OFFLINE_CAFE_SAFE_REJECTED');};
// Frozen sources have no dependency installation. Compile their local module
// graph in memory; resolve external packages from this installed checkout.
function frozenLoader(){const cache=new Map(),external=createRequire(import.meta.url);return function load(file){
 if(cache.has(file))return cache.get(file).exports;const mod=new Module(file);cache.set(file,mod);
 mod.require=name=>{if(!name.startsWith('.'))return external(name);const base=resolve(dirname(file),name),target=[base+'.ts',base+'.js',base].find(candidate=>existsSync(candidate));if(!target)fail();const bounded=relative(frozen,target);if(bounded.startsWith('..')||isAbsolute(bounded))fail();return load(target);};
 mod._compile(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true,emitDecoratorMetadata:false,esModuleInterop:true}}).outputText,file);return mod.exports;
};}
export async function replayStoredCafeState(state,env,{currentChunk=cafe24Chunk,oldChunk,oldAdapter}={}){
 if(state.version!==1||state.stage!=='ITEMS_FIRST'||state.count!==269||state.first?.length!==269||state.items?.length!==60||state.cursor!==60||state.second?.length!==0||state.verifiedItems!==0)fail();
 const previous={...process.env},RealDate=Date;let virtual=Date.parse(state.startedAt)+1000;
 if(!Number.isFinite(virtual))fail();
 const output={listingOrders:269,storedItemOrders:60,nextResponsePresent:false,metadataOldNewEqual:0,itemOldNewEqual:0,currentChunkStoredPass:0,frozenChunkStoredPass:0,originalFailureReproduced:false,checkpointResumed:false};
 try{
  for(const name of Object.keys(process.env))if(name.startsWith('DAILY_SYNC_CAFE24_'))delete process.env[name];
  Object.assign(process.env,env);
  globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[virtual]));}static now(){return virtual;}};
  const labels=cafe24PaymentMethodCsvMap();verifiedCafe24V1Statuses();
  const options={verifiedSellerDropdown:true,csvOptionEvidence:{mallId:'didadi0729',shopKey:'shop1'},paymentMethodCsvLabels:labels};
  const sentinel=[{order_item_code:'SYNTHETIC',product_no:'0',product_name:'Synthetic',option_value:'Synthetic',quantity:'0',product_price:'0',order_status:'N00'}];
  const canonical=value=>JSON.stringify(value);
  for(const order of state.first){if(canonical(normalizeCafe24Order(order,sentinel,options))!==canonical(oldAdapter(order,sentinel,options)))fail();output.metadataOldNewEqual++;}
  for(let i=0;i<60;i++){
   if(canonical(normalizeCafe24Order(state.first[i],state.items[i],options))!==canonical(oldAdapter(state.first[i],state.items[i],options)))fail();output.itemOldNewEqual++;
   for(const [chunk,field]of [[currentChunk,'currentChunkStoredPass'],[oldChunk,'frozenChunkStoredPass']]){
    // Isolated one-order replays exercise the actual chunk normalizer. They do
    // not renew/resume the archived 269-order checkpoint or certify a day.
    const one={...structuredClone(state),count:1,first:[structuredClone(state.first[i])],items:[],cursor:0};
    let calls=0;const result=await chunk({connectionId:state.connectionId,mallId:'didadi0729',shopKey:'shop1',day:state.day,deadlineAt:virtual+60000,state:one,now:()=>virtual,wait:async()=>{},count:async()=>{fail();},listing:async()=>{fail();},items:async()=>{calls++;return structuredClone(state.items[i]);}});
    if(calls!==1||result.state.stage!=='LIST_VERIFY'||result.state.items.length!==1||result.snapshot!==null)fail();output[field]++;
   }
  }
  return output;
 }finally{globalThis.Date=RealDate;for(const name of Object.keys(process.env))if(!(name in previous))delete process.env[name];Object.assign(process.env,previous);}
}
export function credentialReadiness(rows,now=Date.now()){
 if(!Number.isFinite(now)||!Array.isArray(rows)||rows.length!==2||new Set(rows.map(r=>r?.kind)).size!==2||rows.some(r=>!r||!['CAFE24_ACCESS','CAFE24_REFRESH'].includes(r.kind)||typeof r.expiresAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(r.expiresAt)||!Number.isFinite(Date.parse(r.expiresAt))))fail();
 const access=rows.find(r=>r.kind==='CAFE24_ACCESS'),refresh=rows.find(r=>r.kind==='CAFE24_REFRESH');
 return{storedCredentialRows:2,accessMinimum120s:Date.parse(access.expiresAt)>=now+120000,refreshNotExpired:Date.parse(refresh.expiresAt)>now,accessOnlyReadCurrentlyUsable:Date.parse(access.expiresAt)>=now+120000,refreshWouldBeRequiredForNewRead:Date.parse(access.expiresAt)<now+120000,externalRevocationIntrospected:false,snapshotIsLiveCurrentState:false};
}
async function main(){let raw='',input,key,plain,stage='INPUT';try{
 for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>4*1024*1024)fail();}input=JSON.parse(raw);raw='';
 const row=input.checkpoints?.[0];if(input.checkpoints?.length!==1||row.runId!=='a4f7bcea-bfa8-4699-b3f0-34e118889710'||row.connectionId!=='0c35defe-45fc-4a54-bc79-704df7bca5b1'||row.unitKey!=='2026-10-17'||row.revision!==6)fail();
 key=Buffer.from(input.checkpointKey,'base64');if(key.length!==32||key.toString('base64')!==input.checkpointKey)fail();
 const encrypted=Buffer.from(row.ciphertextB64,'base64');if(encrypted.length!==126852)fail();const d=createDecipheriv('aes-256-gcm',key,Buffer.from(row.ivB64,'base64'));d.setAAD(Buffer.from(`${row.connectionId}:${row.runId}:${row.unitKey}`));d.setAuthTag(Buffer.from(row.authTagB64,'base64'));plain=Buffer.concat([d.update(encrypted),d.final()]);const state=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(plain));
 stage='FROZEN_IMPORT';const load=frozenLoader();const {cafe24Chunk:oldChunk}=load(`${frozen}/apps/api/src/daily-sync/cafe24-scheduled-chunk.ts`);
 const {normalizeCafe24Order:oldAdapter}=load(`${frozen}/apps/api/src/daily-sync/cafe24-order-adapter.ts`);
 stage='ACTUAL_CHUNK_REPLAY';const replay=await replayStoredCafeState(state,input.evidence,{oldChunk,oldAdapter});
 process.stdout.write(JSON.stringify({kind:'CAFE_OFFLINE_RESUME_INVESTIGATION',observedAt:new Date().toISOString(),replay,credential:credentialReadiness(input.credentials),localConfig:input.localConfig,checkpointCipherSha256:createHash('sha256').update(encrypted).digest('hex'),providerRequests:0,refreshes:0,databaseConnections:0,databaseWrites:0,rawValuesReturned:0,limits:['BEFORE_INCIDENT_CONFIGURATION_NOT_FAILURE_TIME_BYTE_PROOF','NEXT_ITEM_RESPONSE_NOT_RETAINED','SIXTY_ORDERS_NOT_COMPLETE_DAY','STORED_ACCESS_EXPIRED_DOES_NOT_PROVE_FIELD_UNSUPPORTED_CAUSE']}));
 }catch{process.stdout.write(JSON.stringify({kind:'CAFE_OFFLINE_RESUME_INVESTIGATION_FAILED',stage,rawErrorSuppressed:true,providerRequests:0,databaseWrites:0,rawValuesReturned:0}));process.exitCode=1;}finally{raw='';input=undefined;plain?.fill(0);key?.fill(0);}}
if(process.argv[1]?.endsWith('phase10-cafe-resume-offline-20261020.mjs'))void main();
