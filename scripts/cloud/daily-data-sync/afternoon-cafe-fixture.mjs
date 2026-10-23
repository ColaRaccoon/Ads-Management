// Explicit administrator test setup only. No provider I/O or successful-unit inheritance.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {FIXED_CONNECTIONS} from './deployment-evidence.mjs';
import {acceleratedDefinitions} from './accelerated-october15-profile.mjs';
const q=v=>`'${v.replaceAll("'","''")}'`,hash=(v,kind='md5')=>createHash(kind).update(v).digest('hex');
const CAFE='0c35defe-45fc-4a54-bc79-704df7bca5b1',META='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6';
const DUE='2026-10-15T06:40:00.000Z',request=(key,due)=>`schedule:${key}:${hash(due,'sha256')}`;
const NEW=request('phase08-cafe24',DUE),OLD=request('phase08-cafe24','2026-10-15T01:00:00.000Z');
export const CAFE_FIXTURE_ACTION='SYNC_CAFE24_EXPLICIT_REPLAY_FIXTURE';
const terminal="(a.status IN ('SUCCEEDED','ACTION_REQUIRED','CANCELLED') OR (a.status='EXPIRED' AND NOT a.inspection_only))";
export const CAFE_FIXTURE_APPROVAL_SQL=`EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts marker JOIN phase08_meta_ads.security_audit_events event ON event.after_json->>'approvedAttemptId'=marker.id::text
 JOIN phase08_meta_ads.sync_runs replay ON replay.id::text=event.target_id
 WHERE s.key='phase08-cafe24' AND s.connection_id='${CAFE}'::uuid AND due=timestamptz '${DUE}' AND s.anchor_at=due AND s.window_minutes=110
 AND marker.schedule_key=s.key AND marker.scheduled_for=due AND marker.id>a.id AND marker.status='CAFE24_REPLAY_FIXTURE_APPROVED' AND marker.safe_code='CAFE24_REPLAY_FIXTURE_APPROVED' AND NOT marker.inspection_only
 AND event.action='${CAFE_FIXTURE_ACTION}' AND event.actor_type='USER' AND event.result='REQUESTED' AND event.target_type='SYNC_RUN'
 AND event.after_json->>'requestKey'='${NEW}' AND event.after_json->>'originalFailureAttemptId'=a.id::text
 AND replay.connection_id=s.connection_id AND replay.trigger='SCHEDULED' AND replay.request_key='${NEW}' AND replay.from_date=date '2026-10-14' AND replay.to_date=date '2026-10-14'
 AND replay.actor_user_id IS NULL AND replay.status IN('QUEUED','RUNNING','PARTIAL','FAILED','SUCCEEDED'))`;
