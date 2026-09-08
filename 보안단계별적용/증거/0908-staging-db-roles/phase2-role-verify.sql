\set ON_ERROR_STOP on
\set ECHO none
\set ECHO_HIDDEN off
\pset pager off

BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '8s';
SET LOCAL lock_timeout = '1s';

SELECT set_config('r2a.expected_role', :'expected_role', true);
SELECT set_config('r2a.expected_role_oid', :'expected_role_oid', true);

DO $role_verify$
DECLARE
  expected_role text := current_setting('r2a.expected_role');
  expected_oid oid := current_setting('r2a.expected_role_oid')::oid;
  is_migration boolean := expected_role = 'meta_ads_stg_migration';
  migration_oid oid;
BEGIN
  IF expected_role NOT IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup') THEN
    RAISE EXCEPTION 'R2A_PHASE2_VERIFY_ROLE_NOT_ALLOWLISTED';
  END IF;
  IF current_database() <> 'meta_ads_staging'
      OR current_user <> expected_role OR session_user <> expected_role THEN
    RAISE EXCEPTION 'R2A_PHASE2_VERIFY_PRINCIPAL_OR_DATABASE_MISMATCH';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'R2A_PHASE2_VERIFY_POSTGRES_MAJOR_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM pg_roles
      WHERE rolname = expected_role AND oid = expected_oid
        AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
        AND rolconnlimit = 2) <> 1 THEN
    RAISE EXCEPTION 'R2A_PHASE2_VERIFY_ROLE_ATTRIBUTE_OR_OID_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM pg_stat_ssl
      WHERE pid = pg_backend_pid() AND ssl
        AND version IN ('TLSv1.2', 'TLSv1.3')
        AND cipher IS NOT NULL AND length(cipher) > 0) <> 1 THEN
    RAISE EXCEPTION 'R2A_PHASE2_VERIFY_TLS_MISMATCH';
  END IF;
  IF NOT has_database_privilege(expected_role, 'meta_ads_staging', 'CONNECT')
      OR has_database_privilege(expected_role, 'meta_ads_staging', 'CREATE') <> is_migration
      OR has_database_privilege(expected_role, 'meta_ads_staging', 'TEMPORARY') <> is_migration
      OR NOT has_schema_privilege(expected_role, 'public', 'USAGE')
      OR has_schema_privilege(expected_role, 'public', 'CREATE') <> is_migration THEN
    RAISE EXCEPTION 'R2A_PHASE2_VERIFY_DATABASE_OR_SCHEMA_PRIVILEGE_MISMATCH';
  END IF;
  IF pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = 'meta_ads_staging'))
      <> 'meta_ads_stg_migration'
      OR pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'public'))
      <> 'meta_ads_stg_migration' THEN
    RAISE EXCEPTION 'R2A_PHASE2_VERIFY_OWNER_MISMATCH';
  END IF;
  SELECT oid INTO STRICT migration_oid FROM pg_roles WHERE rolname = 'meta_ads_stg_migration';
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
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE n.nspname = 'public'
      AND (acl.grantee = 0 OR NOT (
        grantee.rolname = 'meta_ads_stg_migration' AND acl.privilege_type IN ('USAGE', 'CREATE')
        OR grantee.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_backup')
        AND acl.privilege_type = 'USAGE' AND NOT acl.is_grantable
      ))
  ) THEN
    RAISE EXCEPTION 'R2A_PHASE2_VERIFY_DATABASE_OR_SCHEMA_ACL_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM pg_default_acl
      WHERE defaclrole = migration_oid AND defaclnamespace = 0
        AND defaclobjtype IN ('f', 'T')) <> 2
      OR EXISTS (SELECT 1 FROM pg_default_acl WHERE defaclrole <> migration_oid)
      OR EXISTS (SELECT 1 FROM pg_default_acl
          WHERE defaclrole = migration_oid
            AND (defaclnamespace <> 0 OR defaclobjtype NOT IN ('f', 'T')))
      OR EXISTS (SELECT 1 FROM pg_default_acl d
          CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
          WHERE d.defaclrole = migration_oid AND acl.grantee <> migration_oid) THEN
    RAISE EXCEPTION 'R2A_PHASE2_VERIFY_DEFAULT_ACL_MISMATCH';
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
    RAISE EXCEPTION 'R2A_PHASE2_VERIFY_ROLE_MEMBERSHIP_MISMATCH';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f'))
      OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typtype = 'e')
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p'))
      OR EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'R2A_PHASE2_VERIFY_SCHEMA_NOT_PRISTINE';
  END IF;
END
$role_verify$;

PREPARE r2a_phase2_session_probe AS
SELECT current_user, session_user, current_database();
EXECUTE r2a_phase2_session_probe;
DEALLOCATE r2a_phase2_session_probe;

SELECT jsonb_build_object(
  'status', 'PHASE2_ROLE_VERIFY_PASS',
  'database', current_database(),
  'current_user', current_user,
  'session_user', session_user,
  'role_oid', (SELECT oid FROM pg_roles WHERE rolname = current_user),
  'ssl', (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
  'tls_version', (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
  'named_prepare_execute_deallocate', true
) AS phase2_role_verify_json;
ROLLBACK;
