import 'reflect-metadata';
import {normalizeCafe24Order} from '../../../apps/api/src/daily-sync/cafe24-order-adapter.ts';
import {orderDay} from '../../../apps/api/src/daily-sync/cafe24-order-preflight.client.ts';
import {requiresCafe24RawAllItemsEvidence,assertCafe24RawAllItemsV1Evidence,isCafe24V1ItemStatusCode} from '../../../apps/api/src/daily-sync/sync-contract.ts';
import {isCafe24FailureDiagnosticCode} from '../../../apps/api/src/daily-sync/cafe24-failure-diagnostic.ts';
import {prepareCafeFieldSample} from './phase10-cafe-field-sample-20261020.mjs';
const DAY='2026-10-16',HOST='https://didadi0729.cafe24api.com';
const ORDER_FIELDS='order_id,shop_no,order_date,updated_date,payment_amount,order_price_amount,actual_order_amount,initial_order_amount,payment_method,order_status,currency';
const ITEM_FIELDS='order_item_code,product_no,product_name,option_value,quantity,product_price,order_status';
const fail=code=>{throw Object.assign(Error(),{fixed:code});},inc=(map,key)=>{map[key]=(map[key]??0)+1;};
const identifier=value=>{if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<0)||!['string','number'].includes(typeof value)||!/^[A-Za-z0-9_-]{1,128}$/.test(String(value)))fail('ORDER_SCOPE_OR_SHAPE');return String(value);};
export function prepareCafeStatusWindow(value,now=Date.now()){
 if(value?.operationKey!=='20261020-cafe08-status-window-a')fail('PREFLIGHT_SCOPE');const base=prepareCafeFieldSample(value.input,now);
 return{...base,safeSummary:{preparedOnly:true,day:DAY,currentFirstPageLimit:100,targetPositions:[21,40],maximumGets:22,maximumItemGets:20,itemPacingMs:500,requestTimeoutMs:20000,bodyLimitBytes:2097152,approvedStatusCodes:[...base.approved].sort(),explicitVersionHeaderSent:false,readOnlyCurrentSample:true,fullDayComplete:false,checkpointResumed:false,originalFailingOrderIdentified:false,originalFailureCauseConfirmed:false,approvalListChanged:false,databaseWrites:0,providerRequests:0,rawValuesReturned:0}};
}
export async function runCafeStatusWindow(prepared,{request=fetch,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 if(!prepared?.access||prepared.safeSummary?.maximumGets!==22||now()>prepared.deadlineAt-20000)fail('PREFLIGHT_SCOPE');
 const report={kind:'CAFE08_CURRENT_STATUS_WINDOW',day:DAY,targetPositions:[21,40],providerRequests:0,itemRequests:0,responseBytes:0,responseByteMetric:'ACCEPTED_BEFORE_CANCELLATION',versionVerifiedResponses:0,targetOrders:0,ordersExamined:0,itemRows:0,approvedStatusCodes:[...prepared.approved].sort(),statusCodeDomain:'N_C_R_E_U_TWO_DIGITS_SHAPE_ONLY',unapprovedCountUnit:'ORDER_AND_ITEM_STATUS_OCCURRENCES',orderStatusCodes:{},itemStatusCodes:{},unapprovedOrderCodes:{},unapprovedItemCodes:{},unapprovedCodes:{},unsupportedV1Codes:{},nonCodeStatusShapes:{},normalizationDiagnostics:{},gateDiagnostics:{},currentSampleOnly:true,fullDayComplete:false,originalFailingOrderIdentified:false,originalFailureCauseConfirmed:false,originalFailureReproduced:false,approvalListChanged:false,explicitVersionHeaderSent:false,canonicalPublished:false,checkpointResumed:false,automaticRetry:false,automaticRefresh:false,databaseWrites:0,rawValuesReturned:0,status:'IN_PROGRESS'};
 let next=now(),stage='COUNT';const compositionOrigins=new Map();
 const get=async(url)=>{
  if(url.origin!==HOST||url.username||url.password||!/^\/api\/v2\/admin\/orders(?:\/count|\/[A-Za-z0-9_-]{1,128}\/items)?$/.test(url.pathname)||report.providerRequests>=22||now()>=prepared.deadlineAt-20000)fail('REQUEST_SCOPE_OR_DEADLINE');
  const pause=Math.max(0,next-now());if(pause)await wait(pause);if(now()>=prepared.deadlineAt-20000)fail('REQUEST_SCOPE_OR_DEADLINE');next=now()+500;report.providerRequests++;
  const controller=new AbortController();let timer,reader,response;const chunks=[];let bytes=0,stopped=false;
  try{
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{stopped=true;controller.abort();reject(Object.assign(Error(),{fixed:'TRANSPORT_OR_TIMEOUT'}));},20000);});
   const consume=async()=>{
    try{response=await request(url,{method:'GET',redirect:'error',cache:'no-store',signal:controller.signal,headers:{Authorization:`Bearer ${prepared.access}`,Accept:'application/json'}});}catch{fail('TRANSPORT_OR_TIMEOUT');}
    if(stopped){await response.body?.cancel().catch(()=>{});fail('TRANSPORT_OR_TIMEOUT');}
    if(response.status!==200){await response.body?.cancel().catch(()=>{});fail([400,404,422].includes(response.status)?`CAFE24_RESPONSE_HTTP_${response.status}`:[401,403].includes(response.status)?'PROVIDER_AUTH_REQUIRED':response.status===429?'PROVIDER_RATE_LIMITED':'PROVIDER_UNAVAILABLE');}
    if(response.headers.get('x-cafe24-api-version')!=='2026-09-01'){await response.body?.cancel().catch(()=>{});fail('API_VERSION_UNVERIFIED');}report.versionVerifiedResponses++;
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>2097152)){await response.body?.cancel().catch(()=>{});fail('BODY_BOUND');}if(!response.body)fail('BODY_ABSENT');reader=response.body.getReader();
    while(true){const part=await reader.read();if(stopped){await reader.cancel().catch(()=>{});fail('TRANSPORT_OR_TIMEOUT');}if(part.done)break;if(bytes+part.value.byteLength>2097152||chunks.length>=512){await reader.cancel().catch(()=>{});fail('BODY_BOUND');}bytes+=part.value.byteLength;report.responseBytes+=part.value.byteLength;chunks.push(Buffer.from(part.value));}
    const raw=Buffer.concat(chunks);try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{fail('CAFE24_RESPONSE_INVALID_JSON');}finally{raw.fill(0);}
   };
   return await Promise.race([consume(),timeout]);
  }finally{stopped=true;clearTimeout(timer);controller.abort();if(reader){await reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}chunks.forEach(buffer=>buffer.fill(0));}
 };
 const status=(value,where)=>{
  if(value==null){inc(report.nonCodeStatusShapes,where+':'+(value===null?'NULL':'MISSING'));return;}
  if(typeof value!=='string'||!/^[NCREU][0-9]{2}$/.test(value)){inc(report.nonCodeStatusShapes,where+':UNREVIEWED_CODE_OR_TYPE');return;}
  inc(where==='ORDER'?report.orderStatusCodes:report.itemStatusCodes,value);
  if(!isCafe24V1ItemStatusCode(value))inc(report.unsupportedV1Codes,value);
  if(!prepared.approved.has(value)){inc(where==='ORDER'?report.unapprovedOrderCodes:report.unapprovedItemCodes,value);inc(report.unapprovedCodes,value);}
 };
 try{
  const countUrl=new URL('/api/v2/admin/orders/count',HOST);for(const [k,v]of Object.entries({shop_no:'1',start_date:DAY,end_date:DAY,date_type:'order_date'}))countUrl.searchParams.set(k,v);const count=await get(countUrl);if(!Number.isSafeInteger(count?.count)||count.count<0||count.count>8000)fail('COUNT_SHAPE');
  stage='FIRST_PAGE';const listUrl=new URL('/api/v2/admin/orders',HOST);for(const[k,v]of Object.entries({shop_no:'1',start_date:DAY,end_date:DAY,date_type:'order_date',limit:'100',offset:'0',fields:ORDER_FIELDS}))listUrl.searchParams.set(k,v);const listing=await get(listUrl);if(!Array.isArray(listing?.orders)||listing.orders.length>100||listing.orders.length>count.count||new Set(listing.orders.map(row=>identifier(row?.order_id))).size!==listing.orders.length||listing.orders.some(row=>String(row.shop_no)!=='1'||row.currency!=='KRW'||orderDay(row.order_date)!==DAY))fail('ORDER_SCOPE_OR_SHAPE');
  const targets=listing.orders.slice(20,40);report.targetOrders=targets.length;
  for(const order of targets){
   const orderId=identifier(order.order_id);stage='ITEMS';const url=new URL(`/api/v2/admin/orders/${orderId}/items`,HOST);url.searchParams.set('shop_no','1');url.searchParams.set('fields',ITEM_FIELDS);report.itemRequests++;const body=await get(url);
   if(!Array.isArray(body?.items)||body.items.length<1||body.items.length>=100)fail('PARTIAL_PAGE');report.ordersExamined++;report.itemRows+=body.items.length;status(order.order_status,'ORDER');for(const line of body.items)status(line?.order_status,'ITEM');
   try{
    const lines=normalizeCafe24Order(order,body.items,{verifiedSellerDropdown:true,csvOptionEvidence:{mallId:'didadi0729',shopKey:'shop1'},compositionOrigins,paymentMethodCsvLabels:prepared.labels});inc(report.normalizationDiagnostics,'PASS');
    if(lines.some(line=>[line.orderStatus,line.lineStatus].some(requiresCafe24RawAllItemsEvidence)))try{assertCafe24RawAllItemsV1Evidence(DAY,prepared.evidence,new Date(now()));inc(report.gateDiagnostics,'RAW_ALL_ITEMS_EVIDENCE_PASS');}catch{inc(report.gateDiagnostics,'CAFE24_EVIDENCE_RAW_ALL_ITEMS');}
    if(lines.some(line=>line.providerUpdatedAt&&line.providerUpdatedAt>new Date(prepared.startedAt)))inc(report.gateDiagnostics,'CAFE24_PROVIDER_TIME_FUTURE');
    if(lines.some(line=>line.orderStatus!=null&&!prepared.approved.has(line.orderStatus)||!prepared.approved.has(line.lineStatus??'')))inc(report.gateDiagnostics,'CAFE24_STATUS_APPROVAL_MISMATCH');
   }catch(error){inc(report.normalizationDiagnostics,isCafe24FailureDiagnosticCode(error?.diagnosticCode)?error.diagnosticCode:'NORMALIZATION_SAFE_REJECTED');}
  }
  report.status='CURRENT_WINDOW_OBSERVED_WITHOUT_APPROVAL_CHANGE';
 }catch(error){report.status='STOPPED_ON_SAFE_FAILURE';report.stage=stage;report.safeCode=isCafe24FailureDiagnosticCode(error?.fixed)||['REQUEST_SCOPE_OR_DEADLINE','TRANSPORT_OR_TIMEOUT','API_VERSION_UNVERIFIED','BODY_BOUND','BODY_ABSENT','PROVIDER_AUTH_REQUIRED','PROVIDER_RATE_LIMITED','PROVIDER_UNAVAILABLE','COUNT_SHAPE','ORDER_SCOPE_OR_SHAPE','PARTIAL_PAGE'].includes(error?.fixed)?error.fixed:'SAFE_DIAGNOSTIC_REJECTED';}
 report.completedAt=new Date(now()).toISOString();return report;
}
