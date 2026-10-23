Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/phase10-cafe-pair-recovery-20261020.ps1"
$destination='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261020/reopened-final-hold-v2.json'
$expectedPath='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-recovery-20261020-v1/independent-readproof.json'
$approvalPath='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-c47-approval-20261020-v1/result.json'
$live=$null;$snapshot=$null;$expected=$null;$plan=$null;$approvalPlan=$null;$stage='START'
try{
 if(Test-Path -LiteralPath $destination){throw 'EVIDENCE_CONSUMED'}
 $expected=Get-Content -LiteralPath $expectedPath -Raw|ConvertFrom-Json -Depth 40 -DateKind String
 if($expected.status -cne 'PASS' -or $expected.unrelatedTablesPreserved -ne 65 -or $expected.exactSystemAuditAppended -ne 1){throw 'EXPECTED_POST_RENEWAL_BASELINE'}
 $stage='FRESH_FIXED_HELD';$live=Get-IncidentState;$snapshot=Get-IncidentSnapshot;Assert-CafeRecoveryHold $snapshot $live;Assert-CafeRecoveryDeploymentStopped
 if((Get-IncidentHash $snapshot.table_digests) -cne (Get-IncidentHash $expected.snapshot.table_digests)){throw 'AFTER_RENEWAL_TABLE_CHANGE'}
 $plan=Read-IncidentPrivate 'cafe08-recovery-plan-20261020-cafe08-read-recovery-a'
 $approval=Get-Content -LiteralPath $approvalPath -Raw|ConvertFrom-Json -AsHashtable -Depth 30 -DateKind String
 if($approval.kind -cne 'CAFE08_C47_PUBLIC_APPROVAL_VERIFIED' -or $approval.changedVariableCount -ne 1 -or $approval.addedCode -cne 'C47' -or $approval.newStatusCount -ne 11 -or $approval.allTenPreserved -cne $true -or $approval.secretsChanged -ne 0 -or $approval.deploymentStarted -cne $false -or $approval.whole68Unchanged -cne $true){throw 'C47_PROOF_SCOPE'}
 $approvalPlan=Read-IncidentPrivate 'cafe08-c47-approval-plan-20261020-cafe08-c47-approval-a'
 if($plan.eligibleSecretRollback -cne $false -or $approvalPlan.eligibleSecretRollback -cne $false -or $approvalPlan.operationKey -cne '20261020-cafe08-c47-approval-a' -or $approvalPlan.beforeVariableHash -cne $plan.variableHash -or (Get-IncidentVariableHash $live.variables) -cne $approvalPlan.expectedVariableHash -or (Get-CafeRecoveryControlsHash $snapshot) -cne $plan.beforeControlsHash -or $approvalPlan.controlsHash -cne $plan.beforeControlsHash){throw 'CONTROLS_OR_ENVIRONMENT_CHANGE'}
 $stage='FRESH_RESOURCES';$resources=Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstanceLimits(environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId numReplicas sleepApplication}}' @{e=$script:IncidentScope.e;s=$script:IncidentScope.s}
 if($resources.serviceInstanceLimits.containers.cpu -ne 1 -or $resources.serviceInstanceLimits.containers.memoryBytes -ne 1000000000 -or $resources.serviceInstance.numReplicas -ne 1 -or $resources.serviceInstance.sleepApplication -cne $true){throw 'RESOURCES_CHANGED'}
 $stage='FRESH_PRIVILEGE_AND_PROVIDER_HOLD';$held=@(Invoke-Phase08Management -Action Query -Query @'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT current_database() AS db,current_user AS principal,
 (SELECT count(*)::int FROM phase08_meta_ads.source_connections) AS connections,
 (SELECT count(*)::int FROM phase08_meta_ads.source_connections WHERE enabled) AS enabled,
 (SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints')) AS grants,
 (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='phase08_runtime') AS memberships,
 (SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication FROM pg_roles WHERE rolname='phase08_runtime') AS restricted;
ROLLBACK;
'@)
 if($held.Count -ne 1 -or $held[0].db -cne 'postgres' -or $held[0].principal -cne 'postgres' -or $held[0].connections -ne 3 -or $held[0].enabled -ne 0 -or $held[0].grants -ne 0 -or $held[0].memberships -ne 0 -or $held[0].restricted -cne $true){throw 'PRIVILEGE_HOLD_CHANGED'}
 $proof=@{kind='PHASE10_REOPENED_FINAL_FRESH_HELD_READPROOF';status='PASS_CONTAINMENT_WITH_EXTERNAL_RESIDUALS';at=[DateTimeOffset]::UtcNow.ToString('o');snapshot=$snapshot;securityDeployment='39c6b738-6d2f-4111-a97b-37f017b39886';deploymentStopped=$true;unstopped=0;all68EqualAfterIsolatedRenewal=$true;expectedPostRenewalProofSha256=(Get-FileHash -LiteralPath $expectedPath).Hash.ToLowerInvariant();c47ApprovalProofSha256=(Get-FileHash -LiteralPath $approvalPath).Hash.ToLowerInvariant();resources=@{cpu=1;memoryBytes=1000000000;replicas=1;sleep=$true;pool=3;heavy=1};sensitiveTableGrants=0;roleMemberships=0;restrictedRole=$true;providersOff=3;environmentUnchangedExceptVerifiedPublicC47List=$true;controlsUnchanged=$true;remoteMutations=0;providerCalls=0;appHttpCalls=0;sharedCredentialChanges=0;operatingChanges=0;normalResume=$false;incidentResolved=$false;stages11And12Started=$false;rawValuesReturned=0}
 $stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write([Text.Encoding]::UTF8.GetBytes(($proof|ConvertTo-Json -Depth 40)));$stream.Flush($true)}finally{$stream.Dispose()}
 @{status=$proof.status;all68EqualAfterIsolatedRenewal=$true;runtimeNoLoginBackend0Stopped=$true;sensitiveTableGrants=0;remoteMutations=0;rawValuesReturned=0;evidence=$destination}|ConvertTo-Json -Compress
}catch{@{status='FAIL';safeStage=$stage;rawErrorSuppressed=$true;remoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress;exit 1}
finally{$live=$null;$snapshot=$null;$expected=$null;$plan=$null;$approvalPlan=$null;$held=$null}
