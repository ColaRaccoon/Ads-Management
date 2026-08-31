#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Apply','Verify')][string]$Action = 'Plan',
  [ValidateSet('RETURN_FORWARD','ACCEPT_ROLLBACK_DROP_PRESERVED')][string]$Mode,
  [string]$RuntimeConfigPath,[string]$ExpectedRuntimeConfigSha256,
  [string]$RollbackJournalPath,[string]$ExpectedRollbackJournalSha256,
  [string]$RollbackEvidencePath,[string]$ExpectedRollbackEvidenceSha256,
  [string]$RestoreReceiptPublicKeyPath,[string]$ExpectedRestoreReceiptPublicKeySha256,
  [string]$NodePath,[string]$ExpectedNodeSha256,
  [string]$AttestationVerifierPath,[string]$ExpectedAttestationVerifierSha256,
  [string]$PsqlPath,[string]$ExpectedPsqlSha256,
  [string]$PgPassFile,[string]$ExpectedPgPassSha256,
  [string]$CaCertificatePath,[string]$ExpectedCaCertificateSha256,
  [string]$FileSystemEvidencePath,[string]$ExpectedFileSystemEvidenceSha256,
  [string]$MaintenanceFlagPath,[string]$ExpectedMaintenanceFlagSha256,
  [string]$ExpectedMaintenanceApprovalIdDigest,
  [ValidateSet('ACTIVE_LOCAL_EDGE','LEGACY_QUIESCED_NO_EDGE')][string]$EdgeStateMode = 'ACTIVE_LOCAL_EDGE',
  [string]$DrainStatePath,[string]$ExpectedDrainStateSha256,
  [string]$EdgeReleaseRoot,[string]$ExpectedEdgeReleaseManifestSha256,
  [string]$EdgeDrainHelperPath,[string]$ExpectedEdgeDrainHelperSha256,
  [string]$EdgeSigningPublicKeyPath,[string]$ExpectedEdgeSigningPublicKeySha256,
  [ValidatePattern('^[A-Za-z0-9._-]{1,128}$')][string]$EdgeServiceName = 'MetaAdsPerformanceEdge',
  [string]$LegacyQuiesceEvidencePath,[string]$ExpectedLegacyQuiesceEvidenceSha256,
  [string]$QuiesceReceiptPublicKeyPath,[string]$ExpectedQuiesceReceiptPublicKeySha256,
  [string]$FinalizationJournalPath,[string]$ExpectedFinalizationJournalSha256,
  [string]$ExpectedApplyPlanSha256,
  [string]$ConfirmProjectRef,[string]$ConfirmDatabaseHost,[string]$ConfirmDatabaseName,
  [string]$ConfirmDatabaseSchema,[string]$ConfirmDatabaseUser,
  [ValidateSet('Apply','VerifyEvidence')][string]$PlannedAction,
  [string]$ApprovedPlanSha256,[string]$ApprovalNonce,[string]$ApprovalIssuedAt,
  [string]$ApprovalExpiresAt,[string]$ApprovalInstanceId,[string]$ApprovalLedgerPath,
  [switch]$Approved
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')

$script:MaximumLegacyQuiesceAgeSeconds = 14400
$script:MaximumEdgeDrainAgeSeconds = 30
$script:MaximumJsonBytes = 16777216
$script:edgeDrainHelper = $null
if ($EdgeStateMode -eq 'ACTIVE_LOCAL_EDGE') {
  $script:edgeDrainHelper = if ($EdgeDrainHelperPath) {
    [IO.Path]::GetFullPath($EdgeDrainHelperPath)
  } else {
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'edge-drain-identity.ps1'))
  }
  . (Import-PinnedHelperScriptBlock $script:edgeDrainHelper $ExpectedEdgeDrainHelperSha256 'ROLLBACK_FINALIZE_EDGE_DRAIN_HELPER_HASH_MISMATCH')
}

function Get-FileSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Assert-NoReparse([string]$Path) {
  $cursor = Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force
  while ($cursor) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ROLLBACK_FINALIZE_REPARSE_REJECTED' }
    $cursor = $cursor.Parent
  }
}

function Get-PinnedFile([string]$Path,[string]$Expected,[string]$Code,[long]$MaximumBytes = 1073741824) {
  if (-not $Path -or -not(Test-Path -LiteralPath $Path -PathType Leaf)) { throw $Code }
  $full = [IO.Path]::GetFullPath($Path)
  Assert-NoReparse $full
  $item = Get-Item -LiteralPath $full -Force
  if ($item.Length -lt 1 -or $item.Length -gt $MaximumBytes -or $Expected -notmatch '^[A-Fa-f0-9]{64}$' -or (Get-FileSha256 $full) -cne $Expected.ToLowerInvariant()) { throw $Code }
  return $full
}

function Read-BoundedJson([string]$Path,[string]$Code,[long]$MaximumBytes = $script:MaximumJsonBytes) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt $MaximumBytes -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw $Code }
  try { return Get-Content -Raw -LiteralPath $item.FullName | ConvertFrom-Json -Depth 64 } catch { throw $Code }
}

function Test-UnderClass([string]$Path,$Roots) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  return @($Roots | Where-Object {
    $root = [IO.Path]::GetFullPath([string]$_).TrimEnd('\')
    $full -ieq $root -or $full.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)
  }).Count -gt 0
}

function Quote-Identifier([string]$Value) {
  if ($Value -notmatch '^[a-z][a-z0-9_]{0,62}$') { throw 'ROLLBACK_FINALIZE_IDENTIFIER_REJECTED' }
  return '"' + $Value + '"'
}

function Stop-ProcessTree([Diagnostics.Process]$Process) {
  if ($Process -and -not $Process.HasExited) {
    $Process.Kill($true)
    if (-not $Process.WaitForExit(5000)) { throw 'ROLLBACK_FINALIZE_PROCESS_TREE_KILL_TIMEOUT' }
  }
}

function Invoke-Bounded([string]$Executable,[string[]]$Arguments,[hashtable]$Environment,[string]$Code) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Executable
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  foreach ($name in @('DATABASE_URL','PGPASSWORD','PGPASSFILE','PGSSLMODE','PGSSLROOTCERT','PGOPTIONS','PGCONNECT_TIMEOUT','PGAPPNAME')) { [void]$info.Environment.Remove($name) }
  foreach ($entry in $Environment.GetEnumerator()) { $info.Environment[$entry.Key] = [string]$entry.Value }
  foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  $watch = [Diagnostics.Stopwatch]::StartNew()
  try {
    if (-not $process.Start()) { throw "$Code`_START_FAILED" }
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errTask = $process.StandardError.ReadToEndAsync()
    while (-not $process.WaitForExit(250)) {
      if ($watch.Elapsed.TotalMinutes -ge 5) { Stop-ProcessTree $process;throw "$Code`_TIMEOUT" }
    }
    $stdout = $outTask.GetAwaiter().GetResult()
    $stderr = $errTask.GetAwaiter().GetResult()
    if (($stdout.Length + $stderr.Length) -gt 1048576) { throw "$Code`_OUTPUT_LIMIT" }
    if ($process.ExitCode -ne 0) { throw $Code }
    return $stdout.Trim()
  } finally {
    Stop-ProcessTree $process
    $process.Dispose()
    $watch.Stop()
  }
}

