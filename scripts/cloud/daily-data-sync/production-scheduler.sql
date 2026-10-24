-- New production infrastructure only. Existing Storage and phase08 are untouched.
-- Run as the existing postgres administrator after reviewing the fixed target.
BEGIN;
DO $guard$ BEGIN
  IF current_user <> 'postgres' OR current_database() <> 'postgres'
    OR coalesce(current_setting('cron.timezone',true),'') NOT IN ('UTC','GMT')
    OR to_regnamespace('daily_data_sync_prod_ops') IS NOT NULL
    OR to_regnamespace('storage_renewal_ops') IS NULL
    OR (SELECT count(*) FROM meta_ads.source_connections WHERE enabled AND access_state='READY'
      AND time_zone='Asia/Seoul' AND (
      (id='be140e7e-3994-406e-94ff-b50dfc7ac7b2' AND provider='CAFE24' AND external_account_id='didadi0729' AND shop_key='shop1' AND currency_code='KRW') OR
      (id='21b811a6-b9d7-44f5-8167-ce40198947b5' AND provider='GOOGLE' AND external_account_id='1391592099' AND currency_code='KRW') OR
      (id='2155a401-bd86-4111-9280-3c95ed207546' AND provider='META' AND external_account_id='2138525300002203' AND currency_code='USD'))) <> 3
    OR (SELECT count(*) FROM cron.job WHERE active AND ((jobname='storage-renewal-daily' AND schedule='0 19 * * *')
      OR (jobname='storage-renewal-verify' AND schedule='15 19 * * *')
      OR (jobname='storage-renewal-audit' AND schedule='20 19 * * *'))) <> 3
    OR EXISTS(SELECT 1 FROM cron.job WHERE jobname='daily-data-sync-prod-tick')
    OR EXISTS(SELECT 1 FROM vault.secrets WHERE name='daily_data_sync_prod_machine')
    OR NOT EXISTS(SELECT 1 FROM meta_ads.source_policies WHERE connection_id='be140e7e-3994-406e-94ff-b50dfc7ac7b2'
      AND data_kind='CAFE24_ORDER' AND from_date='2026-10-24' AND to_date IS NULL
      AND version=3 AND primary_source='CSV' AND coupon_input_source IS NULL)
    OR NOT EXISTS(SELECT 1 FROM meta_ads.source_coverage WHERE connection_id='be140e7e-3994-406e-94ff-b50dfc7ac7b2'
      AND metric_date='2026-10-23' AND reconciliation_status='CSV_API_INPUTS_REVIEWED')
    THEN RAISE EXCEPTION 'PRODUCTION_SCHEDULE_INSTALL_GUARD'; END IF;
END $guard$;
CREATE SCHEMA daily_data_sync_prod_ops;
REVOKE ALL ON SCHEMA daily_data_sync_prod_ops FROM PUBLIC;
CREATE TABLE daily_data_sync_prod_ops.settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), stopped boolean NOT NULL DEFAULT true,
  origin text NOT NULL DEFAULT 'https://patimagroup-work.com' CHECK(origin='https://patimagroup-work.com'),
  target_id text NOT NULL DEFAULT 'bundle-loopback-api' CHECK(target_id='bundle-loopback-api'),
  activated_release text CHECK(activated_release ~ '^[a-f0-9]{40}$'), activated_at timestamptz
);
INSERT INTO daily_data_sync_prod_ops.settings(singleton) VALUES(true);
CREATE TABLE daily_data_sync_prod_ops.schedules (
  key text PRIMARY KEY, connection_id uuid NOT NULL UNIQUE, provider text NOT NULL UNIQUE,
  anchor_at timestamptz NOT NULL, cadence_days integer NOT NULL, window_minutes integer NOT NULL,
  paused boolean NOT NULL DEFAULT true,
  CHECK((key='prod-cafe24' AND connection_id='be140e7e-3994-406e-94ff-b50dfc7ac7b2' AND provider='CAFE24'
    AND anchor_at='2026-10-24T17:00:00Z' AND cadence_days=1 AND window_minutes=110) OR
    (key='prod-google' AND connection_id='21b811a6-b9d7-44f5-8167-ce40198947b5' AND provider='GOOGLE'
    AND anchor_at='2026-10-30T17:01:00Z' AND cadence_days=7 AND window_minutes=90) OR
    (key='prod-meta' AND connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND provider='META'
    AND anchor_at='2026-10-30T17:02:00Z' AND cadence_days=7 AND window_minutes=90))
);
INSERT INTO daily_data_sync_prod_ops.schedules VALUES
  ('prod-cafe24','be140e7e-3994-406e-94ff-b50dfc7ac7b2','CAFE24','2026-10-24T17:00:00Z',1,110,true),
  ('prod-google','21b811a6-b9d7-44f5-8167-ce40198947b5','GOOGLE','2026-10-30T17:01:00Z',7,90,true),
  ('prod-meta','2155a401-bd86-4111-9280-3c95ed207546','META','2026-10-30T17:02:00Z',7,90,true);
