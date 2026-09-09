[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('G_DB_00_PHASE2_RECOVERY_PREPARE_APPROVED_EXACT_V1')]
  [string]$ApprovalToken
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
  throw 'R2A_RECOVERY_POWERSHELL_7_REQUIRED'
}

$secretLibPath = Join-Path $PSScriptRoot 'phase2-secret-lib.ps1'
$secretLibSha256 = '48ddce9d009f8c2e4aa46f18060608ed818807ceba546ea401666a20950fec2c'
$classificationReceiptPath = Join-Path (
  Split-Path -Parent $PSScriptRoot
) '0909-g-db-00-phase2-readonly-classification.json'
$classificationReceiptBytes = 3698
$classificationReceiptSha256 = '807e0c52004beb235f2857077e42cc4e16951587dd3fcf2613f77b0d7ccdfe0d'
$phase1ReceiptSha256 = 'd596ccd6bc43d479705d43cdd720221cdc71dec3c242f52ace1d70cdaba04059'
$executionArtifactHashes = [ordered]@{
  secretLib = $secretLibSha256
  activationSql = '8b8527e25caff9fa9edab37420bd4808fbdf953fd75182a17e8e8c0c080671a7'
  roleVerifySql = '846762928ddc6012202fe989336536fd07c34dd37cd126591e81fe3da8043efe'
  finalVerifySql = '3c13be90502d9947cc13f7bf42eea1e796001a12cdb7ef1755b6b600ef26f184'
  containerEntrypoint = '3116be65ed91b60e9e3db6f191440eedab020a671d1c438c965b32fe4d9e2c41'
}

