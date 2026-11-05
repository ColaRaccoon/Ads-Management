BEGIN;
SET LOCAL statement_timeout='20s';
CREATE TEMP TABLE attempts (LIKE daily_data_sync_prod_ops.attempts INCLUDING DEFAULTS) ON COMMIT DROP;
CREATE TEMP TABLE schedules AS SELECT * FROM daily_data_sync_prod_ops.schedules;
CREATE TEMP TABLE responses(id bigint,status_code integer,content text,timed_out boolean,error_msg text,created timestamptz) ON COMMIT DROP;
CREATE UNIQUE INDEX fixture_inflight_request_id ON attempts(request_id) WHERE status='HTTP_QUEUED';
CREATE OR REPLACE FUNCTION pg_temp.test_reap()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE a pg_temp.attempts; r record; b jsonb; result_state text; code text;
  completed integer; total integer; expected_total integer; expected_offset integer;
BEGIN
  FOR a IN SELECT * FROM pg_temp.attempts WHERE status='HTTP_QUEUED' ORDER BY id FOR UPDATE LOOP
    SELECT status_code,content,timed_out,error_msg INTO r FROM pg_temp.responses WHERE id=a.request_id
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
          FROM pg_temp.schedules WHERE key=a.schedule_key;
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
    UPDATE pg_temp.attempts SET status=result_state,safe_code=code,http_status=r.status_code,
      completed_units=completed,total_units=total,completed_at=clock_timestamp() WHERE id=a.id;
  END LOOP;
END $function$;

INSERT INTO attempts(id,schedule_key,scheduled_for,attempted_at,request_id,status,safe_code) VALUES
 (1,'prod-cafe24','2026-11-04T02:00:00+09',clock_timestamp()-interval '1 day',77,'SUCCEEDED','COMPLETE'),
 (2,'prod-cafe24','2026-11-04T02:00:00+09',clock_timestamp(),77,'HTTP_QUEUED','REQUEST_QUEUED');
DO $test$ BEGIN
  BEGIN
    INSERT INTO attempts(id,schedule_key,scheduled_for,request_id,status,safe_code) VALUES(3,'prod-cafe24','2026-11-04T02:00:00+09',77,'HTTP_QUEUED','REQUEST_QUEUED');
    RAISE EXCEPTION 'DUPLICATE_INFLIGHT_ACCEPTED';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $test$;
INSERT INTO responses VALUES(77,200,'{}',false,NULL,clock_timestamp()-interval '1 day');
SELECT pg_temp.test_reap();
DO $test$ BEGIN IF (SELECT status FROM attempts WHERE id=2) <> 'HTTP_QUEUED' THEN RAISE EXCEPTION 'STALE_RESPONSE_CONSUMED'; END IF; END $test$;
INSERT INTO responses VALUES(77,200,'{"scheduleKey":"prod-cafe24","scheduledFor":"2026-11-03T17:00:00.000Z","status":"SUCCEEDED","completedUnits":1,"totalUnits":1,"fromDate":"2026-11-03","toDate":"2026-11-03"}',false,NULL,clock_timestamp());
SELECT pg_temp.test_reap();
DO $test$ BEGIN
 IF (SELECT status FROM attempts WHERE id=2) <> 'SUCCEEDED' OR (SELECT status FROM attempts WHERE id=1) <> 'SUCCEEDED' THEN RAISE EXCEPTION 'FRESH_RESPONSE_OR_HISTORY_FAILED'; END IF;
END $test$;
INSERT INTO attempts(id,schedule_key,scheduled_for,attempted_at,request_id,status,safe_code) VALUES(4,'prod-cafe24','2026-11-04T02:00:00+09',clock_timestamp()-interval '200 seconds',88,'HTTP_QUEUED','REQUEST_QUEUED');
INSERT INTO responses VALUES(88,200,'{}',false,NULL,clock_timestamp()-interval '1 day');
SELECT pg_temp.test_reap();
DO $test$ BEGIN IF (SELECT safe_code FROM attempts WHERE id=4) <> 'TRANSPORT_FAILED' THEN RAISE EXCEPTION 'EXPIRED_RESPONSE_FAILED'; END IF; END $test$;
SELECT jsonb_build_object('status','PASS','historicalIdReuse',true,'concurrentDuplicateRejected',true,'staleResponseIgnored',true,'freshResponseAccepted',true,'expiredRequestFailed',true,'businessWrites',0) regression;
ROLLBACK;
