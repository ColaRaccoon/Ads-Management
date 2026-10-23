import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { Client } = require('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/pg');
const bin='C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin';
const suffix=process.argv[2]??'v9';assert.match(suffix,/^v(?:9|10)$/);
const root=`C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-20261020-old-history-${suffix}`;
assert(!existsSync(root));mkdirSync(root,{recursive:true});const data=`${root}/pg-data`,port=55436,database='phase10_old_history_synthetic_20261020';
const url=`postgresql://phase10_harness@127.0.0.1:${port}/${database}?schema=meta_ads&connection_limit=3`;
const evidence={kind:'NARROW_OLD_LIFECYCLE_RETAINED_HISTORY_TEST',startedAt:new Date().toISOString(),host:'127.0.0.1',port,database,
 providerCalls:0,remoteWrites:0,appHttp:0,dockerCalls:0,productChanges:0,realBusinessRows:false,status:'RUNNING'};
let pg,started=false;
const sha=v=>createHash('sha256').update(v).digest('hex');
function child(cmd,args,options={}){const r=spawnSync(cmd,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8388608,...options});if(r.status!==0)throw Error('SAFE_LOCAL_CHILD_FAILURE');return r;}
try{
 child(`${bin}/initdb.exe`,['-D',data,'-U','phase10_harness','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C']);
 child(`${bin}/pg_ctl.exe`,['-D',data,'-l',`${root}/postgres.log`,'-o',`-h 127.0.0.1 -p ${port}`,'-w','start'],{stdio:'ignore'});started=true;
 pg=new Client({host:'127.0.0.1',port,user:'phase10_harness',database:'postgres'});await pg.connect();await pg.query(`CREATE DATABASE ${database}`);await pg.end();
 pg=new Client({host:'127.0.0.1',port,user:'phase10_harness',database});await pg.connect();assert.deepEqual((await pg.query('SELECT current_database() AS database,current_user AS role')).rows[0],{database,role:'phase10_harness'});
 await pg.query("CREATE SCHEMA meta_ads;SET search_path=meta_ads,public;SET lock_timeout='2s';SET statement_timeout='30s'");
 const names=readdirSync('apps/api/prisma/migrations',{withFileTypes:true}).filter(r=>r.isDirectory()).map(r=>r.name).sort();for(const name of names)await pg.query(readFileSync(`apps/api/prisma/migrations/${name}/migration.sql`,'utf8'));evidence.currentMigrations=names.length;assert.equal(names.length,51);
 const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();evidence.baselineCommit=head;assert.equal(head,'9e9a1f82bb02346575565b031a43e17e13758dc8');
 const baseline=execFileSync('git',['ls-tree','-r','--name-only',head,'apps/api/prisma/migrations'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(p=>p.endsWith('/migration.sql'));assert.equal(baseline.length,37);evidence.oldSchemaMigrations=37;
 const schema=execFileSync('git',['show',`${head}:apps/api/prisma/schema.prisma`],{encoding:'utf8'});const schemaPath=`${root}/old-schema.prisma`;
 writeFileSync(schemaPath,schema.replace('provider = "prisma-client-js"',`provider = "prisma-client-js"\n  output = "${root}/old-client"`));
 child(process.execPath,['node_modules/prisma/build/index.js','generate','--schema',schemaPath],{env:{...process.env,DATABASE_URL:url,SHADOW_DATABASE_URL:url}});
 mkdirSync(`${root}/old-source`);child('git',['archive','--format=tar',`--output=${root}/old-source.tar`,head,'apps/api/src']);child('tar',['-xf',`${root}/old-source.tar`,'-C',`${root}/old-source`]);
 symlinkSync(resolve('node_modules'),`${root}/old-source/node_modules`,'junction');
 const source='apps/api/src/uploads/upload-lifecycle.service.ts';const expected=execFileSync('git',['show',`${head}:${source}`]);
 const archived=readFileSync(`${root}/old-source/${source}`);assert.equal(archived.toString().replaceAll('\r\n','\n'),expected.toString().replaceAll('\r\n','\n'));
 // Windows git archive applies checkout line endings. Restore exact tracked
 // bytes for the invoked old service after checking semantic text equality.
 evidence.archivedCheckoutLineEndingsNormalized=!archived.equals(expected);writeFileSync(`${root}/old-source/${source}`,expected);assert.equal(sha(readFileSync(`${root}/old-source/${source}`)),sha(expected));evidence.oldLifecycleSourceSha256=sha(expected);
 evidence.productSourceHashes=Object.fromEntries(['apps/api/src/common/meta-source-read-coverage.ts','apps/api/src/metrics/dashboard-metrics.service.ts','apps/api/src/metrics/meta-adset-metric-decoration.service.ts'].map(p=>[p,sha(readFileSync(p))]));
 const r=spawnSync(process.execPath,['--require','./scripts/cloud/daily-data-sync/phase10-api-offline-test-guard.cjs','--import','tsx','--test','scripts/cloud/daily-data-sync/phase10-old-history-lifecycle-20261020.test.ts'],{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8388608,env:{...process.env,TSX_TSCONFIG_PATH:resolve('apps/api/tsconfig.json'),PHASE10_OLD_HISTORY_LOCAL_URL:url,PHASE10_OLD_HISTORY_ROOT:root}});
 writeFileSync(`${root}/tests.txt`,r.stdout+'\n'+r.stderr,{flag:'wx'});evidence.testExit=r.status;assert.equal(r.status,0);const report=JSON.parse(readFileSync(`${root}/lifecycle-result.json`,'utf8'));evidence.caseCount=report.caseCount;evidence.status='PASS_NARROW_TEST_GATE_INSUFFICIENT_FOR_LEGACY_HISTORY_IMMUTABILITY';
}catch{evidence.status='FAIL_SAFE_LOCAL_TEST';evidence.rawExceptionSuppressed=true;process.exitCode=1;}
finally{await pg?.end().catch(()=>{});if(started){const r=spawnSync(`${bin}/pg_ctl.exe`,['-D',data,'-m','fast','-w','stop'],{encoding:'utf8',windowsHide:true,timeout:30000});evidence.postgresStopExit=r.status;if(r.status!==0)process.exitCode=1;}evidence.finishedAt=new Date().toISOString();writeFileSync(`${root}/result.json`,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...evidence,evidence:`${root}/result.json`}));}
