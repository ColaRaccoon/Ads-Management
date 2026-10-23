// One reviewed correction retry of the original failed day. Never fabricate success.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const q=v=>`'${v.replaceAll("'","''")}'`,md5=v=>createHash('md5').update(v).digest('hex');
const KEY='schedule:phase08-meta:'+createHash('sha256').update('2026-10-15T07:00:00.000Z').digest('hex');
export const META_LINK_RETRY_ACTION='SYNC_META_DAY09_LINK_CORRECTION_REVIEWED';
export const META_LINK_RETRY_MARKER='META_LINK_RETRY_APPROVED';
const clause="(a.status='ACTION_REQUIRED' AND NOT (";
export const META_LINK_RETRY_APPROVAL_SQL=`EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts marker JOIN phase08_meta_ads.security_audit_events event ON event.after_json->>'approvedAttemptId'=marker.id::text JOIN phase08_meta_ads.sync_runs retry ON retry.id::text=event.target_id
 WHERE s.key='phase08-meta' AND s.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'::uuid AND due=timestamptz '2026-10-15T07:00:00Z' AND s.anchor_at=due AND s.window_minutes=90
 AND marker.schedule_key=s.key AND marker.scheduled_for=due AND marker.id>a.id AND marker.status='${META_LINK_RETRY_MARKER}' AND marker.safe_code='${META_LINK_RETRY_MARKER}' AND NOT marker.inspection_only
 AND event.action='${META_LINK_RETRY_ACTION}' AND event.actor_type='USER' AND event.result='REQUESTED' AND event.target_type='SYNC_RUN' AND event.after_json->>'requestKey'='${KEY}' AND event.after_json->>'originalFailureAttemptId'=a.id::text
 AND retry.connection_id=s.connection_id AND retry.trigger='SCHEDULED' AND retry.request_key='${KEY}' AND retry.actor_user_id IS NULL AND retry.from_date=date '2026-10-08' AND retry.to_date=date '2026-10-14' AND retry.status IN('QUEUED','RUNNING','PARTIAL','FAILED','SUCCEEDED'))`;
