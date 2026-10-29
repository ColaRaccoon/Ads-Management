import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {productionCafe24Db} from './cafe24-production-context';
import {SalesMetricsService} from '../apps/api/src/sales/sales-metrics.service';
import {GoogleReadService} from '../apps/api/src/google/google-read.service';
const {db,close}=productionCafe24Db();
const productId='3abc89d6-49f7-4848-9341-ae6ccfe988e4',date=new Date('2026-10-28Z');
async function main(){
 const phase=process.argv.includes('--after')?'after':'before';
 const sets=await db.metaAdsetDailyMetric.findMany({where:{isCurrent:true,metricDate:date,adsetName:{contains:'케겔'}},orderBy:{id:'asc'}});
 const ads=await db.metaAdDailyMetric.findMany({where:{isCurrent:true,metricDate:date,adsetNameSnapshot:{contains:'케겔'}},orderBy:{id:'asc'}});
 const sales=await new SalesMetricsService(db).productPerformance({from:'2026-10-28',to:'2026-10-28'});
 const google=await new GoogleReadService(db).report({from:'2026-10-28',to:'2026-10-28',pageSize:100},'profit');
 const rules=await db.productMatchRule.findMany({where:{productId},select:{id:true,matchType:true,pattern:true,isActive:true,validFrom:true,validTo:true}});
 const audits=rules.length?await db.securityAuditEvent.findMany({where:{targetId:{in:rules.map(r=>r.id)}},orderBy:{createdAt:'asc'},select:{action:true,result:true}}):[];
 const report={phase,day:'2026-10-28',rules,adsets:sets.map(r=>({name:r.adsetName,productId:r.productId,source:r.productMatchSource,spendUsd:r.spendUsd})),ads:ads.map(r=>({name:r.adNameSnapshot,productId:r.productId,source:r.productMatchSource,spendUsd:r.spendUsd})),metaMargin:sales.rows.find(r=>r.productId===productId),google:{complete:google.summary.complete,marginKrw:google.summary.marginKrw},audits};
 const file=join(tmpdir(),`kegel-meta-margin-${phase}-20261029.json`);
 if(phase==='after'){
  const before=JSON.parse(readFileSync(join(tmpdir(),'kegel-meta-margin-before-20261029.json'),'utf8'));
  // Prisma changes updatedAt on a mapping edit. Compare the captured financial
  // inputs directly rather than treating that bookkeeping timestamp as money.
  const money=(items:any[])=>items.map(({name,spendUsd})=>({name,spendUsd}));
  if(JSON.stringify(money(report.adsets))!==JSON.stringify(money(before.adsets))||
    JSON.stringify(money(report.ads))!==JSON.stringify(money(before.ads)))throw Error('ORIGINAL_AD_SPEND_CHANGED');
  if(report.metaMargin?.revenueKrw!==before.metaMargin?.revenueKrw||
    report.metaMargin?.grossCostKrw!==before.metaMargin?.grossCostKrw)throw Error('SALES_OR_COST_INPUT_CHANGED');
  if(report.google.marginKrw!==before.google.marginKrw)throw Error('GOOGLE_MARGIN_CHANGED');
  if(!sets.length||!ads.length||[...sets,...ads].some(r=>r.productId!==productId))throw Error('KEGEL_AD_MAPPING_INCOMPLETE');
  if(!report.metaMargin||report.metaMargin.adSpendUsd<=0||report.metaMargin.marginKrw===null)throw Error('KEGEL_MARGIN_NOT_UPDATED');
 }
 writeFileSync(file,JSON.stringify(report,null,2));
 console.log(JSON.stringify({...report,evidencePath:file}));
}
main().catch(e=>{console.error(JSON.stringify({error:/^[A-Z_]+$/.test(e.message)?e.message:e.code??'KEGEL_VERIFY_FAILED'}));process.exitCode=1;}).finally(close);
