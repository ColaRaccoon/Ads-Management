import {readFile} from 'node:fs/promises';
import {assertSchedule,jobPlan,occurrence,PREFIX} from './core.mjs';
import {assertReviewedDeployment,FIXED_CONNECTIONS,ISOLATED_IDENTITY} from './deployment-evidence.mjs';
const MUTABLE=new Set(['install','configure','resume','enable']);
const MODES=new Set([...MUTABLE,'kill','pause','status']);
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const expectedFields=['key','connectionId','provider','timeZone','anchorAt','windowMinutes','targetId'];
export function effectiveScheduleRange(row,now) {
  const slot=occurrence(row,now);
  let due=slot?Date.parse(slot.scheduledFor):Date.parse(row.anchorAt);
  if(slot && now>=Date.parse(slot.deadlineAt))due+=(row.provider==='CAFE24'?1:7)*86400000;
  const last=new Date(due+9*3600000-86400000).toISOString().slice(0,10);
  return {fromDate:new Date(Date.parse(last)-(row.provider==='CAFE24'?0:6)*86400000).toISOString().slice(0,10),toDate:last};
}
export function validateIsolatedSchedules(definitions,payload) {
  if(!Array.isArray(definitions) || definitions.length!==3)throw new Error('THREE_ISOLATED_SCHEDULES_REQUIRED');
  const checked=definitions.map(config=>{
    if(!config || Object.keys(config).some(key=>!expectedFields.includes(key)) || config.targetId!==ISOLATED_IDENTITY.targetId)throw new Error('ISOLATED_SCHEDULE_REJECTED');
    const row=assertSchedule(config),expected=FIXED_CONNECTIONS.find(item=>item.provider===row.provider);
    if(!expected || row.connectionId!==expected.connectionId)throw new Error('ISOLATED_SCHEDULE_REJECTED');
    const {fromDate:first}=effectiveScheduleRange(row,Date.parse(payload.observedAt));
    const policies=payload.connections.find(item=>item.connectionId===row.connectionId)?.policyFromDates;
    if(!policies || Object.values(policies).some(day=>day>first))throw new Error('ANCHOR_BEFORE_POLICY');
    return row;
  });
  if(new Set(checked.map(row=>row.provider)).size!==3 || new Set(checked.map(row=>row.key)).size!==3)throw new Error('DUPLICATE_ISOLATED_SCHEDULE');
  const app=checked.map(({key,connectionId,anchorAt,windowMinutes})=>({key,connectionId,anchorAt,windowMinutes})).sort((a,b)=>a.key.localeCompare(b.key));
  const actual=payload.appSchedules.map(row=>{if(!row || Object.keys(row).length!==4 || !['key','connectionId','anchorAt','windowMinutes'].every(key=>Object.hasOwn(row,key)))throw new Error('APP_SCHEDULE_MISMATCH');return{key:row.key,connectionId:row.connectionId,anchorAt:row.anchorAt,windowMinutes:row.windowMinutes};}).sort((a,b)=>a.key.localeCompare(b.key));
  if(JSON.stringify(app)!==JSON.stringify(actual))throw new Error('APP_SCHEDULE_MISMATCH');
  return checked;
}
const dbGuard=`DO $phase08$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
 OR (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads')<>68
 OR (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3
 OR (SELECT count(*) FROM phase08_meta_ads.source_connections WHERE enabled AND access_state='READY' AND time_zone='Asia/Seoul' AND (
 (id='0c35defe-45fc-4a54-bc79-704df7bca5b1'::uuid AND provider='CAFE24' AND external_account_id='didadi0729' AND shop_key='shop1' AND currency_code='KRW') OR
 (id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900'::uuid AND provider='GOOGLE' AND external_account_id='1391592099' AND shop_key='default' AND currency_code='KRW') OR
 (id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'::uuid AND provider='META' AND external_account_id='2138525300002203' AND shop_key='default' AND currency_code='USD')))<>3
 OR coalesce(current_setting('cron.timezone',true),'') NOT IN ('UTC','GMT') THEN RAISE EXCEPTION 'PHASE08_BATCH_IDENTITY_REJECTED'; END IF;
END $phase08$;`;
function liveScheduleGuards(definitions) {
  const sql=["SELECT id FROM phase08_meta_ads.source_connections WHERE id IN ('0c35defe-45fc-4a54-bc79-704df7bca5b1'::uuid,'b9ebee4b-5d4e-4eae-92b9-9facfbf3c900'::uuid,'1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'::uuid) ORDER BY id FOR SHARE;",dbGuard];
  for(const row of definitions) {
    const kinds=row.provider==='CAFE24'?['CAFE24_ORDER']:row.provider==='GOOGLE'?['GOOGLE_CAMPAIGN']:['META_AD','META_ADSET'];
    sql.push(`DO $phase08$ DECLARE instant timestamptz:=clock_timestamp(); due timestamptz:=${quote(row.anchorAt)}::timestamptz; first_day date; last_day date; BEGIN
      IF instant>=due THEN due:=due+floor(extract(epoch FROM (instant-due))/(${row.cadenceDays}*86400))::bigint*${row.cadenceDays}*interval '1 day'; IF instant>=due+${row.windowMinutes}*interval '1 minute' THEN due:=due+${row.cadenceDays}*interval '1 day'; END IF; END IF;
      last_day:=(due AT TIME ZONE 'Asia/Seoul')::date-1;first_day:=last_day-${row.provider==='CAFE24'?0:6};
      IF (SELECT count(*) FROM phase08_meta_ads.source_policies p WHERE p.connection_id=${quote(row.connectionId)}::uuid AND p.data_kind IN (${kinds.map(quote).join(',')})
        AND ${row.provider==='CAFE24'?"(p.primary_source='CSV' OR (p.primary_source='API' AND p.from_date=first_day AND p.to_date=last_day+1 AND p.reason='CAFE24_SCHEDULED_API_ONLY' AND EXISTS(SELECT 1 FROM phase08_meta_ads.source_coverage c WHERE c.connection_id=p.connection_id AND c.data_kind='CAFE24_ORDER' AND c.metric_date=first_day AND c.source='API' AND c.reconciliation_status='CAFE24_API_ONLY_VERIFIED' AND c.state IN ('COMPLETE_ZERO','COMPLETE_NONZERO'))))":"p.primary_source='API'"}
        AND p.from_date<=first_day AND (p.to_date IS NULL OR p.to_date>last_day))<>${kinds.length} THEN RAISE EXCEPTION 'LIVE_SOURCE_POLICY_MISMATCH'; END IF; END $phase08$;`);
  }
  return sql;
}
function exactJobGuard(row,active) {
  const jobs=jobPlan(row);
  return `DO $phase08$ BEGIN IF (SELECT count(*) FROM cron.job WHERE jobname=${quote(`${PREFIX}${row.key}-audit`)} OR jobname ~ ${quote(`^${PREFIX}${row.key}-[0-9]+$`)})<>${jobs.length} THEN RAISE EXCEPTION 'CRON_JOB_SET_MISMATCH'; END IF;
    ${jobs.map(job=>`IF (SELECT count(*) FROM cron.job WHERE jobname=${quote(job.name)} AND schedule=${quote(job.cron)} AND command=${quote(job.command)} AND active=${active?'true':'false'} AND database=current_database() AND username=current_user)<>1 THEN RAISE EXCEPTION 'CRON_JOB_DEFINITION_MISMATCH'; END IF;`).join('\n')}
    END $phase08$;`;
}
/** Pure rendering returns a review artifact, never executes SQL or touches Vault.
 * Call buildManagementBatch for every real mutable operation. */
