BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT table_schema, table_name,
       string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position) AS columns
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'auth', 'storage', 'realtime', 'extensions', 'vault', 'graphql', 'graphql_public')
  AND table_name IN (
    'products', 'coupang_products', 'canonical_sales_units', 'order_items',
    'ad_campaign_daily_costs', 'ad_excel_uploads', 'daily_sales_unit_profits',
    'daily_store_summaries', 'daily_fake_purchases', 'order_sync_states',
    'meta_adset_daily_metrics', 'google_campaign_daily_costs', 'google_performance_mappings',
    'cafe24_order_lines', 'coupang_sale_lines', 'coupang_ad_metrics'
  )
GROUP BY table_schema, table_name
ORDER BY table_schema, table_name;
ROLLBACK;
