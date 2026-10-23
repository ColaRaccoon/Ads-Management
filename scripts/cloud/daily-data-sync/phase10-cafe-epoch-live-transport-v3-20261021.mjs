// Evaluation-only union of TWO ALREADY USED Orders projections. Product files
// and its incoming URL remain unchanged; only the cloned wire URL is widened.
import {createHash} from 'node:crypto';
import {ProviderFailure} from '../../../apps/api/src/daily-sync/bounded-request.ts';
import {normalizeCafe24Order} from '../../../apps/api/src/daily-sync/cafe24-order-adapter.ts';
import {cafe24PaymentMethodCsvMap,assertCafe24RawAllItemsV1Evidence,requiresCafe24RawAllItemsEvidence} from '../../../apps/api/src/daily-sync/sync-contract.ts';
export const DAYS=['2026-10-16','2026-10-17'];
export const APPROVED=['C40','C47','C48','E00','N00','N20','N30','N40','R00','R30','R40'];
export const RAW_FIELDS='order_id,shop_no,order_date,payment_amount,currency,place_date,order_price_amount,payment_method,order_status';
export const WIRE_FIELDS=RAW_FIELDS+',updated_date,actual_order_amount,initial_order_amount';
export const ITEM_FIELDS='order_item_code,product_no,product_name,option_value,quantity,product_price,order_status';
const HOST='https://didadi0729.cafe24api.com',MAX_BODY=2097152,MAX_TOTAL=67108864,MAX_CALLS=2050;
const safeCodes=new Set(['REQUEST_SCOPE','TOTAL_BOUND','TRANSPORT_TIMEOUT','HTTP_REJECTED','API_VERSION','BODY_BOUND','INVALID_JSON','COUNT_CAP','RESPONSE_SHAPE','UNAPPROVED_STATUS','CANONICAL_PASS_MISMATCH','INCOMPLETE_CAPTURE','STOPPED','PENDING_TRANSFER']);
export function failure(code){throw Object.assign(new ProviderFailure('FIELD_UNSUPPORTED',false),{fixed:safeCodes.has(code)?code:'RESPONSE_SHAPE'});}
const digest=value=>createHash('sha256').update(value).digest('hex');
const view=rows=>JSON.stringify([...rows].sort((a,b)=>a.lineOrderNo.localeCompare(b.lineOrderNo)));
const project=(object,fields)=>{if(!object||typeof object!=='object'||Array.isArray(object))failure('RESPONSE_SHAPE');const result={};for(const name of fields.split(','))if(Object.hasOwn(object,name))result[name]=object[name];return result;};
function status(value,required,approved,report){
 if(value==null&&!required)return;
 if(typeof value!=='string'||!/^[NCREU][0-9]{2}$/.test(value))failure('RESPONSE_SHAPE');
 report.statusCodes[value]=(report.statusCodes[value]??0)+1;
 if(!approved.has(value)){report.unapprovedCodes[value]=(report.unapprovedCodes[value]??0)+1;failure('UNAPPROVED_STATUS');}
}
/** No raw object is returned from this capability. `finish` returns normalized
 * writer input only, after both ORIGINAL normalizations have matched exactly. */
