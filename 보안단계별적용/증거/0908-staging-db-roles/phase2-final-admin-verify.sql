\set ON_ERROR_STOP on
\set ECHO none
\set ECHO_HIDDEN off
\pset pager off

BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '8s';
SET LOCAL lock_timeout = '1s';

SELECT set_config('r2a.expected_database_oid', :'expected_database_oid', true);
SELECT set_config('r2a.expected_runtime_oid', :'expected_runtime_oid', true);
SELECT set_config('r2a.expected_migration_oid', :'expected_migration_oid', true);
SELECT set_config('r2a.expected_backup_oid', :'expected_backup_oid', true);
SELECT set_config('r2a.expected_base_acl_md5', :'expected_base_acl_md5', true);

DO $final_admin_verify$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_PHASE2_FINAL_PRINCIPAL_MISMATCH';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'R2A_PHASE2_FINAL_POSTGRES_MAJOR_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM pg_database
      WHERE datname = 'meta_ads_staging'
        AND oid = current_setting('r2a.expected_database_oid')::oid
        AND pg_get_userbyid(datdba) = 'meta_ads_stg_migration'
        AND datallowconn) <> 1 THEN
    RAISE EXCEPTION 'R2A_PHASE2_FINAL_DATABASE_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM pg_roles
      WHERE (rolname = 'meta_ads_stg_runtime'
          AND oid = current_setting('r2a.expected_runtime_oid')::oid
          OR rolname = 'meta_ads_stg_migration'
          AND oid = current_setting('r2a.expected_migration_oid')::oid
          OR rolname = 'meta_ads_stg_backup'
          AND oid = current_setting('r2a.expected_backup_oid')::oid)
        AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
        AND rolconnlimit = 2) <> 3 THEN
    RAISE EXCEPTION 'R2A_PHASE2_FINAL_ROLE_ATTRIBUTE_OR_OID_MISMATCH';
  END IF;
  IF md5(COALESCE((SELECT datacl::text FROM pg_database WHERE datname = 'postgres'), '<NULL>'))
      IS DISTINCT FROM current_setting('r2a.expected_base_acl_md5') THEN
    RAISE EXCEPTION 'R2A_PHASE2_FINAL_BASE_ACL_CHANGED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_database d
    CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE d.datname = 'meta_ads_staging'
      AND (acl.grantee = 0 OR NOT (
        grantee.rolname = 'meta_ads_stg_migration'
        AND acl.privilege_type IN ('CONNECT', 'CREATE', 'TEMPORARY')
        OR grantee.rolname IN ('postgres', 'meta_ads_stg_runtime', 'meta_ads_stg_backup')
        AND acl.privilege_type = 'CONNECT' AND NOT acl.is_grantable
      ))
  ) THEN
    RAISE EXCEPTION 'R2A_PHASE2_FINAL_DATABASE_ACL_MISMATCH';
  END IF;
  IF (SELECT count(DISTINCT granted_role.rolname)
      FROM pg_auth_members m
      JOIN pg_roles granted_role ON granted_role.oid = m.roleid
      JOIN pg_roles member_role ON member_role.oid = m.member
      WHERE granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
        AND member_role.rolname = 'postgres'
        AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option) <> 3
      OR EXISTS (
        SELECT 1 FROM pg_auth_members m
        JOIN pg_roles granted_role ON granted_role.oid = m.roleid
        JOIN pg_roles member_role ON member_role.oid = m.member
        JOIN pg_roles grantor_role ON grantor_role.oid = m.grantor
        WHERE (granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
          OR member_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup'))
          AND NOT (
            granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
            AND member_role.rolname = 'postgres'
            AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option
          )
      ) THEN
    RAISE EXCEPTION 'R2A_PHASE2_FINAL_ROLE_MEMBERSHIP_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM pg_stat_activity WHERE datname = 'meta_ads_staging') <> 0 THEN
    RAISE EXCEPTION 'R2A_PHASE2_FINAL_TARGET_SESSION_PRESENT';
  END IF;
END
$final_admin_verify$;

SELECT jsonb_build_object(
  'status', 'PHASE2_FINAL_ADMIN_VERIFY_PASS',
  'database_oid', (SELECT oid FROM pg_database WHERE datname = 'meta_ads_staging'),
  'role_login_count', (SELECT count(*) FROM pg_roles
    WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
      AND rolcanlogin),
  'target_session_count', (SELECT count(*) FROM pg_stat_activity WHERE datname = 'meta_ads_staging'),
  'base_acl_md5', md5(COALESCE((SELECT datacl::text FROM pg_database WHERE datname = 'postgres'), '<NULL>'))
) AS phase2_final_admin_verify_json;
ROLLBACK;