function Write-DurableJson([string]$Path,$Value,[switch]$CreateOnly) {
  $full = [IO.Path]::GetFullPath($Path)
  $parent = Split-Path -Parent $full
  if (-not(Test-Path -LiteralPath $parent -PathType Container)) { throw 'ROLLBACK_FINALIZE_OUTPUT_PARENT_REQUIRED' }
  Assert-NoReparse $parent
  if ($CreateOnly -and (Test-Path -LiteralPath $full)) { throw 'ROLLBACK_FINALIZE_OUTPUT_ALREADY_EXISTS' }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 32 -Compress))
  if ($bytes.Length -gt 1048576) { throw 'ROLLBACK_FINALIZE_OUTPUT_LIMIT' }
  $pending = Join-Path $parent ('.rollback-finalize-' + [guid]::NewGuid().ToString('N') + '.pending')
  try {
    $stream = [IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($pending,$full,-not $CreateOnly)
    $committed = [IO.FileStream]::new($full,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough)
    try { $committed.Flush($true) } finally { $committed.Dispose() }
  } finally {
    [Array]::Clear($bytes,0,$bytes.Length)
    if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
  }
}

function Assert-MaintenanceState($Config,[string]$FlagPath) {
  $flag = Read-BoundedJson $FlagPath 'ROLLBACK_FINALIZE_MAINTENANCE_INVALID' 1048576
  try { $enabledAt = [datetimeoffset]::ParseExact([string]$flag.enabledAt,'o',[Globalization.CultureInfo]::InvariantCulture) } catch { throw 'ROLLBACK_FINALIZE_MAINTENANCE_INVALID' }
  $dataRoot = if ($Config.data.root) {
    [IO.Path]::GetFullPath([string]$Config.data.root)
  } else {
    $base = if ($env:ProgramData) { $env:ProgramData } else { $env:LOCALAPPDATA }
    if (-not $base) { throw 'ROLLBACK_FINALIZE_APPLICATION_DATA_ROOT_REQUIRED' }
    [IO.Path]::GetFullPath((Join-Path $base 'MetaAdsPerformance'))
  }
  $expectedFlag = [IO.Path]::GetFullPath((Join-Path $dataRoot 'runtime-control\maintenance.enabled'))
  if ([IO.Path]::GetFullPath($FlagPath) -ine $expectedFlag -or
      $flag.version -ne 1 -or $flag.enabled -ne $true -or
      $flag.releaseId -cne $Config.release.id -or
      $ExpectedMaintenanceApprovalIdDigest -notmatch '^[0-9a-fA-F]{64}$' -or
      $flag.approvalIdDigest -cne $ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant() -or
      $enabledAt -gt [datetimeoffset]::UtcNow.AddMinutes(5)) {
    throw 'ROLLBACK_FINALIZE_MAINTENANCE_SEMANTICS_REJECTED'
  }
  return [pscustomobject]@{ReleaseId=[string]$flag.releaseId;ApprovalIdDigest=[string]$flag.approvalIdDigest;EnabledAt=$enabledAt.ToUniversalTime().ToString('o')}
}

function Assert-LegacyQuiescence($Config,$RollbackEvidence,[string]$Node,[string]$Verifier) {
  $quiesce = Get-PinnedFile $LegacyQuiesceEvidencePath $ExpectedLegacyQuiesceEvidenceSha256 'ROLLBACK_FINALIZE_LEGACY_QUIESCE_HASH_MISMATCH' $script:MaximumJsonBytes
  $public = Get-PinnedFile $QuiesceReceiptPublicKeyPath $ExpectedQuiesceReceiptPublicKeySha256 'ROLLBACK_FINALIZE_QUIESCE_PUBLIC_KEY_HASH_MISMATCH' 1048576
  [void](Invoke-Bounded $Node @($Verifier,$public,$quiesce,'legacy-quiesce') @{} 'ROLLBACK_FINALIZE_QUIESCE_SIGNATURE_REJECTED')
  $value = Read-BoundedJson $quiesce 'ROLLBACK_FINALIZE_LEGACY_QUIESCE_INVALID'
  try { $completed = [datetimeoffset]::ParseExact([string]$value.completedAt,'o',[Globalization.CultureInfo]::InvariantCulture) } catch { throw 'ROLLBACK_FINALIZE_LEGACY_QUIESCE_INVALID' }
  $age = ([datetimeoffset]::UtcNow - $completed).TotalSeconds
  if ($value.attestationType -cne 'legacy-quiesce' -or $value.version -ne 2 -or $value.result -cne 'PASS' -or
      @($value.ports).Count -ne 2 -or (@($value.ports) -join '|') -cne '3100|4100' -or
      -not $value.legacyIdentityHealthSmokeVerifiedBeforeStop -or -not $value.processesStopped -or -not $value.listenersAbsent -or $value.databaseMutated -or
      $value.baselineSha256 -cne $RollbackEvidence.baselineSha256 -or
      $value.processIdentityDigest -cne $RollbackEvidence.legacyProcessIdentityDigest -or
      $value.restartCanonicalDigest -cne $RollbackEvidence.legacyRestartCanonicalDigest -or
      [int]$value.webProcessId -ne [int]$RollbackEvidence.legacyWebProcessId -or
      [int]$value.apiProcessId -ne [int]$RollbackEvidence.legacyApiProcessId -or
      $ExpectedLegacyQuiesceEvidenceSha256.ToLowerInvariant() -cne $RollbackEvidence.legacyQuiesceEvidenceSha256 -or
      $age -lt -300 -or $age -gt $script:MaximumLegacyQuiesceAgeSeconds) {
    throw 'ROLLBACK_FINALIZE_LEGACY_QUIESCE_SEMANTICS_REJECTED'
  }
  if (Get-Process -Id ([int]$value.webProcessId),([int]$value.apiProcessId) -ErrorAction SilentlyContinue) { throw 'ROLLBACK_FINALIZE_LEGACY_WRITER_PRESENT' }
  if (@(Get-NetTCPConnection -State Listen -LocalPort 3100,4100 -ErrorAction SilentlyContinue).Count) { throw 'ROLLBACK_FINALIZE_LEGACY_LISTENER_PRESENT' }
  if (@(Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue).Count) { throw 'ROLLBACK_FINALIZE_LEGACY_MODE_EDGE_LISTENER_PRESENT' }
  $service = Get-CimInstance Win32_Service -Filter "Name='$EdgeServiceName'" -ErrorAction SilentlyContinue
  if ($service -and ($service.State -cne 'Stopped' -or $service.StartMode -notin @('Manual','Disabled'))) { throw 'ROLLBACK_FINALIZE_LEGACY_MODE_EDGE_SERVICE_UNSAFE' }
  $serviceState = if ($service) { "$($service.State)|$($service.StartMode)" } else { 'ABSENT' }
  $identity = Get-TextSha256 (@('rollback-finalize-legacy-quiescence-v2',$ExpectedRuntimeConfigSha256.ToLowerInvariant(),$ExpectedLegacyQuiesceEvidenceSha256.ToLowerInvariant(),[string]$value.processIdentityDigest,[string]$value.restartCanonicalDigest,[string]$value.webProcessId,[string]$value.apiProcessId,$serviceState,'3100|4100|443-absent') -join "`n")
  return [pscustomobject]@{ProofType='SIGNED_LEGACY_QUIESCE_V2';IdentityDigest=$identity;EvidencePath=$quiesce;EvidenceSha256=$ExpectedLegacyQuiesceEvidenceSha256.ToLowerInvariant();PublicKeyPath=$public;PublicKeySha256=$ExpectedQuiesceReceiptPublicKeySha256.ToLowerInvariant();CompletedAt=$completed.ToUniversalTime().ToString('o');ActiveRequests=0;EdgeProcessId=0;EdgeProcessStartedAt=$null;ListenerAddress=$null;ListenerPort=0;ServiceState=$serviceState}
}

