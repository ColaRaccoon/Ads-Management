-- Apply after the Google D-1/D-7 API release and five active definitions are ready.
-- Private scheduler metadata only. Apply production-google-initial-policy.sql first.
-- No credentials, existing policies, collected rows, other schedules or cron jobs change.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
SET LOCAL search_path=meta_ads,pg_catalog,pg_temp;
LOCK TABLE daily_data_sync_prod_ops.schedules IN EXCLUSIVE MODE;
DO $guard$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres'
   OR (SELECT count(*) FROM daily_data_sync_prod_ops.settings WHERE NOT stopped)<>1
   OR (SELECT count(*) FROM daily_data_sync_prod_ops.schedules)<>4
   OR (SELECT count(*) FROM daily_data_sync_prod_ops.schedules WHERE NOT paused)<>4
   OR EXISTS(SELECT 1 FROM daily_data_sync_prod_ops.attempts WHERE status='HTTP_QUEUED')
   OR (SELECT count(*) FROM cron.job WHERE jobname='daily-data-sync-prod-tick' AND active AND schedule='* 17,18 * * *' AND command='SELECT daily_data_sync_prod_ops.tick();')<>1
   OR clock_timestamp()>='2026-10-26T16:30:00Z'::timestamptz
   OR (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::time BETWEEN time '02:00' AND time '04:25'
   OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='daily_data_sync_prod_ops.reap()'::regprocedure
      AND NOT prosecdef AND proconfig=ARRAY['search_path=""']
      AND md5(regexp_replace(prosrc,'[[:space:]]','','g'))='d28b83475ad2cf23610603107d143acd')
   OR (SELECT count(*) FROM pg_constraint WHERE conrelid='daily_data_sync_prod_ops.schedules'::regclass AND conname IN ('schedules_account_cadence','schedules_provider_cadence','schedules_scope_v2','schedules_pkey'))<>4
   OR (SELECT count(*) FROM meta_ads.source_policies WHERE connection_id='21b811a6-b9d7-44f5-8167-ce40198947b5')<>2
   OR NOT EXISTS(SELECT 1 FROM meta_ads.source_policies WHERE connection_id='21b811a6-b9d7-44f5-8167-ce40198947b5' AND data_kind='GOOGLE_CAMPAIGN' AND primary_source='API' AND from_date='2026-10-23' AND to_date IS NULL AND version=1)
   OR NOT EXISTS(SELECT 1 FROM meta_ads.source_policies WHERE connection_id='21b811a6-b9d7-44f5-8167-ce40198947b5' AND data_kind='GOOGLE_CAMPAIGN' AND primary_source='API' AND from_date='2026-10-20' AND to_date='2026-10-23' AND version=2)
 THEN RAISE EXCEPTION 'GOOGLE_DAILY_UPGRADE_GUARD'; END IF;
END $guard$;
CREATE TEMP TABLE google_daily_preserve ON COMMIT DROP AS SELECT
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY key) FROM daily_data_sync_prod_ops.schedules s) schedules,
 (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM meta_ads.source_policies p) policies,
 (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM meta_ads.google_campaign_daily_costs g) google_rows,
 (SELECT jsonb_agg(jsonb_build_array(jobid,jobname,schedule,active,md5(command)) ORDER BY jobid) FROM cron.job) jobs,
 (SELECT count(*) FROM daily_data_sync_prod_ops.attempts) attempts;
ALTER TABLE daily_data_sync_prod_ops.schedules ADD COLUMN day_offset integer NOT NULL DEFAULT 1;
ALTER TABLE daily_data_sync_prod_ops.schedules DROP CONSTRAINT schedules_account_cadence,
 DROP CONSTRAINT schedules_provider_cadence,DROP CONSTRAINT schedules_scope_v2;
