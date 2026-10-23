import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Prisma} from '@prisma/client';
import {aggregateDashboardMetrics,type DashboardMetricRow} from '../../../apps/api/src/metrics/dashboard-decimal-metrics';
const D=Prisma.Decimal;
const row=(spend='1',purchase:number|null=1):DashboardMetricRow=>({metric:{source:'CSV',productId:'p',spendUsd:new D(spend),impressions:1n,linkClicks:1,clicksAll:1,landingPageViews:1,shopClicks:null,attributionSetting:null,actionReportTime:null,attributionWindows:[],metricUnavailableReasons:null} as any,metricDate:'2026-10-14',purchaseCount:purchase,costRule:{salePriceKrw:new D(10),productCostKrw:new D(11),shippingKrw:new D(0),extraCostKrw:new D(0),fxRateKrwPerUsd:new D(2)} as any,cpaRule:{} as any,exchangeRate:null,ruleStatus:'OK'});

test('independent amount availability: partial FX cannot certify a partial KRW sum; known revenue remains its own metric',()=>{
 const known=row('0.1'),missing=row('0.2');missing.costRule!.fxRateKrwPerUsd=new D(0);missing.ruleStatus='MISSING_EXCHANGE_RATE';
 const t=aggregateDashboardMetrics([known,missing]).totals;
 assert.equal(t.spendUsd,'0.3');assert.equal(t.spendKrw,null);assert.equal(t.cpaKrw,null);assert.equal(t.marginKrw,null);assert.equal(t.roas,null);
 assert.equal(t.revenueKrw,'20');assert.equal(t.metricUnavailableReasons.spendKrw,'MISSING_EXCHANGE_RATE');assert.equal(t.ruleStatus,'CRITERIA_MISSING');
});
test('independent unmatched, zero and negative margin preserve unavailable cost instead of inventing positive/zero profit',()=>{
 const unmatched=row('2');unmatched.metric.productId=null;unmatched.costRule=null;unmatched.exchangeRate={rate:new D(2)} as any;unmatched.ruleStatus='UNMATCHED';
 const u=aggregateDashboardMetrics([unmatched]).totals;assert.equal(u.spendKrw,'4');assert.equal(u.revenueKrw,null);assert.equal(u.marginKrw,null);
 const zero=row('0',0);zero.costRule=null;zero.metric.productId=null;const z=aggregateDashboardMetrics([zero]).totals;assert.equal(z.spendKrw,'0');assert.equal(z.revenueKrw,'0');assert.equal(z.marginKrw,null);assert.equal(z.cpaKrw,null);
 const negative=aggregateDashboardMetrics([row('1')]).totals;assert.equal(negative.revenueKrw,'10');assert.equal(negative.marginKrw,'-4');assert.equal(negative.cpaKrw,'2');
});
test('independent BigInt JSON and order invariance preserve all exact count and money digits',()=>{
 const rows=[row('9007199254740993.0001'),row('0.0002'),row('0.1')];rows[0].metric.impressions=9223372036854775807n;rows[1].metric.impressions=9223372036854775807n;
 const a=aggregateDashboardMetrics(rows).totals,b=aggregateDashboardMetrics([...rows].reverse()).totals;
 assert.equal(a.spendUsd,'9007199254740993.1003');assert.equal(a.impressions,'18446744073709551615');
 for(const k of ['spendUsd','spendKrw','revenueKrw','marginKrw','impressions'] as const)assert.equal(a[k],b[k]);
 assert.equal(JSON.parse(JSON.stringify(a)).impressions,'18446744073709551615');
});
test('independent empty and mixed attribution totals do not become collection-completeness evidence',()=>{
 const empty=aggregateDashboardMetrics([]);assert.equal(empty.dataDays,0);assert.equal(empty.totals.spendUsd,'0');assert.equal(empty.totals.impressions,'0');assert.equal(empty.totals.cpaKrw,null);assert.equal(empty.totals.providerPurchaseValueUsd,null);assert.equal(empty.totals.hasApiMetrics,false);
 const a=row(),b=row();b.metric.source='API';b.metric.actionReportTime='impression';
 const mixed=aggregateDashboardMetrics([a,b]).totals;assert.equal(mixed.spendUsd,'2');assert.equal(mixed.spendKrw,'4');
 for(const key of ['purchaseCount','revenueKrw','marginKrw','cpaUsd','cpaKrw','roas'] as const)assert.equal(mixed[key],null,key);
 assert.equal(mixed.metricUnavailableReasons.purchaseCount,'MIXED_ATTRIBUTION');
});