if ((Get-FileHash -LiteralPath $secretLibPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
    $secretLibSha256) {
  throw 'R2A_RECOVERY_SECRET_LIB_HASH_MISMATCH'
}
. $secretLibPath

function Get-R2AOriginalTreeFingerprint {
  param([Parameter(Mandatory)][string]$Root)
  $rootAcl = Get-Acl -LiteralPath $Root
  $rows = @("ROOT|$($rootAcl.Owner)|$($rootAcl.AreAccessRulesProtected)|$($rootAcl.Sddl)")
  $rows += @(Get-ChildItem -LiteralPath $Root -Force | Sort-Object Name | ForEach-Object {
    $acl = Get-Acl -LiteralPath $_.FullName
    $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.Name, $_.Length, $hash,
      $acl.Owner, $acl.AreAccessRulesProtected, $acl.Sddl
  })
  return $rows -join "`n"
}

function Assert-R2ARecoveryExecutionState {
  param([Parameter(Mandatory)][Collections.IDictionary]$Record)

  $expectedTopKeys = @(
    'version', 'status', 'startedAtUtc', 'updatedAtUtc', 'projectRef', 'host', 'port',
    'database', 'databaseOid', 'roleOids', 'phase1ReceiptSha256', 'artifactHashes',
    'commitAckObserved', 'verifiedRoleCount', 'finalAdminVerify', 'automaticRetryCount',
    'negativeAuthTestCount', 'verifyOnlyAttemptCount', 'secretValuesOrHashesStored',
    'operationalReady'
  )
  if ((@($Record.Keys | ForEach-Object { [string]$_ } | Sort-Object) -join "`n") -ne
      (@($expectedTopKeys | Sort-Object) -join "`n")) {
    throw 'R2A_RECOVERY_EXECUTION_STATE_KEYS_MISMATCH'
  }
  if (-not ($Record.roleOids -is [Collections.IDictionary]) -or
      (@($Record.roleOids.Keys | Sort-Object) -join "`n") -ne
        (@('backup', 'migration', 'runtime') -join "`n")) {
    throw 'R2A_RECOVERY_EXECUTION_STATE_ROLE_OID_KEYS_MISMATCH'
  }
  if (-not ($Record.artifactHashes -is [Collections.IDictionary]) -or
      (@($Record.artifactHashes.Keys | Sort-Object) -join "`n") -ne
        (@($executionArtifactHashes.Keys | Sort-Object) -join "`n")) {
    throw 'R2A_RECOVERY_EXECUTION_STATE_ARTIFACT_KEYS_MISMATCH'
  }
  if ($Record.version -cne 'r2a-phase2-execution-state/v1' -or
      $Record.status -cne 'COMMITTED_VERIFY_FAILED' -or
      $Record.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or
      $Record.host -cne 'aws-0-ap-northeast-2.pooler.supabase.com' -or
      $Record.port -ne 5432 -or
      $Record.database -cne 'meta_ads_staging' -or
      $Record.databaseOid -ne 25404 -or
      $Record.roleOids.runtime -ne 25397 -or
      $Record.roleOids.migration -ne 25399 -or
      $Record.roleOids.backup -ne 25401 -or
      $Record.phase1ReceiptSha256 -cne $phase1ReceiptSha256 -or
      $Record.commitAckObserved -ne $true -or
      $Record.verifiedRoleCount -ne 0 -or
      $Record.finalAdminVerify -ne $false -or
      $Record.automaticRetryCount -ne 0 -or
      $Record.negativeAuthTestCount -ne 0 -or
      $Record.verifyOnlyAttemptCount -ne 0 -or
      $Record.secretValuesOrHashesStored -ne $false -or
      $Record.operationalReady -ne $false) {
    throw 'R2A_RECOVERY_EXECUTION_STATE_SEMANTIC_MISMATCH'
  }
  foreach ($name in $executionArtifactHashes.Keys) {
    if ($Record.artifactHashes[$name] -cne $executionArtifactHashes[$name]) {
      throw 'R2A_RECOVERY_EXECUTION_STATE_ARTIFACT_HASH_MISMATCH'
    }
  }
}

function Assert-R2ARecoveryClassificationReceipt {
  param([Parameter(Mandatory)]$Record)

  if ($Record.version -cne 'g-db-00-phase2-readonly-classification/v1' -or
      $Record.status -cne 'CREDENTIAL_OR_VERIFIER_MISMATCH' -or
      $Record.approvedGate.commit -cne 'b2af0238cc47c2937d8a8838963483035db7c9d7' -or
      $Record.approvedGate.manifestSha256 -cne
        '59a57b4cdc8b71b1fe46ec4d81113cc9b4ea71879977b8861481381fb81d4dcf' -or
      $Record.approvedGate.finalAdminSqlSha256 -cne $executionArtifactHashes.finalVerifySql -or
      $Record.approvedGate.adminCatalogExecutionLimit -ne 1 -or
      $Record.target.organizationId -cne 'synohgzwspodxmfemoks' -or
      $Record.target.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or
      $Record.target.host -cne 'aws-0-ap-northeast-2.pooler.supabase.com' -or
      $Record.target.port -ne 5432 -or
      $Record.target.adminDatabase -cne 'postgres' -or
      $Record.target.applicationDatabase -cne 'meta_ads_staging' -or
      $Record.target.databaseOid -ne 25404 -or
      $Record.target.roleOids.runtime -ne 25397 -or
      $Record.target.roleOids.migration -ne 25399 -or
      $Record.target.roleOids.backup -ne 25401 -or
      $Record.priorFailure.receiptSha256 -cne
        '14b5d577b5427fbdd97fb669bded3af5dbd139a05f82ca74ee04ef3b2937d5f1' -or
      $Record.priorFailure.status -cne 'COMMITTED_VERIFY_FAILED' -or
      $Record.priorFailure.providerExecuteAttemptCount -ne 1 -or
      $Record.priorFailure.commitAckObserved -ne $true -or
      $Record.priorFailure.positiveRoleVerificationCount -ne 0 -or
      $Record.priorFailure.activeVerifiedMarkerPresent -ne $false -or
      $Record.adminCatalog.executionCount -ne 1 -or
      $Record.adminCatalog.transactionMode -cne 'BEGIN_READ_ONLY_ROLLBACK' -or
      $Record.adminCatalog.result -cne 'PASS' -or
      $Record.adminCatalog.providerMutation -ne $false -or
      $Record.adminCatalog.rawOutputStored -ne $false -or
      $Record.poolerLogs.rawLogsStored -ne $false -or
      $Record.classification.result -cne 'CREDENTIAL_OR_VERIFIER_MISMATCH' -or
      $Record.classification.credentialVersusVerifierCause -cne
        'UNRESOLVED_WITHOUT_SECRET_COMPARISON' -or
      $Record.classification.verifyOnlyAllowed -ne $false -or
      $Record.actions.activationRerun -cne 'NOT_RUN_PROHIBITED' -or
      $Record.actions.verifyOnly -cne
        'NOT_RUN_PROHIBITED_BY_CREDENTIAL_OR_VERIFIER_MISMATCH' -or
      $Record.credentialState.protectedDpapiRoleRecordCount -ne 3 -or
      $Record.credentialState.executionState -cne 'COMMITTED_VERIFY_FAILED' -or
      $Record.credentialState.retainedUnchanged -ne $true -or
      $Record.credentialState.secretValuesOrHashesEmitted -ne $false -or
      $Record.stagingMigration -cne 'NOT_RUN' -or
      $Record.operationalReady -ne $false) {
    throw 'R2A_RECOVERY_CLASSIFICATION_RECEIPT_SEMANTIC_MISMATCH'
  }
  foreach ($name in @('rawLog', 'userOrUsernameSuffix', 'password', 'verifier', 'connectionUri', 'token')) {
    if ($Record.secretBoundary.$name -ne $false) {
      throw 'R2A_RECOVERY_CLASSIFICATION_RECEIPT_SECRET_BOUNDARY_MISMATCH'
    }
  }
}

function Write-R2ARecoveryMetadataCreateNew {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$CandidateSetId,
    [Parameter(Mandatory)][string]$OriginalExecutionStateSha256
  )

  $path = Join-Path $Root 'recovery-candidate-set.json'
  $record = [ordered]@{
    version = 'r2a-staging-role-recovery-candidate-set/v1'
    status = 'PREPARED_NOT_ACTIVATED'
    candidateSetId = $CandidateSetId
    createdAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    projectRef = 'ehnfrrmbkvlsbpvqcvkr'
    database = 'meta_ads_staging'
    databaseOid = 25404
    roleOids = [ordered]@{ runtime = 25397; migration = 25399; backup = 25401 }
    roleCount = 3
    originalExecutionStateStatus = 'COMMITTED_VERIFY_FAILED'
    originalExecutionStateSha256 = $OriginalExecutionStateSha256
    classificationReceiptSha256 = $classificationReceiptSha256
    credentialsDifferFromAllOriginalAndCandidateValues = $true
    secretValuesOrHashesStoredInMetadata = $false
    activated = $false
    operationalReady = $false
  }
  $json = ($record | ConvertTo-Json -Depth 5) + "`n"
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
  $stream = [IO.File]::Open(
    $path,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    $stream.Dispose()
  }
  Set-R2AUserSystemOnlyAcl -Path $path -Directory $false
  Assert-R2AUserSystemOnlyAcl -Path $path
}

