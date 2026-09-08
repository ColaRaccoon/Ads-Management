\set ON_ERROR_STOP on
\set ECHO none
\set ECHO_HIDDEN off

BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL password_encryption = 'scram-sha-256';
\prompt '' runtime_scram_verifier
\prompt '' migration_scram_verifier
ALTER ROLE meta_ads_stg_runtime PASSWORD :'runtime_scram_verifier';
\unset runtime_scram_verifier
ALTER ROLE meta_ads_stg_migration PASSWORD :'migration_scram_verifier';
\unset migration_scram_verifier
DO $forced_failure$
BEGIN
  RAISE EXCEPTION 'R2A_PHASE2_LOCAL_FORCED_FAILURE';
END
$forced_failure$;

-- Unreachable. Disconnect after ON_ERROR_STOP must roll the transaction back.
COMMIT;
