-- Installed only by control.mjs after the exact isolated host/role/TLS guard.
-- No pg_net queue, Edge Function or storage-renewal objects are used.
DO $$ BEGIN
  IF current_setting('daily_data_sync.install_ref', true) IS DISTINCT FROM 'ehnfrrmbkvlsbpvqcvkr'
     OR current_user <> 'postgres' OR current_database()<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
     OR (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads')<>68
     OR (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68 THEN
    RAISE EXCEPTION 'STAGING_INSTALL_GUARD';
  END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;
DO $$ BEGIN
  IF coalesce(current_setting('cron.timezone',true),'') NOT IN ('GMT','UTC') THEN RAISE EXCEPTION 'CRON_UTC_REQUIRED'; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS daily_data_sync_ops;
REVOKE ALL ON SCHEMA daily_data_sync_ops FROM PUBLIC;
CREATE TABLE IF NOT EXISTS daily_data_sync_ops.settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), stopped boolean NOT NULL DEFAULT true,
  target_id text NOT NULL CHECK(target_id='phase08-full-app'), origin text NOT NULL CHECK(origin='https://phase08-daily-data-sync-production.up.railway.app')
);
CREATE TABLE IF NOT EXISTS daily_data_sync_ops.schedules (
  key text PRIMARY KEY CHECK(key ~ '^[a-z][a-z0-9-]{2,47}$'), connection_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider IN ('CAFE24','GOOGLE','META')), anchor_at timestamptz NOT NULL,
  cadence_days integer NOT NULL CHECK(cadence_days IN (1,7)), window_minutes integer NOT NULL CHECK(window_minutes BETWEEN 30 AND 120),
  paused boolean NOT NULL DEFAULT true, CHECK(cadence_days=CASE WHEN provider='CAFE24' THEN 1 ELSE 7 END)
);
CREATE TABLE IF NOT EXISTS daily_data_sync_ops.attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, schedule_key text NOT NULL REFERENCES daily_data_sync_ops.schedules(key),
  scheduled_for timestamptz NOT NULL, attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL, http_status integer, completed_units integer, total_units integer,
  safe_code text NOT NULL, elapsed_ms integer NOT NULL, inspection_only boolean NOT NULL DEFAULT false
);
ALTER TABLE daily_data_sync_ops.attempts ADD COLUMN IF NOT EXISTS inspection_only boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS daily_sync_attempt_slot ON daily_data_sync_ops.attempts(schedule_key,scheduled_for,id DESC);
ALTER TABLE daily_data_sync_ops.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_data_sync_ops.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_data_sync_ops.attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA daily_data_sync_ops FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA daily_data_sync_ops FROM PUBLIC;

