import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { Client } = require('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/pg');
const bin='C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin';
const suffix=process.argv[2]; assert.match(suffix??'',/^v[1-9][0-9]*$/);
const root=`C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/performance-meta-sql-20261020-${suffix}`;
assert(!existsSync(root)); mkdirSync(root,{recursive:true});
const data=`${root}/pg-data`, port=55436, database='phase10_meta_sql_synthetic_20261020';
const evidence={kind:'FRESH_LOCAL_SYNTHETIC_META_SQL_ORACLE',startedAt:new Date().toISOString(),host:'127.0.0.1',port,database,
  providerCalls:0,remoteWrites:0,realBusinessRows:false,actualSlaMeasured:false,status:'RUNNING'};
let pg, started=false;
function child(command,args,options={}) {
  const r=spawnSync(command,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8388608,...options});
  if(r.status!==0)throw Object.assign(Error('SAFE_LOCAL_CHILD_FAILURE'),{childExit:r.status,stage:args[0]});return r;
}
try {
 child(`${bin}/initdb.exe`,['-D',data,'-U','phase10_harness','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C']);
 child(`${bin}/pg_ctl.exe`,['-D',data,'-l',`${root}/postgres.log`,'-o',`-h 127.0.0.1 -p ${port}`,'-w','start'],{stdio:'ignore'}); started=true;
 pg=new Client({host:'127.0.0.1',port,user:'phase10_harness',database:'postgres'});await pg.connect(); await pg.query(`CREATE DATABASE ${database}`);await pg.end();
 pg=new Client({host:'127.0.0.1',port,user:'phase10_harness',database});await pg.connect();
 assert.deepEqual((await pg.query('SELECT current_database() AS database,current_user AS role')).rows[0],{database,role:'phase10_harness'});
 await pg.query("CREATE SCHEMA meta_ads;SET search_path=meta_ads,public;SET lock_timeout='2s';SET statement_timeout='30s'");
 const names=readdirSync('apps/api/prisma/migrations',{withFileTypes:true}).filter(r=>r.isDirectory()).map(r=>r.name).sort();
 for(const name of names)await pg.query(readFileSync(`apps/api/prisma/migrations/${name}/migration.sql`,'utf8'));
 evidence.migrations=names.length;
 evidence.sourceHashes=Object.fromEntries(['apps/api/src/common/source-read-policy.ts','apps/api/src/common/meta-source-read-coverage.ts','apps/api/src/storefront/storefront-read.service.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
 const storefront=spawnSync(process.execPath,['--require','./scripts/cloud/daily-data-sync/phase10-api-offline-test-guard.cjs','--import','tsx','--test','scripts/cloud/daily-data-sync/phase10-storefront-coverage-postgres-20261020.test.ts'],{
   encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8388608,env:{...process.env,TSX_TSCONFIG_PATH:'apps/api/tsconfig.json',PHASE10_API_SYNTHETIC_TEST_URL:`postgresql://phase10_harness@127.0.0.1:${port}/${database}?schema=meta_ads&connection_limit=3`}});
 writeFileSync(`${root}/storefront-tests.txt`,storefront.stdout+'\n'+storefront.stderr,{flag:'wx'});evidence.storefrontTestExit=storefront.status;assert.equal(storefront.status,0);
 const storefrontLine=storefront.stdout.split(/\r?\n/).find(l=>l.startsWith('{"kind":"PHASE10_REAL_LOCAL_PG_STOREFRONT_COVERAGE_20261020"'));assert(storefrontLine);evidence.storefront=JSON.parse(storefrontLine);
 const r=spawnSync(process.execPath,['--require','./scripts/cloud/daily-data-sync/phase10-api-offline-test-guard.cjs','--import','tsx','--test','scripts/cloud/daily-data-sync/phase10-meta-validation-20261020.test.ts'],{
   encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8388608,env:{...process.env,TSX_TSCONFIG_PATH:'apps/api/tsconfig.json',PHASE10_META_SQL_LOCAL_URL:`postgresql://phase10_harness@127.0.0.1:${port}/${database}?schema=meta_ads&connection_limit=3`}});
 writeFileSync(`${root}/tests.txt`,r.stdout+'\n'+r.stderr,{flag:'wx'}); evidence.testExit=r.status;
 assert.equal(r.status,0); const line=r.stdout.split(/\r?\n/).find(l=>l.startsWith('{"kind":"REAL_SYNTHETIC_PG_META_SINGLE_SQL_ORACLE"'));assert(line);
 evidence.matrix=JSON.parse(line);evidence.status='PASS';
} catch(error) { evidence.status='FAIL';evidence.failure={code:'SAFE_LOCAL_FAILURE',childExit:error.childExit??null,rawSuppressed:true};process.exitCode=1; }
finally { await pg?.end().catch(()=>{}); if(started){ const r=spawnSync(`${bin}/pg_ctl.exe`,['-D',data,'-m','fast','-w','stop'],{encoding:'utf8',windowsHide:true,timeout:30000}); evidence.postgresStopExit=r.status;if(r.status!==0)process.exitCode=1; }
 evidence.finishedAt=new Date().toISOString();writeFileSync(`${root}/result.json`,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...evidence,matrix:evidence.matrix?{cases:evidence.matrix.matrixCases,allPass:evidence.matrix.allPass}:null,evidence:`${root}/result.json`})); }
