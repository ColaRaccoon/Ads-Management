import {createHash} from 'node:crypto';
import {jobPlan} from './core.mjs';
import {october16Definitions} from './october16-profile.mjs';
import {FIXED_CONNECTIONS} from './deployment-evidence.mjs';
import {removeCafeFixtureCallException} from './afternoon-cafe-fixture.mjs';
import {removeMetaLinkRetryCallException} from './afternoon-meta-link-retry.mjs';
const q=v=>`'${v.replaceAll("'","''")}'`,md5=v=>createHash('md5').update(v).digest('hex');
const digest=table=>`(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) FROM ${table} t)`;
export const OCTOBER16_STATE_SQL=`BEGIN READ ONLY;SELECT ${digest('daily_data_sync_ops.settings')} AS "settingsMd5",${digest('daily_data_sync_ops.schedules')} AS "schedulesMd5",${digest('cron.job')} AS "jobsMd5";ROLLBACK;`;
function plan(phase){
 const defs=october16Definitions(phase),normal=october16Definitions('normal').flatMap(jobPlan),all=defs.flatMap(jobPlan);
 const map=new Map(all.map(j=>[j.name,{...j,active:true}]));
 for(const j of normal)if(!map.has(j.name))map.set(j.name,{...j,active:false});
 return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
const snapshot=(compare=false)=>`DO $snapshot$ DECLARE r record; value text; all_rows text:=''; BEGIN
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
 EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text),'''' ORDER BY md5(to_jsonb(t)::text)),'''')) FROM phase08_meta_ads.%I t WHERE NOT (%L = ''security_audit_events'' AND to_jsonb(t)->>''id''=current_setting(''daily_data_sync.accelerated_audit''))',r.tablename,r.tablename) INTO value;
 all_rows:=all_rows||r.tablename||':'||value||';';END LOOP;
 ${compare?"IF md5(all_rows) IS DISTINCT FROM current_setting('daily_data_sync.accelerated_business') THEN RAISE EXCEPTION 'OCTOBER16_BUSINESS_CHANGED';END IF;":"PERFORM set_config('daily_data_sync.accelerated_business',md5(all_rows),true);"}
END $snapshot$;`;
const history=`(SELECT md5(jsonb_build_object('settings',${digest('daily_data_sync_ops.settings')},'scheduleIdentity',(SELECT md5(jsonb_agg(to_jsonb(s)-'anchor_at'-'window_minutes' ORDER BY key)::text) FROM daily_data_sync_ops.schedules s),'cronIdentity',(SELECT md5(jsonb_agg(to_jsonb(j)-'schedule'-'active' ORDER BY jobid)::text) FROM cron.job j),'attempts',${digest('daily_data_sync_ops.attempts')},'vault',${digest('vault.secrets')},'policies',${digest('pg_catalog.pg_policies')},'othercron',(SELECT md5(coalesce(jsonb_agg(to_jsonb(j) ORDER BY jobid)::text,'[]')) FROM cron.job j WHERE jobname NOT LIKE 'daily-data-sync-08-%'))::text))`;
export function buildOctober16ProfileBatch({phase,currentCallDefinition,expectedCallMd5,expectedState,actorId,authId}){
 if(!['test','normal'].includes(phase)||!expectedState||Object.keys(expectedState).sort().join()!=='jobsMd5,schedulesMd5,settingsMd5'||Object.values(expectedState).some(v=>typeof v!=='string'||! /^[a-f0-9]{32}$/.test(v))||![actorId,authId].every(v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v))||typeof currentCallDefinition!=='string'||currentCallDefinition.length>30000)throw Error('OCTOBER16_BATCH_REJECTED');
 const match=currentCallDefinition.match(/^CREATE OR REPLACE FUNCTION daily_data_sync_ops\.call\(schedule_key text, inspection_only boolean(?: DEFAULT false)?\)[\s\S]*?AS (\$\$|\$function\$)([\s\S]*)\1;?\s*$/);
 if(!match||md5(match[2])!==expectedCallMd5||!currentCallDefinition.includes('WHEN query_canceled THEN')||!currentCallDefinition.includes('CURLOPT_USERPWD'))throw Error('OCTOBER16_BATCH_REJECTED');
 const old="IF (started AT TIME ZONE 'Asia/Seoul')::time >= time '04:00' OR\n       (started AT TIME ZONE 'Asia/Seoul')::time < time '02:00' THEN RETURN 'OUTSIDE_RECONCILIATION_WINDOW'; END IF;";
 const timed="timeout_ms:=least(85000,extract(epoch FROM (date_trunc('day',started AT TIME ZONE 'Asia/Seoul')+interval '4 hours'-(started AT TIME ZONE 'Asia/Seoul')))*1000-2000)::integer;";
 const exception="(s.key='phase08-meta' AND s.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'::uuid AND ((s.anchor_at=timestamptz '2026-10-15T06:00:00Z' AND s.window_minutes=35) OR (s.anchor_at=timestamptz '2026-10-15T07:00:00Z' AND s.window_minutes=90)) AND s.provider='META' AND due=s.anchor_at) OR (s.key='phase08-cafe24' AND s.connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1'::uuid AND s.anchor_at=timestamptz '2026-10-15T06:40:00Z' AND s.window_minutes=110 AND s.provider='CAFE24' AND due=s.anchor_at)";
 const extended=`IF (${exception}) THEN IF started>=due+(s.window_minutes+5)*interval '1 minute' THEN RETURN 'OUTSIDE_RECONCILIATION_WINDOW';END IF; ELSE ${old} END IF;`;
 const extendedTime=`IF (${exception}) THEN timeout_ms:=least(85000,extract(epoch FROM (due+(s.window_minutes+5)*interval '1 minute'-started))*1000-2000)::integer; ELSE ${timed} END IF;`;
 const octException="(s.key='phase08-meta' AND s.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'::uuid AND s.anchor_at=timestamptz '2026-10-16T01:20:00Z' AND s.window_minutes=90 AND s.provider='META' AND due=s.anchor_at) OR (s.key='phase08-cafe24' AND s.connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1'::uuid AND s.anchor_at=timestamptz '2026-10-16T01:15:00Z' AND s.window_minutes=110 AND s.provider='CAFE24' AND due=s.anchor_at)";
 const octExtended=extended.replace(exception,()=>octException),octTime=extendedTime.replace(exception,()=>octException);
 let fn=currentCallDefinition.trim().replace(/;?$/,';');
 if(phase==='normal'&&expectedCallMd5!=='05b1727f6a87277934521115edca5e4f')throw Error('OCTOBER16_BATCH_REJECTED');
 if(phase==='test'&&expectedCallMd5!=='045fe672fe54192342df81d1c280eff4')throw Error('OCTOBER16_BATCH_REJECTED');
 let transformMd5=expectedCallMd5;
 if(transformMd5==='045fe672fe54192342df81d1c280eff4'){
  fn=removeMetaLinkRetryCallException(fn);
  transformMd5=md5(fn.match(/AS (\$\$|\$function\$)([\s\S]*)\1;?\s*$/)[2]);
  if(transformMd5!=='fd90904cdf9cf3f6ef962ab8c2cbfc3f')throw Error('OCTOBER16_BATCH_REJECTED');
 }
 if(transformMd5==='fd90904cdf9cf3f6ef962ab8c2cbfc3f'){
  fn=removeCafeFixtureCallException(fn);
  transformMd5=md5(fn.match(/AS (\$\$|\$function\$)([\s\S]*)\1;?\s*$/)[2]);
  if(transformMd5!=='03d7cf6f24da00e3c577b28cd979b951')throw Error('OCTOBER16_BATCH_REJECTED');
 }
 if(phase==='test'){
  if(transformMd5==='03d7cf6f24da00e3c577b28cd979b951') {if(fn.split(extended).length!==2||fn.split(extendedTime).length!==2)throw Error('OCTOBER16_BATCH_REJECTED');fn=fn.replace(extended,()=>old).replace(extendedTime,()=>timed);transformMd5=md5(fn.match(/AS (\$\$|\$function\$)([\s\S]*)\1;?\s*$/)[2]);}
  if(transformMd5!=='0f11e36961a628ab665302b950d0b9aa'||fn.split(old).length!==2||fn.split(timed).length!==2)throw Error('OCTOBER16_BATCH_REJECTED');
  fn=fn.replace(old,()=>octExtended).replace(timed,()=>octTime);
 }else {if(fn.split(octExtended).length!==2||fn.split(octTime).length!==2)throw Error('OCTOBER16_BATCH_REJECTED');fn=fn.replace(octExtended,()=>old).replace(octTime,()=>timed);}

 const resultCallMd5=md5(fn.match(/AS (\$\$|\$function\$)([\s\S]*)\1;?\s*$/)[2]);
 if(phase==='normal'&&resultCallMd5!=='0f11e36961a628ab665302b950d0b9aa')throw Error('OCTOBER16_BATCH_REJECTED');
 const previous=phase==='test'?'previous':'test',before=october16Definitions(previous),after=october16Definitions(phase),beforeJobs=plan(previous),afterJobs=plan(phase);
 const deadline=phase==='test'?'2026-10-16T01:13:00Z':'2026-10-16T14:50:00Z',earliest=phase==='test'?'2026-10-16T00:00:00Z':'2026-10-16T01:20:00Z';
 const guards=before.map(r=>`IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key=${q(r.key)} AND connection_id=${q(r.connectionId)}::uuid AND provider=${q(r.provider)} AND anchor_at=${q(r.anchorAt)}::timestamptz AND window_minutes=${r.windowMinutes} AND cadence_days=${r.provider==='CAFE24'?1:7} AND NOT paused) THEN RAISE EXCEPTION 'OCTOBER16_SCHEDULE';END IF;`).join('\n')+beforeJobs.map(j=>`IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname=${q(j.name)} AND schedule=${q(j.cron)} AND command=${q(j.command)} AND active=${j.active} AND database=current_database() AND username=current_user) THEN RAISE EXCEPTION 'OCTOBER16_JOB';END IF;`).join('\n');
 const sourceGuards=FIXED_CONNECTIONS.map(c=>`IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id=${q(c.connectionId)}::uuid AND provider=${q(c.provider)} AND external_account_id=${q(c.account)} AND shop_key=${q(c.shop)} AND currency_code=${q(c.currency)} AND time_zone='Asia/Seoul' AND enabled AND access_state='READY') THEN RAISE EXCEPTION 'OCTOBER16_SOURCE';END IF;`).join('\n');
 const currentOccurrenceGuard=october16Definitions('test').filter(c=>c.provider!=='GOOGLE').map(c=>`IF EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs WHERE connection_id=${q(c.connectionId)}::uuid AND request_key=${q('schedule:'+c.key+':'+createHash('sha256').update(c.anchorAt).digest('hex'))} AND status NOT IN('SUCCEEDED','CANCELLED') AND clock_timestamp()<${q(c.anchorAt)}::timestamptz+${c.windowMinutes}*interval '1 minute') THEN RAISE EXCEPTION 'OCTOBER16_RUNNING';END IF;`).join('\n');
 const sql=`BEGIN ISOLATION LEVEL REPEATABLE READ;SET LOCAL statement_timeout=15000;SET LOCAL lock_timeout=5000;
 SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));
 ${after.map(r=>`SELECT pg_advisory_xact_lock(hashtextextended(${q('daily-data-sync-08-'+r.key)},0));`).join('\n')}
 SELECT id FROM phase08_meta_ads.source_connections ORDER BY id FOR UPDATE;
 DO $guard$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL OR coalesce(current_setting('cron.timezone',true),'') NOT IN('UTC','GMT')
 OR clock_timestamp()<${q(earliest)}::timestamptz OR clock_timestamp()>=${q(deadline)}::timestamptz
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 OR ${digest('daily_data_sync_ops.settings')} IS DISTINCT FROM ${q(expectedState.settingsMd5)} OR ${digest('daily_data_sync_ops.schedules')} IS DISTINCT FROM ${q(expectedState.schedulesMd5)} OR ${digest('cron.job')} IS DISTINCT FROM ${q(expectedState.jobsMd5)}
 OR (SELECT count(*) FROM daily_data_sync_ops.settings)<>1 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 OR (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%')<>149
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) IS DISTINCT FROM ${q(expectedCallMd5)}
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3 OR (SELECT count(*) FROM phase08_meta_ads.source_connections WHERE enabled AND access_state='READY')<>3
 OR (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM daily_data_sync_ops.attempts a WHERE id<=152) IS DISTINCT FROM 'c044e6c4249188e410d31aacf57422dc'
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp())
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.app_users a JOIN auth.users u ON u.id=a.auth_user_id WHERE a.id=${q(actorId)}::uuid AND a.auth_user_id=${q(authId)}::uuid AND a.role='SUPER_ADMIN' AND a.is_active AND a.invite_status='ACTIVE' AND a.email=u.email AND u.email_confirmed_at IS NOT NULL)
 THEN RAISE EXCEPTION 'OCTOBER16_GUARD';END IF;${guards}${sourceGuards}
 IF EXISTS(SELECT 1 FROM phase08_meta_ads.security_audit_events WHERE action='SYNC_SCHEDULE_EXPLICIT_TEST_PROFILE' AND target_id=${q('october16:'+phase)}) THEN RAISE EXCEPTION 'OCTOBER16_ALREADY_APPLIED';END IF;
 ${currentOccurrenceGuard}
 END $guard$;
 SELECT set_config('daily_data_sync.accelerated_audit',gen_random_uuid()::text,true);
 ${snapshot()}
 SELECT set_config('daily_data_sync.accelerated_history',${history},true);
 ${fn}
 ${after.map(r=>`UPDATE daily_data_sync_ops.schedules SET anchor_at=${q(r.anchorAt)}::timestamptz,window_minutes=${r.windowMinutes} WHERE key=${q(r.key)};`).join('\n')}
 ${afterJobs.map(j=>`SELECT cron.alter_job(jobid,schedule:=${q(j.cron)},active:=${j.active}) FROM cron.job WHERE jobname=${q(j.name)};`).join('\n')}
 INSERT INTO phase08_meta_ads.security_audit_events(id,actor_user_id,actor_type,action,target_type,target_id,result,after_json) VALUES(current_setting('daily_data_sync.accelerated_audit')::uuid,${q(actorId)}::uuid,'USER','SYNC_SCHEDULE_EXPLICIT_TEST_PROFILE','SYNC_SCHEDULE',${q('october16:'+phase)},'SUCCESS',jsonb_build_object('phase',${q(phase)},'priorHistoryInherited',false));
 ${snapshot(true)}
 DO $guard$ BEGIN IF clock_timestamp()>=${q(deadline)}::timestamptz OR ${history} IS DISTINCT FROM current_setting('daily_data_sync.accelerated_history')
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) IS DISTINCT FROM ${q(resultCallMd5)}
 OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active)<>${149}
 THEN RAISE EXCEPTION 'OCTOBER16_HISTORY_CHANGED';END IF;
 ${afterJobs.map(j=>`IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname=${q(j.name)} AND schedule=${q(j.cron)} AND command=${q(j.command)} AND active=${j.active}) THEN RAISE EXCEPTION 'OCTOBER16_JOB_POST';END IF;`).join('\n')}
 END $guard$;
 SELECT 'OCTOBER16_PROFILE_APPLIED' AS state,149 AS total_jobs,${149} AS active_jobs,${q(resultCallMd5)} AS call_md5,true AS history_preserved;COMMIT;`;
 return {state:'OCTOBER16_PROFILE_SQL_PREPARED',sql,resultCallMd5,totalJobs:149,activeJobs:149,appSchedules:after.map(({key,connectionId,anchorAt,windowMinutes})=>({key,connectionId,anchorAt,windowMinutes}))};
}
