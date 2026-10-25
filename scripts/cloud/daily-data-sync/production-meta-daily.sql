-- Apply only after the reviewed daily+weekly API release and four definitions
-- are running. Metadata-only private scheduler change; no credentials or cron
-- recreation, no business rows or existing attempt history are changed.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres'
   OR to_regclass('daily_data_sync_prod_ops.schedules') IS NULL
   OR (SELECT count(*) FROM daily_data_sync_prod_ops.settings WHERE NOT stopped)<>1
   OR (SELECT count(*) FROM daily_data_sync_prod_ops.schedules)<>3
   OR (SELECT count(*) FROM daily_data_sync_prod_ops.schedules WHERE NOT paused AND key IN ('prod-cafe24','prod-google','prod-meta'))<>3
   OR EXISTS(SELECT 1 FROM daily_data_sync_prod_ops.attempts WHERE status='HTTP_QUEUED')
   OR (SELECT count(*) FROM cron.job WHERE jobname='daily-data-sync-prod-tick' AND active AND schedule='* 17,18 * * *' AND command='SELECT daily_data_sync_prod_ops.tick();')<>1
   OR clock_timestamp()>='2026-10-25T16:33:00Z'::timestamptz
   OR (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::time BETWEEN time '02:00' AND time '04:25'
   OR (SELECT count(*) FROM pg_constraint WHERE conrelid='daily_data_sync_prod_ops.schedules'::regclass AND conname IN ('schedules_check','schedules_connection_id_key','schedules_provider_key','schedules_pkey'))<>4
 THEN RAISE EXCEPTION 'META_DAILY_UPGRADE_GUARD'; END IF;
END $guard$;
CREATE TEMP TABLE meta_daily_preserve ON COMMIT DROP AS SELECT
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY key) FROM daily_data_sync_prod_ops.schedules s) schedules,
 (SELECT jsonb_agg(jsonb_build_array(jobid,jobname,schedule,active,md5(command)) ORDER BY jobid) FROM cron.job) jobs,
 (SELECT count(*) FROM daily_data_sync_prod_ops.attempts) attempts;
ALTER TABLE daily_data_sync_prod_ops.schedules DROP CONSTRAINT schedules_connection_id_key,
 DROP CONSTRAINT schedules_provider_key,DROP CONSTRAINT schedules_check;
ALTER TABLE daily_data_sync_prod_ops.schedules ADD CONSTRAINT schedules_account_cadence UNIQUE(connection_id,cadence_days),
 ADD CONSTRAINT schedules_provider_cadence UNIQUE(provider,cadence_days),
 ADD CONSTRAINT schedules_scope_v2 CHECK(
 (key='prod-cafe24' AND connection_id='be140e7e-3994-406e-94ff-b50dfc7ac7b2' AND provider='CAFE24' AND anchor_at='2026-10-24T17:00:00Z' AND cadence_days=1 AND window_minutes=110) OR
 (key='prod-google' AND connection_id='21b811a6-b9d7-44f5-8167-ce40198947b5' AND provider='GOOGLE' AND anchor_at='2026-10-30T17:01:00Z' AND cadence_days=7 AND window_minutes=90) OR
 (key='prod-meta' AND connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND provider='META' AND anchor_at='2026-10-30T17:02:00Z' AND cadence_days=7 AND window_minutes=90) OR
 (key='prod-meta-daily' AND connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND provider='META' AND anchor_at='2026-10-25T17:03:00Z' AND cadence_days=1 AND window_minutes=100));
INSERT INTO daily_data_sync_prod_ops.schedules(key,connection_id,provider,anchor_at,cadence_days,window_minutes,paused)
 VALUES('prod-meta-daily','2155a401-bd86-4111-9280-3c95ed207546','META','2026-10-25T17:03:00Z',1,100,false);
