import {productionCafe24Db} from "./cafe24-production-context";
import {Cafe24ProductMatcher} from "../apps/api/src/domain/cafe24-matcher";
import {loadCafe24MatcherRules} from "../apps/api/src/daily-sync/cafe24-rule-loader";
import {writeSecurityAudit} from "../apps/api/src/security-audit/security-audit.types";
import {Cafe24UploadsService} from "../apps/api/src/sales/cafe24-uploads.service";
const {db,close}=productionCafe24Db();
const productId="2fe84a89-aeb3-4f7f-be8c-5bf186a47a77",apply=process.argv.includes("--apply");
async function main(){
  const rules=await db.cafe24ProductRule.findMany({where:{productId,isActive:true}});
  const single=rules.find(r=>r.displayName==="방한마스크 단품"),bundle=rules.find(r=>r.displayName==="방한마스크 1+1");
  if(rules.length!==2||!single||!bundle)throw Error("MASK_RULE_SCOPE_CHANGED");
  const lines=await db.cafe24OrderLine.findMany({where:{isCurrent:true,productNo:"202"}});
  if(!lines.length||lines.some(l=>l.optionValue===null))throw Error("MASK_ORIGINAL_OPTION_INCOMPLETE");
  const from=new Date(Math.min(...lines.filter(l=>l.orderDate).map(l=>l.orderDate!.getTime())));
  const body=(isBundle:boolean)=>({matchTarget:"SEPARATE",productNameIncludeKeywords:["방한","마스크"],productNameExcludeKeywords:[],
    productNameAliases:[],optionIncludeKeywords:isBundle?["+"]:[],optionExcludeKeywords:isBundle?[]:["+"],validFrom:from});
  const all=await loadCafe24MatcherRules(db),matcher=new Cafe24ProductMatcher();
  const candidate=all.map(r=>r.id===single.id||r.id===bundle.id?{...r,...body(r.id===bundle.id)}:r);
  const results=lines.map(line=>({line,match:matcher.match(line,candidate)}));
  if(results.some(v=>v.match.reason!=="MATCHED"||v.match.productId!==productId))throw Error("MASK_MAPPING_UNVERIFIED");
  const counts={single:results.filter(v=>v.match.matchRuleId===single.id).length,bundle:results.filter(v=>v.match.matchRuleId===bundle.id).length};
  if(apply)await db.$transaction(async tx=>{
    for(const r of [single,bundle]){
      const update=await tx.cafe24ProductRule.updateMany({where:{id:r.id,updatedAt:r.updatedAt},data:body(r.id===bundle.id)});
      if(update.count!==1)throw Error("MASK_RULE_CONCURRENT_CHANGE");
      await writeSecurityAudit(tx,{actorType:"SYSTEM",action:"CAFE24_MAPPING_RULE_SEPARATED",targetType:"CAFE24_PRODUCT_RULE",targetId:r.id,result:"SUCCESS",
        beforeJson:{matchTarget:r.matchTarget,optionIncludeKeywords:r.optionIncludeKeywords,optionExcludeKeywords:r.optionExcludeKeywords},afterJson:{...body(r.id===bundle.id),validFrom:from.toISOString().slice(0,10)}});
    }
    for(const {line,match} of results){
      const retained=(Array.isArray(line.validationErrors)?line.validationErrors:[]).filter(e=>!e||typeof e!=="object"||Array.isArray(e)||!["CAFE24_PRODUCT_UNMATCHED","CAFE24_PRODUCT_AMBIGUOUS"].includes(String(e.errorCode)));
      const update=await tx.cafe24OrderLine.updateMany({where:{id:line.id,isCurrent:true,optionValue:line.optionValue},data:{productId,cafe24ProductRuleId:match.matchRuleId,matchSource:"RULE",validationStatus:retained.length?"WARNING":"VALID",validationErrors:retained}});
      if(update.count!==1)throw Error("MASK_LINE_CONCURRENT_CHANGE");
      await writeSecurityAudit(tx,{actorType:"SYSTEM",action:"CAFE24_MAPPING_REMATCH",targetType:"CAFE24_ORDER_LINE",targetId:line.id,result:"SUCCESS",
        beforeJson:{productId:line.productId,ruleId:line.cafe24ProductRuleId},afterJson:{productId,ruleId:match.matchRuleId}});
      if(line.uploadBatchId)await tx.cafe24UploadRowError.deleteMany({where:{orderLineId:line.id,errorCode:{in:["CAFE24_PRODUCT_UNMATCHED","CAFE24_PRODUCT_AMBIGUOUS"]}}});
    }
  },{timeout:20_000});
  if(apply)await (new Cafe24UploadsService(db,{} as any) as any).refreshCafe24BatchIssueCounts([...new Set(lines.map(l=>l.uploadBatchId).filter(Boolean))]);
  console.log(JSON.stringify({mode:apply?"APPLY":"PREVIEW",from:from.toISOString().slice(0,10),lines:lines.length,...counts,unmatched:0,ambiguous:0,financialFieldsChanged:0}));
}
main().catch(e=>{console.error(JSON.stringify({status:"FAILED",code:/^[A-Z_]+$/.test(e.message)?e.message:e.code??"MASK_REMATCH_FAILED"}));process.exitCode=1;}).finally(close);
