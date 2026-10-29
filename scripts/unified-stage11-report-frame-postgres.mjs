// New fixed loopback PG17; no configured operational connection is ever consumed.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const runtime=resolve(process.env.LOCALAPPDATA,'UnifiedPerformanceStage02'),require=createRequire(import.meta.url);
const {Client}=require(resolve(runtime,'node_modules/pg'));
const bin=resolve(runtime,'node_modules/@embedded-postgres/windows-x64/native/bin');
const root=resolve(runtime,'stage11-frame-'+randomUUID()),data=resolve(root,'data');mkdirSync(root,{recursive:true});
const port=55464,database='unified_stage11_frame',owner='stage11_frame_owner',report='stage11_frame_report';
const url=user=>`postgresql://${user}@127.0.0.1:${port}/${database}?schema=meta_ads&connection_limit=1`;
const evidence={stage:11,kind:'SINGLE_PARAMETERIZED_REPORT_FRAME',remoteWrites:0,synthetic:true,status:'RUNNING',target:{host:'127.0.0.1',port,database},checks:[]};
const run=(file,args,options={})=>{const r=spawnSync(file,args,{windowsHide:true,encoding:'utf8',timeout:300000,maxBuffer:8388608,...options});if(r.status!==0)throw Object.assign(Error('LOCAL_CHILD_FAILED'),{detail:(r.stdout??'')+'\n'+(r.stderr??'')});return r;};
let db,started=false;
try{
 run(resolve(bin,'initdb.exe'),['-D',data,'-U',owner,'--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C']);
 run(resolve(bin,'pg_ctl.exe'),['-D',data,'-l',resolve(root,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -c log_statement=none -c log_min_error_statement=panic`,'-w','start'],{stdio:'ignore'});started=true;
 db=new Client({host:'127.0.0.1',port,user:owner,database:'postgres'});await db.connect();
 const id=(await db.query("SELECT current_database() db,current_user usr,inet_server_addr()::text host,current_setting('server_version_num') version")).rows[0];
 assert.equal(id.db,'postgres');assert.equal(id.usr,owner);assert.match(id.host,/^127\.0\.0\.1/);assert.match(id.version,/^17/);
 await db.query(`CREATE DATABASE ${database}`);await db.end();
 run(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','apps/api/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:url(owner),SHADOW_DATABASE_URL:url(owner).replace(database,database+'_unused')}});
 db=new Client({host:'127.0.0.1',port,user:owner,database});await db.connect();
 await db.query(`CREATE ROLE ${report} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; GRANT USAGE ON SCHEMA meta_ads TO ${report}`);
 for(const table of ['unified_products','unified_rules','unified_aggregation_runs','unified_source_publications','unified_daily_facts','unified_source_coverage'])
  await db.query(`GRANT SELECT ON meta_ads.${table} TO ${report};CREATE POLICY stage11_frame_read ON meta_ads.${table} FOR SELECT TO ${report} USING(true)`);
 await db.query(`GRANT SELECT(id,provider,display_name) ON meta_ads.source_connections TO ${report}`);
 const rls=(await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='meta_ads.source_connections'::regclass")).rows[0].relrowsecurity;
 if(rls)await db.query(`CREATE POLICY stage11_frame_connections ON meta_ads.source_connections FOR SELECT TO ${report} USING(true)`);
 evidence.checks.push('fresh PG17 loopback identity checked before writes; all migrations applied','actual non-owner restricted report login; source_connections only id/provider/display_name granted');
 const result=run(process.execPath,['--import','tsx','--test','scripts/unified-stage11-report-frame.test.ts'],{env:{...process.env,TSX_TSCONFIG_PATH:'apps/api/tsconfig.json',UNIFIED_STAGE11_FRAME_OWNER_URL:url(owner),UNIFIED_STAGE11_FRAME_REPORT_URL:url(report),UNIFIED_PERFORMANCE_ENABLED:'true',UNIFIED_REPORT_LEGACY_PLATFORMS:'',UNIFIED_NAVER_ALLOWED_STORE_IDS:'11111111-1111-4111-8111-111111111119'}});
 assert.match(result.stdout,/pass [1-9]/);assert.match(result.stdout,/skipped 0/);evidence.output=result.stdout;evidence.status='PASS';
}catch(error){evidence.status='FAIL';evidence.syntheticFailure=error.detail??error.message;process.exitCode=1;}
finally{if(db)await db.end().catch(()=>{});if(started){const stop=spawnSync(resolve(bin,'pg_ctl.exe'),['-D',data,'-m','fast','-w','stop'],{windowsHide:true,encoding:'utf8',timeout:30000});evidence.stopExit=stop.status;if(stop.status!==0){evidence.status='FAIL';process.exitCode=1;}}
 writeFileSync('docs/product-performance/research/11-app-report-frame-postgres.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));}