CREATE TABLE daily_data_sync_prod_ops.attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule_key text NOT NULL REFERENCES daily_data_sync_prod_ops.schedules(key),
  scheduled_for timestamptz NOT NULL, attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id bigint UNIQUE, inspection_only boolean NOT NULL DEFAULT false,
  status text NOT NULL, safe_code text NOT NULL,
  http_status integer, completed_units integer, total_units integer, completed_at timestamptz
);
CREATE INDEX production_sync_attempt_slot ON daily_data_sync_prod_ops.attempts(schedule_key,scheduled_for,id DESC);
ALTER TABLE daily_data_sync_prod_ops.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_data_sync_prod_ops.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_data_sync_prod_ops.attempts ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION daily_data_sync_prod_ops.slot(s daily_data_sync_prod_ops.schedules, at_time timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path='' AS $fn$
  SELECT CASE WHEN at_time<s.anchor_at THEN NULL ELSE s.anchor_at+
    floor(extract(epoch FROM(at_time-s.anchor_at))/(s.cadence_days*86400))::bigint*s.cadence_days*interval '1 day' END
$fn$;

-- Reads only our request IDs. Never alters pg_net's shared queue or responses.
CREATE FUNCTION daily_data_sync_prod_ops.reap() RETURNS void
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
        SELECT CASE WHEN provider='CAFE24' THEN 1 ELSE 7 END INTO expected_total
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

-- Future-slot planning is read-only; executing tick always uses the real clock.
CREATE FUNCTION daily_data_sync_prod_ops.candidates(at_time timestamptz)
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
  ORDER BY (SELECT max(a.attempted_at) FROM daily_data_sync_prod_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=d.due) NULLS FIRST,s.key
$fn$;

CREATE FUNCTION daily_data_sync_prod_ops.tick() RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE cfg daily_data_sync_prod_ops.settings; candidate record; instant timestamptz:=clock_timestamp();
  secret text; request bigint; budget integer;
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('daily-data-sync-production',0)) THEN RETURN 'BUSY'; END IF;
  SELECT * INTO STRICT cfg FROM daily_data_sync_prod_ops.settings WHERE singleton;
  IF cfg.stopped THEN RETURN 'STOPPED'; END IF;
  PERFORM daily_data_sync_prod_ops.reap();
  IF EXISTS(SELECT 1 FROM daily_data_sync_prod_ops.attempts WHERE status='HTTP_QUEUED') THEN RETURN 'IN_FLIGHT'; END IF;
  SELECT * INTO candidate FROM daily_data_sync_prod_ops.candidates(instant) LIMIT 1;
  IF NOT FOUND THEN RETURN 'NOT_DUE'; END IF;
  SELECT decrypted_secret INTO STRICT secret FROM vault.decrypted_secrets WHERE name='daily_data_sync_prod_machine';
  IF length(secret)<48 OR cfg.origin<>'https://patimagroup-work.com' OR cfg.target_id<>'bundle-loopback-api' THEN
    RAISE EXCEPTION 'PRODUCTION_SCHEDULE_AUTH_GUARD'; END IF;
  -- Leave five minutes before the unrelated 04:00 Storage renewal. HTTP runs
  -- asynchronously after commit, without occupying a business DB transaction.
  budget:=least(85000,extract(epoch FROM(((date_trunc('day',instant AT TIME ZONE 'Asia/Seoul')+interval '3 hours 55 minutes') AT TIME ZONE 'Asia/Seoul')-instant))*1000-2000)::integer;
  IF budget<3000 THEN secret:=NULL; RETURN 'WINDOW_CLOSED'; END IF;
  request:=net.http_post(url:=cfg.origin||'/backend-api/internal/daily-sync',
    body:=jsonb_build_object('scheduleKey',candidate.key,'scheduledFor',to_char(candidate.due AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    -- libcurl drops Authorization across origins; never use the custom token
    -- header with pg_net's automatically followed redirects.
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret,'x-daily-sync-target',cfg.target_id),
    timeout_milliseconds:=budget);
  secret:=NULL;
  INSERT INTO daily_data_sync_prod_ops.attempts(schedule_key,scheduled_for,request_id,inspection_only,status,safe_code)
    VALUES(candidate.key,candidate.due,request,candidate.inspection,'HTTP_QUEUED','REQUEST_QUEUED');
  RETURN 'HTTP_QUEUED';
END $fn$;
REVOKE ALL ON ALL TABLES IN SCHEMA daily_data_sync_prod_ops FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA daily_data_sync_prod_ops FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA daily_data_sync_prod_ops FROM PUBLIC;
DO $revoke$ DECLARE name text; BEGIN
  FOR name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','meta_ads_prod_runtime') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA daily_data_sync_prod_ops FROM %I',name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA daily_data_sync_prod_ops FROM %I',name);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA daily_data_sync_prod_ops FROM %I',name);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA daily_data_sync_prod_ops FROM %I',name);
  END LOOP;
END $revoke$;
-- Key is generated inside Vault; no plaintext key is written to SQL history.
SELECT vault.create_secret(encode(extensions.gen_random_bytes(48),'base64'),'daily_data_sync_prod_machine');
SELECT cron.schedule('daily-data-sync-prod-tick','* 17,18 * * *','SELECT daily_data_sync_prod_ops.tick();');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='daily-data-sync-prod-tick'),active:=false);
COMMIT;
