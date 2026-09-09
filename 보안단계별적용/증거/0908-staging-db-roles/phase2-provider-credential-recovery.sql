\set ON_ERROR_STOP on
\set ECHO none
\set ECHO_HIDDEN off
\pset pager off

\echo G_DB_00_PHASE2_CREDENTIAL_RECOVERY_BEGIN

BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '30s';
SET LOCAL password_encryption = 'scram-sha-256';

SELECT set_config('r2a.expected_database_oid', :'expected_database_oid', true);
SELECT set_config('r2a.expected_runtime_oid', :'expected_runtime_oid', true);
SELECT set_config('r2a.expected_migration_oid', :'expected_migration_oid', true);
SELECT set_config('r2a.expected_backup_oid', :'expected_backup_oid', true);
SELECT set_config('r2a.expected_base_acl_md5', :'expected_base_acl_md5', true);

DO $phase2_recovery_precondition$
DECLARE
  database_oid oid;
  creator_edge_count integer;
  forbidden_membership_count integer;
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_PRE_PRINCIPAL_MISMATCH';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_PRE_POSTGRES_MAJOR_MISMATCH';
  END IF;
  IF current_setting('password_encryption') <> 'scram-sha-256' THEN
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_PRE_PASSWORD_ENCRYPTION_MISMATCH';
  END IF;
  IF current_setting('scram_iterations')::integer <> 4096 THEN
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_PRE_SCRAM_ITERATIONS_MISMATCH';
  END IF;
  IF md5(COALESCE((SELECT datacl::text FROM pg_database WHERE datname = 'postgres'), '<NULL>'))
      IS DISTINCT FROM current_setting('r2a.expected_base_acl_md5') THEN
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_PRE_BASE_ACL_MISMATCH';
  END IF;

  SELECT oid INTO STRICT database_oid
  FROM pg_database
  WHERE datname = 'meta_ads_staging'
    AND oid = current_setting('r2a.expected_database_oid')::oid
    AND pg_get_userbyid(datdba) = 'meta_ads_stg_migration'
    AND datallowconn;

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
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_PRE_ROLE_ATTRIBUTE_OR_OID_MISMATCH';
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
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_PRE_ROLE_MEMBERSHIP_MISMATCH';
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
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_PRE_ROLE_MEMBERSHIP_CARDINALITY_MISMATCH';
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
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_PRE_DATABASE_ACL_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM pg_stat_activity WHERE datname = 'meta_ads_staging') <> 0 THEN
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_PRE_TARGET_SESSION_PRESENT';
  END IF;
END
$phase2_recovery_precondition$;

-- The runner derives three PostgreSQL-format SCRAM verifiers client-side with independent
-- random salts. Only those verifiers arrive through redirected standard input; plaintext never
-- enters psql, SQL, argv, the container environment, or the wire. With -f, \prompt reads stdin.
\prompt '' runtime_scram_verifier
\prompt '' migration_scram_verifier
\prompt '' backup_scram_verifier
ALTER ROLE meta_ads_stg_runtime PASSWORD :'runtime_scram_verifier';
\unset runtime_scram_verifier
ALTER ROLE meta_ads_stg_migration PASSWORD :'migration_scram_verifier';
\unset migration_scram_verifier
ALTER ROLE meta_ads_stg_backup PASSWORD :'backup_scram_verifier';
\unset backup_scram_verifier

DO $phase2_recovery_postcondition$
BEGIN
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
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_POST_ROLE_ATTRIBUTE_OR_OID_MISMATCH';
  END IF;
  IF md5(COALESCE((SELECT datacl::text FROM pg_database WHERE datname = 'postgres'), '<NULL>'))
      IS DISTINCT FROM current_setting('r2a.expected_base_acl_md5') THEN
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_POST_BASE_ACL_CHANGED';
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
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_POST_ROLE_MEMBERSHIP_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM pg_stat_activity WHERE datname = 'meta_ads_staging') <> 0 THEN
    RAISE EXCEPTION 'R2A_PHASE2_RECOVERY_POST_TARGET_SESSION_PRESENT';
  END IF;
END
$phase2_recovery_postcondition$;

SELECT 'PHASE2_CREDENTIAL_RECOVERY_TX_READY' AS status;
COMMIT;

\echo G_DB_00_PHASE2_CREDENTIAL_RECOVERY_COMMITTED
