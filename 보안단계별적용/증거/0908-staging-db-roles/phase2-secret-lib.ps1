Set-StrictMode -Version Latest

$script:R2ASecretStoreVersion = 'r2a-staging-role-credential/v1'
$script:R2AAllowedRoles = @(
  'meta_ads_stg_runtime',
  'meta_ads_stg_migration',
  'meta_ads_stg_backup'
)
$script:R2AEntropy = [Text.Encoding]::UTF8.GetBytes('meta-ads-security-r2a-staging-role-v1')

function Get-R2ASecretRoot {
  if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
    throw 'R2A_SECRET_APPDATA_MISSING'
  }
  return [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'MetaAdsSecurity\staging-db-roles'))
}

function Assert-R2ANotReparsePoint {
  param([Parameter(Mandatory)][string]$Path)

  $currentPath = [IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrWhiteSpace($currentPath)) {
    if (Test-Path -LiteralPath $currentPath) {
      $item = Get-Item -LiteralPath $currentPath -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'R2A_SECRET_REPARSE_POINT_REJECTED'
      }
    }
    $parentPath = [IO.Path]::GetDirectoryName($currentPath)
    if ([string]::IsNullOrWhiteSpace($parentPath) -or
        $parentPath.Equals($currentPath, [StringComparison]::OrdinalIgnoreCase)) { break }
    $currentPath = $parentPath
  }
}

function Set-R2AUserSystemOnlyAcl {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][bool]$Directory
  )

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [Security.Principal.SecurityIdentifier]::new(
    [Security.Principal.WellKnownSidType]::LocalSystemSid,
    $null
  )
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  if (-not $Directory) {
    $acl = [Security.AccessControl.FileSecurity]::new()
  }
  $acl.SetOwner($currentSid)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
  $propagation = [Security.AccessControl.PropagationFlags]::None
  if ($Directory) {
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  foreach ($sid in @($currentSid, $systemSid)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      $propagation,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-R2AUserSystemOnlyAcl {
  param([Parameter(Mandatory)][string]$Path)

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [Security.Principal.SecurityIdentifier]::new(
    [Security.Principal.WellKnownSidType]::LocalSystemSid,
    $null
  )
  $allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  [void]$allowed.Add($currentSid.Value)
  [void]$allowed.Add($systemSid.Value)

  $acl = Get-Acl -LiteralPath $Path
  if ($acl.Owner -ne $currentSid.Value -and
      $acl.Owner -ne ([Security.Principal.NTAccount]$currentSid.Translate([Security.Principal.NTAccount])).Value) {
    throw 'R2A_SECRET_OWNER_MISMATCH'
  }
  if (-not $acl.AreAccessRulesProtected) {
    throw 'R2A_SECRET_ACL_INHERITANCE_ENABLED'
  }
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  $effectiveAllowSids = @($rules | Where-Object {
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
  } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
  if ($effectiveAllowSids.Count -ne 2 -or
      -not $allowed.Contains($effectiveAllowSids[0]) -or
      -not $allowed.Contains($effectiveAllowSids[1])) {
    throw 'R2A_SECRET_ACL_BROAD_OR_INCOMPLETE'
  }
}

function New-R2APlaintextSecret {
  $bytes = [byte[]]::new(32)
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  try {
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Protect-R2APlaintextSecret {
  param([Parameter(Mandatory)][string]$Plaintext)

  Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($Plaintext)
  try {
    $cipherBytes = [Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $script:R2AEntropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    try {
      return [Convert]::ToBase64String($cipherBytes)
    } finally {
      [Array]::Clear($cipherBytes, 0, $cipherBytes.Length)
    }
  } finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  }
}

function Unprotect-R2APlaintextSecret {
  param([Parameter(Mandatory)][string]$Ciphertext)

  Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
  $cipherBytes = [Convert]::FromBase64String($Ciphertext)
  try {
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
      $cipherBytes,
      $script:R2AEntropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    try {
      return [Text.Encoding]::UTF8.GetString($plainBytes)
    } finally {
      [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    }
  } finally {
    [Array]::Clear($cipherBytes, 0, $cipherBytes.Length)
  }
}

function Get-R2ASecretFilePath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][ValidateSet('meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_stg_backup')]
    [string]$Role
  )
  return Join-Path $Root "$Role.dpapi.json"
}

function Read-R2ACredentialRecord {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][ValidateSet('meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_stg_backup')]
    [string]$Role
  )

  $path = Get-R2ASecretFilePath -Root $Root -Role $Role
  Assert-R2ANotReparsePoint -Path $path
  Assert-R2AUserSystemOnlyAcl -Path $path
  $record = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
  if ($record.version -ne $script:R2ASecretStoreVersion -or $record.role -ne $Role -or
      $record.projectRef -ne 'ehnfrrmbkvlsbpvqcvkr' -or
      $record.database -ne 'meta_ads_staging' -or
      $record.state -ne 'stored' -or
      [string]::IsNullOrWhiteSpace($record.ciphertext)) {
    throw 'R2A_SECRET_RECORD_CONTRACT_MISMATCH'
  }
  return $record
}

function Write-R2ACredentialRecordCreateNew {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][ValidateSet('meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_stg_backup')]
    [string]$Role,
    [Parameter(Mandatory)][string]$Ciphertext
  )

  $path = Get-R2ASecretFilePath -Root $Root -Role $Role
  $record = [ordered]@{
    version = $script:R2ASecretStoreVersion
    role = $Role
    projectRef = 'ehnfrrmbkvlsbpvqcvkr'
    database = 'meta_ads_staging'
    state = 'stored'
    createdAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    ciphertext = $Ciphertext
  }
  $json = ($record | ConvertTo-Json -Depth 4) + "`n"
  $encoding = [Text.UTF8Encoding]::new($false)
  $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = $encoding.GetBytes($json)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
  } finally {
    $stream.Dispose()
  }
  Set-R2AUserSystemOnlyAcl -Path $path -Directory $false
  Assert-R2AUserSystemOnlyAcl -Path $path
}

