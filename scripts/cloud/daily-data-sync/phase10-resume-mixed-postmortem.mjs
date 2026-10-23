import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {Client}=require('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/pg');
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/mixed-20261020-v1/attempt-v6';
const bin='C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin';
const original=readFileSync(`${root}/result.json`), previous=JSON.parse(original);
assert.equal(previous.database,'phase10_mixed_20261020');assert.equal(previous.port,55437);assert.equal(previous.dataDirectory,`${root}/pg-data`);assert.equal(previous.status,'FAIL');
const evidence={kind:'OWNED_SYNTHETIC_FAILED_WORKLOAD_READONLY_POSTMORTEM',originalSha256:createHash('sha256').update(original).digest('hex'),startedAt:new Date().toISOString(),remoteRequests:0,newReadBatchRequests:0,readOnly:true};
let started=false,db;
try{
  await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(55437,'127.0.0.1',()=>s.close(resolve));});
  const r=spawnSync(`${bin}/pg_ctl.exe`,['-D',previous.dataDirectory,'-l',`${root}/postmortem-postgres.log`,'-o','-h 127.0.0.1 -p 55437','-w','start'],{windowsHide:true,stdio:'ignore',timeout:30000});assert.equal(r.status,0);started=true;
  db=new Client({host:'127.0.0.1',port:55437,user:'phase10_mixed_owner',database:previous.database});await db.connect();
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL search_path=meta_ads,public;SET LOCAL statement_timeout=20000');
  const identity=(await db.query('SELECT current_database() AS db,current_user AS principal,current_setting(\'transaction_read_only\') AS ro')).rows[0];assert.deepEqual(identity,{db:previous.database,principal:'phase10_mixed_owner',ro:'on'});
  evidence.runs=(await db.query(`SELECT c.provider::text,r.id,r.request_key,r.trigger::text,r.status::text,r.attempt_count,r.rows_fetched,r.rows_published,r.started_at,r.finished_at,r.next_attempt_at,r.deadline_at,r.safe_error_code FROM sync_runs r JOIN source_connections c ON c.id=r.connection_id ORDER BY c.provider,r.request_key LIMIT 30`)).rows;
  evidence.units=(await db.query(`SELECT c.provider::text,r.request_key,u.unit_key,u.status::text,u.attempts,u.fetched_count,u.published_count,u.completed_at FROM run_units u JOIN sync_runs r ON r.id=u.run_id JOIN source_connections c ON c.id=r.connection_id ORDER BY c.provider,r.request_key,u.unit_key LIMIT 60`)).rows;
  evidence.leases=(await db.query('SELECT c.provider::text,l.generation::text,l.expires_at,l.expires_at>clock_timestamp() AS live FROM sync_leases l JOIN source_connections c ON c.id=l.connection_id ORDER BY c.provider')).rows;
  evidence.auditCodes=(await db.query(`SELECT action,result::text,after_json->>'status' AS status,after_json->>'safeErrorCode' AS safe_error_code,after_json->>'diagnosticCode' AS diagnostic_code,count(*)::int AS count FROM security_audit_events GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5 LIMIT 80`)).rows;
  evidence.checkpointCount=(await db.query('SELECT count(*)::int AS n FROM sync_unit_checkpoints')).rows[0].n;
  await db.query('ROLLBACK');evidence.status='READ_ONLY_CAPTURED';
}catch{evidence.status='SAFE_POSTMORTEM_FAILURE';process.exitCode=1;}
finally{await db?.end().catch(()=>{});if(started)evidence.postgresStopExit=spawnSync(`${bin}/pg_ctl.exe`,['-D',previous.dataDirectory,'-m','fast','-w','stop'],{windowsHide:true,stdio:'ignore',timeout:30000}).status;evidence.finishedAt=new Date().toISOString();writeFileSync(`${root}/postmortem-v1.json`,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(evidence));}