export function removeMetaLinkRetryCallException(definition){const needle=clause+META_LINK_RETRY_APPROVAL_SQL+' OR ';if(definition.split(needle).length!==2)throw Error('META_LINK_CALL');return definition.replace(needle,clause);}
const digest=table=>`(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text)::text,'[]')) FROM ${table} x)`;
export function buildMetaLinkRetry(input){
 const {actorId,authId,currentCallDefinition}=input??{};
 if(![actorId,authId].every(x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x))||typeof currentCallDefinition!=='string'||currentCallDefinition.length>30000)throw Error('META_LINK_INPUT');
 const body=currentCallDefinition.match(/AS (\$\$|\$function\$)([\s\S]*)\1;?\s*$/);
 if(!body||md5(body[2])!=='fd90904cdf9cf3f6ef962ab8c2cbfc3f'||currentCallDefinition.split(clause).length!==2)throw Error('META_LINK_CALL');
 let fn=currentCallDefinition.replace(clause,()=>clause+META_LINK_RETRY_APPROVAL_SQL+' OR ').trim();if(!fn.endsWith(';'))fn+=';';
 if(removeMetaLinkRetryCallException(fn).trim().replace(/;$/,'')!==currentCallDefinition.trim().replace(/;$/,''))throw Error('META_LINK_CALL');
 const resultCallMd5=md5(fn.match(/AS (\$\$|\$function\$)([\s\S]*)\1;\s*$/)[2]);
 const frozen=`SELECT md5(jsonb_build_object('settings',${digest('daily_data_sync_ops.settings')},'schedules',${digest('daily_data_sync_ops.schedules')},'jobs',${digest('cron.job')},'vault',${digest('vault.secrets')},'attempts',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'[]')) FROM daily_data_sync_ops.attempts x WHERE status<>'${META_LINK_RETRY_MARKER}'))::text)`;
 const business=compare=>`DO $snap$ DECLARE t record;part text;joined text:='';BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
 EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM phase08_meta_ads.%I x WHERE NOT ((%L=''sync_runs'' AND to_jsonb(x)->>''id''=current_setting(''daily_data_sync.meta_link_run'')) OR (%L=''run_units'' AND to_jsonb(x)->>''run_id''=current_setting(''daily_data_sync.meta_link_run'') AND to_jsonb(x)->>''unit_key''=''2026-10-09'') OR (%L=''security_audit_events'' AND to_jsonb(x)->>''id''=current_setting(''daily_data_sync.meta_link_audit'')))',t.tablename,t.tablename,t.tablename,t.tablename) INTO part;joined:=joined||t.tablename||':'||part||';';END LOOP;
 ${compare?"IF md5(joined) IS DISTINCT FROM current_setting('daily_data_sync.meta_link_business') THEN RAISE EXCEPTION 'META_LINK_BUSINESS';END IF;":"PERFORM set_config('daily_data_sync.meta_link_business',md5(joined),true);"}END $snap$;`;
 return {state:'PHASE08_META_LINK_RETRY_PREPARED',resultCallMd5,sql:`BEGIN ISOLATION LEVEL REPEATABLE READ;SET LOCAL statement_timeout=15000;SET LOCAL lock_timeout=5000;
 SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-phase08-meta',0));
 SELECT id FROM phase08_meta_ads.source_connections ORDER BY id FOR UPDATE;SELECT key FROM daily_data_sync_ops.schedules ORDER BY key FOR UPDATE;
 SELECT set_config('daily_data_sync.meta_link_audit',gen_random_uuid()::text,true);
 DO $guard$ DECLARE r phase08_meta_ads.sync_runs%ROWTYPE;BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL OR clock_timestamp()<timestamptz '2026-10-15T07:40:00Z' OR clock_timestamp()>=timestamptz '2026-10-15T08:25:00Z'
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 OR (SELECT count(*) FROM daily_data_sync_ops.settings)<>1 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) OR (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3 OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3
 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key='phase08-meta' AND connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND provider='META' AND cadence_days=7 AND anchor_at=timestamptz '2026-10-15T07:00:00Z' AND window_minutes=90 AND NOT paused)
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND provider='META' AND external_account_id='2138525300002203' AND shop_key='default' AND currency_code='USD' AND time_zone='Asia/Seoul' AND enabled AND access_state='READY')
 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%')<>149 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active)<>149
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure)<>'fd90904cdf9cf3f6ef962ab8c2cbfc3f'
 OR (SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY id)::text) FROM daily_data_sync_ops.attempts x WHERE id<=152) IS DISTINCT FROM 'c044e6c4249188e410d31aacf57422dc'
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.security_audit_events WHERE action='${META_LINK_RETRY_ACTION}') OR EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts WHERE status='${META_LINK_RETRY_MARKER}')
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.app_users a JOIN auth.users u ON u.id=a.auth_user_id WHERE a.id=${q(actorId)}::uuid AND a.auth_user_id=${q(authId)}::uuid AND a.role='SUPER_ADMIN' AND a.is_active AND a.invite_status='ACTIVE' AND a.email=u.email AND u.email_confirmed_at IS NOT NULL)
 THEN RAISE EXCEPTION 'META_LINK_GUARD';END IF;
 SELECT * INTO STRICT r FROM phase08_meta_ads.sync_runs WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND request_key='${KEY}' FOR UPDATE;
 IF r.trigger<>'SCHEDULED' OR r.actor_user_id IS NOT NULL OR r.status<>'ACTION_REQUIRED' OR r.safe_error_code IS DISTINCT FROM 'RECONCILIATION_FAILED' OR r.rows_published<>68 OR r.rows_fetched<>68 OR r.attempt_count<>3 OR r.from_date<>date '2026-10-08' OR r.to_date<>date '2026-10-14'
 OR (SELECT count(*) FROM phase08_meta_ads.run_units WHERE run_id=r.id)<>7
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key='2026-10-08' AND status='SUCCEEDED' AND attempts=2 AND fetched_count=68 AND published_count=68)
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key='2026-10-09' AND status='ACTION_REQUIRED' AND attempts=1 AND fetched_count=0 AND published_count=0)
 OR (SELECT count(*) FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key BETWEEN '2026-10-10' AND '2026-10-14' AND status='QUEUED' AND attempts=0 AND fetched_count=0 AND published_count=0)<>5
 OR (SELECT count(*) FROM daily_data_sync_ops.attempts WHERE schedule_key='phase08-meta' AND scheduled_for=timestamptz '2026-10-15T07:00:00Z' AND status='ACTION_REQUIRED')<>1
 THEN RAISE EXCEPTION 'META_LINK_RUN';END IF;PERFORM set_config('daily_data_sync.meta_link_run',r.id::text,true);END $guard$;
 SELECT set_config('daily_data_sync.meta_link_ops',(${frozen}),true);
 ${business(false)}
 ${fn}
 DO $retry$ DECLARE failure bigint;marker bigint;r phase08_meta_ads.sync_runs%ROWTYPE;u phase08_meta_ads.run_units%ROWTYPE;BEGIN
 SELECT * INTO STRICT r FROM phase08_meta_ads.sync_runs WHERE id=current_setting('daily_data_sync.meta_link_run')::uuid;
 SELECT * INTO STRICT u FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key='2026-10-09';
 SELECT id INTO STRICT failure FROM daily_data_sync_ops.attempts WHERE schedule_key='phase08-meta' AND scheduled_for=timestamptz '2026-10-15T07:00:00Z' AND status='ACTION_REQUIRED';
 INSERT INTO daily_data_sync_ops.attempts(schedule_key,scheduled_for,status,safe_code,elapsed_ms,inspection_only) VALUES('phase08-meta',timestamptz '2026-10-15T07:00:00Z','${META_LINK_RETRY_MARKER}','${META_LINK_RETRY_MARKER}',0,false) RETURNING id INTO marker;
 INSERT INTO phase08_meta_ads.security_audit_events(id,actor_user_id,actor_type,action,target_type,target_id,result,before_json,after_json) VALUES(current_setting('daily_data_sync.meta_link_audit')::uuid,${q(actorId)}::uuid,'USER','${META_LINK_RETRY_ACTION}','SYNC_RUN',r.id::text,'REQUESTED',jsonb_build_object('run',to_jsonb(r),'failedUnit',to_jsonb(u)),jsonb_build_object('requestKey','${KEY}','approvedAttemptId',marker::text,'originalFailureAttemptId',failure::text,'day','2026-10-09','attemptsPreserved',true,'deadlineAt','2026-10-15T08:30:00.000Z'));
 UPDATE phase08_meta_ads.run_units SET status='FAILED' WHERE run_id=r.id AND unit_key='2026-10-09';
 UPDATE phase08_meta_ads.sync_runs SET status='PARTIAL' WHERE id=r.id;
 END $retry$;
 ${business(true)}
 DO $guard$ BEGIN IF (${frozen}) IS DISTINCT FROM current_setting('daily_data_sync.meta_link_ops') OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure)<>${q(resultCallMd5)} THEN RAISE EXCEPTION 'META_LINK_FINAL';END IF;END $guard$;
 SELECT 'PHASE08_META_LINK_RETRY_APPLIED' AS state,1 AS reviewed_units,0 AS provider_requests,true AS prior_business_preserved,${q(resultCallMd5)} AS call_md5;COMMIT;`};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const bytes of process.stdin){raw+=bytes;if(Buffer.byteLength(raw)>131072)throw Error('BOUND');}process.stdout.write(JSON.stringify(buildMetaLinkRetry(JSON.parse(raw))));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_META_LINK_RETRY_REJECTED',rawErrorSuppressed:true,providerRequests:0}));process.exitCode=1;}finally{raw='';}}
