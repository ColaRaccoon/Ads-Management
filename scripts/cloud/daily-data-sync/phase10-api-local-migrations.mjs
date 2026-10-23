// Fresh, synthetic loopback PostgreSQL only. Never accepts an external URL.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const require=createRequire(import.meta.url);
const {Client}=require('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/pg');
const bin='C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin';
const runId=process.argv[2];assert.match(runId??'',/^20261019-[a-z0-9-]{3,40}$/);
const root=`C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-${runId}`;
assert(!existsSync(root),'create-new evidence and cluster required');mkdirSync(root,{recursive:true});
const data=`${root}/pg-data`,port=55434,db='phase10_api_synthetic_20261019';
const url=`postgresql://phase10_harness@127.0.0.1:${port}/${db}?schema=meta_ads&connection_limit=3`;
const oldSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const file='apps/api/prisma/schema.prisma';
const oldSchema=execFileSync('git',['show',`${oldSha}:${file}`],{encoding:'utf8'});
const schemaPath=`${root}/old-schema.prisma`;
writeFileSync(schemaPath,oldSchema.replace('provider = "prisma-client-js"',`provider = "prisma-client-js"\n  output = "${root}/old-client"`));
const evidence={kind:'PHASE10_SYNTHETIC_LOCAL_MIGRATION_COMPATIBILITY',startedAt:new Date().toISOString(),oldSha,
  target:{host:'127.0.0.1',port,database:db,schema:'meta_ads'},providerCalls:0,remoteWrites:0,
  realBusinessData:false,thresholds:{lockTimeoutMs:2000,statementTimeoutMs:30000},migrationTimings:[],checks:[],status:'RUNNING'};
