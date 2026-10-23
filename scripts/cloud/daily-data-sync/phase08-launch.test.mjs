import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { assertPhase08Identity, preparePhase08Runtime } from '../../../deploy/cloud/phase08-launch.mjs';
const ref='ehnfrrmbkvlsbpvqcvkr', origin='https://phase08-synthetic.up.railway.app';
const base=()=>({PHASE08_VERIFIED_ORIGIN:origin,APP_ALLOWED_ORIGINS:origin,AUTH_INVITE_REDIRECT_ORIGIN:origin,
  PHASE08_SOURCE_CONTENT_SHA256:'a'.repeat(64),SUPABASE_DATABASE_PROJECT_REF:ref,SUPABASE_DATABASE_SCHEMA:'phase08_meta_ads',
  SUPABASE_DATABASE_RUNTIME_USER:'phase08_runtime',SUPABASE_DATABASE_NAME:'postgres',SUPABASE_DATABASE_HOST:`db.${ref}.supabase.co`,
  SUPABASE_URL:`https://${ref}.supabase.co`,DATABASE_URL:`postgresql://phase08_runtime:synthetic@db.${ref}.supabase.co/postgres?schema=phase08_meta_ads&sslmode=verify-full`,
  DAILY_SYNC_FEATURE_ENABLED:'false',DAILY_SYNC_SCHEDULE_ENABLED:'false'});
