#Requires -Version 7.2
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'local-recovery-security.ps1')

$script:coreSid='S-1-5-21-100-200-300-1001';$script:edgeSid='S-1-5-21-100-200-300-1002'
$script:coreMode='Disabled';$script:edgeMode='Disabled';$script:listenerPresent=$false;$script:processOwnerSid=$null;$script:dropCoreDeny=$false

function Get-CimInstance {
  param([Parameter(Position=0)]$ClassName,[string]$Filter)
  if($ClassName-eq'Win32_Service'){
    if($Filter-like"*MetaAdsPerformanceCore*"){return [pscustomobject]@{State='Stopped';StartMode=$script:coreMode;StartName='HOST\core'}}
    return [pscustomobject]@{State='Stopped';StartMode=$script:edgeMode;StartName='HOST\edge'}
  }
  if($script:processOwnerSid){return ,([pscustomobject]@{ProcessId=1234})}
  return @()
}
function Get-LocalRecoveryAccountSid([string]$Account,[string]$Code){if($Account-like'*\core'){return $script:coreSid};if($Account-like'*\edge'){return $script:edgeSid};throw $Code}
function Get-LocalRecoveryRightsMap {
  $map=[ordered]@{}
  foreach($right in $script:RecoveryServiceRights){$members=@($script:edgeSid);if(-not($script:dropCoreDeny-and$right-eq'SeDenyNetworkLogonRight')){$members+=,$script:coreSid};$map[$right]=$members}
  return $map
}
function Get-NetTCPConnection {param([object]$State,[object]$LocalPort);if($script:listenerPresent){return ,([pscustomobject]@{LocalPort=443})};return @()}
function Invoke-CimMethod {param($InputObject,[string]$MethodName);return [pscustomobject]@{ReturnValue=0;Sid=$script:processOwnerSid}}

function Expect-Rejection([scriptblock]$Work,[string]$Code){try{&$Work;throw 'EXPECTED_REJECTION_NOT_OBSERVED'}catch{if($_.Exception.Message-cne$Code){throw}}}

$ok=Assert-StoppedLocalRecoveryBoundary -CoreServiceName MetaAdsPerformanceCore -EdgeServiceName MetaAdsPerformanceEdge -ExpectedCoreSid $script:coreSid -ExpectedEdgeSid $script:edgeSid -WebPort 3200 -ApiPort 4200
if(-not$ok.ServiceRightsExact-or-not$ok.ServiceAccountProcessesAbsent-or-not$ok.ProtectedListenersAbsent-or$ok.IdentityDigest-notmatch'^[0-9a-f]{64}$'){throw 'HAPPY_PATH_FAILED'}

$script:coreMode='Auto';Expect-Rejection {Assert-StoppedLocalRecoveryBoundary -CoreServiceName MetaAdsPerformanceCore -EdgeServiceName MetaAdsPerformanceEdge -ExpectedCoreSid $script:coreSid -ExpectedEdgeSid $script:edgeSid -WebPort 3200 -ApiPort 4200} 'LOCAL_RECOVERY_CORE_SERVICE_NOT_DISABLED_AND_STOPPED';$script:coreMode='Disabled'
$script:dropCoreDeny=$true;Expect-Rejection {Assert-StoppedLocalRecoveryBoundary -CoreServiceName MetaAdsPerformanceCore -EdgeServiceName MetaAdsPerformanceEdge -ExpectedCoreSid $script:coreSid -ExpectedEdgeSid $script:edgeSid -WebPort 3200 -ApiPort 4200} 'LOCAL_RECOVERY_CORE_RIGHTS_MISMATCH';$script:dropCoreDeny=$false
$script:listenerPresent=$true;Expect-Rejection {Assert-StoppedLocalRecoveryBoundary -CoreServiceName MetaAdsPerformanceCore -EdgeServiceName MetaAdsPerformanceEdge -ExpectedCoreSid $script:coreSid -ExpectedEdgeSid $script:edgeSid -WebPort 3200 -ApiPort 4200} 'LOCAL_RECOVERY_PROTECTED_LISTENER_PRESENT';$script:listenerPresent=$false
$script:processOwnerSid=$script:coreSid;Expect-Rejection {Assert-StoppedLocalRecoveryBoundary -CoreServiceName MetaAdsPerformanceCore -EdgeServiceName MetaAdsPerformanceEdge -ExpectedCoreSid $script:coreSid -ExpectedEdgeSid $script:edgeSid -WebPort 3200 -ApiPort 4200} 'LOCAL_RECOVERY_SERVICE_ACCOUNT_PROCESS_PRESENT';$script:processOwnerSid=$null

[pscustomobject]@{result='PASS';happyPathVerified=$true;automaticCoreRejected=$true;rightsDriftRejected=$true;listenerRejected=$true;orphanProcessRejected=$true}|ConvertTo-Json -Compress
