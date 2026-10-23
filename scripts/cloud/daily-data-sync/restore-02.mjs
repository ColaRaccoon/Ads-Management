// Preparation only: restore the original clock after the authorized October15 test.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {jobPlan} from './core.mjs';
import {FIXED_CONNECTIONS} from './deployment-evidence.mjs';
import {relayTransportPatchSql} from './relay-transport-patch.mjs';
import {reanchorOctober15Sql} from './reanchor-october15.mjs';
import {operatorRetryOctober15Sql} from './operator-retry-october15.mjs';
const REVIEWED_V9_SOURCE='a986132a8f70757ca67ae93b54ce378926166da30ec9817378f206062e214097';
const bodyOf=fn=>fn.match(/AS (\$\$|\$function\$)([\s\S]*?)\1;?\s*$/)?.[2];
const extractCall=sql=>sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION daily_data_sync_ops.call(')).match(/^[\s\S]*?AS (\$\$|\$function\$)([\s\S]*?)\1;?/)[0];
const md5=value=>createHash('md5').update(value).digest('hex');
const q=value=>`'${value.replaceAll("'","''")}'`;
export const NORMAL_02_DEFINITIONS=Object.freeze(FIXED_CONNECTIONS.map((source,index)=>Object.freeze({key:'phase08-'+source.provider.toLowerCase(),connectionId:source.connectionId,provider:source.provider,timeZone:'Asia/Seoul',anchorAt:`2026-10-14T17:0${index}:00.000Z`,windowMinutes:source.provider==='CAFE24'?110:90,targetId:'phase08-full-app'})));
export const TEST_10_DEFINITIONS=Object.freeze(NORMAL_02_DEFINITIONS.map((row,index)=>Object.freeze({...row,anchorAt:`2026-10-15T01:0${index}:00.000Z`})));
const businessSnapshot=`DO $snapshot$ DECLARE row record; item text; state text:=''; BEGIN
 FOR row IN SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
  EXECUTE format('SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'''' ORDER BY md5(to_jsonb(t)::text)),'''')) FROM phase08_meta_ads.%I t',row.tablename) INTO item;
  state:=state||row.tablename||':'||item||';';
 END LOOP;
 PERFORM set_config('daily_data_sync.restore_business_digest',md5(state),true);
END $snapshot$;`;
const compareBusiness=businessSnapshot.replace("PERFORM set_config('daily_data_sync.restore_business_digest',md5(state),true);", "IF md5(state) IS DISTINCT FROM current_setting('daily_data_sync.restore_business_digest') THEN RAISE EXCEPTION 'RESTORE_02_BUSINESS_CHANGED'; END IF;");
const frozenOps=`SELECT md5(jsonb_build_object(
 'settings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY singleton) FROM daily_data_sync_ops.settings s),
 'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM daily_data_sync_ops.attempts a),
 'schedules',(SELECT jsonb_agg(to_jsonb(s)-'anchor_at' ORDER BY key) FROM daily_data_sync_ops.schedules s),
 'ownJobs',(SELECT jsonb_agg(to_jsonb(j)-'schedule' ORDER BY jobid) FROM cron.job j WHERE jobname LIKE 'daily-data-sync-08-%'),
 'otherJobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j WHERE jobname NOT LIKE 'daily-data-sync-08-%'),
 'vaultCiphertext',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM vault.secrets v),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname) FROM pg_catalog.pg_policies p)
 )::text)`;
export async function restore02Sql({currentCallDefinition,expectedProsrcMd5}){
 if(typeof currentCallDefinition!=='string'||currentCallDefinition.length>30000||!/^[a-f0-9]{32}$/.test(expectedProsrcMd5??''))throw Error('RESTORE_02_REJECTED');
 const match=currentCallDefinition.match(/^CREATE OR REPLACE FUNCTION daily_data_sync_ops\.call\(schedule_key text, inspection_only boolean(?: DEFAULT false)?\)[\s\S]*?AS (\$\$|\$function\$)([\s\S]*)\1;?\s*$/);
 if(!match||createHash('md5').update(match[2]).digest('hex')!==expectedProsrcMd5||!currentCallDefinition.includes('WHEN query_canceled THEN')||!currentCallDefinition.includes('CURLOPT_USERPWD')||!currentCallDefinition.includes('https://ehnfrrmbkvlsbpvqcvkr.supabase.co/functions/v1/phase08-scheduled-relay'))throw Error('RESTORE_02_REJECTED');
 // Reconstruct all three reviewed bodies, then compare the complete prosrc. This
 // removes both the one-day inspection exception and operator-retry exceptions;
 // it cannot silently retain an unreviewed function edit or discard audit rows.
 const normal=extractCall(await relayTransportPatchSql({expectedProsrcMd5:'a'.repeat(32),reviewedRelaySourceSha256:'b'.repeat(64)}));
 if(md5(bodyOf(normal))!=='0f11e36961a628ab665302b950d0b9aa')throw Error('RESTORE_02_REJECTED');
 const test=extractCall(reanchorOctober15Sql({currentCallDefinition:normal,expectedProsrcMd5:md5(bodyOf(normal))}));
 const retried=extractCall(operatorRetryOctober15Sql({callDefinition:test,sourceSha:REVIEWED_V9_SOURCE,actorId:'11111111-1111-4111-8111-111111111111',authId:'22222222-2222-4222-8222-222222222222'}));
 if(expectedProsrcMd5!=='3c965ba93beb63a64819ba1bce36ba8f'||match[2]!==bodyOf(retried))throw Error('RESTORE_02_REJECTED');
 const fn=normal.trim().replace(/;?$/,';');
 const jobsBefore=TEST_10_DEFINITIONS.flatMap(jobPlan),jobsAfter=NORMAL_02_DEFINITIONS.flatMap(jobPlan);
 const sourceGuards=FIXED_CONNECTIONS.map(c=>`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id=${q(c.connectionId)}::uuid AND provider=${q(c.provider)} AND external_account_id=${q(c.account)} AND shop_key=${q(c.shop)} AND currency_code=${q(c.currency)} AND time_zone='Asia/Seoul') THEN RAISE EXCEPTION 'RESTORE_02_SCOPE'; END IF;`).join('\n');
 const scheduleGuards=TEST_10_DEFINITIONS.map(c=>`IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key=${q(c.key)} AND connection_id=${q(c.connectionId)}::uuid AND provider=${q(c.provider)} AND anchor_at=${q(c.anchorAt)}::timestamptz AND cadence_days=${c.provider==='CAFE24'?1:7} AND window_minutes=${c.windowMinutes}) THEN RAISE EXCEPTION 'RESTORE_02_SCHEDULE'; END IF;`).join('\n');
 const jobGuards=jobsBefore.map(j=>`IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname=${q(j.name)} AND schedule=${q(j.cron)} AND command=${q(j.command)} AND database=current_database() AND username=current_user) THEN RAISE EXCEPTION 'RESTORE_02_JOB'; END IF;`).join('\n');
 const occurrenceGuards=TEST_10_DEFINITIONS.map(c=>`IF (SELECT count(*) FROM phase08_meta_ads.sync_runs WHERE connection_id=${q(c.connectionId)}::uuid AND trigger='SCHEDULED' AND request_key=${q('schedule:'+c.key+':'+createHash('sha256').update(c.anchorAt).digest('hex'))} AND (status IN ('SUCCEEDED','ACTION_REQUIRED','CANCELLED') OR clock_timestamp()>=${q(c.anchorAt)}::timestamptz+${c.windowMinutes}*interval '1 minute'))<>1 THEN RAISE EXCEPTION 'RESTORE_02_OCCURRENCE_ACTIVE'; END IF;`).join('\n');
 return `BEGIN;
SET LOCAL statement_timeout=30000; SET LOCAL lock_timeout=5000;
SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));
${TEST_10_DEFINITIONS.map(c=>`SELECT pg_advisory_xact_lock(hashtextextended(${q('daily-data-sync-08-'+c.key)},0));`).join('\n')}
SELECT id FROM phase08_meta_ads.source_connections ORDER BY id FOR UPDATE;
DO $guard$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 OR (SELECT count(*) FROM daily_data_sync_ops.settings)<>1 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 OR (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%')<>149
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) IS DISTINCT FROM ${q(expectedProsrcMd5)}
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp())
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.status NOT IN ('SUCCEEDED','FAILED','ACTION_REQUIRED','CANCELLED') AND NOT (${TEST_10_DEFINITIONS.map(c=>`(r.connection_id=${q(c.connectionId)}::uuid AND r.trigger='SCHEDULED' AND r.request_key=${q('schedule:'+c.key+':'+createHash('sha256').update(c.anchorAt).digest('hex'))} AND clock_timestamp()>=${q(c.anchorAt)}::timestamptz+${c.windowMinutes}*interval '1 minute')`).join(' OR ')}))
 THEN RAISE EXCEPTION 'RESTORE_02_NOT_QUIESCENT'; END IF;
 ${sourceGuards}
 ${scheduleGuards}
 ${jobGuards}
 ${occurrenceGuards}
END $guard$;
-- Retain every checkpoint ciphertext/revision/expiry exactly; TTL never extends a run deadline.
${businessSnapshot}
SELECT set_config('daily_data_sync.restore_ops_digest',(${frozenOps}),true);
${fn}
${NORMAL_02_DEFINITIONS.map(c=>`UPDATE daily_data_sync_ops.schedules SET anchor_at=${q(c.anchorAt)}::timestamptz WHERE key=${q(c.key)};`).join('\n')}
${jobsAfter.map(j=>`SELECT cron.alter_job(jobid,schedule:=${q(j.cron)}) FROM cron.job WHERE jobname=${q(j.name)};`).join('\n')}
${compareBusiness}
DO $guard$ BEGIN IF (${frozenOps}) IS DISTINCT FROM current_setting('daily_data_sync.restore_ops_digest') THEN RAISE EXCEPTION 'RESTORE_02_HISTORY_CHANGED'; END IF; END $guard$;
SELECT 'RESTORE_02_DATABASE_ONLY_VERIFIED' AS state,149 AS jobs,3 AS schedules,(SELECT count(*) FROM phase08_meta_ads.sync_unit_checkpoints) AS retained_checkpoint_count,(SELECT count(*) FROM phase08_meta_ads.sync_unit_checkpoints WHERE expires_at>clock_timestamp()) AS retained_unexpired_checkpoint_count,true AS history_preserved,false AS app_definitions_changed,false AS edge_deployed;
COMMIT;`;
}
export function restoreRelay02Bytes(index,source){
 const hash=value=>createHash('sha256').update(value).digest('hex');
 if(typeof index!=='string'||typeof source!=='string'||hash(index)!=='23e837fe985be82c70a5da0a83e3a68ceae634c6073abf0a193dbec4e2df24f7')throw Error('RESTORE_02_SOURCE_REJECTED');
 if(hash(source)==='0bdc81c5ae05c6356436a4f7688ee7576f07d455525a01dfd8a15891592e4b4c')return {index,relay:source,remoteChanges:0};
 if(hash(source)!=='408dcb0cf05d4f1b8f699a81025454d4ce7cb4a3062f47f17821d449b714cd88')throw Error('RESTORE_02_SOURCE_REJECTED');
 source=source.replace(/\r\n/g,'\n'); // Only after exact known historical byte hash; preserve deployed v3 LF bytes.
 const before='export const SCHEDULES=Object.freeze(ORIGINAL_SCHEDULES.map((row,index)=>Object.freeze({...row,anchor:`2026-10-15T01:0${index}:00.000Z` })));';
 const after='export const PREVIOUS_TEST_SCHEDULES=Object.freeze(ORIGINAL_SCHEDULES.map((row,index)=>Object.freeze({...row,anchor:`2026-10-15T01:0${index}:00.000Z` })));\nexport const SCHEDULES=ORIGINAL_SCHEDULES;';
 if(source.split(before).length!==2)throw Error('RESTORE_02_SOURCE_REJECTED');let restored=source.replace(before,()=>after);
 const old="const candidates=readOnly?[...SCHEDULES,...ORIGINAL_SCHEDULES]:SCHEDULES;\n   const schedule=candidates.find(row=>row.key===body.scheduleKey&&(readOnly?Date.parse(body.scheduledFor)>=Date.parse(row.anchor)&&(Date.parse(body.scheduledFor)-Date.parse(row.anchor))%(row.days*86400000)===0:body.scheduledFor===row.anchor)),due=Date.parse(body.scheduledFor),time=now();";
 const next="const candidates=readOnly?[...SCHEDULES,...PREVIOUS_TEST_SCHEDULES]:SCHEDULES;\n   const schedule=candidates.find(row=>row.key===body.scheduleKey&&(PREVIOUS_TEST_SCHEDULES.includes(row)?body.scheduledFor===row.anchor:Date.parse(body.scheduledFor)>=Date.parse(row.anchor)&&(Date.parse(body.scheduledFor)-Date.parse(row.anchor))%(row.days*86400000)===0)),due=Date.parse(body.scheduledFor),time=now();";
 if(restored.split(old).length!==2)throw Error('RESTORE_02_SOURCE_REJECTED');restored=restored.replace(old,()=>next);
 if(hash(restored)!=='0bdc81c5ae05c6356436a4f7688ee7576f07d455525a01dfd8a15891592e4b4c')throw Error('RESTORE_02_SOURCE_REJECTED');
 return {index,relay:restored,remoteChanges:0};
}
export async function restoredRelay02Source(){
 return restoreRelay02Bytes(await readFile(new URL('../../../supabase/functions/phase08-scheduled-relay/index.ts',import.meta.url),'utf8'),await readFile(new URL('../../../supabase/functions/phase08-scheduled-relay/relay.mjs',import.meta.url),'utf8'));
}
