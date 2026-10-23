import {createHash} from 'node:crypto';
import {jobPlan} from './core.mjs';
import {FIXED_CONNECTIONS} from './deployment-evidence.mjs';
import {SCHEDULES,ORIGINAL_SCHEDULES} from './fixtures/relay-20261015-v2.mjs';
const q=s=>`'${s.replaceAll("'","''")}'`;
const definitions=rows=>rows.map(r=>({key:r.key,provider:r.key.slice(8).toUpperCase(),connectionId:FIXED_CONNECTIONS.find(c=>`phase08-${c.provider.toLowerCase()}`===r.key).connectionId,timeZone:'Asia/Seoul',anchorAt:r.anchor,windowMinutes:r.window,targetId:'phase08-full-app'}));
export function reanchorOctober15Sql({currentCallDefinition,expectedProsrcMd5}){
 if(typeof currentCallDefinition!=='string'||!/^[a-f0-9]{32}$/.test(expectedProsrcMd5??'')||currentCallDefinition.length>20000)throw Error('TEST_REANCHOR_REJECTED');
 const pattern=/^CREATE OR REPLACE FUNCTION daily_data_sync_ops\.call\(schedule_key text, inspection_only boolean(?: DEFAULT false)?\)[\s\S]*?AS (\$\$|\$function\$)([\s\S]*)\1;?\s*$/;
 const match=currentCallDefinition.match(pattern);
 if(!match||createHash('md5').update(match[2]).digest('hex')!==expectedProsrcMd5||!currentCallDefinition.includes('WHEN query_canceled THEN')||!currentCallDefinition.includes("CURLOPT_USERPWD")||!currentCallDefinition.includes('https://ehnfrrmbkvlsbpvqcvkr.supabase.co/functions/v1/phase08-scheduled-relay'))throw Error('TEST_REANCHOR_REJECTED');
 const old=definitions(ORIGINAL_SCHEDULES),next=definitions(SCHEDULES),oldJobs=old.flatMap(jobPlan),newJobs=next.flatMap(jobPlan);
 let fn=currentCallDefinition.trim().replace(/;?$/,';');
 const before="IF (started AT TIME ZONE 'Asia/Seoul')::time >= time '04:00' OR\n       (started AT TIME ZONE 'Asia/Seoul')::time < time '02:00' THEN RETURN 'OUTSIDE_RECONCILIATION_WINDOW'; END IF;";
 const allowed=next.map(r=>`(s.key=${q(r.key)} AND s.connection_id=${q(r.connectionId)}::uuid AND s.provider=${q(r.provider)} AND s.anchor_at=${q(r.anchorAt)}::timestamptz AND due=s.anchor_at)`).join(' OR ');
 const replacement=`IF (${allowed}) THEN\n      IF started>=timestamptz '2026-10-15T03:00:00Z' THEN RETURN 'OUTSIDE_RECONCILIATION_WINDOW'; END IF;\n    ELSIF (started AT TIME ZONE 'Asia/Seoul')::time >= time '04:00' OR (started AT TIME ZONE 'Asia/Seoul')::time < time '02:00' THEN RETURN 'OUTSIDE_RECONCILIATION_WINDOW'; END IF;`;
 if(fn.split(before).length!==2)throw Error('TEST_REANCHOR_REJECTED');fn=fn.replace(before,replacement);
 const timeout="timeout_ms:=least(85000,extract(epoch FROM (date_trunc('day',started AT TIME ZONE 'Asia/Seoul')+interval '4 hours'-(started AT TIME ZONE 'Asia/Seoul')))*1000-2000)::integer;";
 if(fn.split(timeout).length!==2)throw Error('TEST_REANCHOR_REJECTED');fn=fn.replace(timeout,`IF (${allowed}) THEN timeout_ms:=least(85000,extract(epoch FROM (timestamptz '2026-10-15T03:00:00Z'-started))*1000-2000)::integer; ELSE ${timeout} END IF;`);
 const sourceGuards=FIXED_CONNECTIONS.map(c=>`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id=${q(c.connectionId)}::uuid AND provider=${q(c.provider)} AND external_account_id=${q(c.account)} AND shop_key=${q(c.shop)} AND currency_code=${q(c.currency)} AND time_zone='Asia/Seoul' AND enabled AND access_state='READY') THEN RAISE EXCEPTION 'TEST_REANCHOR_SOURCE_REJECTED'; END IF;`).join('\n');
 const jobGuards=oldJobs.map(j=>`IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname=${q(j.name)} AND schedule=${q(j.cron)} AND command=${q(j.command)} AND active AND database=current_database() AND username=current_user) THEN RAISE EXCEPTION 'TEST_REANCHOR_JOB_REJECTED'; END IF;`).join('\n');
 const scheduleGuards=old.map(r=>`IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key=${q(r.key)} AND connection_id=${q(r.connectionId)}::uuid AND provider=${q(r.provider)} AND anchor_at=${q(r.anchorAt)}::timestamptz AND cadence_days=${r.provider==='CAFE24'?1:7} AND window_minutes=${r.windowMinutes} AND NOT paused) THEN RAISE EXCEPTION 'TEST_REANCHOR_SCOPE_REJECTED'; END IF;`).join('\n');
 return `BEGIN;
SET LOCAL statement_timeout=15000; SET LOCAL lock_timeout=5000;
SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));
${old.map(r=>`SELECT pg_advisory_xact_lock(hashtextextended(${q('daily-data-sync-08-'+r.key)},0));`).join('\n')}
DO $guard$ BEGIN
 IF clock_timestamp()>=timestamptz '2026-10-15T00:59:30Z' OR clock_timestamp()<timestamptz '2026-10-15T00:00:00Z' OR current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 OR (SELECT count(*) FROM daily_data_sync_ops.settings)<>1 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND NOT stopped AND origin='https://phase08-daily-data-sync-production.up.railway.app' AND target_id='phase08-full-app')
 OR (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%')<>149
 OR (SELECT count(*) FROM daily_data_sync_ops.attempts)<>152 OR EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts WHERE http_status IS NOT NULL)
 OR (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM daily_data_sync_ops.attempts a) IS DISTINCT FROM 'c044e6c4249188e410d31aacf57422dc'
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs) OR EXISTS(SELECT 1 FROM phase08_meta_ads.run_units) OR EXISTS(SELECT 1 FROM phase08_meta_ads.source_coverage) OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases) OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_unit_checkpoints)
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections WHERE enabled AND access_state='READY')<>3 OR (SELECT count(*) FROM phase08_meta_ads.source_policies)<>4
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) IS DISTINCT FROM ${q(expectedProsrcMd5)} THEN RAISE EXCEPTION 'TEST_REANCHOR_REJECTED'; END IF;
 ${scheduleGuards}
 ${sourceGuards}
 ${jobGuards}
END $guard$;
SELECT set_config('daily_data_sync.test_attempts',(SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM daily_data_sync_ops.attempts a),true);
${fn}
${next.map(r=>`UPDATE daily_data_sync_ops.schedules SET anchor_at=${q(r.anchorAt)}::timestamptz WHERE key=${q(r.key)};`).join('\n')}
${newJobs.map(j=>`SELECT cron.alter_job(jobid,schedule:=${q(j.cron)}) FROM cron.job WHERE jobname=${q(j.name)};`).join('\n')}
DO $guard$ BEGIN IF clock_timestamp()>=timestamptz '2026-10-15T01:00:00Z' OR (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM daily_data_sync_ops.attempts a) IS DISTINCT FROM current_setting('daily_data_sync.test_attempts') THEN RAISE EXCEPTION 'TEST_REANCHOR_PRESERVATION_REJECTED'; END IF; END $guard$;
COMMIT;`;
}
