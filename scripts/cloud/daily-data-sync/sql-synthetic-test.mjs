// Synthetic real-PostgreSQL test. HTTP/Vault/Cron extensions are deliberately stubbed.
// Never a remote scheduling or provider evidence substitute.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const container='meta-ads-phase03-pg-0929';
const db=`phase08_scheduler_${Date.now()}`;
const originalInstall=readFileSync(new URL('./install.sql',import.meta.url),'utf8');
if(!originalInstall.includes("current_database()<>'postgres'"))throw new Error('SYNTHETIC_DATABASE_GUARD_FIXTURE_INVALID');
// TEST ONLY: a fresh local fixture DB is distinct from the real postgres target.
const installSource=originalInstall.replace(/^CREATE EXTENSION.*;$/gm,'').replace("current_database()<>'postgres'",`current_database()<>'${db}'`);
// TEST ONLY: after proving the original guard rejects operating aliases, replace
// the call function's origin guard to exercise its algorithm with stub HTTP.
const callSource=installSource.match(/CREATE OR REPLACE FUNCTION daily_data_sync_ops\.call\([\s\S]*?END \$\$;/)?.[0];
if(!callSource || !callSource.includes("THEN RETURN 'TARGET_UNVERIFIED'; END IF;")) throw new Error('SYNTHETIC_GUARD_FIXTURE_INVALID');
const testOnlyCall=callSource.replace(/IF cfg\.origin<>[\s\S]*?THEN RETURN 'TARGET_UNVERIFIED'; END IF;/,
  "IF false THEN RETURN 'TARGET_UNVERIFIED'; END IF; -- TEST ONLY stub target");
function psql(sql,database=db){
 const r=spawnSync('docker',['exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],{input:sql,encoding:'utf8'});
 if(r.status!==0){console.error('SYNTHETIC_SQL_FAILED',r.stderr?.slice(-1600));process.exit(1);}
 return r.stdout;
}
psql(`CREATE DATABASE ${db};`,'postgres');
psql(`CREATE SCHEMA extensions; CREATE SCHEMA vault;
-- TEST ONLY metadata stubs for the strict 68/FORCE RLS install guard.
CREATE SCHEMA phase08_meta_ads;
DO $$ DECLARE i int; BEGIN FOR i IN 1..68 LOOP
EXECUTE format('CREATE TABLE phase08_meta_ads.fixture_%s(id int)',i);
EXECUTE format('ALTER TABLE phase08_meta_ads.fixture_%s ENABLE ROW LEVEL SECURITY',i);
EXECUTE format('ALTER TABLE phase08_meta_ads.fixture_%s FORCE ROW LEVEL SECURITY',i);
END LOOP; END $$;
CREATE TYPE extensions.http_header AS (field text,value text);
CREATE TYPE extensions.http_request AS (method text,uri text,headers extensions.http_header[],content_type text,content text);
CREATE TYPE extensions.http_response AS (status integer,content_type text,headers extensions.http_header[],content text);
CREATE TABLE vault.decrypted_secrets(name text,decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES('daily_data_sync_08_machine','synthetic-only-abcdefghijklmnopqrstuvwxyz0123456789');
CREATE FUNCTION extensions.http_header(text,text) RETURNS extensions.http_header LANGUAGE sql AS 'SELECT ROW($1,$2)::extensions.http_header';
CREATE FUNCTION extensions.http_set_curlopt(text,text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION extensions.http_reset_curlopt() RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE TABLE public.mock_http(mode text); INSERT INTO public.mock_http VALUES('partial');
CREATE FUNCTION extensions.http(req extensions.http_request) RETURNS extensions.http_response LANGUAGE plpgsql AS $$
DECLARE mode text; payload jsonb; due timestamptz; state text; BEGIN
SELECT m.mode INTO mode FROM public.mock_http m;
IF mode='throw' THEN RAISE EXCEPTION 'synthetic-sensitive-diagnostic-must-not-be-recorded'; END IF;
IF mode='auth' THEN RETURN ROW(403,'application/json',NULL,'{}')::extensions.http_response; END IF;
IF mode='lease-busy' THEN RETURN ROW(409,'application/json',NULL,'{"code":"LEASE_LOST","message":"synthetic-private-ignored","details":null}')::extensions.http_response; END IF;
IF mode='scope-409' THEN RETURN ROW(409,'application/json',NULL,'{"code":"ACCOUNT_SCOPE_MISMATCH"}')::extensions.http_response; END IF;
IF mode='array-409' THEN RETURN ROW(409,'application/json',NULL,'{"code":["LEASE_LOST","synthetic-private-ignored"]}')::extensions.http_response; END IF;
IF mode='invalid-409' THEN RETURN ROW(409,'application/json',NULL,'not-json')::extensions.http_response; END IF;
IF mode='oversize-409' THEN RETURN ROW(409,'application/json',NULL,repeat('x',8193))::extensions.http_response; END IF;
payload:=req.content::jsonb;due:=(payload->>'scheduledFor')::timestamptz;state:=CASE WHEN mode='success' THEN 'SUCCEEDED' ELSE 'PARTIAL' END;
RETURN ROW(202,'application/json',NULL,jsonb_build_object('scheduleKey',payload->>'scheduleKey','scheduledFor',payload->>'scheduledFor',
'status',state,'completedUnits',CASE WHEN mode='success' THEN 7 ELSE 1 END,'totalUnits',7,
'fromDate',CASE WHEN mode='bad' THEN NULL ELSE to_char((due AT TIME ZONE 'Asia/Seoul')::date-7,'YYYY-MM-DD') END,
'toDate',to_char((due AT TIME ZONE 'Asia/Seoul')::date-1,'YYYY-MM-DD'))::text)::extensions.http_response;
END $$;
SELECT set_config('daily_data_sync.install_ref','ehnfrrmbkvlsbpvqcvkr',false);
SELECT set_config('cron.timezone','GMT',false);
${installSource}
-- Fixture-only relaxation permits proving original origin guard rejects aliases.
ALTER TABLE daily_data_sync_ops.settings DROP CONSTRAINT settings_origin_check;
INSERT INTO daily_data_sync_ops.settings VALUES(true,false,'phase08-full-app','https://phase08-unprovisioned.invalid');
INSERT INTO daily_data_sync_ops.schedules VALUES('guard-test','00000000-0000-4000-8000-000000000004','META',clock_timestamp()-interval '5 seconds',7,35,false);
DO $$ BEGIN
IF daily_data_sync_ops.invoke('guard-test')<>'TARGET_UNVERIFIED' THEN RAISE EXCEPTION 'UNPROVISIONED_GUARD_REQUIRED'; END IF;
END $$;
-- Fixture-only constraint relaxation permits inserting rejected historic aliases.
DO $$ DECLARE candidate text; BEGIN
FOREACH candidate IN ARRAY ARRAY['https://grand-fascination-staging.up.railway.app','https://patimagroup-work.com'] LOOP
UPDATE daily_data_sync_ops.settings SET origin=candidate;
IF daily_data_sync_ops.invoke('guard-test')<>'TARGET_UNVERIFIED' THEN RAISE EXCEPTION 'OPERATING_ALIAS_NOT_BLOCKED'; END IF;
END LOOP;
IF (SELECT count(*) FROM daily_data_sync_ops.attempts)<>0 THEN RAISE EXCEPTION 'GUARD_MUST_NOT_CALL_HTTP'; END IF;
END $$;
UPDATE daily_data_sync_ops.settings SET origin='https://phase08-synthetic.invalid';
${testOnlyCall}
INSERT INTO daily_data_sync_ops.schedules VALUES('google-test','00000000-0000-4000-8000-000000000001','GOOGLE',clock_timestamp()-interval '5 seconds',7,35,false);
DO $$ BEGIN
IF daily_data_sync_ops.invoke('google-test')<>'PARTIAL' THEN RAISE EXCEPTION 'PARTIAL_EXPECTED'; END IF;
IF (SELECT status FROM daily_data_sync_ops.attempts ORDER BY id DESC LIMIT 1)='SUCCEEDED' THEN RAISE EXCEPTION '202_NOT_SUCCESS'; END IF;
UPDATE public.mock_http SET mode='throw';
IF daily_data_sync_ops.invoke('google-test')<>'FAILED' THEN RAISE EXCEPTION 'FAILED_EXPECTED'; END IF;
IF (SELECT count(*) FROM daily_data_sync_ops.attempts)<>2 THEN RAISE EXCEPTION 'FAILURE_DURABILITY'; END IF;
UPDATE public.mock_http SET mode='bad';
IF daily_data_sync_ops.invoke('google-test')<>'ACTION_REQUIRED' THEN RAISE EXCEPTION 'BAD_RESPONSE_EXPECTED'; END IF;
IF daily_data_sync_ops.invoke('google-test')<>'TERMINAL' THEN RAISE EXCEPTION 'ACTION_REQUIRED_NO_RETRY'; END IF;
END $$;
INSERT INTO daily_data_sync_ops.schedules VALUES('meta-test','00000000-0000-4000-8000-000000000002','META',clock_timestamp()-interval '5 seconds',7,35,false);
UPDATE public.mock_http SET mode='success';
DO $$ BEGIN
IF daily_data_sync_ops.invoke('meta-test')<>'SUCCEEDED' THEN RAISE EXCEPTION 'SUCCESS_EXPECTED'; END IF;
IF daily_data_sync_ops.invoke('meta-test')<>'TERMINAL' THEN RAISE EXCEPTION 'SUCCESS_SKIP'; END IF;
UPDATE daily_data_sync_ops.settings SET stopped=true;
IF daily_data_sync_ops.invoke('meta-test')<>'PAUSED' THEN RAISE EXCEPTION 'KILL_EXPECTED'; END IF;
UPDATE daily_data_sync_ops.settings SET stopped=false;
END $$;
INSERT INTO daily_data_sync_ops.schedules VALUES('missing-test','00000000-0000-4000-8000-000000000003','META',clock_timestamp()-interval '40 minutes',7,35,false);
-- Real SQL + stub normal exception-filter HTTP shape. No provider requests.
INSERT INTO daily_data_sync_ops.schedules VALUES('lease-busy-test','00000000-0000-4000-8000-000000000005','GOOGLE',clock_timestamp()-interval '5 seconds',7,35,false);
UPDATE public.mock_http SET mode='lease-busy';
DO $$ BEGIN
IF daily_data_sync_ops.invoke('lease-busy-test')<>'DELAYED' THEN RAISE EXCEPTION 'HEAVY_BUSY_MUST_RETRY'; END IF;
IF (SELECT safe_code FROM daily_data_sync_ops.attempts WHERE schedule_key='lease-busy-test' ORDER BY id DESC LIMIT 1)<>'APP_LEASE_BUSY' THEN RAISE EXCEPTION 'BUSY_SAFE_ENUM_REQUIRED'; END IF;
UPDATE public.mock_http SET mode='success';
IF daily_data_sync_ops.invoke('lease-busy-test')<>'SUCCEEDED' THEN RAISE EXCEPTION 'SAME_SLOT_RELEASE_SUCCESS'; END IF;
END $$;
DO $$ DECLARE candidate text; i int:=0; result text; key text; BEGIN
FOREACH candidate IN ARRAY ARRAY['scope-409','array-409','invalid-409','oversize-409'] LOOP
i:=i+1;key:='reject-409-'||i;
INSERT INTO daily_data_sync_ops.schedules VALUES(key,'00000000-0000-4000-8000-000000000006','GOOGLE',clock_timestamp()-interval '5 seconds',7,35,false);
UPDATE public.mock_http SET mode=candidate;
result:=daily_data_sync_ops.invoke(key);
IF result<>'ACTION_REQUIRED' OR daily_data_sync_ops.invoke(key)<>'TERMINAL' THEN RAISE EXCEPTION 'NON_BUSY_409_MUST_BE_TERMINAL'; END IF;
END LOOP;
IF EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts WHERE safe_code LIKE '%synthetic-private%' OR status LIKE '%synthetic-private%') THEN RAISE EXCEPTION 'RAW_HTTP_MUST_NOT_PERSIST'; END IF;
END $$;
DO $$ BEGIN
IF daily_data_sync_ops.audit('missing-test')<>'MISSING_SCHEDULE' THEN RAISE EXCEPTION 'MISSING_EXPECTED'; END IF;
PERFORM daily_data_sync_ops.audit('missing-test');
IF (SELECT count(*) FROM daily_data_sync_ops.attempts WHERE schedule_key='missing-test' AND status='MISSING_SCHEDULE' AND NOT inspection_only)<>1 THEN RAISE EXCEPTION 'AUDIT_IDEMPOTENT'; END IF;
IF has_function_privilege('public','daily_data_sync_ops.invoke(text)','EXECUTE') THEN RAISE EXCEPTION 'PUBLIC_EXECUTE'; END IF;
END $$;
`);
psql(`CREATE SCHEMA meta_ads; SET search_path=meta_ads,public;
CREATE TABLE sync_runs(id uuid PRIMARY KEY); INSERT INTO sync_runs VALUES('00000000-0000-4000-8000-000000000001');
${readFileSync(new URL('../../../apps/api/prisma/migrations/20261012170000_scheduled_unit_checkpoints/migration.sql',import.meta.url),'utf8')}
GRANT USAGE ON SCHEMA meta_ads TO meta_ads_stg_runtime,anon;
INSERT INTO sync_unit_checkpoints(run_id,unit_key,ciphertext,iv,auth_tag,expires_at)
VALUES('00000000-0000-4000-8000-000000000001','2026-10-12',decode('001122','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),now()+interval '2 hours');
DO $$ BEGIN
IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='sync_unit_checkpoints'::regclass) THEN RAISE EXCEPTION 'RLS_REQUIRED'; END IF;
IF has_table_privilege('anon','sync_unit_checkpoints','SELECT') OR has_table_privilege('authenticated','sync_unit_checkpoints','SELECT') OR has_table_privilege('service_role','sync_unit_checkpoints','SELECT') THEN RAISE EXCEPTION 'PUBLIC_APP_ROLES_DENIED'; END IF;
BEGIN UPDATE sync_unit_checkpoints SET iv=decode('00','hex'); RAISE EXCEPTION 'INVALID_IV_ACCEPTED'; EXCEPTION WHEN check_violation THEN NULL; END;
BEGIN UPDATE sync_unit_checkpoints SET auth_tag=decode('00','hex'); RAISE EXCEPTION 'INVALID_TAG_ACCEPTED'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SET ROLE meta_ads_stg_runtime;
DO $$ BEGIN
IF (SELECT count(*) FROM sync_unit_checkpoints)<>1 THEN RAISE EXCEPTION 'RUNTIME_RLS_POLICY'; END IF;
UPDATE sync_unit_checkpoints SET revision=revision+1;
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
BEGIN PERFORM count(*) FROM sync_unit_checkpoints; RAISE EXCEPTION 'ANON_ACCESS'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
`);
console.log(JSON.stringify({state:'SYNTHETIC_REAL_POSTGRES_PASS',database:db,cases:25,providerRequests:0,realCron:false,realHttp:false,
  originalOperatingAliasGuard:true,algorithmTargetGuardReplacedTestOnly:true}));
