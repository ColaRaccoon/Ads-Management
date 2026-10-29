-- Correct only schema USAGE after the first role proposal's owner phase ordering.
-- Run once as the actual postgres schema owner. Do not rerun the full policy proposal.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $$
BEGIN
 IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='meta_ads' AND r.rolname='postgres') THEN
  RAISE EXCEPTION 'STAGE11_SCHEMA_OWNER_REQUIRED';
 END IF;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('meta_ads_unified_report','meta_ads_unified_worker') AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit)<>2 THEN
  RAISE EXCEPTION 'STAGE11_FEATURE_ROLES_REQUIRE_REVIEW';
 END IF;
END $$;
GRANT USAGE ON SCHEMA meta_ads TO meta_ads_unified_report,meta_ads_unified_worker;
COMMIT;
SELECT rolname,has_schema_privilege(rolname,'meta_ads','USAGE') AS has_meta_ads_usage
FROM pg_roles WHERE rolname IN ('meta_ads_unified_report','meta_ads_unified_worker') ORDER BY rolname;
