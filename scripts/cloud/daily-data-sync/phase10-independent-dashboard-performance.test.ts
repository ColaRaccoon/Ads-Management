import 'reflect-metadata';
import assert from 'node:assert/strict';
import {test,before} from 'node:test';
import {pathToFileURL} from 'node:url';
import {Prisma} from '@prisma/client';
import {DashboardMetricsService} from '../../../apps/api/src/metrics/dashboard-metrics.service';
import {MetaAdsetMetricDecorationService} from '../../../apps/api/src/metrics/meta-adset-metric-decoration.service';
const base='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261019-v4/apps/api/src/metrics/';
let OldDash:any,OldDecor:any;
before(async()=>{const OldDashboard=await import(pathToFileURL(base+'dashboard-metrics.service.ts').href),OldDecoration=await import(pathToFileURL(base+'meta-adset-metric-decoration.service.ts').href);OldDash=OldDashboard.DashboardMetricsService??OldDashboard.default?.DashboardMetricsService;OldDecor=OldDecoration.MetaAdsetMetricDecorationService??OldDecoration.default?.MetaAdsetMetricDecorationService;});
const D=Prisma.Decimal,date=(s:string)=>new Date(`${s}T00:00:00.000Z`);
function fixture(){
 const calls:Record<string,number>={};const called=(key:string)=>calls[key]=(calls[key]??0)+1;
 const rows=['2026-09-27','2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-04'].map((day,i)=>({
  id:`metric-${i}`,source:'CSV',connectionId:null,metricDate:date(day),productId:'p',product:{id:'p',displayName:'Synthetic'},metaAdsetId:'a',metaAdset:{id:'a'},
  spendUsd:new D(i+1),resultCount:i+2,purchaseCount:null,impressions:100n,reach:70,linkClicks:2,clicksAll:3,landingPageViews:1,shopClicks:0,
  actionReportTime:'impression',attributionWindows:['7d_click'],attributionSetting:null,deliveryStatus:'ACTIVE',adsetName:'Synthetic',stage:'UNKNOWN'
 }));
 const costs=[['old','2026-09-01',1000,1300],['new','2026-10-01',2000,1400]].map(([id,day,price,fx])=>({id,productId:'p',effectiveFrom:date(String(day)),effectiveTo:null,createdAt:date(String(day)),salePriceKrw:new D(price),fxRateKrwPerUsd:new D(fx),vatKrw:new D(0),productCostKrw:new D(100),shippingKrw:new D(10),extraCostKrw:new D(5)}));
 const cpa=[{id:'cpa',productId:'p',effectiveFrom:date('2026-01-01'),effectiveTo:null,createdAt:date('2026-01-01'),targetRatio:new D('0.1'),watchRatio:new D('0.2'),stopRatio:new D('0.3')}];
 const rates=[{rateDate:date('2026-10-02'),rate:new D(1450)}];
 const client:any={metaAdsetDailyMetric:{findMany:async({where}:any)=>{called('metrics');return rows.filter(r=>r.metricDate>=where.metricDate.gte&&r.metricDate<=where.metricDate.lte);}},
  metaAdDailyMetric:{findMany:async()=>{called('adPurchases');return[];}},
  productCostRule:{findMany:async()=>{called('costRules');return costs;}},productCpaRule:{findMany:async()=>{called('cpaRules');return cpa;}},
  exchangeRate:{findMany:async({where}:any)=>{called('fx');return rates.filter(r=>where.rateDate.in.some((d:Date)=>+d===+r.rateDate));}},
  uploadRowError:{count:async()=>0},decisionLog:{findMany:async()=>[]}};
 return{client,calls};
}
for(const [from,to]of [['2026-10-01','2026-10-01'],['2026-09-30','2026-10-01'],['2026-09-30','2026-10-02'],['2026-09-28','2026-10-04'],['2026-10-03','2026-10-03'],['2026-10-05','2026-10-07']])test(`independent dashboard all output equals frozen v4 for ${from}..${to}`,async()=>{
 const previous=process.env.DAILY_SYNC_FEATURE_ENABLED;process.env.DAILY_SYNC_FEATURE_ENABLED='false';
 try{const old=fixture(),current=fixture();const expected=await new OldDash(old.client,new OldDecor(old.client)).dashboardSummary(from,to);const actual=await new DashboardMetricsService(current.client,new MetaAdsetMetricDecorationService(current.client)).dashboardSummary(from,to);assert.deepEqual(actual,expected);assert.equal(old.calls.metrics,5);assert.equal(current.calls.metrics,2);assert((current.calls.costRules??0)<=(old.calls.costRules??0));
 if(from==='2026-10-01'&&to===from){assert.equal(actual.totals.spendKrw,5*1400);assert.equal(actual.totals.revenueKrw,6*2000);}
 }finally{previous===undefined?delete process.env.DAILY_SYNC_FEATURE_ENABLED:process.env.DAILY_SYNC_FEATURE_ENABLED=previous;}
});
test('independent empty decorator performs no database call',async()=>{
 const client=new Proxy({},{get(){throw Error('EMPTY_INPUT_MUST_NOT_QUERY');}});assert.deepEqual(await new MetaAdsetMetricDecorationService(client as any).decorate([]),[]);
});
