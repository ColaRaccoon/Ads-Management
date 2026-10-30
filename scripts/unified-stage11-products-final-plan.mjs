import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const dir='docs/product-performance/research/',plan=JSON.parse(readFileSync(dir+'11-products-names-plan.json','utf8'));
const gifts=plan.rawNameDecisions.filter(row=>row.decision==='AMBIGUOUS_KEEP_UNCLASSIFIED');assert.equal(gifts.length,2);
for(const row of gifts){
 assert.equal(row.platform,'CAFE24');assert(row.source_name.startsWith('[인피니티 러닝조끼]'));assert(row.source_name.replace(/\s/g,'').includes('러닝양말무료증정'));
 row.decision='EXACT_PRIMARY_TITLE_WITH_FREE_GIFT';row.canonicalName='러닝조끼';row.plannedStatus='MATCHED';
}
plan.nameRules.push({kind:'NAME',canonicalName:'러닝조끼',platform:'CAFE24',scopeKey:null,validFrom:plan.from,validTo:null,active:true,payload:{matchType:'EXACT',terms:gifts.map(row=>row.source_name),excludeTerms:[],optionExact:null,optionInclude:[],optionExclude:[],nameField:'product_name',saleUnitName:null}});
plan.titleRevision=2;plan.review.newExactPrimaryTitles=2;plan.review.primaryTitleBasis='Both exact observed Cafe24 titles explicitly name [인피니티 러닝조끼] as the main product and 러닝양말 as a free gift; no generic mixed-title inference.';
const raw=JSON.stringify(plan,null,2)+'\n';writeFileSync(dir+'11-products-final-plan.json',raw);console.log(JSON.stringify({rules:plan.nameRules.length,sha256:createHash('sha256').update(raw).digest('hex')}));
