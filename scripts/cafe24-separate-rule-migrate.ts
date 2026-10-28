import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {productionCafe24Db} from "./cafe24-production-context";
import {Cafe24ProductMatcher,matchesRule} from "../apps/api/src/domain/cafe24-matcher";
import {toCafe24MatcherRules} from "../apps/api/src/daily-sync/cafe24-rule-loader";
import {securityAuditData} from "../apps/api/src/security-audit/security-audit.types";
import {Cafe24UploadsService} from "../apps/api/src/sales/cafe24-uploads.service";
import {separateRulePlan} from "./cafe24-separate-rule-plan";
const {db,close}=productionCafe24Db(),apply=process.argv.includes("--apply");
const codes=["CAFE24_PRODUCT_UNMATCHED","CAFE24_PRODUCT_AMBIGUOUS"];
const fingerprint=(rows:any[])=>createHash("sha256").update(JSON.stringify(rows.map(({productId,cafe24ProductRuleId,matchSource,validationStatus,validationErrors,...raw})=>raw))).digest("hex");
async function main(){
 const saved=await db.cafe24ProductRule.findMany({include:{product:{select:{name:true,isActive:true}}},orderBy:{id:"asc"}});
 const old=toCafe24MatcherRules(saved),plans=saved.map((r,i)=>({rule:r,body:separateRulePlan(old[i],r.product.name)})).filter(p=>p.body);
 const candidate=old.map((r,i)=>({...r,...separateRulePlan(r,saved[i].product.name)}));
 const active=candidate.filter((r,i)=>r.isActive&&saved[i].product.isActive),matcher=new Cafe24ProductMatcher();
 const rows=await db.cafe24OrderLine.findMany({where:{isCurrent:true},omit:{rawRow:true},orderBy:{id:"asc"}});
 if(rows.some(r=>r.optionValue===null))throw Error("ORIGINAL_OPTIONS_INCOMPLETE");
 const beforeFingerprint=fingerprint(rows),changes:any[]=[],counts:Record<string,number>={},transitions:Record<string,number>={},residual:Record<string,number>={},residualReasons:Record<string,number>={};
 let retainedHistorical=0,ambiguous=0,selectedRows=0;
 for(const row of rows){
  if(row.validationStatus==="ERROR"||!["RULE","UNMATCHED"].includes(row.matchSource))continue;
  selectedRows++;
  const result=matcher.match(row,active),previous=candidate.find(r=>r.id===row.cafe24ProductRuleId);
  // An inactive rule or a later edited start date must not erase a valid stored historical attribution.
  const history=result.reason==="NO_MATCH"&&previous&&row.productId===previous.productId&&matchesRule(row,previous);
  if(history){retainedHistorical++;counts[previous.displayName??previous.id]=(counts[previous.displayName??previous.id]??0)+1;continue;}
  if(result.reason==="AMBIGUOUS_MATCH")ambiguous++;
  const label=result.reason==="MATCHED"?result.candidates[0]:result.reason;counts[label]=(counts[label]??0)+1;
  if(result.reason!=="MATCHED"){
   const related=candidate.filter(r=>r.productNumbers.includes(row.productNo));
   const reason=!related.length?"NO_PRODUCT_RULE":active.some(r=>matchesRule(row,r))?"OUTSIDE_RULE_DATES":related.some(r=>matchesRule(row,r))?"INACTIVE_RULE_OR_PRODUCT":"ADD_ON_OR_UNCONFIGURED_OPTION";
   residualReasons[reason]=(residualReasons[reason]??0)+1;
   const key=related.length?`${row.productNo}: ${related[0].displayName} / ${row.optionValue?.slice(0,100)}`:`NO_RULE_PRODUCT_${row.productNo}`;
   residual[key]=(residual[key]??0)+1;
  }
  const kept=(Array.isArray(row.validationErrors)?row.validationErrors:[]).filter((e:any)=>!e||typeof e!=="object"||!codes.includes(e.errorCode));
  const issues=result.reason==="MATCHED"?[]:[{columnName:null,errorCode:result.reason==="NO_MATCH"?codes[0]:codes[1],message:result.reason==="NO_MATCH"?"Cafe24 order line did not match any active product rule.":"Cafe24 order line matched more than one active rule.",severity:"WARNING",...(result.reason==="AMBIGUOUS_MATCH"?{rawValue:result.candidates.join(", ")}: {})}];
  const data={productId:result.productId,cafe24ProductRuleId:result.matchRuleId,matchSource:result.source,validationStatus:result.reason==="NO_MATCH"?"UNMATCHED":kept.length||issues.length?"WARNING":"VALID",validationErrors:[...kept,...issues]};
  // Skip unchanged associations; this migration does not rewrite unrelated validation metadata.
  if(row.productId===data.productId&&row.cafe24ProductRuleId===data.cafe24ProductRuleId&&row.matchSource===data.matchSource)continue;
  const from=saved.find(r=>r.id===row.cafe24ProductRuleId)?.displayName??"UNMATCHED";
  const key=`${from} -> ${label}`;transitions[key]=(transitions[key]??0)+1;
  if(row.productId&&!data.productId&&!row.optionValue?.includes("케겔"))throw Error("UNREVIEWED_MAPPING_LOSS");
  changes.push({row,data,issues});
 }
 if(ambiguous)throw Error("AMBIGUOUS_NEW_RULES");
 const batchIds=[...new Set(changes.map(c=>c.row.uploadBatchId).filter(Boolean))] as string[];
 for(const id of batchIds){
  const batch=await db.cafe24UploadBatch.findUnique({where:{id},select:{rowCount:true,importedAt:true}});
  const count=await db.cafe24OrderLine.count({where:{uploadBatchId:id}});
  if(!batch?.importedAt||batch.rowCount!==count)throw Error("INCOMPLETE_UPLOAD_BATCH");
 }
 const report:any={mode:apply?"APPLY":"PREVIEW",scanned:rows.length,selectedRows,ruleChanges:plans.length,products:new Set(plans.map(p=>p.rule.productId)).size,retainedHistorical,changedRows:changes.length,ambiguous,counts,transitions,residual,residualReasons,plan:plans.map(({rule,body})=>({id:rule.id,name:rule.displayName,isActive:rule.isActive,before:{matchTarget:rule.matchTarget,productNameAliases:rule.productNameAliases,productNameIncludeKeywords:rule.productNameIncludeKeywords,productNameExcludeKeywords:rule.productNameExcludeKeywords,optionIncludeKeywords:rule.optionIncludeKeywords,optionExcludeKeywords:rule.optionExcludeKeywords},after:body}))};
 const reportPath=join(tmpdir(),`cafe24-separate-rules-${apply?"applied":"preview"}.json`);
 writeFileSync(reportPath,JSON.stringify(report,null,2));
 console.log(JSON.stringify({stage:"PRECHECK",...report,plan:undefined,residual:undefined,reportPath}));
 if(apply){
  await db.$transaction(async tx=>{
   const now=await tx.cafe24ProductRule.findMany({select:{id:true,updatedAt:true},orderBy:{id:"asc"}});
   if(JSON.stringify(now)!==JSON.stringify(saved.map(r=>({id:r.id,updatedAt:r.updatedAt}))))throw Error("RULE_SET_CONCURRENT_CHANGE");
   for(const {rule,body} of plans){
    const update=await tx.cafe24ProductRule.updateMany({where:{id:rule.id,updatedAt:rule.updatedAt},data:body!});
    if(update.count!==1)throw Error("RULE_CONCURRENT_CHANGE");
   }
   if(plans.length)await tx.securityAuditEvent.createMany({data:report.plan.map((p:any)=>securityAuditData({actorType:"SYSTEM",action:"CAFE24_MAPPING_RULE_SEPARATED",targetType:"CAFE24_PRODUCT_RULE",targetId:p.id,result:"SUCCESS",beforeJson:p.before,afterJson:p.after}))});
   const grouped=new Map<string,any[]>();for(const c of changes){const key=JSON.stringify(c.data);const group=grouped.get(key)??[];group.push(c);grouped.set(key,group);}
   for(const group of grouped.values())for(let i=0;i<group.length;i+=100){
    const chunk=group.slice(i,i+100);
    const update=await tx.cafe24OrderLine.updateMany({where:{isCurrent:true,OR:chunk.map(({row})=>({id:row.id,productNo:row.productNo,productName:row.productName,optionValue:row.optionValue,orderDate:row.orderDate,productId:row.productId,cafe24ProductRuleId:row.cafe24ProductRuleId,matchSource:row.matchSource,validationStatus:row.validationStatus,validationErrors:{equals:row.validationErrors}}))},data:group[0].data});
    if(update.count!==chunk.length)throw Error("LINE_CONCURRENT_CHANGE");
   }
   if(changes.length){
    await tx.securityAuditEvent.createMany({data:changes.map(({row,data})=>securityAuditData({actorType:"SYSTEM",action:"CAFE24_MAPPING_REMATCH",targetType:"CAFE24_ORDER_LINE",targetId:row.id,result:"SUCCESS",beforeJson:{productId:row.productId,ruleId:row.cafe24ProductRuleId,validationStatus:row.validationStatus},afterJson:{productId:data.productId,ruleId:data.cafe24ProductRuleId,validationStatus:data.validationStatus}}))});
    await tx.cafe24UploadRowError.deleteMany({where:{orderLineId:{in:changes.map(c=>c.row.id)},errorCode:{in:codes}}});
    const errors=changes.filter(c=>c.row.uploadBatchId).flatMap(({row,issues})=>issues.map((issue:any)=>({uploadBatchId:row.uploadBatchId,orderLineId:row.id,rowNumber:row.rowNumber,columnName:null,severity:issue.severity,errorCode:issue.errorCode,message:issue.message,rawValue:issue.rawValue??null})));
    if(errors.length)await tx.cafe24UploadRowError.createMany({data:errors});
   }
  },{timeout:90000});
  await (new Cafe24UploadsService(db,{} as any) as any).refreshCafe24BatchIssueCounts(batchIds);
  const after=await db.cafe24OrderLine.findMany({where:{isCurrent:true},omit:{rawRow:true},orderBy:{id:"asc"}});
  if(fingerprint(after)!==beforeFingerprint)throw Error("RAW_ORDER_DATA_CHANGED");
  for(const {row,data} of changes){const actual=after.find(r=>r.id===row.id);if(!actual||actual.cafe24ProductRuleId!==data.cafe24ProductRuleId||actual.productId!==data.productId)throw Error("POST_WRITE_MAPPING_MISMATCH");}
  const afterRules=await db.cafe24ProductRule.findMany({orderBy:{id:"asc"}});
  const stableRule=(r:any)=>{const {product,matchTarget,productNameAliases,productNameIncludeKeywords,productNameExcludeKeywords,optionIncludeKeywords,optionExcludeKeywords,updatedAt,...stable}=r;return stable;};
  if(JSON.stringify(saved.map(stableRule))!==JSON.stringify(afterRules.map(stableRule)))throw Error("RULE_FINANCIAL_OR_EFFECTIVE_SETTINGS_CHANGED");
  const legacyRemaining=afterRules.filter(r=>r.matchTarget==="LEGACY_COMBINED").length;
  if(legacyRemaining)throw Error("LEGACY_RULES_REMAIN");
  report.verification={legacyRemaining,currentRows:after.length,rawOrderFingerprintUnchanged:true,ruleFinancialAndEffectiveSettingsUnchanged:true,changedRowsVerified:changes.length,batchesRefreshed:batchIds.length};
  writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({stage:"VERIFIED",...report.verification}));
 }
}
main().catch(e=>{console.error(JSON.stringify({status:"FAILED",code:/^[A-Z_]+$/.test(e.message)?e.message:e.code??"RULE_MIGRATION_FAILED"}));process.exitCode=1;}).finally(close);
