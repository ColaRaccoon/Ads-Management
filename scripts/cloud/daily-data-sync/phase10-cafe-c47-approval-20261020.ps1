param([ValidateSet('Prepare','Apply')][string]$Mode='Prepare')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$c47RequestedMode=$Mode
. "$PSScriptRoot/phase10-cafe-field-sample-20261020.ps1"
$Mode=$c47RequestedMode
$script:C47Root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-c47-approval-20261020-v1'
$script:C47Operation='20261020-cafe08-c47-approval-a'
$script:C47Name='DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES'
$script:C47Old=@('C40','C48','E00','N00','N20','N30','N40','R00','R30','R40')
function Write-C47Receipt($Value,[string]$Name){
 if($Name -cnotmatch '^[a-z0-9-]+$'){throw 'OUTPUT_NAME'};[void][IO.Directory]::CreateDirectory($script:C47Root)
 $stream=[IO.File]::Open((Join-Path $script:C47Root ($Name+'.json')),[IO.FileMode]::CreateNew)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 20));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Get-C47Pins{
 $pins=Get-CafeFieldPins;$pins['phase10-cafe-c47-approval-20261020.ps1']=(Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot 'phase10-cafe-c47-approval-20261020.ps1')).Hash.ToLowerInvariant()
 $pins['reviewed-code.json']=(Get-FileHash -Algorithm SHA256 (Join-Path $script:C47Root 'reviewed-code.json')).Hash.ToLowerInvariant();return $pins
}
function Assert-C47Reviewed{
 $review=Get-Content -LiteralPath (Join-Path $script:C47Root 'reviewed-code.json') -Raw|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String
 $observation='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-status-window-20261020-v1/result.json'
 if($review.kind -cne 'CAFE08_C47_EXPLICIT_REVIEW' -or $review.code -cne 'C47' -or $review.version -cne '2026-09-01' -or $review.officialUrl -cne 'https://developers-001.cafe24.com/docs/api/admin/' -or $review.onlyThisCodeApproved -cne $true -or $review.normalizedOrders -ne 20 -or $review.observedItemOccurrences -ne 1 -or $review.originalFailureCauseConfirmed -cne $false -or $review.currentObservationSha256 -cne (Get-FileHash -Algorithm SHA256 $observation).Hash.ToLowerInvariant()){throw 'REVIEW_SCOPE'}
 $actual=Get-Content -LiteralPath $observation -Raw|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String
 if($actual.kind -cne 'CAFE08_CURRENT_STATUS_WINDOW' -or $actual.day -cne '2026-10-16' -or $actual.providerRequests -ne 22 -or $actual.versionVerifiedResponses -ne 22 -or $actual.ordersExamined -ne 20 -or $actual.normalizationDiagnostics.PASS -ne 20 -or $actual.unapprovedCodes.Count -ne 1 -or $actual.unapprovedItemCodes.C47 -ne 1 -or $actual.unsupportedV1Codes.Count -ne 0 -or $actual.whole68Unchanged -cne $true -or $actual.holdsAndEnvironmentUnchanged -cne $true){throw 'CURRENT_REVIEW_PROOF'}
}
function Get-C47ExpectedVariables($Variables){
 $old=@($Variables[$script:C47Name]|ConvertFrom-Json -Depth 5)
 if($old.Count -ne 10 -or @($old|Where-Object {$_ -isnot [string]}).Count -ne 0 -or @($old|Sort-Object -Unique).Count -ne 10 -or (($old|Sort-Object)|ConvertTo-Json -Compress) -cne (($script:C47Old|Sort-Object)|ConvertTo-Json -Compress)){throw 'EXACT_OLD_TEN_REQUIRED'}
 $expected=[ordered]@{};foreach($name in $Variables.Keys){$expected[$name]=$Variables[$name]};$expected[$script:C47Name]=@($old+'C47')|ConvertTo-Json -Compress
 return $expected
}
function Assert-C47Preserved($Before,$After){
 if((Get-CafeRecoveryTablesHash $Before.table_digests) -cne (Get-CafeRecoveryTablesHash $After.table_digests) -or (Get-CafeRecoveryControlsHash $Before) -cne (Get-CafeRecoveryControlsHash $After)){throw 'ALL68_OR_CONTROLS_DRIFT'}
}
function Assert-C47DataHold{
 $cipher=$null;try{$cipher=Get-CafeRecoveryCipherSnapshot;if($cipher.db -cne 'postgres' -or $cipher.principal -cne 'postgres' -or $cipher.heldGrants -ne 0 -or $cipher.enabledConnections -ne 0 -or $cipher.connectionCount -ne 3 -or $cipher.liveLeases -ne 0 -or $cipher.runningRuns -ne 0){throw 'DATA_HOLD_REQUIRED'}}finally{$cipher=$null}
}
function Invoke-C47Action([string]$Action){
 $stage='START';$submitted=$false;$live=$null;$before=$null;$after=$null;$expected=$null;$plan=$null
 try{
  Assert-C47Reviewed;$pins=Get-C47Pins;$privateName='cafe08-c47-approval-plan-'+$script:C47Operation
  if($Action -ceq 'Apply' -and (Test-Path -LiteralPath (Join-Path $script:C47Root 'attempt.json'))){throw 'ATTEMPT_CONSUMED'}
  $stage='FRESH_HELD_TARGET';$live=Get-IncidentState;$before=Get-IncidentSnapshot;Assert-CafeRecoveryHold $before $live;Assert-CafeRecoveryDeploymentStopped;Assert-C47DataHold
  $expected=Get-C47ExpectedVariables $live.variables;$beforeHash=Get-IncidentVariableHash $live.variables;$afterHash=Get-IncidentVariableHash $expected
  if($Action -ceq 'Prepare'){
   $plan=@{operationKey=$script:C47Operation;eligibleSecretRollback=$false;sourcePins=$pins;beforeVariableHash=$beforeHash;expectedVariableHash=$afterHash;beforeApprovedCodes=@($live.variables[$script:C47Name]|ConvertFrom-Json -Depth 5);afterApprovedCodes=@($expected[$script:C47Name]|ConvertFrom-Json -Depth 5);tablesHash=Get-CafeRecoveryTablesHash $before.table_digests;controlsHash=Get-CafeRecoveryControlsHash $before;expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(15).ToString('o')};Write-IncidentPrivate $plan $privateName
   $safe=@{kind='CAFE08_C47_APPROVAL_PREPARED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourcePins=$pins;changedVariableNames=@($script:C47Name);oldStatusCount=10;newStatusCount=11;beforeApprovedCodes=$plan.beforeApprovedCodes;afterApprovedCodes=$plan.afterApprovedCodes;addedCode='C47';oldOrderPreservedC47Appended=$true;n20Preserved=$true;secretsChanged=0;databaseWrites=0;providerRequests=0;remoteMutations=0;skipDeploys=$true;deploymentStarted=$false;serverAtomicCompareAndSwap=$false;compareMode='PREPARED_FULL_VARIABLE_READ_COMPARE_AND_POST_VERIFY';rawValuesReturned=0};Write-C47Receipt $safe 'prepared';return $safe
  }
  $stage='PREPARED_HASH_CAS';$plan=Read-IncidentPrivate $privateName
  if($plan.operationKey -cne $script:C47Operation -or $plan.eligibleSecretRollback -cne $false -or [DateTimeOffset]::Parse($plan.expiresAt) -le [DateTimeOffset]::UtcNow -or (Get-IncidentHash $pins) -cne (Get-IncidentHash $plan.sourcePins) -or $beforeHash -cne $plan.beforeVariableHash -or $afterHash -cne $plan.expectedVariableHash -or (Get-CafeRecoveryTablesHash $before.table_digests) -cne $plan.tablesHash -or (Get-CafeRecoveryControlsHash $before) -cne $plan.controlsHash){throw 'PLAN_CAS'}
  Write-C47Receipt @{kind='CAFE08_C47_SINGLE_VARIABLE_ATTEMPT';observedAt=[DateTimeOffset]::UtcNow.ToString('o');changedNames=@($script:C47Name);addedCode='C47';skipDeploys=$true;replace=$false;secretsChanged=0;retryAllowed=$false;providerRequests=0;databaseWrites=0;eligibleSecretRollback=$false} 'attempt'
  $stage='IMMEDIATE_FULL_VARIABLE_COMPARE';$fresh=Get-IncidentState;$freshSnapshot=Get-IncidentSnapshot;Assert-CafeRecoveryHold $freshSnapshot $fresh;Assert-CafeRecoveryDeploymentStopped;Assert-C47DataHold;Assert-C47Preserved $before $freshSnapshot
  if((Get-IncidentVariableHash $fresh.variables) -cne $plan.beforeVariableHash){throw 'LAST_MOMENT_VARIABLE_CAS'}
  $stage='ONE_PUBLIC_VARIABLE_UPSERT';$submitted=$true
  $reply=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$script:IncidentScope.p;environmentId=$script:IncidentScope.e;serviceId=$script:IncidentScope.s;skipDeploys=$true;replace=$false;variables=@{DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES=$expected[$script:C47Name]}}}
  if($reply.variableCollectionUpsert -cne $true){throw 'UNCERTAIN_UPSERT_INSPECT_NO_RETRY'}
  $stage='VERIFY_EXACT_ONE_CHANGE_AND_HOLDS';$afterLive=Get-IncidentState;$after=Get-IncidentSnapshot;Assert-CafeRecoveryHold $after $afterLive;Assert-CafeRecoveryDeploymentStopped;Assert-C47DataHold;Assert-C47Preserved $before $after
  if((Get-IncidentVariableHash $afterLive.variables) -cne $plan.expectedVariableHash){throw 'AFTER_VARIABLE_HASH'}
  $safe=@{kind='CAFE08_C47_PUBLIC_APPROVAL_VERIFIED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourcePins=$pins;changedVariableNames=@($script:C47Name);changedVariableCount=1;oldStatusCount=10;newStatusCount=11;approvedCodes=@($expected[$script:C47Name]|ConvertFrom-Json -Depth 5);addedCode='C47';allTenPreserved=$true;oldOrderPreservedC47Appended=$true;n20Preserved=$true;whole68Unchanged=$true;controlsUnchanged=$true;otherVariablesUnchanged=$true;heldStoppedImageUnchanged=$true;observationHoldPreserved=$true;mutationCalls=1;providerRequests=0;databaseWrites=0;secretsChanged=0;skipDeploys=$true;replace=$false;deploymentStarted=$false;serverAtomicCompareAndSwap=$false;runtimeProcessReloaded=$false;retryPerformed=$false;eligibleSecretRollback=$false;rawValuesReturned=0};Write-C47Receipt $safe 'result';return $safe
 }catch{
  $safe=@{kind='CAFE08_C47_APPROVAL_SAFE_FAILURE';mode=$Action;stage=$stage;outcomeUncertain=$submitted;automaticRetryAllowed=$false;inspectBeforeAnyFurtherAction=$true;secretRollbackAllowed=$false;rawErrorSuppressed=$true;rawValuesReturned=0};try{Write-C47Receipt $safe ('failure-'+$Action.ToLowerInvariant()+'-'+[DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmssfff'))}catch{};return $safe
 }finally{$live=$null;$before=$null;$after=$null;$expected=$null;$plan=$null}
}
if($MyInvocation.InvocationName -ceq '.'){return}
$public=Invoke-C47Action $Mode;$public|ConvertTo-Json -Depth 20 -Compress
if($public.kind -ceq 'CAFE08_C47_APPROVAL_SAFE_FAILURE'){exit 1}
