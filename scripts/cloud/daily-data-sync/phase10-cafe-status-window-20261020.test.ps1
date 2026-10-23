$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-cafe-status-window-20261020.ps1" -Mode Execute
if($Mode -cne 'Execute'){throw 'STATUS_TEST_MODE_CLOBBER'}
$script:Private=@{};$script:Receipts=@{};$script:Gets=0;$script:Reads=0;$script:Mutations=0;$script:DriftAfter=$false;$script:Stopped=$true;$script:Events=[Collections.Generic.List[string]]::new()
$script:Variables=[ordered]@{DAILY_SYNC_FEATURE_ENABLED='false';DAILY_SYNC_SCHEDULE_ENABLED='false';DAILY_SYNC_ACTIVE_KEY_VERSION='2';DAILY_SYNC_RETIRED_CREDENTIAL_KEY_VERSIONS='1';DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED='true';DAILY_SYNC_CREDENTIAL_KEY_V2='SYNTHETIC_KEY';PHASE08_SOURCE_CONTENT_SHA256='6d60d1662730508e19af171124310b82693c0687d86efdd76fa0663f367a767e';RELEASE_GIT_SHA='5bda544ec579a15745a93f89ee4fbc69bb7102f5'}
function Assert-True($Condition,[string]$Name){if(-not $Condition){throw ('STATUS_TEST_'+$Name)}}
function Test-Path{param([string]$LiteralPath)if($LiteralPath.EndsWith('attempt.json')){return $script:Receipts.ContainsKey('attempt')};return $false}
function Get-CafeStatusPins{return [ordered]@{synthetic='SYNTHETIC_SOURCE_PIN'}}
function Write-IncidentPrivate($Value,[string]$Name){if($script:Private.ContainsKey($Name)){throw 'CREATE_NEW'};$script:Private[$Name]=$Value}
function Read-IncidentPrivate([string]$Name){return $script:Private[$Name]}
function Write-CafeStatusReceipt($Value,[string]$Name){if($script:Receipts.ContainsKey($Name)){throw 'CREATE_NEW'};$script:Receipts[$Name]=$Value;$script:Events.Add($Name)}
function Get-IncidentState{return @{variables=$script:Variables;serviceInstance=@{latestDeployment=@{id='39c6b738-6d2f-4111-a97b-37f017b39886';meta=@{imageDigest='sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0'}}}}}
function Get-IncidentSnapshot{$script:Reads++;$tables=@(0..67|ForEach-Object {[ordered]@{table="synthetic_$_";rows=$(if($script:DriftAfter -and $script:Reads -gt 2 -and $_ -eq 0){1}else{0});md5=('a'*32)}});return @{stopped=$true;paused=3;active_jobs=0;live_leases=0;runtime_role=[ordered]@{login=$false};runtime_backends=0;table_digests=$tables;runtime_grants_md5=('a'*32);job_definitions_md5=('a'*32);other_jobs_md5=('a'*32);original152_md5=('a'*32);call_md5=('a'*32);storage_objects_md5=('a'*32)}}
function Assert-CafeRecoveryDeploymentStopped{if(-not $script:Stopped){throw 'RUNNING'}}
function Get-CafeRecoveryCipherSnapshot{return @{synthetic=$true}}
function Get-CafeFieldCheckpoint{return @{synthetic=$true}}
function Get-CafeFieldProtectedInput($Live,$Snapshot,$Checkpoint){return @{synthetic=$true}}
function Invoke-Phase08Management{$script:Mutations++;throw 'OFFLINE_EGRESS_FORBIDDEN'}
function Invoke-CafeStatusChild($Value,[bool]$Execute){
 if($Execute){Assert-True ($script:Receipts.ContainsKey('attempt')) 'ATTEMPT_BEFORE_GET';$script:Events.Add('GET');$script:Gets++;return @{kind='CAFE08_CURRENT_STATUS_WINDOW';day='2026-10-16';targetPositions=@(21,40);approvalListChanged=$false;originalFailureCauseConfirmed=$false;automaticRetry=$false;automaticRefresh=$false;providerRequests=22;itemRequests=20;rawValuesReturned=0;databaseWrites=0;fullDayComplete=$false;originalFailureReproduced=$false;checkpointResumed=$false}}
 return @{kind='CAFE08_STATUS_WINDOW_PREFLIGHT';summary=@{maximumGets=22;providerRequests=0;fullDayComplete=$false;checkpointResumed=$false};checkpointCipherSha256=('a'*64)}
}
function Reset-Test{$script:Private=@{};$script:Receipts=@{};$script:Gets=0;$script:Reads=0;$script:Mutations=0;$script:DriftAfter=$false;$script:Stopped=$true;$script:Events.Clear()}
$cases=1
try{
 Reset-Test;$result=Invoke-CafeStatusAction Prepare;Assert-True ($result.kind -ceq 'CAFE08_STATUS_WINDOW_PREPARED' -and $script:Gets -eq 0 -and $script:Mutations -eq 0) 'PREPARE_RO';$cases++
 $result=Invoke-CafeStatusAction Execute;Assert-True ($result.kind -ceq 'CAFE08_CURRENT_STATUS_WINDOW' -and $script:Gets -eq 1 -and $script:Mutations -eq 0 -and $result.whole68Unchanged -and $result.holdsAndEnvironmentUnchanged) 'SUCCESS_RO';$cases++
 $result=Invoke-CafeStatusAction Execute;Assert-True ($result.kind -ceq 'CAFE08_STATUS_WINDOW_SAFE_FAILURE' -and $result.stage -ceq 'START' -and $script:Gets -eq 1) 'NO_REPEAT';$cases++
 Reset-Test;$null=Invoke-CafeStatusAction Prepare;$script:Private[('cafe08-status-window-plan-'+$script:CafeStatusOperation)].expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o');$result=Invoke-CafeStatusAction Execute;Assert-True ($result.stage -ceq 'OFFLINE_PREFLIGHT' -and $script:Gets -eq 0) 'EXPIRED_PLAN';$cases++
 Reset-Test;$null=Invoke-CafeStatusAction Prepare;$script:Variables.DAILY_SYNC_SCHEDULE_ENABLED='true';$result=Invoke-CafeStatusAction Execute;Assert-True ($result.stage -ceq 'HELD_BEFORE_READ' -and $script:Gets -eq 0) 'HOLD_DRIFT';$script:Variables.DAILY_SYNC_SCHEDULE_ENABLED='false';$cases++
 Reset-Test;$script:Stopped=$false;$result=Invoke-CafeStatusAction Prepare;Assert-True ($result.stage -ceq 'HELD_BEFORE_READ' -and $script:Gets -eq 0) 'RUNNING_BLOCK';$cases++
 Reset-Test;$null=Invoke-CafeStatusAction Prepare;$script:DriftAfter=$true;$result=Invoke-CafeStatusAction Execute;Assert-True ($result.stage -ceq 'WHOLE68_AFTER_READ' -and $script:Gets -eq 1 -and -not $script:Receipts.ContainsKey('result') -and $script:Mutations -eq 0) 'AFTER_DRIFT';$cases++
 # Evaluate the real script's terminal dispatch after replacing its action with an offline sentinel.
 $source=Get-Content -LiteralPath "$PSScriptRoot/phase10-cafe-status-window-20261020.ps1" -Raw
 $dispatch=$source.Substring($source.LastIndexOf('$public=Invoke-CafeStatusAction'))
 function Invoke-CafeStatusAction([string]$Action){Assert-True ($Action -ceq 'Execute') 'ACTUAL_EXECUTE_DISPATCH';return @{kind='OFFLINE_DISPATCH_PASS'}}
 $null=Invoke-Expression $dispatch;$cases++
 [ordered]@{kind='CAFE08_STATUS_WINDOW_CONTROL_SYNTHETIC_PASS';cases=$cases;providerRequests=0;remoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress
}catch{[ordered]@{kind='CAFE08_STATUS_WINDOW_CONTROL_SYNTHETIC_FAIL';cases=$cases;safeReason=$(if($_.Exception.Message -cmatch '^STATUS_TEST_[A-Z0-9_]+$'){$_.Exception.Message}else{'OFFLINE_TEST_REJECTED'});providerRequests=0;remoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress;exit 1}