const encoded=x=>Buffer.from(JSON.stringify(x)).toString('base64');
const compressed=x=>gzipSync(Buffer.from(JSON.stringify(x))).toString('base64');
test('first boot is inert and refuses operating aliases, roles, schema and provider activation',()=>{
  assert.equal(assertPhase08Identity(base()),origin);
  for(const patch of [{PHASE08_VERIFIED_ORIGIN:'https://grand-fascination-staging.up.railway.app'},
    {PHASE08_VERIFIED_ORIGIN:'https://patimagroup-work.com'},{SUPABASE_DATABASE_RUNTIME_USER:'postgres'},
    {SUPABASE_DATABASE_SCHEMA:'meta_ads'},{DAILY_SYNC_SCHEDULE_ENABLED:'true'},
    {PHASE08_SOURCE_CONTENT_SHA256:''},
    {DATABASE_URL:base().DATABASE_URL+'&schema=meta_ads'},
    {DATABASE_URL:base().DATABASE_URL+'&options=evil'},
    {DATABASE_URL:base().DATABASE_URL+'#fragment'}]) assert.throws(()=>assertPhase08Identity({...base(),...patch}));
  const pooler='aws-0-ap-northeast-2.pooler.supabase.com';
  assert.equal(assertPhase08Identity({...base(),SUPABASE_DATABASE_HOST:pooler,
    DATABASE_URL:`postgresql://phase08_runtime.${ref}:synthetic@${pooler}:5432/postgres?schema=phase08_meta_ads&sslmode=verify-full`}),origin);
});
test('portable synthetic inputs become private files, disappear from environment and clean up',
  { skip: process.platform !== 'win32' && (!process.env.PHASE08_TEST_IMAGE_HASH_PATH || process.getuid?.() === 0) },async()=>{
  const root=await mkdtemp(join(tmpdir(),'phase08-launch-test-'));
  let prepared;
  try {
    const hashPath=process.platform === 'win32' ? join(root,'image-hash') : process.env.PHASE08_TEST_IMAGE_HASH_PATH;
    if(process.platform === 'win32') await writeFile(hashPath,'a'.repeat(64)+'\n');
    const target='synthetic@synthetic.iam.gserviceaccount.com';
    const env={...base(),PHASE08_GOOGLE_TARGET_PRINCIPAL:target,
      PHASE08_GOOGLE_ADC_JSON_B64:encoded({type:'impersonated_service_account',source_credentials:{type:'authorized_user'},
        service_account_impersonation_url:`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${target}:generateAccessToken`}),
      PHASE08_META_REF_UUID:'11111111-1111-1111-1111-111111111111',DAILY_SYNC_META_VAULT_BACKEND:'ENCRYPTED_FILE',
      PHASE08_META_RECORD_B64:encoded({version:1,iv:'synthetic',authTag:'synthetic',ciphertext:'synthetic'}),
      PHASE08_META_CATALOG_JSON_B64:encoded({synthetic:true}),PHASE08_META_REPORT_SCHEMA_JSON_B64:encoded({synthetic:true})};
    prepared=await preparePhase08Runtime(env,process.platform === 'win32' ? root : '/dev/shm',hashPath);
    assert.equal(Object.keys(prepared.env).some(k=>k.endsWith('_B64')&&k.startsWith('PHASE08_')),false);
    assert.equal(env.PHASE08_GOOGLE_ADC_JSON_B64,undefined);
    assert.equal(JSON.parse(await readFile(prepared.env.GOOGLE_APPLICATION_CREDENTIALS,'utf8')).type,'impersonated_service_account');
    if(process.platform!=='win32') { assert.equal((await stat(prepared.directory)).mode&0o777,0o700); assert.equal((await stat(prepared.env.GOOGLE_APPLICATION_CREDENTIALS)).mode&0o777,0o600); }
    const path=prepared.directory; await prepared.cleanup(); prepared=null; await assert.rejects(stat(path));
  } finally { if(prepared) await prepared.cleanup(); await rm(root,{recursive:true,force:true}); }
});
test('image hash mismatch rejects bootstrap and clears protected input even on failure',
  {skip:process.platform !== 'win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'phase08-image-hash-test-'));
  try { const hashPath=join(root,'image-hash');await writeFile(hashPath,'b'.repeat(64)+'\n');
    const env={...base(),PHASE08_GOOGLE_ADC_JSON_B64:encoded({synthetic:true})};
    await assert.rejects(preparePhase08Runtime(env,root,hashPath));assert.equal(env.PHASE08_GOOGLE_ADC_JSON_B64,undefined);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('complete metadata gzip materializes identically and clears gzip environment inputs',
  {skip:process.platform !== 'win32' && (!process.env.PHASE08_TEST_IMAGE_HASH_PATH || process.getuid?.() === 0)},async()=>{
  const root=await mkdtemp(join(tmpdir(),'phase08-gzip-test-'));let prepared;
  try {
    const hashPath=process.platform==='win32'?join(root,'image-hash'):process.env.PHASE08_TEST_IMAGE_HASH_PATH;
    if(process.platform==='win32') await writeFile(hashPath,'a'.repeat(64)+'\n');
    const catalog={version:1,tools:Array.from({length:200},(_,i)=>({name:`tool-${i}`,metadata:'complete metadata retained'}))};
    const report={version:1,fields:['purchase_count','purchase_value']};
    const env={...base(),PHASE08_META_REF_UUID:'11111111-1111-1111-1111-111111111111',DAILY_SYNC_META_VAULT_BACKEND:'ENCRYPTED_FILE',
      PHASE08_META_RECORD_B64:encoded({version:1,iv:'synthetic',authTag:'synthetic',ciphertext:'synthetic'}),
      PHASE08_META_CATALOG_GZIP_B64:compressed(catalog),PHASE08_META_REPORT_SCHEMA_GZIP_B64:compressed(report)};
    prepared=await preparePhase08Runtime(env,process.platform==='win32'?root:'/dev/shm',hashPath);
    assert.deepEqual(JSON.parse(await readFile(prepared.env.DAILY_SYNC_META_MCP_CATALOG_PATH,'utf8')),catalog);
    assert.deepEqual(JSON.parse(await readFile(prepared.env.DAILY_SYNC_META_MCP_REPORTING_SCHEMA_PATH,'utf8')),report);
    assert.equal(env.PHASE08_META_CATALOG_GZIP_B64,undefined);
    assert.equal(Object.keys(prepared.env).some(k=>k.startsWith('PHASE08_')&&k.endsWith('_B64')),false);
    if(process.platform!=='win32') assert.equal((await stat(prepared.env.DAILY_SYNC_META_MCP_CATALOG_PATH)).mode&0o777,0o600);
  } finally {if(prepared)await prepared.cleanup();await rm(root,{recursive:true,force:true});}
});
test('metadata rejects mixed inputs, invalid gzip, noncanonical base64 and oversized decompression',
  {skip:process.platform !== 'win32' && (!process.env.PHASE08_TEST_IMAGE_HASH_PATH || process.getuid?.() === 0)},async()=>{
  const root=await mkdtemp(join(tmpdir(),'phase08-gzip-reject-test-'));
  try {
    const hashPath=process.platform==='win32'?join(root,'image-hash'):process.env.PHASE08_TEST_IMAGE_HASH_PATH;
    if(process.platform==='win32')await writeFile(hashPath,'a'.repeat(64)+'\n');
    for(const patch of [
      {PHASE08_META_CATALOG_JSON_B64:encoded({synthetic:true})},
      {PHASE08_META_CATALOG_GZIP_B64:encoded({notGzip:true})},
      {PHASE08_META_CATALOG_GZIP_B64:compressed({synthetic:true})+'\n'},
      {PHASE08_META_CATALOG_GZIP_B64:compressed({oversize:'x'.repeat(1_048_576)})},
      {PHASE08_META_CATALOG_GZIP_B64:compressed([])},
      {PHASE08_META_REPORT_SCHEMA_JSON_B64:encoded({synthetic:true})}]) {
      const env={...base(),PHASE08_META_REF_UUID:'11111111-1111-1111-1111-111111111111',DAILY_SYNC_META_VAULT_BACKEND:'ENCRYPTED_FILE',
        PHASE08_META_RECORD_B64:encoded({version:1,iv:'synthetic',authTag:'synthetic',ciphertext:'synthetic'}),
        PHASE08_META_CATALOG_GZIP_B64:compressed({synthetic:true}),PHASE08_META_REPORT_SCHEMA_GZIP_B64:compressed({synthetic:true}),...patch};
      await assert.rejects(preparePhase08Runtime(env,process.platform==='win32'?root:'/dev/shm',hashPath));
      assert.equal(env.PHASE08_META_CATALOG_GZIP_B64,undefined);assert.equal(env.PHASE08_META_REPORT_SCHEMA_GZIP_B64,undefined);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});
test('existing production Dockerfile stays periodic; phase08 variant disables periodic health calls',async()=>{
  const sql=await readFile(new URL('../../../deploy/cloud/phase08.Dockerfile',import.meta.url),'utf8');
  assert.match(sql,/HEALTHCHECK NONE/);assert.doesNotMatch(sql,/HEALTHCHECK --interval/);assert.match(sql,/USER node/);
  assert.match(await readFile(new URL('../../../deploy/Dockerfile',import.meta.url),'utf8'),/HEALTHCHECK --interval/);
});
