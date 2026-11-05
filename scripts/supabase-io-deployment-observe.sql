WITH statements AS (
 SELECT queryid::text,calls,rows,total_exec_time,shared_blks_hit,shared_blks_read,shared_blks_dirtied,
   shared_blks_written,temp_blks_read,temp_blks_written,
   CASE WHEN query LIKE '%LEFT JOIN meta_ads.unified_reconciliation_checks%' AND query LIKE 'WITH observed AS (SELECT DISTINCT %' THEN 'AFTER_V1'
     WHEN query LIKE '%LEFT JOIN meta_ads.unified_reconciliation_checks%' THEN 'AFTER_V2' ELSE 'BEFORE' END AS version,
   CASE WHEN query LIKE '%coupang_sale_lines%' THEN 'COUPANG' WHEN query LIKE '%cafe24_order_lines%' THEN 'CAFE24'
     WHEN query LIKE '%daily_store_summaries%' THEN 'NAVER' WHEN query LIKE '%google_campaign_daily_costs%' THEN 'GOOGLE' ELSE 'META' END AS platform
 FROM extensions.pg_stat_statements WHERE query LIKE 'WITH observed AS (%'
), publications AS (
 SELECT platform,count(*) AS dates,max(business_date) AS latest_date,
   md5(string_agg(scope_key||business_date::text||run_id::text||revision::text,',' ORDER BY scope_key,business_date,source_system)) AS pointer_digest
 FROM meta_ads.unified_source_publications GROUP BY platform
)
SELECT now() AS observed_at, (SELECT jsonb_agg(s) FROM statements s) AS statements,
 (SELECT jsonb_agg(p) FROM publications p) AS publications,
 (SELECT jsonb_agg(i) FROM extensions.pg_stat_statements_info i) AS statement_reset,
 (SELECT jsonb_agg(x) FROM (SELECT last_outcome,count(*) AS checks,max(last_checked_at) AS latest_check
   FROM meta_ads.unified_reconciliation_checks WHERE last_checked_at>=now()-interval '10 minutes' GROUP BY last_outcome) x) AS recent_checks,
 (SELECT jsonb_agg(x) FROM (SELECT backend_type,object,context,reads,writes,read_time,write_time,op_bytes,stats_reset
   FROM pg_stat_io WHERE object='relation') x) AS postgres_io;
