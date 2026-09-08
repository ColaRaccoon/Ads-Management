\set ON_ERROR_STOP on
\pset pager off

-- Non-destructive containment. It does not terminate existing sessions or delete data.
\connect postgres postgres

BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;

DO $guard$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_CONTAINMENT_TARGET_PRINCIPAL_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN (
    'meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup'
  )) <> 3 THEN
    RAISE EXCEPTION 'R2A_CONTAINMENT_ROLE_SET_MISMATCH';
  END IF;
END
$guard$;

ALTER ROLE meta_ads_stg_runtime NOLOGIN;
ALTER ROLE meta_ads_stg_migration NOLOGIN;
ALTER ROLE meta_ads_stg_backup NOLOGIN;
COMMIT;

SELECT pg_catalog.jsonb_build_object(
  'status', 'CONTAINED_NOLOGIN_EXISTING_SESSIONS_NOT_TERMINATED',
  'login_role_count', count(*) FILTER (WHERE rolcanlogin),
  'role_count', count(*)
) AS containment_json
FROM pg_roles
WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup');
