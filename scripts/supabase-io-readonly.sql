WITH sizes AS (
  SELECT n.nspname AS schema, c.relname AS name, pg_total_relation_size(c.oid) AS total_bytes,
    pg_relation_size(c.oid) AS heap_bytes, pg_indexes_size(c.oid) AS index_bytes
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='r' AND n.nspname IN ('public','meta_ads')
    AND (c.relname LIKE '%match%' OR c.relname IN ('order_items','unified_reconciliation_checks','unified_source_publications'))
), statements AS (
  SELECT queryid::text, calls, rows, total_exec_time, mean_exec_time, shared_blks_hit, shared_blks_read,
    shared_blks_dirtied, shared_blks_written, temp_blks_read, temp_blks_written,
    CASE WHEN query LIKE '%WITH observed AS%' THEN 'RECONCILIATION_DATES'
      WHEN query ILIKE 'INSERT%SELECT%' AND query ILIKE '%match%' THEN 'MATCH_COPY'
      WHEN query ILIKE 'DELETE%' AND query LIKE '%order_items%' THEN 'ORDER_DELETE' ELSE 'OTHER' END AS kind,
    ARRAY(SELECT DISTINCT m[1] FROM regexp_matches(query,'(?:FROM|INTO|JOIN|UPDATE)\s+([a-zA-Z_"][a-zA-Z0-9_".]*)','gi') m) AS relations
  FROM extensions.pg_stat_statements
  WHERE query LIKE '%WITH observed AS%'
    OR (query ILIKE 'INSERT%SELECT%' AND query ILIKE '%match%')
    OR (query ILIKE 'DELETE%' AND query LIKE '%order_items%')
  ORDER BY total_exec_time DESC LIMIT 12
)
SELECT current_database() AS database, current_user AS role, pg_database_size(current_database()) AS database_bytes,
  (SELECT jsonb_agg(s) FROM sizes s) AS sizes, (SELECT jsonb_agg(s) FROM statements s) AS statements,
  (SELECT jsonb_agg(x) FROM (SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname IN ('meta_ads','public') AND tablename IN ('unified_reconciliation_checks','unified_source_publications','order_items','product_matching_results','product_match_results')) x) AS indexes,
  (SELECT jsonb_agg(x) FROM (SELECT jobid, schedule, active,
    CASE WHEN command ILIKE '%reconcil%' THEN 'RECONCILIATION' WHEN command ILIKE '%daily_data_sync%' THEN 'DAILY_SYNC' ELSE 'OTHER' END AS kind
    FROM cron.job) x) AS schedules;