function Write-R2AActivationMarkerCreateNew {
  param([Parameter(Mandatory)][string]$Root)

  foreach ($role in $script:R2AAllowedRoles) {
    [void](Read-R2ACredentialRecord -Root $Root -Role $role)
  }
  $path = Join-Path $Root 'phase2-activation.json'
  if (Test-Path -LiteralPath $path) {
    throw 'R2A_ACTIVATION_MARKER_ALREADY_EXISTS'
  }
  $candidate = Join-Path $Root ('.phase2-activation.candidate.' + [Guid]::NewGuid().ToString('N'))
  $record = [ordered]@{
    version = 'r2a-staging-role-activation/v1'
    projectRef = 'ehnfrrmbkvlsbpvqcvkr'
    database = 'meta_ads_staging'
    status = 'active_verified'
    activatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    roleCount = 3
    operationalReady = $false
  }
  $json = ($record | ConvertTo-Json -Depth 4) + "`n"
  $stream = [IO.File]::Open($candidate, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
  } finally {
    $stream.Dispose()
  }
  try {
    Set-R2AUserSystemOnlyAcl -Path $candidate -Directory $false
    Assert-R2AUserSystemOnlyAcl -Path $candidate
    [IO.File]::Move($candidate, $path)
    Assert-R2AUserSystemOnlyAcl -Path $path
  } finally {
    if (Test-Path -LiteralPath $candidate) {
      [IO.File]::Delete($candidate)
    }
  }
}

function Read-R2AActivationMarker {
  param([Parameter(Mandatory)][string]$Root)

  $path = Join-Path $Root 'phase2-activation.json'
  Assert-R2ANotReparsePoint -Path $path
  Assert-R2AUserSystemOnlyAcl -Path $path
  $record = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
  if ($record.version -ne 'r2a-staging-role-activation/v1' -or
      $record.projectRef -ne 'ehnfrrmbkvlsbpvqcvkr' -or
      $record.database -ne 'meta_ads_staging' -or
      $record.status -ne 'active_verified' -or
      [int]$record.roleCount -ne 3 -or
      $record.operationalReady -ne $false -or
      [string]::IsNullOrWhiteSpace([string]$record.activatedAtUtc)) {
    throw 'R2A_ACTIVATION_MARKER_CONTRACT_MISMATCH'
  }
  return $record
}
