// Public evidence only. Never reads protected inputs, database files or credentials.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const read=file=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const days=['2026-10-16','2026-10-17'];
const approved=new Set(['C40','C47','C48','E00','N00','N20','N30','N40','R00','R30','R40']);
export function checkPublicLiveResult(result,dayProofs){
  assert.equal(result.status,'PASS');assert.equal(result.localOnly,true);
  assert.equal(result.remoteWrites,0);assert.equal(result.originalRunChanged,false);
  assert.equal(result.checkpointResumed,false);assert.equal(result.oldV1ContinuityRestored,false);
  assert.equal(result.postgresStopExit,0);assert.equal(result.localObservationCommits,2);
  assert.equal(result.localCanonicalCompletedRuns,4);assert.equal(result.days.length,2);
  const summaries=days.map(day=>{
    const matches=result.days.filter(value=>value.day===day);assert.equal(matches.length,1);
    const item=matches[0],read=item.read,obs=item.observation;
    assert.equal(item.status,'PASS');assert.equal(item.realFoundationAndWriter,true);
    assert.equal(item.localFreshManualRuns,2);assert.equal(item.csvPrimaryPolicyVersion,5);
    assert.equal(item.apiShadowOnly,true);assert.equal(item.identicalReplayNoDuplicate,true);
    assert.equal(item.activeLeaseBlockedUntilAfterObservation,true);assert.equal(item.observationOldV1Rows,0);
    assert.equal(obs.baselineEstablished,true);assert.equal(obs.continuityRestored,false);
    assert.equal(obs.snapshotComplete,false);assert.equal(obs.comparisonBoundary,'NEW_EPOCH_NO_V1_COMPARISON');
    assert.equal(read.completeTwoPass,true);assert.equal(read.canonicalTwoPassExact,true);
    assert.equal(read.pendingTransfers,0);assert.equal(read.responseBytesKnown,true);
    assert.equal(read.automaticRetry,false);assert.equal(read.automaticRefresh,false);
    assert.equal(read.rawStored,false);assert.equal(read.countRequests,2);
    assert(Number.isSafeInteger(read.orderCount)&&read.orderCount>=0&&read.orderCount<=500);
    assert(Number.isSafeInteger(item.normalizedLineCount)&&item.normalizedLineCount>=read.orderCount&&item.normalizedLineCount<=10000);
    assert.equal(read.orderCount,obs.observedOrders);assert.equal(read.lineCount,item.normalizedLineCount);
    assert.equal(obs.newEpochBaselineOrders,read.orderCount);
    assert.equal(read.itemRequests,read.orderCount*2);
    assert.equal(read.listRequests,2*(Math.floor(read.orderCount/100)+1));
    assert.equal(read.providerRequests,read.countRequests+read.listRequests+read.itemRequests);
    assert.equal(read.versionVerifiedResponses,read.providerRequests);
    assert(Number.isSafeInteger(read.responseBytes)&&read.responseBytes>=0);
    assert.equal(Object.keys(read.unapprovedCodes).length,0);
    assert(Object.keys(read.statusCodes).every(code=>approved.has(code)));
    const standalone=dayProofs.find(value=>value.day===day);assert(standalone);
    assert.deepEqual(standalone.read,read);assert.deepEqual(standalone.observation,obs);
    assert.equal(standalone.preservation.whole68Unchanged,true);
    assert.equal(standalone.normalizedInput.sha256,result.privateNormalizedInputs[day].sha256);
    assert.equal(standalone.normalizedInput.bytes,result.privateNormalizedInputs[day].bytes);
    return {day,orders:read.orderCount,lines:item.normalizedLineCount,providerGets:read.providerRequests,responseBytes:read.responseBytes};
  });
  assert.equal(result.providerRequests,summaries.reduce((sum,row)=>sum+row.providerGets,0));
  assert.equal(result.responseBytes,summaries.reduce((sum,row)=>sum+row.responseBytes,0));
  assert(result.providerRequests<=2050&&result.responseBytes<=67108864);
  assert.equal(result.localRls.tables,70);assert.equal(result.localRls.force,70);
  assert.equal(result.localRls.runtimeBypass,false);assert.equal(result.localRls.connectionLimit,3);
  assert.equal(result.localRls.initialNewTableNonownerGrants,0);assert.equal(result.localRls.fixturePermissionsOnly,true);
  assert.equal(result.remotePreservation.whole68Unchanged,true);
  assert.equal(result.remotePreservation.environmentUnchanged,true);assert.equal(result.remotePreservation.holdsUnchanged,true);
  assert.equal(result.privacy.privateTreeUserSystemOnly,true);assert.equal(result.privacy.ownedPostmasterAbsent,true);
  assert.equal(result.privacy.passwordFileAbsent,true);
  return summaries;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=process.argv[2],destination=process.argv[3];
  assert.match(root??'',/^C:\/Users\/seong\/AppData\/Local\/MetaAdsPhase10Evaluation\/cafe-epoch-live-20261021-v[1-9][0-9]*$/);
  assert.match(destination??'',/^C:\/Users\/seong\/AppData\/Local\/MetaAdsPhase10Evaluation\/independent\/resume-20261021\/[a-z0-9-]+\.json$/);
  const resultPath=root+'/result.json',dayPaths=days.map(day=>root+'/day-'+day+'.json');
  const result=read(resultPath),summaries=checkPublicLiveResult(result,dayPaths.map(read));
  const sourcePins=Object.entries(result.sourcePins).map(([name,expected])=>{
    assert.match(name,/^phase10-cafe-epoch-live-[a-z0-9-]+\.m?js$|^phase10-cafe-epoch-live-[a-z0-9-]+\.ps1$/);
    const file=path.resolve('scripts/cloud/daily-data-sync',name);assert.equal(sha(file),expected);
    return {path:file.replaceAll('\\','/'),sha256:expected};
  });
  const supportingPins=Object.entries(result.supportingPins).map(([name,expected])=>{
    assert(['phase10-cafe-epoch-eval-v3-native-20261020.mjs','phase10-cafe-live-input-local-20261020.mjs'].includes(name));
    const file=path.resolve('scripts/cloud/daily-data-sync',name);assert.equal(sha(file),expected);
    return {path:file.replaceAll('\\','/'),sha256:expected};
  });
  assert.equal(sourcePins.length,3);assert.equal(supportingPins.length,2);
  const {sourcePins:apiSourcePins}=await import('./phase10-cafe-epoch-eval-v3-native-20261020.mjs');
  const api=apiSourcePins();assert.equal(api.sha256,result.apiSourceSha256);
  assert.equal(api.sha256,'cb07068c268931053861ec770c4168470bf36a594c105270a26d0961c214aa74');
  const proof={kind:'INDEPENDENT_PUBLIC_LIVE_EPOCH_RESULT_RECALCULATION',status:'PASS_PUBLIC_RECEIPTS_AND_SOURCE_BINDING',
    at:new Date().toISOString(),inputs:[resultPath,...dayPaths].map(file=>({path:file,sha256:sha(file)})),sourcePins,supportingPins,
    apiSource:{files:api.rows.length,sha256:api.sha256,fullRuntimeCandidateSource:false},
    summaries,totalGets:result.providerRequests,totalBytes:result.responseBytes,localObservationCommits:2,localManualRuns:4,
    remoteEpochActivation:false,remoteCanonicalPublication:false,independentSqlOrDpapi:false,
    limitations:['Arithmetic, cross-receipt and executed-source assertions reviewed; no independent DB query','Real provider GET and local native assertions are root execution evidence','Source-host evaluation, not immutable image execution or normal scheduler activation']};
  writeFileSync(destination,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:proof.status,path:destination,sha256:sha(destination),summaries}));
}
