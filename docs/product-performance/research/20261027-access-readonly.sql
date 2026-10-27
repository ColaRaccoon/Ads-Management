BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT n.nspname AS schema, c.relname AS relation,
  c.reltuples::bigint AS estimated_rows,
  c.relrowsecurity AS rls_enabled,
  has_schema_privilege('meta_ads_app',n.nspname,'USAGE') AS runtime_schema_usage,
  has_table_privilege('meta_ads_app',c.oid,'SELECT') AS runtime_table_select,
  has_any_column_privilege('meta_ads_app',c.oid,'SELECT') AS runtime_any_column_select
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind='r' AND
  ((n.nspname='public' AND c.relname IN ('order_items','canonical_sales_units','ad_campaign_daily_costs','ad_excel_uploads','daily_sales_unit_profits','daily_store_summaries','daily_fake_purchases','order_sync_states'))
   OR (n.nspname='meta_ads' AND c.relname IN ('products','coupang_products','cafe24_order_lines','coupang_sale_lines','coupang_ad_metrics','meta_adset_daily_metrics','google_campaign_daily_costs')))
ORDER BY n.nspname,c.relname;
ROLLBACK;
