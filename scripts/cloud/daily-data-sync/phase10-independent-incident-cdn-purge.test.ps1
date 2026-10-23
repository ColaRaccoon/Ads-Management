Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-independent-incident-cdn-purge.ps1"
$script:Calls=0;$script:Attempt=$false;$script:WrongKey=$false;$script:ChangedBefore=$false;$script:Status=200;$script:ThrowHttp=$false;$script:Observed=$null
function Get-IncidentState{return @{variables=@{SUPABASE_URL='https://ehnfrrmbkvlsbpvqcvkr.supabase.co';SUPABASE_STORAGE_BUCKET='meta-ads-phase08-isolated';SUPABASE_SECRET_KEY=$(if($script:WrongKey){'sb_secret_syntheticOther'}else{'sb_secret_syntheticSame'})}}}
function Get-IncidentSnapshot{return @{runtime_role=@{login=$false};runtime_backends=0;table_digests=@{synthetic='same'};runtime_grants_md5='same'}}
function Assert-IncidentContained($Value){}
function Read-IncidentPrivate($Name){return @{variables=@{SUPABASE_SECRET_KEY='sb_secret_syntheticSame'}}}
function Read-IncidentStorageMaterial{return @{before=@{}}}
function Get-IncidentStorageSnapshot{return @{object_count=1;policy_md5='same'}}
function Assert-IncidentStorageChangedPolicies($Material,$Snapshot){if($script:ChangedBefore){throw 'SYNTHETIC_REJECT'}}
function Assert-IncidentStoragePreserved($Before,$After){}
function Get-IncidentHash($Value){return 'syntheticSameHash'}
function Write-IndependentIncidentCdnReceipt($Value,$Name){if($Name -ceq 'cdn-purge-attempt-v1'){if($script:Attempt){throw 'SYNTHETIC_CREATE_NEW'};$script:Attempt=$true}}
function Invoke-WebRequest {param($Uri,$Method,$Headers,$MaximumRedirection,$TimeoutSec,[switch]$SkipHttpErrorCheck);$script:Calls++;$script:Observed=@{uri=$Uri;method=$Method;headerNames=@($Headers.Keys);redirect=$MaximumRedirection};if($script:ThrowHttp){throw 'SYNTHETIC_PRIVATE_ERROR'};return @{StatusCode=$script:Status;Content='{"message":"success"}'}}
$passed=0
try{
 $r=Invoke-IndependentIncidentSentinelCdnPurge;if($r.kind -cne 'INCIDENT_EXACT_SENTINEL_CDN_PURGE_QUEUED' -or $script:Calls -ne 1 -or $r.oldBearerHttpDenialVerified -cne $false){throw 'QUEUED_IS_NOT_REVOKED'};$passed++
 if($script:Observed.uri -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co/storage/v1/cdn/meta-ads-phase08-isolated/health/readiness-sentinel' -or $script:Observed.method -cne 'Delete' -or $script:Observed.headerNames.Count -ne 1 -or $script:Observed.headerNames[0] -cne 'apikey' -or $script:Observed.redirect -ne 0){throw 'EXACT_SCOPE'};$passed++
 $r=Invoke-IndependentIncidentSentinelCdnPurge;if($script:Calls -ne 1 -or $r.mutationSubmitted){throw 'SECOND_REQUEST_BLOCKED'};$passed++
 $script:Attempt=$false;$script:WrongKey=$true;$r=Invoke-IndependentIncidentSentinelCdnPurge;if($script:Calls -ne 1 -or $r.mutationSubmitted){throw 'DIFFERENT_KEY_BLOCKED'};$script:WrongKey=$false;$passed++
 $script:ChangedBefore=$true;$r=Invoke-IndependentIncidentSentinelCdnPurge;if($script:Calls -ne 1 -or $r.mutationSubmitted){throw 'CAS_BLOCKED'};$script:ChangedBefore=$false;$passed++
 $script:Status=403;$r=Invoke-IndependentIncidentSentinelCdnPurge;if($script:Calls -ne 2 -or $r.httpStatus -ne 403 -or $r.broaderFallbackAllowed -cne $false){throw 'FEATURE_REJECTION_NO_FALLBACK'};$passed++
 $script:Attempt=$false;$script:ThrowHttp=$true;$r=Invoke-IndependentIncidentSentinelCdnPurge;$json=$r|ConvertTo-Json -Compress;if($script:Calls -ne 3 -or -not $r.outcomeUncertain -or $json.Contains('SYNTHETIC_PRIVATE_ERROR')){throw 'UNKNOWN_OUTCOME_SANITIZED'};$passed++
 @{kind='INCIDENT_EXACT_SENTINEL_CDN_PURGE_LOCAL_TEST';passed=$passed;remoteRequests=0;actualCredentialsRead=0;rawErrorSuppressed=$true}|ConvertTo-Json -Compress
}catch{@{kind='INCIDENT_EXACT_SENTINEL_CDN_PURGE_LOCAL_TEST';passed=$passed;status='FAIL';lastSafeStage=$r.stage;lastSafeKind=$r.kind;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
