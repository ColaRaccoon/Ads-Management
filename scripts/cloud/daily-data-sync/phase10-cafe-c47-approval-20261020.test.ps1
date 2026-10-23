$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-cafe-c47-approval-20261020.ps1" -Mode Apply
if($Mode -cne 'Apply'){throw 'C47_TEST_MODE_CLOBBER'}
$script:Private=@{};$script:Receipts=@{};$script:Mutations=0;$script:StateReads=0;$script:RaceAt=0;$script:Unknown=$false;$script:AfterVarDrift=$false;$script:AfterDbDrift=$false;$script:Stopped=$true;$script:DataHeld=$true
function Assert-Test($Value,[string]$Name){if(-not $Value){throw ('C47_TEST_'+$Name)}}
function New-Vars{return [ordered]@{DAILY_SYNC_FEATURE_ENABLED='false';DAILY_SYNC_SCHEDULE_ENABLED='false';DAILY_SYNC_ACTIVE_KEY_VERSION='2';DAILY_SYNC_RETIRED_CREDENTIAL_KEY_VERSIONS='1';DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED='true';PHASE08_SOURCE_CONTENT_SHA256='6d60d1662730508e19af171124310b82693c0687d86efdd76fa0663f367a767e';RELEASE_GIT_SHA='5bda544ec579a15745a93f89ee4fbc69bb7102f5';DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES='["C40","C48","E00","N00","N20","N30","N40","R00","R30","R40"]';OTHER_PUBLIC='synthetic';OTHER_SECRET='SYNTHETIC_PRIVATE_CANARY'}}
$script:Vars=New-Vars
function Test-Path{param([string]$LiteralPath)if($LiteralPath.EndsWith('attempt.json')){return $script:Receipts.ContainsKey('attempt')};throw 'UNEXPECTED_PATH'}
function Get-C47Pins{return [ordered]@{synthetic='SYNTHETIC_SOURCE'}}
function Write-C47Receipt($Value,[string]$Name){if($script:Receipts.ContainsKey($Name)){throw 'CREATE_NEW'};$script:Receipts[$Name]=$Value}
function Write-IncidentPrivate($Value,[string]$Name){if($script:Private.ContainsKey($Name)){throw 'CREATE_NEW'};$script:Private[$Name]=$Value}
function Read-IncidentPrivate([string]$Name){return $script:Private[$Name]}
function Get-IncidentState{$script:StateReads++;if($script:RaceAt -eq $script:StateReads){$script:Vars.OTHER_PUBLIC='race'};return @{variables=$script:Vars;serviceInstance=@{latestDeployment=@{id='39c6b738-6d2f-4111-a97b-37f017b39886';meta=@{imageDigest='sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0'}}}}}
function Get-IncidentSnapshot{$tables=@(0..67|ForEach-Object {[ordered]@{table="synthetic_$_";rows=$(if($script:AfterDbDrift -and $script:Mutations -gt 0 -and $_ -eq 0){1}else{0});md5=('a'*32)}});return @{stopped=$true;paused=3;active_jobs=0;live_leases=0;runtime_role=[ordered]@{login=$false};runtime_backends=0;table_digests=$tables;runtime_grants_md5=('a'*32);job_definitions_md5=('a'*32);other_jobs_md5=('a'*32);original152_md5=('a'*32);call_md5=('a'*32);storage_objects_md5=('a'*32)}}
function Assert-CafeRecoveryDeploymentStopped{if(-not $script:Stopped){throw 'RUNNING'}}
function Get-CafeRecoveryCipherSnapshot{return @{db='postgres';principal='postgres';heldGrants=$(if($script:DataHeld){0}else{1});enabledConnections=0;connectionCount=3;liveLeases=0;runningRuns=0}}
function Invoke-Phase08Management{throw 'OFFLINE_EGRESS_FORBIDDEN'}
function Invoke-Phase08SchedulerGraph($Query,$Variables){
 Assert-Test ($script:Receipts.ContainsKey('attempt')) 'ATTEMPT_BEFORE_MUTATION'
 Assert-Test ($Query.Contains('variableCollectionUpsert') -and $Variables.input.projectId -ceq $script:IncidentScope.p -and $Variables.input.environmentId -ceq $script:IncidentScope.e -and $Variables.input.serviceId -ceq $script:IncidentScope.s -and $Variables.input.skipDeploys -ceq $true -and $Variables.input.replace -ceq $false -and $Variables.input.variables.Count -eq 1 -and $Variables.input.variables.ContainsKey('DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES')) 'EXACT_ONE_PUBLIC_KEY'
 $script:Mutations++;$script:Vars.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES=$Variables.input.variables.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES
 if($script:AfterVarDrift){$script:Vars.OTHER_PUBLIC='unexpected'}
 return @{variableCollectionUpsert=(-not $script:Unknown)}
}
function Reset-Test{$script:Vars=New-Vars;$script:Private=@{};$script:Receipts=@{};$script:Mutations=0;$script:StateReads=0;$script:RaceAt=0;$script:Unknown=$false;$script:AfterVarDrift=$false;$script:AfterDbDrift=$false;$script:Stopped=$true;$script:DataHeld=$true}
$cases=1
try{
 Assert-C47Reviewed;$cases++
 Reset-Test;$r=Invoke-C47Action Prepare;Assert-Test ($r.kind -ceq 'CAFE08_C47_APPROVAL_PREPARED' -and $script:Mutations -eq 0 -and $r.serverAtomicCompareAndSwap -ceq $false) 'PREPARE_RO';$cases++
 $r=Invoke-C47Action Apply;Assert-Test ($r.kind -ceq 'CAFE08_C47_PUBLIC_APPROVAL_VERIFIED' -and $script:Mutations -eq 1 -and $r.changedVariableCount -eq 1 -and $r.allTenPreserved -and $r.whole68Unchanged -and $r.n20Preserved -and $script:Vars.OTHER_SECRET -ceq 'SYNTHETIC_PRIVATE_CANARY') 'SUCCESS_ONE_KEY';$cases++
 $r=Invoke-C47Action Apply;Assert-Test ($r.kind -ceq 'CAFE08_C47_APPROVAL_SAFE_FAILURE' -and $r.stage -ceq 'START' -and $script:Mutations -eq 1) 'NO_REPEAT';$cases++
 Reset-Test;$reverse=@($script:C47Old);[array]::Reverse($reverse);$script:Vars.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES=$reverse|ConvertTo-Json -Compress;$null=Invoke-C47Action Prepare;$r=Invoke-C47Action Apply;$afterCodes=@($script:Vars.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES|ConvertFrom-Json);Assert-Test ($r.kind -ceq 'CAFE08_C47_PUBLIC_APPROVAL_VERIFIED' -and (($afterCodes[0..9]|ConvertTo-Json -Compress) -ceq ($reverse|ConvertTo-Json -Compress)) -and $afterCodes[10] -ceq 'C47') 'UNSORTED_TEN_PRESERVED_APPEND_ONLY';$cases++
 Reset-Test;$null=Invoke-C47Action Prepare;$script:Vars.OTHER_PUBLIC='different';$r=Invoke-C47Action Apply;Assert-Test ($r.stage -ceq 'PREPARED_HASH_CAS' -and $script:Mutations -eq 0) 'WHOLE_VARS_DRIFT';$cases++
 Reset-Test;$null=Invoke-C47Action Prepare;$script:RaceAt=3;$r=Invoke-C47Action Apply;Assert-Test ($r.stage -ceq 'IMMEDIATE_FULL_VARIABLE_COMPARE' -and $script:Mutations -eq 0) 'LAST_MOMENT_DRIFT';$cases++
 Reset-Test;$script:Vars.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES='["C47","N20"]';$r=Invoke-C47Action Prepare;Assert-Test ($r.stage -ceq 'FRESH_HELD_TARGET' -and $script:Mutations -eq 0) 'NO_WILDCARD_OR_MISSING_TEN';$cases++
 Reset-Test;$script:Stopped=$false;$r=Invoke-C47Action Prepare;Assert-Test ($r.stage -ceq 'FRESH_HELD_TARGET' -and $script:Mutations -eq 0) 'RUNNING_BLOCK';$cases++
 Reset-Test;$script:DataHeld=$false;$r=Invoke-C47Action Prepare;Assert-Test ($r.stage -ceq 'FRESH_HELD_TARGET' -and $script:Mutations -eq 0) 'GRANT_OR_PROVIDER_BLOCK';$cases++
 Reset-Test;$null=Invoke-C47Action Prepare;$script:Unknown=$true;$r=Invoke-C47Action Apply;Assert-Test ($r.outcomeUncertain -ceq $true -and $r.stage -ceq 'ONE_PUBLIC_VARIABLE_UPSERT' -and $script:Mutations -eq 1) 'UNCERTAIN_NO_ROLLBACK';$r=Invoke-C47Action Apply;Assert-Test ($script:Mutations -eq 1 -and $r.stage -ceq 'START') 'UNCERTAIN_NO_RETRY';$cases++
 foreach($flag in @('AfterVarDrift','AfterDbDrift')){Reset-Test;$null=Invoke-C47Action Prepare;Set-Variable -Scope Script -Name $flag -Value $true;$r=Invoke-C47Action Apply;Assert-Test ($r.outcomeUncertain -ceq $true -and $r.stage -ceq 'VERIFY_EXACT_ONE_CHANGE_AND_HOLDS' -and $script:Mutations -eq 1) 'POST_VERIFY_DRIFT';$cases++}
 $source=Get-Content "$PSScriptRoot/phase10-cafe-c47-approval-20261020.ps1" -Raw;$dispatch=$source.Substring($source.LastIndexOf('$public=Invoke-C47Action'))
 function Invoke-C47Action([string]$Action){Assert-Test ($Action -ceq 'Apply') 'ACTUAL_APPLY_DISPATCH';return @{kind='OFFLINE_DISPATCH_PASS'}}
 $null=Invoke-Expression $dispatch;$cases++
 @{kind='CAFE08_C47_APPROVAL_CONTROL_SYNTHETIC_PASS';cases=$cases;actualProviderRequests=0;actualRemoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress
}catch{@{kind='CAFE08_C47_APPROVAL_CONTROL_SYNTHETIC_FAIL';cases=$cases;safeReason=$(if($_.Exception.Message -cmatch '^C47_TEST_[A-Z0-9_]+$'){$_.Exception.Message}else{'OFFLINE_TEST_REJECTED'});actualProviderRequests=0;actualRemoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress;exit 1}
