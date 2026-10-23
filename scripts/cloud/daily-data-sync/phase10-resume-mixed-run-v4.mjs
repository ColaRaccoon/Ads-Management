import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createConnection} from 'node:net';
import {createInterface} from 'node:readline';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {Client}=require('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/pg');
const bin='C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin';
const label=process.argv[2];assert.match(label??'',/^v[1-9][0-9]*$/);
const root=`C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/mixed-20261020-v2/attempt-${label}`;assert(!existsSync(root));mkdirSync(root,{recursive:true});
const image='sha256:1f98e7fc0b5d7009c71815a236e37ca12dc81ed87f3a45d7c0a1142ebdbae0e1';
const revision='d7e9d2001f94f45a0e731a209f5d17415513bb08',name=`phase10-mixed-${label}-${randomUUID().slice(0,8)}`,owner=randomUUID();
const evidence={kind:'ACTUAL_FINAL_IMAGE_SYNTHETIC_MIXED_WORKLOAD',status:'RUNNING',startedAt:new Date().toISOString(),root,image,revision,
  criteria:{p95Ms:5000,requests:40,concurrency:4,errors:0},remoteRequests:0,protectedReads:0,realCredentialsUsed:false,productionCodeEdited:false,
  dataDirectory:`${root}/pg-data`,database:'phase10_mixed_20261020',port:55437,container:name,hostDbOutsideCgroup:true};
const sha=b=>createHash('sha256').update(b).digest('hex');

