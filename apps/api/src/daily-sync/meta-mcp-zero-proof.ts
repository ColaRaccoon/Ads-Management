import { stableMetadataJson } from "../domain/meta-current-metadata";
import { metaMcpFingerprint, selectMetaMcpDay } from "./meta-mcp-capture";
import { META_MCP_DAY_FIELDS, MetaMcpEnvelopeReader, MetaMcpWireFailure, validateMetaMcpCatalog, validateMetaMcpToolOutput } from "./meta-mcp-wire-reader";
type Json=Record<string,unknown>;
const object=(v:unknown):v is Json=>!!v&&typeof v==="object"&&!Array.isArray(v);
function fail():never{throw new MetaMcpWireFailure("OUTPUT_INVALID");}
const same=(a:unknown,b:unknown)=>stableMetadataJson(a)===stableMetadataJson(b);
function count(v:unknown):bigint{if(typeof v!=="string"||!/^(0|[1-9]\d{0,18})$(?![\s\S])/.test(v))fail();return BigInt(v);}
export function metaMcpZeroPlan(capture:unknown){
 const selected=selectMetaMcpDay(capture),wire=selected.wire;
 if(!same(wire.moneyUnits,["USD"]))fail();
 const targetIds=wire.levels.ad.filter(r=>r.link_click===null).map(r=>r.id as string).sort();
 const control=wire.levels.ad.filter(r=>r.link_click!==null&&count(r.link_click)>0n).sort((a,b)=>(a.id as string).localeCompare(b.id as string))[0];
 if(!targetIds.length||targetIds.length>=1000||!control)fail();
 const sum=(rows:Json[])=>rows.reduce((n,r)=>n+(r.link_click===null?0n:count(r.link_click)),0n);
 if(selected.selectedAdsets.some(r=>r.link_click===null)||wire.levels.campaign.some(r=>r.link_click===null))fail();
 const knownTotals={ad:sum(wire.levels.ad).toString(),adset:sum(selected.selectedAdsets).toString(),campaign:sum(wire.levels.campaign).toString(),account:count(wire.levels.ad_account[0].link_click).toString()};
 if(new Set(Object.values(knownTotals)).size!==1)fail();
 const controlId=control.id as string;
 const query={...wire.queries.ad,filtering:[{field:"ad.id",operator:"IN",value:[...targetIds,controlId]},{field:"ad.link_click",operator:"EQUAL",value:["0"]}]};
 return{...selected,targetIds,controlId,query,knownTotals};
}
export type MetaMcpZeroProof={version:1;status:"ZERO_FILTER_VERIFIED";server:"https://mcp.facebook.com/ads";tool:"ads_get_ad_entities";protocolVersion:"2025-06-18";
 accountId:string;day:string;rawCaptureFingerprint:string;query:Json;targetIds:string[];controlId:string;rows:Json[];knownTotals:Record<string,string>;observedAtUtc:string;
 requestCount:1;paginationComplete:true;rawNullsPreserved:true;controlExcluded:true;productionReady:false;proofFingerprint:string};
export type MetaMcpZeroDiagnostic={validationStage:"RESULT_SHAPE"|"CONTEXT"|"TOOL_OUTPUT"|"TERMINAL"|"ID_SET"|"ROW_COMPARE";
 rowCount:number;targetCount:number;targetMatchCount:number;controlPresent:boolean;paginationPresent:boolean;additionalInfoPresent:boolean;contextPresent:boolean;changedField:string;rowIndex:number};
export class MetaMcpZeroProofFailure extends MetaMcpWireFailure{constructor(code:ConstructorParameters<typeof MetaMcpWireFailure>[0],requestCount:number,readonly proofDiagnostic:MetaMcpZeroDiagnostic){super(code,requestCount);}}
export type MetaMcpUnverifiedFilterCapture={version:1;status:"UNVERIFIED_FILTER_CAPTURE";proofAccepted:false;metricsNormalized:false;productionReady:false;
 observationVariant:"LEVEL_QUALIFIED_METRIC"|"BARE_CANONICAL_METRIC"|"OBJECT_IDS_CANONICAL";
 server:"https://mcp.facebook.com/ads";tool:"ads_get_ad_entities";protocolVersion:"2025-06-18";accountId:string;day:string;rawCaptureFingerprint:string;
 query:Json;rows:Json[];observedAtUtc:string;requestCount:1;paginationComplete:true;captureFingerprint:string};
