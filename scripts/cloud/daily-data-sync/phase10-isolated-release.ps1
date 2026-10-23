param([Parameter(Mandatory)][ValidateSet('Prepare','Submit','Status','Verify','RestoreConfig','RestoreImage','RestoreVerify')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/evidence'
$private='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/phase10-release-before-20261019.dpapi'
$scope=@{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
$old='004241ae-ff50-4d0c-b179-3663448bb378';$oldSource='0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1'
$commit='9d9e47c3c64dc39bc240d2d2e323140656b9b471';$source='476287f1b1e62097c98660c421c199be1a21f911ed5ee8c874dcb9859b28dbb8'
$candidate='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261019-v3'
$stage='START';$submitted=$false;$live=$null;$backup=$null;$headers=$null
function Save-Evidence($value,[string]$name){
 $path=Join-Path $root ($name+'.json');$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Depth 25));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
}
function Read-Evidence([string]$name){return ([IO.File]::ReadAllText((Join-Path $root ($name+'.json')))|ConvertFrom-Json -AsHashtable -Depth 25 -DateKind String)}
function Hash-Value($value){$text=$value|ConvertTo-Json -Compress -Depth 30;return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()}
function Variables-Digest($vars){$ordered=[ordered]@{};foreach($k in @($vars.Keys|Sort-Object)){$ordered[$k]=$vars[$k]};return Hash-Value $ordered}
function Live-State {
 $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){project(id:$p){id environments{edges{node{id unmergedChangesCount}}}} variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status meta} activeDeployments{id status}}}' $scope
 $v=$r.variables;$svc=$r.serviceInstance
 if($r.project.id -cne $scope.p -or $svc.serviceId -cne $scope.s -or $svc.environmentId -cne $scope.e -or $svc.startCommand -cne 'node deploy/cloud/phase08-launch.mjs' -or $svc.sleepApplication -cne $true -or $v.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $v.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $v.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or $v.SUPABASE_STORAGE_BUCKET -cne 'meta-ads-phase08-isolated' -or $v.PRISMA_CONNECTION_LIMIT -cne '3' -or $v.HEAVY_OPERATION_CONCURRENCY -cne '1' -or $v.DAILY_SYNC_SCHEDULE_ENABLED -cne 'true'){throw 'TARGET'}
 $environment=@($r.project.environments.edges|Where-Object {$_.node.id -ceq $scope.e})
 if($environment.Count -ne 1 -or -not $environment[0].node.ContainsKey('unmergedChangesCount') -or ($null -ne $environment[0].node.unmergedChangesCount -and $environment[0].node.unmergedChangesCount -cne 0)){throw 'PENDING_ENVIRONMENT_CHANGE'}
 return $r
}
function Check-No-Lease {
 $rows=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT current_database() AS db,current_user AS principal,(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS leases,(SELECT count(*)::int FROM cron.job WHERE active) AS active,(SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) AS stopped;COMMIT;")
 if($rows.Count -ne 1 -or $rows[0].db -cne 'postgres' -or $rows[0].principal -cne 'postgres' -or $rows[0].leases -ne 0 -or $rows[0].active -ne 149 -or $rows[0].stopped -cne $false){throw 'DRAIN_STATE'}
}
function Read-Backup {
 Assert-Phase08PrivatePath -Path $private;$enc=[IO.File]::ReadAllBytes($private)
 try{$plain=[Security.Cryptography.ProtectedData]::Unprotect($enc,[Text.Encoding]::ASCII.GetBytes('Phase10Release20261019/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);return ([Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 30)}finally{[Array]::Clear($enc,0,$enc.Length);if($plain){[Array]::Clear($plain,0,$plain.Length)}}
}
function Assert-Current-Variables($vars,$before,[bool]$candidateConfig){
 if($vars.Count -ne $before.Count){throw 'VARIABLE_COUNT'}
 foreach($name in $before.Keys){$wanted=if($candidateConfig -and $name -ceq 'RELEASE_GIT_SHA'){$commit}elseif($candidateConfig -and $name -ceq 'PHASE08_SOURCE_CONTENT_SHA256'){$source}else{$before[$name]};if($vars[$name] -cne $wanted){throw 'CONCURRENT_VARIABLE_CHANGE'}}
}
try {
 $stage='LIVE_READ';$live=Live-State;$v=$live.variables;$d=$live.serviceInstance.latestDeployment
 if($Mode -ceq 'Status'){@{kind='PHASE10_ISOLATED_STATUS';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$d.id;status=$d.status;imageDigest=$(if($d.meta.ContainsKey('imageDigest')){$d.meta.imageDigest}else{$null});releaseSha=$v.RELEASE_GIT_SHA;sourceSha=$v.PHASE08_SOURCE_CONTENT_SHA256;writes=0}|ConvertTo-Json;exit 0}
 if($Mode -cin @('Prepare','Submit','RestoreConfig','RestoreImage') -and [DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-19T12:00:00Z'){throw 'SESSION_WINDOW_EXPIRED'}
 if($Mode -ceq 'Prepare') {
  $stage='BASELINE_GUARDS';Check-No-Lease
  if($d.id -cne $old -or $d.status -cnotin @('SUCCESS','SLEEPING') -or $v.PHASE08_SOURCE_CONTENT_SHA256 -cne $oldSource -or $v.RELEASE_GIT_SHA -cne '9e9a1f82bb02346575565b031a43e17e13758dc8' -or (Test-Path -LiteralPath $private)){throw 'BASELINE'}
  if(@($live.serviceInstance.activeDeployments).Count -ne 1 -or $live.serviceInstance.activeDeployments[0].id -cne $old){throw 'BASELINE_ACTIVE_DEPLOYMENTS'}
  $actual=(& git -C $candidate rev-parse HEAD).Trim();if($actual -cne $commit){throw 'COMMIT'}
  $manifest=[IO.File]::ReadAllText((Join-Path $candidate 'source-content-manifest.json'))|ConvertFrom-Json -AsHashtable -Depth 15
  if($manifest.sourceContentSha256 -cne $source -or $manifest.files.Count -ne 489){throw 'MANIFEST'}
  foreach($f in $manifest.files){if((Get-FileHash -LiteralPath (Join-Path $candidate $f.name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'FILE_DRIFT'}}
  $stage='PROTECTED_CURRENT_BACKUP';$plain=[Text.Encoding]::UTF8.GetBytes((@{scope=$scope;variables=$v;deploymentId=$d.id;imageDigest=$d.meta.imageDigest;deployHash=(Hash-Value $d.meta.serviceManifest.deploy)}|ConvertTo-Json -Compress -Depth 30))
  try{$enc=[Security.Cryptography.ProtectedData]::Protect($plain,[Text.Encoding]::ASCII.GetBytes('Phase10Release20261019/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);$stream=[IO.File]::Open($private,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($enc,0,$enc.Length)}finally{$stream.Dispose()};Set-Phase08NewPrivateAcl -Path $private}finally{if($plain){[Array]::Clear($plain,0,$plain.Length)};if($enc){[Array]::Clear($enc,0,$enc.Length)}}
  Save-Evidence @{kind='PHASE10_TWO_VARIABLE_UPDATE_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$old;changedNames=@('RELEASE_GIT_SHA','PHASE08_SOURCE_CONTENT_SHA256');candidateCommit=$commit;sourceSha=$source;beforeVariablesHash=(Variables-Digest $v);skipDeploys=$true} 'release-prepare-attempt'
  $stage='TWO_VARIABLE_UPDATE';$submitted=$true;$reply=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$scope.p;environmentId=$scope.e;serviceId=$scope.s;replace=$false;skipDeploys=$true;variables=@{RELEASE_GIT_SHA=$commit;PHASE08_SOURCE_CONTENT_SHA256=$source}}}
  if($reply.variableCollectionUpsert -cne $true){throw 'OUTCOME_UNKNOWN'}
  $fresh=Live-State;Assert-Current-Variables $fresh.variables $v $true
  if($fresh.serviceInstance.latestDeployment.id -cne $old){throw 'UNEXPECTED_DEPLOYMENT'}
  Save-Evidence @{kind='PHASE10_CANDIDATE_CONFIG_PREPARED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');changedVariables=2;otherVariablesPreserved=($v.Count-2);sourceSha=$source;candidateCommit=$commit;remoteDatabaseWrites=0;providerRequests=0;skipDeploys=$true} 'release-prepared'
 } elseif($Mode -ceq 'Submit') {
  $backup=Read-Backup;Assert-Current-Variables $v $backup.variables $true;Check-No-Lease
  if($d.id -cne $old){throw 'ALREADY_SUBMITTED_INSPECT_STATUS'}
  $null=Read-Evidence 'release-prepared'
  Save-Evidence @{kind='PHASE10_BUILD_DEPLOY_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');candidateCommit=$commit;sourceSha=$source;project=$scope.p;environment=$scope.e;service=$scope.s} 'release-submit-attempt'
  $stage='SINGLE_CLI_UPLOAD';$submitted=$true
  $upload='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/upload-v3'
  $stage='UPLOAD_CLOSURE';$proof=Read-Evidence 'upload-v3-verified'
  if($proof.commit -cne $commit -or $proof.sourceContentSha256 -cne $source -or $proof.fileCount -ne 491){throw 'UPLOAD_PROOF'}
  foreach($entry in $proof.files){if((Get-FileHash -LiteralPath (Join-Path $upload $entry.name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256){throw 'UPLOAD_FILE_DRIFT'}}
  $actualFiles=@(Get-ChildItem -LiteralPath $upload -Recurse -Force -File)
  if($actualFiles.Count -ne $proof.fileCount -or @($actualFiles|Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $_.Name -match '^\.env(?:\.|$)|\.(?:dpapi|key|pfx|dump|log)$'}).Count -gt 0){throw 'UPLOAD_CLOSURE'}
  $stage='SINGLE_CLI_UPLOAD'
  & 'C:/Users/seong/AppData/Local/npm-cache/_npx/79fa66f96c8fdacf/node_modules/@railway/cli/bin/railway.exe' up $upload --path-as-root --project $scope.p --environment $scope.e --service $scope.s --detach --json --message 'phase10 reviewed candidate 9d9e47c3' *> (Join-Path $root 'railway-submit.log')
  $code=$LASTEXITCODE
  $fresh=Live-State
  Save-Evidence @{kind='PHASE10_BUILD_DEPLOY_SUBMITTED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');cliExitCode=$code;deploymentId=$fresh.serviceInstance.latestDeployment.id;status=$fresh.serviceInstance.latestDeployment.status;candidateCommit=$commit;sourceSha=$source;outcomeUncertain=($code -ne 0);retryPerformed=$false} 'release-submitted'
  if($code -ne 0){throw 'CLI_OUTCOME_INSPECT_BEFORE_RETRY'}
 } elseif($Mode -cin @('Verify','RestoreVerify')) {
  $backup=Read-Backup;$restoring=$Mode -ceq 'RestoreVerify';Assert-Current-Variables $v $backup.variables (-not $restoring)
  if($d.status -cnotin @('SUCCESS','SLEEPING')){throw 'DEPLOYMENT_NOT_HEALTHY'}
  if(@($live.serviceInstance.activeDeployments).Count -ne 1 -or $live.serviceInstance.activeDeployments[0].id -cne $d.id){throw 'FINAL_ACTIVE_DEPLOYMENTS'}
  if(($restoring -and $d.meta.imageDigest -cne $backup.imageDigest) -or ((-not $restoring) -and $d.id -ceq $old)){throw 'IMAGE_IDENTITY'}
  if((Hash-Value $d.meta.serviceManifest.deploy) -cne $backup.deployHash){throw 'RESOURCE_CONFIG_DRIFT'}
  $stage='PROTECTED_READY';$headers=@{'x-internal-probe-token'=$v.INTERNAL_PROBE_TOKEN};$sw=[Diagnostics.Stopwatch]::StartNew()
  $response=Invoke-WebRequest -Uri ($v.PHASE08_VERIFIED_ORIGIN+'/backend-api/health/ready') -Headers $headers -MaximumRedirection 0 -TimeoutSec 60 -SkipHttpErrorCheck;$sw.Stop()
  if([int]$response.StatusCode -ne 200){throw 'READY_HTTP'};$body=$response.Content|ConvertFrom-Json -AsHashtable
  if($body.status -cne 'ready' -or $body.releaseId -cne $v.RELEASE_GIT_SHA -or $body.runtimeConfigFingerprint -cnotmatch '^[a-f0-9]{64}$'){throw 'READY_IDENTITY'}
  $out=@{kind='PHASE10_DEPLOYMENT_VERIFIED';restored=$restoring;observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$d.id;status=$d.status;imageDigest=$d.meta.imageDigest;releaseSha=$body.releaseId;sourceSha=$v.PHASE08_SOURCE_CONTENT_SHA256;runtimeConfigFingerprint=$body.runtimeConfigFingerprint;readyStatus=200;readyElapsedMs=$sw.ElapsedMilliseconds;resourceConfigurationPreserved=$true;providerRequests=0;productionWrites=0}
  Save-Evidence $out $(if($restoring){'release-restored-verified'}else{'release-candidate-verified'});$out|ConvertTo-Json
 } elseif($Mode -ceq 'RestoreConfig') {
  $backup=Read-Backup;Assert-Current-Variables $v $backup.variables $true;Check-No-Lease
  Save-Evidence @{kind='PHASE10_RESTORE_TWO_VARIABLES_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$d.id;currentVariablesHash=(Variables-Digest $v)} 'release-restore-config-attempt'
  $stage='RESTORE_ONLY_TWO';$submitted=$true;$reply=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$scope.p;environmentId=$scope.e;serviceId=$scope.s;replace=$false;skipDeploys=$true;variables=@{RELEASE_GIT_SHA=$backup.variables.RELEASE_GIT_SHA;PHASE08_SOURCE_CONTENT_SHA256=$backup.variables.PHASE08_SOURCE_CONTENT_SHA256}}}
  if($reply.variableCollectionUpsert -cne $true){throw 'RESTORE_UNKNOWN'}
  $fresh=Live-State;Assert-Current-Variables $fresh.variables $backup.variables $false
  Save-Evidence @{kind='PHASE10_ORIGINAL_VARIABLES_RESTORED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');variableCount=$v.Count;allVariablesExactMatch=$true;onlyTwoVariablesWritten=$true;credentialOverwrite=0} 'release-config-restored'
 } elseif($Mode -ceq 'RestoreImage') {
  $backup=Read-Backup;Assert-Current-Variables $v $backup.variables $false;Check-No-Lease;$null=Read-Evidence 'release-config-restored'
  Save-Evidence @{kind='PHASE10_OLD_IMAGE_RESTORE_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');oldDeploymentId=$old;imageDigest=$backup.imageDigest} 'release-restore-image-attempt'
  $stage='ONE_OLD_IMAGE_REDEPLOY';$submitted=$true;$reply=Invoke-Phase08SchedulerGraph 'mutation($id:String!){deploymentRedeploy(id:$id,usePreviousImageTag:true){id}}' @{id=$old}
  if($reply.deploymentRedeploy.id -cnotmatch '^[a-f0-9-]{36}$'){throw 'RESTORE_DEPLOY_UNKNOWN'}
  Save-Evidence @{kind='PHASE10_OLD_IMAGE_RESTORE_SUBMITTED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$reply.deploymentRedeploy.id;mutationCalls=1;buildRequested=$false} 'release-restore-submitted'
 }
 if($Mode -cnotin @('Verify','RestoreVerify')){@{kind='PHASE10_RELEASE_ACTION_COMPLETED';mode=$Mode;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json}
}catch{$safeCode=if($_.Exception.Message -cin @('TARGET','PENDING_ENVIRONMENT_CHANGE','DRAIN_STATE','VARIABLE_COUNT','CONCURRENT_VARIABLE_CHANGE','DEPLOYMENT_NOT_HEALTHY','FINAL_ACTIVE_DEPLOYMENTS','RESOURCE_CONFIG_DRIFT','READY_HTTP','READY_IDENTITY')){$_.Exception.Message}else{'SAFE_RELEASE_FAILURE'};@{kind='PHASE10_RELEASE_ACTION_REJECTED';mode=$Mode;stage=$stage;safeCode=$safeCode;errorType=$_.Exception.GetType().Name;errorId=$_.FullyQualifiedErrorId;line=$_.InvocationInfo.ScriptLineNumber;outcomeUncertain=$submitted;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally{if($headers){$headers.Clear()};$headers=$null;$backup=$null;$live=$null;$v=$null;$reply=$null;$fresh=$null;$response=$null;$body=$null}
