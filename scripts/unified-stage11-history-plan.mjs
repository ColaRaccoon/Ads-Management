import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';

assert(process.argv.slice(2).every(x=>x==='--incremental'));
const incremental=process.argv.includes('--incremental');
const sourceFile=`docs/product-performance/research/11-all-history-inventory${incremental?'-latest':''}.json`;
const contents=readFileSync(sourceFile,'utf8'),source=JSON.parse(contents);
assert.equal(source.projectRef,'iygjmosbelbosfxidqxv');assert.equal(source.remoteWrites,0);
const inventory=source.rows.history;
const scopes={META:['2155a401-bd86-4111-9280-3c95ed207546','LEGACY_UNBOUND'],GOOGLE:['21b811a6-b9d7-44f5-8167-ce40198947b5'],CAFE24:['be140e7e-3994-406e-94ff-b50dfc7ac7b2','LEGACY_UNBOUND'],COUPANG:['LEGACY_COUPANG_SINGLE_UPLOAD'],NAVER:['5ba1d3cf-7aee-4cd1-aecd-d44352f665dd','78f8cb08-ffe3-481a-94d7-be87ae93ed79']};
const partitions=new Map(),targetDates=[];
function add(platform,scopeKey,date,target=false){
 assert(scopes[platform]?.includes(scopeKey));assert(/^20\d\d-\d\d-\d\d$/.test(date));assert.equal(new Date(date+'T00:00:00Z').toISOString().slice(0,10),date);assert(date<='2026-10-29');
 const key=[platform,scopeKey,date].join('/');partitions.set(key,{platform,scopeKey,date});if(target)targetDates.push(date);
}
for(const day of inventory.sourceDays)if(day.named_rows>0||day.legacy_assigned_rows>0)add(day.platform,day.scope_key,day.business_date,true);
// Refresh already published pointers to avoid leaving earlier report configurations stale.
for(const day of inventory.publishedPartitions)add(day.platform,day.scopeKey,day.date);
assert(targetDates.length>0);const from=targetDates.sort()[0];
const name=inventory.unifiedRules.find(rule=>rule.kind==='NAME'),unit=inventory.unifiedRules.find(rule=>rule.kind==='SALE_UNIT');
assert.equal(inventory.unifiedRules.length,2);assert.equal(name.version,incremental?3:2);assert.equal(unit.version,1);
assert.equal(name.productId,'db50b04e-db3c-4d7f-9f01-9c3dba83c28f');assert.equal(name.payload.terms.join(','),'풀업바');
assert(inventory.productNames.every(n=>!n.legacy_assigned_rows||n.original_name.includes('풀업바')),'Legacy product assignments require explicit alias review');
if(incremental){const before=JSON.parse(readFileSync('docs/product-performance/research/11-all-history-plan.json','utf8'));
 assert.equal(from,before.proposedNameRule.validFrom,'An earlier source requires a separately reviewed full configuration rebuild');
 for(const old of before.partitions)partitions.delete([old.platform,old.scopeKey,old.date].join('/'));}
const ordered=[...partitions.values()].sort((a,b)=>a.platform.localeCompare(b.platform)||a.scopeKey.localeCompare(b.scopeKey)||a.date.localeCompare(b.date));
const ranges=[];
for(const part of ordered){const last=ranges.at(-1);if(last&&last.platform===part.platform&&last.scopeKey===part.scopeKey&&last.days<31&&Date.parse(part.date)-Date.parse(last.to)===86400000){last.to=part.date;last.days++;}else ranges.push({...part,from:part.date,to:part.date,days:1});}
const plan={stage:11,kind:'ALL_STORED_PULLUP_HISTORY',sourceInventorySha256:createHash('sha256').update(contents).digest('hex'),canonicalProduct:'풀업바',
 baselineRules:{name,unit},proposedNameRule:{kind:'NAME',productId:name.productId,platform:null,scopeKey:null,validFrom:from,validTo:null,active:true,
 payload:{matchType:'CONTAINS',terms:['풀업바'],excludeTerms:[],optionInclude:[],optionExclude:[],nameField:null,saleUnitName:null}},
 sourceWrites:0,legacyCostRulesUnchanged:true,partitions:ordered,ranges,samples:inventory.productNames.slice(0,90).map(n=>({originalName:n.original_name,platform:n.platform,
 scopeKey:scopes[n.platform][0],businessDate:from,nameField:n.platform==='META'?'adset_name':n.platform==='GOOGLE'?'campaign_name':'product_name'}))};
const encoded=JSON.stringify(plan,null,2)+'\n';writeFileSync(`docs/product-performance/research/11-all-history-plan${incremental?'-latest':''}.json`,encoded);
console.log(JSON.stringify({status:'READY',planSha256:createHash('sha256').update(encoded).digest('hex'),from,partitions:ordered.length,requests:ranges.length,
 byPlatform:Object.fromEntries(Object.keys(scopes).map(p=>[p,ordered.filter(x=>x.platform===p).length]))}));
