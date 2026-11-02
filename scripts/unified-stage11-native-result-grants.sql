-- Canonical native calculator inputs only. No table-wide grants, source writes or report-role changes.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
SET LOCAL ROLE meta_ads_app;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['products','meta_adset_daily_metrics','cafe24_order_lines'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='meta_ads' AND c.relname=t AND r.rolname='meta_ads_app') THEN
   RAISE EXCEPTION 'NATIVE_RESULT_SOURCE_OWNER_CHANGED';
  END IF;
 END LOOP;
END $$;
GRANT SELECT(name) ON TABLE meta_ads.products TO meta_ads_unified_worker;
GRANT SELECT(product_id) ON TABLE meta_ads.meta_adset_daily_metrics TO meta_ads_unified_worker;
GRANT SELECT(row_number) ON TABLE meta_ads.cafe24_order_lines TO meta_ads_unified_worker;
DO $$
DECLARE t text;
BEGIN
 IF NOT has_column_privilege('meta_ads_unified_worker','meta_ads.products','name','SELECT') OR
    NOT has_column_privilege('meta_ads_unified_worker','meta_ads.meta_adset_daily_metrics','product_id','SELECT') OR
    NOT has_column_privilege('meta_ads_unified_worker','meta_ads.cafe24_order_lines','row_number','SELECT') THEN
  RAISE EXCEPTION 'NATIVE_RESULT_COLUMNS_NOT_GRANTED';
 END IF;
 FOREACH t IN ARRAY ARRAY['products','meta_adset_daily_metrics','cafe24_order_lines'] LOOP
  IF has_table_privilege('meta_ads_unified_worker','meta_ads.'||t,'SELECT') OR
     has_any_column_privilege('meta_ads_unified_worker','meta_ads.'||t,'INSERT') OR
     has_any_column_privilege('meta_ads_unified_worker','meta_ads.'||t,'UPDATE') OR
     has_table_privilege('meta_ads_unified_worker','meta_ads.'||t,'DELETE,TRUNCATE') OR
     has_any_column_privilege('meta_ads_unified_report','meta_ads.'||t,'SELECT') THEN
   RAISE EXCEPTION 'NATIVE_RESULT_SOURCE_PRIVILEGE_TOO_BROAD';
  END IF;
 END LOOP;
 IF has_column_privilege('meta_ads_unified_worker','meta_ads.source_connections','credential_ref','SELECT') OR
    has_column_privilege('meta_ads_unified_worker','meta_ads.source_connections','external_account_id','SELECT') THEN
  RAISE EXCEPTION 'NATIVE_RESULT_PRIVATE_CONNECTION_ACCESS';
 END IF;
END $$;
RESET ROLE;
COMMIT;
