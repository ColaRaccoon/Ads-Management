// Local catalog reconstruction from the exact old operating commit. This tool
// reads a pre-existing metadata receipt; it never connects to production.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {Client}=require('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/pg');
const bin='C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin';
const key=process.argv[2];assert.match(key??'',/^20261019-[a-z0-9-]{3,40}$/);
const root=`C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-baseline-catalog-${key}`;
assert(!existsSync(root));mkdirSync(root,{recursive:true});
const data=`${root}/pg-data`,baseline=`${root}/baseline`,port=55434,db='phase10_baseline_catalog_20261019';mkdirSync(baseline);
const sourcePath='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/evidence/operating-schema.json';
const operating=JSON.parse(readFileSync(sourcePath,'utf8'));
assert.equal(operating.kind,'PHASE10_OPERATING_SCHEMA_READ_ONLY');assert.equal(operating.productionWrites,0);assert.equal(operating.productionBusinessRowsRead,0);
assert.equal(operating.identity.database,'postgres');assert.equal(operating.identity.role,'meta_ads_prod_runtime');assert.equal(operating.identity.schema,'meta_ads');
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();assert.equal(sha,'9e9a1f82bb02346575565b031a43e17e13758dc8');
const evidence={kind:'PHASE10_LOCAL_BASELINE_VS_OPERATING_CATALOG',startedAt:new Date().toISOString(),baselineCommit:sha,local:{host:'127.0.0.1',port,database:db,schema:'meta_ads'},
 sourceReceipt:sourcePath,sourceReceiptSha256:hash(readFileSync(sourcePath,'utf8')),operatingSchemaMetadataSha256:operating.schemaMetadataSha256,productionConnections:0,productionWrites:0,businessRowsRead:0,providerRequests:0,status:'RUNNING'};
