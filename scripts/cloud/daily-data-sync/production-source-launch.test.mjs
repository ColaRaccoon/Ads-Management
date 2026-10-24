import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, access } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { prepareProductionSources } from '../../../deploy/cloud/production-source-launch.mjs';
const identity = { SUPABASE_DATABASE_PROJECT_REF: 'iygjmosbelbosfxidqxv', SUPABASE_DATABASE_SCHEMA: 'meta_ads',
  RAILWAY_PROJECT_ID: '6fe72710-1fc8-445a-a77f-da2da8fee200', RAILWAY_ENVIRONMENT_ID: '01ab3d5a-1036-45b0-aa9c-47179339c9be',
  RAILWAY_SERVICE_ID: 'b0835b08-7799-4c1c-8bcd-90746b9d4248' };
const principal = 'daily-data-automation-ads-read@meta-ads-daily-automation.iam.gserviceaccount.com';
const adc = { type: 'impersonated_service_account', source_credentials: { type: 'authorized_user', client_id: 'SYNTHETIC_CLIENT',
  client_secret: 'SYNTHETIC_SECRET', refresh_token: 'SYNTHETIC_REFRESH' },
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${principal}:generateAccessToken` };
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64');
const gzip = value => gzipSync(Buffer.from(JSON.stringify(value))).toString('base64');
test('production source files have private modes, exact principal, no payload inheritance and bounded cleanup', async () => {
  const source = { ...identity, DAILY_SYNC_GOOGLE_ADC_JSON_B64: b64(adc), DAILY_SYNC_META_RECORD_B64: b64({ version: 1, iv: 'SYNTHETIC', authTag: 'SYNTHETIC', ciphertext: 'SYNTHETIC' }),
    DAILY_SYNC_META_TRANSPORT: 'MCP', DAILY_SYNC_META_CREDENTIAL_REF: 'vault://meta/ab8c009e-082c-4b46-9adf-e026b839a394',
    DAILY_SYNC_META_VAULT_BACKEND: 'ENCRYPTED_FILE', DAILY_SYNC_META_CATALOG_GZIP_B64: gzip({ synthetic: 'catalog' }),
    DAILY_SYNC_META_REPORT_SCHEMA_GZIP_B64: gzip({ synthetic: 'schema' }) };
  const result = await prepareProductionSources(source);
  try {
    assert.deepEqual(JSON.parse(await readFile(result.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')), adc);
    assert.equal(JSON.parse(await readFile(result.env.DAILY_SYNC_META_MCP_CATALOG_PATH, 'utf8')).synthetic, 'catalog');
    for (const key of ['DAILY_SYNC_GOOGLE_ADC_JSON_B64', 'DAILY_SYNC_META_RECORD_B64', 'DAILY_SYNC_META_CATALOG_GZIP_B64', 'DAILY_SYNC_META_REPORT_SCHEMA_GZIP_B64']) {
      assert.equal(source[key], undefined); assert.equal(result.env[key], undefined);
    }
    if (process.platform !== 'win32') {
      assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(result.env.GOOGLE_APPLICATION_CREDENTIALS)).mode & 0o777, 0o600);
    }
  } finally { await result.cleanup(); }
  await assert.rejects(access(result.directory));
});
test('wrong production target, substituted ADC principal and partial Meta bundle fail without leaking payload', async () => {
  for (const patch of [{ SUPABASE_DATABASE_PROJECT_REF: 'ehnfrrmbkvlsbpvqcvkr' }, { RAILWAY_SERVICE_ID: 'wrong' },
    { DAILY_SYNC_GOOGLE_ADC_JSON_B64: b64({ ...adc, service_account_impersonation_url: 'https://wrong.example' }) },
    { DAILY_SYNC_META_RECORD_B64: b64({ token: 'SYNTHETIC_PRIVATE_TOKEN' }) },
    { DAILY_SYNC_GOOGLE_ADC_JSON_B64: 'malformed' }]) {
    const source = { ...identity, ...patch };
    await assert.rejects(prepareProductionSources(source), error => error.message === 'PRODUCTION_SOURCE_PREPARATION_REJECTED');
    for (const key of Object.keys(source)) assert(!key.endsWith('_B64'));
  }
});

test('USER runtime accepts only v2 envelope with an explicit app-scoped person', async () => {
  const bundle = { ...identity, DAILY_SYNC_META_TRANSPORT: 'MCP', DAILY_SYNC_META_AUTH_CLASS: 'USER', DAILY_SYNC_META_USER_ID: '123456789',
    DAILY_SYNC_META_CREDENTIAL_REF: 'vault://meta/ab8c009e-082c-4b46-9adf-e026b839a394', DAILY_SYNC_META_VAULT_BACKEND: 'ENCRYPTED_FILE',
    DAILY_SYNC_META_RECORD_B64: b64({ version: 2, iv: 'SYNTHETIC', authTag: 'SYNTHETIC', ciphertext: 'SYNTHETIC' }),
    DAILY_SYNC_META_CATALOG_GZIP_B64: gzip({ synthetic: 'catalog' }), DAILY_SYNC_META_REPORT_SCHEMA_GZIP_B64: gzip({ synthetic: 'schema' }) };
  const prepared = await prepareProductionSources({ ...bundle }); await prepared.cleanup();
  for (const patch of [{ DAILY_SYNC_META_USER_ID: '' }, { DAILY_SYNC_META_AUTH_CLASS: 'SYSTEM_USER' },
    { DAILY_SYNC_META_RECORD_B64: b64({ version: 1, iv: 'SYNTHETIC', authTag: 'SYNTHETIC', ciphertext: 'SYNTHETIC' }) }])
    await assert.rejects(prepareProductionSources({ ...bundle, ...patch }), /PRODUCTION_SOURCE_PREPARATION_REJECTED/);
});
