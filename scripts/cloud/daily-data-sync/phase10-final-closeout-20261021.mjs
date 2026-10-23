import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation',R=E+'/continuation-20261021',I=E+'/independent/resume-20261021';
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const output=R+'/final-closeout.json';
try{
 assert(!existsSync(output));
 const result=read(R+'/cafe-oneoff-controller-v6/execute-d-result.json');assert.equal(result.status,'PASS');assert.equal(result.outcomeUncertain,false);
 for(const k of ['containCommitted','containVerified','policiesRemoved','protectedRowsVerified','environmentAndStoppedImageUnchanged'])assert.equal(result.cleanup[k],true);
 const inspect=read(R+'/cafe-oneoff-controller-v6/final-d-inspect.json');assert.equal(inspect.status,'INSPECTED');assert.deepEqual(inspect.snapshot,result.cleanup.snapshot);assert.equal(inspect.variablesUnchanged,true);
 const audit=read(I+'/oneoff-continuation-actual-public-audit-v2.json');assert.equal(audit.status,'PASS_PUBLIC_RECEIPTS_AND_SOURCE_BINDING');assert.equal(audit.newManualRuns,2);assert.equal(audit.newEpochDays,2);
 assert.deepEqual(audit.inputs.map(x=>x.path),[R+'/cafe-oneoff-controller-v6/prepared-d-prepared.json',R+'/cafe-oneoff-controller-v6/execute-d-result.json',R+'/cafe-oneoff-controller-v5/execute-c-result.json']);for(const f of audit.inputs)assert.equal(sha(f.path),f.sha256);
 const freshAudit=read(I+'/oneoff-fresh-inspection-public-audit-v1.json');assert.equal(freshAudit.status,'PASS_PUBLIC_RECEIPT_SNAPSHOT_COMPARISON');
 const source=read(R+'/final-source-after-oneoff.json');assert.equal(source.status,'PASS');assert.equal(source.filesMatchedCandidateAndWorkspace,495);assert.equal(source.staged,0);assert.equal(source.deleted,240);assert.equal(source.candidateRelease,'a49bec345f995ec71f25f9e569caa5fe20578235');assert.equal(source.candidateSource,'70a7c8cd00c2dd592f632dd35312e283011ef648c5926b5aac4273edb8cea6f2');assert.equal(source.migrationCount,52);
 const local=read(R+'/final-local-state.json');assert.equal(local.status,'PASS');assert.equal(local.allFourNativePortsListeners,0);assert.equal(local.dockerDesktopProcesses,0);assert.equal(local.dockerBackendProcesses,0);
 const cleanup=read(R+'/final-local-cleanup.json');assert.equal(cleanup.status,'PASS');assert.equal(cleanup.runningContainersBefore,0);assert.equal(cleanup.forceKilledProcesses,0);assert.equal(cleanup.containersImagesVolumesOrFilesDeleted,0);
 const storage=read(R+'/storage-readonly-recheck-v2.json');assert.equal(storage.status,'READ_CACHE_RESIDUAL_STILL_PRESENT');assert.equal(storage.all68Preserved,true);assert.equal(storage.newEpochRowCountPreserved,true);assert.equal(storage.storageMutations,0);assert.equal(storage.sharedCredentialChanges,0);assert.equal(storage.purgeRequests,0);
 const scan=read(R+'/resume-20261021-secret-scan-v3.json');assert.equal(scan.status,'PASS');assert.equal(scan.literalMatches,0);assert.equal(scan.patternMatches,0);assert.equal(scan.privateAcl.currentUserAndSystemOnly,true);assert.equal(scan.privateBackupRollbackEligibilityFlagsFalse,true);
 const files=[
 R+'/cafe-oneoff-controller-v6/prepared-d-prepared.json',R+'/cafe-oneoff-controller-v6/execute-d-result.json',R+'/cafe-oneoff-controller-v6/final-d-inspect.json',
 I+'/oneoff-continuation-actual-public-audit-v2.json',I+'/oneoff-fresh-inspection-public-audit-v1.json',I+'/cafe-oneoff-controller-v6/review.json',I+'/cafe-oneoff-executor-v3/review.json',
 E+'/cafe-recovery-20261021-v1/verified-verify.json',I+'/cafe-renew-v1/actual-public-audit-v1.json',
 I+'/live-actual-qualified-audit-v1.json',I+'/live-native-v4-driver-public-audit-v1.json',R+'/live-native-v4-driver-pass.json',
 R+'/storage-readonly-recheck-v1.json',R+'/storage-readonly-recheck-v2.json',R+'/supabase-quota-read-v1/handoff.json',I+'/meta-lifecycle-runbook-v1.json',
 R+'/final-source-after-oneoff.json',R+'/final-local-state.json',R+'/final-local-state-first-failure.json',R+'/final-local-cleanup.json',R+'/resume-20261021-secret-scan-v2.json',R+'/resume-20261021-secret-scan-v3.json',
 E+'/continuation-20261020/c7-epoch-final-binding.json',
 ];
 const docs=['10_배포전통합검증.md','진행표.md','records/10_결과.md','records/10_배포판정.md','records/10_배포명세.md','records/10_비밀노출사고_20261019.md','records/10_후속검증_20261020.md','records/10_추가실검증_20261021.md'].map(p=>'C:/Users/seong/Desktop/workspace/Meta-Ads-Performance/docs/daily-data-automation/'+p);
 const proof={kind:'PHASE10_AUTHORIZED_ISOLATED_WORK_FINAL_CLOSEOUT',status:'AUTHORIZED_ISOLATED_WORK_COMPLETE_EXTERNAL_LIMITS_REMAIN',at:new Date().toISOString(),
  stage10OverallDecision:'NO_GO_FOR_OPERATIONS',operatingChanges:0,sharedCredentialChanges:0,stages11And12Started:false,existingFeatureFullRegressionExcluded:true,scheduleAndDateBoundaryEvidenceReusedFrom08:true,
  candidateRelease:source.candidateRelease,candidateSource:source.candidateSource,runtimeFiles:495,migrations:52,
  remoteManualRecovery:{days:audit.summaries,orders:audit.orders,lines:audit.lines,gets:audit.gets,responseBytes:audit.bytes,newRuns:2,newEpochDays:2,csvPrimaryVersion:5,originalFailedScheduledRunsAndExpiredCheckpointPreserved:true,oldV1ContinuityRestored:false},
  heldState:{forceRlsTables:70,normalActiveJobs:0,normalTotalJobs:149,pausedProviders:3,login:false,backends:0,leases:0,originalFourHeldGrants:0,newTableGrants:0,newTablePolicies:0,stoppedImageAndEnvironmentPreserved:true},
  performance:{reusedMixedGets:40,concurrency:4,errors:0,p95Ms:2847.49,criterionMs:5000,binding:'C6 measurement narrowed by verified C7 runtime byte equivalence; no fresh C7 cloud40 measurement'},
  localActualStartupWarningPreserved:true,syntheticStartupDriverCorrectionVerified:true,
  unresolved:[{item:'Shared original credentials and all consumer migration/revocation',reason:'Actual shared credential changes forbidden by user'},
   {item:'Old exact Storage URL CDN cache',reason:'Bare URL residual200, exact purge previouslyFeatureNotEnabled403; safe TTL unconfirmed; no paid/broad purge change'},
   {item:'Exact organization monthly consumption/cycle/remaining',reason:'Free plan and allowances verified; authenticated usage surface unavailable; null not zero'},
   {item:'Future normal operational deployment',reason:'Not authorized here; operating identity/Auth/Storage, start-command activation, migration baseline, current credential windows and least privilege restoration remain explicit deployment constraints'}],
  privacy:{selectedFiles:scan.approvedTextFiles,literalMatches:0,patternMatches:0,privateAclPaths:scan.privateAcl.pathsChecked,otherPrivatePrincipals:0,rollbackEligibilityFlagsFalse:true,transcriptErasureProven:false,onlySelectedLocalFilesCovered:true},
  evidence:files.map(path=>({path,sha256:sha(path)})),documents:docs.map(path=>({path,sha256:sha(path)})),rawValuesReturned:0};
 writeFileSync(output,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:proof.status,path:output,sha256:sha(output),remoteOrders:audit.orders,remoteLines:audit.lines,remoteGets:audit.gets,stage10OverallDecision:proof.stage10OverallDecision}));
}catch{console.log(JSON.stringify({status:'FAIL',rawErrorSuppressed:true,rawValuesReturned:0}));process.exitCode=1;}
