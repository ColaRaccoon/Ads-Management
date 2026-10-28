import type {Cafe24RuleInput} from "../apps/api/src/domain/cafe24-matcher";

/** Reviewed against the original Cafe24 product_name and option_value, never the display string. */
export function separateRulePlan(rule:Cafe24RuleInput, productName:string){
 if(rule.matchTarget==="SEPARATE")return null;
 let pi:string[]=[],px:string[]=[],oi:string[]=[],ox:string[]=[];
 const label=rule.displayName??"";
 switch(productName){
  case "버닝웨이브바": pi=["버닝","웨이브","바"];oi=label.includes("1+1")?["+"]:[];ox=oi.length?[]:["+"];break;
  case "버닝 슬라이드":pi=["버닝","슬라이드"];oi=label.includes("1+1")?["+"]:[];ox=oi.length?[]:["+"];break;
  case "스카이스텝":pi=["스카이스텝"];break;
  case "유쉴드마스크":pi=["유쉴드"];oi=label.includes("1+1")?["1+1"]:[];ox=oi.length?[]:["1+1"];break;
  case "퍼펙트스케이트":pi=["퍼펙트","스케이트"];oi=["스케이트"];break;
  case "아이언볼":pi=["아이언볼"];px=["유튜브","공동구매"];oi=["아이언볼"];break;
  case "한줄보호대":pi=["한줄","보호대"];px=["두줄"];oi=label.includes("1+1")?["한줄","1+1"]:["한줄"];ox=label.includes("1+1")?["두줄"]:["두줄","1+1"];break;
  case "에어스텝퍼":pi=["에어","스텝퍼"];if(rule.isActive){px=["공동구매","플로우"];ox=["공동구매","플로우"];}break;
  case "풀업바":pi=["풀업바"];oi=["풀업바"];break;
  case "바라클라바":pi=["바라클라바"];px=["유튜브","공동구매"];oi=[...(label.includes("프로")?["프로"]:[]),...(label.includes("1+1")?["1+1"]:[])];ox=["유튜브","공동구매",...(!label.includes("프로")?["프로"]:[]),...(!label.includes("1+1")?["1+1"]:[])];break;
  case "플로우라이트":pi=["플로우라이트"];oi=label.includes("1+1")?["+"]:[];ox=oi.length?[]:["+"];break;
  case "풀업밴드":pi=["풀업밴드",...(label.includes("🚀")?["🚀"]:[])];px=label.includes("🚀")?[]:["🚀"];oi=rule.optionIncludeKeywords.filter(k=>!["풀업밴드","🚀"].includes(k));ox=rule.optionExcludeKeywords.filter(k=>k!=="🚀");break;
  case "노필수면안대":pi=["노필","수면안대"];break;
  case "퍼펙트슬라이드":pi=["퍼펙트","슬라이드"];oi=["슬라이드",...(label.includes("기본형")?["일반형"]:["프로"]),...(label.includes("1+1")?["1+1"]:[])];ox=label.includes("기본형")?["프로형"]:label.includes("1+1")?["일반"]:["일반형","1+1"];break;
  case "뷰티레그보드":pi=["뷰티레그보드"];break;
  case "러닝조끼":pi=["러닝","조끼"];px=["공동구매","유튜브"];ox=["공동구매","유튜브"];break;
  case "러닝양말":pi=["러닝","양말"];break;
  case "자이로볼":pi=["자이로볼"];px=["비밀링크"];oi=[...rule.optionIncludeKeywords];ox=rule.optionExcludeKeywords.filter(k=>k!=="비밀링크");break;
  case "다이어트양말":pi=["다이어트","양말"];px=["공동구매","유튜브"];ox=["공동구매","유튜브"];break;
  case "베놈무릎보호대":pi=["베놈","무릎보호대"];break;
  case "두줄무릎보호대":pi=["두줄","보호대"];oi=label.includes("1+1")?["1+1"]:["단품"];ox=label.includes("1+1")?[]:["1+1"];break;
  default:throw Error("UNREVIEWED_PRODUCT_RULE");
 }
 return {matchTarget:"SEPARATE",productNameAliases:[],productNameIncludeKeywords:pi,productNameExcludeKeywords:px,optionIncludeKeywords:oi,optionExcludeKeywords:ox};
}
