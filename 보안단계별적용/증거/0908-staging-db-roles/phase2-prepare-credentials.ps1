[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('G_DB_00_PHASE2_PREPARE_APPROVED_EXACT_V1')]
  [string]$ApprovalToken
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$secretLibPath = Join-Path $PSScriptRoot 'phase2-secret-lib.ps1'
$secretLibSha256 = '48ddce9d009f8c2e4aa46f18060608ed818807ceba546ea401666a20950fec2c'
if ((Get-FileHash -LiteralPath $secretLibPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
    $secretLibSha256) {
  throw 'R2A_SECRET_LIB_HASH_MISMATCH'
}
. $secretLibPath

$root = Get-R2ASecretRoot
$parent = Split-Path -Parent $root
Assert-R2ANotReparsePoint -Path $env:APPDATA
Assert-R2ANotReparsePoint -Path $parent
Assert-R2ANotReparsePoint -Path $root
if (-not (Test-Path -LiteralPath $parent)) {
  [void][IO.Directory]::CreateDirectory($parent)
}
Assert-R2ANotReparsePoint -Path $parent

$lockPath = Join-Path $parent 'staging-db-roles.phase2-prepare.lock'
$lock = [IO.FileStream]::new(
  $lockPath,
  [IO.FileMode]::CreateNew,
  [IO.FileAccess]::ReadWrite,
  [IO.FileShare]::None,
  1,
  [IO.FileOptions]::DeleteOnClose
)
try {
  Set-R2AUserSystemOnlyAcl -Path $lockPath -Directory $false
  if (Test-Path -LiteralPath $root) {
    Assert-R2ANotReparsePoint -Path $root
    Assert-R2AUserSystemOnlyAcl -Path $root
    $unexpected = @(Get-ChildItem -LiteralPath $root -Force | Where-Object {
      $_.Name -notin @(
        'meta_ads_stg_runtime.dpapi.json',
        'meta_ads_stg_migration.dpapi.json',
        'meta_ads_stg_backup.dpapi.json',
        'phase2-activation.json'
      )
    })
    if ($unexpected.Count -ne 0) { throw 'R2A_SECRET_STORE_UNEXPECTED_ITEM' }
    foreach ($role in $script:R2AAllowedRoles) {
      [void](Read-R2ACredentialRecord -Root $root -Role $role)
    }
    if (Test-Path -LiteralPath (Join-Path $root 'phase2-activation.json')) {
      throw 'R2A_SECRET_STORE_ALREADY_ACTIVATED_ROTATION_REQUIRES_NEW_GATE'
    }
    [pscustomobject]@{
      status = 'PHASE2_CREDENTIALS_ALREADY_PREPARED_NO_ROTATION'
      credentialMaterialState = 'stored'
      secretValuesOrHashesEmitted = $false
      operationalReady = $false
    } | ConvertTo-Json -Depth 4
    return
  }

  $candidateRoot = Join-Path $parent ('.staging-db-roles.candidate.' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($candidateRoot)
  Set-R2AUserSystemOnlyAcl -Path $candidateRoot -Directory $true
  $secrets = @{}
  try {
    foreach ($role in $script:R2AAllowedRoles) {
      do { $secret = New-R2APlaintextSecret } while ($secrets.Values -contains $secret)
      if ($secret -notmatch '^[A-Za-z0-9_-]{43}$') {
        throw 'R2A_GENERATED_SECRET_SHAPE_MISMATCH'
      }
      $secrets[$role] = $secret
    }
    foreach ($role in $script:R2AAllowedRoles) {
      $ciphertext = Protect-R2APlaintextSecret -Plaintext $secrets[$role]
      Write-R2ACredentialRecordCreateNew -Root $candidateRoot -Role $role -Ciphertext $ciphertext
    }
    foreach ($role in $script:R2AAllowedRoles) {
      [void](Read-R2ACredentialRecord -Root $candidateRoot -Role $role)
    }
    [IO.Directory]::Move($candidateRoot, $root)
    Assert-R2AUserSystemOnlyAcl -Path $root
  } finally {
    if (Test-Path -LiteralPath $candidateRoot) {
      [IO.Directory]::Delete($candidateRoot, $true)
    }
    $secrets.Clear()
  }

  [pscustomobject]@{
    status = 'PHASE2_CREDENTIALS_PREPARED_STORED'
    secretRoot = $root
    roleCount = 3
    credentialMaterialState = 'stored'
    generator = 'DOTNET_CSPRNG_32_BYTES_BASE64URL_NO_PADDING'
    protection = 'DPAPI_CURRENT_USER_AND_USER_SYSTEM_ONLY_ACL'
    secretValuesOrHashesEmitted = $false
    operationalReady = $false
  } | ConvertTo-Json -Depth 4
} finally {
  $lock.Dispose()
}
