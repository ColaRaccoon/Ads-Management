SELECT current_setting('cron.timezone',true) AS cron_timezone,
  (SELECT jsonb_agg(x) FROM (SELECT key,provider,anchor_at,cadence_days,window_minutes,paused
    FROM daily_data_sync_prod_ops.schedules ORDER BY key) x) AS collection_schedules,
  (SELECT stopped FROM daily_data_sync_prod_ops.settings WHERE singleton) AS collection_stopped,
  (SELECT jsonb_agg(x) FROM (SELECT i.relname AS index_name,pg_relation_size(i.oid) AS bytes
    FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid JOIN pg_class t ON t.oid=ix.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='meta_ads' AND t.relname='unified_product_match_results') x) AS match_indexes,
  (SELECT jsonb_agg(x) FROM (SELECT usename,state,count(*) AS sessions FROM pg_stat_activity
    WHERE usename IN ('meta_ads_unified_worker','meta_ads_unified_report') GROUP BY usename,state) x) AS unified_sessions;
