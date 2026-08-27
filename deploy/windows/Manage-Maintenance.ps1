#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Enable','Disable','Verify')][string]$Action='Plan',
  [string]$RuntimeConfigPath,[string]$ExpectedRuntimeConfigSha256,
  [string]$ServiceAccount,
  [string]$InternalProbeTokenFile,
  [string]$ReleaseSwitchJournalPath,
  [string]$NodePath,[string]$ExpectedNodeSha256,[string]$ReleaseRoot,
  [string]$RuntimeReadinessVerifierPath,[string]$ExpectedRuntimeReadinessVerifierSha256,
  [string]$HttpsVerifierPath,[string]$ExpectedHttpsVerifierSha256,
  [string]$ApprovalId,
  [switch]$InitialActivation,
  [ValidateSet('Enable','Disable')][string]$PlannedAction,[string]$ApprovedPlanSha256,[switch]$Approved
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
function ExistingFile([string]$Path,[string]$Code){if(-not$Path-or-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw$Code};$full=[IO.Path]::GetFullPath($Path);$cursor=Get-Item -LiteralPath $full -Force;while($cursor){if($cursor.Attributes-band[IO.FileAttributes]::ReparsePoint){throw'MAINTENANCE_EXECUTABLE_REPARSE_REJECTED'};$cursor=$cursor.Parent};return$full}
function FileHash([string]$Path){return(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function AssertPinned([string]$Path,[string]$Expected,[string]$Code){$file=ExistingFile $Path $Code;if($Expected-notmatch'^[A-Fa-f0-9]{64}$'-or(FileHash $file)-cne$Expected.ToLowerInvariant()){throw$Code};return$file}

function New-MaintenanceApprovalPlan([string]$IntendedAction){
  if($IntendedAction-notin@('Enable','Disable')){throw'PLANNED_ACTION_REQUIRED'}
  $parameters=[ordered]@{runtimeConfigPath=(Get-ApprovalPath $RuntimeConfigPath 'MAINTENANCE_PLAN_RUNTIME_PATH_REQUIRED');runtimeConfigSha256=(Get-ApprovalHash $ExpectedRuntimeConfigSha256 'MAINTENANCE_PLAN_RUNTIME_HASH_REQUIRED');serviceAccount=$ServiceAccount}
  if($IntendedAction-eq'Enable'){$parameters.approvalIdDigest=Get-ApprovalSha256 (Get-ApprovalText $ApprovalId '^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$' 'MAINTENANCE_PLAN_APPROVAL_ID_REQUIRED')}
  else{$parameters.internalProbeTokenPath=Get-ApprovalPath $InternalProbeTokenFile 'MAINTENANCE_PLAN_PROBE_PATH_REQUIRED';$parameters.releaseSwitchJournalPath=Get-ApprovalOptionalPath $ReleaseSwitchJournalPath;$parameters.nodePath=Get-ApprovalPath $NodePath 'MAINTENANCE_PLAN_NODE_PATH_REQUIRED';$parameters.nodeSha256=Get-ApprovalHash $ExpectedNodeSha256 'MAINTENANCE_PLAN_NODE_HASH_REQUIRED';$parameters.releaseRoot=Get-ApprovalPath $ReleaseRoot 'MAINTENANCE_PLAN_RELEASE_ROOT_REQUIRED';$parameters.runtimeReadinessVerifierPath=Get-ApprovalPath $RuntimeReadinessVerifierPath 'MAINTENANCE_PLAN_READINESS_PATH_REQUIRED';$parameters.runtimeReadinessVerifierSha256=Get-ApprovalHash $ExpectedRuntimeReadinessVerifierSha256 'MAINTENANCE_PLAN_READINESS_HASH_REQUIRED';$parameters.httpsVerifierPath=Get-ApprovalPath $HttpsVerifierPath 'MAINTENANCE_PLAN_HTTPS_PATH_REQUIRED';$parameters.httpsVerifierSha256=Get-ApprovalHash $ExpectedHttpsVerifierSha256 'MAINTENANCE_PLAN_HTTPS_HASH_REQUIRED';$parameters.initialActivation=[bool]$InitialActivation}
  $target="Exact maintenance flag derived from runtime config $($parameters.runtimeConfigSha256)"
  $impact=if($IntendedAction-eq'Enable'){'Creates one exact release-bound maintenance flag so HTTPS 443 returns 503 without forwarding new work'}else{'After exact readiness and HTTPS identity checks, removes only that maintenance flag'}
  $rollback=if($IntendedAction-eq'Enable'){'Use a separately approved Disable plan after readiness succeeds'}else{'Failure atomically restores the exact flag; re-enable otherwise requires a new plan'}
  return New-ApprovalPlan $PSCommandPath $IntendedAction $parameters $target $impact $rollback
}
if($Action-eq'Plan'){New-MaintenanceApprovalPlan $PlannedAction|ConvertTo-Json -Depth 12;exit 0}
if($Action-in@('Enable','Disable')){Assert-ApprovedPlan (New-MaintenanceApprovalPlan $Action) ([bool]$Approved) $ApprovedPlanSha256}
if(-not(Test-Path -LiteralPath $RuntimeConfigPath -PathType Leaf)){throw 'RUNTIME_CONFIG_NOT_FOUND'}
$runtimeConfigHash=FileHash $RuntimeConfigPath;if($runtimeConfigHash-cne$ExpectedRuntimeConfigSha256.ToLowerInvariant()){throw'RUNTIME_CONFIG_HASH_MISMATCH'}
$config=Get-Content -Raw -LiteralPath $RuntimeConfigPath|ConvertFrom-Json
if($config.data.root){$dataRoot=[IO.Path]::GetFullPath([string]$config.data.root)}else{
  $base=if($env:ProgramData){$env:ProgramData}else{$env:LOCALAPPDATA}
  if(-not$base){throw 'OS_APPLICATION_DATA_ROOT_UNAVAILABLE'}
  $dataRoot=[IO.Path]::GetFullPath((Join-Path $base 'MetaAdsPerformance'))
}
if(-not(Test-Path -LiteralPath $dataRoot -PathType Container)){throw 'DATA_ROOT_NOT_FOUND'}
$controlRoot=Join-Path $dataRoot 'runtime-control'
if(-not(Test-Path -LiteralPath $controlRoot -PathType Container)){throw 'RUNTIME_CONTROL_ROOT_NOT_FOUND'}
foreach($path in @($dataRoot,$controlRoot)){
  $item=Get-Item -LiteralPath $path -Force
  if($item.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'RUNTIME_CONTROL_REPARSE_REJECTED'}
}
if((Get-Volume -FilePath $controlRoot).FileSystem-ne'NTFS'){throw 'RUNTIME_CONTROL_MUST_BE_NTFS'}
if(-not$ServiceAccount){throw 'SERVICE_ACCOUNT_REQUIRED'}
$serviceSid=([Security.Principal.NTAccount]$ServiceAccount).Translate([Security.Principal.SecurityIdentifier]).Value
$acl=Get-Acl -LiteralPath $controlRoot
$serviceRules=@($acl.Access|Where-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value-eq$serviceSid})
if($serviceRules.Count-eq0-or$serviceRules|Where-Object{$_.AccessControlType-ne'Allow'-or($_.FileSystemRights-band[Security.AccessControl.FileSystemRights]::Write)-ne0}){throw 'RUNTIME_CONTROL_ACL_NOT_READ_ONLY'}
$flag=Join-Path $controlRoot 'maintenance.enabled'
if($Action-eq'Verify'){
  $enabled=$false;$flagRelease=$null;$flagApprovalDigest=$null
  if(Test-Path -LiteralPath $flag -PathType Leaf){$flagValue=Get-Content -Raw -LiteralPath $flag|ConvertFrom-Json;$enabled=$flagValue.version-eq1-and$flagValue.enabled-eq$true-and$flagValue.releaseId-ceq$config.release.id-and$flagValue.approvalIdDigest-match'^[0-9a-f]{64}$'-and([datetime]::Parse([string]$flagValue.enabledAt).ToUniversalTime()-le(Get-Date).ToUniversalTime());$flagRelease=$flagValue.releaseId;$flagApprovalDigest=$flagValue.approvalIdDigest}
  [pscustomobject]@{Result=if($enabled-or-not(Test-Path -LiteralPath $flag)){'PASS'}else{'FAIL'};MaintenanceEnabled=$enabled;ReleaseId=$flagRelease;ApprovalIdDigest=$flagApprovalDigest;ServiceCanWrite=$false}|ConvertTo-Json;if((Test-Path -LiteralPath $flag)-and-not$enabled){exit 1};exit 0
}
if($Action-eq'Enable'){
  if(Test-Path -LiteralPath $flag){throw 'MAINTENANCE_ALREADY_ENABLED'}
  if($ApprovalId-notmatch'^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$'){throw'APPROVAL_ID_REQUIRED'}
  $sha=[Security.Cryptography.SHA256]::Create();try{$approvalDigest=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ApprovalId))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  [IO.File]::WriteAllText($flag,([ordered]@{version=1;enabled=$true;releaseId=$config.release.id;approvalIdDigest=$approvalDigest;enabledAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
  if((Get-Item -LiteralPath $flag).Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'MAINTENANCE_FLAG_REPARSE_REJECTED'}
  [pscustomobject]@{Result='ENABLED';ServiceRestarted=$false;ExistingProcessesChanged=$false}|ConvertTo-Json;exit 0
}
if(-not(Test-Path -LiteralPath $flag -PathType Leaf)){throw 'MAINTENANCE_NOT_ENABLED'}
$flagValue=Get-Content -Raw -LiteralPath $flag|ConvertFrom-Json;if($flagValue.version-ne1-or$flagValue.enabled-ne$true-or$flagValue.releaseId-cne$config.release.id-or$flagValue.approvalIdDigest-notmatch'^[0-9a-f]{64}$'){throw'MAINTENANCE_FLAG_INVALID'}
if(-not$config.lan.enabled-or-not$config.release.id){throw 'FULL_LAN_RELEASE_REQUIRED'}
$node=AssertPinned $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH';$readinessVerifier=AssertPinned $RuntimeReadinessVerifierPath $ExpectedRuntimeReadinessVerifierSha256 'RUNTIME_READINESS_VERIFIER_HASH_MISMATCH';$httpsVerifier=AssertPinned $HttpsVerifierPath $ExpectedHttpsVerifierSha256 'HTTPS_VERIFIER_HASH_MISMATCH'
if(-not(Test-Path -LiteralPath $ReleaseRoot -PathType Container)){throw'RELEASE_ROOT_NOT_FOUND'};$releaseRootFull=[IO.Path]::GetFullPath($ReleaseRoot)
$releaseItem=Get-Item -LiteralPath $releaseRootFull -Force;if($releaseItem.Attributes-band[IO.FileAttributes]::ReparsePoint){throw'RELEASE_ROOT_REPARSE_REJECTED'}
$filesystem=Get-Content -Raw -LiteralPath ([string]$config.hostSecurity.filesystemEvidencePath)|ConvertFrom-Json
function UnderShared([string]$Path){$full=[IO.Path]::GetFullPath($Path);return@($filesystem.classRoots.SHARED_RUNTIME|Where-Object{$root=[IO.Path]::GetFullPath([string]$_).TrimEnd('\');$full-ieq$root-or$full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)}).Count-gt0}
if(-not(UnderShared $node)-or-not(UnderShared $readinessVerifier)-or-not(UnderShared $httpsVerifier)-or-not(UnderShared $releaseRootFull)){throw'MAINTENANCE_VERIFIER_OUTSIDE_SHARED_RUNTIME'}
if(-not(Test-Path -LiteralPath $InternalProbeTokenFile -PathType Leaf)){throw 'INTERNAL_PROBE_TOKEN_FILE_REQUIRED'}
$tokenItem=Get-Item -LiteralPath $InternalProbeTokenFile -Force;if($tokenItem.Attributes-band[IO.FileAttributes]::ReparsePoint-or$tokenItem.Length-lt32-or$tokenItem.Length-gt4096){throw 'INTERNAL_PROBE_TOKEN_FILE_INVALID'}
$probeToken=[IO.File]::ReadAllText([IO.Path]::GetFullPath($InternalProbeTokenFile)).Trim();if($probeToken.Length-lt32){throw 'INTERNAL_PROBE_TOKEN_INVALID'}
function Descendants([int]$RootPid){$all=@(Get-CimInstance Win32_Process);$ids=New-Object 'System.Collections.Generic.HashSet[int]';$ids.Add($RootPid)|Out-Null;do{$changed=$false;foreach($process in $all){if($ids.Contains([int]$process.ParentProcessId)-and-not$ids.Contains([int]$process.ProcessId)){$ids.Add([int]$process.ProcessId)|Out-Null;$changed=$true}}}while($changed);return$ids}
function AssertListener([int]$Port,[string]$Address,$Owners,[string]$Code){$listeners=@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue);if($listeners.Count-ne1-or$listeners[0].LocalAddress-ne$Address-or-not$Owners.Contains([int]$listeners[0].OwningProcess)){throw$Code}}
function Probe([string]$Url,[string]$Token,[string]$ExpectedStatus,[string]$ExpectedRelease){$request=[Net.HttpWebRequest]::Create($Url);$request.Proxy=$null;$request.Timeout=5000;if($Token){$request.Headers.Add('x-internal-probe-token',$Token)};$response=$request.GetResponse();try{$reader=New-Object IO.StreamReader($response.GetResponseStream());$body=$reader.ReadToEnd();if($body.Length-gt4096){return$false};$value=$body|ConvertFrom-Json;return[int]$response.StatusCode-eq200-and$value.status-eq$ExpectedStatus-and(-not$ExpectedRelease-or$value.releaseId-eq$ExpectedRelease)}finally{$response.Dispose()}}
$core=Get-CimInstance Win32_Service -Filter "Name='MetaAdsPerformanceCore'" -ErrorAction SilentlyContinue;$edge=Get-CimInstance Win32_Service -Filter "Name='MetaAdsPerformanceEdge'" -ErrorAction SilentlyContinue
if(-not$core-or-not$edge-or$core.State-ne'Running'-or$edge.State-ne'Running'-or[int]$core.ProcessId-le0-or[int]$edge.ProcessId-le0){throw 'CORE_EDGE_SERVICES_NOT_READY'}
$coreOwners=Descendants([int]$core.ProcessId);$edgeOwners=Descendants([int]$edge.ProcessId)
AssertListener ([int]$config.internalPorts.web) '127.0.0.1' $coreOwners 'WEB_LISTENER_OWNERSHIP_FAILED';AssertListener ([int]$config.internalPorts.api) '127.0.0.1' $coreOwners 'API_LISTENER_OWNERSHIP_FAILED';AssertListener 443 ([string]$config.lan.bindAddress) $edgeOwners 'EDGE_LISTENER_OWNERSHIP_FAILED'
if(-not(Probe "http://127.0.0.1:$($config.internalPorts.web)/backend-api/health/live" $null 'live' ([string]$config.release.id))-or-not(Probe "http://127.0.0.1:$($config.internalPorts.api)/api/health/ready" $probeToken 'ready' $null)){throw 'RELEASE_NOT_READY'}
if($ReleaseSwitchJournalPath){$journal=Get-Content -Raw -LiteralPath $ReleaseSwitchJournalPath|ConvertFrom-Json;if($journal.targetReleaseId-ne$config.release.id-or-not(Test-Path -LiteralPath ([string]$journal.previousReleaseRoot) -PathType Container)){throw 'ROLLBACK_JOURNAL_INVALID'}}elseif(-not$InitialActivation){throw 'ROLLBACK_JOURNAL_OR_INITIAL_ACTIVATION_REQUIRED'}
$runtimeConfigFull=[IO.Path]::GetFullPath($RuntimeConfigPath);&$node $readinessVerifier "--runtime-config=$runtimeConfigFull" "--release-root=$releaseRootFull" '--mode=operational' 2>$null|Out-Null;if($LASTEXITCODE-ne0){throw'OPERATIONAL_READINESS_FAILED'}
$flagText=Get-Content -Raw -LiteralPath $flag
Remove-Item -LiteralPath $flag -Force
try{&$node $httpsVerifier "--connect-address=$($config.lan.bindAddress)" "--hostname=$($config.lan.hostname)" "--ca=$($config.tls.caCertificatePath)" "--certificate=$($config.tls.serverCertificatePath)" "--release-id=$($config.release.id)" '--expected-status=200' 2>$null|Out-Null;if($LASTEXITCODE-ne0){throw'HTTPS_RELEASE_VERIFY_FAILED'}}catch{$pending="$flag.pending";[IO.File]::WriteAllText($pending,$flagText,(New-Object Text.UTF8Encoding($false)));Move-Item -LiteralPath $pending -Destination $flag -Force;throw'MAINTENANCE_DISABLE_ROLLED_BACK'}
$probeToken=$null
[pscustomobject]@{Result='DISABLED';ReadyVerified=$true;SignedRuntimeReadinessVerified=$true;PinnedHttps200Verified=$true;ListenerOwnershipVerified=$true;RollbackAvailable=[bool]$ReleaseSwitchJournalPath;ServiceRestarted=$false;ExistingProcessesChanged=$false}|ConvertTo-Json
