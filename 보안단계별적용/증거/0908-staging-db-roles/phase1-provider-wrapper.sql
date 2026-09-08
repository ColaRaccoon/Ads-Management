\set ON_ERROR_STOP on
\pset pager off

\echo G_DB_00_PHASE1_EXACT_STAGING_SESSION_POOLER
\ir /r2a/00-admin-preflight.sql

BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = pg_catalog;
SELECT md5(COALESCE(datacl::text, '<NULL>')) AS expected_base_acl_md5
FROM pg_database
WHERE datname = 'postgres'
\gset
ROLLBACK;

\ir /r2a/10-admin-bootstrap.sql
\ir /r2a/20-app-bootstrap.sql
\ir /run/phase1-postcondition.sql
