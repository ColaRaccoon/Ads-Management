import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolveProductName} from '../apps/api/src/unified-performance/domain/product-name-resolver.ts';
const dir='docs/product-performance/research/',plan=JSON.parse(readFileSync(dir+'11-products-final-plan.json','utf8'));
const native=JSON.parse(readFileSync(dir+'11-products-catalog.json','utf8')).rows.inventory;
const catalog=plan.products.map(p=>({canonicalName:p.canonicalName,active:true}));
const before=plan.baselineRules.filter(r=>r.kind==='NAME').map(r=>({...r.payload,id:r.id,canonicalProductName:plan.baselineProducts.find(p=>p.id===r.productId).canonicalName,platform:r.platform,scopeKey:r.scopeKey,validFrom:r.validFrom,validTo:r.validTo,active:true}));
const after=[...before,...plan.nameRules.map((r,i)=>({...r,...r.payload,id:'review-'+i,canonicalProductName:r.canonicalName}))];
let exactChecks=0,nativeChecks=0,titleChecks=0;
for(const p of catalog)for(const platform of ['META','GOOGLE','CAFE24','COUPANG','NAVER']){
 const result=resolveProductName({originalName:p.canonicalName,platform,scopeKey:'REVIEW',businessDate:plan.to,nameField:'collected_name'},catalog,after,'REVIEW');assert.equal(result.matchStatus,'MATCHED');assert.equal(result.canonicalProductName,p.canonicalName);exactChecks++;
}
for(const p of native.catalog.filter(p=>['COUPANG','NAVER_UNIT'].includes(p.platform)&&p.active))for(const businessDate of [plan.from,plan.to]){
 const input={originalName:p.original_name,platform:p.platform==='COUPANG'?'COUPANG':'NAVER',scopeKey:p.scope_key??'REVIEW',businessDate,nameField:'collected_name'};
 const a=resolveProductName(input,catalog,before,'BEFORE'),b=resolveProductName(input,catalog,after,'AFTER');assert.equal(a.matchStatus,b.matchStatus);assert.equal(a.canonicalProductName,b.canonicalProductName);nativeChecks++;
}
for(const d of plan.rawNameDecisions)for(const businessDate of [d.first_date,d.last_date]){
 const input={originalName:d.source_name,platform:d.platform,scopeKey:'REVIEW',businessDate,nameField:d.platform==='CAFE24'?'product_name':d.platform==='META'?'adset_name':'campaign_name'},actual=resolveProductName(input,catalog,after,'REVIEW');
 if(['LITERAL_NAME_IN_TITLE','EXACT_PRIMARY_TITLE_WITH_FREE_GIFT'].includes(d.decision)){assert.equal(actual.matchStatus,'MATCHED');assert.equal(actual.canonicalProductName,d.canonicalName);}
 if(d.decision==='EXISTING_MATCH'){const old=resolveProductName(input,catalog,before,'BEFORE');assert.equal(actual.matchStatus,old.matchStatus);assert.equal(actual.canonicalProductName,old.canonicalProductName);}
 titleChecks++;
}
const evidence={status:'PASS',exactChecks,unchangedCoupangNaverNameChecks:nativeChecks,actualTitleDateChecks:titleChecks,...plan.review,sourceWrites:0,saleUnitOrCostChanges:0};writeFileSync(dir+'11-products-final-review.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
