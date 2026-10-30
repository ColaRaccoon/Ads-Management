import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {normalizeProductName,resolveProductName} from '../apps/api/src/unified-performance/domain/product-name-resolver.ts';
const dir='docs/product-performance/research/',original=JSON.parse(readFileSync(dir+'11-products-plan.json','utf8'));
const inventory=JSON.parse(readFileSync(dir+'11-products-raw-names.json','utf8')).rows.inventory;
const native=JSON.parse(readFileSync(dir+'11-products-catalog.json','utf8')).rows.inventory;
const products=inventory.products,catalog=products.map(p=>({canonicalName:p.canonicalName,active:p.active}));
const baseline=original.baselineRules.filter(r=>r.kind==='NAME').map(r=>({...r.payload,id:r.id,canonicalProductName:products.find(p=>p.id===r.productId).canonicalName,active:true,platform:r.platform,scopeKey:r.scopeKey,validFrom:r.validFrom,validTo:r.validTo}));
const rules=new Map(),decisions=[];
for(const row of inventory.names){
 const input={originalName:row.source_name,platform:row.platform,scopeKey:'NATIVE_NAME_REVIEW',businessDate:'2026-10-28',nameField:'collected_name'};
 const before=resolveProductName(input,catalog,baseline,'BEFORE');
 if(before.matchStatus==='MATCHED'){decisions.push({...row,decision:'EXISTING_MATCH',canonicalName:before.canonicalProductName});continue;}
 const text=normalizeProductName(row.source_name??'');let candidates=[];
 for(const p of products){const term=p.canonicalName;if(text.includes(normalizeProductName(term)))candidates.push({canonicalName:p.canonicalName,term});}
 if(row.platform==='META')for(const r of native.metaNameRules.filter(r=>r.is_active&&r.match_type==='CONTAINS')){
  const sourceProduct=native.catalog.find(p=>p.platform==='META_CAFE24'&&p.source_ref===r.source_product&&p.active);
  if(sourceProduct&&text.includes(normalizeProductName(r.pattern)))candidates.push({canonicalName:sourceProduct.display_name,term:r.pattern});
 }
 candidates=candidates.filter((c,i,all)=>!all.some((other,j)=>i!==j&&other.canonicalName!==c.canonicalName&&normalizeProductName(other.term).includes(normalizeProductName(c.term))));
 const names=[...new Set(candidates.map(c=>c.canonicalName))];
 if(names.length!==1){decisions.push({...row,decision:names.length?'AMBIGUOUS_KEEP_UNCLASSIFIED':'NO_LITERAL_NAME_KEEP_UNCLASSIFIED',candidates:names});continue;}
 for(const c of candidates){const key=JSON.stringify([row.platform,c.canonicalName,normalizeProductName(c.term)]);if(rules.has(key))continue;
  const excludeTerms=[...new Set([...products.filter(p=>p.canonicalName!==c.canonicalName&&normalizeProductName(p.canonicalName).includes(normalizeProductName(c.term))).map(p=>p.canonicalName),...baseline.flatMap(r=>r.terms)])].filter(t=>!normalizeProductName(c.term).includes(normalizeProductName(t)));
  rules.set(key,{kind:'NAME',canonicalName:c.canonicalName,platform:row.platform,scopeKey:null,validFrom:original.from,validTo:null,active:true,payload:{matchType:'CONTAINS',terms:[c.term],excludeTerms,optionExact:null,optionInclude:[],optionExclude:[],nameField:null,saleUnitName:null}});
 }
 decisions.push({...row,decision:'LITERAL_NAME_IN_TITLE',canonicalName:names[0]});
}
const nameRules=[...rules.values()],domain=[...baseline,...nameRules.map((r,i)=>({...r,...r.payload,id:'planned-'+i,canonicalProductName:r.canonicalName}))];
let unchanged=0,matched=0,ambiguous=0;
for(const d of decisions){const actual=resolveProductName({originalName:d.source_name,platform:d.platform,scopeKey:'NATIVE_NAME_REVIEW',businessDate:'2026-10-28',nameField:'collected_name'},catalog,domain,'PLANNED');
 if(d.decision==='EXISTING_MATCH'){assert.equal(actual.canonicalProductName,d.canonicalName);assert.equal(actual.matchStatus,'MATCHED');unchanged++;}
 if(d.decision==='LITERAL_NAME_IN_TITLE'){assert.equal(actual.canonicalProductName,d.canonicalName);assert.equal(actual.matchStatus,'MATCHED');matched++;}
 if(actual.matchStatus==='AMBIGUOUS')ambiguous++;
 d.plannedStatus=actual.matchStatus;
}
assert(nameRules.every(r=>['META','GOOGLE','CAFE24'].includes(r.platform)));assert(nameRules.length<400);
const plan={...original,kind:'NATIVE_PRODUCT_TITLE_NAMES_ALL_HISTORY',baselineProducts:products,nameRules,rawNameDecisions:decisions,review:{existingMatchesPreserved:unchanged,newLiteralTitleNames:matched,ambiguousKept:ambiguous,naverOrCoupangRuleChanges:0},policy:'Only observed literal canonical names in META/GOOGLE/CAFE24 titles, plus preexisting approved META aliases. More specific existing names excluded from broader patterns. No new Naver/Coupang aliases; no costs or units changed.'};
const raw=JSON.stringify(plan,null,2)+'\n';writeFileSync(dir+'11-products-names-plan.json',raw);console.log(JSON.stringify({rules:nameRules.length,byPlatform:nameRules.reduce((a,r)=>(a[r.platform]=(a[r.platform]||0)+1,a),{}),...plan.review,rawNames:decisions.length,sha256:createHash('sha256').update(raw).digest('hex')}));
