-- Read-only diagnosis of the aggregate loaded-definition fingerprint.
-- Run twice without an intervening application request to check stability.
-- Hashes and counts only; no row contents, credentials, queries or amounts.
BEGIN READ ONLY;
SET LOCAL statement_timeout=15000;
SET LOCAL TIME ZONE 'UTC';
DO $snapshot$
DECLARE item record; row_digest text; row_count bigint; parts jsonb:='[]'::jsonb;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 OR (SELECT count(*) FROM daily_data_sync_ops.settings)<>1
 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'PHASE08_DIGEST_DIAGNOSTIC_REJECTED'; END IF;
 FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
  EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'''' ORDER BY md5(to_jsonb(t)::text)),'''')) FROM phase08_meta_ads.%I t',item.tablename) INTO row_count,row_digest;
  parts:=parts||jsonb_build_array(jsonb_build_object('component','business','table',item.tablename,'rows',row_count,'digest',row_digest));
 END LOOP;
 PERFORM set_config('daily_data_sync.loaded_probe_digest_parts',parts::text,true);
END $snapshot$;
SELECT 'business' AS component,x->>'table' AS table_name,(x->>'rows')::bigint AS row_count,x->>'digest' AS digest
FROM jsonb_array_elements(current_setting('daily_data_sync.loaded_probe_digest_parts')::jsonb) x
UNION ALL SELECT 'settings',NULL,count(*),md5(jsonb_agg(to_jsonb(x) ORDER BY singleton)::text) FROM daily_data_sync_ops.settings x
UNION ALL SELECT 'schedules',NULL,count(*),md5(jsonb_agg(to_jsonb(x) ORDER BY key)::text) FROM daily_data_sync_ops.schedules x
UNION ALL SELECT 'attempts',NULL,count(*),md5(jsonb_agg(to_jsonb(x) ORDER BY id)::text) FROM daily_data_sync_ops.attempts x
UNION ALL SELECT 'jobs',NULL,count(*),md5(jsonb_agg(to_jsonb(x) ORDER BY jobid)::text) FROM cron.job x
UNION ALL SELECT 'vault',NULL,count(*),md5(jsonb_agg(to_jsonb(x) ORDER BY id)::text) FROM vault.secrets x
ORDER BY component,table_name;
ROLLBACK;
