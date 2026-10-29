-- Parent-only correction for PostgreSQL FK owner-context SELECT ... FOR KEY SHARE.
-- Caller temporarily enables owner SET membership and restores the original grantor row.
-- Only FK-key SELECT and UPDATE(id) on two NEW parent tables; no runtime/source/RLS policy grant.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
SET LOCAL ROLE meta_ads_app;
DO $$
BEGIN
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='meta_ads' AND c.relname IN ('unified_products','unified_aggregation_runs') AND r.rolname='meta_ads_app' AND c.relrowsecurity AND c.relforcerowsecurity)<>2 THEN
  RAISE EXCEPTION 'STAGE11_FK_PARENT_OWNER_OR_FORCE_RLS_CHANGED';
 END IF;
END $$;
GRANT SELECT(id),UPDATE(id) ON TABLE meta_ads.unified_products TO meta_ads_app;
GRANT SELECT(id,source_system,platform,scope_key,business_date),UPDATE(id) ON TABLE meta_ads.unified_aggregation_runs TO meta_ads_app;
DO $$
BEGIN
 IF NOT has_column_privilege('meta_ads_app','meta_ads.unified_products','id','SELECT') OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_products','id','UPDATE')
 OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','id','SELECT') OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','id','UPDATE')
 OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','source_system','SELECT') OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','platform','SELECT')
 OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','scope_key','SELECT') OR NOT has_column_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','business_date','SELECT') THEN
  RAISE EXCEPTION 'STAGE11_FK_PARENT_MINIMUM_PRIVILEGES_NOT_GRANTED';
 END IF;
 IF has_table_privilege('meta_ads_app','meta_ads.unified_products','SELECT,UPDATE') OR has_table_privilege('meta_ads_app','meta_ads.unified_aggregation_runs','SELECT,UPDATE') THEN
  RAISE EXCEPTION 'STAGE11_FK_PARENT_BROAD_PRIVILEGE_REQUIRES_REVIEW';
 END IF;
END $$;
RESET ROLE;
COMMIT;
