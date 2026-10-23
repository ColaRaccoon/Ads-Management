// Exact archived failure diagnosis. Expired checkpoints are examined only as
// evidence; they are never resumed, renewed, written or passed to the runner.
import {PrismaClient} from '@prisma/client';
import {createDecipheriv,createHash} from 'node:crypto';
import {assertBusinessDatabaseTarget} from './seed-isolated-business-config.mjs';
import {normalizeCafe24Order} from '../../../apps/api/src/daily-sync/cafe24-order-adapter.ts';
import {isCafe24FailureDiagnosticCode} from '../../../apps/api/src/daily-sync/cafe24-failure-diagnostic.ts';
import {verifiedCafe24V1Statuses,cafe24PaymentMethodCsvMap,assertCafe24AppVersionEvidence,assertCafe24SellerOptionsEvidence} from '../../../apps/api/src/daily-sync/sync-contract.ts';
const ID='0c35defe-45fc-4a54-bc79-704df7bca5b1',RUN='a4f7bcea-bfa8-4699-b3f0-34e118889710',DAY='2026-10-17';
const REQUEST='schedule:phase08-cafe24:1f31864bca884bebbec09c4fb92e069d153791e4b84d562aa53ae646a8f9dbdc';
const fail=()=>{throw Error('PHASE10_SAFE_DIAGNOSTIC_REJECTED');};
const hash=value=>createHash('sha256').update(value).digest('hex');
function decrypt(row,rawKey,aad,buffers){
 const key=Buffer.from(rawKey??'','base64');buffers.push(key);if(key.length!==32||key.toString('base64')!==rawKey)fail();
 const ciphertext=Buffer.from(row.ciphertext),iv=Buffer.from(row.iv),tag=Buffer.from(row.auth_tag);buffers.push(ciphertext,iv,tag);
 if(iv.length!==12||tag.length!==16||ciphertext.length>16777216)fail();
 const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(tag);
 const plain=Buffer.concat([cipher.update(ciphertext),cipher.final()]);buffers.push(plain);return new TextDecoder('utf-8',{fatal:true}).decode(plain);
}
export async function diagnosePhase10ArchivedCafe(input,{factory=url=>new PrismaClient({datasourceUrl:url}),request=fetch}={}){
 let db,stage='TARGET',calls=0,access='',state,cp;const buffers=[];
 try{
  if(input?.projectRef!=='ehnfrrmbkvlsbpvqcvkr'||!['ARCHIVED_CHECKPOINT_READONLY','CURRENT_SINGLE_ITEM_READONLY'].includes(input.classification)||
    input.env?.SUPABASE_DATABASE_SCHEMA!=='phase08_meta_ads'||input.env?.SUPABASE_DATABASE_RUNTIME_USER!=='phase08_runtime')fail();
  if(new Date().toISOString().slice(0,10)!=='2026-10-19')fail();
  const env=input.env,url=assertBusinessDatabaseTarget({projectRef:input.projectRef,freshVerified:true,databaseUrl:input.databaseUrl});
  db=factory(url);stage='ARCHIVED_READONLY';
  await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5000'");
   const identity=await tx.$queryRawUnsafe("SELECT current_database() AS database,current_user AS role,current_schema() AS schema,current_setting('transaction_read_only') AS readonly");
   if(identity.length!==1||identity[0].database!=='postgres'||identity[0].role!=='phase08_runtime'||identity[0].schema!=='phase08_meta_ads'||identity[0].readonly!=='on')fail();
   const rows=await tx.$queryRawUnsafe("SELECT c.ciphertext,c.iv,c.auth_tag,c.expires_at,c.revision FROM sync_runs r JOIN source_connections s ON s.id=r.connection_id JOIN run_units u ON u.run_id=r.id JOIN sync_unit_checkpoints c ON c.run_id=r.id AND c.unit_key=u.unit_key WHERE r.id=$1::uuid AND r.connection_id=$2::uuid AND r.request_key=$3 AND s.provider='CAFE24' AND s.external_account_id='didadi0729' AND s.shop_key='shop1' AND s.currency_code='KRW' AND s.time_zone='Asia/Seoul' AND r.trigger='SCHEDULED' AND r.status='ACTION_REQUIRED' AND r.safe_error_code='FIELD_UNSUPPORTED' AND r.attempt_count=7 AND r.rows_published=0 AND u.unit_key=$4 AND u.status='ACTION_REQUIRED' AND u.attempts=1 AND u.published_count=0 AND NOT EXISTS(SELECT 1 FROM sync_leases WHERE connection_id=r.connection_id AND expires_at>clock_timestamp()) LIMIT 2",RUN,ID,REQUEST,DAY);
   if(rows.length!==1||rows[0].revision!==6||rows[0].ciphertext.length!==126852||!(rows[0].expires_at instanceof Date)||rows[0].expires_at.toISOString()!=='2026-10-17T19:00:19.119Z')fail();
   cp=rows[0];state=JSON.parse(decrypt(cp,env.DAILY_SYNC_CHECKPOINT_KEY_B64,`${ID}:${RUN}:${DAY}`,buffers));
   if(state.version!==1||state.connectionId!==ID||state.day!==DAY||!['LIST_FIRST','ITEMS_FIRST','LIST_VERIFY','ITEMS_VERIFY','READY'].includes(state.stage)||
     !Number.isInteger(state.count)||state.count<0||state.count>8000||!Number.isInteger(state.pages)||state.pages<0||state.pages>162||
     !Array.isArray(state.first)||!Array.isArray(state.second)||!Array.isArray(state.items)||
     state.first.length>state.count||state.second.length>state.count||state.items.length>state.count||
     state.items.some(items=>!Array.isArray(items)||items.length<1||items.length>=100)||
     !Number.isInteger(state.cursor)||state.cursor<0||state.cursor>state.first.length||
     !Number.isInteger(state.verifiedItems)||state.verifiedItems<0||state.verifiedItems>state.count||
     typeof state.startedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(state.startedAt)||!Number.isFinite(Date.parse(state.startedAt)))fail();
   const firstDone=state.first.length===state.count,itemsDone=state.items.length===state.count;
   const validStage=state.stage==='LIST_FIRST'?state.second.length===0&&state.items.length===0&&state.cursor===0&&state.verifiedItems===0:
    state.stage==='ITEMS_FIRST'?firstDone&&state.second.length===0&&state.cursor===state.items.length&&state.verifiedItems===0:
    state.stage==='LIST_VERIFY'?firstDone&&itemsDone&&state.cursor===0&&state.verifiedItems===0:
    state.stage==='ITEMS_VERIFY'?firstDone&&itemsDone&&state.second.length===state.count&&state.cursor===state.verifiedItems:
    firstDone&&itemsDone&&state.second.length===state.count&&state.cursor===0&&state.verifiedItems===state.count;
   if(!validStage)fail();
   if(input.classification==='CURRENT_SINGLE_ITEM_READONLY'){
    stage='ACCESS_READONLY';
    const rows=await tx.$queryRawUnsafe("SELECT ciphertext,iv,auth_tag,key_version,expires_at FROM source_credentials WHERE connection_id=$1::uuid AND kind='CAFE24_ACCESS' LIMIT 2",ID);
    stage='ACCESS_METADATA';
    if(rows.length!==1||!Number.isInteger(rows[0].key_version)||rows[0].key_version<1||rows[0].key_version>99||
      !(rows[0].expires_at instanceof Date)||!Number.isFinite(rows[0].expires_at.getTime()))fail();
    stage='ACCESS_MINIMUM_TTL';if(rows[0].expires_at.getTime()<Date.now()+120000)fail();
    stage='ACCESS_DECRYPT';
    access=decrypt(rows[0],env[`DAILY_SYNC_CREDENTIAL_KEY_V${rows[0].key_version}`],`${ID}:CAFE24_ACCESS:${rows[0].key_version}`,buffers);
    if(!/^[\x21-\x7e]{20,8192}$/.test(access))fail();
   }
  },{timeout:10000,maxWait:1000});
  stage='OFFLINE_NORMALIZE';const approved=verifiedCafe24V1Statuses(env),labels=cafe24PaymentMethodCsvMap(env),diagnostics={};
  const diagnose=(row,items)=>{try{
    const lines=normalizeCafe24Order(row,items,{verifiedSellerDropdown:true,csvOptionEvidence:{mallId:'didadi0729',shopKey:'shop1'},paymentMethodCsvLabels:labels});
    if(lines.some(l=>l.providerUpdatedAt&&l.providerUpdatedAt>new Date(state.startedAt)))return 'CAFE24_PROVIDER_TIME_FUTURE';
    if(lines.some(l=>l.orderStatus&&!approved.has(l.orderStatus)||!approved.has(l.lineStatus??'')))return 'CAFE24_STATUS_APPROVAL_MISMATCH';
    return null;
   }catch(error){return isCafe24FailureDiagnosticCode(error?.diagnosticCode)?error.diagnosticCode:'CAFE24_DIAGNOSTIC_UNCLASSIFIED';}};
  for(let i=0;i<state.items.length;i++){const code=diagnose(state.first[i],state.items[i]);if(code)diagnostics[code]=(diagnostics[code]??0)+1;}
  const metadata={};for(const row of [...state.first,...state.second]){
   const code=diagnose(row,[{order_item_code:'SYNTHETIC_SENTINEL',product_no:'0',product_name:'Synthetic',option_value:'Synthetic',quantity:'0',product_price:'0',order_status:'N00'}]);
   if(code)metadata[code]=(metadata[code]??0)+1;
  }
  const output={kind:'PHASE10_ARCHIVED_CAFE_FAILURE_DIAGNOSTIC',classification:input.classification,day:DAY,
   observedAt:new Date().toISOString(),archivedCheckpoint:{stage:state.stage,count:state.count,first:state.first.length,second:state.second.length,items:state.items.length,cursor:state.cursor,verifiedItems:state.verifiedItems,
    expiresAt:cp.expires_at.toISOString(),expired:true,revision:cp.revision,encryptedContentSha256:hash(cp.ciphertext)},
   archivedItemDiagnostics:diagnostics,archivedMetadataDiagnostics:metadata,providerRequests:0,databaseWrites:0,credentialRefreshes:0,checkpointResumed:false,checkpointWritten:false,originalFailureReproduced:false,rawValuesReturned:0};
  if(input.classification==='CURRENT_SINGLE_ITEM_READONLY'){
   stage='CURRENT_SINGLE_ITEM';assertCafe24AppVersionEvidence(env);assertCafe24SellerOptionsEvidence(env);
   if(!['ITEMS_FIRST','ITEMS_VERIFY'].includes(state.stage)||state.cursor>=state.first.length)fail();
   const row=state.first[state.cursor],id=row.order_id;if(typeof id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(id))fail();
   const url=new URL(`https://didadi0729.cafe24api.com/api/v2/admin/orders/${id}/items`);url.searchParams.set('shop_no','1');
   url.searchParams.set('fields','order_item_code,product_no,product_name,option_value,quantity,product_price,order_status');
   calls++;const response=await request(url,{method:'GET',headers:{Authorization:`Bearer ${access}`},redirect:'error',signal:AbortSignal.timeout(20000)});
   if(!response.ok||!String(response.headers.get('content-type')).toLowerCase().includes('json'))fail();
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>2097152))fail();
   if(!response.body)fail();const reader=response.body.getReader(),chunks=[];let bytes=0;
   try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2097152||chunks.length>=512){await reader.cancel();fail();}chunks.push(part.value);}}
   finally{reader.releaseLock();}
   const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)))));
   if(!Array.isArray(body.items)||body.items.length===0||body.items.length>=100)fail();
   output.currentObservation={itemRows:body.items.length,failedPredicate:diagnose(row,body.items),statusCounts:{},fieldTypes:{}};
   for(const item of body.items){const status=typeof item.order_status==='string'&&/^[A-Z][0-9]{2}$/.test(item.order_status)?item.order_status:'INVALID';output.currentObservation.statusCounts[status]=(output.currentObservation.statusCounts[status]??0)+1;
    for(const field of ['order_status','option_value','quantity','product_price']){const value=item[field],type=value==null?(value===null?'NULL':'MISSING'):Array.isArray(value)?'ARRAY':typeof value;const key=`${field}:${type}`;output.currentObservation.fieldTypes[key]=(output.currentObservation.fieldTypes[key]??0)+1;}}
   output.providerRequests=calls;
  }
  return output;
 }catch{throw Object.assign(Error('PHASE10_SAFE_DIAGNOSTIC_FAILED'),{safeDiagnostic:{kind:'PHASE10_CAFE_DIAGNOSTIC_FAILED',stage,providerRequests:calls,databaseWrites:0,credentialRefreshes:0,rawErrorSuppressed:true}});}
 finally{access='';buffers.forEach(b=>b.fill(0));await db?.$disconnect().catch(()=>{});if(input){input.env=undefined;input.databaseUrl=undefined;}}
}
if(process.argv[1]?.endsWith('phase10-api-cafe-diagnostic.mjs')){
 let input,raw='',output;try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>2097152)fail();}input=JSON.parse(raw);raw='';output=await diagnosePhase10ArchivedCafe(input);}
 catch(error){output=error.safeDiagnostic??{kind:'PHASE10_CAFE_DIAGNOSTIC_FAILED',rawErrorSuppressed:true};process.exitCode=1;}
 finally{input=undefined;raw='';}process.stdout.write(JSON.stringify(output));
}
