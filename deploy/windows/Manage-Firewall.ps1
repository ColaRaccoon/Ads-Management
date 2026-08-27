#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Apply','Rollback','Verify')][string]$Action='Plan',
  [string[]]$AllowedCidrs,[string]$LanBindAddress,
  [string]$NodeProgramPath,[string]$ExpectedNodeSha256,
  [string]$EdgeServiceAccount,[string]$EvidenceOutputPath,
  [string]$EdgeServiceName='MetaAdsPerformanceEdge',
  [string]$RuleName='MetaAdsPerformance-Https443-PrivateLan',
  [string]$DisplayName='Meta Ads Performance HTTPS 443',
  [ValidateSet('Apply','Rollback','VerifyEvidence')][string]$PlannedAction,[string]$ApprovedPlanSha256,[string]$ApprovalNonce,[string]$ApprovalIssuedAt,[string]$ApprovalExpiresAt,[string]$ApprovalInstanceId,[string]$ApprovalLedgerPath,[switch]$Approved
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')

function Resolve-Sid([string]$Account){if(-not$Account){throw 'DEDICATED_EDGE_ACCOUNT_REQUIRED'};return([Security.Principal.NTAccount]$Account).Translate([Security.Principal.SecurityIdentifier]).Value}
function Ipv4Number([string]$Address){$parts=$Address.Split('.');if($parts.Count-ne4){throw 'IPV4_INVALID'};[uint64]$value=0;foreach($part in $parts){$octet=0;if(-not[int]::TryParse($part,[ref]$octet)-or$octet-lt0-or$octet-gt255){throw 'IPV4_INVALID'};$value=($value*256)+$octet};return $value}
function IsPrivateIpv4([string]$Address){try{$parts=$Address.Split('.')|ForEach-Object{[int]$_};return $parts.Count-eq4-and($parts[0]-eq10-or($parts[0]-eq172-and$parts[1]-ge16-and$parts[1]-le31)-or($parts[0]-eq192-and$parts[1]-eq168))}catch{return $false}}
function Validate-Cidr([string]$Cidr){$parts=$Cidr.Split('/');if($parts.Count-ne2-or-not(IsPrivateIpv4 $parts[0])-or$parts[1]-cne'32'){throw 'EXACT_CLIENT_IPV4_32_REQUIRED'}}
function FullFile([string]$Path,[string]$Code){if(-not$Path-or-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw $Code};return [IO.Path]::GetFullPath($Path)}
function Touches-ProtectedPort($PortFilter){
  $protected=@(443,3200,4200,5432,55432,6543)
  $ports=@($PortFilter.LocalPort|ForEach-Object{([string]$_).Split(',')}|ForEach-Object{$_.Trim()}|Where-Object{$_})
  foreach($entry in $ports){
    if($entry-eq'Any'){return $true}
    if($entry-match'^(\d+)-(\d+)$'){$first=[int]$Matches[1];$last=[int]$Matches[2];if($first-gt$last){return $true};if($protected|Where-Object{$_-ge$first-and$_-le$last}){return $true};continue}
    $number=0;if([int]::TryParse($entry,[ref]$number)){if($number-in$protected){return $true};continue}
    return $true
  }
  return $false
}
function Conflicting-AllowRules([string]$IntendedName){
  $conflicts=New-Object 'System.Collections.Generic.List[string]'
  foreach($candidate in @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction Stop)){
    if($candidate.Name-eq$IntendedName){continue}
    foreach($portFilter in @($candidate|Get-NetFirewallPortFilter)){
      if(Touches-ProtectedPort $portFilter){$conflicts.Add([string]$candidate.Name)|Out-Null;break}
    }
  }
  return @($conflicts|Sort-Object -Unique)
}
function Get-InboundPolicyState {
  $profiles=@(Get-NetFirewallProfile -Profile Domain,Private,Public -ErrorAction Stop)
  if($profiles.Count-ne3){throw 'FIREWALL_PROFILE_CARDINALITY_INVALID'}
  $state=[ordered]@{}
  foreach($profile in $profiles){
    $name=[string]$profile.Name
    $state[$name]=[ordered]@{enabled=[bool]$profile.Enabled;defaultInboundAction=[string]$profile.DefaultInboundAction}
  }
  return [pscustomobject]@{Profiles=$profiles;State=$state;AllProfilesEnabled=(@($profiles|Where-Object{-not[bool]$_.Enabled}).Count-eq0);AllDefaultInboundBlocked=(@($profiles|Where-Object{[string]$_.DefaultInboundAction-ne'Block'}).Count-eq0)}
}
function New-FirewallApprovalPlan([string]$IntendedAction){
  if($IntendedAction-notin@('Apply','Rollback','VerifyEvidence')){throw 'PLANNED_ACTION_REQUIRED'}
  if($RuleName-notmatch'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'){throw 'FIREWALL_PLAN_RULE_NAME_INVALID'}
  $parameters=[ordered]@{ruleName=$RuleName}
  if($IntendedAction-ne'Rollback'){
    if($EdgeServiceName-cne'MetaAdsPerformanceEdge'-or-not$EdgeServiceAccount){throw 'FIREWALL_PLAN_SERVICE_INVALID'}
    if(-not(IsPrivateIpv4 $LanBindAddress)){throw 'FIREWALL_PLAN_BIND_ADDRESS_INVALID'}
    $cidrs=Get-ApprovalSorted $AllowedCidrs 'FIREWALL_PLAN_CLIENT_CIDRS_REQUIRED';foreach($cidr in $cidrs){Validate-Cidr $cidr}
    $parameters=[ordered]@{ruleName=$RuleName;displayName=$DisplayName;edgeServiceName=$EdgeServiceName;edgeServiceAccount=$EdgeServiceAccount;lanBindAddress=$LanBindAddress;allowedClientCidrs=$cidrs;nodeProgramPath=(Get-ApprovalPath $NodeProgramPath 'FIREWALL_PLAN_NODE_PATH_REQUIRED');nodeProgramSha256=(Get-ApprovalHash $ExpectedNodeSha256 'FIREWALL_PLAN_NODE_HASH_REQUIRED');localPort=443;profiles=@('Domain','Private');edgeTraversal='Block'}
    if($IntendedAction-eq'VerifyEvidence'){$parameters.evidenceOutputPath=Get-ApprovalPath $EvidenceOutputPath 'FIREWALL_PLAN_EVIDENCE_PATH_REQUIRED'}
  }
  $target=if($IntendedAction-eq'Rollback'){"Remove exact firewall rule Name=$RuleName"}else{"Exact HTTPS 443 firewall rule Name=$RuleName on $LanBindAddress for $(@($parameters.allowedClientCidrs)-join',')"}
  $impact=if($IntendedAction-eq'Apply'){'Creates one Domain/Private inbound allow rule for exact client /32 addresses; global policy, router, Web/API/DB ports remain unchanged'}elseif($IntendedAction-eq'Rollback'){'Removes only the exact named firewall rule'}else{'Writes non-secret firewall verification evidence only after the exact rule and protected-port boundary pass'}
  $rollback=if($IntendedAction-eq'Apply'){"Remove only exact rule Name=$RuleName using a separately approved Rollback plan"}elseif($IntendedAction-eq'Rollback'){'Recreate only from a new approved Apply plan'}else{'Delete only the exact evidence output file'}
  return New-ApprovalPlan $PSCommandPath $IntendedAction $parameters $target $impact $rollback
}
if($Action-eq'Plan'){
  New-FirewallApprovalPlan $PlannedAction|ConvertTo-Json -Depth 12;exit 0
}
$firewallMutation=if($Action-in@('Apply','Rollback')){$Action}elseif($Action-eq'Verify'-and$EvidenceOutputPath){'VerifyEvidence'}else{$null}
if($firewallMutation){Assert-ApprovedPlan (New-FirewallApprovalPlan $firewallMutation) ([bool]$Approved) $ApprovedPlanSha256}
if($Action-eq'Rollback'){
  $existing=@(Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue);if($existing.Count-gt1){throw 'FIREWALL_RULE_CARDINALITY_INVALID'}
  if($existing.Count-eq1){Remove-NetFirewallRule -Name $RuleName -ErrorAction Stop}
  if(Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue){throw 'FIREWALL_ROLLBACK_VERIFY_FAILED'}
  [pscustomobject]@{Result=if($existing.Count){'ROLLED_BACK'}else{'ROLLED_BACK_ABSENT'};RemovedRuleName=$RuleName;RouterChanged=$false}|ConvertTo-Json;exit 0
}
$node=FullFile $NodeProgramPath 'NODE_PROGRAM_NOT_FOUND'
if($ExpectedNodeSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash-ine$ExpectedNodeSha256){throw 'NODE_PROGRAM_HASH_MISMATCH'}
if(-not(IsPrivateIpv4 $LanBindAddress)){throw 'LAN_BIND_ADDRESS_INVALID'}
if(-not$AllowedCidrs-or$AllowedCidrs.Count-eq0){throw 'ALLOWED_CIDRS_REQUIRED'}
foreach($cidr in $AllowedCidrs){Validate-Cidr $cidr}
$edgeSid=Resolve-Sid $EdgeServiceAccount
if($edgeSid-in@('S-1-5-18','S-1-5-19','S-1-5-20','S-1-1-0','S-1-5-11','S-1-5-32-545')){throw 'DEDICATED_EDGE_ACCOUNT_REQUIRED'}
if($EdgeServiceName-cne'MetaAdsPerformanceEdge'){throw 'EDGE_SERVICE_NAME_INVALID'}
$rule=Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue
$policy=Get-InboundPolicyState

