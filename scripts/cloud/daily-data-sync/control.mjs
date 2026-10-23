import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertTarget, PREFIX } from './core.mjs';
import {buildManagementBatch} from './management-batch.mjs';

const allowed = new Set(['install', 'configure', 'pause', 'resume', 'kill', 'enable', 'status']);
export async function control(client, mode, config) {
  if (!allowed.has(mode)) throw new Error('INVALID_MODE');
  if (['install','configure','resume','enable'].includes(mode)) {
    const batch=await buildManagementBatch(mode,config?.definitions??[],config?.deploymentEvidence);
    if(typeof client.install!=='function')throw new Error('ATOMIC_BATCH_TRANSPORT_REQUIRED');
    await client.install(batch);
    return {state:'ATOMIC_BATCH_APPLIED',mode};
  }
  if (mode === 'kill') {
    await client.$executeRawUnsafe('UPDATE daily_data_sync_ops.settings SET stopped=$1 WHERE singleton', true);
    return { state:'KILLED' };
  }
  if (mode === 'pause') {
    if (!/^[a-z][a-z0-9-]{2,47}$/.test(config?.key ?? '')) throw new Error('INVALID_KEY');
    await client.$transaction(async tx => {
      const schedules=await tx.$queryRawUnsafe('SELECT key FROM daily_data_sync_ops.schedules WHERE key=$1 FOR UPDATE',config.key);
      if (schedules.length!==1) throw new Error('UNKNOWN_SCHEDULE');
      await tx.$executeRawUnsafe('UPDATE daily_data_sync_ops.schedules SET paused=$2 WHERE key=$1',config.key,true);
      const jobs=await tx.$queryRawUnsafe('SELECT jobid FROM cron.job WHERE jobname=$1 OR jobname ~ $2',`${PREFIX}${config.key}-audit`,`^${PREFIX}${config.key}-[0-9]+$`);
      for(const job of jobs) await tx.$queryRawUnsafe('SELECT cron.alter_job($1::bigint,active:=$2::boolean)',job.jobid,false);
    });
    return { state:'PAUSED', key:config.key };
  }
  return { schedules:await client.$queryRawUnsafe('SELECT key,provider,anchor_at,cadence_days,window_minutes,paused FROM daily_data_sync_ops.schedules ORDER BY key'),
    settings:await client.$queryRawUnsafe('SELECT stopped,target_id,origin FROM daily_data_sync_ops.settings'),
    attempts:await client.$queryRawUnsafe('SELECT schedule_key,scheduled_for,attempted_at,status,http_status,safe_code,completed_units,total_units,elapsed_ms FROM daily_data_sync_ops.attempts ORDER BY id DESC LIMIT 40') };
}

async function main() {
  const [mode,configPath]=process.argv.slice(2);
  const target=assertTarget(process.env.DAILY_SYNC_08_STAGING_DATABASE_URL ?? '');
  const config=configPath?JSON.parse(await readFile(configPath,'utf8')):undefined;
  // Reuse an existing driver; never download a package or read an app .env.
  const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
  let pg;
  try { pg=process.env.DAILY_SYNC_08_PG_MODULE_PATH ? require(process.env.DAILY_SYNC_08_PG_MODULE_PATH) : require('pg'); } catch { throw new Error('PG_DRIVER_REQUIRED'); }
  const connectionString=new URL(target); connectionString.searchParams.delete('sslmode');
  const client=new pg.Client({connectionString:connectionString.toString(),ssl:{rejectUnauthorized:true},statement_timeout:120000});
  await client.connect();
  const wrapper={
    $queryRawUnsafe:async(sql,...args)=>(await client.query(sql,args)).rows,
    $executeRawUnsafe:async(sql,...args)=>(await client.query(sql,args)).rowCount,
    install:sql=>client.query(sql),
    $transaction:async cb=>{await client.query('BEGIN');try{const r=await cb(wrapper);await client.query('COMMIT');return r;}catch(e){await client.query('ROLLBACK');throw e;}}
  };
  try {
    const identity=await client.query('SELECT current_database() AS db,current_user AS role');
    if(identity.rows[0].db!=='postgres'||identity.rows[0].role!=='postgres') throw new Error('STAGING_ROLE_REJECTED');
    console.log(JSON.stringify(await control(wrapper,mode,config),(_,v)=>typeof v==='bigint'?v.toString():v));
  } finally {await client.end();}
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) main().catch(()=>{console.error('DAILY_SYNC_08_CONTROL_FAILED');process.exitCode=1;});
