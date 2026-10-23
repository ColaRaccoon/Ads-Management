-- Owner activation approved by the human on 2026-10-23; this is a REVIEW template.
-- The exact C7 migration body is omitted here. This template ends with ROLLBACK.
-- Never replay consumed Role-Execute/Deploy helpers or use an old database password.
BEGIN;
SET LOCAL search_path = meta_ads, pg_catalog, extensions;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $owner_guard$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'OWNER_ACTIVATION_TARGET_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid
    JOIN pg_roles u ON u.oid = m.member
    JOIN pg_roles g ON g.oid = m.grantor
    WHERE r.rolname = 'meta_ads_app' AND u.rolname = 'postgres'
      AND g.rolname = 'supabase_admin'
      AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid
    JOIN pg_roles u ON u.oid = m.member
    JOIN pg_roles g ON g.oid = m.grantor
    WHERE r.rolname = 'meta_ads_app' AND u.rolname = 'postgres'
      AND g.rolname = 'postgres'
  ) THEN RAISE EXCEPTION 'OWNER_MEMBERSHIP_DRIFT'; END IF;
END $owner_guard$;

-- A new grant by postgres is confined to this transaction. The existing grant
-- by supabase_admin is preserved, including its SET=false / INHERIT=false.
GRANT meta_ads_app TO postgres WITH SET TRUE GRANTED BY postgres;
GRANT meta_ads_app TO postgres WITH INHERIT FALSE GRANTED BY postgres;
SET LOCAL ROLE meta_ads_app;

-- The approved exact C7 file, its ledger assertion, and fresh ledger INSERT
-- belong here in the final per-file execution artifact, after separate approval.
-- No arbitrary SQL, role creation, LOGIN/password change, or deletion is added.

RESET ROLE;
REVOKE meta_ads_app FROM postgres GRANTED BY postgres RESTRICT;
DO $owner_cleanup_guard$
BEGIN
  IF current_user <> 'postgres' OR NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid
    JOIN pg_roles u ON u.oid = m.member
    JOIN pg_roles g ON g.oid = m.grantor
    WHERE r.rolname = 'meta_ads_app' AND u.rolname = 'postgres'
      AND g.rolname = 'supabase_admin'
      AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid
    JOIN pg_roles u ON u.oid = m.member
    JOIN pg_roles g ON g.oid = m.grantor
    WHERE r.rolname = 'meta_ads_app' AND u.rolname = 'postgres'
      AND g.rolname = 'postgres'
  ) THEN RAISE EXCEPTION 'OWNER_TEMPORARY_GRANT_NOT_REMOVED'; END IF;
END $owner_cleanup_guard$;
ROLLBACK;
