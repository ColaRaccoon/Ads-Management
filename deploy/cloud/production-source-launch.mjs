import { mkdtemp, chmod, writeFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { launchBundle } from '../launch-bundle.mjs';

const INPUTS = ['DAILY_SYNC_GOOGLE_ADC_JSON_B64', 'DAILY_SYNC_META_RECORD_B64',
  'DAILY_SYNC_META_CATALOG_GZIP_B64', 'DAILY_SYNC_META_REPORT_SCHEMA_GZIP_B64'];
const PRINCIPAL = 'daily-data-automation-ads-read@meta-ads-daily-automation.iam.gserviceaccount.com';
const reject = () => { throw Error('PRODUCTION_SOURCE_PREPARATION_REJECTED'); };
function decode(encoded, gzip = false) {
  if (typeof encoded !== 'string' || encoded.length > 2_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) reject();
  let bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded) { bytes.fill(0); reject(); }
  if (gzip) {
    const compressed = bytes;
    try { bytes = gunzipSync(compressed, { maxOutputLength: 1_048_576 }); }
    finally { compressed.fill(0); }
  }
  try {
    if (bytes.length > 1_048_576) reject();
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
    return { bytes, value };
  } catch { bytes.fill(0); reject(); }
}

/** Private, memory-backed files survive only this container process. No provider calls. */
export async function prepareProductionSources(source, parent = process.platform === 'win32' ? tmpdir() : '/dev/shm') {
  const env = { ...source };
  let directory;
  const cleanup = async () => {
    if (!directory) return;
    // This is the exact mkdtemp result, never a path from an environment payload.
    if (resolve(directory) !== directory || !directory.startsWith(resolve(parent) + '/production-sources-') &&
        !directory.startsWith(resolve(parent) + '\\production-sources-')) reject();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    if (env.SUPABASE_DATABASE_PROJECT_REF !== 'iygjmosbelbosfxidqxv' || env.SUPABASE_DATABASE_SCHEMA !== 'meta_ads' ||
        env.RAILWAY_PROJECT_ID !== '6fe72710-1fc8-445a-a77f-da2da8fee200' ||
        env.RAILWAY_ENVIRONMENT_ID !== '01ab3d5a-1036-45b0-aa9c-47179339c9be' ||
        env.RAILWAY_SERVICE_ID !== 'b0835b08-7799-4c1c-8bcd-90746b9d4248') reject();
    if (!INPUTS.some(key => env[key] !== undefined)) return { env, cleanup };
    if (process.platform !== 'win32' && (process.getuid?.() === 0 || resolve(parent) !== '/dev/shm' ||
        Number((await statfs(parent)).type) !== 0x01021994)) reject();
    directory = resolve(await mkdtemp(join(parent, 'production-sources-')));
    await chmod(directory, 0o700);
    async function save(name, encoded, validate, gzip = false) {
      const { bytes, value } = decode(encoded, gzip);
      try { validate(value); await writeFile(join(directory, name), bytes, { mode: 0o600, flag: 'wx' }); }
      finally { bytes.fill(0); }
      return join(directory, name);
    }
    if (env.DAILY_SYNC_GOOGLE_ADC_JSON_B64 !== undefined) {
      if (env.GOOGLE_APPLICATION_CREDENTIALS) reject();
      env.GOOGLE_APPLICATION_CREDENTIALS = await save('google-adc.json', env.DAILY_SYNC_GOOGLE_ADC_JSON_B64, value => {
        if (value.type !== 'impersonated_service_account' || value.source_credentials?.type !== 'authorized_user' ||
            !value.source_credentials.client_id || !value.source_credentials.client_secret || !value.source_credentials.refresh_token ||
            value.service_account_impersonation_url !== `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${PRINCIPAL}:generateAccessToken`) reject();
      });
    }
    const meta = INPUTS.slice(1).filter(key => env[key] !== undefined);
    if (meta.length) {
      const uuid = /^vault:\/\/meta\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(env.DAILY_SYNC_META_CREDENTIAL_REF ?? '')?.[1];
      if (meta.length !== 3 || !uuid || env.DAILY_SYNC_META_VAULT_BACKEND !== 'ENCRYPTED_FILE' ||
          env.DAILY_SYNC_META_TRANSPORT !== 'MCP' || env.DAILY_SYNC_META_VAULT_DIRECTORY ||
          env.DAILY_SYNC_META_MCP_CATALOG_PATH || env.DAILY_SYNC_META_MCP_REPORTING_SCHEMA_PATH) reject();
      await save(uuid + '.json', env.DAILY_SYNC_META_RECORD_B64, value => {
        if (value.version !== 1 || Object.keys(value).sort().join(',') !== 'authTag,ciphertext,iv,version' ||
            !value.iv || !value.authTag || !value.ciphertext) reject();
      });
      env.DAILY_SYNC_META_VAULT_DIRECTORY = directory;
      env.DAILY_SYNC_META_MCP_CATALOG_PATH = await save('catalog.json', env.DAILY_SYNC_META_CATALOG_GZIP_B64, () => {}, true);
      env.DAILY_SYNC_META_MCP_REPORTING_SCHEMA_PATH = await save('report-schema.json', env.DAILY_SYNC_META_REPORT_SCHEMA_GZIP_B64, () => {}, true);
    }
    return { env, directory, cleanup };
  } catch { await cleanup(); reject(); }
  finally { for (const key of INPUTS) { delete source[key]; delete env[key]; } }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let prepared;
  try {
    prepared = await prepareProductionSources(process.env);
    const bundle = launchBundle({ env: prepared.env, logError: () => console.error('{"event":"production-source-bundle-failed"}') });
    await bundle.completion;
  } catch { console.error('{"event":"production-source-launch-rejected"}'); process.exitCode = 1; }
  finally { if (prepared) await prepared.cleanup(); }
}
