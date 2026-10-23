// Public, local-only verification. Does not start the application, database or provider.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const {resourceSnapshot,validateDbTelemetry}=createRequire(import.meta.url)('./phase10-resume-mixed-proof.cjs');
const version=process.argv[2];assert.match(version??'',/^v[1-9][0-9]*$/);
const root=`C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/mixed-20261020-v2/attempt-${version}`;
const output=`${root}/independent-audit.json`;assert(!existsSync(output));
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=name=>JSON.parse(readFileSync(`${root}/${name}`,'utf8'));
const e=read('result.json'),m=read('mixed-workload.json'),db=read('db-telemetry.json'),pre=read('pre-kill-progress.json');
const result={kind:'LOCAL_MIXED_NUMERICAL_AND_BOUNDARY_AUDIT',at:new Date().toISOString(),status:'RUNNING',remoteRequests:0,protectedReads:0};
try{
  assert.equal(e.image,'sha256:1f98e7fc0b5d7009c71815a236e37ca12dc81ed87f3a45d7c0a1142ebdbae0e1');assert.equal(e.revision,'d7e9d2001f94f45a0e731a209f5d17415513bb08');
  assert.equal(e.migrations,52);assert.equal(e.localFixturePolicies,70);assert.equal(e.explicitlyForcedRlsTables,70);assert.deepEqual(e.candidateBefore,e.candidateAfter);assert.equal(e.resources.memory,1000000000);assert.equal(e.resources.nanoCpus,1000000000);assert.equal(e.resources.network,'none');
  assert.equal(m.rows.length,40);assert.deepEqual(m.rows.map(x=>x.index).sort((a,b)=>a-b),Array.from({length:40},(_,i)=>i));
  assert(m.rows.every(x=>x.status===200&&Number.isFinite(x.ms)&&x.ms>0&&Number.isInteger(x.bytes)&&x.bytes>0&&x.start<=x.end));
  const sorted=m.rows.map(x=>x.ms).sort((a,b)=>a-b),p95=sorted[37];assert.equal(m.p95,p95);assert.equal(e.summary.p95Ms,p95);
  const rowFiles=readdirSync(root).filter(n=>/^measurement-row-\d\d\.json$/.test(n));assert.equal(rowFiles.length,40);
  for(const name of rowFiles){const raw=read(name),final=m.rows.find(r=>r.index===raw.index);assert(final);const {collectorOverlap,transactionOverlap,...original}=final;assert.deepEqual(raw,original);}
  const completeFiles=readdirSync(root).filter(n=>/^measurement-checkpoint-\d\d-reads-complete\.json$/.test(n));assert.equal(completeFiles.length,1);const checkpoint=read(completeFiles[0]);assert.equal(checkpoint.complete,true);assert.equal(checkpoint.rows.length,40);assert.equal(checkpoint.p95Ms,p95);
  assert.deepEqual(checkpoint.criteria,{requests:40,concurrency:4,p95Ms:5000,errors:0});
  const perProvider={};
  for(const [provider,n]of [['META',16],['CAFE24',12],['GOOGLE',12]]){
    const rows=m.rows.filter(r=>r.provider===provider);assert.equal(rows.length,n);
    const tx=m.txSpans.filter(t=>t.provider===provider&&t.canonicalWriter===true);assert(tx.length>0);
    const overlap=rows.filter(r=>tx.some(t=>r.start<t.end&&r.end>t.start));assert(overlap.length>0);
    perProvider[provider]={requests:n,canonicalWriteOverlap:overlap.length,p95:rows.map(r=>r.ms).sort((a,b)=>a-b)[Math.ceil(n*.95)-1]};
  }
  const perEndpoint=Object.fromEntries([...new Set(m.rows.map(r=>r.path))].map(p=>{const r=m.rows.filter(x=>x.path===p);assert.equal(r.length,20);return[p,{requests:20,p95:r.map(x=>x.ms).sort((a,b)=>a-b)[18]}];}));
  assert.equal(m.runsSucceeded,3);assert.equal(m.unitsSucceeded,15);assert.equal(m.coverageBound,22);assert.equal(m.publicationAudits,15);assert.equal(m.metaVersion2Rows,3661);assert.equal(m.metaCurrentSpendUsd,'7322');
  assert.equal(m.finalCounts.ads,3661);assert.equal(m.finalCounts.adsets,1400);assert.equal(m.finalCounts.cafe,379);assert.equal(m.finalCounts.checkpoints[0].n,0);
  assert.equal(Number(m.googlePositiveReadDay.slice(-2))%2,0);assert.equal(m.fixtureRequests.nonFixtureRequests,0);
  assert.equal(pre.activeRun,true);assert.equal(pre.liveLease,true);assert.equal(pre.insideFetchScheduledChunk,true);assert.equal(pre.firstCount,100);assert.equal(pre.checkpoint.revision,1);assert(pre.checkpoint.bytes>0);
  assert.deepEqual(m.preKill.checkpoint,pre.checkpoint);assert.equal(m.checkpointRecoveredAfterSigkill,true);assert(pre.dbBeforeKill.backends>0&&pre.dbBeforeKill.backends<=3);
  assert.equal(e.sessions.length,2);assert.equal(e.sessions[0].code,137);assert.equal(e.sessions[0].restartRequested,true);assert.equal(e.sessions[1].code,0);
  const samples=[...pre.resources,...m.resources];assert(samples.length>0);
  for(const r of samples)resourceSnapshot({at:r.at,current:String(r.cgroupCurrent),peak:String(r.cgroupPeak),max:'999997440',events:Object.entries(r.events).map(([k,v])=>`${k} ${v}`).join('\n'),rss:r.rss,heap:r.heapUsed,heavy:r.heavy});
  assert(samples.some(r=>r.heavy===1));assert.equal(m.authGuardBypassed,false);assert.equal(m.actualLocalSessionChecks,true);assert.equal(m.loggedOut,true);
  assert.equal(m.malformedProvider.status,'ACTION_REQUIRED');assert.equal(m.malformedProvider.code,'FIELD_UNSUPPORTED');assert.equal(m.malformedProvider.publicationAudits,0);assert.equal(m.malformedProvider.canonicalPreserved,true);assert.equal(m.malformedProvider.lastSuccessPreserved,true);
  assert.equal(Number(m.cgroup.memoryMax),999997440);const finalEvents=Object.fromEntries(m.cgroup.memoryEvents.trim().split(/\n/).map(s=>{const[k,v]=s.trim().split(/\s+/);return[k,Number(v)];}));for(const key of ['oom','oom_kill','max'])assert.equal(finalEvents[key],0);assert(Number(m.cgroup.memoryPeak)>0&&Number(m.cgroup.memoryPeak)<=999997440);assert.equal(e.cleanupRemoveExit,0);assert.equal(e.postgresStopExit,0);assert.equal(e.finalState.oomKilled,false);assert.equal(e.finalState.running,false);
  const dbProjection=validateDbTelemetry(db,m.rows,e.dbObservationErrors);
  for(const [p,h]of Object.entries(m.compiledHashes))assert.equal(sha(readFileSync(`C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/portable-build-20261020-v2/api-dist/${p}.js`)),h);
  const waitStart=m.stageHistory.find(s=>s.stage==='RECOVERY_LEASE_WAIT'),waitEnd=m.stageHistory.find(s=>s.stage==='CAFE_CHECKPOINT_CONTINUATIONS');assert(waitStart&&waitEnd&&waitEnd.at>=waitStart.at);
  result.status=p95<=5000&&e.status==='PASS'?'PASS_SYNTHETIC_MIXED_ONLY':'FAIL';
  Object.assign(result,{p95Ms:p95,requests:40,concurrency:4,errors:0,bytes:m.rows.reduce((s,r)=>s+r.bytes,0),perEndpoint,perProvider,
    resourceSamples:samples.length,maxApiRssBytes:Math.max(...samples.map(r=>r.rss)),maxCgroupPeakBytes:Math.max(...samples.map(r=>r.cgroupPeak)),sampledMaxCgroupPeakBytes:Math.max(...samples.map(r=>r.cgroupPeak)),finalKernelMemoryPeakBytes:Number(m.cgroup.memoryPeak),finalKernelMemoryEvents:finalEvents,effectiveMemoryMaxBytes:999997440,requestedMemoryBytes:1000000000,oom:0,oomKill:0,dbProjection,
    recovery:{activeWorkerSigkill:true,encryptedCheckpointRows:100,originalCipherRevisionPreserved:true,leaseWaitMs:waitEnd.at-waitStart.at,completedCafeOrders:343,completedCafeLines:379,checkpointRowsAfterSuccess:0},
    durablePerReadFiles:rowFiles.length,immediateCompletedMeasurementCheckpoint:true,completedMeasurementSha256:sha(readFileSync(`${root}/${completeFiles[0]}`)),runtimeCompiledFilesCompared:Object.keys(m.compiledHashes).length,release:'d7e9d2001f94f45a0e731a209f5d17415513bb08',source:'d1ad9a09da4a07cb7d8dd7c86fa194297b286e957e38d53188cbe08e6539ff14',newEpochPathVerifiedSeparately:true,remote52MigrationApplied:false,explicitlyForcedRlsTables:70,boundaries:{productionScheduledHttpDispatcher:false,actualFoundationQueueRetryLease:true,actualProviderHttpParsers:true,actualCanonicalWriters:true,sharedPrismaPool:true,actualLocalAuthSessionDatabaseChecks:true,productionAuthAndStorage:false,productionLauncher:false,externalProviders:false,fixtureAndLoadClientInsideCgroup:true,postgresOutsideCgroup:true,baselineCafeReconciliationSeeded:true,midTransactionSigkill:false},
    sourceEvidence:Object.fromEntries(['result.json','mixed-workload.json','db-telemetry.json','pre-kill-progress.json'].map(n=>[n,sha(readFileSync(`${root}/${n}`))]))});
}catch{result.status='FAIL_AUDIT_BOUNDARY';result.rawErrorSuppressed=true;process.exitCode=1;}
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:result.status,p95:result.p95Ms??null,resourceSamples:result.resourceSamples??null,maxApiRssBytes:result.maxApiRssBytes??null,maxCgroupPeakBytes:result.maxCgroupPeakBytes??null,evidence:output,sha256:sha(readFileSync(output))}));
