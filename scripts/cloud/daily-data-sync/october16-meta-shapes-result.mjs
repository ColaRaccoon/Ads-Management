// Root-only offline aggregate over the separately encrypted October16 capture.
import {runMetaDiagnostic,safeMetaDiagnosticFailure} from './october16-meta-failed-day09-diagnostic.mjs';
import {META_MCP_PURCHASE_NAMES} from '../../../apps/api/src/daily-sync/meta-mcp-wire-reader.ts';
import {Prisma} from '@prisma/client';
const levels=['ad','adset','campaign','ad_account'];
const fields=['impressions','clicks','reach','frequency','link_click',...META_MCP_PURCHASE_NAMES];
const numeric=v=>{
 if(v===null)return null;
 if(v&&typeof v==='object'&&!Array.isArray(v)){if(Object.keys(v).sort().join()!=='unit,value'||v.unit!=='USD')throw Error('SCALAR');v=v.value;}
 if(typeof v!=='string'||!/^(0|[1-9]\d{0,18})(\.\d{1,6})?$/.test(v))throw Error('SCALAR');
 return new Prisma.Decimal(v);
};
function classify(capture){
 if(capture.day!=='2026-10-09'||capture.accountId!=='2138525300002203')throw Error('SCOPE');
 const result={stage:'OFFLINE_ROW_SHAPES',levels:{},knownTotalsConserved:{},providerRequests:0,databaseWrites:0,rawValuesReturned:0};
 const account=capture.levels.ad_account[0];
 const explicitZero=v=>{const n=numeric(v);return n!==null&&n.isZero();};
 const fullNullSets=capture.levels.adset.filter(row=>explicitZero(row.amount_spent)&&fields.every(f=>row[f]===null));
 const nullSetIds=new Set(fullNullSets.map(row=>row.id));
 const children=capture.levels.ad.filter(row=>nullSetIds.has(row.adset_id));
 const basicZero=row=>['amount_spent','impressions','clicks','reach','frequency'].every(f=>explicitZero(row[f]));
 const pairBad=row=>[['omni_purchase','omni_purchase_values'],['offsite_conversion_fb_pixel_purchase','offsite_conversion_fb_pixel_purchase_values']].some(([a,b])=>(row[a]===null)!==(row[b]===null));
 const positive=row=>fields.some(f=>{const n=numeric(row[f]);return n!==null&&n.gt(0);});
 const eligible=row=>basicZero(row)&&!pairBad(row)&&!positive(row);
 const eligibleChildren=children.filter(eligible);const eligibleSetIds=new Set(fullNullSets.filter(parent=>capture.levels.ad.some(row=>row.adset_id===parent.id)&&capture.levels.ad.filter(row=>row.adset_id===parent.id).every(eligible)).map(row=>row.id));
 result.membershipCandidate={fullNullSets:fullNullSets.length,totalChildren:children.length,childrenBasicNotExplicitZero:children.filter(row=>!basicZero(row)).length,childrenKnownPositiveLink:children.filter(row=>{const n=numeric(row.link_click);return n!==null&&n.gt(0);}).length,childrenPurchaseUnpaired:children.filter(pairBad).length,childrenAnyKnownPositive:children.filter(positive).length,eligibleChildren:eligibleChildren.length,parentsWithOnlyEligibleChildren:eligibleSetIds.size,remainingNullParents:fullNullSets.length-eligibleSetIds.size,allStrictZeroAds:capture.levels.ad.filter(eligible).length,zeroSpendPositiveRowsRetained:capture.levels.ad.filter(row=>explicitZero(row.amount_spent)&&positive(row)).every(row=>!eligible(row))};
 for(const level of levels){
  const rows=capture.levels[level];const nulls=Object.fromEntries(fields.map(f=>[f,0]));let zeroMoneyCoreNull=0,zeroMoneyAllMetricsNull=0,zeroMoneyAnyKnownPositive=0;
  for(const row of rows){for(const f of fields)if(row[f]===null)nulls[f]++;
   const moneyZero=numeric(row.amount_spent).isZero();
   if(moneyZero&&['impressions','clicks','reach','frequency','link_click'].every(f=>row[f]===null))zeroMoneyCoreNull++;
   if(moneyZero&&fields.every(f=>row[f]===null))zeroMoneyAllMetricsNull++;
   if(moneyZero&&fields.some(f=>{const n=numeric(row[f]);return n!==null&&n.gt(0);}))zeroMoneyAnyKnownPositive++;
  }
  result.levels[level]={rows:rows.length,nulls,zeroMoneyCoreNull,zeroMoneyAllMetricsNull,zeroMoneyAnyKnownPositive};
  const totals={};
  for(const f of ['amount_spent','impressions','clicks','link_click',...META_MCP_PURCHASE_NAMES]){
   const observed=numeric(account[f]);const known=rows.reduce((sum,row)=>{const n=numeric(row[f]);return n===null?sum:sum.plus(n);},new Prisma.Decimal(0));
   totals[f]={accountObserved:observed!==null,knownSumEqualsAccount:observed!==null&&known.eq(observed)};
  }
  result.knownTotalsConserved[level]=totals;
 }
 return result;
}
let raw='',input,out;const hard=setTimeout(()=>process.exit(1),60000);
try{for await(const p of process.stdin){raw+=p;if(Buffer.byteLength(raw)>1048576)throw Error('BOUND');}input=JSON.parse(raw);raw='';if(input.mode!=='offline')throw Error('SCOPE');
 out=await runMetaDiagnostic(input,{offlineClassifier:classify,request:async()=>{throw Error('PROVIDER_FORBIDDEN');},factory:()=>{throw Error('DATABASE_FORBIDDEN');}});
 if(out.providerRequests?.graphGet!==0||out.providerRequests?.mcpPost!==0)throw Error('BOUNDARY');out.providerRequests=0;
}catch(e){out=safeMetaDiagnosticFailure(e);}finally{raw='';input=undefined;}
await new Promise(resolve=>process.stdout.write(JSON.stringify(out),resolve));clearTimeout(hard);process.exit(0);
