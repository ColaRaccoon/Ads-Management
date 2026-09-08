\set ON_ERROR_STOP on
\pset pager off

-- NEVER run under a bootstrap/migration approval. A new destructive rollback approval is required.
-- Required psql variables:
--   destructive_confirm = DROP_META_ADS_STAGING_EXACT_V1
--   backup_receipt_sha256 = 64 lowercase hexadecimal characters
--   expected_database_oid, expected_runtime_oid, expected_migration_oid, expected_backup_oid

\if :{?destructive_confirm}
\else
  \set destructive_confirm ''
\endif
\if :{?backup_receipt_sha256}
\else
  \set backup_receipt_sha256 ''
\endif
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

SET statement_timeout = '30s';
SET lock_timeout = '2s';
SET search_path = pg_catalog;

-- Division by zero is deliberate fail-closed behavior when any approval input is missing or invalid.
SELECT CASE WHEN
  :'destructive_confirm' = 'DROP_META_ADS_STAGING_EXACT_V1'
  AND :'backup_receipt_sha256' ~ '^[a-f0-9]{64}$'
  AND :'expected_database_oid' ~ '^[1-9][0-9]*$'
  AND :'expected_runtime_oid' ~ '^[1-9][0-9]*$'
  AND :'expected_migration_oid' ~ '^[1-9][0-9]*$'
  AND :'expected_backup_oid' ~ '^[1-9][0-9]*$'
THEN 1 ELSE 1 / 0 END AS destructive_input_guard;

SELECT set_config('r2a.expected_database_oid', :'expected_database_oid', false);
SELECT set_config('r2a.expected_runtime_oid', :'expected_runtime_oid', false);
SELECT set_config('r2a.expected_migration_oid', :'expected_migration_oid', false);
SELECT set_config('r2a.expected_backup_oid', :'expected_backup_oid', false);

DO $guard$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_DESTRUCTIVE_TARGET_PRINCIPAL_MISMATCH';
  END IF;
  IF (SELECT oid::text FROM pg_database WHERE datname = 'meta_ads_staging')
      IS DISTINCT FROM current_setting('r2a.expected_database_oid') THEN
    RAISE EXCEPTION 'R2A_DESTRUCTIVE_DATABASE_OID_MISMATCH';
  END IF;
  IF (SELECT oid::text FROM pg_roles WHERE rolname = 'meta_ads_stg_runtime')
      IS DISTINCT FROM current_setting('r2a.expected_runtime_oid')
    OR (SELECT oid::text FROM pg_roles WHERE rolname = 'meta_ads_stg_migration')
      IS DISTINCT FROM current_setting('r2a.expected_migration_oid')
    OR (SELECT oid::text FROM pg_roles WHERE rolname = 'meta_ads_stg_backup')
      IS DISTINCT FROM current_setting('r2a.expected_backup_oid') THEN
    RAISE EXCEPTION 'R2A_DESTRUCTIVE_ROLE_OID_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
      AND rolcanlogin
  ) THEN
    RAISE EXCEPTION 'R2A_DESTRUCTIVE_ROLE_NOT_CONTAINED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = 'meta_ads_staging') THEN
    RAISE EXCEPTION 'R2A_DESTRUCTIVE_ACTIVE_SESSION_PRESENT';
  END IF;
END
$guard$;

-- Intentionally no FORCE, CASCADE, DROP OWNED, or REASSIGN OWNED.
-- The creator adds an exact temporary SET edge because the app DB is owned by the migration role.
GRANT meta_ads_stg_migration TO postgres WITH SET TRUE, INHERIT FALSE;
SET ROLE meta_ads_stg_migration;
DROP DATABASE meta_ads_staging;
RESET ROLE;
REVOKE meta_ads_stg_migration FROM postgres GRANTED BY postgres;

BEGIN;
DROP ROLE meta_ads_stg_runtime;
DROP ROLE meta_ads_stg_backup;
DROP ROLE meta_ads_stg_migration;
COMMIT;

RESET statement_timeout;
RESET lock_timeout;
RESET search_path;

SELECT pg_catalog.jsonb_build_object(
  'status', 'DESTRUCTIVE_ROLLBACK_COMPLETED',
  'database_count', (SELECT count(*) FROM pg_database WHERE datname = 'meta_ads_staging'),
  'role_count', (
    SELECT count(*) FROM pg_roles
    WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
  )
) AS destructive_rollback_json;
