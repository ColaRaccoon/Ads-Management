// Root-only protected stdin. Fixed October15 Cafe occurrence; no provider calls or writes.
import {PrismaClient} from '@prisma/client';
import {createHash,createDecipheriv} from 'node:crypto';
import {assertBusinessDatabaseTarget} from './seed-isolated-business-config.mjs';
import {normalizeCafe24Order} from '../../../apps/api/src/daily-sync/cafe24-order-adapter.ts';
import {verifiedCafe24V1Statuses,cafe24PaymentMethodCsvMap} from '../../../apps/api/src/daily-sync/sync-contract.ts';
import {isCafe24FailureDiagnosticCode} from '../../../apps/api/src/daily-sync/cafe24-failure-diagnostic.ts';
const ID='0c35defe-45fc-4a54-bc79-704df7bca5b1',DAY='2026-10-14',DUE='2026-10-15T01:00:00.000Z';
const REQUEST='schedule:phase08-cafe24:'+createHash('sha256').update(DUE).digest('hex');
let diagnosticStage='TARGET';
export function safeCheckpointFailure(error){const stages=['TARGET','KEY','IDENTITY','CHECKPOINT','ENVELOPE','STATE'];const code=typeof error?.code==='string'?error.code:typeof error?.errorCode==='string'?error.errorCode:null;return {state:'PHASE08_CHECKPOINT_DIAGNOSTIC_FAILED',stage:stages.includes(diagnosticStage)?diagnosticStage:'TARGET',code:typeof code==='string'&&/^P[0-9]{4}$/.test(code)?code:stages.includes(error?.message)?error.message:'UNCLASSIFIED',rawErrorSuppressed:true,providerRequests:0,databaseWrites:0};}
const stages=new Set(['LIST_FIRST','ITEMS_FIRST','LIST_VERIFY','ITEMS_VERIFY','READY']);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v,max=8000)=>Number.isInteger(v)&&v>=0&&v<=max;
const type=v=>v===undefined?'MISSING':v===null?'NULL':Array.isArray(v)?'ARRAY':typeof v==='string'?'STRING':typeof v==='number'?'NUMBER':typeof v==='boolean'?'BOOLEAN':object(v)?'OBJECT':'OTHER';
export function classifyCheckpoint(state,env){
 if(!object(state)||state.version!==1||state.connectionId!==ID||state.day!==DAY||!stages.has(state.stage)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(state.startedAt)||new Date(state.startedAt).toISOString()!==state.startedAt||!['count','cursor','verifiedItems'].every(k=>integer(state[k]))||!integer(state.pages,162)||!['first','second','items'].every(k=>Array.isArray(state[k])&&state[k].length<=state.count))throw Error('STATE');
 const firstDone=state.first.length===state.count,itemsDone=state.items.length===state.count;
 const validStage=state.stage==='LIST_FIRST'?state.second.length===0&&state.items.length===0&&state.cursor===0&&state.verifiedItems===0:state.stage==='ITEMS_FIRST'?firstDone&&state.second.length===0&&state.cursor===state.items.length&&state.verifiedItems===0:state.stage==='LIST_VERIFY'?firstDone&&itemsDone&&state.cursor===0&&state.verifiedItems===0:state.stage==='ITEMS_VERIFY'?firstDone&&itemsDone&&state.second.length===state.count&&state.cursor===state.verifiedItems:firstDone&&itemsDone&&state.second.length===state.count&&state.cursor===0&&state.verifiedItems===state.count;
 if(!validStage)throw Error('STATE');
 if(state.cursor>state.count||state.verifiedItems>state.count||state.items.some(items=>!Array.isArray(items)||items.length===0||items.length>=100))throw Error('STATE');
 const approved=verifiedCafe24V1Statuses(env),paymentMethodCsvLabels=cafe24PaymentMethodCsvMap(env),statusFrequency={},fieldTypes={},diagnostics={};let futureUpdatedOrders=0,invalidUpdatedOrders=0,storedPrefixChecked=0;
 const addDiagnostic=code=>{const safe=isCafe24FailureDiagnosticCode(code)?code:'CAFE24_DIAGNOSTIC_UNCLASSIFIED';diagnostics[safe]=(diagnostics[safe]??0)+1;};
 const status=(v,kind)=>{if(v==null)return;const key=typeof v==='string'&&/^[A-Z][0-9]{2}$/.test(v)?v:'INVALID';const name=kind+':'+key;statusFrequency[name]=(statusFrequency[name]??0)+1;if(Object.keys(statusFrequency).length>66)throw Error('STATUS_BOUND');};
 const fields=['order_date','updated_date','order_status','payment_amount','order_price_amount','actual_order_amount','initial_order_amount','payment_method'];
 const options={verifiedSellerDropdown:true,csvOptionEvidence:{mallId:'didadi0729',shopKey:'shop1'},paymentMethodCsvLabels};
 for(const [index,row] of state.first.entries()){
  if(!object(row))throw Error('STATE');
  for(const field of fields){const key=field+':'+type(row[field]);fieldTypes[key]=(fieldTypes[key]??0)+1;}
  status(row.order_status,'ORDER');
  if(row.updated_date!=null){const value=typeof row.updated_date==='string'?Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(row.updated_date)?row.updated_date.replace(' ','T'):row.updated_date.replace(' ','T')+'+09:00'):NaN;if(!Number.isFinite(value))invalidUpdatedOrders++;else if(value>Date.parse(state.startedAt))futureUpdatedOrders++;}
  const stored=state.items[index];
  if(stored){for(const item of stored){if(!object(item))throw Error('STATE');status(item.order_status,'ITEM');for(const field of ['order_status','option_value','quantity','product_price']){const key='item.'+field+':'+type(item[field]);fieldTypes[key]=(fieldTypes[key]??0)+1;}}
   try{normalizeCafe24Order(row,stored,options);storedPrefixChecked++;}catch(error){addDiagnostic(error?.diagnosticCode);}
  }else{try{normalizeCafe24Order(row,[{order_item_code:'VALIDATION_ONLY',product_no:'0',product_name:'validation',option_value:'validation',quantity:'0',product_price:'0',order_status:'N00'}],options);}catch(error){addDiagnostic(error?.diagnosticCode);}}
 }
 const unknownApprovedStatusCounts=Object.fromEntries(Object.entries(statusFrequency).filter(([key])=>key.endsWith(':INVALID')||!approved.has(key.split(':')[1])));
 return {stage:state.stage,count:state.count,pages:state.pages,firstLen:state.first.length,secondLen:state.second.length,itemsLen:state.items.length,cursor:state.cursor,verifiedItems:state.verifiedItems,startedAt:state.startedAt,fieldTypes,statusFrequency,unknownApprovedStatusCounts,futureProviderUpdatedAt:futureUpdatedOrders>0,futureUpdatedOrders,invalidUpdatedOrders,diagnosticCounts:diagnostics,storedPrefixChecked,currentCursorItemsAvailable:Array.isArray(state.items[state.cursor]),failedUncommittedResponseAvailable:false};
}
export async function diagnoseCheckpoint(input,factory=url=>new PrismaClient({datasourceUrl:url})){
 let db,key;const buffers=[];try{
  diagnosticStage='TARGET';const env=input?.env;
  if(input?.projectRef!=='ehnfrrmbkvlsbpvqcvkr'||!env||env.SUPABASE_DATABASE_PROJECT_REF!=='ehnfrrmbkvlsbpvqcvkr'||env.SUPABASE_URL!=='https://ehnfrrmbkvlsbpvqcvkr.supabase.co'||env.DEPLOYMENT_ENVIRONMENT_ID!=='phase08-daily-data-sync-08'||env.SUPABASE_DATABASE_SCHEMA!=='phase08_meta_ads'||env.SUPABASE_DATABASE_RUNTIME_USER!=='phase08_runtime')throw Error('TARGET');
  const url=assertBusinessDatabaseTarget({projectRef:input.projectRef,freshVerified:true,databaseUrl:input.databaseUrl});
  diagnosticStage='KEY';const encoded=env.DAILY_SYNC_CHECKPOINT_KEY_B64;if(typeof encoded!=='string')throw Error('KEY');key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded||Object.entries(env).some(([name,value])=>name!=='DAILY_SYNC_CHECKPOINT_KEY_B64'&&/CREDENTIAL_KEY|SECRET|TOKEN|VAULT_KEY/.test(name)&&value===encoded))throw Error('KEY');
  diagnosticStage='IDENTITY';db=factory(url);let summary,expired;
  await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
   await tx.$executeRawUnsafe("SET LOCAL statement_timeout='10000'");
   const identity=await tx.$queryRawUnsafe("SELECT current_database() AS database,current_user AS role,current_schema() AS schema,current_setting('transaction_read_only') AS readonly,(SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables");
   if(identity.length!==1||identity[0].database!=='postgres'||identity[0].role!=='phase08_runtime'||identity[0].schema!=='phase08_meta_ads'||identity[0].readonly!=='on'||identity[0].tables!==68)throw Error('IDENTITY');
   diagnosticStage='CHECKPOINT';const rows=await tx.$queryRawUnsafe("SELECT r.id,c.ciphertext,c.iv,c.auth_tag,c.expires_at FROM sync_runs r JOIN sync_unit_checkpoints c ON c.run_id=r.id WHERE r.connection_id=$1::uuid AND r.trigger='SCHEDULED' AND r.request_key=$2 AND r.from_date='2026-10-14'::date AND r.to_date='2026-10-14'::date AND c.unit_key='2026-10-14' LIMIT 2",ID,REQUEST);
   if(rows.length!==1)throw Error('CHECKPOINT');const row=rows[0];
   diagnosticStage='ENVELOPE';for(const field of ['ciphertext','iv','auth_tag']){if(row[field] instanceof Uint8Array){buffers.push(row[field]);row[field]=Buffer.from(row[field]);}}if(typeof row.id!=='string'||! /^[a-f0-9-]{36}$/.test(row.id)||!Buffer.isBuffer(row.ciphertext)||row.ciphertext.length<1||row.ciphertext.length>16777216||!Buffer.isBuffer(row.iv)||row.iv.length!==12||!Buffer.isBuffer(row.auth_tag)||row.auth_tag.length!==16||!(row.expires_at instanceof Date)||!Number.isFinite(row.expires_at.getTime()))throw Error('ENVELOPE');
   buffers.push(row.ciphertext,row.iv,row.auth_tag);const decipher=createDecipheriv('aes-256-gcm',key,row.iv);decipher.setAAD(Buffer.from(`${ID}:${row.id}:${DAY}`));decipher.setAuthTag(row.auth_tag);
   const first=decipher.update(row.ciphertext);buffers.push(first);const last=decipher.final();buffers.push(last);const plain=Buffer.concat([first,last]);buffers.push(plain);
   diagnosticStage='STATE';const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));summary=classifyCheckpoint(state,env);expired=row.expires_at<=new Date();
  },{timeout:15000,maxWait:2000});
  return {state:'PHASE08_CHECKPOINT_READONLY_DIAGNOSED',checkpointExpired:expired,...summary,providerRequests:0,databaseWrites:0,rawValuesReturned:0};
 }finally{key?.fill(0);buffers.forEach(buffer=>buffer.fill(0));try{await db?.$disconnect();}finally{if(input&&typeof input==='object'){input.env=undefined;input.databaseUrl=undefined;}}}
}
if(process.argv[1]?.endsWith('checkpoint-readonly-diagnostic.mjs')){
 let raw='',input;try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>1048576)throw Error('BOUND');}input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(await diagnoseCheckpoint(input)));}catch(error){process.stdout.write(JSON.stringify(safeCheckpointFailure(error)));process.exitCode=1;}finally{raw='';input=undefined;}
}
