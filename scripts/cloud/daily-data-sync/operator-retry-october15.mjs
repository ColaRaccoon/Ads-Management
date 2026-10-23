// Public SQL preparation only. A root parent must verify the reviewed successor
// app and sign fresh evidence before applying this single-occurrence recovery.
import {createHash} from 'node:crypto';
const scopes=[
 {key:'phase08-cafe24',id:'0c35defe-45fc-4a54-bc79-704df7bca5b1',provider:'CAFE24',due:'2026-10-15T01:00:00.000Z',end:'2026-10-15T02:50:00.000Z',from:'2026-10-14',to:'2026-10-14',day:'2026-10-14',code:'FIELD_UNSUPPORTED',days:1},
 {key:'phase08-meta',id:'1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6',provider:'META',due:'2026-10-15T01:02:00.000Z',end:'2026-10-15T02:32:00.000Z',from:'2026-10-08',to:'2026-10-14',day:'2026-10-08',code:'RECONCILIATION_FAILED',days:7}
];
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const q=v=>`'${v.replaceAll("'","''")}'`;
const frozen=`SELECT md5(jsonb_build_object(
 'settings',(SELECT jsonb_agg(to_jsonb(x)) FROM daily_data_sync_ops.settings x),
 'schedules',(SELECT jsonb_agg(to_jsonb(x) ORDER BY key) FROM daily_data_sync_ops.schedules x),
 'jobs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY jobid) FROM cron.job x),
 'sources',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM phase08_meta_ads.source_connections x),
 'policies',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM phase08_meta_ads.source_policies x),
 'credentials',(SELECT jsonb_agg(to_jsonb(x) ORDER BY connection_id,kind) FROM phase08_meta_ads.source_credentials x),
 'coverage',(SELECT jsonb_agg(to_jsonb(x) ORDER BY connection_id,data_kind,metric_date) FROM phase08_meta_ads.source_coverage x),
 'checkpoints',(SELECT jsonb_agg(to_jsonb(x) ORDER BY run_id,unit_key) FROM phase08_meta_ads.sync_unit_checkpoints x),
 'audits',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM phase08_meta_ads.security_audit_events x WHERE action<>'SYNC_SCHEDULE_OPERATOR_RETRY'),
 'attempts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM daily_data_sync_ops.attempts x WHERE status<>'OPERATOR_RETRY_APPROVED'),
 'googleRun',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM phase08_meta_ads.sync_runs x WHERE connection_id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900'),
 'googleUnits',(SELECT jsonb_agg(to_jsonb(x) ORDER BY unit_key) FROM phase08_meta_ads.run_units x JOIN phase08_meta_ads.sync_runs r ON r.id=x.run_id WHERE r.connection_id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900')
 )::text)`;
