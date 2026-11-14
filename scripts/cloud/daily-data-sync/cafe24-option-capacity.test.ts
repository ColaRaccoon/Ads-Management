import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import {normalizeCafe24Order} from "../../../apps/api/src/daily-sync/cafe24-order-adapter";
import {cafe24OriginalOptionItems} from "../../../apps/api/src/daily-sync/cafe24-option-backfill";
import {ProviderFailure} from "../../../apps/api/src/daily-sync/bounded-request";
import {CAFE24_OPTION_VALUE_LIMIT, CAFE24_OPTION_COMPOSITION_LIMIT} from "../../../apps/api/src/daily-sync/cafe24-option-projection";
import {cafe24CanonicalFingerprint} from "../../../apps/api/src/daily-sync/cafe24-canonical-fingerprint";

const order = {order_id:"ORDER",shop_no:1,currency:"KRW",order_date:"2026-11-13T12:00:00+09:00",payment_amount:"100",payment_method:["card"]};
const item = {order_item_code:"LINE",product_no:"1",product_name:"상품",option_value:"S",quantity:1,product_price:"100",order_status:"N00"};
const options = {verifiedSellerDropdown:true,csvOptionEvidence:{mallId:"didadi0729",shopKey:"shop1"}};

test("keeps a long provider option and its exact combined identity and fingerprint",()=>{
  for(const length of [257,512,1024]){
    const value="S".repeat(length);
    const row=normalizeCafe24Order(order,[{...item,option_value:value}],options)[0];
    assert.equal(row.optionValue,value);assert.equal(row.optionName,`상품(${value})`);
    assert.equal(cafe24OriginalOptionItems([{...item,option_value:value}])[0].optionValue,value);
    const key=Buffer.alloc(32,7);
    assert.notEqual(cafe24CanonicalFingerprint(key,"connection",row,"1"),
      cafe24CanonicalFingerprint(key,"connection",{...row,optionValue:value.slice(0,-1)},"1"));
  }
  assert.equal(CAFE24_OPTION_VALUE_LIMIT,1024);
  assert.equal(CAFE24_OPTION_COMPOSITION_LIMIT,1282);
});

test("product-name and option-value capacities remain independent and invalid values stay blocked",()=>{
  const rejected=(error:unknown)=>error instanceof ProviderFailure&&error.safeCode==="FIELD_UNSUPPORTED";
  assert.throws(()=>normalizeCafe24Order(order,[{...item,product_name:"P".repeat(257)}],options),rejected);
  for(const value of ["S".repeat(1025),null,undefined,"bad\nvalue"," padded"])
    assert.throws(()=>normalizeCafe24Order(order,[{...item,option_value:value}],options),rejected);
  const row=normalizeCafe24Order(order,[{...item,product_name:"P".repeat(256),option_value:"S".repeat(1024)}],options)[0];
  assert.equal(row.optionName.length,1282);
});