function Read-R2ARecoveryMetadata {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$OriginalExecutionStateSha256
  )

  $path = Join-Path $Root 'recovery-candidate-set.json'
  Assert-R2ANotReparsePoint -Path $path
  Assert-R2AUserSystemOnlyAcl -Path $path
  $record = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
  if ($record.version -cne 'r2a-staging-role-recovery-candidate-set/v1' -or
      $record.status -cne 'PREPARED_NOT_ACTIVATED' -or
      $record.candidateSetId -notmatch '^[a-f0-9]{32}$' -or
      $record.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or
      $record.database -cne 'meta_ads_staging' -or
      $record.databaseOid -ne 25404 -or
      $record.roleOids.runtime -ne 25397 -or
      $record.roleOids.migration -ne 25399 -or
      $record.roleOids.backup -ne 25401 -or
      $record.roleCount -ne 3 -or
      $record.originalExecutionStateStatus -cne 'COMMITTED_VERIFY_FAILED' -or
      $record.originalExecutionStateSha256 -cne $OriginalExecutionStateSha256 -or
      $record.classificationReceiptSha256 -cne $classificationReceiptSha256 -or
      $record.credentialsDifferFromAllOriginalAndCandidateValues -ne $true -or
      $record.secretValuesOrHashesStoredInMetadata -ne $false -or
      $record.activated -ne $false -or
      $record.operationalReady -ne $false) {
    throw 'R2A_RECOVERY_CANDIDATE_METADATA_MISMATCH'
  }
  return $record
}