export function operatorRetryOctober15Sql({actorId,authId,sourceSha,callDefinition}){
 if(!uuid(actorId)||!uuid(authId)||typeof sourceSha!=='string'||!/^[a-f0-9]{64}$/.test(sourceSha)||typeof callDefinition!=='string'||callDefinition.length>20000)throw Error('OPERATOR_RETRY_PREPARATION_REJECTED');
 const match=callDefinition.match(/^CREATE OR REPLACE FUNCTION daily_data_sync_ops\.call\([\s\S]*?AS (\$\$|\$function\$)([\s\S]*)\1;?\s*$/);
 if(!match||createHash('md5').update(match[2]).digest('hex')!=='0446ef683c63d452d8b46ff739fafec4')throw Error('OPERATOR_RETRY_PREPARATION_REJECTED');
 const old="(a.status IN ('SUCCEEDED','ACTION_REQUIRED','CANCELLED') OR (a.status='EXPIRED' AND NOT a.inspection_only))";
 if(callDefinition.split(old).length!==2)throw Error('OPERATOR_RETRY_PREPARATION_REJECTED');
 const exact=scopes.map(s=>`(s.key=${q(s.key)} AND s.connection_id=${q(s.id)}::uuid AND due=${q(s.due)}::timestamptz)`).join(' OR ');
 const approved=`EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts approved JOIN phase08_meta_ads.security_audit_events approved_audit ON approved_audit.after_json->>'approvedAttemptId'=approved.id::text
 JOIN phase08_meta_ads.sync_runs approved_run ON approved_run.id::text=approved_audit.target_id AND approved_run.connection_id=s.connection_id AND approved_run.trigger='SCHEDULED'
 AND approved_run.request_key='schedule:'||s.key||':'||encode(extensions.digest(to_char(due AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sha256'),'hex')
 WHERE (${exact}) AND approved.schedule_key=s.key AND approved.scheduled_for=due AND approved.id>a.id
 AND approved.status='OPERATOR_RETRY_APPROVED' AND approved.safe_code='OPERATOR_RETRY_APPROVED' AND NOT approved.inspection_only
 AND approved_audit.action='SYNC_SCHEDULE_OPERATOR_RETRY' AND approved_audit.actor_type='USER' AND approved_audit.result='REQUESTED' AND approved_audit.target_type='SYNC_RUN'
 AND approved_audit.before_json->>'originalFailureAttemptId'=a.id::text
 AND approved_audit.before_json->>'safeErrorCode'=CASE s.provider WHEN 'CAFE24' THEN 'FIELD_UNSUPPORTED' WHEN 'META' THEN 'RECONCILIATION_FAILED' END
 AND approved_audit.after_json->>'unitKey'=CASE s.provider WHEN 'CAFE24' THEN '2026-10-14' WHEN 'META' THEN '2026-10-08' END
 AND approved_audit.after_json->>'sourceSha'=${q(sourceSha)}
 AND approved_audit.after_json->>'scheduleKey'=s.key AND approved_audit.after_json->>'scheduledFor'=to_char(due AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
 const next=`(a.status IN ('SUCCEEDED','CANCELLED') OR (a.status='EXPIRED' AND NOT a.inspection_only) OR (a.status='ACTION_REQUIRED' AND NOT (${approved})))`;
 let fn=callDefinition.replace(old,next).trim();if(!fn.endsWith(';'))fn+=';';
 const cap="AND a.status NOT IN ('MISSING_SCHEDULE','INCOMPLETE_SCHEDULE')";
 if(fn.split(cap).length!==2)throw Error('OPERATOR_RETRY_PREPARATION_REJECTED');
 fn=fn.replace(cap,"AND a.status NOT IN ('MISSING_SCHEDULE','INCOMPLETE_SCHEDULE','OPERATOR_RETRY_APPROVED')");
 const operations=scopes.map(s=>{
  const request='schedule:'+s.key+':'+createHash('sha256').update(s.due).digest('hex');
  return `DO $retry$ DECLARE r phase08_meta_ads.sync_runs; u phase08_meta_ads.run_units; marker_id bigint; old_attempt bigint; changed integer; BEGIN
 IF clock_timestamp()>=${q(s.end)}::timestamptz-interval '60 seconds' THEN RAISE EXCEPTION 'OPERATOR_RETRY_DEADLINE'; END IF;
 SELECT * INTO STRICT r FROM phase08_meta_ads.sync_runs WHERE connection_id=${q(s.id)}::uuid AND request_key=${q(request)} FOR UPDATE;
 SELECT * INTO STRICT u FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key=${q(s.day)} FOR UPDATE;
 IF r.trigger<>'SCHEDULED' OR r.from_date<>${q(s.from)}::date OR r.to_date<>${q(s.to)}::date OR r.status<>'ACTION_REQUIRED' OR r.safe_error_code<>${q(s.code)} OR r.rows_published<>0 OR u.status<>'ACTION_REQUIRED' OR u.attempts<>1 OR u.fetched_count<>0 OR u.published_count<>0
 OR (SELECT count(*) FROM phase08_meta_ads.run_units WHERE run_id=r.id)<>${s.days}
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key<>${q(s.day)} AND (status<>'QUEUED' OR attempts<>0))
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE connection_id=r.connection_id AND expires_at>clock_timestamp())
 OR EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts WHERE schedule_key=${q(s.key)} AND scheduled_for=${q(s.due)}::timestamptz AND status='OPERATOR_RETRY_APPROVED')
 THEN RAISE EXCEPTION 'OPERATOR_RETRY_STATE'; END IF;
 SELECT max(id) INTO old_attempt FROM daily_data_sync_ops.attempts WHERE schedule_key=${q(s.key)} AND scheduled_for=${q(s.due)}::timestamptz AND status='ACTION_REQUIRED';
 IF old_attempt IS NULL OR (SELECT count(*) FROM daily_data_sync_ops.attempts WHERE schedule_key=${q(s.key)} AND scheduled_for=${q(s.due)}::timestamptz AND status='ACTION_REQUIRED')<>1 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.security_audit_events WHERE action='SYNC_UNIT_ACTION_REQUIRED' AND target_id=r.id::text||':'||u.unit_key AND after_json->>'safeErrorCode'=${q(s.code)}) THEN RAISE EXCEPTION 'OPERATOR_RETRY_HISTORY'; END IF;
 ${s.provider==='CAFE24'?`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_unit_checkpoints WHERE run_id=r.id AND unit_key=u.unit_key AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'OPERATOR_RETRY_CHECKPOINT'; END IF;`:''}
 INSERT INTO daily_data_sync_ops.attempts(schedule_key,scheduled_for,status,http_status,completed_units,total_units,safe_code,elapsed_ms,inspection_only)
 VALUES(${q(s.key)},${q(s.due)}::timestamptz,'OPERATOR_RETRY_APPROVED',NULL,0,${s.days},'OPERATOR_RETRY_APPROVED',0,false) RETURNING id INTO marker_id;
 UPDATE phase08_meta_ads.run_units SET status='QUEUED' WHERE run_id=r.id AND unit_key=u.unit_key AND status='ACTION_REQUIRED' AND attempts=1; GET DIAGNOSTICS changed=ROW_COUNT;IF changed<>1 THEN RAISE EXCEPTION 'OPERATOR_RETRY_CAS'; END IF;
 UPDATE phase08_meta_ads.sync_runs SET status='PARTIAL',safe_error_code=NULL,next_attempt_at=clock_timestamp(),finished_at=NULL,deadline_at=NULL WHERE id=r.id AND status='ACTION_REQUIRED' AND safe_error_code=${q(s.code)};GET DIAGNOSTICS changed=ROW_COUNT;IF changed<>1 THEN RAISE EXCEPTION 'OPERATOR_RETRY_CAS'; END IF;
 INSERT INTO phase08_meta_ads.security_audit_events(id,actor_user_id,actor_type,action,target_type,target_id,result,before_json,after_json)
 VALUES(gen_random_uuid(),${q(actorId)}::uuid,'USER','SYNC_SCHEDULE_OPERATOR_RETRY','SYNC_RUN',r.id::text,'REQUESTED',
 jsonb_build_object('status','ACTION_REQUIRED','safeErrorCode',${q(s.code)},'unitAttempts',u.attempts,'originalFailureAttemptId',old_attempt),
 jsonb_build_object('scheduleKey',${q(s.key)},'scheduledFor',${q(s.due)},'unitKey',u.unit_key,'approvedAttemptId',marker_id::text,'sourceSha',${q(sourceSha)},'reason','REVIEWED_CORRECTION_SAME_OCCURRENCE','unitAttemptsPreserved',true,'checkpointPreserved',true,'deadlineAt',${q(s.end)}));
 END $retry$;`;
 }).join('\n');
 const allScopes=[scopes[0],{key:'phase08-google',id:'b9ebee4b-5d4e-4eae-92b9-9facfbf3c900',provider:'GOOGLE',due:'2026-10-15T01:01:00.000Z'},scopes[1]];
 const identities=[['didadi0729','shop1','KRW'],['1391592099','default','KRW'],['2138525300002203','default','USD']];
 const identityGuards=allScopes.map((s,i)=>`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id=${q(s.id)}::uuid AND provider=${q(s.provider)} AND external_account_id=${q(identities[i][0])} AND shop_key=${q(identities[i][1])} AND currency_code=${q(identities[i][2])} AND time_zone='Asia/Seoul' AND enabled AND access_state='READY') OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key=${q(s.key)} AND connection_id=${q(s.id)}::uuid AND provider=${q(s.provider)} AND anchor_at=${q(s.due)}::timestamptz AND cadence_days=${i===0?1:7} AND window_minutes=${i===0?110:90} AND NOT paused) THEN RAISE EXCEPTION 'OPERATOR_RETRY_SOURCE_OR_SCHEDULE';END IF;`).join('\n');
 return `BEGIN; SET LOCAL statement_timeout=15000;SET LOCAL lock_timeout=5000;
 SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));
 ${scopes.map(s=>`SELECT pg_advisory_xact_lock(hashtextextended(${q('daily-data-sync-08-'+s.key)},0));`).join('\n')}
 SELECT id FROM phase08_meta_ads.source_connections ORDER BY id FOR UPDATE;
 SELECT key FROM daily_data_sync_ops.schedules ORDER BY key FOR UPDATE;
 DO $guard$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL OR clock_timestamp()<timestamptz '2026-10-15T01:00:00Z'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure)<>'0446ef683c63d452d8b46ff739fafec4'
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND NOT stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active)<>149
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3 OR (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3
 OR (SELECT count(*) FROM phase08_meta_ads.source_policies)<>4
 OR (SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text) FROM phase08_meta_ads.source_policies p) IS DISTINCT FROM '20ff972b99143a992a4587dc71413224'
 OR (SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY c.connection_id,c.kind)::text) FROM phase08_meta_ads.source_credentials c) IS DISTINCT FROM '9359eadb95f1346a89b0b6b24e4c462e'
 OR (SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY c.run_id,c.unit_key)::text) FROM phase08_meta_ads.sync_unit_checkpoints c) IS DISTINCT FROM 'e6768feb581e45d422a249a6afdfa281'
 OR (SELECT count(*) FROM phase08_meta_ads.source_credentials WHERE connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1' AND kind IN ('CAFE24_ACCESS','CAFE24_REFRESH') AND expires_at>timestamptz '2026-10-15T02:50:00Z' AND (refresh_until IS NULL OR refresh_until<=clock_timestamp()))<>2
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs WHERE connection_id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900' AND trigger='SCHEDULED' AND from_date='2026-10-08' AND to_date='2026-10-14' AND status='SUCCEEDED')
 OR (SELECT md5(jsonb_agg(to_jsonb(u) ORDER BY u.unit_key)::text) FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900') IS DISTINCT FROM 'e83232df73cc32c072ec738d0a57e664'
 OR (SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY c.metric_date)::text) FROM phase08_meta_ads.source_coverage c WHERE c.connection_id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900') IS DISTINCT FROM '8eeec6a93bfb2161f1b54d3e96b51d29'
 OR (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM daily_data_sync_ops.attempts a WHERE id<=152) IS DISTINCT FROM 'c044e6c4249188e410d31aacf57422dc'
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.app_users WHERE id=${q(actorId)}::uuid AND auth_user_id=${q(authId)}::uuid AND role='SUPER_ADMIN' AND invite_status='ACTIVE' AND is_active)
 OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=${q(authId)}::uuid AND email_confirmed_at IS NOT NULL AND role='authenticated')
 OR (SELECT count(*) FROM phase08_meta_ads.source_coverage WHERE connection_id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900' AND metric_date BETWEEN '2026-10-08' AND '2026-10-14' AND source='API' AND state='COMPLETE_ZERO' AND last_success_run_id IS NOT NULL)<>7
 THEN RAISE EXCEPTION 'OPERATOR_RETRY_IDENTITY';END IF;${identityGuards} END $guard$;
 SELECT set_config('daily_data_sync.operator_retry_frozen',(${frozen}),true);
 ${fn}
 ${operations}
 DO $guard$ BEGIN IF (${frozen}) IS DISTINCT FROM current_setting('daily_data_sync.operator_retry_frozen') THEN RAISE EXCEPTION 'OPERATOR_RETRY_PRESERVATION';END IF;END $guard$;
 COMMIT;`;
}
