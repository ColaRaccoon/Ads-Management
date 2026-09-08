\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = pg_catalog;
DO $guard$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'R2A_PHASE1_SESSION_CLASS_TARGET_MISMATCH';
  END IF;
END
$guard$;
SELECT jsonb_build_object(
  'status', 'PHASE1_TARGET_SESSION_STATE_COUNTS',
  'total', count(*),
  'active', count(*) FILTER (WHERE state = 'active'),
  'idle', count(*) FILTER (WHERE state = 'idle'),
  'idle_in_transaction', count(*) FILTER (WHERE state LIKE 'idle in transaction%'),
  'other_or_null', count(*) FILTER (WHERE state IS NULL OR state NOT IN ('active', 'idle', 'idle in transaction', 'idle in transaction (aborted)'))
) AS session_state_json
FROM pg_stat_activity
WHERE datname = 'meta_ads_staging';
ROLLBACK;
