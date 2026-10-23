import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const CORE_SECRET_NAMES = ['AUTH_SESSION_HANDLE_SECRET','AUTH_AUTHORIZATION_VERSION_SECRET','AUTH_CSRF_SECRET','INTERNAL_PROBE_TOKEN','DAILY_SYNC_MACHINE_TOKEN'];
export function parseIncidentDatabaseUrl(value) {
  const u = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hostname !== 'aws-0-ap-northeast-2.pooler.supabase.com' || u.port !== '5432' || u.pathname !== '/postgres' ||
      decodeURIComponent(u.username) !== 'phase08_runtime.ehnfrrmbkvlsbpvqcvkr' || u.searchParams.get('schema') !== 'phase08_meta_ads' || u.searchParams.get('sslmode') !== 'verify-full' ||
      u.hash || !u.password || u.searchParams.get('connection_limit') !== '3') throw Error('INCIDENT_DB_TARGET');
  return u;
}
export function prepareIncidentCore(before) {
  if (before.SUPABASE_DATABASE_PROJECT_REF !== 'ehnfrrmbkvlsbpvqcvkr' || before.SUPABASE_DATABASE_SCHEMA !== 'phase08_meta_ads' || before.SUPABASE_DATABASE_RUNTIME_USER !== 'phase08_runtime') throw Error('INCIDENT_TARGET');
  const changes = {};
  for (const name of CORE_SECRET_NAMES) changes[name] = name === 'DAILY_SYNC_MACHINE_TOKEN'
    ? randomBytes(32).toString('base64') // The existing Edge relay requires canonical 32-byte base64.
    : randomBytes(48).toString('base64url');
  if (new Set(Object.values(changes)).size !== CORE_SECRET_NAMES.length || Object.values(changes).some(value => Object.values(before).includes(value))) throw Error('INCIDENT_KEY_INDEPENDENCE');
  const u = parseIncidentDatabaseUrl(before.DATABASE_URL);
  u.password = randomBytes(48).toString('hex');
  changes.DATABASE_URL = u.href;
  return { changes, safeSummary: { changedSecretNames: [...CORE_SECRET_NAMES,'DATABASE_URL'], freshIndependent: true, permissionChanges: 0, providerChanges: 0 } };
}
export function incidentPasswordSql(value) {
  const password = decodeURIComponent(parseIncidentDatabaseUrl(value).password);
  if (!/^[a-f0-9]{96}$/.test(password)) throw Error('INCIDENT_PASSWORD_SHAPE');
  // Send PostgreSQL a SCRAM verifier rather than a plaintext password in DDL.
  // All original password bytes remain solely in the protected parent context.
  const salt=randomBytes(16),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
  const client=createHmac('sha256',salted).update('Client Key').digest();
  const stored=createHash('sha256').update(client).digest('base64');
  const server=createHmac('sha256',salted).update('Server Key').digest('base64');
  const verifier=`SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
  salted.fill(0);client.fill(0);salt.fill(0);
  return `BEGIN;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='15s';
DO $guard$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE NOT paused) OR EXISTS(SELECT 1 FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active)
OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='phase08_runtime')
OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='phase08_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole)
THEN RAISE EXCEPTION 'INCIDENT_DB_PASSWORD_GUARD';END IF;END $guard$;
ALTER ROLE phase08_runtime PASSWORD '${verifier}';COMMIT;`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>1048576)throw Error('INPUT');}
    const input=JSON.parse(text);text='';
    const out=input.action==='prepare'?prepareIncidentCore(input.before):input.action==='passwordSql'?{sql:incidentPasswordSql(input.databaseUrl)}:null;
    if(!out)throw Error('ACTION');
    process.stdout.write(JSON.stringify(out));
  } catch { process.stdout.write(JSON.stringify({state:'INCIDENT_CORE_SAFE_FAILURE'}));process.exitCode=1; }
}
