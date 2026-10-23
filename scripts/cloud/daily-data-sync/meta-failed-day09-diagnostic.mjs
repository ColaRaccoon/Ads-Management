import {inspectPurchaseGates} from './meta-purchase-offline-diagnostic.mjs';

// Explicit failed-day MANUAL_DIAGNOSTIC only; protected stdin, no canonical writes.

import {PrismaClient,Prisma} from '@prisma/client';

import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';

import {open,lstat,realpath,unlink} from 'node:fs/promises';

import {execFileSync} from 'node:child_process';

import {join,resolve} from 'node:path';

import {gunzipSync} from 'node:zlib';

import {assertBusinessDatabaseTarget} from './seed-isolated-business-config.mjs';

import {ProtectedFileMetaCredentialResolver} from '../../../apps/api/src/daily-sync/meta-protected-credential-resolver.ts';

import {resolveMetaCredential} from '../../../apps/api/src/daily-sync/meta-credential-resolver.ts';

import {MetaMcpWireReader} from '../../../apps/api/src/daily-sync/meta-mcp-wire-reader.ts';

import {boundedMetaMcpEnvelope} from '../../../apps/api/src/daily-sync/meta-mcp-envelope.ts';

import {selectMetaMcpDay,validateMetaMcpCapture} from '../../../apps/api/src/daily-sync/meta-mcp-capture.ts';

import {createMetaMcpResidualProof} from '../../../apps/api/src/daily-sync/meta-mcp-residual-proof.ts';

import {createMetaMcpPurchaseResidualProof} from '../../../apps/api/src/daily-sync/meta-mcp-purchase.ts';

import {normalizeMetaMcpPurchaseSnapshot} from '../../../apps/api/src/daily-sync/meta-mcp-ads.client.ts';

export const PRIVATE_DIRECTORY='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/meta-diagnostic-20261015-day09';

export const CANONICAL_PRIVATE_DIRECTORY='C:/Users/seong/AppData/Local/Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local/MetaAdsPhase08Runtime/meta-diagnostic-20261015-day09';

export function approvedPrivateDirectory(path){return typeof path==='string'&&[resolve(PRIVATE_DIRECTORY),resolve(CANONICAL_PRIVATE_DIRECTORY)].includes(resolve(path));}

const PROJECT='ehnfrrmbkvlsbpvqcvkr',ACCOUNT='2138525300002203',CONNECTION='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6',DAY='2026-10-09',KIND='MANUAL_DIAGNOSTIC_META_DAY09_PURCHASE_V1';

const MAX=16777216,object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),aad=()=>Buffer.from(JSON.stringify([PROJECT,ACCOUNT,DAY,KIND,1]));

const fail=()=>{throw Error('PHASE08_META_DIAGNOSTIC_REJECTED');};

const b64=(value,length,max=MAX)=>{if(typeof value!=='string'||value.length>Math.ceil(max/3)*4+4)fail();const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value||(length!==undefined&&bytes.length!==length)||bytes.length>max){bytes.fill(0);fail();}return bytes;};

