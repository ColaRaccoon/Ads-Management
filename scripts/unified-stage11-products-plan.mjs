import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeProductName} from '../apps/api/src/unified-performance/domain/product-name-resolver.ts';
import {coupangProductIdentity} from '../apps/api/src/unified-performance/adapters/coupang-configuration.ts';
const dir='docs/product-performance/research/',catalog=JSON.parse(readFileSync(dir+'11-products-catalog.json','utf8')),days=JSON.parse(readFileSync(dir+'11-products-source-days.json','utf8'));
assert.equal(catalog.projectRef,'iygjmosbelbosfxidqxv');assert.equal(days.projectRef,catalog.projectRef);assert.equal(catalog.remoteWrites,0);assert.equal(days.remoteWrites,0);
const source=catalog.rows.inventory,names=new Map(),excludedNative=[];
const established={'버닝웨이브':'버닝웨이브바','두줄보호대':'두줄무릎보호대','버닝슬라이드':'버닝 슬라이드'};
for(const p of source.catalog.filter(p=>p.platform==='META_CAFE24'&&p.active))names.set(normalizeProductName(p.display_name),{canonicalName:p.display_name,origins:['META_CAFE24']});
for(const p of source.catalog.filter(p=>p.platform==='COUPANG'&&p.active)){
 const name=coupangProductIdentity(p.original_name).productName,key=normalizeProductName(name),old=names.get(key);
 if(established[name]&&names.has(normalizeProductName(established[name]))&&normalizeProductName(established[name])!==key){excludedNative.push({platform:'COUPANG',sourceName:name,reason:'Different name; registering it would shadow an existing approved Naver alias',existingCanonical:established[name]});continue;}
 if(old){if(!old.origins.includes('COUPANG'))old.origins.push('COUPANG');}else names.set(key,{canonicalName:name,origins:['COUPANG']});
}
for(const p of source.unifiedProducts){assert(names.has(normalizeProductName(p.canonicalName)));names.get(normalizeProductName(p.canonicalName)).existingId=p.id;}
const naver=source.catalog.filter(p=>p.platform==='NAVER_UNIT'&&p.active).map(p=>{
 const own=names.get(normalizeProductName(p.display_name)),parent=p.parent_name&&names.get(normalizeProductName(p.parent_name)),known=names.get(normalizeProductName(established[p.parent_name||p.display_name]||''));
 return {sourceName:p.display_name,parentName:p.parent_name,scopeKey:p.scope_key,decision:own?'EXACT_NAME':parent?'EXISTING_PARENT_NAME':known?'PREEXISTING_APPROVED_ALIAS':'EXCLUDED_DIFFERENT_NAME',canonicalName:(own||parent||known)?.canonicalName??null};
});
const scopes={META:['2155a401-bd86-4111-9280-3c95ed207546','LEGACY_UNBOUND'],GOOGLE:['21b811a6-b9d7-44f5-8167-ce40198947b5'],CAFE24:['be140e7e-3994-406e-94ff-b50dfc7ac7b2','LEGACY_UNBOUND'],COUPANG:['LEGACY_COUPANG_SINGLE_UPLOAD'],NAVER:['5ba1d3cf-7aee-4cd1-aecd-d44352f665dd','78f8cb08-ffe3-481a-94d7-be87ae93ed79']};
const parts=new Map();
function add(platform,scopeKey,date){assert(scopes[platform]?.includes(scopeKey));assert(/^2026-\d\d-\d\d$/.test(date));assert.equal(new Date(date+'T00:00:00Z').toISOString().slice(0,10),date);assert(date<='2026-10-29');parts.set([platform,scopeKey,date].join('/'),{platform,scopeKey,date});}
for(const p of days.rows.inventory.days)add(p.platform,p.scope_key,p.business_date);
for(const p of source.publicationDays)add(p.platform,p.scopeKey,p.date);
const partitions=[...parts.values()].sort((a,b)=>a.platform.localeCompare(b.platform)||a.scopeKey.localeCompare(b.scopeKey)||a.date.localeCompare(b.date)),ranges=[];
for(const p of partitions){const old=ranges.at(-1);if(old&&old.platform===p.platform&&old.scopeKey===p.scopeKey&&old.days<31&&Date.parse(p.date)-Date.parse(old.to)===86400000){old.to=p.date;old.days++;}else ranges.push({...p,from:p.date,to:p.date,days:1});}
const plan={kind:'EXACT_NATIVE_PRODUCTS_ALL_HISTORY',stage:11,from:partitions.map(p=>p.date).sort()[0],to:'2026-10-29',baselineProducts:source.unifiedProducts,baselineRules:source.unifiedRules,
 products:[...names.values()].sort((a,b)=>a.canonicalName.localeCompare(b.canonicalName)),excludedNative,naverDecisions:naver,partitions,ranges,
 policy:'Register existing Meta/Cafe24 and Coupang native canonical names; exact names only across platforms. Preserve native units and prior approved aliases; do not infer new Naver aliases, strip pack counts, copy costs or mutate sources.'};
assert(plan.products.length<200);assert(plan.partitions.length<1500);
const raw=JSON.stringify(plan,null,2)+'\n';writeFileSync(dir+'11-products-plan.json',raw);console.log(JSON.stringify({products:plan.products.length,newProducts:plan.products.filter(p=>!p.existingId).length,partitions:partitions.length,ranges:ranges.length,from:plan.from,naverExcluded:naver.filter(n=>n.decision==='EXCLUDED_DIFFERENT_NAME').length,sha256:createHash('sha256').update(raw).digest('hex')}));
