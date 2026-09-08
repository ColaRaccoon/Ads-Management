\set ON_ERROR_STOP on
\pset pager off

-- The same direct endpoint and postgres session must be bound to the approved staging receipt.
\connect meta_ads_staging postgres

BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;

DO $guard$
BEGIN
  IF current_database() <> 'meta_ads_staging' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_APP_BOOTSTRAP_TARGET_PRINCIPAL_MISMATCH';
  END IF;
  IF pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database())) <>
      'meta_ads_stg_migration' THEN
    RAISE EXCEPTION 'R2A_APP_BOOTSTRAP_OWNER_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  ) OR EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
  ) THEN
    RAISE EXCEPTION 'R2A_APP_BOOTSTRAP_SCHEMA_NOT_PRISTINE';
  END IF;
END
$guard$;

SET LOCAL ROLE meta_ads_stg_migration;
ALTER SCHEMA public OWNER TO meta_ads_stg_migration;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO meta_ads_stg_runtime, meta_ads_stg_backup;

-- Function EXECUTE and type USAGE have global PUBLIC defaults. PostgreSQL does not let a
-- per-schema REVOKE override those global defaults, so all four revokes are database-global
-- for objects later created by this role in this otherwise dedicated application database.
ALTER DEFAULT PRIVILEGES FOR ROLE meta_ads_stg_migration
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE meta_ads_stg_migration
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE meta_ads_stg_migration
  REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE meta_ads_stg_migration
  REVOKE ALL PRIVILEGES ON TYPES FROM PUBLIC;
COMMIT;

-- Remove only the temporary self-granted SET edge. The creator management ADMIN/NOSET edge remains.
\connect postgres postgres
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;
REVOKE meta_ads_stg_migration FROM postgres GRANTED BY postgres;
COMMIT;

SELECT pg_catalog.jsonb_build_object(
  'status', 'APP_BOOTSTRAP_PASS_NOLOGIN',
  'database', 'meta_ads_staging',
  'roles_login_count', (
    SELECT count(*) FROM pg_roles
    WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
      AND rolcanlogin
  ),
  'temporary_self_set_edge_count', (
    SELECT count(*)
    FROM pg_auth_members m
    JOIN pg_roles granted_role ON granted_role.oid = m.roleid
    JOIN pg_roles member_role ON member_role.oid = m.member
    JOIN pg_roles grantor_role ON grantor_role.oid = m.grantor
    WHERE granted_role.rolname = 'meta_ads_stg_migration'
      AND member_role.rolname = 'postgres'
      AND grantor_role.rolname = 'postgres'
  )
) AS app_bootstrap_json;