const check=(name,detail={})=>evidence.checks.push({name,pass:true,...detail});
let pg,old,newer,started=false;
function child(command,args,options={}) {
  const result=spawnSync(command,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8388608,...options});
  if(result.status!==0)throw Object.assign(Error('SAFE_CHILD_FAILURE'),{safeStage:args[0],safeExit:result.status,syntheticStdout:result.stdout,syntheticStderr:result.stderr});
  return result;
}
try {
  child(`${bin}/initdb.exe`,['-D',data,'-U','phase10_harness','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C']);
  child(`${bin}/pg_ctl.exe`,['-D',data,'-l',`${root}/postgres.log`,'-o',`-h 127.0.0.1 -p ${port}`,'-w','start'],{stdio:'ignore'});started=true;
  pg=new Client({host:'127.0.0.1',port,user:'phase10_harness',database:'postgres'});await pg.connect();
  await pg.query(`CREATE DATABASE ${db}`);await pg.end();
  pg=new Client({host:'127.0.0.1',port,user:'phase10_harness',database:db});await pg.connect();
  const identity=(await pg.query('SELECT current_database() AS database,current_user AS role')).rows[0];
  assert.deepEqual(identity,{database:db,role:'phase10_harness'});
  await pg.query("CREATE SCHEMA meta_ads;SET search_path=meta_ads,public;SET lock_timeout='2s';SET statement_timeout='30s'");
  const names=readdirSync('apps/api/prisma/migrations',{withFileTypes:true}).filter(r=>r.isDirectory()).map(r=>r.name).sort();
  const tracked=execFileSync('git',['ls-tree','-r','--name-only',oldSha,'apps/api/prisma/migrations'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(p=>p.endsWith('/migration.sql'));
  const base=new Set(tracked.map(p=>p.split('/').at(-2)));
  const hashes=names.map(name=>[name,createHash('sha256').update(readFileSync(`apps/api/prisma/migrations/${name}/migration.sql`)).digest('hex')]);
  evidence.migrationFilesSha256=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  evidence.baselineMigrationCount=base.size;evidence.candidateMigrationCount=names.length;evidence.newMigrationCount=names.length-base.size;
  for(const name of names.filter(n=>base.has(n)))await pg.query(readFileSync(`apps/api/prisma/migrations/${name}/migration.sql`,'utf8'));
  child(process.execPath,['node_modules/prisma/build/index.js','generate','--schema',schemaPath],{env:{...process.env,DATABASE_URL:url,SHADOW_DATABASE_URL:url.replace(db,db+'_unused_shadow')}});
  const Old=require(`${root}/old-client`);old=new Old.PrismaClient({datasourceUrl:url});
  const product=await old.product.create({data:{code:'PHASE10-SYNTHETIC',name:'Synthetic',displayName:'Synthetic'}});
  const batch=await old.cafe24UploadBatch.create({data:{originalFilename:'synthetic.csv',fileHashSha256:'a'.repeat(64),columnSchema:[],status:'IMPORTED'}});
  const seed={uploadBatchId:batch.id,rowNumber:1,sourceRowHash:'b'.repeat(64),orderLineKey:'synthetic-1',orderNo:'synthetic-order',lineOrderNo:'synthetic-line',productNo:'1',productName:'Synthetic',optionName:'Synthetic',quantity:'1',salePriceKrw:'100',totalPaidKrw:'100',orderDate:new Date('2026-10-18Z'),productId:product.id};
  await old.cafe24OrderLine.create({data:seed});
  await pg.query(`INSERT INTO cafe24_order_lines(id,upload_batch_id,row_number,source_row_hash,order_line_key,order_no,line_order_no,product_no,product_name,option_name,quantity,sale_price_krw,total_paid_krw,order_date) SELECT gen_random_uuid(),$1::uuid,i,repeat('c',64),'synthetic-'||i,'order-'||i,'line-'||i,'1','Synthetic','Synthetic',1,100,100,'2026-10-18'::date FROM generate_series(2,20000) i`,[batch.id]);
  const baseline=(await pg.query('SELECT count(*)::int AS rows,sum(sale_price_krw*quantity)::text AS amount FROM cafe24_order_lines')).rows[0];
  assert.equal(baseline.rows,20000);check('old-client baseline write/read 20000 synthetic Cafe24 rows',baseline);
  for(const name of names.filter(n=>!base.has(n))) {
    const start=performance.now();await pg.query('BEGIN');
    try {await pg.query(readFileSync(`apps/api/prisma/migrations/${name}/migration.sql`,'utf8'));await pg.query('COMMIT');}
    catch(error){await pg.query('ROLLBACK');throw error;}
    evidence.migrationTimings.push({name,elapsedMs:Number((performance.now()-start).toFixed(3))});
  }
  assert.equal(await old.cafe24OrderLine.count({where:{isCurrent:true}}),20000);
  const oldRead=await old.cafe24OrderLine.findFirstOrThrow({where:{orderLineKey:'synthetic-1'}});assert.equal(oldRead.salePriceKrw.toString(),'100');
  await old.product.update({where:{id:product.id},data:{displayName:'User edit after migration'}});
  await old.cafe24OrderLine.create({data:{...seed,rowNumber:20001,orderLineKey:'user-csv-after-migration'}});
  check('old-client new schema reads and writes retained CSV and user product edits');
  const Current=require('@prisma/client');newer=new Current.PrismaClient({datasourceUrl:url});
  const connection=await newer.sourceConnection.create({data:{provider:'CAFE24',externalAccountId:'phase10-synthetic',shopKey:'shop1',displayName:'Synthetic',currencyCode:'KRW',timeZone:'Asia/Seoul',enabled:false,accessState:'PENDING'}});
  const run=await newer.syncRun.create({data:{connectionId:connection.id,trigger:'SCHEDULED',requestKey:randomUUID(),fromDate:new Date('2026-10-18Z'),toDate:new Date('2026-10-18Z'),status:'SUCCEEDED'}});
  await newer.cafe24OrderLine.update({where:{id:oldRead.id},data:{connectionId:connection.id}});
  const csvBefore=await newer.cafe24OrderLine.findUniqueOrThrow({where:{id:oldRead.id}});
  const api=await newer.cafe24OrderLine.create({data:{orderLineKey:'synthetic-1',orderNo:'synthetic-order',lineOrderNo:'synthetic-line',productNo:'1',productName:'Synthetic',optionName:'Synthetic',quantity:'1',salePriceKrw:'200',totalPaidKrw:'200',orderDate:new Date('2026-10-18Z'),connectionId:connection.id,syncRunId:run.id,source:'API'}});
  const policy=await newer.sourcePolicy.create({data:{connectionId:connection.id,dataKind:'CAFE24_ORDER',fromDate:new Date('2026-10-18Z'),primarySource:'API',version:1,effectiveAt:new Date(),reason:'SYNTHETIC_PHASE10'}});
  const rows=await newer.cafe24OrderLine.findMany({where:{isCurrent:true},select:{id:true,source:true}});
  assert.equal(rows.filter(r=>r.source==='CSV').length,20001);assert.equal(rows.filter(r=>r.source==='API').length,1);
  check('new-client feature-off SQL projection retains CSV without destructive data reset',{csvRows:20001,apiRowsRetained:1});
  const laterCsv=await newer.$transaction(async tx=>{
   await tx.cafe24OrderLine.update({where:{id:csvBefore.id},data:{isCurrent:false}});
   const line=await tx.cafe24OrderLine.create({data:{...seed,rowNumber:20002,connectionId:connection.id,salePriceKrw:'149',totalPaidKrw:'149',importVersion:2}});
   await tx.cafe24OrderLine.update({where:{id:csvBefore.id},data:{supersededByOrderLineId:line.id}});return line;
  });
  // Old Cafe24 business queries restrict imported CSV batches. A broad old
  // client query is unsafe while API rows with nullable CSV fields are current.
  let broadOldCode=null;try{await old.cafe24OrderLine.findUniqueOrThrow({where:{id:api.id}});}catch(error){broadOldCode=error.code??'UNKNOWN';}
  assert.equal(broadOldCode,'P2032');evidence.compatibility={oldCsvWithNewSchema:true,oldClientWhileApiCurrent:false,broadOldCode};
  check('old-client existing imported-CSV batch query works while API row remains current',{rows:(await old.cafe24OrderLine.findMany({where:{isCurrent:true,uploadBatchId:{in:[batch.id]}}})).length});
  const metaConnection=await newer.sourceConnection.create({data:{provider:'META',externalAccountId:'phase10-meta-synthetic',shopKey:'default',displayName:'Synthetic',currencyCode:'USD',timeZone:'Asia/Seoul',enabled:false,accessState:'PENDING'}});
  const metaRun=await newer.syncRun.create({data:{connectionId:metaConnection.id,trigger:'MANUAL',requestKey:randomUUID(),fromDate:new Date('2026-10-18Z'),toDate:new Date('2026-10-18Z'),status:'SUCCEEDED'}});
  const adset=await newer.metaAdset.create({data:{adsetName:'Synthetic',adsetNameKey:'synthetic',connectionId:metaConnection.id}});
  const metric=await newer.metaAdsetDailyMetric.create({data:{metaAdsetId:adset.id,metricDate:new Date('2026-10-18Z'),dateStart:new Date('2026-10-18Z'),dateEnd:new Date('2026-10-18Z'),adsetName:'Synthetic',adsetNameKey:'synthetic',connectionId:metaConnection.id,syncRunId:metaRun.id,source:'API',sourceRevision:'synthetic-v1',resultCount:null,reach:null,shopClicks:null,landingPageViews:null}});
  let oldMetricCode=null;try{await old.metaAdsetDailyMetric.findMany({where:{isCurrent:true,metricDate:{gte:new Date('2026-10-18Z'),lte:new Date('2026-10-18Z')}}});}catch(error){oldMetricCode=error.code??'UNKNOWN';}
  assert.equal(oldMetricCode,'P2032');evidence.compatibility.oldMetricsBusinessQueryWhileApiCurrent=false;evidence.compatibility.oldMetricCode=oldMetricCode;
  const beforeImage={id:api.id,isCurrent:api.isCurrent,source:api.source,connectionId:api.connectionId};
  writeFileSync(`${root}/api-pointer-manifest.json`,JSON.stringify({kind:'SYNTHETIC_POINTER_MANIFEST',beforeImage,csvBeforeImage:{id:csvBefore.id,isCurrent:csvBefore.isCurrent,importVersion:csvBefore.importVersion},metaMetricBeforeImage:{id:metric.id,isCurrent:true},policyBeforeImage:{id:policy.id,primarySource:'API',version:1},restoreIsCurrent:false},null,2)+'\n',{flag:'wx'});
  await newer.$transaction(async tx=>{
   assert.equal((await tx.sourcePolicy.updateMany({where:{id:policy.id,version:1,primarySource:'API'},data:{primarySource:'CSV',version:2,reason:'SYNTHETIC_MANIFEST_ROLLBACK'}})).count,1);
   assert.equal((await tx.cafe24OrderLine.updateMany({where:{id:api.id,source:'API',isCurrent:true,syncRunId:run.id,connectionId:connection.id},data:{isCurrent:false}})).count,1);
   assert.equal((await tx.metaAdsetDailyMetric.updateMany({where:{id:metric.id,isCurrent:true,source:'API',syncRunId:metaRun.id},data:{isCurrent:false}})).count,1);
   // The manifest's previous CSV current pointer became stale after a user
   // NEW_VERSION import. Never reactivate it over that newer current version.
   const csvCurrent=await tx.cafe24OrderLine.findFirstOrThrow({where:{connectionId:connection.id,source:'CSV',orderLineKey:csvBefore.orderLineKey,isCurrent:true}});
   assert.equal(csvCurrent.id,laterCsv.id);assert.equal(csvCurrent.importVersion,2);
  });
  assert.equal((await old.cafe24OrderLine.findMany({where:{isCurrent:true}})).length,20001);
  assert.equal((await old.product.findUniqueOrThrow({where:{id:product.id}})).displayName,'User edit after migration');
  assert.equal(await old.cafe24OrderLine.count({where:{orderLineKey:'user-csv-after-migration',isCurrent:true}}),1);
  assert.equal(await newer.cafe24OrderLine.count({where:{id:api.id,isCurrent:false}}),1);
  assert.equal((await newer.cafe24OrderLine.findUniqueOrThrow({where:{id:csvBefore.id}})).isCurrent,false);
  assert.equal((await newer.cafe24OrderLine.findUniqueOrThrow({where:{id:laterCsv.id}})).salePriceKrw.toString(),'149');
  assert.equal((await newer.cafe24OrderLine.findUniqueOrThrow({where:{id:laterCsv.id}})).isCurrent,true);
  assert.equal((await newer.sourcePolicy.updateMany({where:{id:policy.id,version:1,primarySource:'API'},data:{primarySource:'CSV',version:2}})).count,0);
  check('stale manifest CAS skips newer policy and preserves later CSV NEW_VERSION pointer',{oldCsvCurrent:false,newCsvCurrent:true,newCsvVersion:2,repeatedPolicyWrites:0});
  assert.equal((await old.metaAdsetDailyMetric.findMany({where:{isCurrent:true}})).length,0);
  assert.equal((await newer.sourcePolicy.findUniqueOrThrow({where:{id:policy.id}})).primarySource,'CSV');
  evidence.compatibility.oldReturnAfterManifestPointersAndPolicy=true;
  check('manifest-scoped API pointer demotion permits old-client return and preserves later CSV/user edits',{preservedCsvRows:20001,retainedApiRows:1,fullDatabaseRestore:false});
  const foundation=child(process.execPath,['--require','./scripts/cloud/daily-data-sync/phase10-api-offline-test-guard.cjs','--import','tsx','--test','scripts/cloud/daily-data-sync/phase10-api-foundation-postgres.test.ts','scripts/cloud/daily-data-sync/phase10-api-refresh-postgres.test.ts','scripts/cloud/daily-data-sync/phase10-api-before-image-postgres.test.ts','scripts/cloud/daily-data-sync/phase10-api-storefront-postgres.test.ts'],{
    env:{...process.env,TSX_TSCONFIG_PATH:'apps/api/tsconfig.json',PHASE10_API_SYNTHETIC_TEST_URL:url,PHASE10_API_BEFORE_IMAGE_EVIDENCE:`${root}/full-cafe-before-image-manifest.json`}});
  writeFileSync(`${root}/foundation-tests.txt`,foundation.stdout+'\n'+foundation.stderr,{flag:'wx'});
  assert.match(foundation.stdout,/PHASE10_SYNTHETIC_REAL_PG_FOUNDATION/);check('actual current foundation real PG zero publication and writer/final-fence transaction rollback',{assertedScenarios:4,providerRequests:0});
  assert.match(foundation.stdout,/PHASE10_SYNTHETIC_REAL_PG_OAUTH_VAULT/);check('actual OAuth and vault transaction synthetic token rotation on real local PG',{providerRequests:0,remoteIdentityGuard:'MOCK',backupImplementation:'MOCK',providerResponse:'SYNTHETIC'});
  assert.match(foundation.stdout,/PHASE10_REAL_PG_SYNTHETIC_CAFE_BEFORE_IMAGE/);check('real Cafe24 writer full pointer before-image scoped rollback preserves later CSV/policy/audits',{providerRequests:0,testedBusinessKeys:1,publishedVersions:3,actualImageRollback:false});
  assert.match(foundation.stdout,/PHASE10_REAL_LOCAL_PG_STOREFRONT_CONTEXT/);check('real local PG Storefront frozen-v5 output equality and request-local RepeatableRead evidence',{providerRequests:0,actualSlaValidated:false});
  const final=(await pg.query("SELECT count(*)::int AS rows,sum(sale_price_krw*quantity)::text AS amount FROM cafe24_order_lines WHERE source='CSV' AND is_current AND order_date='2026-10-18'::date")).rows[0];
  assert.equal(final.rows,20001);assert.equal(final.amount,'2000149.000000');evidence.final=final;
  const locker=new Client({host:'127.0.0.1',port,user:'phase10_harness',database:db});await locker.connect();
  try{await locker.query('BEGIN;LOCK TABLE meta_ads.cafe24_order_lines IN ACCESS SHARE MODE');await pg.query("SET lock_timeout='500ms'");const start=performance.now();let code=null;
   try{await pg.query('ALTER TABLE cafe24_order_lines ADD COLUMN phase10_lock_probe integer');}catch(error){code=error.code;}
   assert.equal(code,'55P03');const lockMs=performance.now()-start;assert(lockMs>=400&&lockMs<2500);check('exclusive schema lock contention aborts at configured timeout',{sqlState:code,elapsedMs:Number(lockMs.toFixed(3))});
  }finally{await locker.query('ROLLBACK');await locker.end();}
  evidence.status='MIGRATION_AND_SCOPED_ROLLBACK_PASS_OLD_API_CURRENT_INCOMPATIBLE';
}catch(error){evidence.status='FAIL';evidence.failure={code:/^[A-Z0-9_]{3,80}$/.test(error?.code??'')?error.code:'SAFE_LOCAL_FAILURE',stage:error.safeStage??null,childExit:error.safeExit??null,rawErrorSuppressed:true};if(typeof error.syntheticStdout==='string'){writeFileSync(`${root}/synthetic-child-failure.txt`,error.syntheticStdout+'\n'+error.syntheticStderr,{flag:'wx'});evidence.failure.syntheticOutput=`${root}/synthetic-child-failure.txt`;}process.exitCode=1;}
finally{
  await Promise.allSettled([old?.$disconnect(),newer?.$disconnect(),pg?.end()]);
  if(started){const result=spawnSync(`${bin}/pg_ctl.exe`,['-D',data,'-m','fast','-w','stop'],{encoding:'utf8',windowsHide:true,timeout:30000});evidence.postgresStopExit=result.status;if(result.status!==0)process.exitCode=1;}
  evidence.endedAt=new Date().toISOString();writeFileSync(`${root}/result.json`,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({...evidence,migrationTimings:undefined,evidence:`${root}/result.json`}));
}
