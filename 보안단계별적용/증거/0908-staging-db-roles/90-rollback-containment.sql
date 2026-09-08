\set ON_ERROR_STOP on
\pset pager off

-- Non-destructive containment. It blocks new database connections and role logins.
-- It does not terminate existing sessions or delete data.
-- Required psql variables:
--   expected_database_oid, expected_runtime_oid, expected_migration_oid, expected_backup_oid

\if :{?expected_database_oid}
\else
  \set expected_database_oid '0'
\endif
\if :{?expected_runtime_oid}
\else
  \set expected_runtime_oid '0'
\endif
\if :{?expected_migration_oid}
\else
  \set expected_migration_oid '0'
\endif
\if :{?expected_backup_oid}
\else
  \set expected_backup_oid '0'
\endif

\connect -reuse-previous=on postgres

BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;

-- Division by zero is deliberate fail-closed behavior for missing/non-numeric receipt OIDs.
SELECT CASE WHEN
  :'expected_database_oid' ~ '^[1-9][0-9]*$'
  AND :'expected_runtime_oid' ~ '^[1-9][0-9]*$'
  AND :'expected_migration_oid' ~ '^[1-9][0-9]*$'
  AND :'expected_backup_oid' ~ '^[1-9][0-9]*$'
THEN 1 ELSE 1 / 0 END AS containment_input_guard;

SELECT set_config('r2a.expected_database_oid', :'expected_database_oid', true);
SELECT set_config('r2a.expected_runtime_oid', :'expected_runtime_oid', true);
SELECT set_config('r2a.expected_migration_oid', :'expected_migration_oid', true);
SELECT set_config('r2a.expected_backup_oid', :'expected_backup_oid', true);

DO $guard$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_CONTAINMENT_TARGET_PRINCIPAL_MISMATCH';
  END IF;
  IF (SELECT oid::text FROM pg_database WHERE datname = 'meta_ads_staging')
      IS DISTINCT FROM current_setting('r2a.expected_database_oid') OR
     (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'meta_ads_staging')
      IS DISTINCT FROM 'meta_ads_stg_migration' THEN
    RAISE EXCEPTION 'R2A_CONTAINMENT_DATABASE_IDENTITY_MISMATCH';
  END IF;
  IF (SELECT oid::text FROM pg_roles WHERE rolname = 'meta_ads_stg_runtime')
      IS DISTINCT FROM current_setting('r2a.expected_runtime_oid') OR
     (SELECT oid::text FROM pg_roles WHERE rolname = 'meta_ads_stg_migration')
      IS DISTINCT FROM current_setting('r2a.expected_migration_oid') OR
     (SELECT oid::text FROM pg_roles WHERE rolname = 'meta_ads_stg_backup')
      IS DISTINCT FROM current_setting('r2a.expected_backup_oid') THEN
    RAISE EXCEPTION 'R2A_CONTAINMENT_ROLE_IDENTITY_MISMATCH';
  END IF;
END
$guard$;

GRANT meta_ads_stg_migration TO postgres WITH SET TRUE, INHERIT FALSE;
SET LOCAL ROLE meta_ads_stg_migration;
ALTER DATABASE meta_ads_staging ALLOW_CONNECTIONS false;
RESET ROLE;
REVOKE meta_ads_stg_migration FROM postgres GRANTED BY postgres;
ALTER ROLE meta_ads_stg_runtime NOLOGIN;
ALTER ROLE meta_ads_stg_migration NOLOGIN;
ALTER ROLE meta_ads_stg_backup NOLOGIN;
COMMIT;

SELECT pg_catalog.jsonb_build_object(
  'status', 'CONTAINED_DATABASE_CLOSED_ROLES_NOLOGIN_EXISTING_SESSIONS_NOT_TERMINATED',
  'database_allow_connections', (
    SELECT datallowconn FROM pg_database WHERE datname = 'meta_ads_staging'
  ),
  'login_role_count', count(*) FILTER (WHERE rolcanlogin),
  'role_count', count(*),
  'temporary_self_set_edge_count', (
    SELECT count(*) FROM pg_auth_members
    WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = 'meta_ads_stg_migration')
      AND member = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
      AND grantor = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
  )
) AS containment_json
FROM pg_roles
WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup');