export function classifyMetaCapture(wire,catalog){

 if(!object(wire)||wire.accountId!==ACCOUNT||wire.day!==DAY||wire.profile!=='PURCHASE_V1')fail();

 const result={classification:'MANUAL_DIAGNOSTIC',day:DAY,stage:'CAPTURE_SELECTION',accepted:false,counts:{},providerRequests:0,databaseWrites:0,rawValuesReturned:0};

 try{

  validateMetaMcpCapture(wire);

  for(const level of ['ad','adset','campaign','ad_account'])result.counts[level]=wire.levels[level].length;

  result.parentIdentityMismatchCounts={missingAdset:0,missingCampaign:0,adsetCampaign:0,adsetName:0,campaignName:0};

  const sets=new Map(wire.levels.adset.map(row=>[row.id,row])),campaigns=new Map(wire.levels.campaign.map(row=>[row.id,row]));

  for(const row of wire.levels.ad){const parent=sets.get(row.adset_id),campaign=campaigns.get(row.campaign_id);if(!parent)result.parentIdentityMismatchCounts.missingAdset++;if(!campaign)result.parentIdentityMismatchCounts.missingCampaign++;if(parent&&parent.campaign_id!==row.campaign_id)result.parentIdentityMismatchCounts.adsetCampaign++;if(parent&&parent.name!==row.adset_name)result.parentIdentityMismatchCounts.adsetName++;if(campaign&&campaign.name!==row.campaign_name)result.parentIdentityMismatchCounts.campaignName++;}

  const selected=selectMetaMcpDay(wire);

  result.parentMismatchCounts={spend:0,impressions:0,clicks:0,linkClicks:0,purchaseCount:0};

  const metricFields={impressions:'impressions',clicks:'clicks',linkClicks:'link_click',purchaseCount:'omni_purchase'};

  const compare=(parent,children)=>{if(!children.reduce((sum,row)=>sum.plus(row.amount_spent.value),new Prisma.Decimal(0)).eq(parent.amount_spent.value))result.parentMismatchCounts.spend++;for(const [name,field] of Object.entries(metricFields)){if(parent[field]!==null&&children.every(row=>row[field]!==null)&&children.reduce((sum,row)=>sum+BigInt(row[field]),0n)!==BigInt(parent[field]))result.parentMismatchCounts[name]++;}};

  for(const parent of selected.selectedAdsets)compare(parent,wire.levels.ad.filter(row=>row.adset_id===parent.id));

  for(const parent of wire.levels.campaign)compare(parent,selected.selectedAdsets.filter(row=>row.campaign_id===parent.id));

  compare(wire.levels.ad_account[0],wire.levels.campaign);

  result.counts.nullAdLinks=wire.levels.ad.filter(r=>r.link_click===null).length;result.counts.nullAdPurchases=wire.levels.ad.filter(r=>r.omni_purchase===null).length;result.counts.excludedAdsets=selected.excludedAdsets.length;

  result.stage='LINK_RESIDUAL';const linkProof=result.counts.nullAdLinks?createMetaMcpResidualProof(wire,catalog):undefined;

  result.stage='PURCHASE_RESIDUAL';const purchaseProof=createMetaMcpPurchaseResidualProof(wire,catalog);result.derivedPurchaseZeroCounts={ads:purchaseProof.targetIds.length,campaigns:(purchaseProof.derivedParentTargets??[]).filter(row=>row.level==='campaign').length,adsets:(purchaseProof.derivedParentTargets??[]).filter(row=>row.level==='adset').length};

  result.stage='NORMALIZE';normalizeMetaMcpPurchaseSnapshot(wire,{version:1,transport:'META_ADS_MCP',linkProof,purchaseProof},catalog);

  result.stage='ACCEPTED';result.accepted=true;return result;

 }catch(error){if(result.stage==='PURCHASE_RESIDUAL')result.purchaseGateDiagnostics=inspectPurchaseGates(wire,catalog);return {...result,code:['RECONCILIATION_FAILED','FIELD_UNSUPPORTED','ACCOUNT_SCOPE_MISMATCH'].includes(error?.safeCode)?error.safeCode:'DIAGNOSTIC_VALIDATION_FAILED'};}

}

export function sealDiagnosticCapture(wire,key){

 const plain=Buffer.from(JSON.stringify(wire));try{if(plain.length<1||plain.length>MAX||!Buffer.isBuffer(key)||key.length!==32)fail();const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad());const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);return {version:1,projectRef:PROJECT,accountId:ACCOUNT,day:DAY,kind:KIND,iv:iv.toString('base64'),authTag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};}finally{plain.fill(0);}

}