export function renderManagementBatch(mode,definitions=[],installSql='') {
  if(!MODES.has(mode))throw new Error('INVALID_MODE');
  if(['configure','resume','enable'].includes(mode)) {
    if(!Array.isArray(definitions) || definitions.length!==3)throw new Error('THREE_ISOLATED_SCHEDULES_REQUIRED');
    definitions=definitions.map(assertSchedule);
    if(new Set(definitions.map(row=>row.provider)).size!==3 || new Set(definitions.map(row=>row.key)).size!==3 || definitions.some(row=>
      row.targetId!==ISOLATED_IDENTITY.targetId || !FIXED_CONNECTIONS.some(expected=>expected.provider===row.provider && expected.connectionId===row.connectionId)))throw new Error('ISOLATED_SCHEDULE_REJECTED');
  }
  if(mode==='status')return "SELECT singleton,stopped,target_id,origin FROM daily_data_sync_ops.settings; SELECT key,connection_id,provider,anchor_at,cadence_days,window_minutes,paused FROM daily_data_sync_ops.schedules ORDER BY key; SELECT schedule_key,scheduled_for,status,http_status,safe_code,completed_units,total_units,elapsed_ms FROM daily_data_sync_ops.attempts ORDER BY id DESC LIMIT 40;";
  const stopGuard="DO $phase08$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' THEN RAISE EXCEPTION 'PHASE08_BATCH_IDENTITY_REJECTED'; END IF; END $phase08$;";
  const statements=['BEGIN;','SET LOCAL statement_timeout=120000;','SET LOCAL lock_timeout=5000;',mode==='kill'||mode==='pause'?stopGuard:dbGuard,
    "SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));"];
  if(['configure','resume','enable'].includes(mode))statements.push(...liveScheduleGuards(definitions));
  if(mode==='install')statements.push("SELECT set_config('daily_data_sync.install_ref','ehnfrrmbkvlsbpvqcvkr',true);",installSql,
    `INSERT INTO daily_data_sync_ops.settings(singleton,stopped,target_id,origin) VALUES(true,true,'phase08-full-app',${quote(ISOLATED_IDENTITY.origin)}) ON CONFLICT(singleton) DO NOTHING;`,
    `DO $phase08$ BEGIN IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin=${quote(ISOLATED_IDENTITY.origin)}) OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE NOT paused) OR EXISTS(SELECT 1 FROM cron.job WHERE jobname LIKE '${PREFIX}%' AND active) THEN RAISE EXCEPTION 'INSTALL_REQUIRES_INERT_BASELINE'; END IF; END $phase08$;`);
  else if(mode==='kill')statements.push('UPDATE daily_data_sync_ops.settings SET stopped=true WHERE singleton;');
  else if(mode==='configure') {
    statements.push(`INSERT INTO daily_data_sync_ops.settings(singleton,stopped,target_id,origin) VALUES(true,true,'phase08-full-app',${quote(ISOLATED_IDENTITY.origin)}) ON CONFLICT(singleton) DO NOTHING;`,
      `DO $phase08$ BEGIN IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin=${quote(ISOLATED_IDENTITY.origin)}) OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE NOT paused) THEN RAISE EXCEPTION 'PAUSE_BEFORE_CONFIGURE'; END IF; END $phase08$;`);
    for(const row of definitions) {
      statements.push(`DO $phase08$ BEGIN IF EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts WHERE schedule_key=${quote(row.key)}) THEN RAISE EXCEPTION 'NEW_KEY_REQUIRED_AFTER_EXECUTION'; END IF; END $phase08$;`,
        `INSERT INTO daily_data_sync_ops.schedules(key,connection_id,provider,anchor_at,cadence_days,window_minutes,paused) VALUES(${quote(row.key)},${quote(row.connectionId)}::uuid,${quote(row.provider)},${quote(row.anchorAt)}::timestamptz,${row.cadenceDays},${row.windowMinutes},true) ON CONFLICT(key) DO UPDATE SET connection_id=excluded.connection_id,provider=excluded.provider,anchor_at=excluded.anchor_at,cadence_days=excluded.cadence_days,window_minutes=excluded.window_minutes WHERE daily_data_sync_ops.schedules.paused;`,
        `DO $phase08$ DECLARE job record; BEGIN FOR job IN SELECT jobid FROM cron.job WHERE jobname=${quote(`${PREFIX}${row.key}-audit`)} OR jobname ~ ${quote(`^${PREFIX}${row.key}-[0-9]+$`)} LOOP PERFORM cron.unschedule(job.jobid); END LOOP; END $phase08$;`);
      for(const job of jobPlan(row))statements.push(`DO $phase08$ DECLARE created bigint; BEGIN created:=cron.schedule(${quote(job.name)},${quote(job.cron)},${quote(job.command)}); PERFORM cron.alter_job(created,active:=false); END $phase08$;`);
    }
  } else if(mode==='pause' || mode==='resume') {
    if(mode==='resume')for(const row of definitions)statements.push(exactJobGuard(row,false));
    for(const row of definitions)statements.push(`DO $phase08$ DECLARE job record; BEGIN IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key=${quote(row.key)}) THEN RAISE EXCEPTION 'UNKNOWN_SCHEDULE'; END IF;
      ${mode==='resume'?"IF (SELECT count(*) FROM vault.secrets WHERE name='daily_data_sync_08_machine')<>1 THEN RAISE EXCEPTION 'MACHINE_SECRET_REQUIRED'; END IF;":''}
      ${mode==='resume'?"IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app') THEN RAISE EXCEPTION 'PAUSE_BEFORE_RESUME'; END IF;":''}
      UPDATE daily_data_sync_ops.schedules SET paused=${mode==='pause'?'true':'false'} WHERE key=${quote(row.key)};
      FOR job IN SELECT jobid FROM cron.job WHERE jobname=${quote(`${PREFIX}${row.key}-audit`)} OR jobname ~ ${quote(`^${PREFIX}${row.key}-[0-9]+$`)} LOOP PERFORM cron.alter_job(job.jobid,active:=${mode==='pause'?'false':'true'}); END LOOP; END $phase08$;`);
  } else if(mode==='enable') {
    for(const row of definitions)statements.push(exactJobGuard(row,true));
    statements.push("DO $phase08$ BEGIN IF (SELECT count(*) FROM daily_data_sync_ops.schedules WHERE NOT paused)<>3 OR (SELECT count(*) FROM vault.secrets WHERE name='daily_data_sync_08_machine')<>1 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app') THEN RAISE EXCEPTION 'ACTIVATION_BASELINE_REJECTED'; END IF; END $phase08$;");
    for(const row of definitions)statements.push(`DO $phase08$ BEGIN IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key=${quote(row.key)} AND NOT paused AND connection_id=${quote(row.connectionId)}::uuid AND provider=${quote(row.provider)} AND anchor_at=${quote(row.anchorAt)}::timestamptz AND cadence_days=${row.cadenceDays} AND window_minutes=${row.windowMinutes}) THEN RAISE EXCEPTION 'ACTIVATION_SCHEDULE_MISMATCH'; END IF; END $phase08$;`);
    statements.push('UPDATE daily_data_sync_ops.settings SET stopped=false WHERE singleton;');
  }
  statements.push('COMMIT;');return statements.join('\n');
}
export async function buildManagementBatch(mode,definitions=[],envelope) {
  if(!MODES.has(mode))throw new Error('INVALID_MODE');
  if(mode==='status' || mode==='kill')return renderManagementBatch(mode);
  if(mode==='pause') {
    if(!Array.isArray(definitions) || definitions.length<1 || definitions.some(row=>!row || Object.keys(row).length!==1 || !/^[a-z][a-z0-9-]{2,47}$/.test(row.key)))throw new Error('INVALID_KEY');
    return renderManagementBatch(mode,definitions);
  }
  const payload=assertReviewedDeployment(envelope);
  if(mode==='install') {if(payload.scheduleEnabled || payload.appSchedules.length || payload.managementSchedules.length)throw new Error('INSTALL_REQUIRES_INERT_BASELINE');return renderManagementBatch(mode,[],await readFile(new URL('./install.sql',import.meta.url),'utf8'));}
  const checked=validateIsolatedSchedules(definitions,payload);
  if(mode==='configure' && payload.scheduleEnabled)throw new Error('CONFIGURE_REQUIRES_SCHEDULE_OFF');
  if(mode==='resume' || mode==='enable') {
    const expected=checked.map(({key,connectionId,provider,anchorAt,windowMinutes,cadenceDays})=>({key,connectionId,provider,anchorAt,windowMinutes,cadenceDays})).sort((a,b)=>a.key.localeCompare(b.key));
    const fields=['key','connectionId','provider','anchorAt','windowMinutes','cadenceDays'];
    const actual=payload.managementSchedules.map(row=>{if(!row || Object.keys(row).length!==fields.length || !fields.every(key=>Object.hasOwn(row,key)))throw new Error('MANAGEMENT_SCHEDULE_MISMATCH');return Object.fromEntries(fields.map(key=>[key,row[key]]));}).sort((a,b)=>a.key.localeCompare(b.key));
    if(JSON.stringify(expected)!==JSON.stringify(actual))throw new Error('MANAGEMENT_SCHEDULE_MISMATCH');
    if(!payload.scheduleEnabled)throw new Error('APP_SCHEDULE_NOT_ENABLED');
  }
  return renderManagementBatch(mode,checked);
}
