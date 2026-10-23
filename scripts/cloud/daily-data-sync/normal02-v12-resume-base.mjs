// Internal fixed-v12 common guards; use reviewed R3/partial execution profiles.
// One explicit root-approved post-recovery resume. It never installs, configures or reanchors.
import {pathToFileURL} from 'node:url';
import {assertReviewedDeployment} from './deployment-evidence.mjs';
import {NORMAL_02_DEFINITIONS} from './restore-02.mjs';
import {FIXED_CONNECTIONS} from './deployment-evidence.mjs';
import {jobPlan} from './core.mjs';
import {effectiveScheduleRange} from './management-batch.mjs';
const SOURCE='d1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21';
const EDGE='4d1f31ac23eb3e6479eb747546ccee41e263c688ed9d3c0a2526e1fdf6af05ad';
const q=v=>`'${v.replaceAll("'","''")}'`,uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const frozen=`SELECT md5(jsonb_build_object('settings',(SELECT jsonb_agg(to_jsonb(x)-'stopped') FROM daily_data_sync_ops.settings x),'schedules',(SELECT jsonb_agg(to_jsonb(x)-'paused' ORDER BY key) FROM daily_data_sync_ops.schedules x),'attempts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM daily_data_sync_ops.attempts x),'jobs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY jobid) FROM cron.job x),'vaultCiphertext',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM vault.secrets x),'policies',(SELECT jsonb_agg(to_jsonb(x) ORDER BY schemaname,tablename,policyname) FROM pg_policies x))::text)`;
const business=`DO $snapshot$ DECLARE item record; digest text; all_rows text:='';BEGIN
 FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
 EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM phase08_meta_ads.%I x%s',item.tablename,CASE WHEN item.tablename='security_audit_events' THEN ' WHERE action<>''SYNC_SCHEDULE_NORMAL_CLOCK_RESUME''' ELSE '' END) INTO digest;
 all_rows:=all_rows||item.tablename||':'||digest||';';END LOOP;
 PERFORM set_config('daily_data_sync.resume_business',md5(all_rows),true);
END $snapshot$;`;
export function buildNormal02V12Resume(input,{verifyEvidence=assertReviewedDeployment}={}){
 const proof=verifyEvidence(input?.envelope);
 if(proof.sourceSha!==SOURCE||!uuid(proof.deploymentId)||!uuid(input.actorId)||!uuid(input.authId)||input.edgeBundleSha!==EDGE||proof.featureEnabled!==true||proof.scheduleEnabled!==true||Date.parse(proof.databaseObservedAt)<Date.now()-300000||!Array.isArray(proof.appSchedules)||proof.appSchedules.length!==3)throw Error('NORMAL02_RESUME_REJECTED');
 for(const row of NORMAL_02_DEFINITIONS){const app=proof.appSchedules.filter(x=>x.key===row.key);if(app.length!==1||Object.keys(app[0]).sort().join()!=='anchorAt,connectionId,key,windowMinutes'||app[0].connectionId!==row.connectionId||app[0].anchorAt!==row.anchorAt||app[0].windowMinutes!==row.windowMinutes)throw Error('NORMAL02_RESUME_REJECTED');}
 const scheduleGuards=NORMAL_02_DEFINITIONS.map((r,i)=>`IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key=${q(r.key)} AND connection_id=${q(r.connectionId)}::uuid AND provider=${q(r.provider)} AND anchor_at=${q(r.anchorAt)}::timestamptz AND cadence_days=${i?7:1} AND window_minutes=${r.windowMinutes} AND paused=${i===2?'true':'false'}) THEN RAISE EXCEPTION 'NORMAL02_SCHEDULE';END IF;`).join('\n');
 const sources=FIXED_CONNECTIONS.map(r=>`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id=${q(r.connectionId)}::uuid AND provider=${q(r.provider)} AND external_account_id=${q(r.account)} AND shop_key=${q(r.shop)} AND currency_code=${q(r.currency)} AND time_zone='Asia/Seoul' AND enabled AND access_state='READY' AND (credential_expires_at IS NULL OR credential_expires_at>clock_timestamp())${r.provider==='META'?" AND credential_expires_at>clock_timestamp()+interval '7 days'":''}) THEN RAISE EXCEPTION 'NORMAL02_SOURCE';END IF;`).join('\n');
 const policyGuards=NORMAL_02_DEFINITIONS.map(row=>{const range=effectiveScheduleRange(row,Date.parse(proof.observedAt)),kinds=row.provider==='CAFE24'?['CAFE24_ORDER']:row.provider==='GOOGLE'?['GOOGLE_CAMPAIGN']:['META_AD','META_ADSET'];return kinds.map(kind=>`IF (SELECT count(*) FROM phase08_meta_ads.source_policies WHERE connection_id=${q(row.connectionId)}::uuid AND data_kind=${q(kind)} AND from_date<=${q(range.fromDate)}::date AND (to_date IS NULL OR to_date>${q(range.toDate)}::date) AND primary_source ${row.provider==='CAFE24'?"IN('CSV','API')":"='API'"})<>1 THEN RAISE EXCEPTION 'NORMAL02_FUTURE_POLICY';END IF;`).join('\n');}).join('\n');
 const jobs=NORMAL_02_DEFINITIONS.flatMap(jobPlan).map(j=>`IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname=${q(j.name)} AND schedule=${q(j.cron)} AND command=${q(j.command)} AND active AND database=current_database() AND username=current_user) THEN RAISE EXCEPTION 'NORMAL02_JOB';END IF;`).join('\n');
 const compare=business.replace("PERFORM set_config('daily_data_sync.resume_business',md5(all_rows),true);","IF md5(all_rows) IS DISTINCT FROM current_setting('daily_data_sync.resume_business') THEN RAISE EXCEPTION 'NORMAL02_BUSINESS_CHANGED';END IF;");
 return {state:'PHASE08_NORMAL02_RESUME_SQL_PREPARED',sql:`BEGIN;SET LOCAL statement_timeout=30000;SET LOCAL lock_timeout=5000;
SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));
${NORMAL_02_DEFINITIONS.map(r=>`SELECT pg_advisory_xact_lock(hashtextextended(${q('daily-data-sync-08-'+r.key)},0));`).join('\n')}
SELECT id FROM phase08_meta_ads.source_connections ORDER BY id FOR UPDATE;
SELECT key FROM daily_data_sync_ops.schedules ORDER BY key FOR UPDATE;
DO $guard$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL OR coalesce(current_setting('cron.timezone',true),'') NOT IN('GMT','UTC')
 OR clock_timestamp()>=${q(proof.expiresAt)}::timestamptz OR clock_timestamp()>=${q(proof.databaseObservedAt)}::timestamptz+interval '5 minutes'
 OR (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date<>'2026-10-15'::date
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 OR (SELECT count(*) FROM daily_data_sync_ops.settings)<>1 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3 OR (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%')<>149
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp())
 OR (SELECT count(*) FROM daily_data_sync_ops.attempts WHERE id<=152)<>152 OR (SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY id)::text) FROM daily_data_sync_ops.attempts x WHERE id<=152) IS DISTINCT FROM 'c044e6c4249188e410d31aacf57422dc'
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.security_audit_events WHERE action='SYNC_SCHEDULE_NORMAL_CLOCK_RESUME')
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.app_users a JOIN auth.users u ON u.id=a.auth_user_id WHERE a.id=${q(input.actorId)}::uuid AND a.auth_user_id=${q(input.authId)}::uuid AND a.role='SUPER_ADMIN' AND a.is_active AND a.invite_status='ACTIVE' AND a.email=u.email AND u.email_confirmed_at IS NOT NULL)
 THEN RAISE EXCEPTION 'NORMAL02_RESUME_GUARD';END IF;
 ${scheduleGuards}
 ${sources}
 ${policyGuards}
 ${jobs}
 IF (SELECT count(*) FROM phase08_meta_ads.source_policies WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND data_kind IN('META_AD','META_ADSET') AND primary_source='API' AND from_date<='2026-10-08' AND (to_date IS NULL OR to_date>'2026-10-08'))<>2 THEN RAISE EXCEPTION 'NORMAL02_POLICY';END IF;
 IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.trigger='SCHEDULED' AND r.request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-15T01:02:00.000Z','sha256'),'hex') AND r.status='FAILED' AND r.safe_error_code='PROVIDER_UNAVAILABLE' AND r.from_date='2026-10-08' AND r.to_date='2026-10-14' AND r.rows_published=0 AND (SELECT count(*) FROM phase08_meta_ads.run_units WHERE run_id=r.id)=7 AND EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key='2026-10-08' AND status='FAILED' AND attempts=2) AND NOT EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key<>'2026-10-08' AND (status<>'QUEUED' OR attempts<>0))) THEN RAISE EXCEPTION 'NORMAL02_OLD_WEEKLY';END IF;
 IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.trigger='MANUAL' AND r.request_key='phase08-manual-meta-20261008-v11-20261015' AND r.from_date='2026-10-08' AND r.to_date='2026-10-08' AND r.status='SUCCEEDED' AND r.actor_user_id=${q(input.actorId)}::uuid
 AND (SELECT count(*) FROM phase08_meta_ads.run_units WHERE run_id=r.id)=1 AND EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key='2026-10-08' AND status='SUCCEEDED')
 AND (SELECT count(*) FROM phase08_meta_ads.source_coverage c WHERE c.connection_id=r.connection_id AND c.metric_date='2026-10-08' AND c.data_kind IN('META_AD','META_ADSET') AND c.source='API' AND c.state IN('COMPLETE_ZERO','COMPLETE_NONZERO') AND c.last_success_run_id=r.id AND c.row_count=CASE c.data_kind WHEN 'META_AD' THEN(SELECT count(*) FROM phase08_meta_ads.meta_ad_daily_metrics WHERE connection_id=r.connection_id AND metric_date='2026-10-08' AND source='API' AND is_current) ELSE(SELECT count(*) FROM phase08_meta_ads.meta_adset_daily_metrics WHERE connection_id=r.connection_id AND metric_date='2026-10-08' AND source='API' AND is_current) END)=2
 AND EXISTS(SELECT 1 FROM phase08_meta_ads.security_audit_events WHERE target_id=r.id::text AND action='SYNC_RUN_QUEUED' AND actor_type='USER' AND actor_user_id=${q(input.actorId)}::uuid AND after_json->>'trigger'='MANUAL')) THEN RAISE EXCEPTION 'NORMAL02_MANUAL_RECOVERY';END IF;
 IF (SELECT count(*) FROM phase08_meta_ads.meta_ad_daily_metrics m JOIN phase08_meta_ads.source_record_links l ON l.record_id=m.id AND l.connection_id=m.connection_id AND l.data_kind='META_AD' AND l.source='API' AND l.record_table='meta_ad_daily_metrics' AND l.is_current AND l.version=m.import_version WHERE m.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND m.metric_date='2026-10-08' AND m.source='API' AND m.is_current)<>(SELECT count(*) FROM phase08_meta_ads.meta_ad_daily_metrics WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND metric_date='2026-10-08' AND source='API' AND is_current)
 OR (SELECT count(*) FROM phase08_meta_ads.meta_adset_daily_metrics m JOIN phase08_meta_ads.source_record_links l ON l.record_id=m.id AND l.connection_id=m.connection_id AND l.data_kind='META_ADSET' AND l.source='API' AND l.record_table='meta_adset_daily_metrics' AND l.is_current AND l.version=m.import_version WHERE m.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND m.metric_date='2026-10-08' AND m.source='API' AND m.is_current)<>(SELECT count(*) FROM phase08_meta_ads.meta_adset_daily_metrics WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND metric_date='2026-10-08' AND source='API' AND is_current) THEN RAISE EXCEPTION 'NORMAL02_LINKS';END IF;
END $guard$;
${business}
SELECT set_config('daily_data_sync.resume_ops',(${frozen}),true);
UPDATE daily_data_sync_ops.schedules SET paused=false WHERE key='phase08-meta' AND paused;
UPDATE daily_data_sync_ops.settings SET stopped=false WHERE singleton AND stopped;
INSERT INTO phase08_meta_ads.security_audit_events(id,actor_user_id,actor_type,action,target_type,target_id,result,before_json,after_json) VALUES(gen_random_uuid(),${q(input.actorId)}::uuid,'USER','SYNC_SCHEDULE_NORMAL_CLOCK_RESUME','SYNC_SCHEDULE','phase08-meta','SUCCESS',jsonb_build_object('stopped',true,'metaPaused',true),jsonb_build_object('stopped',false,'metaPaused',false,'sourceSha',${q(SOURCE)},'deploymentId',${q(proof.deploymentId)},'manualRecoveredDay','2026-10-08','originalWeeklySucceeded',false,'remainingUncollectedDates',6));
${compare}
DO $guard$ BEGIN IF (${frozen}) IS DISTINCT FROM current_setting('daily_data_sync.resume_ops') OR EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE stopped) OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE paused) THEN RAISE EXCEPTION 'NORMAL02_RESUME_PRESERVATION';END IF;END $guard$;
SELECT 'PHASE08_NORMAL02_RESUMED' AS state,false AS global_stopped,false AS meta_paused,149 AS active_jobs,true AS business_history_preserved,false AS original_weekly_succeeded,6 AS uncollected_old_dates;
COMMIT;`};
}
