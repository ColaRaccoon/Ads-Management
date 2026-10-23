param([ValidateSet('Prepare','Refresh','Verify')][string]$Mode='Prepare')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$script:CafeRecoveryOperation='20261021-cafe08-epoch-live-a'
$script:CafeRecoveryRoot='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-recovery-20261021-v1'
function Write-CafeRecoveryReceipt($Value,[string]$Name){
 if($Name -cnotmatch '^[a-z0-9-]+$'){throw 'RECEIPT_NAME'}
 [void][IO.Directory]::CreateDirectory($script:CafeRecoveryRoot);$stream=[IO.File]::Open((Join-Path $script:CafeRecoveryRoot ($Name+'.json')),[IO.FileMode]::CreateNew)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 15));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Get-CafeRecoveryPins{
 $result=[ordered]@{};foreach($name in @('phase10-cafe-pair-renew-20261021.ps1','phase10-cafe-pair-renew-child-20261021.mjs','phase10-cafe-pair-renew-20261021.mjs')){$result[$name]=(Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant()};return $result
}
function Invoke-CafeRecoveryChild($Value){
 $child=$null;$wire=$null;$raw=$null;$discard=$null
 try{
  $wire=$Value|ConvertTo-Json -Depth 45 -Compress;if([Text.Encoding]::UTF8.GetByteCount($wire)>4194304){throw 'CHILD_INPUT_BOUND'}
  $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');$psi.ArgumentList.Add((Join-Path $PSScriptRoot 'phase10-cafe-pair-renew-child-20261021.mjs'));$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $psi.Environment.Clear();foreach($name in @('SystemRoot','PATH','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($name)){$psi.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}};$psi.Environment['CAFE08_PROTECTED_PARENT']='20261021-ROOT'
  $utf8=[Text.UTF8Encoding]::new($false,$true);$psi.StandardInputEncoding=$utf8;$psi.StandardOutputEncoding=$utf8;$psi.StandardErrorEncoding=$utf8
  $child=[Diagnostics.Process]::Start($psi);$out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync();$child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null
  if(-not $child.WaitForExit(30000)){$child.Kill($true);throw 'CHILD_TIMEOUT'}
  $raw=$out.GetAwaiter().GetResult();$discard=$err.GetAwaiter().GetResult();$discard=$null;if($child.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetByteCount($raw)>1048576){throw 'CHILD_REJECTED'}
  return ($raw|ConvertFrom-Json -AsHashtable -Depth 45 -DateKind String)
 }finally{if($child){if(-not $child.HasExited){$child.Kill($true)};$child.Dispose()};$wire=$null;$raw=$null;$discard=$null;$Value=$null}
}
function Get-CafeRecoveryTablesHash($Tables){
 $canonical=@($Tables|Sort-Object table|ForEach-Object {[ordered]@{table=$_.table;rows=$_.rows;md5=$_.md5}});return Get-IncidentHash $canonical
}
function Get-CafeRecoveryControlsHash($Snapshot){return Get-IncidentHash ([ordered]@{runtimeRole=$Snapshot.runtime_role;runtimeGrants=$Snapshot.runtime_grants_md5;jobDefinitions=$Snapshot.job_definitions_md5;otherJobs=$Snapshot.other_jobs_md5;originalHistory=$Snapshot.original152_md5;call=$Snapshot.call_md5;storageObjects=$Snapshot.storage_objects_md5})}
function Get-CafeRecoveryCallbackState{
 $value=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id}}}' @{p=$script:IncidentScope.p;e=$script:IncidentScope.e;s='deaaeaf9-ee5c-42fa-b32f-600c7a90befc'}
 if($value.serviceInstance.serviceId -cne 'deaaeaf9-ee5c-42fa-b32f-600c7a90befc' -or $value.serviceInstance.environmentId -cne $script:IncidentScope.e -or $value.serviceInstance.latestDeployment.id -cne '0f09de34-c1bf-4a1e-9a2a-fe511bbb07f3' -or $value.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false'){throw 'CALLBACK_STATE'};return $value
}
function Invoke-CafeRecoveryCallbackInspect{return (& "$PSScriptRoot/../../../deploy/cafe24-test/run-live-canonical.ps1" -Mode Inspect -PassThru)}
function Assert-CafeRecoveryDeploymentStopped{
 $value=Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id deploymentStopped} activeDeployments{id deploymentStopped}}}' @{e=$script:IncidentScope.e;s=$script:IncidentScope.s}
 if($value.serviceInstance.serviceId -cne $script:IncidentScope.s -or $value.serviceInstance.environmentId -cne $script:IncidentScope.e -or $value.serviceInstance.latestDeployment.id -cne '39c6b738-6d2f-4111-a97b-37f017b39886' -or $value.serviceInstance.latestDeployment.deploymentStopped -cne $true -or @($value.serviceInstance.activeDeployments|Where-Object deploymentStopped -CNE $true).Count -ne 0){throw 'DEPLOYMENT_NOT_STOPPED'}
}
function Assert-CafeRecoveryHold($Snapshot,$Live){
 Assert-IncidentContained $Snapshot
 if($Live.serviceInstance.latestDeployment.id -cne '39c6b738-6d2f-4111-a97b-37f017b39886' -or $Live.serviceInstance.latestDeployment.meta.imageDigest -cne 'sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0'){throw 'HELD_IMAGE_IDENTITY'}
 if($Snapshot.runtime_role.login -cne $false -or $Snapshot.runtime_backends -ne 0 -or $Snapshot.table_digests.Count -ne 68 -or $Live.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $Live.variables.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false' -or $Live.variables.DAILY_SYNC_ACTIVE_KEY_VERSION -cne '2' -or $Live.variables.DAILY_SYNC_RETIRED_CREDENTIAL_KEY_VERSIONS -cne '1' -or $Live.variables.DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED -cne 'true' -or $Live.variables.Contains('DAILY_SYNC_CREDENTIAL_KEY_V1') -or $Live.variables.Contains('DAILY_SYNC_CAFE24_CLIENT_SECRET') -or $Live.variables.PHASE08_SOURCE_CONTENT_SHA256 -cne '6d60d1662730508e19af171124310b82693c0687d86efdd76fa0663f367a767e' -or $Live.variables.RELEASE_GIT_SHA -cne '5bda544ec579a15745a93f89ee4fbc69bb7102f5'){throw 'HOLD_REQUIRED'}
}
function Get-CafeRecoveryCipherSnapshot{
 $sql=(Invoke-CafeRecoveryChild @{action='SNAPSHOT_SQL'}).sql
 try{$rows=@(Invoke-Phase08Management -Action Query -Query $sql);if($rows.Count -ne 1 -or $rows[0].db -cne 'postgres' -or $rows[0].principal -cne 'postgres'){throw 'READ_IDENTITY'};return ($rows[0]|ConvertTo-Json -Depth 35 -Compress|ConvertFrom-Json -AsHashtable -Depth 35 -DateKind String)}finally{$rows=$null;$sql=$null}
}
function Assert-CafeRecoveryCallbackProof{
 $path='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-recovery-20261021-v1/callback-inspect.json'
 $proof=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json -AsHashtable -DateKind String
 if($proof.kind -cne 'CAFE_FIXED06_CALLBACK_READONLY_INSPECT' -or $proof.credentialRevisionsRemainOriginal11 -cne $true -or $proof.connectionDisabled -cne $true -or $proof.liveLease -cne $false -or $proof.sameFinal06Deployment -cne $true -or ([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($proof.observedAt)).TotalMinutes -gt 30){throw 'FRESH_CALLBACK11_PROOF'}
 return (Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant()
}
function Get-CafeRecoveryLineagePins{
 $out=[ordered]@{};foreach($relative in @('docs/daily-data-automation/records/06_결과.md','docs/daily-data-automation/records/08_결과.md')){$path=Join-Path (Resolve-Path "$PSScriptRoot/../../..").Path $relative;$out[$relative]=(Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant()};return $out
}
function Assert-CafeRecoveryUnusedStorage([string]$ResponseName,[string]$ForwardName){
 Assert-Phase08PrivatePath -Path $script:IncidentPrivate -Directory
 foreach($name in @($ResponseName,$ForwardName)){if(Test-Path -LiteralPath (Join-Path $script:IncidentPrivate ($name+'.dpapi'))){throw 'CAPTURED_RESPONSE_EXISTS_NO_REPOST'}}
}
function Invoke-CafeRecoveryAction([string]$Action){
 $stage='START';$submitted=$false;$live=$null;$gate=$null;$plan=$null;$callback=$null;$baseline=$null;$cipher=$null;$protectedResponse=$null;$prepared=$null;$result=$null
 $planName='cafe08-recovery-plan-'+$script:CafeRecoveryOperation;$responseName='cafe08-recovery-response-'+$script:CafeRecoveryOperation;$forwardName='cafe08-recovery-forward-'+$script:CafeRecoveryOperation
 try{
  $pins=Get-CafeRecoveryPins
  if($Action -ceq 'Refresh' -and (Test-Path -LiteralPath (Join-Path $script:CafeRecoveryRoot 'attempt.json'))){throw 'ATTEMPT_CONSUMED_NO_REPOST'}
  if($Action -cin @('Prepare','Refresh')){Assert-CafeRecoveryUnusedStorage $responseName $forwardName}
  $stage='HELD_RUNTIME';$live=Get-IncidentState;$gate=Get-IncidentSnapshot;Assert-CafeRecoveryHold $gate $live;Assert-CafeRecoveryDeploymentStopped
  $stage='READONLY_PAIR';$cipher=Get-CafeRecoveryCipherSnapshot
  if($Action -ceq 'Prepare'){
   $stage='PRIVATE_STORAGE_PREFLIGHT';$probeName='cafe08-recovery-storage-probe-'+$script:CafeRecoveryOperation;$probe=[ordered]@{marker='CAFE08_DPAPI_STORAGE_PROBE';nonce=[Guid]::NewGuid().ToString();eligibleSecretRollback=$false};Write-IncidentPrivate $probe $probeName;$roundTrip=Read-IncidentPrivate $probeName;if($roundTrip.marker -cne $probe.marker -or $roundTrip.nonce -cne $probe.nonce -or $roundTrip.eligibleSecretRollback -cne $false){throw 'DPAPI_STORAGE_ROUNDTRIP'};$probe=$null;$roundTrip=$null
   $stage='CALLBACK_LINEAGE_PROOF';$callbackHash=Assert-CafeRecoveryCallbackProof
   $callback=Get-CafeRecoveryCallbackState
   $baseline=Read-IncidentPrivate 'compromised-baseline'
   if($callback.serviceInstance.serviceId -cne 'deaaeaf9-ee5c-42fa-b32f-600c7a90befc' -or $callback.serviceInstance.environmentId -cne $script:IncidentScope.e -or $callback.serviceInstance.latestDeployment.id -cne '0f09de34-c1bf-4a1e-9a2a-fe511bbb07f3' -or $callback.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $callback.variables.DAILY_SYNC_CAFE24_CLIENT_ID -cne $baseline.variables.DAILY_SYNC_CAFE24_CLIENT_ID -or $callback.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET -cne $baseline.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET){throw 'CALLBACK_BINDING'}
   $stage='CURRENT_REV9_PROVENANCE';$priorResponse=Read-IncidentPrivate 'cafe08-recovery-response-20261020-cafe08-read-recovery-a'
   $stage='OFFLINE_PLAN';$plan=Invoke-CafeRecoveryChild @{action='PREPARE';input=@{operationKey=$script:CafeRecoveryOperation;snapshot=$cipher;previousProtectedResponse=$priorResponse;credentialKeyV2=$live.variables.DAILY_SYNC_CREDENTIAL_KEY_V2;clientId=$callback.variables.DAILY_SYNC_CAFE24_CLIENT_ID;clientSecret=$callback.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET;callbackSecretMatchesBaseline=$true;callbackRevision11Verified=$true;new08OAuthNoCloneLineageVerified=$true;holdsVerified=$true;activeKeyVersion=$live.variables.DAILY_SYNC_ACTIVE_KEY_VERSION;retiredV1=$live.variables.DAILY_SYNC_RETIRED_CREDENTIAL_KEY_VERSIONS;observationQuarantined=$live.variables.DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED}}
   $plan.sourcePins=$pins;$plan.lineagePins=Get-CafeRecoveryLineagePins;$plan.beforeTables=$gate.table_digests;$plan.beforeTablesHash=Get-CafeRecoveryTablesHash $gate.table_digests;$plan.beforeControlsHash=Get-CafeRecoveryControlsHash $gate;$plan.variableHash=Get-IncidentVariableHash $live.variables;$plan.callbackProofSha256=$callbackHash;$plan.callbackVariableHash=Get-IncidentVariableHash $callback.variables
   $stage='DPAPI_PLAN';Write-IncidentPrivate $plan $planName
   $result=@{kind='CAFE08_RECOVERY_PREPARED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');summary=$plan.safeSummary;sourcePins=$pins;lineagePins=$plan.lineagePins;callbackProofSha256=$callbackHash;callbackRevision11Verified=$true;new08OAuthNoCloneLineageVerified=$true;whole68BeforeImageBound=$true;eligibleSecretRollback=$false;providerRequests=0;remoteMutations=0;rawValuesReturned=0};Write-CafeRecoveryReceipt $result 'prepared';return $result
  }
  $plan=Read-IncidentPrivate $planName
  if($plan.operationKey -cne $script:CafeRecoveryOperation -or $plan.eligibleSecretRollback -cne $false -or (Get-IncidentHash $pins) -cne (Get-IncidentHash $plan.sourcePins) -or (Get-IncidentVariableHash $live.variables) -cne $plan.variableHash){throw 'PLAN_PIN'}
  if($Action -ceq 'Refresh'){
   $callback=Get-CafeRecoveryCallbackState
   if([DateTimeOffset]::Parse($plan.expiresAt) -le [DateTimeOffset]::UtcNow -or (Get-CafeRecoveryTablesHash $gate.table_digests) -cne $plan.beforeTablesHash -or (Get-CafeRecoveryControlsHash $gate) -cne $plan.beforeControlsHash -or (Get-IncidentVariableHash $callback.variables) -cne $plan.callbackVariableHash -or $cipher.connection.rowHash -cne $plan.snapshot.connection.rowHash){throw 'STALE_PLAN'}
   foreach($row in $plan.snapshot.credentials){$actual=@($cipher.credentials|Where-Object kind -CEQ $row.kind);if($actual.Count -ne 1 -or $actual[0].rowHash -cne $row.rowHash){throw 'PAIR_DRIFT'}}
   $stage='ATTEMPT_CREATE_NEW';Write-CafeRecoveryReceipt @{kind='CAFE08_RECOVERY_ATTEMPT';observedAt=[DateTimeOffset]::UtcNow.ToString('o');maximumTokenPosts=1;automaticRetryAllowed=$false;eligibleSecretRollback=$false;sourcePins=$pins;rawValuesReturned=0} 'attempt'
   $stage='TOKEN_POST_ONCE';$submitted=$true;$protectedResponse=Invoke-CafeRecoveryChild @{action='SUBMIT_ONCE';plan=$plan}
   # Seal before inspecting provider ownership/scope/JSON or HTTP success.
   $stage='SEAL_UNPARSED_RESPONSE';Write-IncidentPrivate $protectedResponse $responseName
   $stage='VALIDATE_SEALED_RESPONSE';$prepared=Invoke-CafeRecoveryChild @{action='FINALIZE';plan=$plan;protectedResponse=$protectedResponse;tables=$plan.beforeTables}
   Write-IncidentPrivate $prepared $forwardName
   $stage='PAIR_EXACT_CAS_ONCE';$reply=@(Invoke-Phase08Management -Action Query -Query $prepared.mutationSql)
   if($reply.Count -ne 1 -or $reply[0].credentialRows -ne 2 -or $reply[0].connectionRows -ne 1 -or $reply[0].auditRows -ne 1 -or $reply[0].enabledRemainsFalse -cne $true){throw 'CAS_OUTCOME_INSPECT'}
  }elseif($Action -ceq 'Verify'){$prepared=Read-IncidentPrivate $forwardName}else{throw 'ACTION'}
  $stage='READONLY_NEW_PAIR_VERIFY';$cipher=Get-CafeRecoveryCipherSnapshot;$verification=Invoke-CafeRecoveryChild @{action='VERIFY';prepared=$prepared;snapshot=$cipher;plan=$plan}
  $after=Get-IncidentSnapshot;Assert-CafeRecoveryHold $after $live
  if((Get-CafeRecoveryControlsHash $after) -cne $plan.beforeControlsHash){throw 'CONTROLS_CHANGED'}
  $afterLive=Get-IncidentState;if((Get-IncidentVariableHash $afterLive.variables) -cne $plan.variableHash){throw 'ENVIRONMENT_CHANGED'};Assert-CafeRecoveryDeploymentStopped
  foreach($table in $plan.beforeTables){if($table.table -cin @('source_credentials','source_connections','security_audit_events')){continue};$actual=@($after.table_digests|Where-Object table -CEQ $table.table);if($actual.Count -ne 1 -or $actual[0].rows -ne $table.rows -or $actual[0].md5 -cne $table.md5){throw 'UNRELATED_AFTER68'}}
  $stage='CALLBACK_AFTER_READONLY_INSPECT';$callback=Get-CafeRecoveryCallbackState;if((Get-IncidentVariableHash $callback.variables) -cne $plan.callbackVariableHash){throw 'CALLBACK_VARIABLES_CHANGED'}
  $callbackInspect=Invoke-CafeRecoveryCallbackInspect
  if($callbackInspect -isnot [Collections.IDictionary] -or $callbackInspect.mode -cne 'inspect' -or $callbackInspect.day -cne '2026-10-01' -or $callbackInspect.connectionEnabled -cne $false -or $callbackInspect.credentialRevisions.Count -ne 2 -or @($callbackInspect.credentialRevisions|Where-Object {$_ -ne 11}).Count -ne 0 -or $callbackInspect.syncExecutionEvidence.leaseActive -cne $false -or $callbackInspect.currentApiLines -ne 477 -or $callbackInspect.currentApiVersions -ne 477 -or $callbackInspect.currentApiLinks -ne 477 -or $callbackInspect.lastSuccessPreserved -cne $true){throw 'CALLBACK_PRESERVATION'}
  $result=@{kind='CAFE08_RECOVERY_VERIFIED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');verification=$verification;eligibleSecretRollback=$false;providerPosts=1;sharedClientSecretChanged=$false;callbackRevision11StillVerified=$true;callbackVariablesUnchanged=$true;callbackApi477AndLastSuccessPreserved=$true;observationQuarantined=$true;runtimeNoLogin=$true;providerConnectionsOff=$true;rawValuesReturned=0};Write-CafeRecoveryReceipt $result ('verified-'+$Action.ToLowerInvariant());return $result
 }catch{
  $failure=@{kind='CAFE08_RECOVERY_SAFE_FAILURE';mode=$Action;stage=$stage;requestMayHaveBeenSubmitted=$submitted;automaticRetryAllowed=$false;oldRefreshRestoreForbidden=$true;inspectActualStateBeforeAnyNewAction=$true;rawErrorSuppressed=$true;rawValuesReturned=0}
  try{Write-CafeRecoveryReceipt $failure ('failure-'+$Action.ToLowerInvariant()+'-'+[DateTimeOffset]::UtcNow.ToString('yyyyMMddhhmmssfff'))}catch{}
  return $failure
 }finally{$live=$null;$gate=$null;$plan=$null;$callback=$null;$baseline=$null;$cipher=$null;$priorResponse=$null;$protectedResponse=$null;$prepared=$null;$reply=$null}
}
if($MyInvocation.InvocationName -ceq '.'){return}
$safeResult=Invoke-CafeRecoveryAction $Mode;$safeResult|ConvertTo-Json -Depth 15 -Compress
if($safeResult.kind -ceq 'CAFE08_RECOVERY_SAFE_FAILURE'){exit 1}
