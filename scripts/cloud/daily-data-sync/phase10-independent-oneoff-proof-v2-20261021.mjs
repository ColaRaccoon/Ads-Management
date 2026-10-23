// Public receipts only: no database, network, protected input or process launch.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const DAYS=['2026-10-16','2026-10-17'],OP='20261021-cafe08-manual-a';
const APPROVED=new Set(['C40','C47','C48','E00','N00','N20','N30','N40','R00','R30','R40']);
const SOURCE='70a7c8cd00c2dd592f632dd35312e283011ef648c5926b5aac4273edb8cea6f2';
const ANCESTOR_PATH=E+'/continuation-20261021/cafe-oneoff-controller-v5/execute-c-result.json';
const ANCESTOR_SHA='cb70081771644edeb168eefc3742b6a364be3a468635f712c1084fabb0000f63';
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
export function checkOneoffPublicV2(prepared,final,ancestorRaw){
 assert.equal(createHash('sha256').update(ancestorRaw).digest('hex'),ANCESTOR_SHA);
 const ancestor=JSON.parse(ancestorRaw),a=ancestor.cleanup.snapshot;
 assert.equal(ancestor.status,'FAIL');assert.equal(ancestor.stage,'EXECUTE_2026-10-16');
 for(const k of ['containVerified','policiesRemoved','protectedRowsVerified'])assert.equal(ancestor.cleanup[k],true);
 assert.equal(ancestor.dayResults.length,1);assert.equal(ancestor.dayResults[0].readCalls,0);
 assert.equal(ancestor.dayResults[0].runId,null);assert.equal(a.newCount,2);
 assert.equal(a.newCatalog,'690faef6638482b0b123fc2ed5014061');
 assert.equal(prepared.sourceClosure.continuationReceiptSha256,ANCESTOR_SHA);
 assert.equal(prepared.before.newRows,0);
 for(const key of Object.keys(a))assert.deepEqual(prepared.before[key],a[key],'ancestor '+key);
 assert.equal(prepared.kind,'CAFE08_ONEOFF_RO_PREPARED');assert.equal(prepared.status,'PASS');
 assert.equal(final.kind,'CAFE08_ONEOFF_FINAL');assert.equal(final.status,'PASS');
 assert.equal(final.outcomeUncertain,false);assert.equal(final.automaticRetry,false);
 assert.equal(final.rawValuesReturned,0);
 const b=prepared.before,c=final.cleanup,s=c.snapshot;
 for(const k of ['containCommitted','containVerified','policiesRemoved','protectedRowsVerified','environmentAndStoppedImageUnchanged'])assert.equal(c[k],true);
 for(const k of ['protected','catalog','oldPolicies','oldGrants','defaultAcl','storage','controls','role','migrationLedgers','connectionImmutable','policy'])assert.deepEqual(s[k],b[k],k);
 for(const v of [b,s]){
  assert.equal(v.oldCount,68);assert.equal(v.oldForced,68);assert.equal(v.oldGrantCount,256);
  assert.equal(v.heldGrants,0);assert.equal(v.memberships,0);assert.equal(v.unsafeRole,false);
  assert.equal(v.login,false);assert.equal(v.enabled,false);assert.equal(v.otherEnabled,0);
  assert.equal(v.backends,0);assert.equal(v.leases,0);assert.equal(v.operator,1);
  assert.equal(v.newGrants,0);assert.equal(v.newPolicies,0);assert.equal(v.newNonownerGrants,0);
  assert.equal(v.controls.stopped,true);assert.equal(v.controls.paused,3);
  assert.equal(v.controls.jobs,149);assert.equal(v.controls.activeJobs,0);
 }
 assert.equal(b.newCount,2);assert.equal(b.newForced,2);assert.equal(b.ownRuns,0);
 assert.equal(b.existingApiRows,0);assert.equal(s.newCount,2);assert.equal(s.newForced,2);
 assert.equal(s.fkExact,1);assert.equal(s.ownRuns,2);
 assert.equal(prepared.sourceClosure.runtimeSourceSha256,SOURCE);
 assert.equal(prepared.sourceClosure.runtimeFiles,495);assert.equal(prepared.sourceClosure.migrations,52);
 assert.equal(final.dayResults.length,2);
 const seenRuns=new Set();let gets=0,bytes=0;
 const summaries=DAYS.map(day=>{
  const matches=final.dayResults.filter(v=>v.day===day);assert.equal(matches.length,1);
  const d=matches[0],r=d.read,o=d.observation,p=d.publication;
  assert.equal(d.kind,'CAFE08_ONEOFF_CHILD_RESULT');assert.equal(d.status,'PASS');
  assert.equal(d.operationKey,OP);assert.equal(d.requestKey,`phase10-${OP}-${day}`);
  assert.match(d.runId,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  assert(!seenRuns.has(d.runId));seenRuns.add(d.runId);
  assert.equal(d.providerTokenPosts,0);assert.equal(d.oldCheckpointAccessed,false);
  assert.equal(d.policyMutationRequested,false);assert.equal(d.rawValuesReturned,0);
  assert.equal(o.baselineEstablished,true);assert.equal(o.continuityRestored,false);
  assert.equal(o.snapshotComplete,false);assert.equal(o.comparisonBoundary,'NEW_EPOCH_NO_V1_COMPARISON');
  for(const k of ['completeTwoPass','canonicalTwoPassExact','responseBytesKnown'])assert.equal(r[k],true);
  for(const k of ['automaticRetry','automaticRefresh','rawStored'])assert.equal(r[k],false);
  assert.equal(r.pendingTransfers,0);assert.equal(r.countRequests,2);
  assert(Number.isSafeInteger(r.orderCount)&&r.orderCount>=0&&r.orderCount<=500);
  assert(Number.isSafeInteger(r.lineCount)&&r.lineCount>=0&&r.lineCount<=10000);
  assert.equal(r.orderCount,o.observedOrders);assert.equal(r.itemRequests,r.orderCount*2);
  assert.equal(r.listRequests,2*(Math.floor(r.orderCount/100)+1));
  assert.equal(r.providerRequests,r.countRequests+r.listRequests+r.itemRequests);
  assert.equal(r.versionVerifiedResponses,r.providerRequests);
  assert.equal(Object.keys(r.unapprovedCodes).length,0);
  assert(Object.keys(r.statusCodes).every(code=>APPROVED.has(code)));
  assert(Number.isSafeInteger(r.responseBytes)&&r.responseBytes>=0);
  assert.equal(d.readCalls,r.providerRequests);assert.equal(d.responseBytes,r.responseBytes);
  gets+=r.providerRequests;bytes+=r.responseBytes;
  assert.equal(d.cumulativeRequests,gets);assert.equal(d.cumulativeResponseBytes,bytes);
  for(const k of ['runSucceeded','unitSucceeded','exactLastSuccessRun','policyMd5Unchanged','canonicalTwoPassExact','storedValuesExact','currentLinksExact'])assert.equal(p[k],true);
  assert.equal(p.newManualRuns,1);assert.equal(p.policyVersion,5);assert.equal(p.primarySource,'CSV');
  for(const k of ['publishedLines','coverageRows','lineCount','versionCount','currentLinkCount'])assert.equal(p[k],r.lineCount);
  assert.equal(p.publishedAudits,1);assert.match(p.persistedSha256,/^[a-f0-9]{64}$/);
  return {day,orders:r.orderCount,lines:r.lineCount,providerGets:r.providerRequests,responseBytes:r.responseBytes};
 });
 assert(gets<=2050&&bytes<=67108864);
 assert.equal(s.existingApiRows,summaries.reduce((n,d)=>n+d.lines*2,0));
 assert.equal(s.newRows,summaries.reduce((n,d)=>n+d.orders,0)+2);
 return {summaries,gets,bytes,orders:summaries.reduce((n,d)=>n+d.orders,0),lines:summaries.reduce((n,d)=>n+d.lines,0)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [root,preparedName,finalName,destination]=process.argv.slice(2);
 assert.match(root??'',/^C:\/Users\/seong\/AppData\/Local\/MetaAdsPhase10Evaluation\/continuation-20261021\/cafe-oneoff-controller-v[1-9][0-9]*$/);
 for(const n of [preparedName,finalName])assert.match(n??'',/^[a-z0-9-]+\.json$/);
 assert.match(destination??'',/^C:\/Users\/seong\/AppData\/Local\/MetaAdsPhase10Evaluation\/independent\/resume-20261021\/[a-z0-9-]+\.json$/);
 const inputs=[root+'/'+preparedName,root+'/'+finalName,ANCESTOR_PATH],prepared=read(inputs[0]),final=read(inputs[1]);
 const calculation=checkOneoffPublicV2(prepared,final,readFileSync(ANCESTOR_PATH)),pins=Object.entries(prepared.pins).map(([name,value])=>{
  assert.match(name,/^[a-z0-9.-]+\.(?:ps1|mjs)$/);assert.match(value,/^[a-f0-9]{64}$/);
  const file=path.resolve('scripts/cloud/daily-data-sync',name);assert.equal(sha(file),value);
  return{name,sha256:value};
 });
 const proof={kind:'INDEPENDENT_ONEOFF_CONTINUATION_PUBLIC_RESULT_AND_PRESERVATION_AUDIT',status:'PASS_PUBLIC_RECEIPTS_AND_SOURCE_BINDING',at:new Date().toISOString(),inputs:inputs.map(file=>({path:file,sha256:sha(file)})),pins,...calculation,
  adoptedExisting52FromSha256:ANCESTOR_SHA,initialEpochRows:0,finalEpochRows:final.cleanup.snapshot.newRows,originalScheduledRunsAndCheckpointsPreservedByParentDigest:true,csvPrimaryVersion:5,newManualRuns:2,newEpochDays:2,
  finalRuntimeLogin:false,finalRuntimeBackends:0,newTableGrants:0,newTablePolicies:0,originalFourHeldGrants:0,
  normalSchedulerResumed:false,oldV1ContinuityRestored:false,sourceHostManualScript:true,productionImageActivated:false,
  independentProviderRequests:0,independentRemoteOrSqlOrDpapi:false,
  limitations:['Public receipt/hash arithmetic and source binding, not an independent raw database query','Protected digest intentionally permits the two selected coverage rows, exact owned new-run records and target lease/connection control metadata','Additive52 SQL leaves original migration ledgers unchanged; normal migrate-deploy convergence is not claimed','Explicit MANUAL recovery preserves original failed scheduled runs and expired checkpoint; it does not resume or rewrite them']};
 writeFileSync(destination,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:proof.status,path:destination,sha256:sha(destination),...calculation}));
}
