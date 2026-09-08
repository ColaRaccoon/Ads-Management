\set ON_ERROR_STOP on
\pset pager off

\connect -reuse-previous=on postgres
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = pg_catalog;
SELECT set_config('r2a.expected_base_acl_md5', :'expected_base_acl_md5', true);

DO $base_verify$
DECLARE
  database_oid oid;
  creator_edge_count integer;
  forbidden_membership_count integer;
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_BASE_PRINCIPAL_MISMATCH';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_POSTGRES_MAJOR_MISMATCH';
  END IF;
  IF md5(COALESCE((SELECT datacl::text FROM pg_database WHERE datname = 'postgres'), '<NULL>'))
      IS DISTINCT FROM current_setting('r2a.expected_base_acl_md5') THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_BASE_ACL_CHANGED';
  END IF;
  IF (SELECT count(*)
      FROM pg_database d
      CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
      WHERE d.datname = 'postgres' AND acl.grantee = 0
        AND acl.privilege_type IN ('CONNECT', 'TEMPORARY')) <> 2 THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_BASE_PUBLIC_ACL_MISMATCH';
  END IF;

  SELECT oid INTO STRICT database_oid
  FROM pg_database
  WHERE datname = 'meta_ads_staging'
    AND pg_get_userbyid(datdba) = 'meta_ads_stg_migration'
    AND datallowconn;

  IF (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
        AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
        AND rolconnlimit = 2) <> 3 THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_ROLE_ATTRIBUTE_MISMATCH';
  END IF;

  SELECT count(*) INTO creator_edge_count
  FROM pg_auth_members m
  JOIN pg_roles granted_role ON granted_role.oid = m.roleid
  JOIN pg_roles member_role ON member_role.oid = m.member
  WHERE granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
    AND member_role.rolname = 'postgres'
    AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option;

  SELECT count(*) INTO forbidden_membership_count
  FROM pg_auth_members m
  JOIN pg_roles granted_role ON granted_role.oid = m.roleid
  JOIN pg_roles member_role ON member_role.oid = m.member
  WHERE (granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
      OR member_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup'))
    AND NOT (
      granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
      AND member_role.rolname = 'postgres'
      AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option
    );
  IF creator_edge_count <> 3 OR forbidden_membership_count <> 0 THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_ROLE_MEMBERSHIP_MISMATCH';
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
        WHERE granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
          AND member_role.rolname = 'postgres' AND grantor_role.rolname = 'postgres'
      ) THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_ROLE_MEMBERSHIP_CARDINALITY_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_database d
    CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE d.oid = database_oid
      AND (acl.grantee = 0 OR NOT (
        grantee.rolname = 'meta_ads_stg_migration'
        AND acl.privilege_type IN ('CONNECT', 'CREATE', 'TEMPORARY')
        OR grantee.rolname IN ('postgres', 'meta_ads_stg_runtime', 'meta_ads_stg_backup')
        AND acl.privilege_type = 'CONNECT' AND NOT acl.is_grantable
      ))
  ) THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_DATABASE_ACL_UNEXPECTED';
  END IF;
  IF NOT has_database_privilege('postgres', 'meta_ads_staging', 'CONNECT')
      OR NOT has_database_privilege('meta_ads_stg_runtime', 'meta_ads_staging', 'CONNECT')
      OR has_database_privilege('meta_ads_stg_runtime', 'meta_ads_staging', 'CREATE')
      OR has_database_privilege('meta_ads_stg_runtime', 'meta_ads_staging', 'TEMPORARY')
      OR NOT has_database_privilege('meta_ads_stg_backup', 'meta_ads_staging', 'CONNECT')
      OR has_database_privilege('meta_ads_stg_backup', 'meta_ads_staging', 'CREATE')
      OR has_database_privilege('meta_ads_stg_backup', 'meta_ads_staging', 'TEMPORARY') THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_DATABASE_PRIVILEGE_MISMATCH';
  END IF;
END
$base_verify$;

