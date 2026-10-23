// Fresh native local PostgreSQL only. All rows/keys/provider values synthetic.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {prepareIncidentCryptoTransform,incidentCryptoSnapshotSql} from './incident-crypto-transform.mjs';
import {syntheticIncidentCryptoInput} from './incident-crypto-fixtures.mjs';
import {runIncidentCryptoChild} from './incident-crypto-child.mjs';
import {openCredential,credentialKey} from '../../../apps/api/src/daily-sync/credential-vault.ts';
import {cafe24ObservationKey} from '../../../apps/api/src/daily-sync/cafe24-observed-revision.ts';
import {loadScheduledCheckpoint} from '../../../apps/api/src/daily-sync/scheduled-checkpoint.ts';
const require=createRequire(import.meta.url),{Client}=require('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/pg');
const key=process.argv[2];assert.match(key??'',/^20261019-[a-z0-9-]{3,32}$/);
const root=`C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019/crypto/${key}`;
assert(!existsSync(root));mkdirSync(root,{recursive:true});
const bin='C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin';
const data=`${root}/pg-data`,port=55435,url=`postgresql://postgres@127.0.0.1:${port}/postgres?schema=phase08_meta_ads&connection_limit=3`;
const summary={kind:'INCIDENT_CRYPTO_REAL_LOCAL_PG_SYNTHETIC',providerRequests:0,remoteMutations:0,realCredentialsUsed:false,checksPassed:0,status:'RUNNING'};
let pg,db,started=false,stage='INIT',sqlState=null;
const check=()=>{summary.checksPassed++;};
function child(command,args){const result=spawnSync(command,args,{stdio:'ignore',windowsHide:true,timeout:60000});if(result.status!==0)throw Error('SAFE_CHILD_FAILURE');}
async function rejectSql(sql){let rejected=false;try{await pg.query(sql);}catch{rejected=true;await pg.query('ROLLBACK');}assert(rejected);}
try{
 child(`${bin}/initdb.exe`,['-D',data,'-U','postgres','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C']);
 child(`${bin}/pg_ctl.exe`,['-D',data,'-l',`${root}/postgres.log`,'-o',`-h 127.0.0.1 -p ${port} -c shared_buffers=16MB -c max_connections=20 -c log_min_error_statement=panic -c log_error_verbosity=terse`,'-w','start']);started=true;
 pg=new Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await pg.connect();
 stage='MIGRATIONS';await pg.query('CREATE SCHEMA phase08_meta_ads;SET search_path=phase08_meta_ads,public');
 const names=readdirSync('apps/api/prisma/migrations',{withFileTypes:true}).filter(r=>r.isDirectory()).map(r=>r.name).sort();
 for(const name of names){stage=`MIGRATION_${name}`;await pg.query(readFileSync(`apps/api/prisma/migrations/${name}/migration.sql`,'utf8').replaceAll('"meta_ads".','"phase08_meta_ads".'));}
 stage='POST_MIGRATION_ROLE';
 await pg.query('CREATE ROLE phase08_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;GRANT USAGE ON SCHEMA phase08_meta_ads TO phase08_runtime');
 const tables=(await pg.query("SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads'")).rows;
 summary.syntheticTableCount=tables.length;
 for(const {tablename}of tables){assert.match(tablename,/^[a-z0-9_]+$/);await pg.query(`ALTER TABLE ${tablename} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${tablename} FORCE ROW LEVEL SECURITY`);}
 assert.equal(tables.length,68);check();
 db=new PrismaClient({datasourceUrl:url});stage='FIXTURE';
 const{input,plaintexts,runId}=syntheticIncidentCryptoInput(),at=new Date('2026-10-17Z');
 await db.sourceConnection.create({data:{id:input.connectionId,provider:'CAFE24',externalAccountId:'didadi0729',shopKey:'shop1',displayName:'Synthetic incident crypto',currencyCode:'KRW',timeZone:'Asia/Seoul',enabled:false,accessState:'READY'}});
 await db.syncRun.create({data:{id:runId,connectionId:input.connectionId,trigger:'MANUAL',requestKey:'SYNTHETIC_INCIDENT_CRYPTO',fromDate:new Date('2026-10-16Z'),toDate:at,status:'FAILED'}});
 stage='FIXTURE_CREDENTIALS';for(const row of input.snapshot.credentials)await db.sourceCredential.create({data:{id:row.id,connectionId:row.connectionId,kind:row.kind,keyVersion:1,revision:row.revision,
  ciphertext:Buffer.from(row.ciphertextB64,'base64'),iv:Buffer.from(row.ivB64,'base64'),authTag:Buffer.from(row.authTagB64,'base64'),expiresAt:new Date(row.expiresAt)}});
 stage='FIXTURE_CHECKPOINTS';for(const row of input.snapshot.checkpoints){
  await db.runUnit.create({data:{runId,unitKey:row.unitKey,status:'FAILED',checkpointValue:row.checkpointValue,attempts:1}});
  await pg.query('INSERT INTO sync_unit_checkpoints(run_id,unit_key,ciphertext,iv,auth_tag,revision,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz)',[row.runId,row.unitKey,Buffer.from(row.ciphertextB64,'base64'),Buffer.from(row.ivB64,'base64'),Buffer.from(row.authTagB64,'base64'),row.revision,row.expiresAt]);
 }
 stage='FIXTURE_OBSERVATION';await db.cafe24ObservedOrderRevision.create({data:{connectionId:input.connectionId,orderKeyHash:'a'.repeat(64),revision:1,orderDate:at,contentHash:'b'.repeat(64),firstObservedAt:at,lastObservedAt:at,observationId:runId}});
 await db.cafe24ObservedDayCheckpoint.create({data:{connectionId:input.connectionId,orderDate:at,queryStartedAt:at,completedAt:at,observationId:runId,keyVersion:1,orderCount:1,itemCount:1,snapshotHash:'c'.repeat(64)}});
 stage='FIXTURE_BUSINESS';const product=await db.product.create({data:{code:'SYNTHETIC_INCIDENT_USER',name:'Synthetic',displayName:'User edit preserved'}});
 const batch=await db.cafe24UploadBatch.create({data:{originalFilename:'synthetic.csv',fileHashSha256:'d'.repeat(64),columnSchema:[],status:'IMPORTED',rowCount:1}});
 await db.cafe24OrderLine.create({data:{uploadBatchId:batch.id,rowNumber:1,sourceRowHash:'e'.repeat(64),orderLineKey:'SYNTHETIC_ONLY_CSV',orderNo:'SYNTHETIC_ONLY_ORDER',lineOrderNo:'SYNTHETIC_ONLY_LINE',productNo:'1',productName:'Synthetic',optionName:'Synthetic',quantity:'1',salePriceKrw:'149',totalPaidKrw:'149',orderDate:at,productId:product.id,source:'CSV'}});
 const snap=async()=>{const r=(await pg.query(incidentCryptoSnapshotSql())).rows[0];return{credentials:r.credentials,checkpoints:r.checkpoints};};
 stage='SNAPSHOT';input.snapshot=await snap();const beforeBusiness=JSON.stringify(await db.cafe24OrderLine.findMany()),beforeObserved=JSON.stringify(await db.cafe24ObservedOrderRevision.findMany());
 summary.credentialShape={rows:input.snapshot.credentials.length,allExpiryStrings:input.snapshot.credentials.every(r=>typeof r.expiresAt==='string'),
  allOwnersNull:input.snapshot.credentials.every(r=>r.refreshOwner===null&&r.refreshUntil===null),allVersion1:input.snapshot.credentials.every(r=>r.keyVersion===1),
  allCipherCanonical:input.snapshot.credentials.every(r=>Buffer.from(r.ciphertextB64,'base64').toString('base64')===r.ciphertextB64),
  allExpiryValid:input.snapshot.credentials.every(r=>Number.isFinite(Date.parse(r.expiresAt)))};
 stage='PREPARE';const prepared=prepareIncidentCryptoTransform(input);check();stage='NEGATIVE_CAS';
 await pg.query('UPDATE source_credentials SET revision=revision+1 WHERE id=$1',[input.snapshot.credentials[0].id]);await rejectSql(prepared.mutationSql);
 assert.equal(await db.sourceCredential.count({where:{keyVersion:2}}),0);await pg.query('UPDATE source_credentials SET revision=revision-1 WHERE id=$1',[input.snapshot.credentials[0].id]);check();
 await pg.query('GRANT SELECT ON cafe24_observed_order_revisions TO phase08_runtime');await rejectSql(prepared.mutationSql);await pg.query('REVOKE SELECT ON cafe24_observed_order_revisions FROM phase08_runtime');check();
 await db.syncLease.create({data:{connectionId:input.connectionId,ownerRunId:runId,expiresAt:new Date(Date.now()+60000)}});await rejectSql(prepared.mutationSql);await db.syncLease.delete({where:{connectionId:input.connectionId}});check();
 stage='NEGATIVE_MID_WRITE';
 await pg.query("CREATE FUNCTION incident_fail_second() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF OLD.kind='CAFE24_REFRESH' THEN RAISE EXCEPTION 'SYNTHETIC_MID_WRITE_FAILURE'; END IF; RETURN NEW; END$$;CREATE TRIGGER incident_fail_second BEFORE UPDATE ON source_credentials FOR EACH ROW EXECUTE FUNCTION incident_fail_second()");
 await rejectSql(prepared.mutationSql);assert.equal(await db.sourceCredential.count({where:{keyVersion:2}}),0);assert.equal(await db.securityAuditEvent.count({where:{action:'INCIDENT_CRYPTO_REWRAPPED'}}),0);
 await pg.query('DROP TRIGGER incident_fail_second ON source_credentials;DROP FUNCTION incident_fail_second()');check();
 stage='NEGATIVE_OLD_SESSION';
 await pg.query('ALTER ROLE phase08_runtime LOGIN');
 const lingering=new Client({host:'127.0.0.1',port,user:'phase08_runtime',database:'postgres'});
 await lingering.connect();await pg.query('ALTER ROLE phase08_runtime NOLOGIN');
 await rejectSql(prepared.mutationSql);await lingering.end();check();
 stage='TRANSFORM';const reply=await pg.query(prepared.mutationSql);const finalReply=Array.isArray(reply)?reply.at(-1).rows[0]:reply.rows[0];
 assert.equal(finalReply.credentialRowsReencrypted,2);assert.equal(finalReply.checkpointRowsReencrypted,2);check();
 assert.equal(JSON.stringify(await db.cafe24OrderLine.findMany()),beforeBusiness);assert.equal(JSON.stringify(await db.cafe24ObservedOrderRevision.findMany()),beforeObserved);
 assert.equal((await db.product.findUnique({where:{id:product.id}})).displayName,'User edit preserved');assert.equal(await db.cafe24ObservedDayCheckpoint.count({where:{keyVersion:1}}),1);check();
 const after=await snap();assert.equal(after.credentials.filter(r=>r.keyVersion===2).length,2);assert.equal(after.credentials.filter(r=>r.keyVersion===1).length,0);
 const bridgeVerification=runIncidentCryptoChild({operation:'VERIFY',input,after});assert.equal(bridgeVerification.verified,true);assert.equal(bridgeVerification.oldCredentialKeyCannotDecryptNewCiphertext,true);assert.equal(bridgeVerification.oldCheckpointKeyCannotDecryptNewCiphertext,true);check();
 for(const r of after.credentials){const old=input.snapshot.credentials.find(b=>b.id===r.id);assert.ok(r.expiresAt===old.expiresAt);assert.equal(r.revision,old.revision+1);}
 for(const r of after.checkpoints){const old=input.snapshot.checkpoints.find(b=>b.unitKey===r.unitKey);assert.ok(r.expiresAt===old.expiresAt);assert.equal(r.revision,old.revision+1);assert.ok(r.checkpointValue===createHash('sha256').update(Buffer.from(r.ciphertextB64,'base64')).digest('hex'));}check();
 stage='NEW_KEYS';const oldEnvironment={...process.env};
 try{
  delete process.env.DAILY_SYNC_CREDENTIAL_KEY_V1;Object.assign(process.env,prepared.environmentUpdate.set);
  for(const r of await db.sourceCredential.findMany()){const token=openCredential(r,r.connectionId,r.kind);assert.ok(Buffer.from(token).equals(plaintexts[r.kind]));}
  assert.throws(()=>credentialKey(1,{...prepared.environmentUpdate.set,DAILY_SYNC_CREDENTIAL_KEY_V1:input.oldKeys.credentialV1}));check();
  const claim={runId,connectionId:input.connectionId};assert.equal((await loadScheduledCheckpoint(db,claim,'2026-10-17')).syntheticOnly,true);
  await assert.rejects(loadScheduledCheckpoint(db,claim,'2026-10-16'));check();
  assert.throws(()=>cafe24ObservationKey());assert.equal((await pg.query("SELECT has_table_privilege('phase08_runtime','cafe24_observed_order_revisions','SELECT,INSERT,UPDATE,DELETE') AS allowed")).rows[0].allowed,false);check();
 }finally{
  for(const name of [...Object.keys(prepared.environmentUpdate.set),'DAILY_SYNC_CREDENTIAL_KEY_V1']){if(oldEnvironment[name]===undefined)delete process.env[name];else process.env[name]=oldEnvironment[name];}
 }
 stage='REPLAY';await rejectSql(prepared.mutationSql);assert.equal(await db.securityAuditEvent.count({where:{action:'INCIDENT_CRYPTO_REWRAPPED'}}),1);check();
 summary.status='PASS';Object.assign(summary,{credentialRowsReencrypted:2,checkpointRowsReencrypted:2,oldCredentialVersionRemaining:0,businessRowsPreserved:true,
  observationBaselinePreserved:true,observationUseQuarantined:true,newKeyDecryptsSameStoredTokens:true,oldKeyReuseRejected:true,checkpointExpiryPreserved:true,expiredCheckpointNotResumed:true,
  staleRevisionRejected:true,unrevokedObservationGrantRejected:true,liveLeaseRejected:true,midWriteFaultAtomicRollback:true,lingeringOldRuntimeSessionRejected:true,replayRejected:true,providerCredentialsRevoked:false,operatingTouched:false});
}catch(error){summary.status='FAIL';summary.safeStage=stage;summary.rawErrorSuppressed=true;if(['INPUT','KEYS','SNAPSHOT','CREDENTIALS','CHECKPOINTS','SQL'].includes(error?.safeStage))summary.transformStage=error.safeStage;if(typeof error?.code==='string'&&/^[A-Z0-9]{5}$/.test(error.code))summary.sqlState=error.code;process.exitCode=1;}
finally{
 await db?.$disconnect();await pg?.end();
 if(started){const stopped=spawnSync(`${bin}/pg_ctl.exe`,['-D',data,'-m','fast','-w','stop'],{stdio:'ignore',windowsHide:true,timeout:30000});summary.postgresStopExit=stopped.status;if(stopped.status!==0)process.exitCode=1;}
 writeFileSync(`${root}/result.json`,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(summary));
}
