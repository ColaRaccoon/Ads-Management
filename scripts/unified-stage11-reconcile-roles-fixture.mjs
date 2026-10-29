// A new loopback PG17 only. Rehearse exact migration batch and ownership-aware roles.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
const runtime=resolve(process.env.LOCALAPPDATA,'UnifiedPerformanceStage02'),require=createRequire(import.meta.url);
const {Client}=require(resolve(runtime,'node_modules/pg'));
const bin=resolve(runtime,'node_modules/@embedded-postgres/windows-x64/native/bin');
const root=resolve(runtime,'stage11-roles-'+randomUUID()),data=resolve(root,'data');mkdirSync(root,{recursive:true});
const port=55461,database='unified_stage11_roles',owner='fixture_owner';
const url=`postgresql://${owner}@127.0.0.1:${port}/${database}?schema=meta_ads`;
const run=(file,args,options={})=>{const r=spawnSync(file,args,{windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:8388608,...options});if(r.status!==0)throw Object.assign(Error('LOCAL_CHILD_FAILED'),{code:'LOCAL_CHILD_FAILED',detail:r.stderr?.slice(0,500)});return r;};
const evidence={stage:11,kind:'FRESH_LOOPBACK_MIGRATION_ROLES_REHEARSAL',remoteWrites:0,status:'RUNNING',checks:[]};
let started=false,db;
try{
run(resolve(bin,'initdb.exe'),['-D',data,'-U',owner,'--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C']);
run(resolve(bin,'pg_ctl.exe'),['-D',data,'-l',resolve(root,'pg.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start'],{stdio:'ignore'});started=true;
db=new Client({host:'127.0.0.1',port,user:owner,database:'postgres'});await db.connect();
const id=(await db.query("SELECT current_user usr,current_database() db,inet_server_addr()::text host,current_setting('server_version_num') version")).rows[0];
assert.equal(id.usr,owner);assert.equal(id.db,'postgres');assert.match(id.host,/^127\.0\.0\.1/);assert.match(id.version,/^17/);
await db.query(`CREATE DATABASE ${database}`);await db.end();
run(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','apps/api/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:url,SHADOW_DATABASE_URL:url.replace(database,database+'_unused')}});
db=new Client({host:'127.0.0.1',port,user:owner,database});await db.connect();await db.query('SET search_path TO meta_ads,public');
const proposal=JSON.parse(readFileSync('docs/product-performance/research/11-data-source-access-proposal.json','utf8'));
const operationalMetadata=JSON.parse(readFileSync('docs/product-performance/research/11-management-metadata.json','utf8')).rows.metadata;
for(const t of proposal.naver){
 const actual=operationalMetadata.sourceTables.find(row=>row.schema==='public'&&row.name===t.table);assert(actual);assert.equal(actual.owner,'patima_app');assert.equal(actual.rls,false);assert.equal(actual.forceRls,false);
 await db.query(`CREATE TABLE public.${t.table}(id text PRIMARY KEY,payload jsonb,updated_at timestamptz);REVOKE ALL ON public.${t.table} FROM PUBLIC`);
}
evidence.publicFixtureOwnershipSource='11-management-metadata.json:17 patima_app-owned tables; RLS=false, FORCE=false';
await db.query('CREATE SCHEMA IF NOT EXISTS extensions');
await db.query('CREATE ROLE meta_ads_app NOLOGIN;CREATE ROLE patima_app NOLOGIN;CREATE ROLE postgres LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB CREATEROLE;CREATE ROLE supabase_admin NOLOGIN CREATEROLE;GRANT meta_ads_app,patima_app TO supabase_admin WITH ADMIN TRUE;SET ROLE supabase_admin;GRANT meta_ads_app,patima_app TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;RESET ROLE;GRANT pg_read_all_data TO postgres WITH ADMIN TRUE, INHERIT TRUE, SET TRUE;GRANT CREATE,USAGE ON SCHEMA meta_ads TO meta_ads_app');
// Match the operational owner, not a superuser-owned application schema.
for(const row of (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='meta_ads'")).rows)await db.query(`ALTER TABLE meta_ads.${row.tablename} OWNER TO meta_ads_app`);
await db.query('ALTER SCHEMA meta_ads OWNER TO postgres;ALTER SCHEMA extensions OWNER TO postgres;ALTER EXTENSION btree_gist SET SCHEMA extensions;GRANT SELECT ON meta_ads._prisma_migrations TO postgres');
if(process.env.UNIFIED_STAGE11_MIGRATION_SQL){
 const expected=JSON.parse(readFileSync('docs/product-performance/research/11-management-metadata.json','utf8')).rows.metadata.migrations.filter(x=>x.finished_at&&!x.rolled_back_at);
 await db.query('DROP TABLE meta_ads.unified_mapping_audits,meta_ads.unified_product_match_results,meta_ads.unified_source_coverage,meta_ads.unified_daily_facts,meta_ads.unified_source_publications,meta_ads.unified_rules,meta_ads.unified_products,meta_ads.unified_aggregation_runs CASCADE;DROP FUNCTION meta_ads.unified_check_publication(),meta_ads.unified_immutable_run(),meta_ads.unified_immutable_child()');
 await db.query("DELETE FROM meta_ads._prisma_migrations WHERE migration_name IN ('20261027071504_unified_performance_foundation','20261028080000_unified_report_publication')");
 for(const row of expected)await db.query('UPDATE meta_ads._prisma_migrations SET checksum=$1 WHERE migration_name=$2',[row.checksum,row.migration_name]);
 const reviewedBatch=readFileSync(process.env.UNIFIED_STAGE11_MIGRATION_SQL,'utf8');
 evidence.migrationSqlSha256=createHash('sha256').update(reviewedBatch).digest('hex');
 let batch=reviewedBatch.replaceAll("current_database()<>'postgres'",`current_database()<>'${database}'`);
 if(process.env.UNIFIED_STAGE11_OWNER_TRIGGER_WORKAROUND==='1'){
  batch=batch.replace('-- Additive stage06 queue and immutable source/day publications. No runtime grants.',
   'GRANT TRIGGER ON meta_ads.unified_aggregation_runs,meta_ads.unified_daily_facts,meta_ads.unified_source_coverage,meta_ads.unified_product_match_results TO meta_ads_app;\n-- Additive stage06 queue and immutable source/day publications. No runtime grants.');
  evidence.ownerTriggerWorkaround=true;
 }
 // Execute as restricted management login, with explicit SET ROLE owner in the reviewed batch.
 const mgmt=new Client({host:'127.0.0.1',port,user:'postgres',database});await mgmt.connect();
 try{await mgmt.query(batch);}finally{await mgmt.end();}
 assert.equal((await db.query("SELECT count(*)::int n FROM meta_ads._prisma_migrations WHERE finished_at IS NOT NULL")).rows[0].n,58);
 evidence.checks.push(evidence.ownerTriggerWorkaround ? 'Parent reviewed two-migration batch plus local four-table owner TRIGGER grant succeeds after local-only removal/history simulation' : 'Exact parent reviewed two-migration batch succeeds after local-only removal/history simulation; owner SET ROLE and extension schema reproduced');
}
// The operational admin is a member without automatic inheritance; public sources are owner-controlled.
await db.query(`ALTER DATABASE ${database} OWNER TO postgres;ALTER SCHEMA public OWNER TO pg_database_owner;GRANT CREATE,USAGE ON SCHEMA public TO postgres`);
for(const t of proposal.naver)await db.query(`ALTER TABLE public.${t.table} OWNER TO patima_app`);
const mgmt=new Client({host:'127.0.0.1',port,user:'postgres',database});await mgmt.connect();
try{
 const before=(await mgmt.query("SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) snapshot FROM pg_auth_members a WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('meta_ads_app','patima_app')) AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres')")).rows[0].snapshot;
 const reviewedRoles=readFileSync('scripts/unified-stage11-reconcile-roles.sql','utf8');
 evidence.roleSqlSha256=createHash('sha256').update(reviewedRoles).digest('hex');
 const roles=reviewedRoles.replace('BEGIN;','BEGIN; GRANT meta_ads_app,patima_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;').replace('COMMIT;',"RESET ROLE; REVOKE meta_ads_app,patima_app FROM postgres GRANTED BY postgres; COMMIT;");
 await mgmt.query(roles);
 // Reproduce the first proposal's schema-grant warning, then apply only the corrective SQL.
 await mgmt.query('REVOKE USAGE ON SCHEMA meta_ads FROM meta_ads_unified_report,meta_ads_unified_worker');
 await mgmt.query(readFileSync('scripts/unified-stage11-reconcile-roles-schema-fix.sql','utf8'));
 evidence.correctiveSchemaUsageFix='PASS';
 // Reproduce silent source-owner GRANT failure by removing only the new worker's column grants.
 for(const table of proposal.naver)await db.query(`REVOKE SELECT (${table.columns.map(col=>'"'+col+'"').join(',')}) ON "public"."${table.table}" FROM meta_ads_unified_worker`);
 const denied=(await mgmt.query("SELECT has_column_privilege('meta_ads_unified_worker','public.stores','payload','SELECT') allowed")).rows[0];assert.equal(denied.allowed,false);
 const publicFix=readFileSync('scripts/unified-stage11-reconcile-roles-public-fix.sql','utf8').replace('BEGIN;','BEGIN; GRANT patima_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;').replace('COMMIT;',"RESET ROLE; REVOKE patima_app FROM postgres GRANTED BY postgres; COMMIT;");
 await assert.rejects(mgmt.query(publicFix.replace('SET LOCAL ROLE patima_app;','')),error=>error.message.startsWith('STAGE11_SOURCE_SELECT_NOT_GRANTED'));
 await mgmt.query('ROLLBACK');
 evidence.wrongPublicOwnerGrantRejectedBeforeCommit=true;
 await mgmt.query(publicFix);
 evidence.correctivePublicGrantsFix='PASS';
 const after=(await mgmt.query("SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) snapshot FROM pg_auth_members a WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('meta_ads_app','patima_app')) AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres')")).rows[0].snapshot;
 assert.deepEqual(after,before);evidence.membershipRestoredExactly=true;
}finally{await mgmt.end();}
evidence.checks.push('Ownership-aware role SQL applied under non-superuser NOINHERIT management login');
for(const role of ['meta_ads_unified_report','meta_ads_unified_worker'])await db.query(`ALTER ROLE ${role} LOGIN`);
for(const role of ['meta_ads_unified_report','meta_ads_unified_worker']){
 const c=new Client({host:'127.0.0.1',port,user:role,database});await c.connect();
 try{
 const r=(await c.query("SELECT current_user role,has_column_privilege(current_user,'meta_ads.source_connections','credential_ref','SELECT') credential,has_table_privilege(current_user,'meta_ads.source_credentials','SELECT') credential_table")).rows[0];assert.equal(r.role,role);assert.equal(r.credential,false);assert.equal(r.credential_table,false);
 await assert.rejects(c.query('SELECT credential_ref FROM meta_ads.source_connections LIMIT 0'),error=>error.code==='42501');
 await assert.rejects(c.query('SELECT * FROM meta_ads.source_credentials LIMIT 0'),error=>error.code==='42501');
 if(role.endsWith('worker')){const rows=(await c.query(readFileSync('scripts/unified-stage11-reconcile-access.sql','utf8'))).rows;assert.equal(rows.length,44);evidence.accessViolations=rows.filter(x=>!x.table_exists||!x.schema_usage||x.missing_select_columns.length||x.writable_columns.length||x.can_delete_or_truncate);assert.equal(evidence.accessViolations.length,0);
  for(const table of [...proposal.metaAds,...proposal.naver])await c.query(`SELECT ${table.columns.map(col=>'"'+col+'"').join(',')} FROM "${table.schema}"."${table.table}" LIMIT 0`);
  await assert.rejects(c.query('DELETE FROM meta_ads.cafe24_order_lines WHERE false'),error=>error.code==='42501');
 }else{assert.equal((await c.query("SELECT has_table_privilege(current_user,'meta_ads.unified_product_match_results','SELECT') matches,has_table_privilege(current_user,'meta_ads.cafe24_order_lines','SELECT') raw")).rows[0].matches,false);assert.equal((await c.query("SELECT has_table_privilege(current_user,'meta_ads.cafe24_order_lines','SELECT') raw")).rows[0].raw,false);
  await assert.rejects(c.query('SELECT * FROM meta_ads.unified_product_match_results LIMIT 0'),error=>error.code==='42501');
  await assert.rejects(c.query('SELECT * FROM meta_ads.cafe24_order_lines LIMIT 0'),error=>error.code==='42501');
 }
 }finally{await c.end();}
}
evidence.checks.push('Actual two restricted login roles deny credential/reference columns, credential tables, raw report source/match access; worker exact44table SELECT and zero source DML');
const fx=run(process.execPath,['--import','tsx','--test','scripts/unified-stage11-reconcile-fx-projection.test.ts'],{env:{...process.env,TSX_TSCONFIG_PATH:'apps/api/tsconfig.json',UNIFIED_STAGE11_FK_OWNER_URL:url,
 UNIFIED_STAGE11_FK_REPORT_URL:url.replace(owner,'meta_ads_unified_report'),UNIFIED_STAGE11_FK_WORKER_URL:url.replace(owner,'meta_ads_unified_worker')}});
assert.match(fx.stdout,/pass 1/);assert.match(fx.stdout,/skipped 0/);evidence.fxImplicitIdTest='PASS';
const fxFixClient=new Client({host:'127.0.0.1',port,user:'postgres',database});await fxFixClient.connect();
try{
 const before=(await fxFixClient.query("SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) snapshot FROM pg_auth_members a WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('meta_ads_app','patima_app')) AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres')")).rows[0].snapshot;
 const fix=readFileSync('scripts/unified-stage11-reconcile-roles-fx-fix.sql','utf8').replace('BEGIN;','BEGIN; GRANT meta_ads_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;').replace('COMMIT;',"RESET ROLE; REVOKE meta_ads_app FROM postgres GRANTED BY postgres; COMMIT;");
 await fxFixClient.query(fix);
 const after=(await fxFixClient.query("SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) snapshot FROM pg_auth_members a WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('meta_ads_app','patima_app')) AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres')")).rows[0].snapshot;
 assert.deepEqual(after,before);evidence.fxCorrectiveSqlExecutedAsOwner='PASS';
}finally{await fxFixClient.end();}
const fk=run(process.execPath,['--import','tsx','--test','scripts/unified-stage11-reconcile-fk.test.ts'],{env:{...process.env,TSX_TSCONFIG_PATH:'apps/api/tsconfig.json',UNIFIED_STAGE11_FK_OWNER_URL:url,
 UNIFIED_STAGE11_FK_REPORT_URL:url.replace(owner,'meta_ads_unified_report'),UNIFIED_STAGE11_FK_WORKER_URL:url.replace(owner,'meta_ads_unified_worker')}});
assert.match(fk.stdout,/pass 1/);assert.match(fk.stdout,/skipped 0/);evidence.fkTest='PASS';
const fkFixClient=new Client({host:'127.0.0.1',port,user:'postgres',database});await fkFixClient.connect();
try{
 const before=(await fkFixClient.query("SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) snapshot FROM pg_auth_members a WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('meta_ads_app','patima_app')) AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres')")).rows[0].snapshot;
 const fix=readFileSync('scripts/unified-stage11-reconcile-roles-fk-fix.sql','utf8').replace('BEGIN;','BEGIN; GRANT meta_ads_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;').replace('COMMIT;',"RESET ROLE; REVOKE meta_ads_app FROM postgres GRANTED BY postgres; COMMIT;");
 await fkFixClient.query(fix);
 const after=(await fkFixClient.query("SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) snapshot FROM pg_auth_members a WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('meta_ads_app','patima_app')) AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres')")).rows[0].snapshot;
 assert.deepEqual(after,before);evidence.fkCorrectiveSqlExecutedAsOwner='PASS';
}finally{await fkFixClient.end();}
evidence.status='PASS';
}catch(error){evidence.status='FAIL';evidence.sqlstate=error.code??null;evidence.message=error.message;process.exitCode=1;}
finally{if(db)await db.end().catch(()=>{});if(started){const stop=spawnSync(resolve(bin,'pg_ctl.exe'),['-D',data,'-m','fast','-w','stop'],{windowsHide:true,encoding:'utf8',timeout:30000});evidence.stopExit=stop.status;if(stop.status!==0){evidence.status='FAIL';process.exitCode=1;}}writeFileSync('docs/product-performance/research/11-data-role-fixture.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));}