export function removeCafeFixtureCallException(definition){
 const replacement=`(a.status IN ('SUCCEEDED','CANCELLED') OR (a.status='ACTION_REQUIRED' AND NOT (${CAFE_FIXTURE_APPROVAL_SQL})) OR (a.status='EXPIRED' AND NOT a.inspection_only))`;
 if(definition.split(replacement).length!==2)throw Error('CAFE_FIXTURE_CALL_REJECTED');
 return definition.replace(replacement,terminal);
}
const digest=table=>`(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text)::text,'[]')) FROM ${table} x)`;
export function buildAfternoonCafeFixture({actorId,authId,currentCallDefinition,expectedState}){
 if(![actorId,authId].every(v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v))||!expectedState||Object.keys(expectedState).sort().join()!=='jobsMd5,schedulesMd5,settingsMd5'||Object.values(expectedState).some(v=>typeof v!=='string'||!/^[a-f0-9]{32}$/.test(v))||typeof currentCallDefinition!=='string'||currentCallDefinition.length>30000)throw Error('CAFE_FIXTURE_INPUT');
 const match=currentCallDefinition.match(/^CREATE OR REPLACE FUNCTION daily_data_sync_ops\.call\(schedule_key text, inspection_only boolean(?: DEFAULT false)?\)[\s\S]*?AS (\$\$|\$function\$)([\s\S]*)\1;?\s*$/);
 if(!match||hash(match[2])!=='03d7cf6f24da00e3c577b28cd979b951'||currentCallDefinition.split(terminal).length!==2)throw Error('CAFE_FIXTURE_CALL_REJECTED');
 const replacement=`(a.status IN ('SUCCEEDED','CANCELLED') OR (a.status='ACTION_REQUIRED' AND NOT (${CAFE_FIXTURE_APPROVAL_SQL})) OR (a.status='EXPIRED' AND NOT a.inspection_only))`;
 let fn=currentCallDefinition.replace(terminal,replacement).trim();if(!fn.endsWith(';'))fn+=';';
 const next=fn.match(/AS (\$\$|\$function\$)([\s\S]*)\1;\s*$/);if(!next||removeCafeFixtureCallException(fn).trim().replace(/;$/,'')!==currentCallDefinition.trim().replace(/;$/,''))throw Error('CAFE_FIXTURE_CALL_REJECTED');
 const snapshot=compare=>`DO $snapshot$ DECLARE item record;part text;all_rows text:='';BEGIN
 FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
 EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM phase08_meta_ads.%I x WHERE NOT ((%L=''sync_runs'' AND to_jsonb(x)->>''id''=current_setting(''daily_data_sync.cafe_fixture_run'')) OR (%L=''run_units'' AND to_jsonb(x)->>''run_id''=current_setting(''daily_data_sync.cafe_fixture_run'')) OR (%L=''security_audit_events'' AND to_jsonb(x)->>''id''=current_setting(''daily_data_sync.cafe_fixture_audit'')))',item.tablename,item.tablename,item.tablename,item.tablename) INTO part;
 all_rows:=all_rows||item.tablename||':'||part||';';END LOOP;
 ${compare?"IF md5(all_rows) IS DISTINCT FROM current_setting('daily_data_sync.cafe_fixture_business') THEN RAISE EXCEPTION 'CAFE_FIXTURE_BUSINESS_CHANGED';END IF;":"PERFORM set_config('daily_data_sync.cafe_fixture_business',md5(all_rows),true);"}END $snapshot$;`;
 const frozen=`SELECT md5(jsonb_build_object('settings',${digest('daily_data_sync_ops.settings')},'schedules',${digest('daily_data_sync_ops.schedules')},'jobs',${digest('cron.job')},'vault',${digest('vault.secrets')},'attempts',(SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY id)::text,'[]')) FROM daily_data_sync_ops.attempts a WHERE status<>'CAFE24_REPLAY_FIXTURE_APPROVED'))::text)`;
 const sourceGuards=FIXED_CONNECTIONS.map(c=>`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id=${q(c.connectionId)}::uuid AND provider=${q(c.provider)} AND external_account_id=${q(c.account)} AND shop_key=${q(c.shop)} AND currency_code=${q(c.currency)} AND time_zone='Asia/Seoul' AND enabled AND access_state='READY') THEN RAISE EXCEPTION 'CAFE_FIXTURE_SOURCE';END IF;`).join('\n');
 const defs=acceleratedDefinitions('collection').map(d=>`IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key=${q(d.key)} AND connection_id=${q(d.connectionId)}::uuid AND provider=${q(d.provider)} AND anchor_at=${q(d.anchorAt)}::timestamptz AND window_minutes=${d.windowMinutes} AND cadence_days=${d.provider==='CAFE24'?1:7} AND NOT paused) THEN RAISE EXCEPTION 'CAFE_FIXTURE_SCHEDULE';END IF;`).join('\n');
 return {state:'PHASE08_CAFE_FIXTURE_PREPARED',requestKey:NEW,resultCallMd5:hash(next[2]),sql:`BEGIN ISOLATION LEVEL REPEATABLE READ;SET LOCAL statement_timeout=15000;SET LOCAL lock_timeout=5000;
 SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));
 SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-phase08-cafe24',0));
 SELECT id FROM phase08_meta_ads.source_connections ORDER BY id FOR UPDATE;
 SELECT key FROM daily_data_sync_ops.schedules ORDER BY key FOR UPDATE;
 SELECT set_config('daily_data_sync.cafe_fixture_run',gen_random_uuid()::text,true),set_config('daily_data_sync.cafe_fixture_audit',gen_random_uuid()::text,true);
 DO $guard$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
 OR clock_timestamp()<timestamptz '2026-10-15T07:00:00Z' OR clock_timestamp()>=timestamptz '2026-10-15T08:30:00Z'-interval '60 seconds'
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3 OR (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3
 OR (SELECT count(*) FROM daily_data_sync_ops.settings)<>1 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp())
 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%')<>149 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active)<>149
 OR ${digest('daily_data_sync_ops.settings')} IS DISTINCT FROM ${q(expectedState.settingsMd5)} OR ${digest('daily_data_sync_ops.schedules')} IS DISTINCT FROM ${q(expectedState.schedulesMd5)} OR ${digest('cron.job')} IS DISTINCT FROM ${q(expectedState.jobsMd5)}
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure)<>'03d7cf6f24da00e3c577b28cd979b951'
 OR (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM daily_data_sync_ops.attempts a WHERE id<=152) IS DISTINCT FROM 'c044e6c4249188e410d31aacf57422dc'
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs WHERE connection_id='${CAFE}'::uuid AND request_key='${NEW}')
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.security_audit_events WHERE action='${CAFE_FIXTURE_ACTION}') OR EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts WHERE status='CAFE24_REPLAY_FIXTURE_APPROVED')
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.app_users a JOIN auth.users u ON u.id=a.auth_user_id WHERE a.id=${q(actorId)}::uuid AND a.auth_user_id=${q(authId)}::uuid AND a.role='SUPER_ADMIN' AND a.is_active AND a.invite_status='ACTIVE' AND a.email=u.email AND u.email_confirmed_at IS NOT NULL)
 OR (SELECT count(*) FROM phase08_meta_ads.sync_runs r JOIN phase08_meta_ads.run_units u ON u.run_id=r.id WHERE r.connection_id='${CAFE}'::uuid AND r.request_key='${OLD}' AND r.trigger='SCHEDULED' AND r.status='SUCCEEDED' AND r.actor_user_id IS NULL AND r.from_date=date '2026-10-14' AND r.to_date=date '2026-10-14' AND u.unit_key='2026-10-14' AND u.status='SUCCEEDED')<>1
 OR (SELECT count(*) FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='${CAFE}'::uuid AND r.request_key='${OLD}')<>1
 OR (SELECT count(*) FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='${META}'::uuid AND r.request_key='${request('phase08-meta','2026-10-15T07:00:00.000Z')}' AND u.status='SUCCEEDED') NOT BETWEEN 1 AND 6
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='${META}'::uuid AND r.request_key='${request('phase08-meta','2026-10-15T07:00:00.000Z')}' AND u.unit_key='2026-10-08' AND u.status='SUCCEEDED')
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id='${CAFE}'::uuid AND credential_ref='source_credentials:${CAFE}:CAFE24_REFRESH' AND credential_expires_at>clock_timestamp())
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_credentials WHERE connection_id='${CAFE}'::uuid AND kind='CAFE24_REFRESH' AND expires_at>clock_timestamp() AND (refresh_until IS NULL OR refresh_until<=clock_timestamp()))
 OR (SELECT count(*) FROM daily_data_sync_ops.attempts WHERE schedule_key='phase08-cafe24' AND scheduled_for=timestamptz '${DUE}' AND status='ACTION_REQUIRED')<>1
 THEN RAISE EXCEPTION 'CAFE_FIXTURE_GUARD';END IF;${sourceGuards}${defs}END $guard$;
 SELECT set_config('daily_data_sync.cafe_fixture_ops',(${frozen}),true);
 ${snapshot(false)}
 ${fn}
 DO $fixture$ DECLARE marker bigint;failure bigint;BEGIN
 SELECT id INTO STRICT failure FROM daily_data_sync_ops.attempts WHERE schedule_key='phase08-cafe24' AND scheduled_for=timestamptz '${DUE}' AND status='ACTION_REQUIRED';
 INSERT INTO phase08_meta_ads.sync_runs(id,connection_id,trigger,request_key,from_date,to_date,status,actor_user_id,deadline_at) VALUES(current_setting('daily_data_sync.cafe_fixture_run')::uuid,'${CAFE}'::uuid,'SCHEDULED','${NEW}',date '2026-10-14',date '2026-10-14','QUEUED',NULL,NULL);
 INSERT INTO phase08_meta_ads.run_units(run_id,unit_key,status,attempts,fetched_count,published_count) VALUES(current_setting('daily_data_sync.cafe_fixture_run')::uuid,'2026-10-14','QUEUED',0,0,0);
 INSERT INTO daily_data_sync_ops.attempts(schedule_key,scheduled_for,status,safe_code,elapsed_ms,inspection_only) VALUES('phase08-cafe24',timestamptz '${DUE}','CAFE24_REPLAY_FIXTURE_APPROVED','CAFE24_REPLAY_FIXTURE_APPROVED',0,false) RETURNING id INTO marker;
 INSERT INTO phase08_meta_ads.security_audit_events(id,actor_user_id,actor_type,action,target_type,target_id,result,before_json,after_json) VALUES(current_setting('daily_data_sync.cafe_fixture_audit')::uuid,${q(actorId)}::uuid,'USER','${CAFE_FIXTURE_ACTION}','SYNC_RUN',current_setting('daily_data_sync.cafe_fixture_run'),'REQUESTED',jsonb_build_object('priorSuccessfulScheduledRunPreserved',true,'originalFailureAttemptId',failure::text),jsonb_build_object('requestKey','${NEW}','approvedAttemptId',marker::text,'originalFailureAttemptId',failure::text,'fixtureOnly',true,'freshCollectionRequired',true,'deadlineAt','2026-10-15T08:30:00.000Z'));
 END $fixture$;
 ${snapshot(true)}
 DO $guard$ BEGIN IF (${frozen}) IS DISTINCT FROM current_setting('daily_data_sync.cafe_fixture_ops') OR clock_timestamp()>=timestamptz '2026-10-15T08:30:00Z'-interval '60 seconds' OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure)<>${q(hash(next[2]))} THEN RAISE EXCEPTION 'CAFE_FIXTURE_FINAL_GUARD';END IF;END $guard$;
 SELECT 'PHASE08_CAFE_FIXTURE_APPLIED' AS state,1 AS new_runs,1 AS new_units,0 AS inherited_successful_units,0 AS provider_requests,true AS prior_business_preserved,${q(hash(next[2]))} AS call_md5;COMMIT;`};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>131072)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(buildAfternoonCafeFixture(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_CAFE_FIXTURE_REJECTED',rawErrorSuppressed:true,providerRequests:0}));process.exitCode=1;}finally{raw='';}}
