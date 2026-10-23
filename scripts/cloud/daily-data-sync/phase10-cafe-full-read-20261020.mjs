// The production fetchDaySnapshot method is called unchanged. Only its I/O seam
// is replaced: no Prisma writer, OAuth refresh, retry, or durable observation.
import 'reflect-metadata';
import {Cafe24OrdersClient} from '../../../apps/api/src/daily-sync/cafe24-orders.client.ts';
import {ProviderFailure} from '../../../apps/api/src/daily-sync/bounded-request.ts';
import {isCafe24FailureDiagnosticCode} from '../../../apps/api/src/daily-sync/cafe24-failure-diagnostic.ts';
import {prepareCafeFieldSample} from './phase10-cafe-field-sample-20261020.mjs';
import {CAFE08_ID} from './phase10-cafe-pair-recovery-20261020.mjs';
const DAYS=['2026-10-16','2026-10-17'],HOST='https://didadi0729.cafe24api.com';
const ORDER_FIELDS='order_id,shop_no,order_date,updated_date,payment_amount,order_price_amount,actual_order_amount,initial_order_amount,payment_method,order_status,currency';
const ITEM_FIELDS='order_item_code,product_no,product_name,option_value,quantity,product_price,order_status';
const MAX_CALLS=2050,MAX_TOTAL_BYTES=64*1024*1024,MAX_BODY=2*1024*1024;
const EVIDENCE_KEYS=['DAILY_SYNC_CAFE24_APP_API_VERSION','DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT','DAILY_SYNC_CAFE24_SELLER_DROPDOWN','DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT','DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES','DAILY_SYNC_CAFE24_VERIFIED_NORMAL_STATUSES','DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED','DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT','DAILY_SYNC_CAFE24_PAYMENT_METHOD_CSV_MAP','DAILY_SYNC_CAFE24_PAYMENT_METHOD_MAP_VERIFIED_AT'];
const failure=(code='FULL_READ_SAFE_REJECTED')=>{throw Object.assign(new ProviderFailure('FIELD_UNSUPPORTED',false),{fixed:code});};
export function prepareCafeFullRead(input,now=Date.now()){
 if(input?.operationKey!=='20261020-cafe08-full-read-a')failure();
 const prepared=prepareCafeFieldSample(input.input,now);
 return{...prepared,safeSummary:{preparedOnly:true,unitDays:DAYS,maximumGets:MAX_CALLS,maximumBodyBytes:MAX_BODY,maximumTotalBytes:MAX_TOTAL_BYTES,diagnosticOrderCapPerDay:500,dayDeadlineMs:600000,itemPacingMs:500,requestTimeoutMs:20000,wholeDayMethod:'FROZEN_FETCH_DAY_SNAPSHOT',transportOverrideOnly:true,explicitVersionHeaderSent:false,observationHoldPreserved:true,providerRequests:0,databaseWrites:0,rawValuesReturned:0,canonicalPublished:false,originalFailureCauseConfirmed:false}};
}
export async function runCafeFullReadDay(prepared,day,{request=fetch,usedRequests=0,usedBytes=0}={}){
 if(!DAYS.includes(day)||!prepared?.access||!Number.isFinite(prepared.startedAt)||Date.now()>prepared.startedAt+60000||!Number.isSafeInteger(usedRequests)||usedRequests<0||usedRequests>=MAX_CALLS||!Number.isSafeInteger(usedBytes)||usedBytes<0||usedBytes>=MAX_TOTAL_BYTES)failure();
 const started=Date.now(),deadline=started+600000;let stopped=false,firstFixed=null;const activeControllers=new Set(),activeConsumes=new Set();
 const report={kind:'CAFE08_FULL_CURRENT_DAY_READ',day,startedAt:new Date(started).toISOString(),status:'IN_PROGRESS',completeTwoPass:false,providerRequests:0,itemRequests:0,countRequests:0,listRequests:0,responseBytes:0,versionVerifiedResponses:0,connectionStubReads:0,oauthStubReads:0,orderCount:null,lineCount:null,uniqueLineCount:null,pageCount:null,currentObservationOnly:true,canonicalPublished:false,originalFailureCauseConfirmed:false,originalFailedRunChanged:false,checkpointResumed:false,observationHoldPreserved:true,databaseWrites:0,rawValuesReturned:0,automaticRetry:false,automaticRefresh:false,explicitVersionHeaderSent:false,transportOverrideOnly:true};
 const envNames=[...EVIDENCE_KEYS,'DAILY_SYNC_FEATURE_ENABLED','DAILY_SYNC_ALLOWED_ACCOUNTS'],previous=new Map(envNames.map(name=>[name,process.env[name]]));
 const reject=code=>{stopped=true;firstFixed??=code;for(const controller of activeControllers)controller.abort();failure(code);};
 const deny=()=>reject('DATABASE_OR_OAUTH_SCOPE');
 const prisma=new Proxy({sourceConnection:new Proxy({findUnique:async query=>{if(JSON.stringify(query)!==JSON.stringify({where:{id:CAFE08_ID}}))deny();report.connectionStubReads++;return{id:CAFE08_ID,provider:'CAFE24',externalAccountId:'didadi0729',shopKey:'shop1',currencyCode:'KRW',timeZone:'Asia/Seoul',enabled:false};}},{get:(target,key)=>key==='findUnique'?target.findUnique:deny()})},{get:(target,key)=>key==='sourceConnection'?target.sourceConnection:deny()});
 const oauth=new Proxy({accessToken:async(...args)=>{if(JSON.stringify(args)!==JSON.stringify([CAFE08_ID,'didadi0729','shop1']))deny();report.oauthStubReads++;return prepared.access;}},{get:(target,key)=>key==='accessToken'?target.accessToken:deny()});
 const getJson=async(url,token,clientDeadline)=>{
  const query=url.searchParams,path=url.pathname,isCount=path==='/api/v2/admin/orders/count',isList=path==='/api/v2/admin/orders',isItem=/^\/api\/v2\/admin\/orders\/[A-Za-z0-9_-]{1,128}\/items$/.test(path);
  const keys=[...query.keys()].sort(),expected=(isItem?['shop_no','fields']:isCount?['shop_no','start_date','end_date','date_type']:['shop_no','start_date','end_date','date_type','limit','offset','fields']).sort();
  if(stopped||Date.now()>=deadline||url.origin!==HOST||url.username||url.password||url.hash||!isCount&&!isList&&!isItem||token!==prepared.access||query.get('shop_no')!=='1'||JSON.stringify(keys)!==JSON.stringify(expected)||clientDeadline!==deadline||!isItem&&(query.get('start_date')!==day||query.get('end_date')!==day||query.get('date_type')!=='order_date')||isItem&&query.get('fields')!==ITEM_FIELDS||isList&&(query.get('fields')!==ORDER_FIELDS||query.get('limit')!=='100'||!/^(?:0|100|200|300|400|500)$/.test(query.get('offset')??'')))reject('REQUEST_SCOPE_OR_DEADLINE');
  if(usedRequests+report.providerRequests>=MAX_CALLS||usedBytes+report.responseBytes>=MAX_TOTAL_BYTES)reject('TOTAL_REQUEST_OR_BYTE_BOUND');
  report.providerRequests++;if(isCount)report.countRequests++;else if(isList)report.listRequests++;else report.itemRequests++;
  const controller=new AbortController(),remaining=Math.min(20000,deadline-Date.now());activeControllers.add(controller);let timer;const buffers=[];let reader,response,bytes=0;
  try{
   const timeout=new Promise((_,rejectPromise)=>{timer=setTimeout(()=>{controller.abort();rejectPromise(Object.assign(Error(),{fixed:'TRANSPORT_OR_TIMEOUT'}));},remaining);});
   const consume=async()=>{
    try{response=await request(url,{method:'GET',redirect:'error',cache:'no-store',signal:controller.signal,headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});}catch{reject('TRANSPORT_OR_TIMEOUT');}
    if(stopped){await response.body?.cancel().catch(()=>{});failure(firstFixed??'READ_ALREADY_STOPPED');}
    if(response.status!==200){await response.body?.cancel().catch(()=>{});reject([400,404,422].includes(response.status)?`CAFE24_RESPONSE_HTTP_${response.status}`:[401,403].includes(response.status)?'PROVIDER_AUTH_REQUIRED':response.status===429?'PROVIDER_RATE_LIMITED':'PROVIDER_UNAVAILABLE');}
    if(response.headers.get('x-cafe24-api-version')!=='2026-09-01'){await response.body?.cancel().catch(()=>{});reject('API_VERSION_UNVERIFIED');}report.versionVerifiedResponses++;
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY||Number(length)>MAX_TOTAL_BYTES-usedBytes-report.responseBytes)){await response.body?.cancel().catch(()=>{});reject('BODY_BOUND');}
    if(!response.body)reject('BODY_ABSENT');reader=response.body.getReader();
    while(true){const part=await reader.read();if(stopped){await reader.cancel().catch(()=>{});failure(firstFixed??'READ_ALREADY_STOPPED');}if(part.done)break;const next=part.value.byteLength;if(bytes+next>MAX_BODY||buffers.length>=512||usedBytes+report.responseBytes+next>MAX_TOTAL_BYTES){await reader.cancel().catch(()=>{});reject('BODY_BOUND');}bytes+=next;report.responseBytes+=next;buffers.push(Buffer.from(part.value));}
    const raw=Buffer.concat(buffers);let body;try{body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{reject('CAFE24_RESPONSE_INVALID_JSON');}finally{raw.fill(0);}
    if(isCount&&(!Number.isSafeInteger(body?.count)||body.count<0||body.count>500))reject('DIAGNOSTIC_COUNT_CAP_OR_SHAPE');
    return{body,bytes};
   };
   const pending=consume();activeConsumes.add(pending);pending.then(()=>activeConsumes.delete(pending),()=>activeConsumes.delete(pending));
   return await Promise.race([pending,timeout]);
  }catch(error){if(error instanceof ProviderFailure){stopped=true;throw error;}reject(error?.fixed==='TRANSPORT_OR_TIMEOUT'?'TRANSPORT_OR_TIMEOUT':'SAFE_TRANSPORT_REJECTED');}
  finally{clearTimeout(timer);controller.abort();activeControllers.delete(controller);if(reader){await reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}buffers.forEach(buffer=>buffer.fill(0));}
 };
 class DiagnosticClient extends Cafe24OrdersClient{async getJson(...args){return getJson(...args);}}
 try{
  for(const name of EVIDENCE_KEYS){if(prepared.evidence[name]===undefined)delete process.env[name];else process.env[name]=prepared.evidence[name];}
  process.env.DAILY_SYNC_FEATURE_ENABLED='true';process.env.DAILY_SYNC_ALLOWED_ACCOUNTS='["CAFE24/didadi0729/shop1"]';
  const client=new DiagnosticClient(prisma,oauth,deny);if(client.fetchDaySnapshot!==Cafe24OrdersClient.prototype.fetchDaySnapshot)deny();
  // Client captures its own day start; the absolute deadline supplied here is the
  // stricter of the two and is propagated unchanged to every GET seam.
  const result=await client.fetchDaySnapshot(CAFE08_ID,day,deadline);
  const unique=new Set(result.orders.map(row=>JSON.stringify([row.orderNo,row.lineOrderNo])));
  if(result.orderCount>500||result.orders.length>50000||unique.size!==result.orders.length||result.orders.some(row=>row.orderDate.toISOString().slice(0,10)!==day)||report.countRequests!==2||report.listRequests<2||report.itemRequests!==2*result.orderCount||report.connectionStubReads!==1||report.oauthStubReads!==1)reject('FINAL_COMPLETENESS_SHAPE');
  report.status='COMPLETE_CURRENT_TWO_PASS_READ';report.completeTwoPass=true;report.orderCount=result.orderCount;report.lineCount=result.orders.length;report.uniqueLineCount=unique.size;report.pageCount=result.pageCount;report.fetchedAt=result.fetchedAt.toISOString();result.orders.length=0;
 }catch(error){stopped=true;report.status='STOPPED_ON_SAFE_FAILURE';report.safeCode=firstFixed??(isCafe24FailureDiagnosticCode(error?.diagnosticCode)?error.diagnosticCode:['RECONCILIATION_FAILED','PARTIAL_PAGE','FIELD_UNSUPPORTED','RUN_LIMIT_EXCEEDED','ACCOUNT_SCOPE_MISMATCH','CURRENCY_MISMATCH'].includes(error?.safeCode)?error.safeCode:'SAFE_CLIENT_REJECTED');}
 finally{
  if(stopped)for(const controller of activeControllers)controller.abort();
  let cleanupTimer;try{if(activeConsumes.size)await Promise.race([Promise.allSettled([...activeConsumes]),new Promise(resolve=>{cleanupTimer=setTimeout(resolve,1000);})]);}finally{clearTimeout(cleanupTimer);}
  report.pendingTransfersAtReturn=activeConsumes.size;report.responseBytesKnown=activeConsumes.size===0;
  // A deliberately abort-ignoring transport is never labelled a known total.
  // Late continuations are stopped before any counter or body processing.
  for(const [name,value]of previous){if(value===undefined)delete process.env[name];else process.env[name]=value;}report.completedAt=new Date().toISOString();report.elapsedMs=Date.now()-started;
 }
 return report;
}