export function openDiagnosticCapture(envelope,key){

 const fields=['version','projectRef','accountId','day','kind','iv','authTag','ciphertext'];if(!object(envelope)||Object.keys(envelope).sort().join()!==fields.sort().join()||envelope.version!==1||envelope.projectRef!==PROJECT||envelope.accountId!==ACCOUNT||envelope.day!==DAY||envelope.kind!==KIND||!Buffer.isBuffer(key)||key.length!==32)fail();

 const buffers=[];try{const iv=b64(envelope.iv,12,12),tag=b64(envelope.authTag,16,16),ciphertext=b64(envelope.ciphertext,undefined);buffers.push(iv,tag,ciphertext);const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(aad());decipher.setAuthTag(tag);const first=decipher.update(ciphertext);buffers.push(first);const last=decipher.final();buffers.push(last);const plain=Buffer.concat([first,last]);buffers.push(plain);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));}finally{buffers.forEach(b=>b.fill(0));}

}

async function privateDirectory(){

 if(process.platform!=='win32')fail();const requested=resolve(PRIVATE_DIRECTORY),directory=await realpath(requested);

 if(!approvedPrivateDirectory(directory))fail();

 for(const start of [requested,directory]){let current=start;for(;;){const info=await lstat(current);if(info.isSymbolicLink())fail();const parent=resolve(current,'..');if(parent===current)break;current=parent;}}

 const command="$ErrorActionPreference='Stop';$p='C:\\Users\\seong\\AppData\\Local\\MetaAdsPhase08Runtime\\meta-diagnostic-20261015-day09';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$a=Get-Acl -LiteralPath $p;if(-not $a.AreAccessRulesProtected){exit 1};if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18')){exit 1};foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.IdentityReference.Value -notin @($sid,'S-1-5-18') -or $r.AccessControlType -ne 'Allow'){exit 1}}";

 try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{stdio:'ignore',timeout:5000});}catch{fail();}return directory;

}

async function writeNew(path,value){const bytes=Buffer.from(JSON.stringify(value));let file;try{file=await open(path,'wx',0o600);await file.writeFile(bytes);await file.sync();return {bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}finally{await file?.close();bytes.fill(0);}}

async function readCipher(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>24000000)fail();const file=await open(path,'r');let bytes;try{bytes=await file.readFile();if(bytes.length!==info.size)fail();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}finally{await file.close();bytes?.fill(0);}}

function metadata(env,prefix){const json=env[prefix+'_JSON_B64'],gzip=env[prefix+'_GZIP_B64'];if((typeof json==='string')===(typeof gzip==='string'))fail();const encoded=b64(json??gzip,undefined,2097152);let bytes;try{bytes=json?encoded:gunzipSync(encoded,{maxOutputLength:1048576});if(bytes.length>1048576)fail();const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!object(value))fail();return value;}finally{encoded.fill(0);if(bytes!==encoded)bytes?.fill(0);}}

/** Private local replay material for a separately reviewed rollback diagnostic; no provider access. */

export async function loadMetaDiagnosticReplay(input){

 if(input?.projectRef!==PROJECT||input.artifactId!=='35428d2c-70e3-4eb3-a752-a189c232a0a2'||input.classification!=='MANUAL_DIAGNOSTIC'||input.day!==DAY||!object(input.env))fail();

 const directory=await privateDirectory(),path=join(directory,input.artifactId+'.json'),info=await lstat(path);

 if(!info.isFile()||info.isSymbolicLink()||info.size!==400752)fail();

 const file=await open(path,'r');let bytes,key;

 try{bytes=await file.readFile();if(bytes.length!==400752||createHash('sha256').update(bytes).digest('hex')!=='85d04b1ed6cccf9c84eedc0f25e89b0e0301cab8ea5174d3170372af61cbe880')fail();

 key=b64(input.captureKeyB64,32,32);if(Object.values(input.env).includes(input.captureKeyB64))fail();

 const wire=openDiagnosticCapture(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),key),catalog=metadata(input.env,'PHASE08_META_CATALOG');

 const linkProof=wire.levels.ad.some(row=>row.link_click===null)?createMetaMcpResidualProof(wire,catalog):undefined;

 const snapshot=normalizeMetaMcpPurchaseSnapshot(wire,{version:1,transport:'META_ADS_MCP',linkProof,purchaseProof:createMetaMcpPurchaseResidualProof(wire,catalog)},catalog);

 if(snapshot.ads.length!==55||snapshot.adsets.length!==13)fail();return snapshot;

 }finally{await file.close();bytes?.fill(0);key?.fill(0);}

}