export function createLiveTransport({day,access,usage,request,normalize=normalizeCafe24Order,now=Date.now}){
 if(!DAYS.includes(day)||typeof access!=='string'||access.length<20||typeof request!=='function'||!usage||!Number.isSafeInteger(usage.requests)||!Number.isSafeInteger(usage.bytes)||usage.requests<0||usage.bytes<0)failure('REQUEST_SCOPE');
 const started=now(),deadline=started+600000,approved=new Set(APPROVED),orders=[new Map(),new Map()],lines=[new Map(),new Map()],origins=[new Map(),new Map()],controllers=new Set(),consumes=new Set();
 let stopped=false,frozen=false,firstCode=null,finished=false;
 const report={day,providerRequests:0,countRequests:0,listRequests:0,itemRequests:0,responseBytes:0,versionVerifiedResponses:0,completeTwoPass:false,canonicalTwoPassExact:false,statusCodes:{},unapprovedCodes:{},rawFields:RAW_FIELDS,wireFields:WIRE_FIELDS,wireFieldsUnionOverride:true,explicitVersionHeaderSent:false,automaticRetry:false,automaticRefresh:false,rawStored:false};
 const reject=code=>{stopped=true;firstCode??=safeCodes.has(code)?code:'RESPONSE_SHAPE';for(const controller of controllers)controller.abort();failure(firstCode);};
 const canonical=(order,items,pass)=>{
  const result=normalize(order,items,{verifiedSellerDropdown:true,csvOptionEvidence:{mallId:'didadi0729',shopKey:'shop1'},compositionOrigins:origins[pass],paymentMethodCsvLabels:cafe24PaymentMethodCsvMap()});
  for(const line of result){if(line.orderDate.toISOString().slice(0,10)!==day||line.providerUpdatedAt!==null&&+line.providerUpdatedAt>started)reject('RESPONSE_SHAPE');for(const code of [line.orderStatus,line.lineStatus]){if(code!=null&&!approved.has(code))reject('UNAPPROVED_STATUS');if(requiresCafe24RawAllItemsEvidence(code))assertCafe24RawAllItemsV1Evidence(day);}}
  return result;
 };
 const getJson=async(url,token,clientDeadline)=>{
  if(!(url instanceof URL))reject('REQUEST_SCOPE');const isCount=url.pathname==='/api/v2/admin/orders/count',isList=url.pathname==='/api/v2/admin/orders',match=/^\/api\/v2\/admin\/orders\/([A-Za-z0-9_-]{1,128})\/items$/.exec(url.pathname),isItem=!!match;
  const expected=(isItem?['fields','shop_no']:isCount?['date_type','end_date','shop_no','start_date']:['date_type','end_date','fields','limit','offset','shop_no','start_date']).sort();
  if(stopped||finished||now()>=deadline||token!==access||url.origin!==HOST||url.username||url.password||url.hash||!isCount&&!isList&&!isItem||!Number.isFinite(clientDeadline)||clientDeadline>deadline+10000||JSON.stringify([...url.searchParams.keys()].sort())!==JSON.stringify(expected)||url.searchParams.get('shop_no')!=='1'||!isItem&&(url.searchParams.get('start_date')!==day||url.searchParams.get('end_date')!==day||url.searchParams.get('date_type')!=='order_date')||isList&&(url.searchParams.get('fields')!==RAW_FIELDS||url.searchParams.get('limit')!=='100'||!/^(?:0|100|200|300|400|500)$/.test(url.searchParams.get('offset')??''))||isItem&&url.searchParams.get('fields')!==ITEM_FIELDS)reject('REQUEST_SCOPE');
  if(usage.requests>=MAX_CALLS||usage.bytes>=MAX_TOTAL)reject('TOTAL_BOUND');
  usage.requests++;report.providerRequests++;if(isCount)report.countRequests++;else if(isList)report.listRequests++;else report.itemRequests++;
  const pass=report.countRequests-1;if(pass<0||pass>1||isItem&&!orders[pass].has(match[1]))reject('RESPONSE_SHAPE');
  const wire=new URL(url);if(isList)wire.searchParams.set('fields',WIRE_FIELDS);
  const controller=new AbortController();controllers.add(controller);let reader,timer;const buffers=[];
  const consume=async()=>{
   const response=await request(wire,{method:'GET',redirect:'error',cache:'no-store',signal:controller.signal,headers:{Authorization:`Bearer ${access}`,Accept:'application/json'}});
   if(stopped){await response.body?.cancel().catch(()=>{});failure(firstCode??'STOPPED');}
   if(response.status!==200){await response.body?.cancel().catch(()=>{});reject('HTTP_REJECTED');}
   if(response.headers.get('x-cafe24-api-version')!=='2026-09-01'){await response.body?.cancel().catch(()=>{});reject('API_VERSION');}report.versionVerifiedResponses++;
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY||Number(length)>MAX_TOTAL-usage.bytes)){await response.body?.cancel().catch(()=>{});reject('BODY_BOUND');}
   if(!response.body)reject('RESPONSE_SHAPE');reader=response.body.getReader();let bytes=0;
   while(true){const part=await reader.read();if(stopped||frozen){await reader.cancel().catch(()=>{});failure(firstCode??'STOPPED');}if(part.done)break;if(bytes+part.value.byteLength>MAX_BODY||buffers.length>=512||usage.bytes+part.value.byteLength>MAX_TOTAL){await reader.cancel().catch(()=>{});reject('BODY_BOUND');}bytes+=part.value.byteLength;usage.bytes+=part.value.byteLength;report.responseBytes+=part.value.byteLength;buffers.push(Buffer.from(part.value));}
   const raw=Buffer.concat(buffers);let body;try{body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{reject('INVALID_JSON');}finally{raw.fill(0);}
   if(isCount){if(!Number.isSafeInteger(body?.count)||body.count<0||body.count>500)reject('COUNT_CAP');return{body:{count:body.count},bytes};}
   if(isList){if(!Array.isArray(body?.orders)||body.orders.length>100)reject('RESPONSE_SHAPE');const rows=body.orders.map(value=>{const row=project(value,WIRE_FIELDS);if(typeof row.order_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(row.order_id)||orders[pass].has(row.order_id)||orders[pass].size>=500)reject('RESPONSE_SHAPE');status(row.order_status,false,approved,report);for(const amount of ['actual_order_amount','initial_order_amount'])if(row[amount]!=null)row[amount]=project(row[amount],'order_price_amount,payment_amount,shipping_fee');orders[pass].set(row.order_id,row);return row;});return{body:{orders:rows},bytes};}
   if(!Array.isArray(body?.items)||body.items.length<1||body.items.length>=100||lines[pass].has(match[1]))reject('RESPONSE_SHAPE');
   const items=body.items.map(value=>{const row=project(value,ITEM_FIELDS);status(row.order_status,true,approved,report);return row;});
   const normalized=canonical(orders[pass].get(match[1]),items,pass);lines[pass].set(match[1],normalized);
   if(pass===1&&(!lines[0].has(match[1])||view(lines[0].get(match[1]))!==view(normalized)))reject('CANONICAL_PASS_MISMATCH');
   return{body:{items},bytes};
  };
  try{
   const pending=consume();consumes.add(pending);pending.then(()=>consumes.delete(pending),()=>consumes.delete(pending));
   const timeout=new Promise((_,no)=>{timer=setTimeout(()=>{controller.abort();no(Error('TIMEOUT'));},Math.min(20000,deadline-now()));});
   return await Promise.race([pending,timeout]);
  }catch(error){if(error instanceof ProviderFailure){stopped=true;firstCode??=error.fixed??'RESPONSE_SHAPE';for(const active of controllers)active.abort();throw error;}reject('TRANSPORT_TIMEOUT');}
  finally{clearTimeout(timer);controller.abort();controllers.delete(controller);if(reader){await reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}for(const buffer of buffers)buffer.fill(0);}
 };
 const finish=()=>{
  if(stopped||finished||consumes.size||report.countRequests!==2||orders[0].size!==orders[1].size||lines[0].size!==orders[0].size||lines[1].size!==orders[0].size||report.itemRequests!==2*orders[0].size||[...orders[0].keys()].some(id=>!orders[1].has(id)||view(lines[0].get(id))!==view(lines[1].get(id))))reject('INCOMPLETE_CAPTURE');
  const normalized=[...lines[0].values()].flat();if(normalized.length>10000||new Set(normalized.map(row=>JSON.stringify([row.orderNo,row.lineOrderNo]))).size!==normalized.length)reject('RESPONSE_SHAPE');
  report.completeTwoPass=true;report.canonicalTwoPassExact=true;report.orderCount=orders[0].size;report.lineCount=normalized.length;report.pageCount=report.listRequests;report.normalizedSha256=digest(JSON.stringify(normalized));finished=true;for(const map of [...orders,...lines,...origins])map.clear();return{orders:normalized,report:{...report},fetchedAt:new Date(),pageCount:report.listRequests};
 };
 const close=async()=>{stopped=true;for(const c of controllers)c.abort();await Promise.race([Promise.allSettled([...consumes]),new Promise(resolve=>setTimeout(resolve,1000))]);const pending=consumes.size;frozen=true;for(const map of [...orders,...lines,...origins])map.clear();return{...report,safeCode:firstCode,pendingTransfers:pending,responseBytesKnown:pending===0,responseBytes:pending===0?report.responseBytes:null};};
 return{getJson,finish,close,publicReport:()=>({...report})};
}