UPDATE daily_data_sync_prod_ops.schedules SET paused=true WHERE key='prod-google';
ALTER TABLE daily_data_sync_prod_ops.schedules ADD CONSTRAINT schedules_account_cadence_offset UNIQUE(connection_id,cadence_days,day_offset),
 ADD CONSTRAINT schedules_provider_cadence_offset UNIQUE(provider,cadence_days,day_offset),
 ADD CONSTRAINT schedules_scope_v3 CHECK(
 (key='prod-cafe24' AND connection_id='be140e7e-3994-406e-94ff-b50dfc7ac7b2' AND provider='CAFE24' AND anchor_at='2026-10-24T17:00:00Z' AND cadence_days=1 AND window_minutes=110 AND day_offset=1) OR
 (key='prod-google' AND connection_id='21b811a6-b9d7-44f5-8167-ce40198947b5' AND provider='GOOGLE' AND anchor_at='2026-10-30T17:01:00Z' AND cadence_days=7 AND window_minutes=90 AND day_offset=1 AND paused) OR
 (key='prod-meta' AND connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND provider='META' AND anchor_at='2026-10-30T17:02:00Z' AND cadence_days=7 AND window_minutes=90 AND day_offset=1) OR
 (key='prod-meta-daily' AND connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND provider='META' AND anchor_at='2026-10-25T17:03:00Z' AND cadence_days=1 AND window_minutes=100 AND day_offset=1) OR
 (key='prod-google-daily' AND connection_id='21b811a6-b9d7-44f5-8167-ce40198947b5' AND provider='GOOGLE' AND anchor_at='2026-10-26T17:01:00Z' AND cadence_days=1 AND window_minutes=90 AND day_offset=1) OR
 (key='prod-google-recheck-d7' AND connection_id='21b811a6-b9d7-44f5-8167-ce40198947b5' AND provider='GOOGLE' AND anchor_at='2026-10-26T17:04:00Z' AND cadence_days=1 AND window_minutes=90 AND day_offset=7));
INSERT INTO daily_data_sync_prod_ops.schedules(key,connection_id,provider,anchor_at,cadence_days,window_minutes,paused,day_offset) VALUES
 ('prod-google-daily','21b811a6-b9d7-44f5-8167-ce40198947b5','GOOGLE','2026-10-26T17:01:00Z',1,90,false,1),
 ('prod-google-recheck-d7','21b811a6-b9d7-44f5-8167-ce40198947b5','GOOGLE','2026-10-26T17:04:00Z',1,90,false,7);
CREATE OR REPLACE FUNCTION daily_data_sync_prod_ops.reap() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE a daily_data_sync_prod_ops.attempts; r record; b jsonb; result_state text; code text;
  completed integer; total integer; expected_total integer; expected_offset integer;
