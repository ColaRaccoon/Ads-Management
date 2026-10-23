$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-cafe-pair-renew-20261021.ps1"
$script:Private=@{};$script:Receipts=@{};$script:Events=[Collections.Generic.List[string]]::new();$script:Posts=0;$script:Mutations=0;$script:BadResponse=$false;$script:ExistingCaptured=$false;$script:Stopped=$true
$script:Variables=[ordered]@{DAILY_SYNC_FEATURE_ENABLED='false';DAILY_SYNC_SCHEDULE_ENABLED='false';DAILY_SYNC_ACTIVE_KEY_VERSION='2';DAILY_SYNC_RETIRED_CREDENTIAL_KEY_VERSIONS='1';DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED='true';DAILY_SYNC_CREDENTIAL_KEY_V2='SYNTHETIC_KEY';PHASE08_SOURCE_CONTENT_SHA256='6d60d1662730508e19af171124310b82693c0687d86efdd76fa0663f367a767e';RELEASE_GIT_SHA='5bda544ec579a15745a93f89ee4fbc69bb7102f5'}
$script:CallbackVariables=[ordered]@{DAILY_SYNC_CAFE24_CLIENT_ID='SyntheticClient001';DAILY_SYNC_CAFE24_CLIENT_SECRET='SYNTHETIC_SECRET';DAILY_SYNC_FEATURE_ENABLED='false'}
$script:Tables=@(0..67|ForEach-Object {[ordered]@{table="synthetic_$_";rows=0;md5=('a'*32)}})
function Test-Path{param([string]$LiteralPath)if($LiteralPath.EndsWith('attempt.json')){return $script:Receipts.ContainsKey('attempt')};return $script:ExistingCaptured}
function Assert-Phase08PrivatePath{}
function Write-IncidentPrivate($Value,[string]$Name){$script:Events.Add('PRIVATE:'+$(if($Name.Contains('-response-')){'RESPONSE'}elseif($Name.Contains('-forward-')){'FORWARD'}elseif($Name.Contains('-plan-')){'PLAN'}else{'PROBE'}));if($script:Private.ContainsKey($Name)){throw 'SYNTHETIC_CREATE_NEW'};$script:Private[$Name]=$Value}
function Read-IncidentPrivate([string]$Name){if($Name -ceq 'cafe08-recovery-response-20261020-cafe08-read-recovery-a'){return @{bodyB64='SYNTHETIC_PROTECTED_BODY_ONLY'}};if($Name -ceq 'compromised-baseline'){return @{variables=$script:CallbackVariables}};return $script:Private[$Name]}
function Write-CafeRecoveryReceipt($Value,[string]$Name){if($script:Receipts.ContainsKey($Name)){throw 'SYNTHETIC_CREATE_NEW'};$script:Receipts[$Name]=$Value;$script:Events.Add('RECEIPT:'+$(if($Name -ceq 'attempt'){'ATTEMPT'}else{'OTHER'}))}
function Get-IncidentState{return @{variables=$script:Variables;serviceInstance=@{latestDeployment=@{id='39c6b738-6d2f-4111-a97b-37f017b39886';meta=@{imageDigest='sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0'}}}}}
function Get-IncidentSnapshot{return @{stopped=$true;paused=3;active_jobs=0;live_leases=0;runtime_role=[ordered]@{login=$false};runtime_backends=0;table_digests=$script:Tables;runtime_grants_md5=('a'*32);job_definitions_md5=('a'*32);other_jobs_md5=('a'*32);original152_md5=('a'*32);call_md5=('a'*32);storage_objects_md5=('a'*32)}}
function Get-CafeRecoveryCipherSnapshot{return @{connection=@{rowHash=('a'*32)};credentials=@(@{kind='CAFE24_ACCESS';rowHash=('a'*32)},@{kind='CAFE24_REFRESH';rowHash=('a'*32)})}}
function Assert-CafeRecoveryCallbackProof{return ('b'*64)}
function Invoke-Phase08SchedulerGraph($Query,$Variables){if($Query.Contains('deploymentStopped')){return @{serviceInstance=@{serviceId=$script:IncidentScope.s;environmentId=$script:IncidentScope.e;latestDeployment=@{id='39c6b738-6d2f-4111-a97b-37f017b39886';deploymentStopped=$script:Stopped};activeDeployments=@()}}};return @{variables=$script:CallbackVariables;serviceInstance=@{serviceId='deaaeaf9-ee5c-42fa-b32f-600c7a90befc';environmentId=$script:IncidentScope.e;latestDeployment=@{id='0f09de34-c1bf-4a1e-9a2a-fe511bbb07f3'}}}}
function Invoke-Phase08Management{$script:Mutations++;return @{credentialRows=2;connectionRows=1;auditRows=1;enabledRemainsFalse=$true}}
function Invoke-CafeRecoveryCallbackInspect{return @{mode='inspect';day='2026-10-01';connectionEnabled=$false;credentialRevisions=@(11,11);syncExecutionEvidence=@{leaseActive=$false};currentApiLines=477;currentApiVersions=477;currentApiLinks=477;lastSuccessPreserved=$true}}
function Invoke-CafeRecoveryChild($Value){switch($Value.action){
 'PREPARE'{return @{operationKey=$script:CafeRecoveryOperation;eligibleSecretRollback=$false;expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(15).ToString('o');snapshot=$Value.input.snapshot;safeSummary=@{preparedOnly=$true;providerRequests=0}}}
 'SUBMIT_ONCE'{$script:Posts++;$script:Events.Add('POST');return @{operationKey=$script:CafeRecoveryOperation;httpStatus=200;bodyB64='SYNTHETIC_PROTECTED_ONLY';eligibleSecretRollback=$false}}
 'FINALIZE'{$script:Events.Add('VALIDATE');if($script:BadResponse){throw 'SYNTHETIC_RESPONSE_SCOPE_REJECTION'};return @{mutationSql='SYNTHETIC_CAS_SQL';eligibleSecretRollback=$false}}
 'VERIFY'{return @{verified=$true}}
 default{throw 'UNEXPECTED_CHILD'}
}}
function Assert-True($Condition,[string]$Name){if(-not $Condition){throw ('SYNTHETIC_RECOVERY_TEST_'+$Name)}}
function Reset-Test{$script:Private=@{};$script:Receipts=@{};$script:Events.Clear();$script:Posts=0;$script:Mutations=0;$script:BadResponse=$false;$script:ExistingCaptured=$false;$script:Stopped=$true;$script:Tables[0].rows=0}
$cases=0
try{
 Reset-Test;$result=Invoke-CafeRecoveryAction Prepare;Assert-True ($result.kind -ceq 'CAFE08_RECOVERY_PREPARED' -and $script:Posts -eq 0 -and $script:Mutations -eq 0) 'PREPARE_RO';$cases++
 $script:BadResponse=$true;$result=Invoke-CafeRecoveryAction Refresh;Assert-True ($result.stage -ceq 'VALIDATE_SEALED_RESPONSE' -and $script:Posts -eq 1 -and $script:Mutations -eq 0) 'SCOPE_FAIL_NO_SQL';Assert-True ($script:Events.IndexOf('PRIVATE:RESPONSE') -lt $script:Events.IndexOf('VALIDATE') -and $script:Events.IndexOf('RECEIPT:ATTEMPT') -lt $script:Events.IndexOf('POST')) 'PROTECT_BEFORE_VALIDATE';$cases++
 $result=Invoke-CafeRecoveryAction Refresh;Assert-True ($result.stage -ceq 'START' -and $script:Posts -eq 1) 'NO_REPEAT_AFTER_FAILURE';$cases++
 Reset-Test;$script:ExistingCaptured=$true;$result=Invoke-CafeRecoveryAction Prepare;Assert-True ($result.stage -ceq 'START' -and $script:Posts -eq 0) 'EXISTING_RESPONSE_BLOCK';$cases++
 Reset-Test;$script:Stopped=$false;$result=Invoke-CafeRecoveryAction Prepare;Assert-True ($result.stage -ceq 'HELD_RUNTIME' -and $script:Posts -eq 0) 'DEPLOYMENT_RUNNING_BLOCK';$cases++
 Reset-Test;$null=Invoke-CafeRecoveryAction Prepare;$script:Tables[0].rows=1;$result=Invoke-CafeRecoveryAction Refresh;Assert-True ($result.stage -ceq 'READONLY_PAIR' -and $script:Posts -eq 0) 'BEFORE68_DRIFT_BLOCK';$cases++
 Reset-Test;$null=Invoke-CafeRecoveryAction Prepare;$result=Invoke-CafeRecoveryAction Refresh;Assert-True ($result.kind -ceq 'CAFE08_RECOVERY_VERIFIED' -and $script:Posts -eq 1 -and $script:Mutations -eq 1 -and $result.callbackRevision11StillVerified) 'SUCCESS_CALLBACK_PRESERVED';$cases++
 [ordered]@{kind='CAFE08_RECOVERY_CONTROL_SYNTHETIC_PASS';cases=$cases;providerRequests=0;remoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress
}catch{[ordered]@{kind='CAFE08_RECOVERY_CONTROL_SYNTHETIC_FAIL';cases=$cases;safeReason=$(if($_.Exception.Message -cmatch '^SYNTHETIC_RECOVERY_TEST_[A-Z0-9_]+$'){$_.Exception.Message}else{'TEST_TOOL_REJECTED'});providerRequests=0;remoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress;exit 1}
