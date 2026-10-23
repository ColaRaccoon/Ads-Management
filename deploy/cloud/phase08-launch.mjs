import { mkdtemp, chmod, writeFile, rm, statfs, readFile, lstat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { launchBundle } from '../launch-bundle.mjs';

const REF = 'ehnfrrmbkvlsbpvqcvkr';
const INPUTS = ['PHASE08_GOOGLE_ADC_JSON_B64','PHASE08_META_RECORD_B64',
  'PHASE08_META_CATALOG_JSON_B64','PHASE08_META_REPORT_SCHEMA_JSON_B64',
  'PHASE08_META_CATALOG_GZIP_B64','PHASE08_META_REPORT_SCHEMA_GZIP_B64'];
const reject = () => { throw new Error('PHASE08_PREPARATION_REJECTED'); };
function jsonBytes(value, gzip = false) {
  if (typeof value !== 'string' || value.length > 2_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) reject();
  let bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length < 1 || bytes.length > 1_048_576) { bytes.fill(0); reject(); }
  if (gzip) {
    const compressed = bytes;
    try { bytes = gunzipSync(compressed, { maxOutputLength: 1_048_576 }); }
    catch { reject(); }
    finally { compressed.fill(0); }
  }
  try { const item = JSON.parse(bytes.toString('utf8')); if (!item || typeof item !== 'object' || Array.isArray(item)) reject(); return { bytes, item }; }
  catch { bytes.fill(0); reject(); }
}
export function assertPhase08Identity(env) {
  const origin = new URL(env.PHASE08_VERIFIED_ORIGIN ?? 'invalid');
  if (origin.protocol !== 'https:' || origin.origin !== env.PHASE08_VERIFIED_ORIGIN ||
      !/^phase08-[a-z0-9-]+\.up\.railway\.app$/.test(origin.hostname) ||
      env.APP_ALLOWED_ORIGINS !== origin.origin || env.AUTH_INVITE_REDIRECT_ORIGIN !== origin.origin ||
      !/^[a-f0-9]{64}$/.test(env.PHASE08_SOURCE_CONTENT_SHA256 ?? '') ||
      env.SUPABASE_DATABASE_PROJECT_REF !== REF || env.SUPABASE_DATABASE_SCHEMA !== 'phase08_meta_ads' ||
      env.SUPABASE_DATABASE_RUNTIME_USER !== 'phase08_runtime' || env.SUPABASE_DATABASE_NAME !== 'postgres' ||
      new URL(env.SUPABASE_URL).origin !== `https://${REF}.supabase.co`) reject();
  const db = new URL(env.DATABASE_URL);
  const direct = db.hostname === `db.${REF}.supabase.co` && db.username === 'phase08_runtime';
  const pooler = db.hostname === 'aws-0-ap-northeast-2.pooler.supabase.com' && db.username === `phase08_runtime.${REF}`;
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || !(direct || pooler) || (db.port && db.port !== '5432') || db.hash ||
      db.pathname !== '/postgres' || db.searchParams.get('schema') !== 'phase08_meta_ads' ||
      db.hostname !== env.SUPABASE_DATABASE_HOST || db.searchParams.get('sslmode') !== 'verify-full') reject();
  const allowed = new Set(['schema','sslmode','connection_limit','pool_timeout','connect_timeout']);
  for (const key of db.searchParams.keys()) if (!allowed.has(key) || db.searchParams.getAll(key).length !== 1) reject();
  // First full-app boot must remain inert. Root can explicitly activate a verified
  // isolated deployment later; its normal feature and machine guards still apply.
  if (env.PHASE08_ACTIVATED !== 'true' && (env.DAILY_SYNC_FEATURE_ENABLED !== 'false' ||
      env.DAILY_SYNC_SCHEDULE_ENABLED !== 'false')) reject();
  return origin.origin;
}
export async function preparePhase08Runtime(source, parent = process.platform === 'win32' ? tmpdir() : '/dev/shm',
  imageHashPath = '/srv/app/phase08-source-content-sha256') {
  const env = { ...source };
  let directory;
  try {
    assertPhase08Identity(env);
    if (process.getuid?.() === 0) reject();
    if (process.platform !== 'win32') {
      if (resolve(parent) !== '/dev/shm' || Number((await statfs(parent)).type) !== 0x01021994) reject();
    }
    const hashInfo = await lstat(imageHashPath);
    if (!hashInfo.isFile() || hashInfo.isSymbolicLink() || hashInfo.size !== 65 ||
        (process.platform !== 'win32' && (hashInfo.uid !== 0 || (hashInfo.mode & 0o222) !== 0)) ||
        (await readFile(imageHashPath,'utf8')).trim() !== env.PHASE08_SOURCE_CONTENT_SHA256) reject();
    directory = resolve(await mkdtemp(join(parent, 'phase08-runtime-')));
    await chmod(directory, 0o700);
    const save = async (name, encoded, validate, gzip = false) => {
      const { bytes, item } = jsonBytes(encoded, gzip);
      try { validate(item); await writeFile(join(directory, name), bytes, { mode: 0o600, flag: 'wx' }); }
      finally { bytes.fill(0); }
      return join(directory, name);
    };
    if (env.PHASE08_GOOGLE_ADC_JSON_B64) env.GOOGLE_APPLICATION_CREDENTIALS = await save('google-adc.json',
      env.PHASE08_GOOGLE_ADC_JSON_B64, item => {
        if (item.type !== 'impersonated_service_account' || item.source_credentials?.type !== 'authorized_user' ||
            !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(env.PHASE08_GOOGLE_TARGET_PRINCIPAL ?? '') ||
            item.service_account_impersonation_url !== `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${env.PHASE08_GOOGLE_TARGET_PRINCIPAL}:generateAccessToken`) reject();
      });
    if (env.PHASE08_META_RECORD_B64) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(env.PHASE08_META_REF_UUID ?? '') || env.DAILY_SYNC_META_VAULT_BACKEND !== 'ENCRYPTED_FILE') reject();
      await save(`${env.PHASE08_META_REF_UUID}.json`,env.PHASE08_META_RECORD_B64,
        item => { if (item.version !== 1 || !item.iv || !item.authTag || !item.ciphertext) reject(); });
      env.DAILY_SYNC_META_VAULT_DIRECTORY = directory;
      const metadata = async (name, prefix) => {
        const json = env[`${prefix}_JSON_B64`], gzip = env[`${prefix}_GZIP_B64`];
        if ((json !== undefined ? 1 : 0) + (gzip !== undefined ? 1 : 0) !== 1) reject();
        return save(name, json ?? gzip, () => {}, gzip !== undefined);
      };
      env.DAILY_SYNC_META_MCP_CATALOG_PATH = await metadata('catalog.json','PHASE08_META_CATALOG');
      env.DAILY_SYNC_META_MCP_REPORTING_SCHEMA_PATH = await metadata('report-schema.json','PHASE08_META_REPORT_SCHEMA');
    }
    return { env, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch { if (directory) await rm(directory, { recursive: true, force: true }); reject(); }
  finally { for (const key of [...INPUTS,'PHASE08_META_REF_UUID']) { delete env[key]; delete source[key]; } }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let prepared;
  const cleanupSync = () => { if (prepared) rmSync(prepared.directory, { recursive: true, force: true }); };
  try {
    prepared = await preparePhase08Runtime(process.env);
    process.once('exit',cleanupSync);
    const bundle = launchBundle({ env: prepared.env,
      logError: () => console.error('{"event":"phase08-bundle-failed"}') });
    await bundle.completion;
  } catch { console.error('{"event":"phase08-bootstrap-rejected"}'); process.exitCode = 1; }
  finally { if (prepared) await prepared.cleanup(); }
}
