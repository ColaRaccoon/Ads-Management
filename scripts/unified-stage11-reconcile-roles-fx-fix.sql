-- Parent-only one-column correction. Source contents, RLS and provider payload access stay unchanged.
-- Invoke within the reviewed temporary owner-SET membership wrapper; preserve all original memberships.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
SET LOCAL ROLE meta_ads_app;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='meta_ads' AND c.relname='exchange_rates' AND r.rolname='meta_ads_app') THEN
  RAISE EXCEPTION 'STAGE11_FX_OWNER_CHANGED';
 END IF;
END $$;
GRANT SELECT(id) ON TABLE meta_ads.exchange_rates TO meta_ads_unified_worker;
DO $$
BEGIN
 IF NOT has_column_privilege('meta_ads_unified_worker','meta_ads.exchange_rates','id','SELECT') THEN
  RAISE EXCEPTION 'STAGE11_FX_IMPLICIT_ORDER_KEY_NOT_GRANTED';
 END IF;
 IF has_table_privilege('meta_ads_unified_worker','meta_ads.exchange_rates','SELECT') OR has_column_privilege('meta_ads_unified_worker','meta_ads.exchange_rates','provider_payload','SELECT') OR has_column_privilege('meta_ads_unified_report','meta_ads.exchange_rates','id','SELECT') THEN
  RAISE EXCEPTION 'STAGE11_FX_BROAD_OR_REPORT_SOURCE_PRIVILEGE';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='meta_ads.exchange_rates'::regclass AND a.attnum>0 AND NOT a.attisdropped AND(has_column_privilege('meta_ads_unified_worker',a.attrelid,a.attnum,'INSERT') OR has_column_privilege('meta_ads_unified_worker',a.attrelid,a.attnum,'UPDATE'))) OR has_table_privilege('meta_ads_unified_worker','meta_ads.exchange_rates','DELETE,TRUNCATE') THEN
  RAISE EXCEPTION 'STAGE11_FX_SOURCE_WRITABLE';
 END IF;
END $$;
RESET ROLE;
COMMIT;
