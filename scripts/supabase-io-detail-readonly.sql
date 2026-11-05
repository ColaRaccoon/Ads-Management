SELECT
  (SELECT jsonb_agg(x) FROM (SELECT queryid::text,
    regexp_replace(query, $rx$'([^']|'')*'$rx$, '''[literal]''', 'g') AS parameterized_query
    FROM extensions.pg_stat_statements WHERE queryid IN (-8341297477197280576,-2560290445934354023)) x) AS statements,
  (SELECT jsonb_agg(x) FROM (SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname='meta_ads' AND tablename IN ('unified_product_match_results','cafe24_order_lines',
      'meta_adset_daily_metrics','google_campaign_daily_costs','coupang_sale_lines','coupang_ad_metrics','coupang_manual_purchases')) x) AS indexes,
  (SELECT jsonb_agg(x) FROM (SELECT schemaname,relname,n_live_tup,n_dead_tup,last_autovacuum,last_autoanalyze
    FROM pg_stat_user_tables WHERE schemaname='meta_ads' AND relname IN ('unified_product_match_results',
    'cafe24_order_lines','coupang_sale_lines','unified_aggregation_runs')) x) AS estimates,
  (SELECT jsonb_agg(x) FROM (SELECT name,setting,unit FROM pg_settings WHERE name IN
    ('shared_buffers','work_mem','effective_cache_size','max_connections','track_io_timing')) x) AS settings,
  (SELECT jsonb_agg(x) FROM extensions.pg_stat_statements_info x) AS statistics_info;