BEGIN
  FOR a IN SELECT * FROM daily_data_sync_prod_ops.attempts WHERE status='HTTP_QUEUED' ORDER BY id FOR UPDATE LOOP
    SELECT status_code,content,timed_out,error_msg INTO r FROM net._http_response WHERE id=a.request_id;
    IF NOT FOUND AND clock_timestamp()<a.attempted_at+interval '100 seconds' THEN CONTINUE; END IF;
    result_state:='FAILED'; code:='TRANSPORT_FAILED'; completed:=NULL; total:=NULL;
    IF r.status_code IN (401,403) THEN result_state:='ACTION_REQUIRED'; code:='MACHINE_AUTH_REQUIRED';
    ELSIF r.status_code IN (429,500,502,503,504) THEN code:='HTTP_RETRYABLE';
    ELSIF r.status_code=409 THEN
      BEGIN
        IF octet_length(r.content)>8192 THEN RAISE EXCEPTION 'RESPONSE_LIMIT'; END IF;
        IF r.content::jsonb->>'code'='LEASE_LOST' THEN result_state:='DELAYED'; code:='APP_LEASE_BUSY';
        ELSE result_state:='ACTION_REQUIRED'; code:='HTTP_SCOPE_REJECTED'; END IF;
      EXCEPTION WHEN OTHERS THEN result_state:='ACTION_REQUIRED'; code:='HTTP_SCOPE_REJECTED'; END;
    ELSIF r.status_code IN (200,202) AND NOT coalesce(r.timed_out,false) THEN
      BEGIN
        IF octet_length(r.content)>8192 THEN RAISE EXCEPTION 'RESPONSE_LIMIT'; END IF;
        b:=r.content::jsonb; completed:=(b->>'completedUnits')::integer; total:=(b->>'totalUnits')::integer;
        SELECT cadence_days,day_offset INTO expected_total,expected_offset
          FROM daily_data_sync_prod_ops.schedules WHERE key=a.schedule_key;
        IF b->>'scheduleKey' IS DISTINCT FROM a.schedule_key OR
          b->>'scheduledFor' IS DISTINCT FROM to_char(a.scheduled_for AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR
          b->>'status' IS NULL OR b->>'status' NOT IN ('NOT_STARTED','QUEUED','RUNNING','PARTIAL','FAILED','ACTION_REQUIRED','CANCELLED','SUCCEEDED','DELAYED','EXPIRED') OR
          completed IS NULL OR total IS DISTINCT FROM expected_total OR completed<0 OR completed>total OR
          (b->>'status'='SUCCEEDED' AND completed<>total) OR
          b->>'fromDate' IS NULL OR b->>'toDate' IS NULL OR
          b->>'fromDate' !~ '^\d{4}-\d{2}-\d{2}$' OR b->>'toDate' !~ '^\d{4}-\d{2}-\d{2}$' OR
          (b->>'toDate')::date IS DISTINCT FROM (a.scheduled_for AT TIME ZONE 'Asia/Seoul')::date-expected_offset OR
          (b->>'fromDate')::date IS DISTINCT FROM (a.scheduled_for AT TIME ZONE 'Asia/Seoul')::date-expected_offset-(total-1)
          THEN RAISE EXCEPTION 'RESPONSE_SCOPE'; END IF;
        result_state:=b->>'status'; code:=CASE WHEN result_state='SUCCEEDED' THEN 'COMPLETE'
          WHEN result_state='EXPIRED' AND b->>'id' IS NULL THEN 'MISSING_SCHEDULE'
          WHEN result_state='EXPIRED' THEN 'INCOMPLETE_SCHEDULE' ELSE 'APP_INCOMPLETE' END;
      EXCEPTION WHEN OTHERS THEN result_state:='ACTION_REQUIRED'; code:='INVALID_APP_RESPONSE'; completed:=NULL; total:=NULL;
      END;
    ELSIF r.status_code IS NOT NULL THEN result_state:='ACTION_REQUIRED'; code:='HTTP_REJECTED'; END IF;
    UPDATE daily_data_sync_prod_ops.attempts SET status=result_state,safe_code=code,http_status=r.status_code,
      completed_units=completed,total_units=total,completed_at=clock_timestamp() WHERE id=a.id;
  END LOOP;
END $fn$;

DO $verify$ BEGIN
 IF (SELECT schedules FROM google_daily_preserve) IS DISTINCT FROM
    (SELECT jsonb_agg((to_jsonb(s)-'day_offset') || CASE WHEN key='prod-google' THEN '{"paused":false}'::jsonb ELSE '{}'::jsonb END ORDER BY key)
      FROM daily_data_sync_prod_ops.schedules s WHERE key NOT IN ('prod-google-daily','prod-google-recheck-d7'))
 OR (SELECT policies FROM google_daily_preserve) IS DISTINCT FROM
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM meta_ads.source_policies p)
 OR (SELECT google_rows FROM google_daily_preserve) IS DISTINCT FROM
    (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM meta_ads.google_campaign_daily_costs g)
 OR (SELECT jobs FROM google_daily_preserve) IS DISTINCT FROM
    (SELECT jsonb_agg(jsonb_build_array(jobid,jobname,schedule,active,md5(command)) ORDER BY jobid) FROM cron.job)
 OR (SELECT attempts FROM google_daily_preserve)<>(SELECT count(*) FROM daily_data_sync_prod_ops.attempts)
 OR (SELECT count(*) FROM daily_data_sync_prod_ops.schedules WHERE NOT paused)<>5
 THEN RAISE EXCEPTION 'GOOGLE_DAILY_PRESERVATION_GUARD'; END IF;
END $verify$;
COMMIT;
-- Rollback: pause both new Google keys, keep all history and source policies.
-- Do not restore the retired weekly job automatically or drop the added column.
