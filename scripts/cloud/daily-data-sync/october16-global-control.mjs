// Fixed, user-approved October 16 isolated test controls. No provider I/O.
import {pathToFileURL} from 'node:url';
import {assertReviewedDeployment,FIXED_CONNECTIONS} from './deployment-evidence.mjs';
import {october16Definitions} from './october16-profile.mjs';
import {october16Definitions as repeatDefinitions} from './october16-repeat-profile.mjs';
const q=v=>`'${v.replaceAll("'","''")}'`;
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const profiles={
 'resume-repeat':{profile:'repeat',stop:false,start:'2026-10-16T02:50:00Z',end:'2026-10-16T03:29:50Z'},
 'stop-repeat-publish-fix':{profile:'repeat',stop:true,start:'2026-10-16T03:30:00Z',end:'2026-10-16T04:50:00Z'},
 'resume-repeat-publish-fix':{profile:'repeat',stop:false,start:'2026-10-16T03:30:00Z',end:'2026-10-16T04:55:00Z'},
 'stop-repeat-normalize':{profile:'repeat',stop:true,start:'2026-10-16T03:30:00Z',end:'2026-10-16T13:00:00Z'},
 'resume-test':{profile:'test',stop:false,start:'2026-10-16T00:00:00Z',end:'2026-10-16T01:10:00Z'},
 'stop-restart':{profile:'test',stop:true,start:'2026-10-16T01:20:30Z',end:'2026-10-16T02:40:00Z'},
 'resume-restart':{profile:'test',stop:false,start:'2026-10-16T01:20:30Z',end:'2026-10-16T02:45:00Z'},
 'stop-issue':{profile:'test',stop:true,start:'2026-10-16T01:15:00Z',end:'2026-10-16T03:05:00Z'},
 'resume-issue':{profile:'test',stop:false,start:'2026-10-16T01:15:00Z',end:'2026-10-16T02:45:00Z'},
 'stop-meta-fix':{profile:'test',stop:true,start:'2026-10-16T01:20:00Z',end:'2026-10-16T02:35:00Z'},
 'resume-meta-fix':{profile:'test',stop:false,start:'2026-10-16T01:20:00Z',end:'2026-10-16T02:40:00Z'},
 'stop-publish-fix':{profile:'test',stop:true,start:'2026-10-16T02:20:00Z',end:'2026-10-16T02:45:00Z'},
 'resume-publish-fix':{profile:'test',stop:false,start:'2026-10-16T02:20:00Z',end:'2026-10-16T02:49:50Z'},
 'stop-v20-restart':{profile:'test',stop:true,start:'2026-10-16T02:30:00Z',end:'2026-10-16T02:47:00Z'},
 'resume-v20-restart':{profile:'test',stop:false,start:'2026-10-16T02:30:00Z',end:'2026-10-16T02:49:50Z'},
 'stop-normalize':{profile:'test',stop:true,start:'2026-10-16T01:15:00Z',end:'2026-10-16T13:00:00Z'},
 'resume-normal':{profile:'normal',stop:false,start:'2026-10-16T01:15:00Z',end:'2026-10-16T13:00:00Z'}
};
export function buildOctober16GlobalControl(input,{verifyEvidence=assertReviewedDeployment}={}){
 const p=profiles[input?.action];if(!p||!uuid(input.actorId)||!uuid(input.authId))throw Error('CONTROL_SCOPE');
 const action='SYNC_OCTOBER16_'+input.action.replaceAll('-','_').toUpperCase();
 const defs=p.profile==='repeat'?repeatDefinitions('test'):october16Definitions(p.profile),app=defs.map(({key,connectionId,anchorAt,windowMinutes})=>({key,connectionId,anchorAt,windowMinutes}));
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
 const active=149;
 const guards=defs.map(d=>`IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key=${q(d.key)} AND connection_id=${q(d.connectionId)}::uuid AND provider=${q(d.provider)} AND anchor_at=${q(d.anchorAt)}::timestamptz AND window_minutes=${d.windowMinutes} AND cadence_days=${d.provider==='CAFE24'?1:7} AND NOT paused) THEN RAISE EXCEPTION 'CONTROL_PROFILE';END IF;`).join('\n');
 const sources=FIXED_CONNECTIONS.map(c=>`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id=${q(c.connectionId)}::uuid AND provider=${q(c.provider)} AND external_account_id=${q(c.account)} AND shop_key=${q(c.shop)} AND currency_code=${q(c.currency)} AND time_zone=${q(c.timeZone)} AND enabled AND access_state='READY') THEN RAISE EXCEPTION 'CONTROL_SOURCE';END IF;`).join('\n');
 const currentRunGuard=['stop-normalize','stop-repeat-normalize'].includes(input.action)?`IF EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules s WHERE s.key IN('phase08-cafe24','phase08-meta') AND clock_timestamp()<s.anchor_at+s.window_minutes*interval '1 minute' AND NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.connection_id=s.connection_id AND r.request_key='schedule:'||s.key||':'||encode(extensions.digest(to_char(s.anchor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sha256'),'hex') AND r.status IN('SUCCEEDED','FAILED','ACTION_REQUIRED','CANCELLED'))) THEN RAISE EXCEPTION 'CONTROL_COLLECTION_ACTIVE';END IF;`:'';
 const minSuccesses=input.action==='stop-v20-restart'?2:1;
 const restartGuard=['stop-restart','stop-v20-restart'].includes(input.action)?`IF (SELECT count(*) FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-16T01:20:00.000Z','sha256'),'hex') AND u.status='SUCCEEDED') NOT BETWEEN ${minSuccesses} AND 6 THEN RAISE EXCEPTION 'CONTROL_RESTART_SCOPE';END IF;`:'';
 const proofGuard=proof?`OR clock_timestamp()>=${q(proof.expiresAt)}::timestamptz OR clock_timestamp()>=${q(proof.databaseObservedAt)}::timestamptz+interval '5 minutes'`:'';
 return {state:'PHASE08_OCTOBER16_GLOBAL_CONTROL_PREPARED',action:input.action,globalStopped:p.stop,sql:`BEGIN;SET LOCAL statement_timeout=30000;SET LOCAL lock_timeout=5000;
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
 END $guard$;
 SELECT set_config('daily_data_sync.afternoon_control_ops',(${frozen}),true);
 ${business}
 UPDATE daily_data_sync_ops.settings SET stopped=${p.stop} WHERE singleton;
 INSERT INTO phase08_meta_ads.security_audit_events(id,actor_user_id,actor_type,action,target_type,target_id,result,before_json,after_json) VALUES(gen_random_uuid(),${q(input.actorId)}::uuid,'USER',${q(action)},'SYNC_SCHEDULE','phase08-full-app','SUCCESS',jsonb_build_object('stopped',${!p.stop}),jsonb_build_object('stopped',${p.stop},'profile',${q(p.profile)}));
 ${compare}
 DO $guard$ BEGIN IF (${frozen}) IS DISTINCT FROM current_setting('daily_data_sync.afternoon_control_ops') THEN RAISE EXCEPTION 'CONTROL_OPS_CHANGED';END IF;END $guard$;
 SELECT 'PHASE08_OCTOBER16_GLOBAL_CONTROL_APPLIED' AS state,stopped AS global_stopped,${q(input.action)} AS action,${active} AS active_jobs,149 AS total_jobs FROM daily_data_sync_ops.settings WHERE singleton;
 COMMIT;`};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>131072)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(buildOctober16GlobalControl(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_OCTOBER16_GLOBAL_CONTROL_REJECTED',rawErrorSuppressed:true}));process.exitCode=1;}finally{raw='';}}
