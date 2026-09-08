\set ON_ERROR_STOP on
\pset pager off

BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = pg_catalog;

DO $preflight$
DECLARE
  admin_row pg_roles%ROWTYPE;
  target_role_count integer;
  target_database_count integer;
  public_connect boolean;
  public_temporary boolean;
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_PREFLIGHT_TARGET_PRINCIPAL_MISMATCH';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'R2A_PREFLIGHT_POSTGRES_MAJOR_MISMATCH';
  END IF;
  SELECT * INTO STRICT admin_row FROM pg_roles WHERE rolname = 'postgres';
  IF admin_row.rolsuper OR NOT admin_row.rolcreatedb OR NOT admin_row.rolcreaterole THEN
    RAISE EXCEPTION 'R2A_PREFLIGHT_ADMIN_CAPABILITY_MISMATCH';
  END IF;
  SELECT count(*) INTO target_role_count
  FROM pg_roles
  WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup');
  SELECT count(*) INTO target_database_count
  FROM pg_database
  WHERE datname = 'meta_ads_staging';
  IF target_role_count <> 0 OR target_database_count <> 0 THEN
    RAISE EXCEPTION 'R2A_PREFLIGHT_TARGET_COLLISION';
  END IF;
  SELECT
    COALESCE(bool_or(privilege_type = 'CONNECT'), false),
    COALESCE(bool_or(privilege_type = 'TEMPORARY'), false)
  INTO public_connect, public_temporary
  FROM pg_database d
  CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
  WHERE d.datname = 'postgres' AND acl.grantee = 0;
  IF NOT public_connect OR NOT public_temporary THEN
    RAISE EXCEPTION 'R2A_PREFLIGHT_BASE_PUBLIC_ACL_DRIFT';
  END IF;
END
$preflight$;

SELECT pg_catalog.jsonb_build_object(
  'status', 'PREFLIGHT_PASS_NO_MUTATION',
  'database', current_database(),
  'current_user', current_user,
  'session_user', session_user,
  'server_version_num', current_setting('server_version_num'),
  'target_role_count', (
    SELECT count(*) FROM pg_roles
    WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
  ),
  'target_database_count', (
    SELECT count(*) FROM pg_database WHERE datname = 'meta_ads_staging'
  ),
  'base_postgres_public_connect', true,
  'base_postgres_public_temporary', true,
  'transaction_read_only', current_setting('transaction_read_only'),
  'project_ref_proof', 'NOT_PROVABLE_BY_SQL_BIND_ENDPOINT_RECEIPT'
) AS preflight_json;

ROLLBACK;