if($Action-eq'Verify'){
  $pass=$false;$conflicts=Conflicting-AllowRules $RuleName
  if($rule-and@($rule).Count-eq1){
    $ports=@($rule|Get-NetFirewallPortFilter);$addresses=@($rule|Get-NetFirewallAddressFilter);$apps=@($rule|Get-NetFirewallApplicationFilter);$services=@($rule|Get-NetFirewallServiceFilter);$interfaces=@($rule|Get-NetFirewallInterfaceFilter)
    if($ports.Count-ne1-or$addresses.Count-ne1-or$apps.Count-ne1-or$services.Count-ne1-or$interfaces.Count-ne1){throw 'FIREWALL_FILTER_CARDINALITY_INVALID'}
    $port=$ports[0];$address=$addresses[0];$app=$apps[0];$service=$services[0];$interface=$interfaces[0]
    $actualRemote=@($address.RemoteAddress|Sort-Object);$expectedRemote=@($AllowedCidrs|Sort-Object)
    $pass=$rule.Enabled-eq'True'-and$rule.Direction-eq'Inbound'-and$rule.Action-eq'Allow'-and([string]$rule.Profile)-eq'Domain, Private'-and
      $port.Protocol-eq'TCP'-and[string]$port.LocalPort-eq'443'-and[string]$address.LocalAddress-eq$LanBindAddress-and
      (($actualRemote-join',')-ceq($expectedRemote-join','))-and$app.Program-ieq$node-and
      [string]$service.Service-ceq$EdgeServiceName-and[string]$interface.InterfaceAlias-eq'Any'-and$rule.EdgeTraversalPolicy-eq'Block'-and$conflicts.Count-eq0-and$policy.AllDefaultInboundBlocked-and$policy.AllProfilesEnabled
  }
  if(-not$pass){[pscustomobject]@{Result='FAIL';RuleCount=@($rule).Count;ConflictingRuleCount=$conflicts.Count;DefaultInboundBlocked=$policy.AllDefaultInboundBlocked;ProfilePolicies=$policy.State;PublicProfileOpened=$null}|ConvertTo-Json -Depth 5;exit 1}
  if($EvidenceOutputPath){
    $output=[IO.Path]::GetFullPath($EvidenceOutputPath);$parent=Split-Path -Parent $output;if(-not(Test-Path -LiteralPath $parent -PathType Container)){throw 'FIREWALL_EVIDENCE_PARENT_NOT_FOUND'}
    $temp=Join-Path $parent ('.firewall-'+[Guid]::NewGuid().ToString('N')+'.tmp')
    try{[IO.File]::WriteAllText($temp,([ordered]@{version=4;result='PASS';ruleName=$RuleName;bindAddress=$LanBindAddress;allowedCidrs=@($AllowedCidrs|Sort-Object);exactClientAddresses=$true;protectedPorts=@(443,3200,4200,5432,55432,6543);nodeProgramPath=$node;nodeProgramSha256=$ExpectedNodeSha256.ToLowerInvariant();edgeServiceName=$EdgeServiceName;edgeServiceSid=$edgeSid;serviceRestricted=$true;publicProfileOpened=$false;conflictingAllowRulesAbsent=$true;internalPortsDenied=$true;allProfilesEnabled=$true;defaultInboundBlocked=$true;profilePolicies=$policy.State;routerChanged=$false;completedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)));Move-Item -LiteralPath $temp -Destination $output -Force}finally{Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue}
  }
  [pscustomobject]@{Result='PASS';RuleCount=1;ConflictingRuleCount=0;DefaultInboundBlocked=$true;PublicProfileOpened=$false;InternalPortsDenied=$true}|ConvertTo-Json;exit 0
}
if($rule){throw 'FIREWALL_RULE_ALREADY_EXISTS'}
if(-not$policy.AllDefaultInboundBlocked-or-not$policy.AllProfilesEnabled){throw 'FIREWALL_PROFILES_MUST_ALREADY_BE_ENABLED_AND_DEFAULT_INBOUND_BLOCK'}
$preexisting=Conflicting-AllowRules $RuleName;if($preexisting.Count){throw 'CONFLICTING_INBOUND_ALLOW_RULES_PRESENT'}
New-NetFirewallRule -Name $RuleName -DisplayName $DisplayName -Direction Inbound -Action Allow -Enabled True `
  -Profile Domain,Private -Protocol TCP -LocalPort 443 -LocalAddress $LanBindAddress -RemoteAddress $AllowedCidrs `
  -Program $node -Service $EdgeServiceName|Out-Null
[pscustomobject]@{Result='APPLIED';PublicProfileOpened=$false;RouterChanged=$false;WebApiDbRulesCreated=$false;VerifyRequired=$true}|ConvertTo-Json
