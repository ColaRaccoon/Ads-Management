\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = pg_catalog;
DO $inspect_guard$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_PHASE1_INSPECT_TARGET_PRINCIPAL_MISMATCH';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'R2A_PHASE1_INSPECT_POSTGRES_MAJOR_MISMATCH';
  END IF;
END
$inspect_guard$;
SELECT jsonb_build_object(
  'status', 'PHASE1_FAILURE_READ_ONLY_INSPECTION',
  'database', (SELECT jsonb_build_object(
    'oid', oid, 'owner', pg_get_userbyid(datdba), 'allow_connections', datallowconn)
    FROM pg_database WHERE datname = 'meta_ads_staging'),
  'roles', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name', rolname, 'oid', oid, 'login', rolcanlogin, 'inherit', rolinherit,
    'superuser', rolsuper, 'create_db', rolcreatedb, 'create_role', rolcreaterole,
    'replication', rolreplication, 'bypass_rls', rolbypassrls,
    'connection_limit', rolconnlimit) ORDER BY rolname)
    FROM pg_roles WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')), '[]'::jsonb),
  'expected_memberships', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'granted_role', granted_role.rolname, 'member', 'postgres',
    'grantor_class', CASE WHEN grantor_role.rolname = 'postgres' THEN 'SELF' ELSE 'NON_SELF' END,
    'admin', m.admin_option,
    'inherit', m.inherit_option, 'set', m.set_option)
    ORDER BY granted_role.rolname, grantor_role.oid)
    FROM pg_auth_members m
    JOIN pg_roles granted_role ON granted_role.oid = m.roleid
    JOIN pg_roles member_role ON member_role.oid = m.member
    JOIN pg_roles grantor_role ON grantor_role.oid = m.grantor
    WHERE granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
      AND member_role.rolname = 'postgres'), '[]'::jsonb),
  'unexpected_membership_count', (SELECT count(*)
    FROM pg_auth_members m
    JOIN pg_roles granted_role ON granted_role.oid = m.roleid
    JOIN pg_roles member_role ON member_role.oid = m.member
    WHERE (granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
        OR member_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup'))
      AND NOT (granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
        AND member_role.rolname = 'postgres')),
  'target_active_session_count', (SELECT count(*) FROM pg_stat_activity WHERE datname = 'meta_ads_staging'),
  'base_acl_md5', md5(COALESCE((SELECT datacl::text FROM pg_database WHERE datname = 'postgres'), '<NULL>'))
) AS phase1_failure_inspection_json;
ROLLBACK;
