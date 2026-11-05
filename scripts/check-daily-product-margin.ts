import "reflect-metadata";
import assert from "node:assert/strict";
import {mkdirSync, writeFileSync} from "node:fs";
import {Prisma} from "@prisma/client";
import {productionCafe24Db} from "./cafe24-production-context";
import {SalesMetricsService} from "../apps/api/src/sales/sales-metrics.service";

// Read the actual product-margin service, with no provider requests or data writes.
process.env.PRISMA_CONNECTION_LIMIT="1";
const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const day=process.argv.find(arg=>arg.startsWith("--day="))?.slice(6)??new Date(Date.parse(today)-86400000).toISOString().slice(0,10);
assert(/^\d{4}-\d{2}-\d{2}$/.test(day)&&new Date(day+"T00:00:00Z").toISOString().slice(0,10)===day&&day<today,"DAY_SCOPE");
const {db,close}=productionCafe24Db();
async function main(){
 const result=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  const date=new Date(day+"T00:00:00Z");
  const salesWhere={connectionId:"be140e7e-3994-406e-94ff-b50dfc7ac7b2",orderDate:date,isCurrent:true,source:"API" as const};
  const lines=await tx.cafe24OrderLine.count({where:salesWhere});
  const mappedLines=await tx.cafe24OrderLine.count({where:{...salesWhere,productId:{not:null}}});
  const adsets=await tx.metaAdsetDailyMetric.aggregate({where:{connectionId:"2155a401-bd86-4111-9280-3c95ed207546",metricDate:date,isCurrent:true,source:"API"},_count:true,_sum:{spendUsd:true}});
  const view=await new SalesMetricsService(tx as unknown as typeof db).productPerformance({from:day,to:day});
  const allocated=view.rows.reduce((sum,row)=>sum.plus(row.adSpendUsd),new Prisma.Decimal(0));
  const unmatched=new Prisma.Decimal(view.summary.adUnmatchedSpendUsd);
  const stored=adsets._sum.spendUsd??new Prisma.Decimal(0);
  const selling=view.rows.filter(row=>row.quantity!==0||row.revenueKrw!==0);
  const advertising=view.rows.filter(row=>row.adSpendUsd>0);
  const issues:string[]=[];
  if(view.summary.salesLineCount!==lines)issues.push("SALES_VIEW_LINE_COUNT_MISMATCH");
  if(view.summary.adMetricCount!==adsets._count)issues.push("MARGIN_ADSET_COUNT_MISMATCH");
  // Only accommodates number serialization in the existing display service;
  // this is not the provider's USD 10 reconciliation tolerance.
  if(allocated.plus(unmatched).minus(stored).abs().gt("0.0001"))issues.push("MARGIN_AD_SPEND_MISMATCH");
  if(mappedLines>0&&selling.length===0)issues.push("MARGIN_SALES_NOT_VISIBLE");
  if(stored.gt(0)&&advertising.length===0)issues.push("MARGIN_AD_SPEND_NOT_VISIBLE");
  if(view.summary.missingExchangeRateDates.length||advertising.some(row=>row.adSpendKrw===null))issues.push("MARGIN_EXCHANGE_RATE_MISSING");
  if(unmatched.gt(0))issues.push("MARGIN_UNALLOCATED_AD_SPEND");
  return {checkedAt:new Date().toISOString(),day,status:issues.length?"ATTENTION":"PASS",issues,
   canonical:{salesLines:lines,mappedSalesLines:mappedLines,adsets:adsets._count,adsetSpendUsd:stored.toFixed(4)},
   productMargin:{salesLines:view.summary.salesLineCount,salesUnmatchedLines:view.summary.salesUnmatchedCount,adsets:view.summary.adMetricCount,
    productsWithSales:selling.length,productsWithAdSpend:advertising.length,
    revenueKrw:view.rows.reduce((n,row)=>n+row.revenueKrw,0),allocatedAdSpendUsd:allocated.toFixed(4),unallocatedAdSpendUsd:unmatched.toFixed(4),
    missingExchangeRateDates:view.summary.missingExchangeRateDates},providerRequests:0,businessWrites:0};
 },{timeout:60000,maxWait:10000});
 const directory=`reports/daily-product-margin/${day}-${new Date().toISOString().replace(/[:.]/g,"-")}`;
 mkdirSync(directory,{recursive:true});writeFileSync(`${directory}/summary.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));if(result.issues.length)process.exitCode=1;
}
main().catch(error=>{console.error(JSON.stringify({status:"FAILED",code:error?.code??error?.getResponse?.()?.code??"PRODUCT_MARGIN_CHECK_FAILED"}));process.exitCode=1;}).finally(close);
