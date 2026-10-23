import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import {HttpException} from "@nestjs/common";
import {cafe24Chunk,type Cafe24ChunkState} from "../../../apps/api/src/daily-sync/cafe24-scheduled-chunk";
import {Cafe24OrdersClient} from "../../../apps/api/src/daily-sync/cafe24-orders.client";
import {withCafe24Diagnostic} from "../../../apps/api/src/daily-sync/cafe24-failure-diagnostic";
import {ProviderFailure} from "../../../apps/api/src/daily-sync/bounded-request";

const now=Date.parse("2026-10-20T00:00:00Z");
const order=()=>({order_id:"PRIVATE_SYNTHETIC_ORDER",shop_no:1,order_date:"2026-10-19T10:00:00+09:00",payment_amount:"100",currency:"KRW",payment_method:["card"]});
const item=()=>({order_item_code:"PRIVATE_SYNTHETIC_LINE",product_no:"1",product_name:"Synthetic",option_value:"S",quantity:1,product_price:"100",order_status:"N00"});
const state=():Cafe24ChunkState=>({version:1,connectionId:"synthetic",day:"2026-10-19",startedAt:new Date(now).toISOString(),stage:"ITEMS_FIRST",count:1,pages:1,first:[order()],second:[],items:[],cursor:0,verifiedItems:0});
const input=(saved:Cafe24ChunkState|null,line:unknown=item(),row:unknown=order())=>({connectionId:"synthetic",mallId:"didadi0729",shopKey:"shop1",day:"2026-10-19",deadlineAt:now+55000,now:()=>now,state:saved,count:async()=>1,listing:async()=>[row],items:async()=>[line],wait:async()=>{}});
function setup(){
 process.env.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES='["N00","N20","C40"]';
 delete process.env.DAILY_SYNC_CAFE24_PAYMENT_METHOD_CSV_MAP;delete process.env.DAILY_SYNC_CAFE24_PAYMENT_METHOD_MAP_VERIFIED_AT;
 delete process.env.DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED;delete process.env.DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT;
}
const reason=(expected:string)=>(error:unknown)=>{
 assert(error instanceof ProviderFailure||error instanceof HttpException);
 const code=error instanceof ProviderFailure?error.safeCode:(error.getResponse() as any).code;
 assert.equal(code,"FIELD_UNSUPPORTED");assert.equal((error as any).diagnosticCode,expected);
 assert.equal(JSON.stringify(error).includes("PRIVATE_SYNTHETIC"),false);return true;
};
for(const [name,change,code] of [
 ["status configuration",()=>{process.env.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES='{bad';},"CAFE24_EVIDENCE_STATUS_SET"],
 ["payment mapping configuration",()=>{process.env.DAILY_SYNC_CAFE24_PAYMENT_METHOD_CSV_MAP='{}';},"CAFE24_EVIDENCE_PAYMENT_MAP"]
] as const)test(`scheduled ${name} retains its exact fixed diagnostic`,async()=>{setup();change();const saved=state(),before=JSON.stringify(saved);await assert.rejects(cafe24Chunk(input(saved)),reason(code));assert.equal(JSON.stringify(saved),before);});
test("scheduled C40 still requires raw-all evidence and does not silently accept an approved status",async()=>{setup();const saved=state();await assert.rejects(cafe24Chunk(input(saved,{...item(),order_status:"C40"})),reason("CAFE24_EVIDENCE_RAW_ALL_ITEMS"));assert.equal(saved.cursor,0);});
for(const [name,row,code] of [
 ["shape",null,"CAFE24_FIELD_ORDER_SHAPE"],
 ["identifier",{...order(),order_id:"bad/private"},"CAFE24_FIELD_ORDER_ID"],
 ["date",{...order(),order_date:null},"CAFE24_FIELD_ORDER_DATE"]
] as const)test(`listing ${name} failure has no raw values`,async()=>{setup();await assert.rejects(cafe24Chunk(input(null,item(),row)),reason(code));});
test("item shape is classified before any checkpoint update",async()=>{setup();const saved=state();await assert.rejects(cafe24Chunk(input(saved,null)),reason("CAFE24_FIELD_ITEM_SHAPE"));assert.equal(saved.cursor,0);});
test("existing more precise adapter diagnostic is preserved",async()=>{setup();await assert.rejects(cafe24Chunk(input(state(),{...item(),option_value:null})),reason("CAFE24_FIELD_OPTION_VALUE"));});
test("known N00 and exact provider amounts are unchanged",async()=>{setup();const result=await cafe24Chunk(input(state()));assert.equal(result.state.stage,"LIST_VERIFY");assert.deepEqual(result.state.items[0],[item()]);assert.equal(result.snapshot,null);});
test("helper preserves original exception identity, safe code, retryability and prior diagnostic",()=>{
 const original=new ProviderFailure("FIELD_UNSUPPORTED",true,42,"request","CAFE24_FIELD_ITEM_ID");
 assert.throws(()=>withCafe24Diagnostic("CAFE24_FIELD_ITEM_SHAPE",()=>{throw original;}),e=>e===original&&e.retryable&&e.retryAfterMs===42&&e.diagnosticCode==="CAFE24_FIELD_ITEM_ID");
 const unrelated=new ProviderFailure("PROVIDER_UNAVAILABLE",true);assert.throws(()=>withCafe24Diagnostic("CAFE24_FIELD_ITEM_SHAPE",()=>{throw unrelated;}),e=>e===unrelated&&e.diagnosticCode===null);
});
for(const gate of ["APP_VERSION","SELLER_OPTIONS"] as const)test(`scheduled ${gate} stops before database and credential access`,async()=>{
 setup();process.env.DAILY_SYNC_FEATURE_ENABLED="true";let reads=0;
 const client=new Cafe24OrdersClient({sourceConnection:{findUnique:async()=>{reads++;throw Error("UNEXPECTED");}}} as any,{accessToken:async()=>{reads++;throw Error("UNEXPECTED");}} as any);
 process.env.DAILY_SYNC_CAFE24_APP_API_VERSION=gate==="APP_VERSION"?"invalid":"2026-09-01";
 process.env.DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT="2026-10-20";
 process.env.DAILY_SYNC_CAFE24_SELLER_DROPDOWN="false";process.env.DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT="2026-10-20";
 await assert.rejects(client.fetchScheduledChunk("synthetic","2026-10-19",now+55000,null),e=>(e as any).diagnosticCode===`CAFE24_EVIDENCE_${gate}`);assert.equal(reads,0);
});

class TransportProbe extends Cafe24OrdersClient {
 read(){return this.getJson(new URL("https://synthetic.invalid/orders/PRIVATE_SYNTHETIC_ORDER"),"PRIVATE_SYNTHETIC_ACCESS",Date.now()+5000);}
}
for(const status of [400,404,422])test(`HTTP ${status} is distinct from unsupported provider fields without reading its body`,async()=>{
 let bodyReads=0;const response=new Response(null,{status});Object.defineProperty(response,"body",{get(){bodyReads++;throw Error("BODY_MUST_NOT_BE_READ");}});
 const client=new TransportProbe({} as any,{} as any,async()=>response);
 await assert.rejects(client.read(),reason(`CAFE24_RESPONSE_HTTP_${status}`));assert.equal(bodyReads,0);
});
test("invalid JSON keeps its safe failure code and adds only a fixed reason",async()=>{
 const client=new TransportProbe({} as any,{} as any,async()=>new Response("PRIVATE_SYNTHETIC_RESPONSE",{status:200}));
 await assert.rejects(client.read(),reason("CAFE24_RESPONSE_INVALID_JSON"));
});
