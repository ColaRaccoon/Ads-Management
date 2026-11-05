BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='20s';
DO $guard$ BEGIN
  IF current_user <> 'postgres' OR current_database() <> 'postgres'
    OR NOT pg_try_advisory_xact_lock(hashtextextended('daily-data-sync-production',0))
    OR (SELECT origin FROM daily_data_sync_prod_ops.settings WHERE singleton) IS DISTINCT FROM 'https://patimagroup-work.com'
    OR (SELECT md5(pg_get_functiondef('daily_data_sync_prod_ops.reap()'::regprocedure))) <> 'b453d847fb8f532a32cef47d8c416347'
    OR (SELECT md5(pg_get_functiondef('daily_data_sync_prod_ops.tick()'::regprocedure))) <> 'b0cdd2981335a3189835284431cb8e70'
    OR EXISTS(SELECT 1 FROM daily_data_sync_prod_ops.attempts WHERE status='HTTP_QUEUED')
  THEN RAISE EXCEPTION 'REQUEST_ID_REPAIR_GUARD'; END IF;
END $guard$;
LOCK TABLE daily_data_sync_prod_ops.attempts IN ACCESS EXCLUSIVE MODE;
ALTER TABLE daily_data_sync_prod_ops.attempts DROP CONSTRAINT attempts_request_id_key;
CREATE UNIQUE INDEX production_sync_inflight_request_id ON daily_data_sync_prod_ops.attempts(request_id) WHERE status='HTTP_QUEUED';
COMMENT ON INDEX daily_data_sync_prod_ops.production_sync_inflight_request_id IS 'pg_net request IDs may restart; durable attempt ID is the historical identity. Only active requests must be unique.';
CREATE OR REPLACE FUNCTION daily_data_sync_prod_ops.reap()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE a daily_data_sync_prod_ops.attempts; r record; b jsonb; result_state text; code text;
  completed integer; total integer; expected_total integer; expected_offset integer;
BEGIN
  FOR a IN SELECT * FROM daily_data_sync_prod_ops.attempts WHERE status='HTTP_QUEUED' ORDER BY id FOR UPDATE LOOP
    SELECT status_code,content,timed_out,error_msg INTO r FROM net._http_response WHERE id=a.request_id
      AND created >= a.attempted_at - interval '5 seconds'
      AND created >= pg_catalog.pg_postmaster_start_time()
      ORDER BY created DESC LIMIT 1;
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
END $function$;

SELECT jsonb_build_object('status','REPAIRED','attemptsRetained',(SELECT count(*) FROM daily_data_sync_prod_ops.attempts),'reapHash',md5(pg_get_functiondef('daily_data_sync_prod_ops.reap()'::regprocedure)),'schedulerStopped',(SELECT stopped FROM daily_data_sync_prod_ops.settings WHERE singleton)) receipt;
COMMIT;
