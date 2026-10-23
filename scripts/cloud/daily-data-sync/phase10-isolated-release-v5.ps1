param([Parameter(Mandatory)][ValidateSet('SwitchCandidate','Submit','Status','Verify','RestoreConfig','RestoreImage','RestoreVerify')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/evidence'
$private='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/phase10-release-before-20261019.dpapi'
$scope=@{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
$old='004241ae-ff50-4d0c-b179-3663448bb378';$failed='da217f17-e7b5-48ca-bc17-f8ced5c9e16e'
$commit='f7c7a0232b6c94c1fcce2cc4f6b78b2792712950';$source='68d245c1980c33b5e71dd3c52cd0f7000c30faee8ed90f6bb369fc430bb7ff6c'
$stage='START';$submitted=$false;$backup=$null;$v=$null;$headers=$null
# Import reviewed definitions, never the earlier release entrypoint or receipts.
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'phase10-isolated-release.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'DEFINITION_PARSE'}
foreach($name in @('Hash-Value','Variables-Digest','Live-State','Check-No-Lease','Read-Backup','Assert-Current-Variables')){
 $fn=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name})
 if($fn.Count -ne 1){throw 'DEFINITION_MISSING'}
 $parameters=($fn[0].Parameters|Where-Object {$null -ne $_}|ForEach-Object {$_.Extent.Text}) -join ',';$body=$fn[0].Body.Extent.Text.Substring(1,$fn[0].Body.Extent.Text.Length-2)
 Set-Item -LiteralPath ('function:script:'+$name) -Value ([scriptblock]::Create("param($parameters)`n"+$body))
}
function Save-V5($value,[string]$name){$path=Join-Path $root ('v5-'+$name+'.json');$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Depth 20));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}
function Assert-Old-Active($state){$active=@($state.serviceInstance.activeDeployments);if($active.Count -ne 1 -or $active[0].id -cne $failed -or $active[0].status -cnotin @('SUCCESS','SLEEPING')){throw 'OLD_ACTIVE_IDENTITY'}}
try {
 $stage='LIVE_READ';$live=Live-State;$v=$live.variables;$d=$live.serviceInstance.latestDeployment
 if($Mode -ceq 'Status'){@{kind='PHASE10_V5_STATUS';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$d.id;status=$d.status;imageDigest=$(if($d.meta.ContainsKey('imageDigest')){$d.meta.imageDigest}else{$null});active=@($live.serviceInstance.activeDeployments);releaseSha=$v.RELEASE_GIT_SHA;sourceSha=$v.PHASE08_SOURCE_CONTENT_SHA256;writes=0}|ConvertTo-Json -Depth 10;exit 0}
 if($Mode -cin @('SwitchCandidate','Submit','RestoreConfig','RestoreImage') -and [DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-19T12:00:00Z'){throw 'SESSION_WINDOW'}
 $backup=Read-Backup
 if($Mode -ceq 'SwitchCandidate'){
  $stage='FAILED_CANDIDATE_EXACT_STATE';Check-No-Lease;Assert-Old-Active $live
  if($d.id -cne $failed -or $d.status -cnotin @('SUCCESS','SLEEPING') -or $v.Count -ne $backup.variables.Count){throw 'FAILED_CANDIDATE'}
  foreach($name in $backup.variables.Keys){$wanted=if($name -ceq 'RELEASE_GIT_SHA'){'acbda3d65cff713650d317fa40e74764af46d2c0'}elseif($name -ceq 'PHASE08_SOURCE_CONTENT_SHA256'){'16d8fbd10b357847b7a1666762f2196b850e394bc0cdee6d15df68075c7a2743'}else{$backup.variables[$name]};if($v[$name] -cne $wanted){throw 'CONCURRENT_VARIABLE_CHANGE'}}
  Save-V5 @{kind='PHASE10_NEW_CANDIDATE_SWITCH_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');failedDeployment=$failed;activePreserved=$old;commit=$commit;sourceSha=$source;changedNames=@('RELEASE_GIT_SHA','PHASE08_SOURCE_CONTENT_SHA256')} 'switch-attempt'
  $stage='TWO_VARIABLE_SWITCH';$submitted=$true;$reply=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$scope.p;environmentId=$scope.e;serviceId=$scope.s;replace=$false;skipDeploys=$true;variables=@{RELEASE_GIT_SHA=$commit;PHASE08_SOURCE_CONTENT_SHA256=$source}}}
  if($reply.variableCollectionUpsert -cne $true){throw 'OUTCOME_UNKNOWN'}
  $fresh=Live-State;Assert-Current-Variables $fresh.variables $backup.variables $true;Assert-Old-Active $fresh
  Save-V5 @{kind='PHASE10_NEW_CANDIDATE_SWITCH_VERIFIED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');commit=$commit;sourceSha=$source;otherVariablesPreserved=99;providerRequests=0;databaseWrites=0} 'switched'
 } elseif($Mode -ceq 'Submit'){
  $stage='SOURCE_AND_ACTIVE_GUARDS';Assert-Current-Variables $v $backup.variables $true;Check-No-Lease;Assert-Old-Active $live
  if($d.id -cne $failed -or $d.status -cnotin @('SUCCESS','SLEEPING') -or -not (Test-Path -LiteralPath (Join-Path $root 'v5-switched.json'))){throw 'SUBMISSION_BASELINE'}
  $upload='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/upload-v5';$proof=[IO.File]::ReadAllText((Join-Path $root 'upload-v5-verified.json'))|ConvertFrom-Json -AsHashtable -Depth 15
  if($proof.commit -cne $commit -or $proof.sourceContentSha256 -cne $source -or $proof.fileCount -ne 491){throw 'UPLOAD_IDENTITY'}
  foreach($entry in $proof.files){$item=Get-Item -LiteralPath (Join-Path $upload $entry.name);if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne $entry.size -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256){throw 'UPLOAD_BYTES'}}
  if(@(Get-ChildItem -LiteralPath $upload -Recurse -Force -File).Count -ne 491){throw 'UPLOAD_EXTRA_FILES'}
  Save-V5 @{kind='PHASE10_V5_DEPLOY_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');commit=$commit;sourceSha=$source;scope=$scope;uploadFiles=491} 'submit-attempt'
  $stage='SINGLE_CLI_UPLOAD';$submitted=$true
  & 'C:/Users/seong/AppData/Local/npm-cache/_npx/79fa66f96c8fdacf/node_modules/@railway/cli/bin/railway.exe' up $upload --path-as-root --project $scope.p --environment $scope.e --service $scope.s --detach --json --message 'phase10 reviewed candidate f7c7a023' *> (Join-Path $root 'railway-submit-v5.log')
  $code=$LASTEXITCODE;$fresh=Live-State
  Save-V5 @{kind='PHASE10_V5_DEPLOY_SUBMITTED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$fresh.serviceInstance.latestDeployment.id;status=$fresh.serviceInstance.latestDeployment.status;cliExitCode=$code;outcomeUncertain=($code -ne 0);retryPerformed=$false;commit=$commit;sourceSha=$source} 'submitted'
  if($code -ne 0){throw 'CLI_OUTCOME_UNKNOWN'}
 } elseif($Mode -cin @('Verify','RestoreVerify')){
  $stage='IMAGE_CONFIG_IDENTITY';$restoring=$Mode -ceq 'RestoreVerify';Assert-Current-Variables $v $backup.variables (-not $restoring)
  $active=@($live.serviceInstance.activeDeployments)
  if($d.status -cnotin @('SUCCESS','SLEEPING') -or $active.Count -ne 1 -or $active[0].id -cne $d.id -or $d.meta.imageDigest -cnotmatch '^sha256:[a-f0-9]{64}$'){throw 'ACTIVE_IMAGE'}
  if($restoring -and $d.meta.imageDigest -cne $backup.imageDigest){throw 'RESTORE_IMAGE_MISMATCH'}
  if((Hash-Value $d.meta.serviceManifest.deploy) -cne $backup.deployHash){throw 'DEPLOY_CONFIG_DRIFT'}
  $stage='PROTECTED_READY';$headers=@{'x-internal-probe-token'=$v.INTERNAL_PROBE_TOKEN};$sw=[Diagnostics.Stopwatch]::StartNew()
  $response=Invoke-WebRequest -Uri ($v.PHASE08_VERIFIED_ORIGIN+'/backend-api/health/ready') -Headers $headers -MaximumRedirection 0 -TimeoutSec 60 -SkipHttpErrorCheck;$sw.Stop()
  if([int]$response.StatusCode -ne 200){throw 'READY_HTTP'};$body=$response.Content|ConvertFrom-Json -AsHashtable
  if($body.status -cne 'ready' -or $body.releaseId -cne $v.RELEASE_GIT_SHA -or $body.runtimeConfigFingerprint -cnotmatch '^[a-f0-9]{64}$'){throw 'READY_IDENTITY'}
  $out=@{kind='PHASE10_V5_DEPLOYMENT_VERIFIED';restored=$restoring;observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$d.id;imageDigest=$d.meta.imageDigest;releaseSha=$body.releaseId;sourceSha=$v.PHASE08_SOURCE_CONTENT_SHA256;runtimeConfigFingerprint=$body.runtimeConfigFingerprint;readyStatus=200;readyElapsedMs=$sw.ElapsedMilliseconds;resourceConfigurationPreserved=$true;providerRequests=0;productionWrites=0}
  Save-V5 $out $(if($restoring){'restored-verified'}else{'candidate-verified'});$out|ConvertTo-Json
 } elseif($Mode -ceq 'RestoreConfig'){
  Assert-Current-Variables $v $backup.variables $true;Check-No-Lease
  Save-V5 @{kind='PHASE10_V5_RESTORE_CONFIG_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');currentDeployment=$d.id;restoreNames=@('RELEASE_GIT_SHA','PHASE08_SOURCE_CONTENT_SHA256')} 'restore-config-attempt'
  $submitted=$true;$reply=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$scope.p;environmentId=$scope.e;serviceId=$scope.s;replace=$false;skipDeploys=$true;variables=@{RELEASE_GIT_SHA=$backup.variables.RELEASE_GIT_SHA;PHASE08_SOURCE_CONTENT_SHA256=$backup.variables.PHASE08_SOURCE_CONTENT_SHA256}}}
  if($reply.variableCollectionUpsert -cne $true){throw 'RESTORE_OUTCOME_UNKNOWN'};$fresh=Live-State;Assert-Current-Variables $fresh.variables $backup.variables $false
  Save-V5 @{kind='PHASE10_ORIGINAL_ALL_VARIABLES_MATCH';observedAt=[DateTimeOffset]::UtcNow.ToString('o');variableCount=$v.Count;allVariablesExactMatch=$true;changedVariables=2;credentialOverwrite=0} 'config-restored'
 } elseif($Mode -ceq 'RestoreImage'){
  Assert-Current-Variables $v $backup.variables $false;Check-No-Lease
  if(-not (Test-Path -LiteralPath (Join-Path $root 'v5-config-restored.json'))){throw 'RESTORE_CONFIG_FIRST'}
  Save-V5 @{kind='PHASE10_OLD_IMAGE_RESTORE_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');previousDeploymentId=$old;imageDigest=$backup.imageDigest;buildRequested=$false} 'restore-image-attempt'
  $submitted=$true;$reply=Invoke-Phase08SchedulerGraph 'mutation($id:String!){deploymentRedeploy(id:$id,usePreviousImageTag:true){id}}' @{id=$old}
  if($reply.deploymentRedeploy.id -cnotmatch '^[a-f0-9-]{36}$'){throw 'RESTORE_OUTCOME_UNKNOWN'}
  Save-V5 @{kind='PHASE10_OLD_IMAGE_RESTORE_SUBMITTED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$reply.deploymentRedeploy.id;mutationCalls=1;buildRequested=$false} 'restore-submitted'
 }
 if($Mode -cnotin @('Verify','RestoreVerify')){@{kind='PHASE10_V5_ACTION_COMPLETED';mode=$Mode;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json}
}catch{@{kind='PHASE10_V5_ACTION_REJECTED';mode=$Mode;stage=$stage;errorType=$_.Exception.GetType().Name;errorId=$_.FullyQualifiedErrorId;line=$_.InvocationInfo.ScriptLineNumber;outcomeUncertain=$submitted;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally{if($headers){$headers.Clear()};$headers=$null;$backup=$null;$v=$null;$live=$null;$fresh=$null;$response=$null;$reply=$null}