export function safeMetaDiagnosticFailure(error){

 const value=error?.diagnostic,stages=['INPUT','DIRECTORY','METADATA','DB_IDENTITY','FAILED_UNIT','CREDENTIAL_FILE','AUTH','CAPTURE','SEAL','CLASSIFY'];

 const stage=typeof value?.stage==='string'&&stages.includes(value.stage)?value.stage:'INPUT';

 const counts=value?.providerRequests;const valid=Number.isSafeInteger(counts?.graphGet)&&counts.graphGet>=0&&counts.graphGet<=3&&Number.isSafeInteger(counts?.mcpPost)&&counts.mcpPost>=0&&counts.mcpPost<=100;

 return {state:'PHASE08_META_MANUAL_DIAGNOSTIC_FAILED',classification:'MANUAL_DIAGNOSTIC',stage,code:'DIAGNOSTIC_REJECTED',providerRequests:valid?{graphGet:counts.graphGet,mcpPost:counts.mcpPost}:null,providerCountsObserved:valid,rawErrorSuppressed:true,databaseWrites:0};

}

export async function runMetaDiagnostic(input,{request=fetch,factory=url=>new PrismaClient({datasourceUrl:url}),checkDirectory=privateDirectory,offlineClassifier=classifyMetaCapture}={}){

 let key,credential,db,recordPath,recordCreated=false,timer,closed=false,stage='INPUT';const started=Date.now();const controller=new AbortController(),buffers=[];const counts={graphGet:0,mcpPost:0};

 try{

  if(input?.projectRef!==PROJECT||!['capture','offline','preflight'].includes(input.mode)||input.classification!=='MANUAL_DIAGNOSTIC'||input.day!==DAY||!object(input.env))fail();const env=input.env;

  if(env.SUPABASE_DATABASE_PROJECT_REF!==PROJECT||env.SUPABASE_DATABASE_SCHEMA!=='phase08_meta_ads'||env.SUPABASE_DATABASE_RUNTIME_USER!=='phase08_runtime'||env.DAILY_SYNC_META_TRANSPORT!=='MCP'||env.PHASE08_META_CONNECTION_ID!==CONNECTION)fail();

  key=b64(input.captureKeyB64,32,32);if(Object.values(env).includes(input.captureKeyB64))fail();

  stage='DIRECTORY';const directory=await checkDirectory();if(!approvedPrivateDirectory(directory))fail();

  stage='METADATA';const catalog=metadata(env,'PHASE08_META_CATALOG'),reporting=metadata(env,'PHASE08_META_REPORT_SCHEMA');

  if(input.mode==='offline'){

   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.artifactId??''))fail();

   stage='SEAL';const envelope=await readCipher(join(directory,input.artifactId+'.json')),wire=openDiagnosticCapture(envelope,key);

   stage='CLASSIFY';return {state:'PHASE08_META_CAPTURE_REPLAYED',...offlineClassifier(wire,catalog),mode:'offline',artifactId:input.artifactId,providerRequests:{graphGet:0,mcpPost:0},originalFailureReproduced:false};

  }

  const deadline=started+55000;timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));

  const tracked=async(url,options={})=>{if(closed||controller.signal.aborted||options.signal?.aborted)fail();const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.hash)fail();const method=options.method??'GET';if(parsed.hostname==='graph.facebook.com'&&method==='GET'&&['/v26.0/debug_token','/v26.0/me',`/v26.0/act_${ACCOUNT}`].includes(parsed.pathname)){if(counts.graphGet>=3)fail();counts.graphGet++;}else if(parsed.href==='https://mcp.facebook.com/ads'&&method==='POST'){if(counts.mcpPost>=100)fail();counts.mcpPost++;}else fail();return request(url,{...options,redirect:'error',signal:AbortSignal.any([controller.signal,...(options.signal?[options.signal]:[])])});};

  const task=async()=>{try{if(Date.now()>=deadline)fail();

   stage='DB_IDENTITY';const url=assertBusinessDatabaseTarget({projectRef:PROJECT,freshVerified:true,databaseUrl:input.databaseUrl});db=factory(url);

   await db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5000'");const rows=await tx.$queryRawUnsafe("SELECT current_database() AS database,current_user AS role,current_schema() AS schema,current_setting('transaction_read_only') AS readonly,(SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables,EXISTS(SELECT 1 FROM sync_runs r JOIN source_connections source ON source.id=r.connection_id JOIN run_units u ON u.run_id=r.id WHERE source.provider='META' AND source.external_account_id='2138525300002203' AND source.shop_key='default' AND source.currency_code='USD' AND source.time_zone='Asia/Seoul' AND source.enabled AND source.access_state='READY' AND source.credential_ref=$3 AND source.credential_expires_at>clock_timestamp()+interval '7 days' AND r.connection_id=$1::uuid AND r.trigger='SCHEDULED' AND r.request_key=$2 AND r.status='ACTION_REQUIRED' AND r.safe_error_code='RECONCILIATION_FAILED' AND u.unit_key='2026-10-09' AND u.status='ACTION_REQUIRED' AND u.attempts=1 AND u.fetched_count=0 AND u.published_count=0 AND r.rows_published=68 AND r.rows_fetched=68 AND r.actor_user_id IS NULL AND r.from_date=date '2026-10-08' AND r.to_date=date '2026-10-14' AND (SELECT count(*) FROM run_units all_units WHERE all_units.run_id=r.id)=7 AND EXISTS(SELECT 1 FROM run_units successful WHERE successful.run_id=r.id AND successful.unit_key='2026-10-08' AND successful.status='SUCCEEDED' AND successful.attempts=2 AND successful.fetched_count=68 AND successful.published_count=68) AND NOT EXISTS(SELECT 1 FROM run_units remaining WHERE remaining.run_id=r.id AND remaining.unit_key NOT IN('2026-10-08','2026-10-09') AND (remaining.unit_key NOT BETWEEN '2026-10-10' AND '2026-10-14' OR remaining.status<>'QUEUED' OR remaining.attempts<>0 OR remaining.fetched_count<>0 OR remaining.published_count<>0)) AND NOT EXISTS(SELECT 1 FROM sync_leases l WHERE l.connection_id=r.connection_id AND l.expires_at>clock_timestamp())) AS failed",CONNECTION,'schedule:phase08-meta:'+createHash('sha256').update('2026-10-15T07:00:00.000Z').digest('hex'),env.DAILY_SYNC_META_CREDENTIAL_REF);if(rows.length!==1||rows[0].database!=='postgres'||rows[0].role!=='phase08_runtime'||rows[0].schema!=='phase08_meta_ads'||rows[0].readonly!=='on'||rows[0].tables!==68)fail();stage='FAILED_UNIT';if(rows[0].failed!==true)fail();},{timeout:8000,maxWait:1000});

   if(closed||controller.signal.aborted||Date.now()>=deadline)fail();

   stage='CREDENTIAL_FILE';const ref=env.DAILY_SYNC_META_CREDENTIAL_REF,uuid=env.PHASE08_META_REF_UUID;if(!/^[a-f0-9-]{36}$/.test(uuid??'')||ref!==`vault://meta/${uuid}`)fail();

   const record=b64(env.PHASE08_META_RECORD_B64,undefined,32768);buffers.push(record);const checkedRecord=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record));if(!object(checkedRecord)||checkedRecord.version!==1||Object.keys(checkedRecord).sort().join()!=='authTag,ciphertext,iv,version')fail();const checkedKey=b64(env.DAILY_SYNC_META_VAULT_KEY,32,32);checkedKey.fill(0);if(input.mode==='preflight')return {state:'PHASE08_META_DIAGNOSTIC_PREFLIGHT_VERIFIED',classification:'MANUAL_DIAGNOSTIC',providerRequests:{graphGet:0,mcpPost:0},databaseWrites:0,rawValuesReturned:0};recordPath=join(directory,uuid+'.json');let file;try{file=await open(recordPath,'wx',0o600);recordCreated=true;if(closed||controller.signal.aborted||Date.now()>=deadline)fail();await file.writeFile(record);if(closed||controller.signal.aborted||Date.now()>=deadline)fail();}finally{await file?.close();}

   stage='AUTH';credential=await resolveMetaCredential(new ProtectedFileMetaCredentialResolver(directory,env.DAILY_SYNC_META_VAULT_KEY,tracked),{credentialRef:ref,connectionId:CONNECTION,accountId:ACCOUNT,transport:'MCP'},new Date(),Math.min(20000,deadline-Date.now()));

   if(closed||controller.signal.aborted||Date.now()>=deadline)fail();

   stage='CAPTURE';const wire=await new MetaMcpWireReader(tracked,boundedMetaMcpEnvelope).fetchDay({accountId:ACCOUNT,day:DAY,accessToken:credential.token,clientConversationId:catalog.client_conversation_id,catalog,reporting,deadlineAt:deadline,allowUnverifiedIdentityCapture:true,profile:'PURCHASE_V1'});

   if(closed||controller.signal.aborted||Date.now()>=deadline)fail();

   stage='SEAL';const artifactId=randomUUID(),envelope=sealDiagnosticCapture(wire,key),path=join(directory,artifactId+'.json'),artifact=await writeNew(path,envelope);

   stage='CLASSIFY';return {state:'PHASE08_META_CAPTURED_AND_CLASSIFIED',...classifyMetaCapture(wire,catalog),mode:'capture',artifactId,artifactPath:path,artifactSha256:artifact.sha256,artifactBytes:artifact.bytes,providerRequests:counts,originalFailureReproduced:false};

  }finally{if(recordCreated){await unlink(recordPath).catch(()=>{});recordCreated=false;}}};

  return await Promise.race([task(),new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('TIMEOUT')),{once:true}))]);

 }catch{const error=Error('PHASE08_META_MANUAL_DIAGNOSTIC_FAILED');error.diagnostic={state:'PHASE08_META_MANUAL_DIAGNOSTIC_FAILED',classification:'MANUAL_DIAGNOSTIC',stage,providerRequests:{graphGet:counts.graphGet,mcpPost:counts.mcpPost},rawErrorSuppressed:true,databaseWrites:0};throw error;}finally{closed=true;controller.abort();clearTimeout(timer);if(credential)credential.token='';key?.fill(0);buffers.forEach(b=>b.fill(0));if(recordCreated)await unlink(recordPath).catch(()=>{});if(db)await Promise.race([db.$disconnect().catch(()=>{}),new Promise(resolve=>{const wait=setTimeout(resolve,500);wait.unref?.();})]);if(input&&typeof input==='object'){input.env=undefined;input.databaseUrl=undefined;input.captureKeyB64=undefined;}}

}

if(process.argv[1]?.endsWith('meta-failed-day09-diagnostic.mjs')){

 let raw='',input,output;const failure={state:'PHASE08_META_MANUAL_DIAGNOSTIC_FAILED',classification:'MANUAL_DIAGNOSTIC',rawErrorSuppressed:true,databaseWrites:0};

 const hard=setTimeout(()=>{process.stdout.write(JSON.stringify(failure),()=>process.exit(1));},60000);

 try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>2097152)fail();}input=JSON.parse(raw);raw='';output=await runMetaDiagnostic(input);}

 catch(error){output=safeMetaDiagnosticFailure(error);process.exitCode=1;}

 finally{raw='';input=undefined;}

 await new Promise(resolve=>process.stdout.write(JSON.stringify(output),resolve));clearTimeout(hard);process.exit(process.exitCode??0);

}

