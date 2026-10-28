import test from "node:test";
import assert from "node:assert/strict";
import {Cafe24ProductMatcher,type Cafe24RuleInput} from "../apps/api/src/domain/cafe24-matcher";
import {separateRulePlan} from "./cafe24-separate-rule-plan";
const base:Cafe24RuleInput={id:"r",productId:"p",productNumbers:[],productNameAliases:[],optionIncludeKeywords:[],optionExcludeKeywords:[],priority:1,matchTarget:"LEGACY_COMBINED",isActive:true};
const plan=(product:string,label:string,extra:Partial<Cafe24RuleInput>={})=>{const r={...base,...extra,displayName:label};return {...r,...separateRulePlan(r,product)};};
const match=(productName:string,optionValue:string,rules:Cafe24RuleInput[])=>new Cafe24ProductMatcher().match({productNo:"",productName,optionValue,optionName:"arbitrary display string with 1+1 SET + 🚀",orderDate:new Date("2026-10-27Z")},rules);
test("balaclava promotion in title cannot change the selected model or bundle",()=>{
 const rules=["바라클라바","바라클라바 프로","바라클라바 1+1","바라클라바 프로 1+1"].map((label,i)=>({...plan("바라클라바",label),id:String(i)}));
 assert.equal(match("겨울 바라클라바 자사몰 단독 1+1 할인","옵션2.인피니티 바라클라바 프로, 색상=블랙",rules).matchRuleId,"1");
 for(const [option,index] of [["기본",0],["프로",1],["기본 1+1",2],["프로 1+1",3]] as const)assert.equal(match("겨울 바라클라바 1+1",option,rules).matchRuleId,String(index));
});
test("band colors and SET are option predicates; rocket is a product predicate",()=>{
 const rules=[
  {...plan("풀업밴드","풀업밴드 (크로스셀링)",{optionIncludeKeywords:["풀업밴드","그린"],optionExcludeKeywords:["퍼플","블랙","레드","SET","🚀"]}),id:"cross"},
  {...plan("풀업밴드","풀업밴드 🚀",{optionIncludeKeywords:["풀업밴드","그린","🚀"],optionExcludeKeywords:["퍼플","블랙","레드","SET"]}),id:"green"},
  {...plan("풀업밴드","풀업밴드 세트 🚀",{optionIncludeKeywords:["풀업밴드","SET","🚀"],optionExcludeKeywords:["퍼플","블랙","레드"]}),id:"set"}
 ];
 assert.equal(match("풀업 밴드 🚀SET 구성 특가","옵션1.그린(초급자)45mm",rules).matchRuleId,"green");
 assert.equal(match("풀업밴드 그린 초급자","그린(초급자)45mm",rules).matchRuleId,"cross");
 assert.equal(match("풀업밴드 🚀SET 구성 특가","풀업밴드 SET",rules).matchRuleId,"set");
 assert.equal(match("풀업밴드 그린 초급자","퍼플(중급자)32mm",rules).reason,"NO_MATCH");
});
test("bundle wavebar and slide rules identify original options without option aliases",()=>{
 for(const product of ["버닝웨이브바","버닝 슬라이드"]){
  const single={...plan(product,product+" 단품"),id:"single"},bundle={...plan(product,product+" 1+1"),id:"bundle"};
  assert.equal(match(product+" 케이스 + 스트랩 무료", "블랙",[single,bundle]).matchRuleId,"single");
  assert.equal(match(product,"블랙+그레이",[single,bundle]).matchRuleId,"bundle");
 }
});
test("slide option must identify a slide; title's pro and gift words do not substitute",()=>{
 const rules=["퍼펙트슬라이드_기본형","퍼펙트슬라이드_프로형","퍼펙트슬라이드 프로 1+1"].map((label,i)=>({...plan("퍼펙트슬라이드",label),id:String(i)}));
 const name="퍼펙트 슬라이드 프로 고급 무릎패드 무료";
 assert.equal(match(name,"퍼펙트 슬라이드 프로",rules).matchRuleId,"1");
 assert.equal(match(name,"퍼펙트 슬라이드 프로 1+1",rules).matchRuleId,"2");
 assert.equal(match("퍼펙트 AB슬라이드","퍼팩트 슬라이드 일반형",rules).matchRuleId,"0");
 assert.equal(match("퍼펙트 AB슬라이드","케겔 일반형(블랙)",rules).reason,"NO_MATCH");
});
test("same product number does not confuse gyro and iron products",()=>{
 const gyro={...plan("자이로볼","자이로볼 아이언",{optionIncludeKeywords:["아이언"],optionExcludeKeywords:["챌린지","메딕","메탈","호크아이","비밀링크","아이언볼"]}),id:"gyro"};
 const iron={...plan("아이언볼","아이언볼"),id:"iron"};
 assert.equal(match("아이언볼 전용케이스 무료","옵션1.아이언볼",[gyro,iron]).matchRuleId,"iron");
 assert.equal(match("4세대 자이로볼","아이언 best",[gyro,iron]).matchRuleId,"gyro");
 assert.equal(match("비밀링크 자이로볼","아이언",[gyro,iron]).reason,"NO_MATCH");
});
test("inactive and date controls remain intact; separate rules are left alone",()=>{
 const r=plan("두줄무릎보호대","두줄무릎보호대 단품",{isActive:false,validFrom:"2026-06-01",validTo:"2026-07-31"});
 assert.equal(r.isActive,false);assert.equal(r.validFrom,"2026-06-01");assert.equal(r.validTo,"2026-07-31");
 assert.equal(separateRulePlan({...base,matchTarget:"SEPARATE"},"방한마스크"),null);
 assert.throws(()=>separateRulePlan(base,"새 상품"),/UNREVIEWED_PRODUCT_RULE/);
});
