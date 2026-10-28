import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { Cafe24ProductMatcher, matchesRule, type Cafe24RuleInput } from "../apps/api/src/domain/cafe24-matcher";
import { Cafe24CsvParser } from "../apps/api/src/domain/cafe24-csv";
import { normalizeCafe24Order } from "../apps/api/src/daily-sync/cafe24-order-adapter";
import { cafe24OriginalOptionItems } from "../apps/api/src/daily-sync/cafe24-option-backfill";
import { cafe24CanonicalFingerprint } from "../apps/api/src/daily-sync/cafe24-canonical-fingerprint";
import { Cafe24CanonicalWriterService } from "../apps/api/src/daily-sync/cafe24-canonical-writer.service";

const rule: Cafe24RuleInput = { id:"single",productId:"mask",productNumbers:[],productNameAliases:[],
  matchTarget:"SEPARATE",productNameIncludeKeywords:["방한","마스크"],productNameExcludeKeywords:["공동구매"],
  optionIncludeKeywords:[],optionExcludeKeywords:["+"],priority:100,validFrom:"2026-10-01" };
const bundle: Cafe24RuleInput = {...rule,id:"bundle",optionIncludeKeywords:["+"],optionExcludeKeywords:[]};
const row={productNo:"202",productName:"[파티마 방한마스크] ❄️1+1 구성 특별 할인❄️",
  optionName:"표시용 상품명(옵션1.블랙)",optionValue:"⭐색상선택⭐=옵션1.블랙",orderDate:new Date("2026-10-27Z")};
test("promotion in product name does not turn a single option into a bundle",()=>{
  assert(matchesRule(row,rule)); assert(!matchesRule(row,bundle));
  for(const option of ["블랙1+1","브라운1+1","블랙+브라운"]){
    const input={...row,optionValue:`⭐색상선택⭐=${option}`};
    assert(!matchesRule(input,rule));assert(matchesRule(input,bundle));
    assert.equal(new Cafe24ProductMatcher().match(input,[rule,bundle]).matchRuleId,"bundle");
  }
});
test("product and option include/exclude apply to their own fields and together",()=>{
  assert(!matchesRule({...row,productName:"다른 상품",optionValue:"방한마스크 단품"},rule));
  assert(!matchesRule({...row,productName:"공동구매 방한마스크"},rule));
  assert(matchesRule({...row,optionValue:"공동구매 단품"},rule));
  assert(matchesRule({...row,productName:"새 이름 방한 마스크 / (기획전) | 1+1"},rule));
});
test("raw option is mandatory for separate mode; never split combined names",()=>{
  assert(!matchesRule({...row,optionValue:null},rule));
  assert(!matchesRule({...row,optionValue:undefined},rule));
  assert(!matchesRule(row,{...rule,matchTarget:"UNKNOWN"}));
});
test("legacy matching and ambiguity remain explicit",()=>{
  assert(matchesRule({...row,optionValue:null},{...rule,matchTarget:"LEGACY_COMBINED",optionIncludeKeywords:["표시용"]}));
  assert.equal(new Cafe24ProductMatcher().match(row,[rule,{...rule,id:"other",priority:1}]).reason,"AMBIGUOUS_MATCH");
  assert(!matchesRule(row,{...rule,productNameAliases:["옵션1.블랙"]}));
});
test("provider fields with arbitrary punctuation stay independent",()=>{
  const product_name="방한마스크 (새 상품) | ✨1+1✨",option_value="색상=(블랙)|단품";
  const result=normalizeCafe24Order({order_id:"TEST-ORDER",shop_no:1,currency:"KRW",order_date:"2026-10-27T12:00:00+09:00",payment_amount:"10000"},
    [{order_item_code:"TEST-ITEM",product_no:202,product_name,option_value,quantity:"1",product_price:"10000",order_status:"N30"}],
    {verifiedSellerDropdown:true,csvOptionEvidence:{mallId:"didadi0729",shopKey:"shop1"}});
  assert.equal(result[0].productName,product_name);assert.equal(result[0].optionValue,option_value);
  assert.equal(result[0].optionName,`${product_name}(${option_value})`);
  const key=Buffer.alloc(32,7);
  assert.notEqual(cafe24CanonicalFingerprint(key,"connection",result[0],"202"),
    cafe24CanonicalFingerprint(key,"connection",{...result[0],optionValue:null},"202"));
});
test("backfill accepts only original provider fields with unambiguous identity",()=>{
  const result=cafe24OriginalOptionItems([{order_item_code:"ITEM-1",product_no:202,option_value:"색상=(블랙)+브라운"}]);
  assert.equal(result[0].optionValue,"색상=(블랙)+브라운");
  assert.throws(()=>cafe24OriginalOptionItems([{order_item_code:"ITEM-1",product_no:202,product_name:"상품(옵션)"}]));
  assert.throws(()=>cafe24OriginalOptionItems([{order_item_code:"ITEM-1",product_no:202,option_value:"A"},{order_item_code:"ITEM-1",product_no:202,option_value:"B"}]));
});
test("CSV without dedicated option column never infers raw options",()=>{
  const csv={"주문번호":"TEST-ORDER","품목별 주문번호":"TEST-ITEM","총 결제금액":"10000","상품번호":"202",
    "주문상품명":"방한마스크 1+1 행사","주문상품명(옵션포함)":"방한마스크 1+1 행사(블랙)","수량":"1","판매가":"10000","결제수단":"카드","발주일":"2026-10-27 12:00:00"};
  const parser=new Cafe24CsvParser();
  assert.equal(parser.parseRow(csv).parsedRow?.optionValue,null);
  assert.equal(parser.parseRow({...csv,"옵션값":"색상=블랙"}).parsedRow?.optionValue,"색상=블랙");
});