SELECT jsonb_build_object(
  'status', 'PHASE1_BASE_POSTCONDITION_PASS',
  'base_acl_before_md5', current_setting('r2a.expected_base_acl_md5'),
  'base_acl_after_md5', md5(COALESCE((SELECT datacl::text FROM pg_database WHERE datname = 'postgres'), '<NULL>')),
  'database_oid', (SELECT oid FROM pg_database WHERE datname = 'meta_ads_staging'),
  'database_owner', (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'meta_ads_staging'),
  'database_allow_connections', (SELECT datallowconn FROM pg_database WHERE datname = 'meta_ads_staging'),
  'roles', (SELECT jsonb_agg(jsonb_build_object(
    'name', rolname, 'oid', oid, 'login', rolcanlogin, 'inherit', rolinherit,
    'superuser', rolsuper, 'create_db', rolcreatedb, 'create_role', rolcreaterole,
    'replication', rolreplication, 'bypass_rls', rolbypassrls,
    'connection_limit', rolconnlimit) ORDER BY rolname)
    FROM pg_roles WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')),
  'creator_edge_count', (SELECT count(*) FROM pg_auth_members m
    JOIN pg_roles granted_role ON granted_role.oid = m.roleid
    JOIN pg_roles member_role ON member_role.oid = m.member
    WHERE granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
      AND member_role.rolname = 'postgres'
      AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option),
  'target_active_session_count', (SELECT count(*) FROM pg_stat_activity
    WHERE datname = 'meta_ads_staging')
) AS phase1_base_postcondition_json;
ROLLBACK;

\connect -reuse-previous=on meta_ads_staging
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = pg_catalog;

DO $app_verify$
DECLARE
  database_oid oid;
  migration_oid oid;
BEGIN
  IF current_database() <> 'meta_ads_staging' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_APP_PRINCIPAL_MISMATCH';
  END IF;
  SELECT oid INTO STRICT database_oid FROM pg_database WHERE datname = 'meta_ads_staging';
  SELECT oid INTO STRICT migration_oid FROM pg_roles WHERE rolname = 'meta_ads_stg_migration';
  IF pg_get_userbyid((SELECT datdba FROM pg_database WHERE oid = database_oid)) <> 'meta_ads_stg_migration'
      OR pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'public')) <> 'meta_ads_stg_migration' THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_OWNER_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM pg_db_role_setting s
      CROSS JOIN LATERAL unnest(s.setconfig) setting
      WHERE s.setdatabase = database_oid AND s.setrole = 0
        AND setting = 'search_path=public, pg_catalog') <> 1
      OR (SELECT count(*) FROM pg_db_role_setting s
          CROSS JOIN LATERAL unnest(s.setconfig) setting
          WHERE s.setdatabase = database_oid) <> 1 THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_DATABASE_SETTING_MISMATCH';
  END IF;
  IF EXISTS (
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
    RAISE EXCEPTION 'R2A_PHASE1_POST_SCHEMA_ACL_UNEXPECTED';
  END IF;
  IF NOT has_schema_privilege('meta_ads_stg_runtime', 'public', 'USAGE')
      OR has_schema_privilege('meta_ads_stg_runtime', 'public', 'CREATE')
      OR NOT has_schema_privilege('meta_ads_stg_backup', 'public', 'USAGE')
      OR has_schema_privilege('meta_ads_stg_backup', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'R2A_PHASE1_POST_SCHEMA_PRIVILEGE_MISMATCH';
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
    RAISE EXCEPTION 'R2A_PHASE1_POST_DEFAULT_ACL_MISMATCH';
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
    RAISE EXCEPTION 'R2A_PHASE1_POST_SCHEMA_NOT_PRISTINE';
  END IF;
END
$app_verify$;

SELECT jsonb_build_object(
  'status', 'PHASE1_APP_POSTCONDITION_PASS',
  'database', current_database(),
  'current_user', current_user,
  'session_user', session_user,
  'schema_owner', (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'),
  'public_relation_count', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')),
  'public_enum_count', (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'),
  'public_routine_count', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')),
  'public_user_trigger_count', (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal),
  'migration_global_default_acl_count', (SELECT count(*) FROM pg_default_acl
    WHERE defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'meta_ads_stg_migration')
      AND defaclnamespace = 0 AND defaclobjtype IN ('f', 'T'))
) AS phase1_app_postcondition_json;
ROLLBACK;
