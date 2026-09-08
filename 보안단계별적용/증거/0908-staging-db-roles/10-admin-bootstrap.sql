\set ON_ERROR_STOP on
\pset pager off

-- Run only after 00-admin-preflight.sql and an exact G-DB-00 phase-1 approval.
-- CREATE DATABASE must remain outside a transaction.

BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;

DO $guard$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_BOOTSTRAP_TARGET_PRINCIPAL_MISMATCH';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'R2A_BOOTSTRAP_POSTGRES_MAJOR_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
  ) OR EXISTS (SELECT 1 FROM pg_database WHERE datname = 'meta_ads_staging') THEN
    RAISE EXCEPTION 'R2A_BOOTSTRAP_TARGET_COLLISION';
  END IF;
END
$guard$;

CREATE ROLE meta_ads_stg_runtime
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
CREATE ROLE meta_ads_stg_migration
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
CREATE ROLE meta_ads_stg_backup
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;

-- PG17 gives a non-superuser CREATEROLE creator an ADMIN/NOSET management edge.
-- A separate self-granted SET edge is temporary and removed in 20-app-bootstrap.sql.
GRANT meta_ads_stg_migration TO postgres WITH SET TRUE, INHERIT FALSE;
COMMIT;

SET statement_timeout = '30s';
SET lock_timeout = '2s';
SET search_path = pg_catalog;
CREATE DATABASE meta_ads_staging
  OWNER meta_ads_stg_migration
  TEMPLATE template0
  ENCODING 'UTF8'
  ALLOW_CONNECTIONS false;

BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL ROLE meta_ads_stg_migration;
REVOKE ALL PRIVILEGES ON DATABASE meta_ads_staging FROM PUBLIC;
GRANT CONNECT ON DATABASE meta_ads_staging
  TO postgres, meta_ads_stg_runtime, meta_ads_stg_migration, meta_ads_stg_backup;
ALTER DATABASE meta_ads_staging SET search_path = public, pg_catalog;
ALTER DATABASE meta_ads_staging ALLOW_CONNECTIONS true;
COMMIT;
RESET statement_timeout;
RESET lock_timeout;
RESET search_path;

SELECT pg_catalog.jsonb_build_object(
  'status', 'ADMIN_BOOTSTRAP_PARTIAL_PENDING_APP_BOOTSTRAP',
  'database', d.datname,
  'database_owner', pg_get_userbyid(d.datdba),
  'allow_connections', d.datallowconn,
  'roles', (
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', r.rolname,
      'login', r.rolcanlogin,
      'inherit', r.rolinherit,
      'superuser', r.rolsuper,
      'create_db', r.rolcreatedb,
      'create_role', r.rolcreaterole,
      'replication', r.rolreplication,
      'bypass_rls', r.rolbypassrls,
      'connection_limit', r.rolconnlimit
    ) ORDER BY r.rolname)
    FROM pg_roles r
    WHERE r.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
  )
) AS bootstrap_json
FROM pg_database d
WHERE d.datname = 'meta_ads_staging';
