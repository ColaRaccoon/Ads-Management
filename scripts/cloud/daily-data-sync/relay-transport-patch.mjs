import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {jobPlan} from './core.mjs';
import {FIXED_CONNECTIONS} from './deployment-evidence.mjs';
import {SCHEDULES} from './fixtures/relay-20261015-v2.mjs';
export const RELAY_URL='https://ehnfrrmbkvlsbpvqcvkr.supabase.co/functions/v1/phase08-scheduled-relay';
export const RELAY_VAULT_NAME='daily_data_sync_08_relay_userpwd';
const sourceUrl=new URL('./install.sql',import.meta.url);
const quote=value=>`'${value.replaceAll("'","''")}'`;
const frozenState=`SELECT md5(jsonb_build_object(
 'settings',(SELECT jsonb_agg(to_jsonb(x) ORDER BY singleton) FROM daily_data_sync_ops.settings x),
 'schedules',(SELECT jsonb_agg(to_jsonb(x) ORDER BY key) FROM daily_data_sync_ops.schedules x),
 'attempts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM daily_data_sync_ops.attempts x),
 'jobs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY jobid) FROM cron.job x),
 'sources',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM phase08_meta_ads.source_connections x),
 'policies',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM phase08_meta_ads.source_policies x),
 'oldTables',(SELECT jsonb_agg(to_jsonb(x) ORDER BY schemaname,tablename) FROM pg_catalog.pg_tables x WHERE schemaname NOT IN ('daily_data_sync_ops','cron','vault')),
 'rls',(SELECT jsonb_agg(to_jsonb(x) ORDER BY schemaname,tablename,policyname) FROM pg_catalog.pg_policies x)
 )::text)`;