function unverifiedRows(plan:ReturnType<typeof metaMcpZeroPlan>,result:unknown,strictAdditionalInfo=false){
 if(strictAdditionalInfo){
  if(!object(result))fail();
  const check=(v:unknown)=>{if(!object(v)||Object.hasOwn(v,"additional_info"))fail();};
  if("structuredContent" in result)check(result.structuredContent);
  if(Array.isArray(result.content))for(const block of result.content){if(object(block)&&block.type==="text"&&typeof block.text==="string"&&block.text.trim()){let v:unknown;try{v=JSON.parse(block.text);}catch{fail();}check(v);}}
 }
 const page=validateMetaMcpToolOutput(result,"ad",plan.wire.accountId,plan.wire.day,plan.wire.clientConversationId);
 if(page.nextCursor!==null||(page.totalCount!==null&&page.totalCount!==page.rows.length))fail();
 const permitted=new Set([...plan.targetIds,plan.controlId]),seen=new Set<string>();
 for(const row of page.rows){const id=row.id as string;if(!permitted.has(id)||seen.has(id))fail();seen.add(id);}
 return page.rows;
}
function verifiedRows(plan:ReturnType<typeof metaMcpZeroPlan>,result:unknown){
 const diagnostic:MetaMcpZeroDiagnostic={validationStage:"RESULT_SHAPE",rowCount:0,targetCount:plan.targetIds.length,targetMatchCount:0,controlPresent:false,paginationPresent:false,additionalInfoPresent:false,contextPresent:false,changedField:"NONE",rowIndex:-1};
 try{
 if(!object(result))fail();
 const check=(out:unknown)=>{
  if(!object(out))fail();
  diagnostic.paginationPresent ||= Object.hasOwn(out,"pagination");diagnostic.additionalInfoPresent ||= Object.hasOwn(out,"additional_info");diagnostic.contextPresent ||=Object.hasOwn(out,"_additional_context");
  let raw:unknown;try{raw=typeof out.ad_entities==="string"?JSON.parse(out.ad_entities):undefined;}catch{}
  if(Array.isArray(raw)&&raw.length<=1000){diagnostic.rowCount=raw.length;diagnostic.targetMatchCount=new Set(raw.filter(r=>object(r)&&plan.targetIds.includes(r.id as string)).map(r=>(r as Json).id)).size;diagnostic.controlPresent=raw.some(r=>object(r)&&r.id===plan.controlId);}
  diagnostic.validationStage="CONTEXT";if(Object.hasOwn(out,"_additional_context")||("additional_info" in out&&out.additional_info!==""))fail();
 };
 if("structuredContent" in result)check(result.structuredContent);
 if(Array.isArray(result.content))for(const block of result.content){if(object(block)&&block.type==="text"&&typeof block.text==="string"&&block.text.trim()){let text:unknown;try{text=JSON.parse(block.text);}catch{fail();}check(text);}}
 diagnostic.validationStage="TOOL_OUTPUT";const page=validateMetaMcpToolOutput(result,"ad",plan.wire.accountId,plan.wire.day,plan.wire.clientConversationId);
 diagnostic.validationStage="TERMINAL";
 if(page.nextCursor!==null||(page.totalCount!==null&&page.totalCount!==plan.targetIds.length))fail();
 diagnostic.validationStage="ID_SET";const ids=page.rows.map(r=>r.id as string).sort();if(!same(ids,plan.targetIds))fail();
 const originals=new Map(plan.wire.levels.ad.map(r=>[r.id,r]));
 diagnostic.validationStage="ROW_COMPARE";
 for(const [index,row] of page.rows.entries()){const original=originals.get(row.id);
  if(!original||original.link_click!==null||(row.link_click!==null&&row.link_click!=="0")||!same({...row,link_click:null},original)){
   diagnostic.rowIndex=index;diagnostic.changedField=original?([...META_MCP_DAY_FIELDS.ad,"date_start","date_stop"].find(f=>f==="link_click"?(row.link_click!==null&&row.link_click!=="0"):!same(row[f],original[f]))??"OTHER"):"id";fail();
  }
 }
 return page.rows;
 }catch(error){throw new MetaMcpZeroProofFailure(error instanceof MetaMcpWireFailure?error.safeCode:"OUTPUT_INVALID",0,diagnostic);}
}
export function validateMetaMcpZeroProof(capture:unknown,value:unknown):MetaMcpZeroProof{
 const plan=metaMcpZeroPlan(capture);
 if(!object(value)||value.version!==1||value.status!=="ZERO_FILTER_VERIFIED"||value.server!=="https://mcp.facebook.com/ads"||value.tool!=="ads_get_ad_entities"||value.protocolVersion!=="2025-06-18"||
 value.accountId!==plan.wire.accountId||value.day!==plan.wire.day||value.rawCaptureFingerprint!==plan.selection.rawCaptureFingerprint||!same(value.query,plan.query)||!same(value.targetIds,plan.targetIds)||value.controlId!==plan.controlId||!same(value.knownTotals,plan.knownTotals)||
 value.requestCount!==1||value.paginationComplete!==true||value.rawNullsPreserved!==true||value.controlExcluded!==true||value.productionReady!==false||typeof value.observedAtUtc!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$(?![\s\S])/.test(value.observedAtUtc)||!Number.isFinite(Date.parse(value.observedAtUtc))||new Date(value.observedAtUtc).toISOString()!==value.observedAtUtc||Date.parse(value.observedAtUtc)<Date.parse(plan.wire.observedAtUtc)||Date.parse(value.observedAtUtc)>Date.now()+300000||!Array.isArray(value.rows))fail();
 verifiedRows(plan,{structuredContent:{ad_entities:JSON.stringify(value.rows)}});
 const {proofFingerprint,...body}=value;if(proofFingerprint!==metaMcpFingerprint(body))fail();return value as MetaMcpZeroProof;
}
export class MetaMcpZeroProofReader{
 constructor(private readonly request:typeof fetch,private readonly readEnvelope:MetaMcpEnvelopeReader){}
 async verify(provided:{capture:unknown;catalog:unknown;reporting:unknown;accessToken:string}):Promise<MetaMcpZeroProof>{return await this.execute(provided,false) as MetaMcpZeroProof;}
 /** Diagnostic capture cannot satisfy the proof validator or canonical normalizer. */
 async captureUnverified(provided:{capture:unknown;catalog:unknown;reporting:unknown;accessToken:string}):Promise<MetaMcpUnverifiedFilterCapture>{return await this.execute(provided,true) as MetaMcpUnverifiedFilterCapture;}
 async captureBareCanonicalMetric(provided:{capture:unknown;catalog:unknown;reporting:unknown;accessToken:string}):Promise<MetaMcpUnverifiedFilterCapture>{return await this.execute(provided,true,true) as MetaMcpUnverifiedFilterCapture;}
 async captureObjectIdsCanonical(provided:{capture:unknown;catalog:unknown;reporting:unknown;accessToken:string}):Promise<MetaMcpUnverifiedFilterCapture>{return await this.execute(provided,true,false,true) as MetaMcpUnverifiedFilterCapture;}
 private async execute(provided:{capture:unknown;catalog:unknown;reporting:unknown;accessToken:string},captureOnly:boolean,bareCanonicalMetric=false,objectIdsCanonical=false):Promise<MetaMcpZeroProof|MetaMcpUnverifiedFilterCapture>{
  const input=Object.freeze({...provided});let requestCount=0;
  try{
   const serializedCapture=JSON.stringify(input.capture);if(Buffer.byteLength(serializedCapture)>16*1024*1024)fail();
   const plan=metaMcpZeroPlan(JSON.parse(serializedCapture));
   if((bareCanonicalMetric||objectIdsCanonical)&&!captureOnly||bareCanonicalMetric&&objectIdsCanonical)fail();
   const {filtering:_filter,...baseQuery}=plan.query;
   const query=objectIdsCanonical?{...baseQuery,object_ids:[...plan.targetIds,plan.controlId]}:bareCanonicalMetric?{...plan.query,filtering:[(plan.query.filtering as Json[])[0],{field:"link_click",operator:"EQUAL",value:["0"]}]}:plan.query;
   if(typeof input.accessToken!=="string"||!/^[\x21-\x7e]{40,4096}$(?![\s\S])/.test(input.accessToken))fail();
   validateMetaMcpCatalog(input.catalog,input.reporting,plan.wire.clientConversationId);
   if(!object(input.catalog)||!Array.isArray(input.catalog.fields)||!object(input.reporting)||!object(input.reporting.reportingTool)||!object(input.reporting.reportingTool.inputSchema)||!object(input.reporting.reportingTool.inputSchema.properties))fail();
   for(const [name,operator] of [["id","IN"],["link_click","EQUAL"]]){const field=input.catalog.fields.find(f=>object(f)&&f.name===name);if(!object(field)||field.filterable!==true||!Array.isArray(field.levels)||!field.levels.includes("ad")||!Array.isArray(field.supported_filter_operators)||!field.supported_filter_operators.includes(operator))fail();}
   const filtering=input.reporting.reportingTool.inputSchema.properties.filtering;
   if(objectIdsCanonical){const ids=input.reporting.reportingTool.inputSchema.properties.object_ids;if(!object(ids)||ids.type!=="array"||!object(ids.items)||ids.items.type!=="string")fail();}
   if(!object(filtering)||filtering.type!=="array"||!object(filtering.items)||filtering.items.type!=="object"||!object(filtering.items.properties))fail();
   const p=filtering.items.properties;if(!object(p.field)||p.field.type!=="string"||!object(p.operator)||p.operator.type!=="string"||!object(p.value)||p.value.type!=="array"||!object(p.value.items)||p.value.items.type!=="string")fail();
   const controller=new AbortController();let rejectTimeout:((e:Error)=>void)|undefined;
   const timeout=new Promise<never>((_,reject)=>{rejectTimeout=reject;});const timer=setTimeout(()=>{controller.abort();rejectTimeout?.(new MetaMcpWireFailure("HTTP_UNAVAILABLE"));},20000);
   let envelope:unknown;
   try{requestCount=1;envelope=await Promise.race([(async()=>{const response=await this.request("https://mcp.facebook.com/ads",{method:"POST",redirect:"error",signal:controller.signal,headers:{Authorization:`Bearer ${input.accessToken}`,"Content-Type":"application/json",Accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-06-18"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"ads_get_ad_entities",arguments:query}})});if(response.redirected||response.status!==200||!response.body)throw new MetaMcpWireFailure("HTTP_UNAVAILABLE");return this.readEnvelope(response,2*1024*1024);})(),timeout]);}finally{clearTimeout(timer);controller.abort();}
   if(!object(envelope)||envelope.jsonrpc!=="2.0"||envelope.id!==1||"error" in envelope||"method" in envelope)fail();
   if(captureOnly){
    const rows=unverifiedRows(plan,envelope.result,objectIdsCanonical);
    const body:Omit<MetaMcpUnverifiedFilterCapture,"captureFingerprint">={version:1,status:"UNVERIFIED_FILTER_CAPTURE",proofAccepted:false,metricsNormalized:false,productionReady:false,observationVariant:objectIdsCanonical?"OBJECT_IDS_CANONICAL":bareCanonicalMetric?"BARE_CANONICAL_METRIC":"LEVEL_QUALIFIED_METRIC",server:"https://mcp.facebook.com/ads",tool:"ads_get_ad_entities",protocolVersion:"2025-06-18",accountId:plan.wire.accountId,day:plan.wire.day,rawCaptureFingerprint:plan.selection.rawCaptureFingerprint,query,rows,observedAtUtc:new Date().toISOString(),requestCount:1,paginationComplete:true};
    const capture={...body,captureFingerprint:metaMcpFingerprint(body)};if(JSON.stringify(capture).includes(input.accessToken))throw new MetaMcpWireFailure("TOKEN_REFLECTION");return capture;
   }
   const rows=verifiedRows(plan,envelope.result);
   const body:Omit<MetaMcpZeroProof,"proofFingerprint">={version:1,status:"ZERO_FILTER_VERIFIED",server:"https://mcp.facebook.com/ads",tool:"ads_get_ad_entities",protocolVersion:"2025-06-18",accountId:plan.wire.accountId,day:plan.wire.day,rawCaptureFingerprint:plan.selection.rawCaptureFingerprint,query:plan.query,targetIds:plan.targetIds,controlId:plan.controlId,rows,knownTotals:plan.knownTotals,observedAtUtc:new Date().toISOString(),requestCount:1,paginationComplete:true,rawNullsPreserved:true,controlExcluded:true,productionReady:false};
   const proof={...body,proofFingerprint:metaMcpFingerprint(body)};if(JSON.stringify(proof).includes(input.accessToken))throw new MetaMcpWireFailure("TOKEN_REFLECTION");return validateMetaMcpZeroProof(plan.wire,proof);
  }catch(error){if(error instanceof MetaMcpZeroProofFailure)throw new MetaMcpZeroProofFailure(error.safeCode,requestCount,error.proofDiagnostic);throw new MetaMcpWireFailure(error instanceof MetaMcpWireFailure?error.safeCode:"OUTPUT_INVALID",requestCount);}
 }
}