let started=false,pg,stage='COPY_BASELINE';
function child(exe,args,options={}){const result=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4194304,...options});if(result.status!==0||result.error)throw Object.assign(Error('SAFE_LOCAL_CHILD_FAILURE'),{safeExit:result.status});return result;}
try{
 const schema=execFileSync('git',['show',`${sha}:apps/api/prisma/schema.prisma`],{encoding:'utf8'});writeFileSync(`${baseline}/schema.prisma`,schema,{flag:'wx'});
 const names=execFileSync('git',['ls-tree','-r','--name-only',sha,'apps/api/prisma/migrations'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(path=>path.endsWith('/migration.sql'));
 assert.equal(names.length,37);const migrationHashes=[];
 for(const path of names){const name=path.split('/').at(-2),sql=execFileSync('git',['show',`${sha}:${path}`],{encoding:'utf8'});mkdirSync(`${baseline}/migrations/${name}`,{recursive:true});writeFileSync(`${baseline}/migrations/${name}/migration.sql`,sql,{flag:'wx'});migrationHashes.push([name,hash(sql)]);}
 writeFileSync(`${baseline}/migrations/migration_lock.toml`,'provider = "postgresql"\n',{flag:'wx'});
 evidence.baselineMigrationCount=names.length;evidence.baselineMigrationFilesSha256=hash(migrationHashes);
 stage='LOCAL_CLUSTER';child(`${bin}/initdb.exe`,['-D',data,'-U','phase10_harness','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C']);
 child(`${bin}/pg_ctl.exe`,['-D',data,'-l',`${root}/postgres.log`,'-o',`-h 127.0.0.1 -p ${port}`,'-w','start'],{stdio:'ignore'});started=true;
 pg=new Client({host:'127.0.0.1',port,user:'phase10_harness',database:'postgres'});await pg.connect();await pg.query(`CREATE DATABASE ${db}`);await pg.end();
 pg=new Client({host:'127.0.0.1',port,user:'phase10_harness',database:db});await pg.connect();await pg.query('CREATE SCHEMA meta_ads;SET search_path=meta_ads,public');
 stage='BASELINE_37_DEPLOY';const url=`postgresql://phase10_harness@127.0.0.1:${port}/${db}?schema=meta_ads&connection_limit=1`;
 const deployed=child(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema',`${baseline}/schema.prisma`],{env:{...process.env,DATABASE_URL:url,SHADOW_DATABASE_URL:url.replace(db,db+'_unused_shadow')}});
 writeFileSync(`${root}/migration-deploy.txt`,deployed.stdout+'\n'+deployed.stderr,{flag:'wx'});
 stage='LOCAL_READONLY_CATALOG';await pg.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout='15000'");
 const identity=(await pg.query("SELECT current_database() AS database,current_user AS role,current_schema() AS schema,current_setting('transaction_read_only') AS readonly")).rows[0];
 assert.equal(identity.database,db);assert.equal(identity.role,'phase10_harness');assert.equal(identity.schema,'meta_ads');assert.equal(identity.readonly,'on');
 // Deliberately identical SQL, field order and ordering to operating receipt.
 const tables=(await pg.query("SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relkind='r' ORDER BY c.relname")).rows;
 const columns=(await pg.query("SELECT c.relname AS table_name,a.attname AS column_name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type,a.attnotnull AS not_null FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum")).rows;
 const indexes=(await pg.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='meta_ads' ORDER BY tablename,indexname")).rows;
 const migrations=(await pg.query('SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows[0].count;
 assert.equal(migrations,37);await pg.query('COMMIT');
 const local={identity,tables,columns,indexes};writeFileSync(`${root}/local-baseline-schema.json`,JSON.stringify({kind:'PHASE10_LOCAL_BASELINE_SCHEMA_METADATA',metadata:local,schemaMetadataSha256:hash(local)},null,2)+'\n',{flag:'wx'});
 function differences(oldRows,newRows,keyOf){const oldMap=new Map(oldRows.map(row=>[keyOf(row),row])),newMap=new Map(newRows.map(row=>[keyOf(row),row]));return{onlyOperating:[...oldMap].filter(([key])=>!newMap.has(key)).map(([,v])=>v),onlyLocal:[...newMap].filter(([key])=>!oldMap.has(key)).map(([,v])=>v),changed:[...oldMap].filter(([key,value])=>newMap.has(key)&&hash(value)!==hash(newMap.get(key))).map(([key,value])=>({key,operating:value,local:newMap.get(key)}))};}
 const structural={tables,columns,indexes},operatingStructural={tables:operating.metadata.tables,columns:operating.metadata.columns,indexes:operating.metadata.indexes};
 const drift={tables:differences(operating.metadata.tables,tables,row=>row.name),columns:differences(operating.metadata.columns,columns,row=>`${row.table_name}.${row.column_name}`),indexes:differences(operating.metadata.indexes,indexes,row=>`${row.tablename}.${row.indexname}`)};
 const driftCount=Object.values(drift).reduce((sum,set)=>sum+set.onlyOperating.length+set.onlyLocal.length+set.changed.length,0);
 evidence.localCounts={tables:tables.length,columns:columns.length,indexes:indexes.length,appliedMigrations:migrations};
 evidence.operatingCounts={tables:operating.tableCount,columns:operating.columnCount,indexes:operating.indexCount};
 evidence.identityDifferences={database:{operating:operating.identity.database,local:identity.database},role:{operating:operating.identity.role,local:identity.role},schemaEqual:operating.identity.schema===identity.schema,readOnlyEqual:operating.identity.readonly===identity.readonly};
 evidence.operatingStructuralSha256=hash(operatingStructural);evidence.localStructuralSha256=hash(structural);evidence.rawMetadataHashesExpectedToDifferBecauseIdentity=true;
 evidence.structuralOrderIdentical=hash(operatingStructural)===hash(structural);evidence.semanticDriftCount=driftCount;evidence.drift=drift;
 evidence.status=driftCount===0?'PASS_NO_CATALOG_DRIFT_BEYOND_DATABASE_ROLE_IDENTITY':'CATALOG_DRIFT_REQUIRES_REVIEW';
 evidence.scope='Tables/RLS flags, column names/order/formatted types/nullability and index definitions only; defaults, functions, triggers, grants, constraints and table row volumes are not compared.';
}catch(error){evidence.status='FAIL';evidence.failure={stage,code:/^[A-Z0-9_]{3,80}$/.test(error?.code??'')?error.code:'SAFE_LOCAL_FAILURE',childExit:error.safeExit??null,rawErrorSuppressed:true};process.exitCode=1;}
finally{await pg?.end().catch(()=>{});if(started){const stop=spawnSync(`${bin}/pg_ctl.exe`,['-D',data,'-m','fast','-w','stop'],{encoding:'utf8',windowsHide:true,timeout:30000});evidence.postgresStopExit=stop.status;if(stop.status!==0)process.exitCode=1;}
 evidence.endedAt=new Date().toISOString();writeFileSync(`${root}/result.json`,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...evidence,drift:undefined,evidence:`${root}/result.json`}));}
