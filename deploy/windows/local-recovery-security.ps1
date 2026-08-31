#Requires -Version 7.2

$script:RecoverySystemSid = 'S-1-5-18'
$script:RecoveryAdministratorsSid = 'S-1-5-32-544'
$script:RecoveryServiceRights = @(
  'SeServiceLogonRight','SeDenyInteractiveLogonRight','SeDenyRemoteInteractiveLogonRight','SeDenyNetworkLogonRight','SeDenyBatchLogonRight'
)

function Get-LocalRecoveryTextSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant()) } finally { $sha.Dispose() }
}

function Get-LocalRecoveryAccountSid([string]$Account,[string]$Code) {
  if (-not $Account -or $Account -notmatch '^[^\\]+\\[^\\]+$') { throw $Code }
  try { return ([Security.Principal.NTAccount]$Account).Translate([Security.Principal.SecurityIdentifier]).Value } catch { throw $Code }
}

function Get-LocalRecoveryRightsMap {
  $temporary = Join-Path ([IO.Path]::GetTempPath()) ('meta-recovery-rights-' + [guid]::NewGuid().ToString('N') + '.inf')
  try {
    & secedit.exe /export /cfg $temporary /areas USER_RIGHTS /quiet | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $temporary -PathType Leaf)) { throw 'LOCAL_RECOVERY_USER_RIGHTS_EXPORT_FAILED' }
    $result = [ordered]@{};$section = ''
    foreach ($line in [IO.File]::ReadAllLines($temporary,[Text.Encoding]::Unicode)) {
      $trim = $line.Trim()
      if ($trim -match '^\[(.+)\]$') { $section = $Matches[1];continue }
      if ($section -ne 'Privilege Rights' -or $trim -notmatch '^([^=]+)=(.*)$') { continue }
      $result[$Matches[1].Trim()] = @($Matches[2].Split(',') | ForEach-Object { $_.Trim().TrimStart('*') } | Where-Object { $_ })
    }
    return $result
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Assert-LocalRecoveryServiceRights($Rights,[string]$Sid,[string]$Code) {
  $actual = @($Rights.Keys | Where-Object { @($Rights[$_]) -contains $Sid } | Sort-Object)
  $expected = @($script:RecoveryServiceRights | Sort-Object)
  if (($actual -join '|') -cne ($expected -join '|')) { throw $Code }
}

function Assert-StoppedLocalRecoveryBoundary {
  param(
    [string]$CoreServiceName,[string]$EdgeServiceName,[string]$ExpectedCoreSid,[string]$ExpectedEdgeSid,
    [int]$WebPort,[int]$ApiPort
  )
  if ($CoreServiceName -notmatch '^[A-Za-z0-9._-]{1,128}$' -or $EdgeServiceName -notmatch '^[A-Za-z0-9._-]{1,128}$') { throw 'LOCAL_RECOVERY_SERVICE_NAME_INVALID' }
  if ($ExpectedCoreSid -notmatch '^S-1-[0-9-]+$' -or $ExpectedEdgeSid -notmatch '^S-1-[0-9-]+$' -or $ExpectedCoreSid -ceq $ExpectedEdgeSid) { throw 'LOCAL_RECOVERY_SERVICE_SID_INVALID' }
  if ($WebPort -ne 3200 -or $ApiPort -ne 4200) { throw 'LOCAL_RECOVERY_INTERNAL_PORT_CONTRACT_INVALID' }
  $core = Get-CimInstance Win32_Service -Filter "Name='$CoreServiceName'" -ErrorAction SilentlyContinue
  $edge = Get-CimInstance Win32_Service -Filter "Name='$EdgeServiceName'" -ErrorAction SilentlyContinue
  if (-not $core -or $core.State -cne 'Stopped' -or $core.StartMode -cne 'Disabled') { throw 'LOCAL_RECOVERY_CORE_SERVICE_NOT_DISABLED_AND_STOPPED' }
  if (-not $edge -or $edge.State -cne 'Stopped' -or $edge.StartMode -cne 'Disabled') { throw 'LOCAL_RECOVERY_EDGE_SERVICE_NOT_DISABLED_AND_STOPPED' }
  $coreSid = Get-LocalRecoveryAccountSid ([string]$core.StartName) 'LOCAL_RECOVERY_CORE_ACCOUNT_INVALID'
  $edgeSid = Get-LocalRecoveryAccountSid ([string]$edge.StartName) 'LOCAL_RECOVERY_EDGE_ACCOUNT_INVALID'
  if ($coreSid -cne $ExpectedCoreSid -or $edgeSid -cne $ExpectedEdgeSid) { throw 'LOCAL_RECOVERY_SERVICE_ACCOUNT_SID_MISMATCH' }
  $rights = Get-LocalRecoveryRightsMap
  Assert-LocalRecoveryServiceRights $rights $coreSid 'LOCAL_RECOVERY_CORE_RIGHTS_MISMATCH'
  Assert-LocalRecoveryServiceRights $rights $edgeSid 'LOCAL_RECOVERY_EDGE_RIGHTS_MISMATCH'
  if (@(Get-NetTCPConnection -State Listen -LocalPort 443,$WebPort,$ApiPort -ErrorAction SilentlyContinue).Count) { throw 'LOCAL_RECOVERY_PROTECTED_LISTENER_PRESENT' }
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
    if ($null -eq $owner -or [int]$owner.ReturnValue -ne 0 -or [string]$owner.Sid -notmatch '^S-1-[0-9-]+$') { throw 'LOCAL_RECOVERY_PROCESS_OWNER_UNVERIFIABLE' }
    if ([string]$owner.Sid -in @($coreSid,$edgeSid)) { throw 'LOCAL_RECOVERY_SERVICE_ACCOUNT_PROCESS_PRESENT' }
  }
  $identityDigest = Get-LocalRecoveryTextSha256 (@('stopped-local-services-v2',$CoreServiceName,[string]$core.StartName,$coreSid,'Stopped','Disabled',$EdgeServiceName,[string]$edge.StartName,$edgeSid,'Stopped','Disabled',"443|$WebPort|$ApiPort-absent",'service-rights-exact','service-sid-processes-absent') -join "`n")
  return [pscustomobject]@{IdentityDigest=$identityDigest;CoreServiceState='Stopped|Disabled';EdgeServiceState='Stopped|Disabled';CoreServiceSid=$coreSid;EdgeServiceSid=$edgeSid;ProtectedListenersAbsent=$true;ServiceAccountProcessesAbsent=$true;ServiceRightsExact=$true}
}

