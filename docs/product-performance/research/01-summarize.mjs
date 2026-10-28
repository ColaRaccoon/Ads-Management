import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
const {Prisma}=require('@prisma/client');
const D=Prisma.Decimal;
const root=new URL('./',import.meta.url);
const load=n=>JSON.parse(readFileSync(new URL(n,root),'utf8'));
const coverage=load('01-coverage-result.json');
const detail=load('01-detail-result.json');
const followup=load('01-followup-result.json');
const stored=load('01-stored-result.json');
const get=(doc,name)=>{const q=doc.queries.find(q=>q.name===name);if(q.status!=='SUCCESS')throw Error(name);return q.rows==null?[]:Array.isArray(q.rows)?q.rows:[q.rows]};
const total=(rows,key)=>rows.reduce((s,r)=>s.plus(r[key]??0),new D(0)).toFixed();
const stores=get(coverage,'naver_stores');
const result=[];
for(const name of ['meta','google','cafe24','coupang_sales','coupang_ads']){
 let rows=get(coverage,name+'_recent_daily');
 if(name==='cafe24')rows=rows.filter(r=>r.source==='API'||r.scope==='LEGACY_UNBOUND');
 for(const [period,subset] of [['2026-10-26',rows.filter(r=>r.date==='2026-10-26')],['2026-10-20..26',rows]]){
  result.push({source:name,period,rows:total(subset,'rows'),unmappedRows:name==='google'?null:total(subset,'unmapped_rows'),rawAmount:total(subset,'raw_amount'),unit:name==='meta'?'USD':name==='google'?'MICROS_KRW':'KRW',basis:name==='cafe24'?'sum(sale_price_krw), NOT quantity/coupon adjusted business revenue':'selected-current source amount',scopeStatus:name.startsWith('coupang')?'LEGACY_COUPANG_SINGLE_UPLOAD_USER_CONFIRMED':name==='cafe24'||name==='meta'?'7day contains legacy unbound CSV':'bound'});
 }
}
for(const store of stores){
 for(const [kind,key,amount] of [['sales','naver_orders_daily_','raw_revenue'],['ads','naver_ads_daily_','raw_spend']]){
  const rows=get(coverage,key+store.id).filter(r=>kind!=='sales'||r.sale_status==='SALE');
  for(const [period,subset] of [['2026-10-26',rows.filter(r=>r.date==='2026-10-26')],['2026-10-20..26',rows]])result.push({source:'naver_'+kind,scope:store.name,period,rows:total(subset,'rows'),unmappedRows:total(subset,'unmapped_rows'),rawAmount:total(subset,amount),unit:'KRW',basis:kind==='sales'?'SALE productPaymentAmount':'active confirmed PASSED upload totalCost'});
 }
}
const storedComparison=get(stored,'naver_stored_summary_corrected').map(r=>{
 const sales=get(coverage,'naver_orders_daily_'+r.store_id).filter(x=>x.date===r.date&&x.sale_status==='SALE');
 const ads=get(coverage,'naver_ads_daily_'+r.store_id).filter(x=>x.date===r.date);
 return {store:stores.find(s=>s.id===r.store_id).name,date:r.date,rawSaleRevenue:total(sales,'raw_revenue'),storedRevenue:r.total_revenue,revenueDifference:new D(total(sales,'raw_revenue')).minus(r.total_revenue).toFixed(),rawAdSpend:total(ads,'raw_spend'),storedAdSpend:r.ad_cost,adDifference:new D(total(ads,'raw_spend')).minus(r.ad_cost).toFixed(),storedExcludedRevenue:r.excluded_order_revenue,storedExcludedAdSpend:r.excluded_ad_cost,storedProfit:r.estimated_profit,storedProfitStatus:r.profit_status,calculationVersion:r.calculation_version,calculatedAt:r.calculated_at};
});
const checks={sourceComparison:result,storedComparison,naverCostPresence:stores.flatMap(s=>get(followup,'naver_cost_coverage_'+(s.name==='인피니티스토어'?'infinity':'patima')).map(r=>({store:s.name,...r}))),cafe24CostPresence:get(detail,'cafe24_cost_presence'),coupangCostPresence:get(detail,'coupang_cost_presence'),fx:get(followup,'exchange_rates_corrected')};
writeFileSync(new URL('01-evidence-summary.json',root),JSON.stringify(checks,null,2)+'\n');
let md='# 01 하루·7일 원천 대조표\n\n관측일: 2026-10-27 KST. 생성: `node docs/product-performance/research/01-summarize.mjs`. 금액은 Decimal 문자열 합산이다. 이 표는 선택 조건을 명시한 원천 기준선이며 아직 구현하지 않은 통합 집계/기존 보고서와의 일치 검증이 아니다. 전액 실결제·완전이익으로 사용하지 않는다.\n\n';
md+='최근 하루=10/26, 7일=10/20~26. Cafe24 10/23의 API 229행과 CSV 228행을 합치지 않고 정책에 따라 API만 선택했다. Meta 광고세트만 사용하며 개별 광고는 합산하지 않았다. 네이버 판매는 SALE만, 광고는 활성·확정·요일검증통과 업로드만 사용했다.\n\n';
md+='| 원천/범위 | 기간 | 행수 | 기존 연결 없는 행 | 원금액 | 단위 |\n| --- | --- | ---: | ---: | ---: | --- |\n';
for(const r of result)md+=`| ${r.source}${r.scope?' / '+r.scope:''} | ${r.period} | ${r.rows} | ${r.unmappedRows??'별도 이름 판정 필요'} | ${r.rawAmount} | ${r.unit} |\n`;
md+='\nGoogle micros는 1,000,000으로 나누며 현재 계정통화 KRW다. Cafe24 원금액은 sale_price_krw 합계이므로 수량·등록 판매가·쿠폰 반영 후 운영매출과 다르다. Meta USD는 날짜별 저장 환율 적용 전이다. 광고전환매출은 포함하지 않았다. 기존 원천 product_id/canonicalSalesUnitId 연결률은 새 이름 분류 성공률이 아니다.\n\n';
md+='7일은 조사 창의 길이이며 모든 원천이7일 보유한다는 뜻이 아니다. Google은 10/20·23·25·26만 현재행 및 COMPLETE_NONZERO coverage가 있고10/21·22·24는 둘 다 없다(0원완료 아님). 원시 자료 공통 관측일은10/20·23·25·26, 계정 연결된 Meta/Google/Cafe24 공통 관측일은10/23·25·26이다. 따라서 연속된 완전7일 공통 구간은 없다. 네이버 order_sync_states=0, 쿠팡 CSV의0건 완료 증거 없음, Cafe24/쿠팡/파티마 미분류도 별도 제한이다.\n\n';
md+='원가 존재 조사에서 Cafe24/쿠팡의 연결된 최근 판매행은 날짜 유효 원가 규칙 누락 0건이다. 이는 기본값0의 입력 의도·쿠폰·판매단위·반품까지 완전하다는 뜻이 아니다. 네이버 no_cost_anywhere는 어떤 시점의 원가도 없는 행만 세며, 실제 유효일 우선순위 검증의 대용이 아니다. 자세한 일별 수치는 `../research/01-evidence-summary.json`을 참조한다.\n';
md+='\n## 네이버 저장 결과와의 제한 대조\n\n';
md+='| 스토어 | 날짜 | SALE 원천−저장 매출 | 유효 광고−저장 광고 | 저장 계산버전 |\n| --- | --- | ---: | ---: | --- |\n';
for(const r of storedComparison)md+=`| ${r.store} | ${r.date} | ${r.revenueDifference} | ${r.adDifference} | ${r.calculationVersion} |\n`;
md+='\n이 차이는 미분류 제외·계산시각·기존 산식 등의 차이를 포함하며 통합 버그로 단정하지 않는다. 저장 이익과 제외금액은 JSON에 보존했다. 사용자가 네이버의 추정 정확도를 수용했으므로 이 차이를0으로 만들기 위한 원천 재수집·전수 재계산은 요구하지 않는다. 선택 입력의 금액 보존과 중복 차감 여부만 후속 어댑터에서 검증한다. `naver_stored_daily_recent.net_profit` null은 실제 필드명이 estimatedNetProfit인데 netProfit으로 처음 조회한 결과여서 이익 미입력 증거가 아니다. 수정 투영은 `01-stored-result.json`에 있다.\n';
writeFileSync(new URL('../records/01_원천대조.md',root),md);
console.log(JSON.stringify({comparisonRows:result.length,readOnly:true}));
