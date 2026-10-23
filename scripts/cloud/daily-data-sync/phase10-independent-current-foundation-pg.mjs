// Fresh local synthetic data only. Stop and preserve the cluster on all exits.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{Client}=require('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/pg');
const bin='C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin';
const label=process.argv[2];assert.match(label??'',/^20261020-[a-z0-9-]{3,40}$/);
const root=`C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/resume-${label}`;
assert(!existsSync(root),'create-new evidence only');mkdirSync(root,{recursive:true});
const port=55437,db='phase10_independent_20261020',data=`${root}/pg-data`,url=`postgresql://phase10_independent@127.0.0.1:${port}/${db}?schema=meta_ads&connection_limit=3`;
const out={kind:'PHASE10_INDEPENDENT_CURRENT_FOUNDATION_LOCAL_PG',at:new Date().toISOString(),status:'RUNNING',target:{host:'127.0.0.1',port,database:db,schema:'meta_ads'},providerRequests:0,remoteMutations:0,realBusinessData:false};
let started=false,pg;
const child=(cmd,args,options={})=>spawnSync(cmd,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8388608,...options});
try{
 for(const [cmd,args] of [['initdb.exe',['-D',data,'-U','phase10_independent','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C']],['pg_ctl.exe',['-D',data,'-l',`${root}/postgres.log`,'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']]]){if(cmd==='pg_ctl.exe')started=true;const r=child(`${bin}/${cmd}`,args,cmd==='pg_ctl.exe'?{stdio:'ignore'}:{});assert.equal(r.status,0,'local cluster initialization');}
 pg=new Client({host:'127.0.0.1',port,user:'phase10_independent',database:'postgres'});await pg.connect();await pg.query(`CREATE DATABASE ${db}`);await pg.end();
 pg=new Client({host:'127.0.0.1',port,user:'phase10_independent',database:db});await pg.connect();
 assert.deepEqual((await pg.query('SELECT current_database() AS db,current_user AS principal')).rows,[{db,principal:'phase10_independent'}]);
 await pg.query("CREATE SCHEMA meta_ads;SET search_path=meta_ads,public;SET lock_timeout='2s';SET statement_timeout='30s'");
 const migrations=readdirSync('apps/api/prisma/migrations',{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort();const hashes=[];
 for(const name of migrations){const bytes=readFileSync(`apps/api/prisma/migrations/${name}/migration.sql`);hashes.push([name,createHash('sha256').update(bytes).digest('hex')]);await pg.query(bytes.toString('utf8'));}
 out.migrationCount=migrations.length;out.migrationDigest=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
 await pg.end();pg=null;
 const args=['--require','./scripts/cloud/daily-data-sync/phase10-api-offline-test-guard.cjs','--import','tsx','--test','--test-reporter=spec','scripts/cloud/daily-data-sync/phase10-independent-current-foundation-postgres.test.ts'];
 const r=child(process.execPath,args,{env:{...process.env,TSX_TSCONFIG_PATH:'apps/api/tsconfig.json',PHASE10_INDEPENDENT_SYNTHETIC_URL:url}});
 writeFileSync(`${root}/foundation-tests.txt`,(r.stdout??'')+(r.stderr??''),{flag:'wx'});out.testExitCode=r.status;out.command={node:process.version,args};assert.equal(r.status,0,'current foundation independent tests');out.status='PASS';
}catch(error){out.status='FAIL';out.safeErrorType=error?.name??'Error';out.rawErrorSuppressed=true;process.exitCode=1;}
finally{if(pg)await pg.end().catch(()=>{});if(started){const r=child(`${bin}/pg_ctl.exe`,['-D',data,'-m','immediate','-w','stop']);out.postgresStopExit=r.status;if(r.status!==0){out.status='FAIL';process.exitCode=1;}}writeFileSync(`${root}/result.json`,JSON.stringify(out,null,2),{flag:'wx'});console.log(JSON.stringify(out));}
