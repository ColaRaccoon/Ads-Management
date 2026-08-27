#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Merge')][string]$Action='Plan',[ValidateSet('PreOpen','Live')][string]$Phase='PreOpen',
  [string[]]$ClientEvidencePaths,[string[]]$ExpectedClientEvidenceSha256s,[string]$Hostname,[string]$ExpectedCaThumbprint,
  [string]$ExpectedServerCertificateSha256,[int]$ExpectedClientCount,[string]$ExpectedClientSetDigest,[string[]]$ExpectedAllowedClientCidrs,
  [string]$ExpectedReleaseId,[string]$OutputPath,[ValidateSet('Merge')][string]$PlannedAction,[string]$ApprovedPlanSha256,[switch]$Approved
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
function IsPrivateIpv4([string]$Address){try{$parts=$Address.Split('.')|ForEach-Object{[int]$_};return ($parts.Count-eq4-and($parts|Where-Object{$_-lt0-or$_-gt255}).Count-eq0-and($parts[0]-eq10-or($parts[0]-eq172-and$parts[1]-ge16-and$parts[1]-le31)-or($parts[0]-eq192-and$parts[1]-eq168)))}catch{return $false}}
function New-MergeApprovalPlan([string]$IntendedAction) {
  if($IntendedAction-cne'Merge'){throw'CLIENT_TRUST_MERGE_PLAN_ACTION_REQUIRED'};if(@($ClientEvidencePaths).Count-ne@($ExpectedClientEvidenceSha256s).Count-or@($ClientEvidencePaths).Count-lt1){throw'CLIENT_TRUST_MERGE_PLAN_INPUT_PAIR_REQUIRED'}
  $inputs=@();for($index=0;$index-lt$ClientEvidencePaths.Count;$index++){$inputs+=[ordered]@{path=Get-ApprovalPath $ClientEvidencePaths[$index] 'CLIENT_TRUST_MERGE_PLAN_INPUT_PATH_REQUIRED';sha256=Get-ApprovalHash $ExpectedClientEvidenceSha256s[$index] 'CLIENT_TRUST_MERGE_PLAN_INPUT_HASH_REQUIRED'}}
  $p=[ordered]@{phase=$Phase;inputs=@($inputs|Sort-Object path);hostname=Get-ApprovalText $Hostname '^[A-Za-z0-9.-]{1,253}$' 'CLIENT_TRUST_MERGE_PLAN_HOSTNAME_REQUIRED';caThumbprint=Get-ApprovalText $ExpectedCaThumbprint '^[A-Fa-f0-9]{40}$' 'CLIENT_TRUST_MERGE_PLAN_CA_REQUIRED';serverCertificateSha256=Get-ApprovalHash $ExpectedServerCertificateSha256 'CLIENT_TRUST_MERGE_PLAN_CERT_HASH_REQUIRED';expectedClientCount=$ExpectedClientCount;expectedClientSetDigest=Get-ApprovalHash $ExpectedClientSetDigest 'CLIENT_TRUST_MERGE_PLAN_CLIENT_SET_REQUIRED';allowedClientCidrs=@(Get-ApprovalSorted $ExpectedAllowedClientCidrs 'CLIENT_TRUST_MERGE_PLAN_CIDRS_REQUIRED');releaseId=$ExpectedReleaseId;outputPath=Get-ApprovalPath $OutputPath 'CLIENT_TRUST_MERGE_PLAN_OUTPUT_REQUIRED'}
  New-ApprovalPlan $PSCommandPath 'Merge' $p 'Exact client-trust inputs and aggregate evidence path' 'Reads only the hash-pinned client receipts and writes one non-secret aggregate used by the LAN fail-closed gate' 'Remove only the exact aggregate evidence file'
}
if($Action-eq'Plan'){New-MergeApprovalPlan $PlannedAction|ConvertTo-Json -Depth 12;exit 0};$approvalPlan=New-MergeApprovalPlan 'Merge';Assert-ApprovedPlan $approvalPlan ([bool]$Approved) $ApprovedPlanSha256
if(-not$ClientEvidencePaths-or$ClientEvidencePaths.Count-eq0-or$ExpectedClientCount-lt1-or$ExpectedClientCount-gt10000-or$ExpectedClientSetDigest-notmatch'^[a-f0-9]{64}$'-or$ExpectedCaThumbprint-notmatch'^[A-Fa-f0-9]{40}$'-or$ExpectedServerCertificateSha256-notmatch'^[A-Fa-f0-9]{64}$'-or@($ExpectedAllowedClientCidrs).Count-ne$ExpectedClientCount-or@($ExpectedAllowedClientCidrs|Where-Object{$_-notmatch'^(?:\d{1,3}\.){3}\d{1,3}/32$'-or-not(IsPrivateIpv4 ($_-replace'/32$',''))}).Count){throw 'CLIENT_EVIDENCE_REQUIRED'}
if($Phase-eq'Live'-and-not$ExpectedReleaseId){throw 'LIVE_RELEASE_ID_REQUIRED'}
$seen=New-Object 'System.Collections.Generic.HashSet[string]'
$seenAddresses=New-Object 'System.Collections.Generic.HashSet[string]'
$seenPlans=New-Object 'System.Collections.Generic.HashSet[string]'
for($inputIndex=0;$inputIndex-lt$ClientEvidencePaths.Count;$inputIndex++){$path=$ClientEvidencePaths[$inputIndex]
  if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'CLIENT_EVIDENCE_NOT_FOUND'}
  if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash-ine$ExpectedClientEvidenceSha256s[$inputIndex]){throw'CLIENT_EVIDENCE_HASH_MISMATCH'}
  $evidence=Get-Content -Raw -LiteralPath $path|ConvertFrom-Json;$age=(Get-Date).ToUniversalTime()-[datetime]$evidence.completedAt
  $expectedHttps=$Phase-eq'Live';$expectedRelease=if($expectedHttps){$ExpectedReleaseId}else{$null}
  if($evidence.version-ne3-or$evidence.result-ne'PASS'-or$evidence.phase-cne$Phase.ToUpperInvariant()-or$evidence.hostname-cne$Hostname-or$evidence.caThumbprint-ine$ExpectedCaThumbprint-or$evidence.serverCertificateSha256-ine$ExpectedServerCertificateSha256-or$evidence.clientIdHash-notmatch'^[0-9a-f]{64}$'-or-not(IsPrivateIpv4 ([string]$evidence.clientIpv4Address))-or$evidence.clientIpv4Cidr-cne"$($evidence.clientIpv4Address)/32"-or-not$evidence.clientAddressOwnershipVerified-or$evidence.verificationPlanSha256-notmatch'^[0-9a-f]{64}$'-or-not$evidence.trustStoreVerified-or-not$evidence.certificateChainVerified-or-not$evidence.hostnameVerified-or[bool]$evidence.httpsVerified-ne$expectedHttps-or$evidence.releaseId-cne$expectedRelease-or$age.TotalDays-gt7-or$age.TotalMinutes-lt-5-or-not$seen.Add($evidence.clientIdHash)-or-not$seenAddresses.Add([string]$evidence.clientIpv4Address)-or-not$seenPlans.Add([string]$evidence.verificationPlanSha256)){throw 'CLIENT_EVIDENCE_INVALID'}
}
if(Test-Path -LiteralPath $OutputPath){throw 'AGGREGATE_EVIDENCE_ALREADY_EXISTS'}
$sha=[Security.Cryptography.SHA256]::Create();try{$clientSetDigest=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((@($seen)|Sort-Object)-join"`n"))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
if($seen.Count-ne$ExpectedClientCount-or$clientSetDigest-cne$ExpectedClientSetDigest-or((@($seenAddresses|ForEach-Object{"$_/32"})|Sort-Object)-join'|')-cne((@($ExpectedAllowedClientCidrs)|Sort-Object)-join'|')){throw'CLIENT_SET_DOES_NOT_MATCH_INSTALLATION_PLAN'}
$planSha=[Security.Cryptography.SHA256]::Create();try{$verificationPlanSetDigest=[BitConverter]::ToString($planSha.ComputeHash([Text.Encoding]::UTF8.GetBytes((@($seenPlans)|Sort-Object)-join"`n"))).Replace('-','').ToLowerInvariant()}finally{$planSha.Dispose()}
$record=[ordered]@{version=4;result='PASS';phase=$Phase.ToUpperInvariant();hostname=$Hostname;caThumbprint=$ExpectedCaThumbprint.ToUpperInvariant();serverCertificateSha256=$ExpectedServerCertificateSha256.ToLowerInvariant();verifiedClientCount=$seen.Count;clientSetDigest=$clientSetDigest;allowedClientCidrs=@($ExpectedAllowedClientCidrs|Sort-Object);clientAddressMappingVerified=$true;clientAddressOwnershipVerified=$true;verificationPlanSetDigest=$verificationPlanSetDigest;httpsVerified=($Phase-eq'Live');releaseId=if($Phase-eq'Live'){$ExpectedReleaseId}else{$null};completedAt=(Get-Date).ToUniversalTime().ToString('o')}
[IO.File]::WriteAllText($OutputPath,($record|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
[pscustomobject]@{Result='PASS';Phase=$Phase;VerifiedClientCount=$seen.Count}|ConvertTo-Json
