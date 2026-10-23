import 'reflect-metadata';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PrismaClient,Prisma} from '@prisma/client';
import {assertBusinessDatabaseTarget} from './seed-isolated-business-config.mjs';
import {StorefrontReadService} from '../../../apps/api/src/storefront/storefront-read.service.ts';
const DAY='2026-10-14',ROOT='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261019-v4';
const hash=b=>createHash('sha256').update(b).digest('hex');
const D=Prisma.Decimal.clone({precision:50,toExpPos:100,toExpNeg:-100});
export async function inspectCommonDay(input){
 let db,stage='TARGET';const before={};
 try{
  assert.equal(input.projectRef,'ehnfrrmbkvlsbpvqcvkr');assert.equal(input.day,DAY);
  assert.equal(input.env?.SUPABASE_DATABASE_SCHEMA,'phase08_meta_ads');assert.equal(input.env?.SUPABASE_DATABASE_RUNTIME_USER,'phase08_runtime');
  const manifest=JSON.parse(await readFile(`${ROOT}/source-content-manifest.json`,'utf8'));
  assert.equal(manifest.sourceContentSha256,'16d8fbd10b357847b7a1666762f2196b850e394bc0cdee6d15df68075c7a2743');
  const names=['apps/api/src/storefront/storefront-read.service.ts','apps/api/src/common/source-read-policy.ts','apps/api/src/common/meta-source-read-coverage.ts','apps/api/src/domain/effective-rule.ts'];
  const files=[];for(const name of names){const bytes=await readFile(name);const sha256=hash(bytes);assert.equal(sha256,manifest.files.find(f=>f.name===name)?.sha256);files.push({name,sha256});}
  db=new PrismaClient({datasourceUrl:assertBusinessDatabaseTarget({projectRef:input.projectRef,freshVerified:true,databaseUrl:input.databaseUrl})});
  for(const key of ['DAILY_SYNC_FEATURE_ENABLED','DAILY_SYNC_SCHEDULE_ENABLED']){before[key]=process.env[key];process.env[key]=input.env[key];assert.equal(input.env[key],'true');}
  let reference,identity,coverage,policies;
  const adapter={$transaction:async action=>db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='20000'");
   identity=(await tx.$queryRawUnsafe("SELECT current_database() AS database,current_user AS role,current_schema() AS schema,current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation"))[0];
   assert.deepEqual(identity,{database:'postgres',role:'phase08_runtime',schema:'phase08_meta_ads',readonly:'on',isolation:'repeatable read'});
   stage='INDEPENDENT_SQL';
   reference=(await tx.$queryRawUnsafe(`WITH cafe AS (
    SELECT l.quantity,l.sale_price_krw,p.is_active,
     coalesce(r.sale_price_krw_override,c.sale_price_krw,l.sale_price_krw) AS price,
     CASE WHEN c.id IS NULL AND r.sale_price_krw_override IS NULL AND (
      regexp_replace(coalesce(r.display_name,''),'\\s+','','g') ILIKE '%1+1%' OR
      EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(r.option_include_keywords,'[]'::jsonb)) v WHERE regexp_replace(btrim(v),'\\s+','','g') ILIKE '%1+1%' OR btrim(v)='+') OR
      EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(r.product_name_aliases,'[]'::jsonb)) v WHERE regexp_replace(btrim(v),'\\s+','','g') ILIKE '%1+1%')
     ) THEN 2 ELSE 1 END AS multiplier
    FROM cafe24_order_lines l LEFT JOIN products p ON p.id=l.product_id LEFT JOIN cafe24_product_rules r ON r.id=l.cafe24_product_rule_id
    LEFT JOIN LATERAL(SELECT * FROM product_cost_rules c WHERE c.product_id=l.product_id AND c.effective_from<=$1::date AND(c.effective_to IS NULL OR c.effective_to>=$1::date) ORDER BY c.effective_from DESC,c.created_at DESC,c.id DESC LIMIT 1)c ON true
    WHERE l.source='API' AND l.is_current AND l.order_date=$1::date AND l.validation_status::text<>'ERROR'
   ), meta AS (
    SELECT m.spend_usd,coalesce(e.rate,CASE WHEN p.is_active AND c.fx_rate_krw_per_usd>0 THEN c.fx_rate_krw_per_usd END) AS fx
    FROM meta_adset_daily_metrics m LEFT JOIN products p ON p.id=m.product_id
    LEFT JOIN LATERAL(SELECT * FROM product_cost_rules c WHERE c.product_id=m.product_id AND c.effective_from<=$1::date AND(c.effective_to IS NULL OR c.effective_to>=$1::date) ORDER BY c.effective_from DESC,c.created_at DESC,c.id DESC LIMIT 1)c ON true
    LEFT JOIN exchange_rates e ON e.rate_date=$1::date AND e.base_currency='USD' AND e.quote_currency='KRW' AND e.provider='KOREA_EXIM'
    WHERE m.source='API' AND m.is_current AND m.metric_date=$1::date
   ) SELECT
    (SELECT count(*)::int FROM cafe) AS cafe_rows,(SELECT count(*)::int FROM cafe WHERE is_active) AS cafe_matched,
    (SELECT coalesce(sum(price*quantity*multiplier) FILTER(WHERE is_active),0)::text FROM cafe) AS cafe_legacy_revenue,
    (SELECT coalesce(sum(sale_price_krw*quantity),0)::text FROM cafe) AS cafe_raw_quantity_sales,
    (SELECT count(*)::int FROM google_campaign_daily_costs WHERE source='API' AND is_current AND metric_date=$1::date) AS google_rows,
    (SELECT coalesce(sum(cost_micros::numeric),0)::text FROM google_campaign_daily_costs WHERE source='API' AND is_current AND metric_date=$1::date) AS google_cost_micros,
    (SELECT count(*)::int FROM meta) AS meta_adset_rows,(SELECT coalesce(sum(spend_usd),0)::text FROM meta) AS meta_adset_usd,
    (SELECT count(*)::int FROM meta_ad_daily_metrics WHERE source='API' AND is_current AND metric_date=$1::date) AS meta_ad_rows,
    (SELECT coalesce(sum(spend_usd),0)::text FROM meta_ad_daily_metrics WHERE source='API' AND is_current AND metric_date=$1::date) AS meta_ad_usd,
    (SELECT CASE WHEN count(*) FILTER(WHERE spend_usd>0 AND(fx IS NULL OR fx<=0))>0 THEN NULL ELSE coalesce(sum(spend_usd*fx) FILTER(WHERE fx>0),0)::text END FROM meta) AS meta_spend_krw`,DAY))[0];
   coverage=await tx.$queryRawUnsafe("SELECT c.provider::text AS provider,v.data_kind::text AS kind,v.state::text AS state,v.row_count AS rows,v.total_amount::text AS original_amount,v.last_success_run_id IS NOT NULL AS success_present FROM source_coverage v JOIN source_connections c ON c.id=v.connection_id WHERE v.metric_date=$1::date ORDER BY c.provider::text,v.data_kind::text",DAY);
   policies=await tx.$queryRawUnsafe("SELECT c.provider::text AS provider,p.data_kind::text AS kind,p.primary_source::text AS source,count(*)::int AS policies FROM source_policies p JOIN source_connections c ON c.id=p.connection_id WHERE p.from_date<=$1::date AND(p.to_date IS NULL OR p.to_date>$1::date) GROUP BY c.provider,p.data_kind,p.primary_source ORDER BY c.provider::text,p.data_kind::text",DAY);
   assert.equal(policies.length,4);assert(policies.every(p=>p.source==='API'&&p.policies===1));
   stage='CURRENT_CANDIDATE_SOURCE';return action(tx);
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,timeout:30000,maxWait:5000})};
  const result=await new StorefrontReadService(adapter).summary(DAY,DAY);
  stage='EXACT_COMPARISON';const channel=p=>result.channels.find(c=>c.provider===p);
  const exact=(a,b)=>assert.equal(a==null?null:new D(a).toString(),b==null?null:new D(b).toString());
  exact(result.totals.revenueKrw,reference.cafe_legacy_revenue);exact(channel('CAFE24').amount,reference.cafe_legacy_revenue);
  exact(channel('GOOGLE').amount,new D(reference.google_cost_micros).div(1000000).toString());
  exact(channel('META').amount,reference.meta_adset_usd);exact(reference.meta_adset_usd,reference.meta_ad_usd);
  exact(channel('META').spendKrw,reference.meta_spend_krw);
  const known=new D(reference.google_cost_micros).div(1000000).plus(reference.meta_spend_krw??0).toString();exact(result.totals.knownSpendKrw,known);
  assert.equal(result.totals.totalSpendKrw,null);assert.equal(result.totals.mer,null);assert.equal(result.complete,false);assert.equal(channel('KAKAO').state,'NOT_CONNECTED');
  assert(channel('GOOGLE').complete&&channel('META').complete&&channel('CAFE24').complete);
  return{kind:'PHASE10_INDEPENDENT_COMMON_DAY_REAL_DB',classification:'CURRENT_CANDIDATE_SOURCE_AND_INDEPENDENT_SQL_SAME_READONLY_SNAPSHOT',observedAt:new Date().toISOString(),day:DAY,candidateCommit:'acbda3d65cff713650d317fa40e74764af46d2c0',sourceContentSha256:manifest.sourceContentSha256,identity,files,reference,actual:{totals:result.totals,channels:result.channels.map(({provider,amount,currency,spendKrw,complete,state})=>({provider,amount,currency,spendKrw,complete,state})),coverage:result.coverage.map(({provider,dataKind,state,rowCount,amount,complete})=>({provider,dataKind,state,rowCount,amount,complete})),currencyStatus:result.currencyStatus},independentCoverage:coverage,policies,allComparedValuesExact:true,metaAdsAndAdsetsNotAdded:true,googleCostUnallocated:true,cafeRevenueMeaning:'LEGACY_MATCHED_REVENUE_NOT_NET_SALES',kakaoBlocksTotalAndMer:true,providerRequests:0,databaseWrites:0,rawUserRowsReturned:0};
 }catch(error){throw Object.assign(Error('PHASE10_INDEPENDENT_COMMON_DAY_FAILED'),{safeDiagnostic:{kind:'PHASE10_INDEPENDENT_COMMON_DAY_FAILED',stage,code:/^P\d{4}$/.test(error?.code??'')?error.code:'SAFE_CHECK_FAILED',providerRequests:0,databaseWrites:0,rawErrorSuppressed:true}});}
 finally{await db?.$disconnect().catch(()=>{});for(const[key,value]of Object.entries(before))value===undefined?delete process.env[key]:process.env[key]=value;if(input){input.env=undefined;input.databaseUrl=undefined;}}
}
if(process.argv[1]?.endsWith('phase10-independent-common-day.mjs')){
 let raw='',input,out;try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>2097152)throw Error('bound');}input=JSON.parse(raw);raw='';out=await inspectCommonDay(input);}catch(error){out=error.safeDiagnostic??{kind:'PHASE10_INDEPENDENT_COMMON_DAY_FAILED',rawErrorSuppressed:true};process.exitCode=1;}finally{input=undefined;raw='';}process.stdout.write(JSON.stringify(out));
}