const candidate='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v6';
const source='d1ad9a09da4a07cb7d8dd7c86fa194297b286e957e38d53188cbe08e6539ff14';
const verifyClosure=()=>{const mf=JSON.parse(readFileSync(candidate+'/source-content-manifest.json','utf8'));assert.equal(mf.files.length,495);assert.equal(mf.sourceContentSha256,source);assert.equal(sha(JSON.stringify(mf.files)),source);for(const f of mf.files){const b=readFileSync(candidate+'/'+f.name);assert.equal(b.length,f.size);assert.equal(sha(b),f.sha256);}return {source,files:495,migrations:52};};
evidence.candidateBefore=verifyClosure();evidence.remoteMigrationApplied=false;evidence.epochActivation=false;evidence.actualEpochEntryExercisedByMixed=false;
const scripts=['phase10-resume-mixed-container-v2.cjs','phase10-resume-mixed-fixtures.cjs','phase10-resume-mixed-proof.cjs','phase10-resume-mixed-state.cjs'];
const {validateDbTelemetry}=require('./phase10-resume-mixed-proof.cjs');
evidence.harnessHashes=Object.fromEntries([...scripts,'phase10-resume-mixed-run-v4.mjs'].map(n=>[n,sha(readFileSync(`scripts/cloud/daily-data-sync/${n}`))]));
const assertHarness=()=>{for(const n of scripts)assert.equal(sha(readFileSync(`scripts/cloud/daily-data-sync/${n}`)),evidence.harnessHashes[n],'MOUNTED_SOURCE_CHANGED');};
let pg,pgStarted=false,created=false,currentChild,stage='PREPARE',lastResult;
const publicStages=[],dbTelemetry=[],dbObservationErrors=[];
async function captureDb(stageOverride=null){const r=await pg.query("SELECT count(*)::int AS backends,count(*) FILTER(WHERE state='active')::int AS active,count(*) FILTER(WHERE state='idle in transaction')::int AS idle_tx,count(*) FILTER(WHERE wait_event_type='Lock')::int AS locks FROM pg_stat_activity WHERE usename='phase10_mixed_runtime'");const v={at:Date.now(),stage:stageOverride??stage,...r.rows[0]};dbTelemetry.push(v);return v;}
function command(exe,args,options={}){const r=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024,...options});if(r.status!==0)throw Object.assign(Error('LOCAL_COMMAND_FAILED'),{safeChildExit:r.status});return r.stdout?.trim()??'';}
function inspect(format){return command('docker',['inspect','--format',format,name]);}
const save=(name,v)=>writeFileSync(`${root}/${name}`,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
async function session(resume=null){
  assertHarness();
  const sockets=new Map();let result=null,restart=null,failure=null,discardedOutputLines=0,discardedStderrBytes=0;
  const child=spawn('docker',['start','--attach','--interactive',name],{windowsHide:true,stdio:['pipe','pipe','pipe']});currentChild=child;
  const send=v=>{if(!child.stdin.destroyed)child.stdin.write(JSON.stringify(v)+'\n');};
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try{let m;try{m=JSON.parse(line);}catch{discardedOutputLines++;return;}
    if(m.t==='relay-ready')send({t:'start',resume});
    else if(m.t==='db-open'){
      assert(Number.isInteger(m.id)&&m.id>0&&m.id<=1000);const socket=createConnection({host:'127.0.0.1',port:55437});sockets.set(m.id,socket);
      socket.on('data',b=>send({t:'db-data',id:m.id,data:b.toString('base64')}));socket.on('end',()=>send({t:'db-end',id:m.id}));socket.on('error',()=>send({t:'db-end',id:m.id}));
    }else if(m.t==='db-data')sockets.get(m.id)?.write(Buffer.from(m.data,'base64'));
    else if(m.t==='db-end')sockets.get(m.id)?.end();
    else if(m.t==='stage'){stage=m.stage;publicStages.push(m);console.log(JSON.stringify({stage,at:m.at,generation:resume?2:1}));}
    else if(m.t==='measurement-row'){assert(Number.isInteger(m.row?.index)&&m.row.index>=0&&m.row.index<40);save(`measurement-row-${String(m.row.index).padStart(2,'0')}.json`,m.row);}
    else if(m.t==='measurement-checkpoint'){assert(Number.isInteger(m.sequence)&&m.sequence>0&&m.sequence<=20);assert(['phase-complete','reads-complete','writer-phase-settled','failure-partial'].includes(m.label));save(`measurement-checkpoint-${String(m.sequence).padStart(2,'0')}-${m.label}.json`,m.data);evidence.lastMeasurementCheckpoint={sequence:m.sequence,label:m.label,rows:m.data.rows.length,complete:m.data.complete,p95Ms:m.data.p95Ms};send({t:'measurement-ack',sequence:m.sequence});}
    else if(m.t==='retry-wait'){publicStages.push({stage:'SCHEDULED_BACKOFF_WAIT',runId:m.runId,milliseconds:m.milliseconds,at:m.at});}
    else if(m.t==='failure')failure=m;
    else if(m.t==='result')result=m.data;
    else if(m.t==='checkpoint-restart'){restart=m.data;void(async()=>{restart.dbBeforeKill=await captureDb('BEFORE_ACTIVE_SIGKILL');assert(restart.dbBeforeKill.backends>0&&restart.dbBeforeKill.backends<=3);assert.equal(dbObservationErrors.length,0);save('pre-kill-progress.json',restart);command('docker',['kill','--signal','KILL',name]);})().catch(()=>{failure={stage,safeCode:'PRE_KILL_TELEMETRY_GUARD',rawSuppressed:true};child.kill();});}
    else if(m.t==='warm-status')publicStages.push({stage:'WARM_STATUS',status:m.status});
    }catch{failure={stage,safeCode:'PUBLIC_EVIDENCE_CHECKPOINT_FAILED',rawSuppressed:true};child.kill();}
  });
  child.stderr.on('data',b=>{discardedStderrBytes+=b.length;});
  const timer=setInterval(()=>{void captureDb().catch(()=>dbObservationErrors.push({at:Date.now(),stage,safeCode:'DB_TELEMETRY_QUERY_FAILED'}));},500);
  const timeout=setTimeout(()=>{failure={stage,safeCode:'EXPERIMENT_TIME_LIMIT',rawSuppressed:true};child.kill();},18*60000);
  const exit=await new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
  clearInterval(timer);clearTimeout(timeout);lines.close();for(const s of sockets.values())s.destroy();currentChild=null;
  evidence.sessions??=[];evidence.sessions.push({...exit,discardedOutputLines,discardedStderrBytes,restartRequested:!!restart});
  if(failure)throw Object.assign(Error('SAFE_CONTAINER_FAILURE'),{failure});
  if(restart){assert.equal(exit.code,137);return {restart};}
  assert.equal(exit.code,0);assert(result,'MISSING_EXPERIMENT_RESULT');return {result};
}
try{
  stage='PG_INIT';command(`${bin}/initdb.exe`,['-D',evidence.dataDirectory,'-U','phase10_mixed_owner','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C']);
  command(`${bin}/pg_ctl.exe`,['-D',evidence.dataDirectory,'-l',`${root}/postgres.log`,'-o','-h 127.0.0.1 -p 55437','-w','start'],{stdio:'ignore'});pgStarted=true;
  pg=new Client({host:'127.0.0.1',port:55437,user:'phase10_mixed_owner',database:'postgres'});await pg.connect();await pg.query('CREATE DATABASE phase10_mixed_20261020');await pg.end();
  pg=new Client({host:'127.0.0.1',port:55437,user:'phase10_mixed_owner',database:'phase10_mixed_20261020'});await pg.connect();
  await pg.query('CREATE SCHEMA meta_ads;SET search_path=meta_ads,public');
  const migrations=readdirSync('apps/api/prisma/migrations',{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort();assert.equal(migrations.length,52);
  for(const n of migrations)assert.equal(sha(readFileSync(`apps/api/prisma/migrations/${n}/migration.sql`)),sha(readFileSync(`C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v6/apps/api/prisma/migrations/${n}/migration.sql`)),'CANDIDATE_MIGRATION_BYTES_CHANGED');
  for(const n of migrations)await pg.query(readFileSync(`apps/api/prisma/migrations/${n}/migration.sql`,'utf8'));evidence.migrations=52;
  await pg.query("CREATE ROLE phase10_mixed_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 3 PASSWORD 'synthetic-local-only';GRANT USAGE ON SCHEMA meta_ads TO phase10_mixed_runtime;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA meta_ads TO phase10_mixed_runtime;GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA meta_ads TO phase10_mixed_runtime");
  // New empty local database only: explicit test-role policies; RLS/FORCE and NOSUPERUSER/NOBYPASSRLS stay enabled.
  const tables=(await pg.query("SELECT tablename FROM pg_tables WHERE schemaname='meta_ads' ORDER BY tablename")).rows;
  assert.equal(tables.length,70);for(const {tablename}of tables){assert(/^[a-z0-9_]+$/.test(tablename));await pg.query(`ALTER TABLE meta_ads."${tablename}" ENABLE ROW LEVEL SECURITY;ALTER TABLE meta_ads."${tablename}" FORCE ROW LEVEL SECURITY`);await pg.query(`CREATE POLICY mixed_fixture_runtime ON meta_ads."${tablename}" FOR ALL TO phase10_mixed_runtime USING(true) WITH CHECK(true)`);}
  evidence.localFixturePolicies=tables.length;const forced=(await pg.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity")).rows[0].n;assert.equal(forced,70);evidence.explicitlyForcedRlsTables=forced;
  stage='IMAGE_CAS';assert.equal(command('docker',['image','inspect','--format','{{.Id}}',image]),image);assert.equal(command('docker',['image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',image]),revision);
  const mounts=scripts.flatMap(n=>['--mount',`type=bind,src=${path.resolve('scripts/cloud/daily-data-sync/'+n)},dst=/experiment/${n},readonly`]);
  command('docker',['create','--name',name,'--label',`phase10.mixed.owner=${owner}`,'--network','none','--read-only','--memory','1000000000','--memory-swap','1000000000','--cpus','1','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=67108864','--log-driver','none','--interactive',...mounts,image,'node','--max-old-space-size=512','/experiment/phase10-resume-mixed-container-v2.cjs']);created=true;
  assert.equal(inspect('{{index .Config.Labels "phase10.mixed.owner"}}'),owner);assert.equal(inspect('{{.HostConfig.NetworkMode}}'),'none');assert.equal(inspect('{{.HostConfig.Memory}}'),'1000000000');assert.equal(inspect('{{.HostConfig.MemorySwap}}'),'1000000000');assert.equal(inspect('{{.HostConfig.NanoCpus}}'),'1000000000');assert.equal(inspect('{{.Config.OpenStdin}}'),'true');
  evidence.resources={memory:1000000000,swap:1000000000,nanoCpus:1000000000,network:'none',runtimeSecretEnvironmentInjected:false};
  const first=await session();assert(first.restart,'MISSING_SIGKILL_BOUNDARY');assert.equal(inspect('{{.State.OOMKilled}}'),'false');evidence.firstGenerationKilled=true;
  const second=await session(first.restart);lastResult=second.result;save('mixed-workload.json',lastResult);
  evidence.status=lastResult.status;evidence.summary={requests:lastResult.rows.length,p95Ms:lastResult.p95,errors:lastResult.rows.filter(r=>r.status!==200).length,checkpointRecovered:lastResult.checkpointRecoveredAfterSigkill,fixtureOnly:lastResult.fixtureRequests.nonFixtureRequests===0,finalCounts:lastResult.finalCounts};
  evidence.finalState={exitCode:Number(inspect('{{.State.ExitCode}}')),oomKilled:inspect('{{.State.OOMKilled}}')==='true',running:inspect('{{.State.Running}}')==='true'};
  assert.equal(evidence.finalState.oomKilled,false);assert.equal(evidence.finalState.running,false);evidence.dbProjection=validateDbTelemetry(dbTelemetry,lastResult.rows,dbObservationErrors);
}catch(error){evidence.status='FAIL';evidence.failure={stage,code:error.message==='SAFE_CONTAINER_FAILURE'?'SAFE_CONTAINER_FAILURE':'LOCAL_EXPERIMENT_FAILED',childExit:error.safeChildExit??null,container:error.failure??null,rawSuppressed:true};process.exitCode=1;}
finally{
  if(currentChild)currentChild.kill();
  if(created){try{assert.equal(inspect('{{index .Config.Labels "phase10.mixed.owner"}}'),owner);evidence.cleanupStopExit=spawnSync('docker',['stop','--time','3',name],{windowsHide:true,stdio:'ignore'}).status;}catch{evidence.cleanupOwnerGuardFailed=true;}finally{if(!evidence.cleanupOwnerGuardFailed)evidence.cleanupRemoveExit=spawnSync('docker',['rm','--force',name],{windowsHide:true,stdio:'ignore'}).status;}}
  await pg?.end().catch(()=>{});if(pgStarted)evidence.postgresStopExit=spawnSync(`${bin}/pg_ctl.exe`,['-D',evidence.dataDirectory,'-m','fast','-w','stop'],{windowsHide:true,stdio:'ignore',timeout:30000}).status;
  try{evidence.candidateAfter=verifyClosure();}catch{evidence.status='FAIL';evidence.finalClosureFailure={safeCode:'CANDIDATE_FINAL_CLOSURE_FAILED',rawSuppressed:true};process.exitCode=1;}evidence.finishedAt=new Date().toISOString();evidence.publicStages=publicStages;evidence.dbObservationErrors=dbObservationErrors;save('db-telemetry.json',dbTelemetry);save('result.json',evidence);console.log(JSON.stringify({status:evidence.status,summary:evidence.summary??null,failure:evidence.failure??null,postgresStopExit:evidence.postgresStopExit,evidence:`${root}/result.json`}));
}
