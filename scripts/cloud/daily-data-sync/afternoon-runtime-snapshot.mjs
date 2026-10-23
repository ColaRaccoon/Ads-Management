// Fixed read-only aggregate; raw business rows and credential values never leave SQL.
export const AFTERNOON_RUNTIME_SQL=`BEGIN READ ONLY;SET LOCAL statement_timeout=15000;
 DO $snapshot$ DECLARE r record;d text;all_rows text:='';BEGIN
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
 EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM phase08_meta_ads.%I x',r.tablename) INTO d;
 all_rows:=all_rows||r.tablename||':'||d||';';END LOOP;
 PERFORM set_config('daily_data_sync.afternoon_readonly_business',md5(all_rows),true);END $snapshot$;
 SELECT current_database() AS database,current_user AS principal,
 current_setting('daily_data_sync.afternoon_readonly_business') AS business_md5,
 (SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app') AS stopped,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables,
 (SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%') AS total_jobs,
 (SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS active_jobs,
 (SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS live_leases,
 (SELECT count(*)::int FROM phase08_meta_ads.sync_runs WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-15T06:00:00.000Z','sha256'),'hex')) AS outage_runs,
 (SELECT count(*)::int FROM daily_data_sync_ops.attempts WHERE schedule_key='phase08-meta' AND scheduled_for='2026-10-15T06:00:00Z' AND NOT inspection_only AND status NOT IN('INCOMPLETE_SCHEDULE','MISSING_SCHEDULE')) AS outage_work_attempts,
 (SELECT count(*)::int FROM daily_data_sync_ops.attempts WHERE schedule_key='phase08-meta' AND scheduled_for='2026-10-15T06:00:00Z' AND inspection_only) AS outage_inspections,
 (SELECT count(*)::int FROM daily_data_sync_ops.attempts WHERE schedule_key='phase08-meta' AND scheduled_for='2026-10-15T06:00:00Z' AND status IN('INCOMPLETE_SCHEDULE','MISSING_SCHEDULE')) AS outage_audits,
 (SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY id)::text) FROM daily_data_sync_ops.attempts x WHERE id<=152) AS original_history,
 (SELECT count(*)::int FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-15T07:00:00.000Z','sha256'),'hex') AND u.status='SUCCEEDED') AS collection_succeeded_units;
 COMMIT;`;
process.stdout.write(JSON.stringify({state:'PHASE08_AFTERNOON_RUNTIME_SNAPSHOT_SQL',sql:AFTERNOON_RUNTIME_SQL}));