function Get-LocalRecoveryAclEntries([string]$Class,$FileSystemEvidence) {
  $full = [Security.AccessControl.FileSystemRights]::FullControl
  $modify = [Security.AccessControl.FileSystemRights]'Modify,Synchronize'
  $read = [Security.AccessControl.FileSystemRights]'ReadAndExecute,Synchronize'
  $entries = [ordered]@{$script:RecoverySystemSid=$full;$script:RecoveryAdministratorsSid=$full}
  if ($Class -ceq 'CORE_MODIFY') {
    $entries[[string]$FileSystemEvidence.coreServiceSid] = $modify
    $entries[[string]$FileSystemEvidence.backupSid] = $read
  } elseif ($Class -cne 'ADMIN_ONLY') { throw 'LOCAL_RECOVERY_ACL_CLASS_INVALID' }
  return $entries
}

function Get-LocalRecoveryTreeItems([string]$Root) {
  $full = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if (-not(Test-Path -LiteralPath $full -PathType Container)) { throw 'LOCAL_RECOVERY_ACL_ROOT_NOT_FOUND' }
  $pending = [Collections.Generic.Stack[string]]::new();$items = [Collections.Generic.List[string]]::new();$pending.Push($full)
  while ($pending.Count) {
    $current = $pending.Pop();$item = Get-Item -LiteralPath $current -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'LOCAL_RECOVERY_REPARSE_REJECTED' }
    $items.Add($item.FullName);if ($items.Count -gt 1000000) { throw 'LOCAL_RECOVERY_ACL_ITEM_LIMIT' }
    if ($item.PSIsContainer) { foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($item.FullName)) { $pending.Push($child) } }
  }
  return @($items)
}

function Set-LocalRecoveryExactAcl([string]$Root,[ValidateSet('CORE_MODIFY','ADMIN_ONLY')][string]$Class,$FileSystemEvidence) {
  $entries = Get-LocalRecoveryAclEntries $Class $FileSystemEvidence
  foreach ($path in Get-LocalRecoveryTreeItems $Root) {
    $item = Get-Item -LiteralPath $path -Force;$acl = Get-Acl -LiteralPath $path
    $acl.SetAccessRuleProtection($true,$false);foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
    $inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in $entries.Keys) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,$entries[$sid],$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))) }
    $acl.SetOwner([Security.Principal.SecurityIdentifier]$script:RecoveryAdministratorsSid);Set-Acl -LiteralPath $path -AclObject $acl
  }
}

function Test-LocalRecoveryAclDescriptor($Item,$Acl,$Entries) {
  try {
    if (-not $Acl.AreAccessRulesProtected -or $Acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value -cne $script:RecoveryAdministratorsSid -or @($Acl.Access).Count -ne $Entries.Count) { return $false }
    $inherit = if ($Item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($rule in @($Acl.Access)) {
      $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if (-not $Entries.Contains($sid) -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne $Entries[$sid] -or $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rule.IsInherited) { return $false }
    }
    return $true
  } catch { return $false }
}

function Assert-LocalRecoveryExactAcl([string]$Root,[ValidateSet('CORE_MODIFY','ADMIN_ONLY')][string]$Class,$FileSystemEvidence) {
  $entries = Get-LocalRecoveryAclEntries $Class $FileSystemEvidence
  foreach ($path in Get-LocalRecoveryTreeItems $Root) {
    $item = Get-Item -LiteralPath $path -Force;$acl = Get-Acl -LiteralPath $path
    if (-not(Test-LocalRecoveryAclDescriptor $item $acl $entries)) { throw 'LOCAL_RECOVERY_ACL_DESCRIPTOR_MISMATCH' }
  }
  return $true
}

function Assert-LocalRecoveryAclOneOf([string]$Root,[ValidateSet('CORE_MODIFY','ADMIN_ONLY')][string[]]$Classes,$FileSystemEvidence) {
  $expected = @($Classes | ForEach-Object { Get-LocalRecoveryAclEntries $_ $FileSystemEvidence })
  foreach ($path in Get-LocalRecoveryTreeItems $Root) {
    $item = Get-Item -LiteralPath $path -Force;$acl = Get-Acl -LiteralPath $path
    if (-not @($expected | Where-Object { Test-LocalRecoveryAclDescriptor $item $acl $_ }).Count) { throw 'LOCAL_RECOVERY_ACL_TRANSITION_DESCRIPTOR_REJECTED' }
  }
  return $true
}