CREATE OR REPLACE FUNCTION daily_data_sync_ops.slot(schedule daily_data_sync_ops.schedules, instant timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN instant < schedule.anchor_at THEN NULL ELSE schedule.anchor_at +
   floor(extract(epoch FROM (instant-schedule.anchor_at))/(schedule.cadence_days*86400))::bigint *
   schedule.cadence_days * interval '1 day' END
$$;

CREATE OR REPLACE FUNCTION daily_data_sync_ops.call(schedule_key text, inspection_only boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg daily_data_sync_ops.settings; s daily_data_sync_ops.schedules; due timestamptz;
  started timestamptz:=clock_timestamp(); res extensions.http_response; body jsonb;
  secret text; state text:='FAILED'; code text:='TRANSPORT_FAILED'; completed integer; total integer;
  response_phase boolean:=false; timeout_ms integer:=85000;
BEGIN
  SELECT * INTO STRICT cfg FROM daily_data_sync_ops.settings WHERE singleton;
  SELECT * INTO STRICT s FROM daily_data_sync_ops.schedules WHERE key=schedule_key;
  IF cfg.stopped OR s.paused THEN RETURN 'PAUSED'; END IF;
  -- PHASE08_ISOLATED_ORIGIN_GUARD: the distinct app resource was independently verified.
  -- Direct SQL/cron calls also reject every other origin and runtime target.
  IF cfg.origin<>'https://phase08-daily-data-sync-production.up.railway.app'
     OR cfg.target_id<>'phase08-full-app' THEN RETURN 'TARGET_UNVERIFIED'; END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('daily-data-sync-08-'||s.key,0)) THEN RETURN 'BUSY'; END IF;
  due:=daily_data_sync_ops.slot(s,started);
  IF due IS NULL THEN RETURN 'NOT_DUE'; END IF;
  IF started>=due+s.window_minutes*interval '1 minute' AND NOT inspection_only THEN RETURN 'EXPIRED'; END IF;
  IF inspection_only THEN
    -- A final closed-slot step can finalize already committed units, but the
    -- application guarantees it cannot queue/fetch an expired occurrence.
    IF started<due+s.window_minutes*interval '1 minute' THEN RETURN 'NOT_DUE'; END IF;
    IF (started AT TIME ZONE 'Asia/Seoul')::time >= time '04:00' OR
       (started AT TIME ZONE 'Asia/Seoul')::time < time '02:00' THEN RETURN 'OUTSIDE_RECONCILIATION_WINDOW'; END IF;
    timeout_ms:=least(85000,extract(epoch FROM (date_trunc('day',started AT TIME ZONE 'Asia/Seoul')+interval '4 hours'-(started AT TIME ZONE 'Asia/Seoul')))*1000-2000)::integer;
    IF timeout_ms<3000 THEN RETURN 'OUTSIDE_RECONCILIATION_WINDOW'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=due
    AND (a.status IN ('SUCCEEDED','ACTION_REQUIRED','CANCELLED') OR (a.status='EXPIRED' AND NOT a.inspection_only))) THEN RETURN 'TERMINAL'; END IF;
  IF inspection_only THEN
    IF (SELECT count(*) FROM daily_data_sync_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=due AND a.inspection_only)>=3 THEN RETURN 'INSPECTIONS_EXHAUSTED'; END IF;
  ELSE
    IF (SELECT count(*) FROM daily_data_sync_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=due AND NOT a.inspection_only
      AND a.status NOT IN ('MISSING_SCHEDULE','INCOMPLETE_SCHEDULE'))>=(CASE WHEN s.provider='CAFE24' THEN 120 ELSE 24 END) THEN RETURN 'ATTEMPTS_EXHAUSTED'; END IF;
  END IF;
  -- Catch errors in a nested block: the external failure record commits even when the app is down.
  BEGIN
    SELECT decrypted_secret INTO STRICT secret FROM vault.decrypted_secrets WHERE name='daily_data_sync_08_machine';
    IF length(secret)<32 THEN RAISE EXCEPTION 'MISSING_SECRET'; END IF;
    PERFORM extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS',timeout_ms::text);
    PERFORM extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS','15000');
    PERFORM extensions.http_set_curlopt('CURLOPT_FOLLOWLOCATION','0');
    SELECT * INTO res FROM extensions.http(( 'POST',cfg.origin||'/backend-api/internal/daily-sync',
      ARRAY[extensions.http_header('x-daily-sync-token',secret),extensions.http_header('x-daily-sync-target',cfg.target_id)],
      'application/json',jsonb_build_object('scheduleKey',s.key,'scheduledFor',to_char(due AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    )::extensions.http_request);
    secret:=NULL;
    PERFORM extensions.http_reset_curlopt();
    IF res.status IN (401,403) THEN state:='ACTION_REQUIRED';code:='MACHINE_AUTH_REQUIRED';
    ELSIF res.status IN (429,500,502,503,504) THEN code:='HTTP_RETRYABLE';
    ELSIF res.status=409 THEN
      response_phase:=true;
      IF octet_length(res.content)>8192 THEN RAISE EXCEPTION 'INVALID_APP_RESPONSE'; END IF;
      body:=res.content::jsonb;
      IF jsonb_typeof(body)='object' AND jsonb_typeof(body->'code')='string' AND body->>'code'='LEASE_LOST' THEN
        state:='DELAYED';code:='APP_LEASE_BUSY';
      ELSE state:='ACTION_REQUIRED';code:='HTTP_REJECTED'; END IF;
    ELSIF res.status NOT IN (200,202) THEN state:='ACTION_REQUIRED';code:='HTTP_REJECTED';
    ELSE
      response_phase:=true;
      IF octet_length(res.content)>8192 THEN RAISE EXCEPTION 'INVALID_APP_RESPONSE'; END IF;
      body:=res.content::jsonb;
      completed:=(body->>'completedUnits')::integer; total:=(body->>'totalUnits')::integer;
      IF body->>'scheduleKey' IS DISTINCT FROM s.key OR body->>'scheduledFor' IS DISTINCT FROM to_char(due AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        OR body->>'status' IS NULL OR body->>'status' NOT IN ('NOT_STARTED','QUEUED','RUNNING','PARTIAL','FAILED','ACTION_REQUIRED','CANCELLED','SUCCEEDED','DELAYED','EXPIRED')
        OR total IS DISTINCT FROM (CASE WHEN s.provider='CAFE24' THEN 1 ELSE 7 END)
        OR completed IS NULL OR completed<0 OR completed>total
        OR (body->>'status'='SUCCEEDED' AND completed<>total)
        OR body->>'fromDate' IS NULL OR body->>'toDate' IS NULL
        OR body->>'fromDate' !~ '^\d{4}-\d{2}-\d{2}$' OR body->>'toDate' !~ '^\d{4}-\d{2}-\d{2}$'
        OR (body->>'toDate')::date-(body->>'fromDate')::date<>total-1
        OR (body->>'toDate')::date IS DISTINCT FROM (due AT TIME ZONE 'Asia/Seoul')::date-1
        OR (body->>'fromDate')::date IS DISTINCT FROM (due AT TIME ZONE 'Asia/Seoul')::date-total THEN
        state:='ACTION_REQUIRED'; code:='INVALID_APP_RESPONSE';
      ELSE state:=body->>'status'; code:=CASE WHEN state='SUCCEEDED' THEN 'COMPLETE' ELSE 'APP_INCOMPLETE' END; END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    secret:=NULL; PERFORM extensions.http_reset_curlopt();
    -- Never persist SQLERRM, response content, URL headers, credentials or provider diagnostics.
    IF response_phase THEN state:='ACTION_REQUIRED';code:='INVALID_APP_RESPONSE'; ELSE code:='TRANSPORT_FAILED'; END IF;
  END;
  INSERT INTO daily_data_sync_ops.attempts(schedule_key,scheduled_for,status,http_status,completed_units,total_units,safe_code,elapsed_ms,inspection_only)
    VALUES(s.key,due,state,res.status,completed,total,code,least(2147483647,extract(epoch FROM (clock_timestamp()-started))*1000)::integer,inspection_only);
  RETURN state;
END $$;

CREATE OR REPLACE FUNCTION daily_data_sync_ops.invoke(schedule_key text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT daily_data_sync_ops.call(schedule_key,false)
$$;

CREATE OR REPLACE FUNCTION daily_data_sync_ops.audit(schedule_key text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s daily_data_sync_ops.schedules; due timestamptz; state text;
BEGIN
  SELECT * INTO STRICT s FROM daily_data_sync_ops.schedules WHERE key=schedule_key;
  IF s.paused OR (SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) THEN RETURN 'PAUSED'; END IF;
  due:=daily_data_sync_ops.slot(s,clock_timestamp());
  IF due IS NULL OR clock_timestamp()<due+s.window_minutes*interval '1 minute' THEN RETURN 'NOT_DUE'; END IF;
  IF EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=due AND status='SUCCEEDED') THEN RETURN 'SUCCEEDED'; END IF;
  PERFORM daily_data_sync_ops.call(schedule_key,true);
  IF EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=due AND status='SUCCEEDED') THEN RETURN 'SUCCEEDED'; END IF;
  state:=CASE WHEN EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=due AND NOT a.inspection_only AND a.status NOT IN ('MISSING_SCHEDULE','INCOMPLETE_SCHEDULE')) THEN 'INCOMPLETE_SCHEDULE' ELSE 'MISSING_SCHEDULE' END;
  IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts a WHERE a.schedule_key=s.key AND a.scheduled_for=due AND status=state) THEN
    INSERT INTO daily_data_sync_ops.attempts(schedule_key,scheduled_for,status,safe_code,elapsed_ms) VALUES(s.key,due,state,state,0);
  END IF;
  RETURN state;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA daily_data_sync_ops FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','meta_ads_stg_runtime','meta_ads_prod_runtime','phase08_runtime','phase08_storage_app','phase08_migration') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA daily_data_sync_ops FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA daily_data_sync_ops FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA daily_data_sync_ops FROM %I',role_name);
  END LOOP;
END $$;
