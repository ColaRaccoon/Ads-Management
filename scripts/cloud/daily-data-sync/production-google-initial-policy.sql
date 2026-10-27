-- Run once using the existing meta_ads_prod_runtime database connection.
-- The SQL Editor postgres role intentionally cannot assume the runtime role.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
SET LOCAL search_path=meta_ads,pg_catalog,pg_temp;
SELECT id FROM meta_ads.source_connections WHERE id='21b811a6-b9d7-44f5-8167-ce40198947b5' FOR UPDATE;
DO $guard$ BEGIN
 IF current_user<>'meta_ads_prod_runtime'
 OR clock_timestamp()>='2026-10-26T16:30:00Z'::timestamptz
 OR NOT EXISTS(SELECT 1 FROM meta_ads.source_connections WHERE id='21b811a6-b9d7-44f5-8167-ce40198947b5' AND provider='GOOGLE' AND external_account_id='1391592099' AND enabled)
 OR (SELECT count(*) FROM meta_ads.source_policies WHERE connection_id='21b811a6-b9d7-44f5-8167-ce40198947b5')<>1
 OR NOT EXISTS(SELECT 1 FROM meta_ads.source_policies WHERE connection_id='21b811a6-b9d7-44f5-8167-ce40198947b5' AND data_kind='GOOGLE_CAMPAIGN' AND primary_source='API' AND from_date='2026-10-23' AND to_date IS NULL AND version=1)
 THEN RAISE EXCEPTION 'GOOGLE_INITIAL_POLICY_GUARD'; END IF;
END $guard$;
WITH added AS (
 INSERT INTO meta_ads.source_policies(id,connection_id,data_kind,from_date,to_date,primary_source,version,reason)
 VALUES(gen_random_uuid(),'21b811a6-b9d7-44f5-8167-ce40198947b5','GOOGLE_CAMPAIGN','2026-10-20','2026-10-23','API',2,'GOOGLE_DAILY_D7_INITIAL_WINDOW') RETURNING id
)
INSERT INTO meta_ads.security_audit_events(id,actor_type,action,target_type,target_id,result,after_json)
SELECT gen_random_uuid(),'SYSTEM','SOURCE_POLICY_CHANGED','SOURCE_POLICY',id::text,'SUCCESS',
 jsonb_build_object('connectionId','21b811a6-b9d7-44f5-8167-ce40198947b5','fromDate','2026-10-20','toDateExclusive','2026-10-23','version',2,'reason','USER_REQUEST_GOOGLE_DAILY_D1_D7_20261026') FROM added;
COMMIT;
