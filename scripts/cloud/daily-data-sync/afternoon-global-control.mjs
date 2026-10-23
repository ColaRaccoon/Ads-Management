// Fixed, user-approved October 15 isolated test controls. No provider I/O.
import {pathToFileURL} from 'node:url';
import {assertReviewedDeployment,FIXED_CONNECTIONS} from './deployment-evidence.mjs';
import {acceleratedDefinitions} from './accelerated-october15-profile.mjs';
const q=v=>`'${v.replaceAll("'","''")}'`;
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const profiles={
 'stop-setup':{profile:'normal',stop:true,start:'2026-10-15T05:08:00Z',end:'2026-10-15T05:58:00Z'},
 'resume-outage':{profile:'outage',stop:false,start:'2026-10-15T05:08:00Z',end:'2026-10-15T05:59:00Z'},
 'stop-outage-end':{profile:'outage',stop:true,start:'2026-10-15T06:38:00Z',end:'2026-10-15T07:00:00Z'},
 'resume-collection':{profile:'collection',stop:false,start:'2026-10-15T06:38:00Z',end:'2026-10-15T07:00:00Z'},
 'stop-restart':{profile:'collection',stop:true,start:'2026-10-15T07:00:30Z',end:'2026-10-15T08:15:00Z'},
 'resume-restart':{profile:'collection',stop:false,start:'2026-10-15T07:00:30Z',end:'2026-10-15T08:25:00Z'},
 'stop-normalize':{profile:'collection',stop:true,start:'2026-10-15T07:00:00Z',end:'2026-10-15T13:00:00Z'},
 'resume-normal':{profile:'normal',stop:false,start:'2026-10-15T07:00:00Z',end:'2026-10-15T13:00:00Z'},
 'stop-meta-fix':{profile:'collection',stop:true,start:'2026-10-15T07:01:00Z',end:'2026-10-15T08:15:00Z'},
 'resume-meta-fix':{profile:'collection',stop:false,start:'2026-10-15T07:01:00Z',end:'2026-10-15T08:25:00Z'},
 'stop-meta-link':{profile:'collection',stop:true,start:'2026-10-15T07:40:00Z',end:'2026-10-15T08:15:00Z'},
 'resume-meta-link':{profile:'collection',stop:false,start:'2026-10-15T07:40:00Z',end:'2026-10-15T08:25:00Z'},
 'stop-meta-budget':{profile:'collection',stop:true,start:'2026-10-15T08:02:00Z',end:'2026-10-15T08:20:00Z'},
 'resume-meta-budget':{profile:'collection',stop:false,start:'2026-10-15T08:02:00Z',end:'2026-10-15T08:29:00Z'}
};
export function buildAfternoonGlobalControl(input,{verifyEvidence=assertReviewedDeployment}={}){
 const p=profiles[input?.action];if(!p||!uuid(input.actorId)||!uuid(input.authId))throw Error('CONTROL_SCOPE');
 const action='SYNC_ACCELERATED_20261015_'+input.action.replaceAll('-','_').toUpperCase();
 const defs=acceleratedDefinitions(p.profile),app=defs.map(({key,connectionId,anchorAt,windowMinutes})=>({key,connectionId,anchorAt,windowMinutes}));
 let proof;
 if(!p.stop){
  proof=verifyEvidence(input.envelope);
  const normalize=a=>a.map(({key,connectionId,anchorAt,windowMinutes})=>({key,connectionId,anchorAt,windowMinutes})).sort((a,b)=>a.key.localeCompare(b.key));
  if(!proof.featureEnabled||!proof.scheduleEnabled||Date.now()-Date.parse(proof.databaseObservedAt)>300000||JSON.stringify(normalize(proof.appSchedules))!==JSON.stringify(normalize(app)))throw Error('CONTROL_PROOF');
 }
 const frozen=`SELECT md5(jsonb_build_object('settings',(SELECT jsonb_agg(to_jsonb(x)-'stopped') FROM daily_data_sync_ops.settings x),'schedules',(SELECT jsonb_agg(to_jsonb(x) ORDER BY key) FROM daily_data_sync_ops.schedules x),'jobs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY jobid) FROM cron.job x),'attempts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM daily_data_sync_ops.attempts x),'vault',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM vault.secrets x))::text)`;
 const business=`DO $snapshot$ DECLARE item record;digest text;all_rows text:='';BEGIN
 FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
 EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM phase08_meta_ads.%I x%s',item.tablename,CASE WHEN item.tablename='security_audit_events' THEN ' WHERE action<>'||quote_literal(${q(action)}) ELSE '' END) INTO digest;
 all_rows:=all_rows||item.tablename||':'||digest||';';END LOOP;
 PERFORM set_config('daily_data_sync.afternoon_control_business',md5(all_rows),true);END $snapshot$;`;
 const compare=business.replace("PERFORM set_config('daily_data_sync.afternoon_control_business',md5(all_rows),true);","IF md5(all_rows) IS DISTINCT FROM current_setting('daily_data_sync.afternoon_control_business') THEN RAISE EXCEPTION 'CONTROL_BUSINESS_CHANGED';END IF;");
 const active=p.profile==='outage'?138:149;
 const guards=defs.map(d=>`IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key=${q(d.key)} AND connection_id=${q(d.connectionId)}::uuid AND provider=${q(d.provider)} AND anchor_at=${q(d.anchorAt)}::timestamptz AND window_minutes=${d.windowMinutes} AND cadence_days=${d.provider==='CAFE24'?1:7} AND NOT paused) THEN RAISE EXCEPTION 'CONTROL_PROFILE';END IF;`).join('\n');
 const sources=FIXED_CONNECTIONS.map(c=>`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id=${q(c.connectionId)}::uuid AND provider=${q(c.provider)} AND external_account_id=${q(c.account)} AND shop_key=${q(c.shop)} AND currency_code=${q(c.currency)} AND time_zone=${q(c.timeZone)} AND enabled AND access_state='READY') THEN RAISE EXCEPTION 'CONTROL_SOURCE';END IF;`).join('\n');
 const currentRunGuard=input.action==='stop-normalize'?`IF EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules s WHERE s.key IN('phase08-cafe24','phase08-meta') AND clock_timestamp()<s.anchor_at+s.window_minutes*interval '1 minute' AND NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.connection_id=s.connection_id AND r.request_key='schedule:'||s.key||':'||encode(extensions.digest(to_char(s.anchor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sha256'),'hex') AND r.status IN('SUCCEEDED','FAILED','ACTION_REQUIRED','CANCELLED'))) THEN RAISE EXCEPTION 'CONTROL_COLLECTION_ACTIVE';END IF;`:'';
 const restartGuard=input.action==='stop-restart'?`IF (SELECT count(*) FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-15T07:00:00.000Z','sha256'),'hex') AND u.status='SUCCEEDED') NOT BETWEEN 1 AND 6 THEN RAISE EXCEPTION 'CONTROL_RESTART_SCOPE';END IF;`:'';
 const failureGuard=input.action==='stop-meta-fix'?`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-15T07:00:00.000Z','sha256'),'hex') AND r.status='FAILED' AND r.safe_error_code='PROVIDER_UNAVAILABLE' AND u.unit_key='2026-10-08' AND u.status='FAILED' AND u.attempts BETWEEN 1 AND 2) THEN RAISE EXCEPTION 'CONTROL_META_FAILURE_SCOPE';END IF;`:'';
 const proofGuard=proof?`OR clock_timestamp()>=${q(proof.expiresAt)}::timestamptz OR clock_timestamp()>=${q(proof.databaseObservedAt)}::timestamptz+interval '5 minutes'`:'';
 return {state:'PHASE08_AFTERNOON_GLOBAL_CONTROL_PREPARED',action:input.action,globalStopped:p.stop,sql:`BEGIN;SET LOCAL statement_timeout=30000;SET LOCAL lock_timeout=5000;
 SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));
 ${defs.map(d=>`SELECT pg_advisory_xact_lock(hashtextextended(${q('daily-data-sync-08-'+d.key)},0));`).join('\n')}
 SELECT id FROM phase08_meta_ads.source_connections ORDER BY id FOR UPDATE;
 SELECT key FROM daily_data_sync_ops.schedules ORDER BY key FOR UPDATE;
 DO $guard$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
 OR clock_timestamp()<${q(p.start)}::timestamptz OR clock_timestamp()>=${q(p.end)}::timestamptz
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 OR (SELECT count(*) FROM daily_data_sync_ops.settings)<>1 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped=${!p.stop} AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 OR (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%')<>149
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3
 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active)<>${active}
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp())
 OR (SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY id)::text) FROM daily_data_sync_ops.attempts x WHERE id<=152) IS DISTINCT FROM 'c044e6c4249188e410d31aacf57422dc'
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.security_audit_events WHERE action=${q(action)})
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.app_users a JOIN auth.users u ON u.id=a.auth_user_id WHERE a.id=${q(input.actorId)}::uuid AND a.auth_user_id=${q(input.authId)}::uuid AND a.role='SUPER_ADMIN' AND a.is_active AND a.invite_status='ACTIVE' AND a.email=u.email AND u.email_confirmed_at IS NOT NULL)
 ${proofGuard} THEN RAISE EXCEPTION 'CONTROL_GUARD';END IF;
 ${guards}
 ${sources}
 ${currentRunGuard}
 ${restartGuard}
 ${failureGuard}
 ${input.action==='stop-meta-link'?`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-15T07:00:00.000Z','sha256'),'hex') AND r.status='ACTION_REQUIRED' AND r.safe_error_code='RECONCILIATION_FAILED' AND r.rows_published=68 AND u.unit_key='2026-10-09' AND u.status='ACTION_REQUIRED' AND u.attempts=1 AND u.fetched_count=0 AND u.published_count=0 AND EXISTS(SELECT 1 FROM phase08_meta_ads.run_units first WHERE first.run_id=r.id AND first.unit_key='2026-10-08' AND first.status='SUCCEEDED' AND first.attempts=2 AND first.fetched_count=68 AND first.published_count=68)) THEN RAISE EXCEPTION 'CONTROL_META_LINK_SCOPE';END IF;`:''}
 ${input.action==='stop-meta-budget'?`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-15T07:00:00.000Z','sha256'),'hex') AND r.status IN('PARTIAL','FAILED') AND r.safe_error_code='PROVIDER_UNAVAILABLE' AND r.rows_published=68 AND u.unit_key='2026-10-09' AND u.status='FAILED' AND u.attempts=2 AND u.fetched_count=0 AND u.published_count=0 AND EXISTS(SELECT 1 FROM phase08_meta_ads.run_units first WHERE first.run_id=r.id AND first.unit_key='2026-10-08' AND first.status='SUCCEEDED' AND first.attempts=2 AND first.fetched_count=68 AND first.published_count=68)) THEN RAISE EXCEPTION 'CONTROL_META_BUDGET_SCOPE';END IF;`:''}
 END $guard$;
 SELECT set_config('daily_data_sync.afternoon_control_ops',(${frozen}),true);
 ${business}
 UPDATE daily_data_sync_ops.settings SET stopped=${p.stop} WHERE singleton;
 INSERT INTO phase08_meta_ads.security_audit_events(id,actor_user_id,actor_type,action,target_type,target_id,result,before_json,after_json) VALUES(gen_random_uuid(),${q(input.actorId)}::uuid,'USER',${q(action)},'SYNC_SCHEDULE','phase08-full-app','SUCCESS',jsonb_build_object('stopped',${!p.stop}),jsonb_build_object('stopped',${p.stop},'profile',${q(p.profile)}));
 ${compare}
 DO $guard$ BEGIN IF (${frozen}) IS DISTINCT FROM current_setting('daily_data_sync.afternoon_control_ops') THEN RAISE EXCEPTION 'CONTROL_OPS_CHANGED';END IF;END $guard$;
 SELECT 'PHASE08_AFTERNOON_GLOBAL_CONTROL_APPLIED' AS state,stopped AS global_stopped,${q(input.action)} AS action,${active} AS active_jobs,149 AS total_jobs FROM daily_data_sync_ops.settings WHERE singleton;
 COMMIT;`};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>131072)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(buildAfternoonGlobalControl(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_AFTERNOON_GLOBAL_CONTROL_REJECTED',rawErrorSuppressed:true}));process.exitCode=1;}finally{raw='';}}
