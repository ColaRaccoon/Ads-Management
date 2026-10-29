// Dated maintenance, not a sync job. Preview is the default; --apply requires
// the original local snapshots and refuses replay after a committed operation.
import {writeFileSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {productionCafe24Db} from './cafe24-production-context';
import {SalesMetricsService} from '../apps/api/src/sales/sales-metrics.service';
import {GoogleReadService} from '../apps/api/src/google/google-read.service';
import {Prisma} from '@prisma/client';
import {Cafe24ProductMatcher} from '../apps/api/src/domain/cafe24-matcher';
import {toCafe24MatcherRules} from '../apps/api/src/daily-sync/cafe24-rule-loader';
import {writeSecurityAudit} from '../apps/api/src/security-audit/security-audit.types';
import {Cafe24UploadsService} from '../apps/api/src/sales/cafe24-uploads.service';
const {db,close}=productionCafe24Db();
const day=(d:Date|null)=>d?.toISOString().slice(0,10)??null;
const evidence=join(tmpdir(),'youtube-channel-before-20261029.json');
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const operationFile=join(tmpdir(),'youtube-channel-operation-20261029.json');
const targetRules=new Map([
 ['0da829ad-8cf5-416c-90b2-5f3769c8fcf5',{youtube:'180',regular:'145',product:'5d716ce2-2aa3-452e-8f32-3c30eac1d9f0'}],
 ['4e2a7e06-ed85-46dc-bf19-04d1954dc042',{youtube:'179',regular:'120',product:'051772e0-d4bc-414b-8817-5ee09d3e7db6'}]
]);
async function fingerprints(client:any){
 return (await client.$queryRaw(Prisma.sql`SELECT count(*)::int AS "rows",
 md5(string_agg(jsonb_build_array(id,order_date,source,connection_id,import_version,source_row_hash,
 quantity,sale_price_krw,total_order_krw,total_paid_krw,actual_order_price_krw,actual_payment_krw,
 actual_shipping_fee_krw,initial_order_price_krw,initial_payment_krw,initial_shipping_fee_krw)::text,',' ORDER BY id)) AS "financial",
 md5(string_agg(CASE WHEN product_name NOT LIKE '%[유튜브]%' THEN
 jsonb_build_array(id,product_id,cafe24_product_rule_id,match_source,validation_status,validation_errors)::text END,',' ORDER BY id)) AS "regularMappings"
 FROM cafe24_order_lines WHERE is_current=true`))[0];
}
async function separate(apply:boolean){
 if(existsSync(operationFile)&&JSON.parse(readFileSync(operationFile,'utf8')).applied)throw Error('SEPARATION_ALREADY_APPLIED');
 const baseline=JSON.parse(readFileSync(evidence,'utf8'));
 const rules=await db.cafe24ProductRule.findMany({where:{isActive:true},orderBy:{id:'asc'}});
 const lines=await db.cafe24OrderLine.findMany({where:{isCurrent:true,productName:{contains:'[유튜브]'}},orderBy:{id:'asc'}});
 if(lines.length!==baseline.lines.length||hash(lines.map(l=>l.id))!==hash(baseline.lines.map((l:any)=>l.id)))throw Error('YOUTUBE_SCOPE_CHANGED');
 const maps=await db.googlePerformanceMapping.findMany({where:{kind:'SALE',productNo:{in:['179','180']},optionScope:'PRODUCT'}});
 for(const [id,target]of targetRules){
  const rule=rules.find(r=>r.id===id),before=baseline.rules.find((r:any)=>r.id===id);
  if(!rule||!before||rule.updatedAt.toISOString()!==before.updatedAt||rule.productId!==target.product)throw Error('RULE_SCOPE_CHANGED');
  if([rule.salePriceKrwOverride,rule.productCostKrwOverride,rule.shippingKrwOverride,rule.extraCostKrwOverride].some(v=>v!==null))throw Error('SHARED_COST_OVERRIDE_REQUIRES_REVIEW');
  const mapping=maps.filter(m=>m.productNo===target.youtube&&m.productId===target.product&&day(m.startDate)!<='2026-10-19'&&!m.endDate);
  if(mapping.length!==1)throw Error('GOOGLE_MAPPING_MISSING');
 }
 const candidate=rules.map(r=>targetRules.has(r.id)?{...r,productNumbers:(r.productNumbers as string[]).filter(n=>n!==targetRules.get(r.id)!.youtube),productNameExcludeKeywords:[...new Set([...(r.productNameExcludeKeywords as string[]),'[유튜브]'])]}:r);
 const matcher=new Cafe24ProductMatcher(),projected=toCafe24MatcherRules(candidate);
 if(lines.some(l=>matcher.match(l,projected).productId!==null))throw Error('YOUTUBE_STILL_MATCHES_META');
 const changed=lines.filter(l=>l.productId!==null);
 if(changed.length!==47||changed.some(l=>!l.cafe24ProductRuleId||!targetRules.has(l.cafe24ProductRuleId)||l.matchSource!=='RULE'||l.validationStatus==='ERROR'))throw Error('MAPPING_CHANGE_SCOPE_MISMATCH');
 const beforeFingerprint=await fingerprints(db);
 const backup={applied:false,rules:rules.filter(r=>targetRules.has(r.id)),lines:changed.map(({id,productId,cafe24ProductRuleId,matchSource,validationStatus,validationErrors})=>({id,productId,cafe24ProductRuleId,matchSource,validationStatus,validationErrors})),beforeFingerprint};
 const summary={mode:apply?'APPLY':'PREVIEW',youtubeProducts:new Set(lines.map(l=>l.productNo)).size,youtubeRows:lines.length,changedRows:changed.length,
  changedByProduct:[...targetRules.values()].map(t=>({productNo:t.youtube,records:changed.filter(l=>l.productNo===t.youtube).length})),changed28:changed.filter(l=>day(l.orderDate)==='2026-10-28').length,financialFieldsChanged:0,sourcePoliciesChanged:0,legacyCsvBindingsChanged:0};
 if(!apply){console.log(JSON.stringify(summary));return;}
 writeFileSync(operationFile,JSON.stringify(backup,null,2));
 await db.$transaction(async tx=>{
  if(JSON.stringify(await fingerprints(tx))!==JSON.stringify(beforeFingerprint))throw Error('INPUTS_CHANGED_DURING_PREPARATION');
  for(const id of targetRules.keys()){
   const before=rules.find(r=>r.id===id)!,after=candidate.find(r=>r.id===id)!;
   const changedRule=await tx.cafe24ProductRule.updateMany({where:{id,updatedAt:before.updatedAt},data:{productNumbers:after.productNumbers,productNameExcludeKeywords:after.productNameExcludeKeywords}});
   if(changedRule.count!==1)throw Error('RULE_CONCURRENT_CHANGE');
   await writeSecurityAudit(tx,{actorType:'SYSTEM',action:'CAFE24_YOUTUBE_CHANNEL_SEPARATED',targetType:'CAFE24_PRODUCT_RULE',targetId:id,result:'SUCCESS',beforeJson:{productNumbers:before.productNumbers,productNameExcludeKeywords:before.productNameExcludeKeywords},afterJson:{productNumbers:after.productNumbers,productNameExcludeKeywords:after.productNameExcludeKeywords}});
  }
  for(const line of changed){
   const issues=(Array.isArray(line.validationErrors)?line.validationErrors:[]).filter((e:any)=>!['CAFE24_PRODUCT_UNMATCHED','CAFE24_PRODUCT_AMBIGUOUS'].includes(e?.errorCode));
   const warning={columnName:null,errorCode:'CAFE24_PRODUCT_UNMATCHED',message:'YouTube sale is separated into a Google-only product mapping.',severity:'WARNING'};
   const result=await tx.cafe24OrderLine.updateMany({where:{id:line.id,isCurrent:true,productId:line.productId,cafe24ProductRuleId:line.cafe24ProductRuleId,matchSource:line.matchSource},data:{productId:null,cafe24ProductRuleId:null,matchSource:'UNMATCHED',validationStatus:'UNMATCHED',validationErrors:[...issues,warning] as Prisma.InputJsonValue}});
   if(result.count!==1)throw Error('LINE_CONCURRENT_CHANGE');
   if(line.uploadBatchId){
    await tx.cafe24UploadRowError.deleteMany({where:{orderLineId:line.id,errorCode:{in:['CAFE24_PRODUCT_UNMATCHED','CAFE24_PRODUCT_AMBIGUOUS']}}});
    await tx.cafe24UploadRowError.create({data:{uploadBatchId:line.uploadBatchId,orderLineId:line.id,rowNumber:line.rowNumber!,...warning,severity:'WARNING'}});
   }
   await writeSecurityAudit(tx,{actorType:'SYSTEM',action:'CAFE24_YOUTUBE_CHANNEL_REMATCHED',targetType:'CAFE24_ORDER_LINE',targetId:line.id,result:'SUCCESS',beforeJson:{productId:line.productId,ruleId:line.cafe24ProductRuleId,matchSource:line.matchSource},afterJson:{productId:null,ruleId:null,matchSource:'UNMATCHED',googleProductId:targetRules.get(line.cafe24ProductRuleId!)!.product}});
  }
  if(JSON.stringify(await fingerprints(tx))!==JSON.stringify(beforeFingerprint))throw Error('FINANCIAL_OR_REGULAR_INPUT_CHANGED');
 },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,timeout:60_000});
 writeFileSync(operationFile,JSON.stringify({...backup,applied:true,summary},null,2));
 await (new Cafe24UploadsService(db,{} as any) as any).refreshCafe24BatchIssueCounts([...new Set(changed.flatMap(l=>l.uploadBatchId?[l.uploadBatchId]:[]))]);
 console.log(JSON.stringify({...summary,afterFingerprint:await fingerprints(db),backup:operationFile}));
}
async function verify(){
 const baseline=JSON.parse(readFileSync(evidence,'utf8')),operation=JSON.parse(readFileSync(operationFile,'utf8'));
 const currentFingerprint=await fingerprints(db);
 if(JSON.stringify(currentFingerprint)!==JSON.stringify(operation.beforeFingerprint))throw Error('FINANCIAL_OR_REGULAR_INPUT_CHANGED');
 const remaining=await db.cafe24OrderLine.count({where:{isCurrent:true,productName:{contains:'[유튜브]'},productId:{not:null}}});
 if(remaining!==0)throw Error('YOUTUBE_STILL_IN_META');
 const meta=await new SalesMetricsService(db).productPerformance({from:'2026-10-28',to:'2026-10-28'});
 const google=await new GoogleReadService(db).report({from:'2026-10-28',to:'2026-10-28',pageSize:100},'profit');
 const history=await new GoogleReadService(db).report({from:'2026-10-19',to:'2026-10-22',pageSize:100},'profit');
 const historical=JSON.parse(readFileSync(join(tmpdir(),'youtube-google-history-before-20261029.json'),'utf8'));
 for(const field of ['quantity','knownRevenueKrw','grossCostKrw','couponDeductionKrw','unmappedSalesCount'])if(history.summary[field as keyof typeof history.summary]!==historical.summary[field])throw Error('GOOGLE_LEGACY_SALES_CHANGED');
 if(JSON.stringify(google.products)!==JSON.stringify(baseline.google.products)||JSON.stringify(google.summary)!==JSON.stringify(baseline.google.summary))throw Error('GOOGLE_OCT28_RESULT_CHANGED');
 for(const row of meta.rows){const before=baseline.meta.rows.find((r:any)=>r.productId===row.productId);if(!before)throw Error('META_PRODUCT_SCOPE_CHANGED');if(row.productId!=='5d716ce2-2aa3-452e-8f32-3c30eac1d9f0'&&JSON.stringify(row)!==JSON.stringify(before))throw Error('OTHER_META_RESULT_CHANGED');}
 const pullup=meta.rows.find(r=>r.productId==='5d716ce2-2aa3-452e-8f32-3c30eac1d9f0')!;
 if(pullup.quantity!==101||pullup.revenueKrw!==3524900||Math.abs(pullup.marginKrw!-515211.788)>0.001)throw Error('PULLUP_MARGIN_UNEXPECTED');
 const unmatched=await new SalesMetricsService(db).unmatchedCafe24Lines({from:'2026-10-28',to:'2026-10-28',take:'500'});
 if(unmatched.filter(l=>l.productNo==='180').length!==10)throw Error('PULLUP_UNMATCHED_LIST_INCOMPLETE');
 const report={verifiedAt:new Date().toISOString(),allYoutubeMappedIntoMeta:remaining,financialInputsUnchanged:true,regularMappingsUnchanged:true,googleHistoryPreserved:true,
  metaProducts:meta.rows.filter(r=>['풀업바','버닝웨이브바','케겔'].includes(r.product?.displayName??'')).map(r=>({name:r.product?.displayName,quantity:r.quantity,revenue:r.revenueKrw,cost:r.grossCostKrw,coupon:r.couponDeductionKrw,adSpend:r.adSpendKrw,margin:r.marginKrw})),
  metaTotals:{quantity:meta.rows.reduce((s,r)=>s+r.quantity,0),revenue:meta.rows.reduce((s,r)=>s+r.revenueKrw,0),margin:meta.rows.reduce((s,r)=>s+(r.marginKrw??0),0)},googleSummary:google.summary,googleProducts:google.products,unmatched:{total:unmatched.length,youtube:unmatched.filter(l=>l.productName.includes('[유튜브]')).length,pullup:10},operation:operation.summary};
 writeFileSync(join(tmpdir(),'youtube-channel-after-20261029.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
async function main(){
 if(process.argv.includes('--ready')){
  const expected='e80f7d1f3f6c574caebe16a962c74aca4cf24dfb';
  const response=await fetch('https://patimagroup-work.com/backend-api/health/ready',{headers:{'x-internal-probe-token':process.env.INTERNAL_PROBE_TOKEN!},signal:AbortSignal.timeout(20000)});
  const body=await response.json();if(!response.ok||body.status!=='ready'||body.releaseId!==expected||!body.runtimeConfigFingerprint)throw Error('DEPLOYMENT_NOT_VERIFIED');
  console.log(JSON.stringify({ready:true,releaseId:body.releaseId}));return;
 }
 if(process.argv.includes('--apply')||process.argv.includes('--plan'))return separate(process.argv.includes('--apply'));
 if(process.argv.includes('--verify'))return verify();
 if(process.argv.includes('--history')){
  const connections=await db.sourceConnection.findMany({where:{provider:'CAFE24'},select:{id:true,displayName:true}});
  const policies=await db.sourcePolicy.findMany({where:{dataKind:'CAFE24_ORDER'},select:{connectionId:true,fromDate:true,toDate:true,primarySource:true}});
  const csv=await db.cafe24OrderLine.findMany({where:{isCurrent:true,source:'CSV',productName:{contains:'[유튜브]'}},select:{id:true,connectionId:true,uploadBatchId:true,productNo:true,productId:true,orderDate:true}});
  const batches=await db.cafe24UploadBatch.findMany({where:{id:{in:[...new Set(csv.flatMap(r=>r.uploadBatchId?[r.uploadBatchId]:[]))]}},select:{id:true,originalFilename:true}});
  const report=await new GoogleReadService(db).report({from:'2026-10-19',to:'2026-10-22',pageSize:100},'profit');
  const file=join(tmpdir(),'youtube-google-history-before-20261029.json');if(!existsSync(file))writeFileSync(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({connections,policies,csv,batches,history:{summary:report.summary,coverage:report.coverage,products:report.products}},null,2));return;
 }
 const lines=await db.cafe24OrderLine.findMany({where:{isCurrent:true,productName:{contains:'[유튜브]'}},include:{product:true,matchRule:true},orderBy:{id:'asc'}});
 const rules=await db.cafe24ProductRule.findMany({where:{isActive:true},orderBy:{id:'asc'}});
 const googleMappings=await db.googlePerformanceMapping.findMany({where:{kind:'SALE'},include:{product:{select:{displayName:true}}}});
 const costs=await db.productCostRule.findMany({orderBy:{effectiveFrom:'asc'}});
 const allGroups=new Map<string,any>();
 for(const l of lines){const key=`${l.connectionId}:${l.productNo}`;const g=allGroups.get(key)??{connectionId:l.connectionId,productNo:l.productNo,productName:l.productName,rows:0,rows28:0,quantity28:0,mappedRows:0,mapped28:0,ruleIds:new Set<string>(),products:new Set<string>(),from:day(l.orderDate),to:day(l.orderDate),options:new Set<string>()};g.rows++;g.options.add(l.optionName);if(l.productId){g.mappedRows++;g.products.add(l.product?.displayName);if(l.cafe24ProductRuleId)g.ruleIds.add(l.cafe24ProductRuleId);}if(day(l.orderDate)==='2026-10-28'){g.rows28++;g.quantity28+=l.quantity.toNumber();if(l.productId)g.mapped28++;}if(day(l.orderDate)!&&day(l.orderDate)!<g.from)g.from=day(l.orderDate);if(day(l.orderDate)!&&day(l.orderDate)!>g.to)g.to=day(l.orderDate);allGroups.set(key,g);}
 const meta=await new SalesMetricsService(db).productPerformance({from:'2026-10-28',to:'2026-10-28'});
 const google=await new GoogleReadService(db).report({from:'2026-10-28',to:'2026-10-28',pageSize:100},'profit');
 const safeLines=lines.map(({id,orderDate,productNo,productName,optionName,optionValue,quantity,salePriceKrw,totalPaidKrw,productId,cafe24ProductRuleId,matchSource,validationStatus,source,connectionId,uploadBatchId})=>({id,orderDate,productNo,productName,optionName,optionValue,quantity,salePriceKrw,totalPaidKrw,productId,cafe24ProductRuleId,matchSource,validationStatus,source,connectionId,uploadBatchId}));
 const report={groups:[...allGroups.values()].map(({ruleIds,products,options,...g})=>({...g,ruleIds:[...ruleIds],products:[...products],optionCount:options.size})).sort((a,b)=>Number(a.productNo)-Number(b.productNo)),rules,googleMappings,costs,lines:safeLines,meta,google,financialHash:hash(safeLines.map(({id,quantity,salePriceKrw,totalPaidKrw})=>({id,quantity,salePriceKrw,totalPaidKrw})))};
 if(!existsSync(evidence))writeFileSync(evidence,JSON.stringify(report,null,2));
 console.log(JSON.stringify({evidence,groups:report.groups,rules:rules.filter(r=>report.groups.some(g=>g.ruleIds.includes(r.id))).map(r=>({id:r.id,displayName:r.displayName,productId:r.productId,productNumbers:r.productNumbers,excludes:r.productNameExcludeKeywords,overrides:[r.salePriceKrwOverride,r.productCostKrwOverride,r.shippingKrwOverride,r.extraCostKrwOverride]})),googleMappings,meta:meta.rows.map(r=>({name:r.product?.displayName,quantity:r.quantity,revenue:r.revenueKrw,grossCost:r.grossCostKrw,coupon:r.couponDeductionKrw,ads:r.adSpendKrw,margin:r.marginKrw})),google:{summary:google.summary,products:google.products}},null,2));
}
main().catch(e=>{console.error(JSON.stringify({error:/^[A-Z_]+$/.test(e.message)?e.message:e.code??'YOUTUBE_AUDIT_FAILED'}));process.exitCode=1;}).finally(close);