function Assert-R2ARecoveryRootItems {
  param([Parameter(Mandatory)][string]$Root)

  $expected = @(
    'meta_ads_stg_runtime.dpapi.json',
    'meta_ads_stg_migration.dpapi.json',
    'meta_ads_stg_backup.dpapi.json',
    'recovery-candidate-set.json'
  )
  $actual = @(Get-ChildItem -LiteralPath $Root -Force | ForEach-Object { $_.Name } | Sort-Object)
  if (($actual -join "`n") -ne (@($expected | Sort-Object) -join "`n")) {
    throw 'R2A_RECOVERY_ROOT_ITEMS_MISMATCH'
  }
}

if (-not (Test-Path -LiteralPath $classificationReceiptPath -PathType Leaf) -or
    (Get-Item -LiteralPath $classificationReceiptPath).Length -ne $classificationReceiptBytes -or
    (Get-FileHash -LiteralPath $classificationReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
      $classificationReceiptSha256) {
  throw 'R2A_RECOVERY_CLASSIFICATION_RECEIPT_BYTES_OR_HASH_MISMATCH'
}
Assert-R2ANotReparsePoint -Path $classificationReceiptPath
$classificationReceipt = Get-Content -Raw -LiteralPath $classificationReceiptPath | ConvertFrom-Json
Assert-R2ARecoveryClassificationReceipt -Record $classificationReceipt

$originalRoot = Get-R2ASecretRoot
$parent = Split-Path -Parent $originalRoot
$recoveryRoot = [IO.Path]::GetFullPath((Join-Path $parent 'staging-db-roles-recovery'))
if ($originalRoot.Equals($recoveryRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'R2A_RECOVERY_ROOT_NOT_SEPARATE'
}
Assert-R2ANotReparsePoint -Path $env:APPDATA
Assert-R2ANotReparsePoint -Path $parent
Assert-R2ANotReparsePoint -Path $originalRoot
Assert-R2ANotReparsePoint -Path $recoveryRoot
if (-not (Test-Path -LiteralPath $originalRoot -PathType Container)) {
  throw 'R2A_RECOVERY_ORIGINAL_ROOT_MISSING'
}
Assert-R2AUserSystemOnlyAcl -Path $originalRoot

$originalExpectedItems = @(
  'meta_ads_stg_runtime.dpapi.json',
  'meta_ads_stg_migration.dpapi.json',
  'meta_ads_stg_backup.dpapi.json',
  'phase2-execution-state.json'
)
$originalActualItems = @(
  Get-ChildItem -LiteralPath $originalRoot -Force | ForEach-Object { $_.Name } | Sort-Object
)
if (($originalActualItems -join "`n") -ne (@($originalExpectedItems | Sort-Object) -join "`n")) {
  throw 'R2A_RECOVERY_ORIGINAL_ROOT_ITEMS_MISMATCH'
}
if (Test-Path -LiteralPath (Join-Path $originalRoot 'phase2-activation.json')) {
  throw 'R2A_RECOVERY_ACTIVE_VERIFIED_MARKER_PRESENT'
}

$executionStatePath = Join-Path $originalRoot 'phase2-execution-state.json'
Assert-R2ANotReparsePoint -Path $executionStatePath
Assert-R2AUserSystemOnlyAcl -Path $executionStatePath
$executionStateSha256 = (
  Get-FileHash -LiteralPath $executionStatePath -Algorithm SHA256
).Hash.ToLowerInvariant()
$executionState = Get-Content -Raw -LiteralPath $executionStatePath |
  ConvertFrom-Json -AsHashtable -DateKind String
Assert-R2ARecoveryExecutionState -Record $executionState

$lockPath = Join-Path $parent 'staging-db-roles.phase2-recovery-prepare.lock'
$lock = [IO.FileStream]::new(
  $lockPath,
  [IO.FileMode]::CreateNew,
  [IO.FileAccess]::ReadWrite,
  [IO.FileShare]::None,
  1,
  [IO.FileOptions]::DeleteOnClose
)
$executionLock = $null
$originalSecrets = @{}
$candidateSecrets = @{}
try {
  Set-R2AUserSystemOnlyAcl -Path $lockPath -Directory $false
  Assert-R2AUserSystemOnlyAcl -Path $lockPath

  $executionLockPath = Join-Path $parent 'staging-db-roles.phase2-recovery-source.lock'
  $executionLock = [IO.FileStream]::new(
    $executionLockPath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None,
    1,
    [IO.FileOptions]::DeleteOnClose
  )
  Set-R2AUserSystemOnlyAcl -Path $executionLockPath -Directory $false
  Assert-R2AUserSystemOnlyAcl -Path $executionLockPath
  $originalTreeFingerprint = Get-R2AOriginalTreeFingerprint -Root $originalRoot
  $lockedExecutionStateSha256 = (
    Get-FileHash -LiteralPath $executionStatePath -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if ($lockedExecutionStateSha256 -cne $executionStateSha256) {
    throw 'R2A_RECOVERY_EXECUTION_STATE_CHANGED_BEFORE_LOCK'
  }
  $lockedExecutionState = Get-Content -Raw -LiteralPath $executionStatePath |
    ConvertFrom-Json -AsHashtable -DateKind String
  Assert-R2ARecoveryExecutionState -Record $lockedExecutionState

  $staleCandidates = @(
    Get-ChildItem -LiteralPath $parent -Force |
      Where-Object { $_.Name -like '.staging-db-roles-recovery.candidate.*' }
  )
  if ($staleCandidates.Count -ne 0) {
    throw 'R2A_RECOVERY_STALE_CANDIDATE_REQUIRES_CLASSIFICATION'
  }

  foreach ($role in $script:R2AAllowedRoles) {
    $record = Read-R2ACredentialRecord -Root $originalRoot -Role $role
    $plain = Unprotect-R2APlaintextSecret -Ciphertext $record.ciphertext
    if ($plain -notmatch '^[A-Za-z0-9_-]{43}$') {
      throw 'R2A_RECOVERY_ORIGINAL_SECRET_SHAPE_MISMATCH'
    }
    $originalSecrets[$role] = $plain
  }
  if (@($originalSecrets.Values | Sort-Object -Unique).Count -ne 3) {
    throw 'R2A_RECOVERY_ORIGINAL_SECRETS_NOT_DISTINCT'
  }

  if (Test-Path -LiteralPath $recoveryRoot) {
    Assert-R2ANotReparsePoint -Path $recoveryRoot
    Assert-R2AUserSystemOnlyAcl -Path $recoveryRoot
    Assert-R2ARecoveryRootItems -Root $recoveryRoot
    [void](Read-R2ARecoveryMetadata `
      -Root $recoveryRoot `
      -OriginalExecutionStateSha256 $executionStateSha256)
    foreach ($role in $script:R2AAllowedRoles) {
      $record = Read-R2ACredentialRecord -Root $recoveryRoot -Role $role
      $plain = Unprotect-R2APlaintextSecret -Ciphertext $record.ciphertext
      if ($plain -notmatch '^[A-Za-z0-9_-]{43}$' -or
          $originalSecrets.Values -contains $plain -or
          $candidateSecrets.Values -contains $plain) {
        throw 'R2A_RECOVERY_EXISTING_CANDIDATE_SECRET_CONTRACT_MISMATCH'
      }
      $candidateSecrets[$role] = $plain
    }
    if (@($candidateSecrets.Values | Sort-Object -Unique).Count -ne 3) {
      throw 'R2A_RECOVERY_EXISTING_CANDIDATES_NOT_DISTINCT'
    }
    if ((Get-R2AOriginalTreeFingerprint -Root $originalRoot) -cne $originalTreeFingerprint) {
      throw 'R2A_RECOVERY_ORIGINAL_TREE_CHANGED'
    }
    [pscustomobject]@{
      status = 'PHASE2_RECOVERY_CANDIDATES_ALREADY_PREPARED_NO_ROTATION'
      roleCount = 3
      originalCredentialSetRetained = $true
      candidateCredentialSetActivated = $false
      secretValuesOrHashesEmitted = $false
      operationalReady = $false
    } | ConvertTo-Json -Depth 4
    return
  }

  $candidateSetId = [Guid]::NewGuid().ToString('N')
  $candidateRoot = [IO.Path]::GetFullPath((Join-Path $parent ".staging-db-roles-recovery.candidate.$candidateSetId"))
  if (-not [IO.Path]::GetDirectoryName($candidateRoot).Equals($parent,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'R2A_RECOVERY_CANDIDATE_SCOPE_INVALID'
  }
  [void][IO.Directory]::CreateDirectory($candidateRoot)
  Set-R2AUserSystemOnlyAcl -Path $candidateRoot -Directory $true
  Assert-R2AUserSystemOnlyAcl -Path $candidateRoot
  try {
    foreach ($role in $script:R2AAllowedRoles) {
      do {
        $plain = New-R2APlaintextSecret
      } while ($originalSecrets.Values -contains $plain -or
        $candidateSecrets.Values -contains $plain)
      if ($plain -notmatch '^[A-Za-z0-9_-]{43}$') {
        throw 'R2A_RECOVERY_GENERATED_SECRET_SHAPE_MISMATCH'
      }
      $candidateSecrets[$role] = $plain
    }
    foreach ($role in $script:R2AAllowedRoles) {
      $ciphertext = Protect-R2APlaintextSecret -Plaintext $candidateSecrets[$role]
      Write-R2ACredentialRecordCreateNew `
        -Root $candidateRoot `
        -Role $role `
        -Ciphertext $ciphertext
    }
    Write-R2ARecoveryMetadataCreateNew `
      -Root $candidateRoot `
      -CandidateSetId $candidateSetId `
      -OriginalExecutionStateSha256 $executionStateSha256
    Assert-R2ARecoveryRootItems -Root $candidateRoot
    foreach ($role in $script:R2AAllowedRoles) {
      [void](Read-R2ACredentialRecord -Root $candidateRoot -Role $role)
    }
    [void](Read-R2ARecoveryMetadata `
      -Root $candidateRoot `
      -OriginalExecutionStateSha256 $executionStateSha256)
    [IO.Directory]::Move($candidateRoot, $recoveryRoot)
    Assert-R2ANotReparsePoint -Path $recoveryRoot
    Assert-R2AUserSystemOnlyAcl -Path $recoveryRoot
    Assert-R2ARecoveryRootItems -Root $recoveryRoot
  } finally {
    if (Test-Path -LiteralPath $candidateRoot) {
      Assert-R2ANotReparsePoint -Path $candidateRoot
      [IO.Directory]::Delete($candidateRoot, $true)
    }
  }

  if ((Get-R2AOriginalTreeFingerprint -Root $originalRoot) -cne $originalTreeFingerprint) {
    throw 'R2A_RECOVERY_ORIGINAL_TREE_CHANGED'
  }
  [pscustomobject]@{
    status = 'PHASE2_RECOVERY_CANDIDATES_PREPARED_NOT_ACTIVATED'
    roleCount = 3
    originalCredentialSetRetained = $true
    candidateCredentialSetActivated = $false
    generator = 'DOTNET_CSPRNG_32_BYTES_BASE64URL_NO_PADDING'
    protection = 'DPAPI_CURRENT_USER_AND_USER_SYSTEM_ONLY_ACL'
    secretValuesOrHashesEmitted = $false
    operationalReady = $false
  } | ConvertTo-Json -Depth 4
} finally {
  $plain = $null
  $ciphertext = $null
  $candidateSecrets.Clear()
  $originalSecrets.Clear()
  if ($null -ne $executionLock) {
    $executionLock.Dispose()
  }
  $lock.Dispose()
}