test("completed-day reread versions a newly recovered option without duplicating financial rows",async()=>{
  const savedKey=process.env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64,savedVersion=process.env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION;
  process.env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64=Buffer.alloc(32,17).toString("base64");
  process.env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION="2";
  const versions:any[]=[],lines:any[]=[],links:any[]=[];
  const model=(items:any[])=>({findMany:async()=>items.filter(v=>v.isCurrent),createMany:async({data}:any)=>items.push(...data),
    updateMany:async({where,data}:any)=>{const selected=items.filter(v=>v.isCurrent&&(!where.id||where.id.in.includes(v.id)));selected.forEach(v=>Object.assign(v,data));return{count:selected.length};}});
  const tx:any={cafe24ProductRule:{findMany:async()=>[]},cafe24OrderApiVersion:{...model(versions),
    groupBy:async()=>versions.length?[{canonicalKeyHash:versions[0].canonicalKeyHash,_max:{version:Math.max(...versions.map(v=>v.version))}}]:[]},
    cafe24OrderLine:model(lines),sourceRecordLink:model(links),$executeRaw:async()=>0};
  const writer=new Cafe24CanonicalWriterService({} as any,{} as any);
  const base:any={orderNo:"TEST-ORDER",lineOrderNo:"TEST-LINE",productNo:"202",productName:"방한마스크 1+1 행사",optionName:"방한마스크 1+1 행사(블랙)",
    optionValue:null,orderedAt:new Date("2026-10-27T03:00:00Z"),orderDate:new Date("2026-10-27Z"),providerUpdatedAt:null,quantity:"1.0000",salePriceKrw:"10000.00",totalOrderKrw:null,totalPaidKrw:"10000.00",paymentMethod:null};
  const write=(input:any)=>(writer as any).writeCafe24Rows(tx,{connectionId:"connection",runId:"run"},[input],new Date("2026-10-28T00:00:00Z"));
  try {
    await write(base);const businessKey=lines[0].orderLineKey;
    await write({...base,optionValue:"색상=블랙"});
    assert.equal(versions.length,2);assert.equal(lines.length,2);
    const current=lines.filter(v=>v.isCurrent);assert.equal(current.length,1);
    assert.equal(current[0].optionValue,"색상=블랙");assert.equal(current[0].orderLineKey,businessKey);
    assert.equal(current[0].quantity.toString(),"1");assert.equal(current[0].totalPaidKrw.toString(),"10000");
    assert.equal(versions.filter(v=>v.isCurrent)[0].optionValue,"색상=블랙");
    await write({...base,optionValue:"색상=블랙"});assert.equal(lines.length,2);assert.equal(versions.length,2);
  } finally {
    if(savedKey===undefined)delete process.env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64;else process.env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64=savedKey;
    if(savedVersion===undefined)delete process.env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION;else process.env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION=savedVersion;
  }
});