export async function relayTransportPatchSql({expectedProsrcMd5,reviewedRelaySourceSha256}) {
 if(typeof expectedProsrcMd5!=='string'||!/^[a-f0-9]{32}$/.test(expectedProsrcMd5)||typeof reviewedRelaySourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(reviewedRelaySourceSha256))throw new Error('PHASE08_RELAY_PATCH_REJECTED');
 const source=(await readFile(sourceUrl,'utf8')).replace(/\r\n/g,'\n'),start=source.indexOf('CREATE OR REPLACE FUNCTION daily_data_sync_ops.call('),end=source.indexOf('CREATE OR REPLACE FUNCTION daily_data_sync_ops.invoke(',start);
 if(start<0||end<0)throw new Error('PHASE08_RELAY_PATCH_REJECTED');let fn=source.slice(start,end).trim();
 const replace=(old,value)=>{if(fn.split(old).length!==2)throw new Error('PHASE08_RELAY_PATCH_REJECTED');fn=fn.replace(old,()=>value);};
 replace("BEGIN\n    SELECT decrypted_secret",`BEGIN
    IF current_setting('log_min_messages') NOT IN ('info','notice','warning','error','log','fatal','panic') OR current_setting('client_min_messages') NOT IN ('info','notice','warning','error') THEN RAISE EXCEPTION 'UNSAFE_LOGGING'; END IF;
    PERFORM extensions.http_reset_curlopt();
    SELECT decrypted_secret`);
 replace("WHERE name='daily_data_sync_08_machine'",`WHERE name='${RELAY_VAULT_NAME}'`);
 replace("IF length(secret)<32 THEN RAISE EXCEPTION 'MISSING_SECRET'; END IF;","IF secret !~ '^phase08-scheduler:[A-Za-z0-9+/]{43}=$' THEN RAISE EXCEPTION 'MISSING_SECRET'; END IF;");
 replace("PERFORM extensions.http_set_curlopt('CURLOPT_FOLLOWLOCATION','0');","PERFORM extensions.http_set_curlopt('CURLOPT_USERPWD',secret);");
 replace("'POST',cfg.origin||'/backend-api/internal/daily-sync'",`'POST','${RELAY_URL}'`);
 replace("ARRAY[extensions.http_header('x-daily-sync-token',secret),extensions.http_header('x-daily-sync-target',cfg.target_id)]","ARRAY[extensions.http_header('x-daily-sync-target',cfg.target_id)]");
 replace('EXCEPTION WHEN OTHERS THEN',`EXCEPTION WHEN query_canceled THEN
    secret:=NULL; PERFORM extensions.http_reset_curlopt();
    RAISE;
  WHEN OTHERS THEN`);
 const sourceDigest=createHash('sha256').update(fn).digest('hex');
 const definitions=SCHEDULES.map(row=>{const source=FIXED_CONNECTIONS.find(item=>`phase08-${item.provider.toLowerCase()}`===row.key);return {key:row.key,connectionId:source.connectionId,provider:source.provider,timeZone:'Asia/Seoul',anchorAt:row.anchor,windowMinutes:row.window,targetId:'phase08-full-app'};});
 const shapeGuards=definitions.map(row=>`IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key=${quote(row.key)} AND connection_id=${quote(row.connectionId)}::uuid AND provider=${quote(row.provider)} AND anchor_at=${quote(row.anchorAt)}::timestamptz AND cadence_days=${row.provider==='CAFE24'?1:7} AND window_minutes=${row.windowMinutes} AND NOT paused) THEN RAISE EXCEPTION 'PHASE08_RELAY_PATCH_SCHEDULE_REJECTED'; END IF;`).join('\n');
 const jobGuards=definitions.flatMap(jobPlan).map(job=>`IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname=${quote(job.name)} AND schedule=${quote(job.cron)} AND command=${quote(job.command)} AND active AND database=current_database() AND username=current_user) THEN RAISE EXCEPTION 'PHASE08_RELAY_PATCH_JOB_REJECTED'; END IF;`).join('\n');
 return `BEGIN;
SET LOCAL statement_timeout=15000;
SET LOCAL lock_timeout=5000;
SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));
${definitions.map(row=>`SELECT pg_advisory_xact_lock(hashtextextended(${quote('daily-data-sync-08-'+row.key)},0));`).join('\n')}
DO $guard$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
 OR (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads')<>68
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 OR (SELECT count(*) FROM daily_data_sync_ops.settings)<>1
 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND NOT stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 OR (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%')<>149
 OR (SELECT count(*) FROM daily_data_sync_ops.attempts)<>152
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections WHERE enabled AND access_state='READY' AND time_zone='Asia/Seoul' AND ((id='0c35defe-45fc-4a54-bc79-704df7bca5b1'::uuid AND provider='CAFE24' AND external_account_id='didadi0729' AND shop_key='shop1' AND currency_code='KRW') OR (id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900'::uuid AND provider='GOOGLE' AND external_account_id='1391592099' AND shop_key='default' AND currency_code='KRW') OR (id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'::uuid AND provider='META' AND external_account_id='2138525300002203' AND shop_key='default' AND currency_code='USD')))<>3
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs) OR EXISTS(SELECT 1 FROM phase08_meta_ads.source_coverage)
 OR (SELECT count(*) FROM phase08_meta_ads.source_policies)<>4
 OR (SELECT count(*) FROM vault.secrets WHERE name='daily_data_sync_08_machine')<>1
 OR (SELECT count(*) FROM vault.secrets WHERE name='${RELAY_VAULT_NAME}')<>1
 OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) IS DISTINCT FROM '${expectedProsrcMd5}'
 THEN RAISE EXCEPTION 'PHASE08_RELAY_PATCH_IDENTITY_REJECTED'; END IF;
 ${shapeGuards}
 ${jobGuards}
END $guard$;
SELECT set_config('daily_data_sync.relay_patch_frozen',(${frozenState}),true);
-- Reviewed Edge source ${reviewedRelaySourceSha256}; generated call definition ${sourceDigest}.
${fn}
REVOKE ALL ON FUNCTION daily_data_sync_ops.call(text,boolean) FROM PUBLIC,anon,authenticated,service_role,phase08_runtime,phase08_storage_app,phase08_migration;
DO $guard$ BEGIN IF (${frozenState}) IS DISTINCT FROM current_setting('daily_data_sync.relay_patch_frozen') THEN RAISE EXCEPTION 'PHASE08_RELAY_PATCH_PRESERVATION_REJECTED'; END IF; END $guard$;
COMMIT;`;
}
