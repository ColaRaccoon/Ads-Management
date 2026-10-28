// Offline, non-PII query manifest preparation. No credentials or network.
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('./', import.meta.url);
const inventory = JSON.parse(readFileSync(new URL('01-inventory-result.json', root), 'utf8'));
const rows = name => inventory.queries.find(q => q.name === name).rows;
const quote = s => "'" + s.replaceAll("'", "''") + "'";
const queries = [];
const add = (name, sql) => queries.push({name, sql});
add('naver_units_named', "SELECT id,payload->>'storeId' AS store_id,payload->>'displayName' AS name,payload->>'isActive' AS active,payload->>'isGroup' AS is_group,payload->>'parentSalesUnitId' AS parent_id,payload->'matchAliases' AS aliases FROM public.canonical_sales_units ORDER BY payload->>'storeId',payload->>'displayName' LIMIT 150");
add('naver_stores', "SELECT id,payload->>'name' AS name,payload->>'storeName' AS store_name,payload->>'displayName' AS display_name FROM public.stores ORDER BY id LIMIT 20");
add('naver_cost_keys', "SELECT 'setting' AS kind,jsonb_object_keys(payload) AS key FROM (SELECT payload FROM public.sales_unit_cost_settings LIMIT 1) s UNION ALL SELECT 'snapshot',jsonb_object_keys(payload) FROM (SELECT payload FROM public.sales_unit_cost_snapshots LIMIT 1) s UNION ALL SELECT 'entry',jsonb_object_keys(payload) FROM (SELECT payload FROM public.sales_unit_cost_snapshot_entries LIMIT 1) s");
add('naver_settings', "SELECT payload->>'storeId' AS store_id,payload->>'salesUnitId' AS unit_id,payload->>'canonicalSalesUnitId' AS canonical_id,payload->>'effectiveFrom' AS effective_from,payload->>'productCost' AS product_cost,payload->>'shippingCost' AS shipping_cost,payload->>'isActive' AS active FROM public.sales_unit_cost_settings LIMIT 150");
add('cafe24_rules', "SELECT p.name,r.display_name,r.product_name_aliases,r.option_include_keywords,r.option_exclude_keywords,r.sale_price_krw_override::text,r.product_cost_krw_override::text,r.shipping_krw_override::text,r.extra_cost_krw_override::text,r.valid_from,r.valid_to FROM meta_ads.cafe24_product_rules r JOIN meta_ads.products p ON p.id=r.product_id WHERE r.is_active ORDER BY p.name,r.display_name LIMIT 100");
add('google_sale_units', "SELECT p.name,m.option_name,m.option_scope,m.sale_unit_label,m.sale_price_krw_override::text,m.product_cost_krw_override::text,m.shipping_krw_override::text,m.extra_cost_krw_override::text,m.start_date,m.end_date FROM meta_ads.google_performance_mappings m JOIN meta_ads.products p ON p.id=m.product_id WHERE kind='SALE' ORDER BY p.name,m.start_date LIMIT 100");
for (const [name, table, date, mapped, amount] of [
  ['meta','meta_adset_daily_metrics','metric_date','product_id','spend_usd'],
  ['google','google_campaign_daily_costs','metric_date',null,'cost_micros'],
  ['cafe24','cafe24_order_lines','order_date','product_id','sale_price_krw'],
  ['coupang_sales','coupang_sale_lines','sale_date','coupang_product_id','net_sales_krw'],
  ['coupang_ads','coupang_ad_metrics','metric_date','spend_product_id','ad_spend_krw']
]) {
  const account = name.startsWith('coupang') ? "'UNIDENTIFIED_SCOPE'" : 'coalesce(connection_id::text,\'LEGACY_UNBOUND\')';
  add(name+'_bounds', `SELECT ${account} AS scope,min(${date})::text AS min_date,max(${date})::text AS max_date,count(*) AS current_rows FROM meta_ads.${table} WHERE is_current GROUP BY 1 ORDER BY 1`);
  add(name+'_recent_daily', `SELECT ${account} AS scope,${date}::text AS date,${name.startsWith('coupang') ? "'CSV'" : 'source::text'} AS source,count(*) AS rows,${mapped ? `count(*) FILTER(WHERE ${mapped} IS NULL)` : 'NULL::bigint'} AS unmapped_rows,sum(${amount})::text AS raw_amount FROM meta_ads.${table} WHERE is_current AND ${date} BETWEEN '2026-10-20' AND '2026-10-26' GROUP BY 1,2,3 ORDER BY 1,2,3`);
}
add('source_coverage_recent', "SELECT connection_id,data_kind,metric_date::text,source,state,last_success_at,reconciliation_status,row_count,total_amount::text,warning_codes FROM meta_ads.source_coverage WHERE metric_date BETWEEN '2026-10-20' AND '2026-10-26' ORDER BY connection_id,data_kind,metric_date LIMIT 200");
for (const store of [...new Set(rows('naver_units').map(x=>x.store_id))]) {
  const scope = quote(store);
  add('naver_orders_bounds_'+store, `SELECT ${scope} AS scope,min(payload->>'paymentDate') AS min_date,max(payload->>'paymentDate') AS max_date,count(*) AS rows FROM public.order_items WHERE payload->>'storeId'=${scope}`);
  add('naver_orders_daily_'+store, `SELECT ${scope} AS scope,left(payload->>'paymentDate',10) AS date,payload->>'saleStatus' AS sale_status,count(*) AS rows,count(*) FILTER(WHERE nullif(payload->>'canonicalSalesUnitId','') IS NULL) AS unmapped_rows,sum((payload->>'productPaymentAmount')::numeric)::text AS raw_revenue FROM public.order_items WHERE payload->>'storeId'=${scope} AND payload->>'paymentDate'>='2026-10-20' AND payload->>'paymentDate'<'2026-10-27' GROUP BY 1,2,3 ORDER BY 2,3`);
  add('naver_ads_bounds_'+store, `SELECT ${scope} AS scope,min(a.payload->>'reportDate') AS min_date,max(a.payload->>'reportDate') AS max_date,count(*) AS rows FROM public.ad_campaign_daily_costs a JOIN public.ad_excel_uploads u ON u.id=a.payload->>'sourceUploadId' WHERE a.payload->>'storeId'=${scope} AND u.payload->>'storeId'=${scope} AND u.payload->>'isActive'='true' AND u.payload->>'state'='CONFIRMED' AND u.payload->>'weekdayValidationStatus'='PASSED'`);
  add('naver_ads_daily_'+store, `SELECT ${scope} AS scope,a.payload->>'reportDate' AS date,count(*) AS rows,count(*) FILTER(WHERE nullif(a.payload->>'canonicalSalesUnitId','') IS NULL) AS unmapped_rows,sum((a.payload->>'totalCost')::numeric)::text AS raw_spend FROM public.ad_campaign_daily_costs a JOIN public.ad_excel_uploads u ON u.id=a.payload->>'sourceUploadId' WHERE a.payload->>'storeId'=${scope} AND a.payload->>'reportDate'>='2026-10-20' AND a.payload->>'reportDate'<'2026-10-27' AND u.payload->>'storeId'=${scope} AND u.payload->>'isActive'='true' AND u.payload->>'state'='CONFIRMED' AND u.payload->>'weekdayValidationStatus'='PASSED' GROUP BY 1,2 ORDER BY 2`);
}
add('naver_sync_count', 'SELECT count(*) AS rows FROM public.order_sync_states');
add('naver_cost_access', "SELECT r.rolname,c.relname,c.relrowsecurity,has_table_privilege(r.oid,c.oid,'SELECT') AS table_select FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE r.rolname IN ('meta_ads_app','meta_ads_prod_runtime') AND n.nspname='public' AND c.relname IN ('sales_unit_cost_settings','sales_unit_cost_snapshots','sales_unit_cost_snapshot_entries') ORDER BY 1,2");
writeFileSync(new URL('01-coverage-queries.json', root), JSON.stringify(queries,null,2)+'\n', {flag:'wx'});
console.log(JSON.stringify({queries:queries.length,networkRequests:0}));