function Assert-CurrentQuiescence($Config,$RollbackEvidence,[string]$Runtime,[string]$Node,[string]$Verifier) {
  $releaseRoot = if ($EdgeReleaseRoot -and (Test-Path -LiteralPath $EdgeReleaseRoot -PathType Container)) { [IO.Path]::GetFullPath($EdgeReleaseRoot).TrimEnd('\') } else { throw 'ROLLBACK_FINALIZE_EDGE_RELEASE_ROOT_REQUIRED' }
  Assert-NoReparse $releaseRoot
  $manifestPath = Get-PinnedFile (Join-Path $releaseRoot 'release-manifest.json') $ExpectedEdgeReleaseManifestSha256 'ROLLBACK_FINALIZE_EDGE_RELEASE_MANIFEST_HASH_MISMATCH' $script:MaximumJsonBytes
  $manifest = Read-BoundedJson $manifestPath 'ROLLBACK_FINALIZE_EDGE_RELEASE_MANIFEST_INVALID'
  if ($manifest.version -ne 4 -or -not $manifest.runtimeSmokeVerified -or $manifest.releaseId -cne $Config.release.id -or
      $RollbackEvidence.edgeStateMode -cne $EdgeStateMode -or $RollbackEvidence.edgeReleaseId -cne $Config.release.id -or
      $RollbackEvidence.edgeReleaseManifestSha256 -cne $ExpectedEdgeReleaseManifestSha256.ToLowerInvariant()) {
    throw 'ROLLBACK_FINALIZE_EDGE_RELEASE_IDENTITY_REJECTED'
  }
  if ($EdgeStateMode -eq 'ACTIVE_LOCAL_EDGE') {
    $drain = Get-PinnedFile $DrainStatePath $ExpectedDrainStateSha256 'ROLLBACK_FINALIZE_DRAIN_HASH_MISMATCH' 1048576
    $public = Get-PinnedFile $EdgeSigningPublicKeyPath $ExpectedEdgeSigningPublicKeySha256 'ROLLBACK_FINALIZE_EDGE_PUBLIC_KEY_HASH_MISMATCH' 1048576
    $identity = Assert-ExactEdgeDrainIdentity -EdgeServiceName $EdgeServiceName -RuntimeConfigPath $Runtime -ExpectedRuntimeConfigSha256 $ExpectedRuntimeConfigSha256 -ReleaseRoot $releaseRoot -ExpectedReleaseManifestSha256 $ExpectedEdgeReleaseManifestSha256 -NodePath $Node -ExpectedNodeSha256 $ExpectedNodeSha256 -DrainStatePath $drain -ExpectedDrainStateSha256 $ExpectedDrainStateSha256 -AttestationVerifierPath $Verifier -ExpectedAttestationVerifierSha256 $ExpectedAttestationVerifierSha256 -EdgeSigningPublicKeyPath $public -ExpectedEdgeSigningPublicKeySha256 $ExpectedEdgeSigningPublicKeySha256 -MaximumAgeSeconds $script:MaximumEdgeDrainAgeSeconds
    if ($RollbackEvidence.quiescenceProofType -cne 'SIGNED_EDGE_DRAIN_V2' -or -not $RollbackEvidence.quiescenceVerified -or -not $RollbackEvidence.drainVerified -or $RollbackEvidence.legacyNoEdgeVerified -or [int]$identity.ActiveRequests -ne 0) { throw 'ROLLBACK_FINALIZE_ACTIVE_EDGE_BOUNDARY_REJECTED' }
    return [pscustomobject]@{ProofType='SIGNED_EDGE_DRAIN_V2';IdentityDigest=$identity.IdentityDigest;EvidencePath=$drain;EvidenceSha256=$ExpectedDrainStateSha256.ToLowerInvariant();PublicKeyPath=$public;PublicKeySha256=$ExpectedEdgeSigningPublicKeySha256.ToLowerInvariant();CompletedAt=$identity.DrainCompletedAt;ActiveRequests=0;EdgeProcessId=$identity.EdgeProcessId;EdgeProcessStartedAt=$identity.EdgeProcessStartedAt;ListenerAddress=$identity.ListenerAddress;ListenerPort=$identity.ListenerPort;ServiceState='RUNNING_DRAINED'}
  }
  if ($RollbackEvidence.quiescenceProofType -cne 'SIGNED_LEGACY_QUIESCE_V2' -or -not $RollbackEvidence.quiescenceVerified -or -not $RollbackEvidence.legacyNoEdgeVerified -or $RollbackEvidence.drainVerified) { throw 'ROLLBACK_FINALIZE_LEGACY_EDGE_BOUNDARY_REJECTED' }
  return Assert-LegacyQuiescence $Config $RollbackEvidence $Node $Verifier
}

function Get-BoundaryContext {
  $runtime = Get-PinnedFile $RuntimeConfigPath $ExpectedRuntimeConfigSha256 'ROLLBACK_FINALIZE_RUNTIME_HASH_MISMATCH' $script:MaximumJsonBytes
  $rollbackJournal = Get-PinnedFile $RollbackJournalPath $ExpectedRollbackJournalSha256 'ROLLBACK_FINALIZE_JOURNAL_HASH_MISMATCH' $script:MaximumJsonBytes
  $rollbackEvidencePath = Get-PinnedFile $RollbackEvidencePath $ExpectedRollbackEvidenceSha256 'ROLLBACK_FINALIZE_EVIDENCE_HASH_MISMATCH' $script:MaximumJsonBytes
  $restorePublic = Get-PinnedFile $RestoreReceiptPublicKeyPath $ExpectedRestoreReceiptPublicKeySha256 'ROLLBACK_FINALIZE_PUBLIC_KEY_HASH_MISMATCH' 1048576
  $node = Get-PinnedFile $NodePath $ExpectedNodeSha256 'ROLLBACK_FINALIZE_NODE_HASH_MISMATCH'
  $verifier = Get-PinnedFile $AttestationVerifierPath $ExpectedAttestationVerifierSha256 'ROLLBACK_FINALIZE_VERIFIER_HASH_MISMATCH' $script:MaximumJsonBytes
  $psql = Get-PinnedFile $PsqlPath $ExpectedPsqlSha256 'ROLLBACK_FINALIZE_PSQL_HASH_MISMATCH'
  $pgpass = Get-PinnedFile $PgPassFile $ExpectedPgPassSha256 'ROLLBACK_FINALIZE_PGPASS_HASH_MISMATCH' 1048576
  $ca = Get-PinnedFile $CaCertificatePath $ExpectedCaCertificateSha256 'ROLLBACK_FINALIZE_CA_HASH_MISMATCH' 1048576
  $filesystemPath = Get-PinnedFile $FileSystemEvidencePath $ExpectedFileSystemEvidenceSha256 'ROLLBACK_FINALIZE_FILESYSTEM_HASH_MISMATCH' $script:MaximumJsonBytes
  $maintenancePath = Get-PinnedFile $MaintenanceFlagPath $ExpectedMaintenanceFlagSha256 'ROLLBACK_FINALIZE_MAINTENANCE_HASH_MISMATCH' 1048576
  $config = Read-BoundedJson $runtime 'ROLLBACK_FINALIZE_RUNTIME_INVALID'
  $journal = Read-BoundedJson $rollbackJournal 'ROLLBACK_FINALIZE_JOURNAL_INVALID'
  $rollbackEvidence = Read-BoundedJson $rollbackEvidencePath 'ROLLBACK_FINALIZE_EVIDENCE_INVALID'
  $filesystem = Read-BoundedJson $filesystemPath 'ROLLBACK_FINALIZE_FILESYSTEM_INVALID'
  [void](Invoke-Bounded $node @($verifier,$restorePublic,$rollbackEvidencePath,'legacy-database-rollback') @{} 'ROLLBACK_FINALIZE_SIGNATURE_REJECTED')
  $preserved = [string]$journal.preservedSchema
  if ($journal.version -ne 3 -or $journal.state -cne 'COMPLETE_MAINTENANCE_REQUIRED' -or -not $journal.originalSchemaPreserved -or $journal.partialTargetPossible -or
      $journal.edgeStateMode -cne $EdgeStateMode -or $journal.quiescenceProofType -cne $rollbackEvidence.quiescenceProofType -or
      $journal.legacyQuiesceEvidenceSha256 -cne $rollbackEvidence.legacyQuiesceEvidenceSha256 -or
      $rollbackEvidence.attestationType -cne 'legacy-database-rollback' -or $rollbackEvidence.version -ne 3 -or $rollbackEvidence.result -cne 'PASS' -or
      -not $rollbackEvidence.productionDatabaseRestored -or -not $rollbackEvidence.preRollbackSchemaPreserved -or
      -not $rollbackEvidence.maintenanceVerified -or -not $rollbackEvidence.maintenanceMustRemainEnabled -or -not $rollbackEvidence.legacyWritersQuiesced -or
      $rollbackEvidence.preservedSchema -cne $preserved -or
      $rollbackEvidence.databaseProjectRef -cne $ConfirmProjectRef -or $rollbackEvidence.databaseHost -cne $ConfirmDatabaseHost -or
      $rollbackEvidence.databaseName -cne $ConfirmDatabaseName -or $rollbackEvidence.databaseSchema -cne $ConfirmDatabaseSchema -or
      $preserved -notmatch '^__metaads_pre_[0-9a-f]{16}$') {
    throw 'ROLLBACK_FINALIZE_BOUNDARY_EVIDENCE_REJECTED'
  }
  if ($config.database.provider -cne 'supabase_postgres' -or $config.database.projectRef -cne $ConfirmProjectRef -or
      $config.database.host -cne $ConfirmDatabaseHost -or $config.database.name -cne $ConfirmDatabaseName -or
      $config.database.schema -cne $ConfirmDatabaseSchema -or $config.database.migrationUser -cne $ConfirmDatabaseUser -or
      $config.database.port -ne 5432 -or $config.database.caCertificateSha256 -cne $ExpectedCaCertificateSha256.ToLowerInvariant() -or
      [IO.Path]::GetFullPath([string]$config.database.caCertificatePath) -ine $ca) {
    throw 'ROLLBACK_FINALIZE_CONFIG_CONFIRMATION_MISMATCH'
  }
  $maintenance = Assert-MaintenanceState $config $maintenancePath
  $quiescence = Assert-CurrentQuiescence $config $rollbackEvidence $runtime $node $verifier
  $shared = @($runtime,$node,$verifier,$restorePublic,$psql,$ca,$EdgeReleaseRoot)
  if ($EdgeStateMode -eq 'ACTIVE_LOCAL_EDGE') { $shared += @($script:edgeDrainHelper,$EdgeSigningPublicKeyPath) } else { $shared += @($QuiesceReceiptPublicKeyPath) }
  if ($filesystem.result -cne 'PASS' -or -not $filesystem.exactAcl -or $filesystem.filesystem -cne 'NTFS' -or -not $filesystem.nonReparse -or
      @($shared | Where-Object { -not(Test-UnderClass $_ $filesystem.classRoots.SHARED_RUNTIME) }).Count -or
      -not(Test-UnderClass $pgpass $filesystem.classRoots.ADMIN_ONLY) -or
      -not(Test-UnderClass $maintenancePath $filesystem.classRoots.EDGE_READ) -or
      -not(Test-UnderClass $filesystemPath $filesystem.classRoots.ADMIN_EVIDENCE) -or
      -not(Test-UnderClass $rollbackJournal $filesystem.classRoots.ADMIN_EVIDENCE) -or
      -not(Test-UnderClass $rollbackEvidencePath $filesystem.classRoots.ADMIN_EVIDENCE) -or
      -not(Test-UnderClass $FinalizationJournalPath $filesystem.classRoots.ADMIN_EVIDENCE) -or
      ($EdgeStateMode -eq 'ACTIVE_LOCAL_EDGE' -and -not(Test-UnderClass $DrainStatePath $filesystem.classRoots.EDGE_READ)) -or
      ($EdgeStateMode -eq 'LEGACY_QUIESCED_NO_EDGE' -and -not(Test-UnderClass $LegacyQuiesceEvidencePath $filesystem.classRoots.ADMIN_EVIDENCE))) {
    throw 'ROLLBACK_FINALIZE_FILESYSTEM_BOUNDARY_REJECTED'
  }
  $operationFingerprint = Get-TextSha256 (@(
    'rollback-finalization-operation-v2',$Mode,$ExpectedRuntimeConfigSha256.ToLowerInvariant(),
    $ExpectedRollbackJournalSha256.ToLowerInvariant(),$ExpectedRollbackEvidenceSha256.ToLowerInvariant(),
    $ExpectedRestoreReceiptPublicKeySha256.ToLowerInvariant(),$ExpectedNodeSha256.ToLowerInvariant(),
    $ExpectedAttestationVerifierSha256.ToLowerInvariant(),$ExpectedPsqlSha256.ToLowerInvariant(),
    $ExpectedPgPassSha256.ToLowerInvariant(),$ExpectedCaCertificateSha256.ToLowerInvariant(),
    $ExpectedFileSystemEvidenceSha256.ToLowerInvariant(),$ExpectedMaintenanceFlagSha256.ToLowerInvariant(),
    $ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant(),$EdgeStateMode,[IO.Path]::GetFullPath($EdgeReleaseRoot),
    $ExpectedEdgeReleaseManifestSha256.ToLowerInvariant(),$ConfirmProjectRef,$ConfirmDatabaseHost,$ConfirmDatabaseName,
    $ConfirmDatabaseSchema,$ConfirmDatabaseUser,$preserved,[IO.Path]::GetFullPath($FinalizationJournalPath)
  ) -join "`n")
  return [pscustomobject]@{Runtime=$runtime;Config=$config;RollbackJournal=$rollbackJournal;RollbackEvidencePath=$rollbackEvidencePath;RollbackEvidence=$rollbackEvidence;RestorePublic=$restorePublic;Node=$node;Verifier=$verifier;Psql=$psql;PgPass=$pgpass;Ca=$ca;FileSystemPath=$filesystemPath;FileSystem=$filesystem;MaintenancePath=$maintenancePath;Maintenance=$maintenance;Quiescence=$quiescence;PreservedSchema=$preserved;OperationFingerprint=$operationFingerprint}
}

function Get-ExistingFinalizationHash([string]$IntendedAction) {
  if ($IntendedAction -eq 'VerifyEvidence') {
    [void](Get-PinnedFile $FinalizationJournalPath $ExpectedFinalizationJournalSha256 'ROLLBACK_FINALIZE_OUTPUT_HASH_MISMATCH' 1048576)
    return $ExpectedFinalizationJournalSha256.ToLowerInvariant()
  }
  if (Test-Path -LiteralPath $FinalizationJournalPath -PathType Leaf) {
    [void](Get-PinnedFile $FinalizationJournalPath $ExpectedFinalizationJournalSha256 'ROLLBACK_FINALIZE_EXISTING_OUTPUT_HASH_REQUIRED' 1048576)
    return $ExpectedFinalizationJournalSha256.ToLowerInvariant()
  }
  if ($ExpectedFinalizationJournalSha256) { throw 'ROLLBACK_FINALIZE_UNEXPECTED_OUTPUT_HASH' }
  return $null
}

function New-FinalizePlan([string]$IntendedAction) {
  if ($IntendedAction -notin @('Apply','VerifyEvidence')) { throw 'ROLLBACK_FINALIZE_PLANNED_ACTION_REQUIRED' }
  if (-not $Mode) { throw 'ROLLBACK_FINALIZE_MODE_REQUIRED' }
  $context = Get-BoundaryContext
  $existingFinalizationHash = Get-ExistingFinalizationHash $IntendedAction
  $parameters = [ordered]@{
    mode=$Mode;provider='supabase_postgres';projectRef=Get-ApprovalText $ConfirmProjectRef '^[a-z]{20}$' 'ROLLBACK_FINALIZE_PROJECT_REQUIRED';databaseHost=Get-ApprovalText $ConfirmDatabaseHost '^(?:db\.[a-z]{20}\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$' 'ROLLBACK_FINALIZE_HOST_REQUIRED';databasePort=5432;databaseName=Get-ApprovalText $ConfirmDatabaseName '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_FINALIZE_DATABASE_REQUIRED';databaseSchema=Get-ApprovalText $ConfirmDatabaseSchema '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_FINALIZE_SCHEMA_REQUIRED';databaseUser=Get-ApprovalText $ConfirmDatabaseUser '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_FINALIZE_USER_REQUIRED';preservedSchema=$context.PreservedSchema
    runtimeConfigPath=Get-ApprovalPath $RuntimeConfigPath 'ROLLBACK_FINALIZE_RUNTIME_REQUIRED';runtimeConfigSha256=Get-ApprovalHash $ExpectedRuntimeConfigSha256 'ROLLBACK_FINALIZE_RUNTIME_HASH_REQUIRED';rollbackJournalPath=Get-ApprovalPath $RollbackJournalPath 'ROLLBACK_FINALIZE_JOURNAL_REQUIRED';rollbackJournalSha256=Get-ApprovalHash $ExpectedRollbackJournalSha256 'ROLLBACK_FINALIZE_JOURNAL_HASH_REQUIRED';rollbackEvidencePath=Get-ApprovalPath $RollbackEvidencePath 'ROLLBACK_FINALIZE_EVIDENCE_REQUIRED';rollbackEvidenceSha256=Get-ApprovalHash $ExpectedRollbackEvidenceSha256 'ROLLBACK_FINALIZE_EVIDENCE_HASH_REQUIRED';restoreReceiptPublicKeyPath=Get-ApprovalPath $RestoreReceiptPublicKeyPath 'ROLLBACK_FINALIZE_PUBLIC_KEY_REQUIRED';restoreReceiptPublicKeySha256=Get-ApprovalHash $ExpectedRestoreReceiptPublicKeySha256 'ROLLBACK_FINALIZE_PUBLIC_KEY_HASH_REQUIRED'
    nodePath=Get-ApprovalPath $NodePath 'ROLLBACK_FINALIZE_NODE_REQUIRED';nodeSha256=Get-ApprovalHash $ExpectedNodeSha256 'ROLLBACK_FINALIZE_NODE_HASH_REQUIRED';attestationVerifierPath=Get-ApprovalPath $AttestationVerifierPath 'ROLLBACK_FINALIZE_VERIFIER_REQUIRED';attestationVerifierSha256=Get-ApprovalHash $ExpectedAttestationVerifierSha256 'ROLLBACK_FINALIZE_VERIFIER_HASH_REQUIRED';psqlPath=Get-ApprovalPath $PsqlPath 'ROLLBACK_FINALIZE_PSQL_REQUIRED';psqlSha256=Get-ApprovalHash $ExpectedPsqlSha256 'ROLLBACK_FINALIZE_PSQL_HASH_REQUIRED';pgPassPath=Get-ApprovalPath $PgPassFile 'ROLLBACK_FINALIZE_PGPASS_REQUIRED';pgPassSha256=Get-ApprovalHash $ExpectedPgPassSha256 'ROLLBACK_FINALIZE_PGPASS_HASH_REQUIRED';caCertificatePath=Get-ApprovalPath $CaCertificatePath 'ROLLBACK_FINALIZE_CA_REQUIRED';caCertificateSha256=Get-ApprovalHash $ExpectedCaCertificateSha256 'ROLLBACK_FINALIZE_CA_HASH_REQUIRED'
    filesystemEvidencePath=Get-ApprovalPath $FileSystemEvidencePath 'ROLLBACK_FINALIZE_FILESYSTEM_REQUIRED';filesystemEvidenceSha256=Get-ApprovalHash $ExpectedFileSystemEvidenceSha256 'ROLLBACK_FINALIZE_FILESYSTEM_HASH_REQUIRED';filesystemRequired='NTFS_EXACT_ACL';maintenanceFlagPath=Get-ApprovalPath $MaintenanceFlagPath 'ROLLBACK_FINALIZE_MAINTENANCE_REQUIRED';maintenanceFlagSha256=Get-ApprovalHash $ExpectedMaintenanceFlagSha256 'ROLLBACK_FINALIZE_MAINTENANCE_HASH_REQUIRED';maintenanceApprovalIdDigest=Get-ApprovalHash $ExpectedMaintenanceApprovalIdDigest 'ROLLBACK_FINALIZE_MAINTENANCE_APPROVAL_REQUIRED';maintenanceReleaseId=$context.Maintenance.ReleaseId
    edgeStateMode=$EdgeStateMode;edgeServiceName=$EdgeServiceName;edgeReleaseRoot=Get-ApprovalPath $EdgeReleaseRoot 'ROLLBACK_FINALIZE_EDGE_RELEASE_ROOT_REQUIRED';edgeReleaseManifestSha256=Get-ApprovalHash $ExpectedEdgeReleaseManifestSha256 'ROLLBACK_FINALIZE_EDGE_RELEASE_HASH_REQUIRED';quiescenceProofType=$context.Quiescence.ProofType;quiescenceIdentityDigest=$context.Quiescence.IdentityDigest;quiescenceEvidencePath=Get-ApprovalPath $context.Quiescence.EvidencePath 'ROLLBACK_FINALIZE_QUIESCENCE_PATH_REQUIRED';quiescenceEvidenceSha256=Get-ApprovalHash $context.Quiescence.EvidenceSha256 'ROLLBACK_FINALIZE_QUIESCENCE_HASH_REQUIRED';quiescencePublicKeyPath=Get-ApprovalPath $context.Quiescence.PublicKeyPath 'ROLLBACK_FINALIZE_QUIESCENCE_PUBLIC_KEY_REQUIRED';quiescencePublicKeySha256=Get-ApprovalHash $context.Quiescence.PublicKeySha256 'ROLLBACK_FINALIZE_QUIESCENCE_PUBLIC_KEY_HASH_REQUIRED';quiescenceCompletedAt=$context.Quiescence.CompletedAt;activeRequests=0;edgeProcessId=$context.Quiescence.EdgeProcessId;edgeProcessStartedAt=$context.Quiescence.EdgeProcessStartedAt;edgeListenerAddress=$context.Quiescence.ListenerAddress;edgeListenerPort=$context.Quiescence.ListenerPort;edgeServiceState=$context.Quiescence.ServiceState
    finalizationJournalPath=Get-ApprovalPath $FinalizationJournalPath 'ROLLBACK_FINALIZE_OUTPUT_REQUIRED';existingFinalizationJournalSha256=$existingFinalizationHash;operationFingerprint=$context.OperationFingerprint
  }
  if ($EdgeStateMode -eq 'ACTIVE_LOCAL_EDGE') {
    $parameters.edgeDrainHelperPath=Get-ApprovalPath $script:edgeDrainHelper 'ROLLBACK_FINALIZE_EDGE_DRAIN_HELPER_REQUIRED';$parameters.edgeDrainHelperSha256=Get-ApprovalHash $ExpectedEdgeDrainHelperSha256 'ROLLBACK_FINALIZE_EDGE_DRAIN_HELPER_HASH_REQUIRED';$parameters.maximumDrainAgeSeconds=$script:MaximumEdgeDrainAgeSeconds
  } else {
    $parameters.maximumLegacyQuiesceAgeSeconds=$script:MaximumLegacyQuiesceAgeSeconds;$parameters.legacyPortsAbsent=@(3100,4100);$parameters.edge443Absent=$true
  }
  if ($IntendedAction -eq 'VerifyEvidence') { $parameters.expectedApplyPlanSha256=Get-ApprovalHash $ExpectedApplyPlanSha256 'ROLLBACK_FINALIZE_APPLY_PLAN_HASH_REQUIRED' }
  return New-ApprovalPlan $PSCommandPath $IntendedAction $parameters "Exact Supabase rollback boundary finalization: $Mode" $(if($Mode -eq 'RETURN_FORWARD'){'Under maintenance and current signed writer drain, drops the restored legacy schema and atomically renames the preserved forward schema back to production'}else{'Under maintenance and current signed writer drain, accepts the restored legacy schema and irreversibly drops only the exact preserved forward schema'}) 'A durable pre-mutation INTENT reconciles 1|1 and 1|0 live schema states after interruption; otherwise keep maintenance and writers quiesced and use a new exact approved retry or restore'
}

function New-CompleteRecord($Intent,$Plan,$Boundary,[string]$ObservedState) {
  return [ordered]@{
    version=2;state='COMPLETE_MAINTENANCE_REQUIRED';mode=$Mode;operationFingerprint=$Boundary.OperationFingerprint
    initialApprovalPlanSha256=[string]$Intent.initialApprovalPlanSha256;approvalPlanSha256=$Plan.planSha256
    recoveryApprovalPlanSha256=$(if ($Plan.planSha256 -cne [string]$Intent.initialApprovalPlanSha256) { $Plan.planSha256 } else { $null })
    rollbackJournalSha256=$ExpectedRollbackJournalSha256.ToLowerInvariant();rollbackEvidenceSha256=$ExpectedRollbackEvidenceSha256.ToLowerInvariant()
    filesystemEvidenceSha256=$ExpectedFileSystemEvidenceSha256.ToLowerInvariant();maintenanceFlagSha256=$ExpectedMaintenanceFlagSha256.ToLowerInvariant();maintenanceApprovalIdDigest=$ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant()
    edgeStateMode=$EdgeStateMode;quiescenceProofType=$Boundary.Quiescence.ProofType;quiescenceIdentityDigest=$Boundary.Quiescence.IdentityDigest;quiescenceEvidenceSha256=$Boundary.Quiescence.EvidenceSha256;activeRequestsAtMutation=0
    databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$Boundary.PreservedSchema
    observedSchemaState=$ObservedState;currentSchemaPresent=$true;preservedSchemaAbsent=$true;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true
    completedAt=[datetimeoffset]::UtcNow.ToString('o')
  }
}

function Assert-ExistingIntent($Record,$Boundary) {
  if ($Record.version -ne 2 -or $Record.state -notin @('INTENT','FAILED_MAINTENANCE_REQUIRED','COMPLETE_MAINTENANCE_REQUIRED') -or
      $Record.mode -cne $Mode -or $Record.operationFingerprint -cne $Boundary.OperationFingerprint -or
      $Record.databaseProjectRef -cne $ConfirmProjectRef -or $Record.databaseHost -cne $ConfirmDatabaseHost -or
      $Record.databaseName -cne $ConfirmDatabaseName -or $Record.databaseSchema -cne $ConfirmDatabaseSchema -or
      $Record.preservedSchema -cne $Boundary.PreservedSchema -or $Record.initialApprovalPlanSha256 -notmatch '^[0-9a-f]{64}$' -or
      -not $Record.maintenanceMustRemainEnabled -or -not $Record.legacyWritersMustRemainQuiesced) {
    throw 'ROLLBACK_FINALIZE_EXISTING_INTENT_REJECTED'
  }
}

$intended = if ($Action -eq 'Apply') { 'Apply' } else { 'VerifyEvidence' }
$plan = New-FinalizePlan $(if ($Action -eq 'Plan') { $PlannedAction } else { $intended })
if ($Action -eq 'Plan') { $plan | ConvertTo-Json -Depth 16;exit 0 }
Assert-ApprovedPlan $plan ([bool]$Approved) $ApprovedPlanSha256
$boundary = Get-BoundaryContext
if ($boundary.Quiescence.IdentityDigest -cne $plan.exactParameters.quiescenceIdentityDigest -or $boundary.OperationFingerprint -cne $plan.exactParameters.operationFingerprint) { throw 'ROLLBACK_FINALIZE_ACTION_BOUNDARY_DRIFT' }

$connectionUser = if ($boundary.Config.database.connectionMode -eq 'session_pooler') { "$ConfirmDatabaseUser.$ConfirmProjectRef" } else { $ConfirmDatabaseUser }
$environment = @{PGPASSFILE=$boundary.PgPass;PGSSLMODE='verify-full';PGSSLROOTCERT=$boundary.Ca;PGCONNECT_TIMEOUT='15';PGOPTIONS='-c statement_timeout=240000 -c lock_timeout=30000 -c idle_in_transaction_session_timeout=60000';PGAPPNAME='meta-ads-rollback-finalize'}
$base = @("--host=$ConfirmDatabaseHost",'--port=5432',"--username=$connectionUser","--dbname=$ConfirmDatabaseName",'--no-password','--tuples-only','--no-align','--set=ON_ERROR_STOP=1')
$schema = Quote-Identifier $ConfirmDatabaseSchema
$saved = Quote-Identifier $boundary.PreservedSchema
$stateSql = "SELECT (to_regnamespace('$ConfirmDatabaseSchema') IS NOT NULL)::int || '|' || (to_regnamespace('$($boundary.PreservedSchema)') IS NOT NULL)::int"

if ($Action -eq 'Apply') {
  $intent = $null
  $journalOwned = $false
  $completed = $false
  $reconciledAfterFailure = $false
  $observed = 'UNKNOWN'
  try {
    if (Test-Path -LiteralPath $FinalizationJournalPath -PathType Leaf) {
      $intent = Read-BoundedJson $FinalizationJournalPath 'ROLLBACK_FINALIZE_EXISTING_INTENT_INVALID' 1048576
      Assert-ExistingIntent $intent $boundary
      $journalOwned = $true
    }
    $observed = Invoke-Bounded $boundary.Psql ($base + @("--command=$stateSql")) $environment 'ROLLBACK_FINALIZE_STATE_CHECK'
    if ($intent -and $intent.state -ceq 'COMPLETE_MAINTENANCE_REQUIRED') {
      if ($observed -cne '1|0') { throw 'ROLLBACK_FINALIZE_COMPLETE_STATE_DRIFT' }
      $completed = $true
    } elseif ($observed -eq '1|0' -and $intent) {
      Write-DurableJson $FinalizationJournalPath (New-CompleteRecord $intent $plan $boundary $observed)
      $completed = $true
      $reconciledAfterFailure = $true
    } else {
      if ($observed -cne '1|1') { throw 'ROLLBACK_FINALIZE_SCHEMA_STATE_REJECTED' }
      if (-not $intent) {
        $intent = [ordered]@{
          version=2;state='INTENT';mode=$Mode;operationFingerprint=$boundary.OperationFingerprint
          initialApprovalPlanSha256=$plan.planSha256;approvalInstanceId=$plan.approvalInstanceId
          rollbackJournalSha256=$ExpectedRollbackJournalSha256.ToLowerInvariant();rollbackEvidenceSha256=$ExpectedRollbackEvidenceSha256.ToLowerInvariant()
          filesystemEvidenceSha256=$ExpectedFileSystemEvidenceSha256.ToLowerInvariant();maintenanceFlagSha256=$ExpectedMaintenanceFlagSha256.ToLowerInvariant();maintenanceApprovalIdDigest=$ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant()
          edgeStateMode=$EdgeStateMode;quiescenceProofType=$boundary.Quiescence.ProofType;quiescenceIdentityDigest=$boundary.Quiescence.IdentityDigest;quiescenceEvidenceSha256=$boundary.Quiescence.EvidenceSha256;activeRequestsAtIntent=0
          databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$boundary.PreservedSchema
          expectedPreState='1|1';expectedPostState='1|0';maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;createdAt=[datetimeoffset]::UtcNow.ToString('o')
        }
        Write-DurableJson $FinalizationJournalPath $intent -CreateOnly
        $journalOwned = $true
      }
      [void](Assert-MaintenanceState $boundary.Config $boundary.MaintenancePath)
      $actionQuiescence = Assert-CurrentQuiescence $boundary.Config $boundary.RollbackEvidence $boundary.Runtime $boundary.Node $boundary.Verifier
      if ($actionQuiescence.IdentityDigest -cne $plan.exactParameters.quiescenceIdentityDigest -or [int]$actionQuiescence.ActiveRequests -ne 0) { throw 'ROLLBACK_FINALIZE_ACTION_TIME_QUIESCENCE_CHANGED' }
      $beforeMutation = Invoke-Bounded $boundary.Psql ($base + @("--command=$stateSql")) $environment 'ROLLBACK_FINALIZE_PRE_MUTATION_STATE_CHECK'
      if ($beforeMutation -cne '1|1') { throw 'ROLLBACK_FINALIZE_PRE_MUTATION_STATE_REJECTED' }
      $sql = if ($Mode -eq 'RETURN_FORWARD') { "BEGIN; DROP SCHEMA $schema CASCADE; ALTER SCHEMA $saved RENAME TO $schema; COMMIT;" } else { "BEGIN; DROP SCHEMA $saved CASCADE; COMMIT;" }
      [void](Invoke-Bounded $boundary.Psql ($base + @("--command=$sql")) $environment 'ROLLBACK_FINALIZE_MUTATION_FAILED')
      $observed = Invoke-Bounded $boundary.Psql ($base + @("--command=$stateSql")) $environment 'ROLLBACK_FINALIZE_STATE_VERIFY'
      if ($observed -cne '1|0') { throw 'ROLLBACK_FINALIZE_POST_STATE_REJECTED' }
      Write-DurableJson $FinalizationJournalPath (New-CompleteRecord $intent $plan $boundary $observed)
      $completed = $true
    }
  } catch {
    $failureCode = [string]$_.Exception.Message
    try { $observed = Invoke-Bounded $boundary.Psql ($base + @("--command=$stateSql")) $environment 'ROLLBACK_FINALIZE_FAILURE_STATE_CHECK' } catch { $observed = 'UNKNOWN' }
    if ($journalOwned -and $intent) {
      try {
        if ($observed -ceq '1|0') {
          Write-DurableJson $FinalizationJournalPath (New-CompleteRecord $intent $plan $boundary $observed)
          $completed = $true
          $reconciledAfterFailure = $true
        } else {
          Write-DurableJson $FinalizationJournalPath ([ordered]@{
            version=2;state='FAILED_MAINTENANCE_REQUIRED';mode=$Mode;operationFingerprint=$boundary.OperationFingerprint
            initialApprovalPlanSha256=[string]$intent.initialApprovalPlanSha256;lastApprovalPlanSha256=$plan.planSha256;failureCode=$failureCode
            rollbackJournalSha256=$ExpectedRollbackJournalSha256.ToLowerInvariant();rollbackEvidenceSha256=$ExpectedRollbackEvidenceSha256.ToLowerInvariant()
            filesystemEvidenceSha256=$ExpectedFileSystemEvidenceSha256.ToLowerInvariant();maintenanceFlagSha256=$ExpectedMaintenanceFlagSha256.ToLowerInvariant();maintenanceApprovalIdDigest=$ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant()
            edgeStateMode=$EdgeStateMode;quiescenceProofType=$boundary.Quiescence.ProofType;quiescenceIdentityDigest=$boundary.Quiescence.IdentityDigest;quiescenceEvidenceSha256=$boundary.Quiescence.EvidenceSha256
            databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$boundary.PreservedSchema
            observedSchemaState=$observed;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;recoveryProcedure='KEEP MAINTENANCE AND WRITER QUIESCENCE. HASH-PIN THIS JOURNAL AND CREATE A NEW EXACT APPLY PLAN TO RECONCILE 1|1 OR 1|0.';failedAt=[datetimeoffset]::UtcNow.ToString('o')
          })
        }
      } catch { throw 'ROLLBACK_FINALIZE_FAILED_AND_DURABLE_JOURNAL_WRITE_FAILED' }
    }
    if (-not $completed) { throw 'ROLLBACK_FINALIZE_FAILED_MAINTENANCE_REQUIRED' }
  }
  if (-not $completed) { throw 'ROLLBACK_FINALIZE_INCOMPLETE' }
  [pscustomobject]@{Result='COMPLETE_MAINTENANCE_REQUIRED';Mode=$Mode;CurrentSchemaPresent=$true;PreservedSchemaAbsent=$true;MaintenanceRetained=$true;WritersRemainQuiesced=$true;CrashStateReconciled=$reconciledAfterFailure;DatabaseSecretEmitted=$false} | ConvertTo-Json
  exit 0
}

$finalPath = Get-PinnedFile $FinalizationJournalPath $ExpectedFinalizationJournalSha256 'ROLLBACK_FINALIZE_OUTPUT_HASH_MISMATCH' 1048576
$record = Read-BoundedJson $finalPath 'ROLLBACK_FINALIZE_OUTPUT_INVALID' 1048576
$state = Invoke-Bounded $boundary.Psql ($base + @("--command=$stateSql")) $environment 'ROLLBACK_FINALIZE_VERIFY_STATE'
if ($record.version -ne 2 -or $record.state -cne 'COMPLETE_MAINTENANCE_REQUIRED' -or $record.mode -cne $Mode -or
    $record.operationFingerprint -cne $boundary.OperationFingerprint -or $record.approvalPlanSha256 -cne $ExpectedApplyPlanSha256.ToLowerInvariant() -or
    $record.rollbackJournalSha256 -cne $ExpectedRollbackJournalSha256.ToLowerInvariant() -or $record.rollbackEvidenceSha256 -cne $ExpectedRollbackEvidenceSha256.ToLowerInvariant() -or
    $record.filesystemEvidenceSha256 -cne $ExpectedFileSystemEvidenceSha256.ToLowerInvariant() -or $record.maintenanceFlagSha256 -cne $ExpectedMaintenanceFlagSha256.ToLowerInvariant() -or
    $record.maintenanceApprovalIdDigest -cne $ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant() -or
    $record.edgeStateMode -cne $EdgeStateMode -or $record.quiescenceProofType -cne $boundary.Quiescence.ProofType -or
    $record.databaseProjectRef -cne $ConfirmProjectRef -or $record.databaseHost -cne $ConfirmDatabaseHost -or
    $record.databaseName -cne $ConfirmDatabaseName -or $record.databaseSchema -cne $ConfirmDatabaseSchema -or
    $record.preservedSchema -cne $boundary.PreservedSchema -or $state -cne '1|0' -or
    -not $record.currentSchemaPresent -or -not $record.preservedSchemaAbsent -or -not $record.maintenanceMustRemainEnabled -or -not $record.legacyWritersMustRemainQuiesced) {
  throw 'ROLLBACK_FINALIZE_VERIFY_REJECTED'
}
[pscustomobject]@{Result='PASS';Mode=$Mode;CurrentSchemaPresent=$true;PreservedSchemaAbsent=$true;MaintenanceRetained=$true;WritersRemainQuiesced=$true;DurableIntentReconciled=$true} | ConvertTo-Json