CREATE OR REPLACE FUNCTION daily_data_sync_prod_ops.reap() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE a daily_data_sync_prod_ops.attempts; r record; b jsonb; result_state text; code text;
  completed integer; total integer; expected_total integer;
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
        SELECT CASE WHEN provider='CAFE24' OR key='prod-meta-daily' THEN 1 ELSE 7 END INTO expected_total
          FROM daily_data_sync_prod_ops.schedules WHERE key=a.schedule_key;
        IF b->>'scheduleKey' IS DISTINCT FROM a.schedule_key OR
          b->>'scheduledFor' IS DISTINCT FROM to_char(a.scheduled_for AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR
          b->>'status' IS NULL OR b->>'status' NOT IN ('NOT_STARTED','QUEUED','RUNNING','PARTIAL','FAILED','ACTION_REQUIRED','CANCELLED','SUCCEEDED','DELAYED','EXPIRED') OR
          completed IS NULL OR total IS DISTINCT FROM expected_total OR completed<0 OR completed>total OR
          (b->>'status'='SUCCEEDED' AND completed<>total) OR
          b->>'fromDate' IS NULL OR b->>'toDate' IS NULL OR
          b->>'fromDate' !~ '^\d{4}-\d{2}-\d{2}$' OR b->>'toDate' !~ '^\d{4}-\d{2}-\d{2}$' OR
          (b->>'toDate')::date IS DISTINCT FROM (a.scheduled_for AT TIME ZONE 'Asia/Seoul')::date-1 OR
          (b->>'fromDate')::date IS DISTINCT FROM (a.scheduled_for AT TIME ZONE 'Asia/Seoul')::date-total
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
CREATE OR REPLACE FUNCTION daily_data_sync_prod_ops.candidates(at_time timestamptz)
RETURNS TABLE(key text,due timestamptz,inspection boolean) LANGUAGE sql STABLE SET search_path='' AS $fn$
  SELECT s.key,d.due,at_time>=d.due+s.window_minutes*interval '1 minute'
  FROM daily_data_sync_prod_ops.schedules s
  CROSS JOIN LATERAL(SELECT daily_data_sync_prod_ops.slot(s,at_time) due) d
  WHERE NOT s.paused AND d.due IS NOT NULL
    AND (at_time AT TIME ZONE 'Asia/Seoul')::date=(d.due AT TIME ZONE 'Asia/Seoul')::date
    AND (at_time AT TIME ZONE 'Asia/Seoul')::time>=time '02:00'
    AND (at_time AT TIME ZONE 'Asia/Seoul')::time<time '03:55'
    AND NOT EXISTS(SELECT 1 FROM daily_data_sync_prod_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=d.due
      AND a.status IN ('SUCCEEDED','ACTION_REQUIRED','CANCELLED','EXPIRED'))
    AND NOT EXISTS(SELECT 1 FROM daily_data_sync_prod_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=d.due
      AND a.attempted_at>=date_trunc('minute',at_time))
    AND ((at_time<d.due+s.window_minutes*interval '1 minute'
      AND floor(extract(epoch FROM(at_time-d.due))/60)::integer%(CASE WHEN s.provider='CAFE24' THEN 1 ELSE 5 END)=0
      AND (SELECT count(*) FROM daily_data_sync_prod_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=d.due AND NOT a.inspection_only)<CASE WHEN s.provider='CAFE24' THEN 120 ELSE 24 END)
      OR (at_time>=d.due+(s.window_minutes+3)*interval '1 minute'
        AND (SELECT count(*) FROM daily_data_sync_prod_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=d.due AND a.inspection_only)<3))
  ORDER BY CASE WHEN s.key='prod-meta-daily' THEN 0 ELSE 1 END,(SELECT max(a.attempted_at) FROM daily_data_sync_prod_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=d.due) NULLS FIRST,s.key
$fn$;
DO $verify$ BEGIN
 IF (SELECT schedules FROM meta_daily_preserve) IS DISTINCT FROM
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY key) FROM daily_data_sync_prod_ops.schedules s WHERE key<>'prod-meta-daily')
 OR (SELECT jobs FROM meta_daily_preserve) IS DISTINCT FROM
    (SELECT jsonb_agg(jsonb_build_array(jobid,jobname,schedule,active,md5(command)) ORDER BY jobid) FROM cron.job)
 OR (SELECT attempts FROM meta_daily_preserve)<>(SELECT count(*) FROM daily_data_sync_prod_ops.attempts)
 OR (SELECT count(*) FROM daily_data_sync_prod_ops.schedules WHERE NOT paused)<>4
 THEN RAISE EXCEPTION 'META_DAILY_PRESERVATION_GUARD'; END IF;
END $verify$;
COMMIT;
-- Rollback first pauses only prod-meta-daily. Preserve its attempts/history;
-- keep v2 validation and the three old schedules. Then restore the reviewed
-- previous image/three-definition config. Never delete a day or rewrite success.
