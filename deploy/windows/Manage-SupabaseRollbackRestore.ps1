#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Apply','Recover','Verify','VerifyRecovery')][string]$Action = 'Plan',
  [ValidateSet('LEGACY_BASELINE','LOCAL_RELEASE')][string]$PreviousReleaseKind = 'LEGACY_BASELINE',
  [ValidateSet('MIGRATION_ROLLBACK','DAILY_BACKUP_RECOVERY')][string]$RecoveryPurpose = 'MIGRATION_ROLLBACK',
  [string]$RuntimeConfigPath,[string]$ExpectedRuntimeConfigSha256,
  [string]$LegacyBaselineEvidencePath,[string]$ExpectedLegacyBaselineEvidenceSha256,
  [string]$LegacyQuiesceEvidencePath,[string]$ExpectedLegacyQuiesceEvidenceSha256,[string]$QuiesceReceiptPublicKeyPath,[string]$ExpectedQuiesceReceiptPublicKeySha256,
  [string]$MigrationJournalPath,[string]$ExpectedMigrationJournalSha256,
  [string]$RestoreRehearsalEvidencePath,[string]$ExpectedRestoreRehearsalEvidenceSha256,
  [string]$MaintenanceFlagPath,[string]$ExpectedMaintenanceFlagSha256,[ValidateSet('ACTIVE_LOCAL_EDGE','LEGACY_QUIESCED_NO_EDGE','STOPPED_LOCAL_EDGE')][string]$EdgeStateMode='ACTIVE_LOCAL_EDGE',[string]$DrainStatePath,[string]$ExpectedDrainStateSha256,
  [string]$EdgeReleaseRoot,[string]$ExpectedEdgeReleaseManifestSha256,
  [string]$BackupEvidencePath,[string]$ExpectedBackupEvidenceSha256,[string]$BackupReceiptPublicKeyPath,[string]$ExpectedBackupReceiptPublicKeySha256,
  [string]$BackupDirectory,[string]$BackupIntegrityKeyFile,[string]$ExpectedBackupIntegrityKeySha256,
  [string]$NodePath,[string]$ExpectedNodeSha256,[string]$AttestationVerifierPath,[string]$ExpectedAttestationVerifierSha256,[string]$EdgeDrainHelperPath,[string]$ExpectedEdgeDrainHelperSha256,[string]$EdgeSigningPublicKeyPath,[string]$ExpectedEdgeSigningPublicKeySha256,[ValidatePattern('^[A-Za-z0-9._-]{1,128}$')][string]$EdgeServiceName='MetaAdsPerformanceEdge',
  [string]$RecoveryProcessTreeHelperPath,[string]$ExpectedRecoveryProcessTreeHelperSha256,
  [string]$LocalRecoverySecurityHelperPath,[string]$ExpectedLocalRecoverySecurityHelperSha256,[string]$RecoveryWorkspaceRoot,[ValidatePattern('^[A-Za-z0-9._-]{1,128}$')][string]$CoreServiceName='MetaAdsPerformanceCore',
  [string]$AttestationSignerPath,[string]$ExpectedAttestationSignerSha256,[string]$RestoreReceiptPrivateKeyPath,[string]$ExpectedRestoreReceiptPrivateKeySha256,[string]$RestoreReceiptPublicKeyPath,[string]$ExpectedRestoreReceiptPublicKeySha256,
  [string]$PsqlPath,[string]$ExpectedPsqlSha256,[string]$PgRestorePath,[string]$ExpectedPgRestoreSha256,[string]$PgPassFile,[string]$ExpectedPgPassSha256,[string]$CaCertificatePath,[string]$ExpectedCaCertificateSha256,
  [string]$FileSystemEvidencePath,[string]$ExpectedFileSystemEvidenceSha256,[string]$RollbackJournalPath,[string]$ExpectedRollbackJournalSha256,[string]$EvidenceOutputPath,[string]$ExpectedEvidenceSha256,
  [string]$ConfirmProjectRef,[string]$ConfirmDatabaseHost,[string]$ConfirmDatabaseName,[string]$ConfirmDatabaseSchema,[string]$ConfirmDatabaseUser,
  [ValidateSet(14400)][int]$MaximumRestoreDurationSeconds = 14400,[ValidateRange(1048576,274877906944)][long]$MaximumDatabaseDumpBytes = 68719476736,[ValidateRange(4096,8388608)][int]$MaximumChildOutputBytes = 1048576,
  [ValidateSet('Apply','Recover','VerifyEvidence','VerifyRecovery')][string]$PlannedAction,[string]$ApprovedPlanSha256,[string]$ApprovalNonce,[string]$ApprovalIssuedAt,[string]$ApprovalExpiresAt,[string]$ApprovalInstanceId,[string]$ApprovalLedgerPath,[switch]$Approved
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
$recoveryProcessTreeHelper=if($RecoveryProcessTreeHelperPath){[IO.Path]::GetFullPath($RecoveryProcessTreeHelperPath)}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'recovery-process-tree.ps1'))}
. (Import-PinnedHelperScriptBlock $recoveryProcessTreeHelper $ExpectedRecoveryProcessTreeHelperSha256 'ROLLBACK_PROCESS_TREE_HELPER_HASH_MISMATCH')
$localRecoverySecurityHelper=if($LocalRecoverySecurityHelperPath){[IO.Path]::GetFullPath($LocalRecoverySecurityHelperPath)}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'local-recovery-security.ps1'))}
. (Import-PinnedHelperScriptBlock $localRecoverySecurityHelper $ExpectedLocalRecoverySecurityHelperSha256 'ROLLBACK_LOCAL_RECOVERY_SECURITY_HELPER_HASH_MISMATCH')
$edgeDrainHelper=$null;if($EdgeStateMode-eq'ACTIVE_LOCAL_EDGE'){$edgeDrainHelper=if($EdgeDrainHelperPath){[IO.Path]::GetFullPath($EdgeDrainHelperPath)}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'edge-drain-identity.ps1'))};. (Import-PinnedHelperScriptBlock $edgeDrainHelper $ExpectedEdgeDrainHelperSha256 'ROLLBACK_EDGE_DRAIN_HELPER_HASH_MISMATCH')}
$script:RestoreWatch = [Diagnostics.Stopwatch]::StartNew()
$script:WorkDeadlineSeconds = $MaximumRestoreDurationSeconds - 10
$script:MaximumInventoryFiles = 1000000
$script:MaximumInventoryBytes = [long]1099511627776

function Assert-RestoreDeadline([switch]$Finalization) {
  $limit = if ($Finalization) { $MaximumRestoreDurationSeconds } else { $script:WorkDeadlineSeconds }
  if ($script:RestoreWatch.Elapsed.TotalSeconds -ge $limit) { throw 'ROLLBACK_RESTORE_DEADLINE_EXCEEDED' }
}
function Existing([string]$Path,[bool]$Directory,[string]$Code) {
  Assert-RestoreDeadline;$kind = if ($Directory) { 'Container' } else { 'Leaf' }
  if (-not $Path -or -not(Test-Path -LiteralPath $Path -PathType $kind)) { throw $Code }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\');$cursor = Get-Item -LiteralPath $full -Force
  while ($cursor) { if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ROLLBACK_RESTORE_REPARSE_REJECTED' };$cursor = $cursor.Parent }
  Assert-RestoreDeadline;return $full
}
function Read-BoundedBytes([string]$Path,[long]$Maximum,[string]$Code) {
  Assert-RestoreDeadline;$item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -lt 0 -or $item.Length -gt $Maximum) { throw $Code }
  $stream = [IO.FileStream]::new($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read,1048576,[IO.FileOptions]::SequentialScan);$memory = [IO.MemoryStream]::new();$buffer = New-Object byte[] 1048576
  try { while (($count = $stream.Read($buffer,0,$buffer.Length)) -gt 0) { Assert-RestoreDeadline;if ($memory.Length + $count -gt $Maximum) { throw $Code };$memory.Write($buffer,0,$count) };if ($memory.Length -ne $item.Length) { throw $Code };return $memory.ToArray() } finally { [Array]::Clear($buffer,0,$buffer.Length);$memory.Dispose();$stream.Dispose() }
}
function Read-BoundedJson([string]$Path,[long]$Maximum,[string]$Code) {
  $bytes = Read-BoundedBytes $Path $Maximum $Code
  try { $value = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -Depth 64 } catch { throw $Code } finally { [Array]::Clear($bytes,0,$bytes.Length) }
  Assert-RestoreDeadline;return $value
}
function Read-BoundedJsonSnapshot([string]$Path,[long]$Maximum,[string]$Code) {
  $bytes = Read-BoundedBytes $Path $Maximum $Code;$sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant();$value = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -Depth 64 } catch { throw $Code } finally { $sha.Dispose();[Array]::Clear($bytes,0,$bytes.Length) }
  Assert-RestoreDeadline;return [pscustomobject]@{Value=$value;Sha256=$digest}
}
function Hash([string]$Path,[long]$Maximum = 1073741824,[string]$Code = 'ROLLBACK_FILE_HASH_REJECTED') {
  Assert-RestoreDeadline;$item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -lt 0 -or $item.Length -gt $Maximum) { throw $Code }
  $stream = [IO.FileStream]::new($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read,1048576,[IO.FileOptions]::SequentialScan);$hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256);$buffer = New-Object byte[] 1048576;[long]$bytes = 0
  try { while (($count = $stream.Read($buffer,0,$buffer.Length)) -gt 0) { Assert-RestoreDeadline;$bytes += $count;if ($bytes -gt $Maximum) { throw $Code };$hash.AppendData($buffer,0,$count) };if ($bytes -ne $item.Length) { throw $Code };return ([BitConverter]::ToString($hash.GetHashAndReset()).Replace('-','').ToLowerInvariant()) } finally { [Array]::Clear($buffer,0,$buffer.Length);$hash.Dispose();$stream.Dispose() }
}
function AssertHash([string]$Path,[string]$Expected,[string]$Code,[long]$Maximum = 1073741824) { if ($Expected -notmatch '^[A-Fa-f0-9]{64}$' -or (Hash $Path $Maximum $Code) -cne $Expected.ToLowerInvariant()) { throw $Code } }
function TextHash([string]$Value) { $sha = [Security.Cryptography.SHA256]::Create();try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant()) } finally { $sha.Dispose() } }
function Under([string]$Path,$Roots) { $full = [IO.Path]::GetFullPath($Path).TrimEnd('\');return @($Roots | Where-Object { $root = [IO.Path]::GetFullPath([string]$_).TrimEnd('\');$full -ieq $root -or $full.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase) }).Count -gt 0 }
function Write-AtomicJson([string]$Path,$Value,[switch]$CreateOnly) {
  Assert-RestoreDeadline -Finalization;$full = [IO.Path]::GetFullPath($Path);$parent = Split-Path -Parent $full
  if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'-and$RollbackJournalPath-and$full-ieq[IO.Path]::GetFullPath($RollbackJournalPath)){
    if(-not$recoveryWorkspaceRoot-or-not$recoverySecurityHelper-or$ExpectedLocalRecoverySecurityHelperSha256-notmatch'^[A-Fa-f0-9]{64}$'){throw 'ROLLBACK_DAILY_JOURNAL_WORKSPACE_BINDING_REQUIRED'}
    $Value.recoveryWorkspaceRoot=[IO.Path]::GetFullPath($recoveryWorkspaceRoot).TrimEnd('\')
    $Value.localRecoverySecurityHelperPath=[IO.Path]::GetFullPath($recoverySecurityHelper)
    $Value.localRecoverySecurityHelperSha256=$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()
  }
  if (-not(Test-Path -LiteralPath $parent -PathType Container)) { throw 'ROLLBACK_JOURNAL_PARENT_NOT_FOUND' };if ($CreateOnly -and (Test-Path -LiteralPath $full)) { throw 'ROLLBACK_JOURNAL_ALREADY_EXISTS' }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 32 -Compress));if ($bytes.Length -gt 1048576) { throw 'ROLLBACK_JOURNAL_SIZE_LIMIT' };$pending = Join-Path $parent ('.rollback-' + [guid]::NewGuid().ToString('N') + '.pending')
  try { $stream = [IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough);try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() };[IO.File]::Move($pending,$full,-not $CreateOnly);$committed=[IO.FileStream]::new($full,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough);try{$committed.Flush($true)}finally{$committed.Dispose()} } finally { [Array]::Clear($bytes,0,$bytes.Length);if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force } }
  Assert-RestoreDeadline -Finalization
}
function Stop-TreeVerified($Process) {
  if ($null -eq $Process) { return };$remainingMilliseconds = [Math]::Max(100,[Math]::Min(5000,[int](($MaximumRestoreDurationSeconds - $script:RestoreWatch.Elapsed.TotalSeconds) * 1000)))
  try { Stop-VerifiedRecoveryProcessTree $Process $remainingMilliseconds } catch { throw 'ROLLBACK_PROCESS_TREE_EXIT_UNCONFIRMED' }
}
function Invoke-Bounded([string]$Executable,[string[]]$Arguments,[hashtable]$Environment,[string]$Code,[switch]$Cleanup) {
  if ($Cleanup) { Assert-RestoreDeadline -Finalization } else { Assert-RestoreDeadline }
  $info = [Diagnostics.ProcessStartInfo]::new();$info.FileName = $Executable;$info.UseShellExecute = $false;$info.CreateNoWindow = $true;$info.RedirectStandardOutput = $true;$info.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) };foreach ($name in @('DATABASE_URL','PGPASSWORD','PGPASSFILE','PGSSLMODE','PGSSLROOTCERT','PGOPTIONS','PGCONNECT_TIMEOUT')) { [void]$info.Environment.Remove($name) };foreach ($name in $Environment.Keys) { $info.Environment[$name] = [string]$Environment[$name] }
  $process = $null;$started = $false;$stdout = [IO.MemoryStream]::new();$stderr = [IO.MemoryStream]::new();$outBuffer = New-Object byte[] 8192;$errBuffer = New-Object byte[] 8192
  try {
    $process=Start-VerifiedRecoveryProcess $info;if (-not $process) { throw "$Code`_START_FAILED" };$started = $true;$outTask = $process.StandardOutput.BaseStream.ReadAsync($outBuffer,0,$outBuffer.Length);$errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer,0,$errBuffer.Length);$outDone = $false;$errDone = $false
    while (-not($process.HasExited -and $outDone -and $errDone)) {
      if ($Cleanup) { Assert-RestoreDeadline -Finalization } else { Assert-RestoreDeadline }
      if (-not $outDone -and $outTask.IsCompleted) { $count = $outTask.GetAwaiter().GetResult();if ($count -eq 0) { $outDone = $true } else { if ($stdout.Length + $stderr.Length + $count -gt $MaximumChildOutputBytes) { Stop-TreeVerified $process;throw "$Code`_OUTPUT_LIMIT" };$stdout.Write($outBuffer,0,$count);$outTask = $process.StandardOutput.BaseStream.ReadAsync($outBuffer,0,$outBuffer.Length) } }
      if (-not $errDone -and $errTask.IsCompleted) { $count = $errTask.GetAwaiter().GetResult();if ($count -eq 0) { $errDone = $true } else { if ($stdout.Length + $stderr.Length + $count -gt $MaximumChildOutputBytes) { Stop-TreeVerified $process;throw "$Code`_OUTPUT_LIMIT" };$stderr.Write($errBuffer,0,$count);$errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer,0,$errBuffer.Length) } }
      if (-not($process.HasExited -and $outDone -and $errDone)) { [Threading.Thread]::Sleep(10) }
    }
    if ($process.ExitCode -ne 0) { throw "$Code`_FAILED" };return [Text.Encoding]::UTF8.GetString($stdout.ToArray()).Trim()
  } finally { try { if ($started) { Stop-TreeVerified $process } } finally { if($process){$process.Dispose()};$stdout.Dispose();$stderr.Dispose();[Array]::Clear($outBuffer,0,$outBuffer.Length);[Array]::Clear($errBuffer,0,$errBuffer.Length) } }
}
function Hmac([string]$KeyFile,[string]$Value) { $bytes = Read-BoundedBytes $KeyFile 1024 'ROLLBACK_INTEGRITY_KEY_INVALID';if ($bytes.Length -lt 32) { throw 'ROLLBACK_INTEGRITY_KEY_INVALID' };$h = [Security.Cryptography.HMACSHA256]::new($bytes);try { return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant()) } finally { $h.Dispose();[Array]::Clear($bytes,0,$bytes.Length) } }
function SignatureInput($m) { return @('6',$m.backupId,$m.createdAt,$m.backupMode,$m.sourceDataRoot,$m.backupRoot,$m.databaseProvider,$m.databaseProjectRef,$m.databaseConnectionMode,$m.databaseHost,[string]$m.databasePort,$m.databaseName,$m.databaseSchema,$m.releaseId,$m.databaseDumpSha256,[string]$m.databaseDumpBytes,[string]$m.maximumDatabaseDumpBytes,[string]$m.maximumBackupDurationSeconds,[string]$m.backupSafetyMarginBytes,[string]$m.elapsedSeconds,[string]$m.databaseSizePreflightVerified,[string]$m.databaseDumpRealtimeCapEnforced,[string]$m.databaseDumpFinalCapVerified,[string]$m.hardDeadlineEnforced,[string]$m.processTreeKillOnDeadline,[string]$m.incompleteStagingCleanupContract,$m.storageManifestSha256,$m.storageReferenceDigest,$m.storageReferenceConversionSha256,[string]$m.storageReferenceCount,[string]$m.storageReferenceZeroVerified,$m.legacyBaselineSha256,$m.legacyStorageStageEvidenceSha256,$m.migrationDigest,$m.appliedMigrationDigest,$m.businessKpiDigest,$m.targetEvidenceFingerprint,$m.configFingerprint,$m.fileCount,$m.totalBytes,$m.integrityKeyId,$m.nodeSha256,$m.psqlSha256,$m.pgDumpSha256,$m.executorSetDigest,$m.filesystemEvidenceSha256,$m.nasIdentityHelperSha256) -join "`n" }
function InventoryDigest([string]$Root) {
  $full = Existing $Root $true 'LEGACY_STORAGE_ROOT_NOT_FOUND';$prefix = $full.TrimEnd('\') + '\';$files = [Collections.Generic.List[IO.FileInfo]]::new();$pending = [Collections.Generic.Stack[string]]::new();$pending.Push($full);[long]$total = 0;[int]$directoryCount = 0
  while ($pending.Count) {
    Assert-RestoreDeadline;$directory = $pending.Pop();$directoryCount += 1;if ($directoryCount -gt $script:MaximumInventoryFiles) { throw 'ROLLBACK_STORAGE_DIRECTORY_LIMIT' }
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      Assert-RestoreDeadline;$attributes = [IO.File]::GetAttributes($entry);if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ROLLBACK_STORAGE_INVENTORY_REJECTED' }
      if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($entry);continue }
      $file = [IO.FileInfo]::new($entry);if ($files.Count -ge $script:MaximumInventoryFiles -or $file.Length -gt 536870912) { throw 'ROLLBACK_STORAGE_INVENTORY_LIMIT' };$relative = $file.FullName.Substring($prefix.Length).Replace('\','/');if (-not $relative -or $relative.Length -gt 1024 -or $relative -match '(^|/)\.\.?(/|$)' -or $relative -match '[\x00-\x1f\x7f]') { throw 'ROLLBACK_STORAGE_INVENTORY_REJECTED' };$total += $file.Length;if ($total -gt $script:MaximumInventoryBytes) { throw 'ROLLBACK_STORAGE_INVENTORY_LIMIT' };$files.Add($file)
    }
  }
  $digest = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256);$first = $true
  try { foreach ($file in @($files | Sort-Object FullName)) { Assert-RestoreDeadline;$relative = $file.FullName.Substring($prefix.Length).Replace('\','/');$line = $(if ($first) { '' } else { "`n" }) + "$relative|$($file.Length)|$(Hash $file.FullName 536870912 'ROLLBACK_STORAGE_FILE_HASH_REJECTED')";$bytes = [Text.Encoding]::UTF8.GetBytes($line);try { $digest.AppendData($bytes);$first = $false } finally { [Array]::Clear($bytes,0,$bytes.Length) } };return ([BitConverter]::ToString($digest.GetHashAndReset()).Replace('-','').ToLowerInvariant()) } finally { $digest.Dispose() }
}
function Assert-DailyStoragePaths([string]$Live,[string]$Staging,[string]$Preserved,[string]$Workspace) {
  $dataRoot=[IO.Path]::GetFullPath([string]$config.data.root).TrimEnd('\')
  $expectedLive=Join-Path $dataRoot 'storage'
  $workspaceRoot=[IO.Path]::GetFullPath($Workspace).TrimEnd('\')
  if([IO.Path]::GetFullPath($Live)-ine$expectedLive-or(Split-Path -Parent ([IO.Path]::GetFullPath($Staging)))-ine$workspaceRoot-or(Split-Path -Parent ([IO.Path]::GetFullPath($Preserved)))-ine$workspaceRoot-or(Split-Path -Leaf $Staging)-notmatch'^storage-recovery-[0-9a-f]{16}$'-or(Split-Path -Leaf $Preserved)-notmatch'^storage-preserved-[0-9a-f]{16}$'-or[IO.Path]::GetFullPath($Staging)-ieq[IO.Path]::GetFullPath($Preserved)){throw 'ROLLBACK_DAILY_STORAGE_PATH_REJECTED'}
  [void](Existing $dataRoot $true 'ROLLBACK_DATA_ROOT_NOT_FOUND')
  [void](Existing $workspaceRoot $true 'ROLLBACK_RECOVERY_WORKSPACE_NOT_FOUND')
}
function Copy-VerifiedStoragePayload([string]$Source,[string]$Target,$FileSystemEvidence) {
  $sourceRoot=Existing $Source $true 'ROLLBACK_STORAGE_PAYLOAD_NOT_FOUND'
  if(Test-Path -LiteralPath $Target){throw 'ROLLBACK_STORAGE_STAGING_ALREADY_EXISTS'}
  [void](New-Item -ItemType Directory -Path $Target);Set-LocalRecoveryExactAcl $Target 'ADMIN_ONLY' $FileSystemEvidence
  try{
    $sourcePrefix=$sourceRoot.TrimEnd('\')+'\';$pending=[Collections.Generic.Stack[string]]::new();$pending.Push($sourceRoot);[int]$count=0;[long]$total=0
    while($pending.Count){Assert-RestoreDeadline;$directory=$pending.Pop();$relativeDirectory=$directory.Substring($sourceRoot.Length).TrimStart('\');$targetDirectory=if($relativeDirectory){Join-Path $Target $relativeDirectory}else{$Target};if(-not(Test-Path -LiteralPath $targetDirectory)){[void](New-Item -ItemType Directory -Path $targetDirectory)}
      foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)){$attributes=[IO.File]::GetAttributes($entry);if($attributes-band[IO.FileAttributes]::ReparsePoint){throw 'ROLLBACK_STORAGE_PAYLOAD_REPARSE_REJECTED'};if($attributes-band[IO.FileAttributes]::Directory){$pending.Push($entry);continue};$item=[IO.FileInfo]::new($entry);$count+=1;$total+=$item.Length;if($count-gt$script:MaximumInventoryFiles-or$total-gt$script:MaximumInventoryBytes-or$item.Length-gt536870912){throw 'ROLLBACK_STORAGE_PAYLOAD_LIMIT'};$relative=$item.FullName.Substring($sourcePrefix.Length);$destination=Join-Path $Target $relative;$destinationParent=Split-Path -Parent $destination;if(-not(Test-Path -LiteralPath $destinationParent)){[void](New-Item -ItemType Directory -Path $destinationParent)};$input=[IO.FileStream]::new($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read,1048576,[IO.FileOptions]::SequentialScan);$output=[IO.FileStream]::new($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,1048576,[IO.FileOptions]::WriteThrough);try{$buffer=New-Object byte[] 1048576;while(($read=$input.Read($buffer,0,$buffer.Length))-gt0){Assert-RestoreDeadline;$output.Write($buffer,0,$read)};$output.Flush($true)}finally{if($buffer){[Array]::Clear($buffer,0,$buffer.Length)};$output.Dispose();$input.Dispose()};if((Hash $destination 536870912 'ROLLBACK_STORAGE_STAGING_HASH_REJECTED')-cne(Hash $item.FullName 536870912 'ROLLBACK_STORAGE_SOURCE_HASH_REJECTED')){throw 'ROLLBACK_STORAGE_STAGING_HASH_MISMATCH'}}
    }
    Set-LocalRecoveryExactAcl $Target 'ADMIN_ONLY' $FileSystemEvidence;Assert-LocalRecoveryExactAcl $Target 'ADMIN_ONLY' $FileSystemEvidence|Out-Null;$sourceDigest=InventoryDigest $sourceRoot;$targetDigest=InventoryDigest $Target;if($sourceDigest-cne$targetDigest){throw 'ROLLBACK_STORAGE_STAGING_INVENTORY_MISMATCH'};return $targetDigest
  }catch{if(Test-Path -LiteralPath $Target){Remove-Item -LiteralPath $Target -Recurse -Force};throw}
}
function Restore-OriginalStorage([string]$Live,[string]$Staging,[string]$Preserved,[string]$Workspace,[string]$ExpectedOriginalDigest,$FileSystemEvidence) {
  Assert-DailyStoragePaths $Live $Staging $Preserved $Workspace
  if(Test-Path -LiteralPath $Preserved -PathType Container){
    if(Test-Path -LiteralPath $Live){if(Test-Path -LiteralPath $Staging){throw 'ROLLBACK_STORAGE_RECOVERY_STAGING_COLLISION'};[IO.Directory]::Move($Live,$Staging)}
    [IO.Directory]::Move($Preserved,$Live)
    Set-LocalRecoveryExactAcl $Live 'CORE_MODIFY' $FileSystemEvidence;Assert-LocalRecoveryExactAcl $Live 'CORE_MODIFY' $FileSystemEvidence|Out-Null
    if(Test-Path -LiteralPath $Staging){Set-LocalRecoveryExactAcl $Staging 'ADMIN_ONLY' $FileSystemEvidence;Assert-LocalRecoveryExactAcl $Staging 'ADMIN_ONLY' $FileSystemEvidence|Out-Null}
  }
  if(-not(Test-Path -LiteralPath $Live -PathType Container)-or(InventoryDigest $Live)-cne$ExpectedOriginalDigest){throw 'ROLLBACK_ORIGINAL_STORAGE_RECOVERY_FAILED'}
  if(Test-Path -LiteralPath $Staging){
    [void](InventoryDigest $Staging)
    Remove-Item -LiteralPath $Staging -Recurse -Force
    if(Test-Path -LiteralPath $Staging){throw 'ROLLBACK_STORAGE_RECOVERY_STAGING_CLEANUP_FAILED'}
  }
  return $true
}
function Get-RollbackStorageDigest {
  if($PreviousReleaseKind-eq'LEGACY_BASELINE'){
    $digest=TextHash (@("uploads=$(InventoryDigest ([string]$baseline.legacyUploadsRoot))","reports=$(InventoryDigest ([string]$baseline.legacyReportsRoot))") -join "`n")
    if($digest-cne$baseline.storageInventoryDigest){throw 'ROLLBACK_STORAGE_HASH_MISMATCH'}
    return $digest
  }
  $liveRoot=Join-Path ([IO.Path]::GetFullPath([string]$config.data.root)) 'storage'
  $backupPayloadRoot=Join-Path $backupRoot 'storage-payload'
  $liveDigest=InventoryDigest $liveRoot
  $backupDigest=InventoryDigest $backupPayloadRoot
  if($liveDigest-cne$backupDigest){throw 'ROLLBACK_LOCAL_STORAGE_BACKUP_HASH_MISMATCH'}
  return $liveDigest
}
function KpiSql { return "SELECT concat_ws('|',(SELECT count(*) FROM meta_adset_daily_metrics WHERE is_current),(SELECT coalesce(sum(spend_usd),0)::text FROM meta_adset_daily_metrics WHERE is_current),(SELECT coalesce(sum(result_count),0)::text FROM meta_adset_daily_metrics WHERE is_current),(SELECT count(*) FROM meta_ad_daily_metrics WHERE is_current),(SELECT coalesce(sum(purchase_count),0)::text FROM meta_ad_daily_metrics WHERE is_current),(SELECT count(*) FROM cafe24_order_lines WHERE is_current),(SELECT coalesce(sum(total_paid_krw),0)::text FROM cafe24_order_lines WHERE is_current),(SELECT count(*) FROM coupang_sale_lines WHERE is_current),(SELECT coalesce(sum(net_sales_krw),0)::text FROM coupang_sale_lines WHERE is_current),(SELECT count(*) FROM coupang_ad_metrics WHERE is_current),(SELECT coalesce(sum(ad_spend_krw),0)::text FROM coupang_ad_metrics WHERE is_current),(SELECT coalesce(sum(total_orders_1d),0)::text FROM coupang_ad_metrics WHERE is_current),(SELECT count(*) FROM coupang_manual_purchases),(SELECT coalesce(sum(quantity),0)::text FROM coupang_manual_purchases),(SELECT coalesce(sum(sales_amount_krw),0)::text FROM coupang_manual_purchases),(SELECT coalesce(sum(total_cost_krw),0)::text FROM coupang_manual_purchases),(SELECT count(*) FROM decision_logs),(SELECT count(*) FROM change_logs),(SELECT count(*) FROM report_exports))" }
function Quote-Identifier([string]$Value) { return '"' + $Value.Replace('"','""') + '"' }
function Get-PreservedSchemaName { $context = Get-ApprovalContext;return '__metaads_pre_' + $context.instanceId.Replace('-','').Substring(0,16) }

function Assert-LegacyQuiesceState($Baseline,$Migration,[string]$BaselineHash) {
  $quiescePath = Existing $LegacyQuiesceEvidencePath $false 'ROLLBACK_QUIESCE_EVIDENCE_NOT_FOUND'
  $quiescePublic = Existing $QuiesceReceiptPublicKeyPath $false 'ROLLBACK_QUIESCE_PUBLIC_KEY_NOT_FOUND'
  AssertHash $quiescePath $ExpectedLegacyQuiesceEvidenceSha256 'ROLLBACK_QUIESCE_EVIDENCE_HASH_MISMATCH' 16777216
  AssertHash $quiescePublic $ExpectedQuiesceReceiptPublicKeySha256 'ROLLBACK_QUIESCE_PUBLIC_KEY_HASH_MISMATCH' 1048576
  [void](Invoke-Bounded $NodePath @($AttestationVerifierPath,$quiescePublic,$quiescePath,'legacy-quiesce') @{} 'ROLLBACK_QUIESCE_SIGNATURE_VERIFY')
  $value = Read-BoundedJson $quiescePath 16777216 'ROLLBACK_QUIESCE_EVIDENCE_INVALID'
  try { $completed = [datetimeoffset]::Parse([string]$value.completedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind) } catch { throw 'ROLLBACK_QUIESCE_TIME_INVALID' }
  $now = [datetimeoffset]::UtcNow
  if ($value.version -ne 2 -or $value.result -cne 'PASS' -or $value.signingKeyId -notmatch '^[0-9a-f]{64}$' -or @($value.ports).Count -ne 2 -or (@($value.ports)-join'|') -cne '3100|4100' -or $value.baselineSha256 -cne $BaselineHash -or $value.processIdentityDigest -cne $Baseline.processIdentityDigest -or $value.restartCanonicalDigest -cne $Baseline.restartCanonicalDigest -or $value.webLaunchCanonicalDigest -cne $Baseline.webLaunchCanonicalDigest -or $value.apiLaunchCanonicalDigest -cne $Baseline.apiLaunchCanonicalDigest -or -not $value.legacyIdentityHealthSmokeVerifiedBeforeStop -or -not $value.processesStopped -or -not $value.listenersAbsent -or $value.databaseMutated -or $value.webProcessId -ne $Baseline.webProcessId -or $value.apiProcessId -ne $Baseline.apiProcessId -or $value.restartSpecSha256 -cne $Baseline.restartSpecSha256 -or $Migration.legacyQuiesceEvidenceSha256 -cne $ExpectedLegacyQuiesceEvidenceSha256.ToLowerInvariant() -or $completed -lt $now.AddHours(-24) -or $completed -gt $now.AddMinutes(5)) { throw 'ROLLBACK_QUIESCE_EVIDENCE_REJECTED' }
  if (Get-Process -Id ([int]$Baseline.webProcessId),([int]$Baseline.apiProcessId) -ErrorAction SilentlyContinue) { throw 'ROLLBACK_BASELINE_WRITER_IDENTITY_STILL_PRESENT' }
  if (@(Get-NetTCPConnection -State Listen -LocalPort 3100,4100 -ErrorAction SilentlyContinue).Count) { throw 'ROLLBACK_LEGACY_LISTENER_PRESENT' }
  return [pscustomobject]@{EvidenceSha256=(Hash $quiescePath 16777216);PublicKeySha256=(Hash $quiescePublic 1048576);CompletedAt=$completed.ToUniversalTime().ToString('o');ProcessIdentityDigest=[string]$value.processIdentityDigest;RestartCanonicalDigest=[string]$value.restartCanonicalDigest;WebProcessId=[int]$value.webProcessId;ApiProcessId=[int]$value.apiProcessId;SigningKeyId=[string]$value.signingKeyId}
}

function Get-CurrentEdgeIdentity {
  $runtime = Existing $RuntimeConfigPath $false 'ROLLBACK_RUNTIME_NOT_FOUND'
  AssertHash $runtime $ExpectedRuntimeConfigSha256 'ROLLBACK_RUNTIME_HASH_MISMATCH' 16777216
  $config = Read-BoundedJson $runtime 16777216 'ROLLBACK_RUNTIME_INVALID'
  $node = Existing $NodePath $false 'ROLLBACK_NODE_NOT_FOUND'
  AssertHash $node $ExpectedNodeSha256 'ROLLBACK_NODE_HASH_MISMATCH'
  $releaseRoot = Existing $EdgeReleaseRoot $true 'ROLLBACK_EDGE_RELEASE_ROOT_NOT_FOUND'
  $releaseManifestPath = Existing (Join-Path $releaseRoot 'release-manifest.json') $false 'ROLLBACK_EDGE_RELEASE_MANIFEST_NOT_FOUND'
  AssertHash $releaseManifestPath $ExpectedEdgeReleaseManifestSha256 'ROLLBACK_EDGE_RELEASE_MANIFEST_HASH_MISMATCH' 16777216
  $releaseManifest = Read-BoundedJson $releaseManifestPath 16777216 'ROLLBACK_EDGE_RELEASE_MANIFEST_INVALID'
  if($releaseManifest.version-ne4-or-not$releaseManifest.runtimeSmokeVerified-or$releaseManifest.releaseId-cne$config.release.id-or$releaseManifest.migrationDigest-cne$config.release.migrationDigest-or$releaseManifest.appliedMigrationDigest-cne$config.release.appliedMigrationDigest-or[IO.Path]::GetFullPath([string]$config.hostSecurity.nodeProgramPath)-cne$node-or[string]$config.hostSecurity.nodeProgramSha256-cne$ExpectedNodeSha256.ToLowerInvariant()){throw 'ROLLBACK_EDGE_RELEASE_IDENTITY_REJECTED'}
  if($EdgeStateMode-eq'ACTIVE_LOCAL_EDGE'){
    $drainPath=Existing $DrainStatePath $false 'ROLLBACK_DRAIN_NOT_FOUND';AssertHash $drainPath $ExpectedDrainStateSha256 'ROLLBACK_DRAIN_HASH_MISMATCH' 1048576
    $identity=Assert-ExactEdgeDrainIdentity -EdgeServiceName $EdgeServiceName -RuntimeConfigPath $runtime -ExpectedRuntimeConfigSha256 $ExpectedRuntimeConfigSha256 -ReleaseRoot $releaseRoot -ExpectedReleaseManifestSha256 $ExpectedEdgeReleaseManifestSha256 -NodePath $node -ExpectedNodeSha256 $ExpectedNodeSha256 -DrainStatePath $drainPath -ExpectedDrainStateSha256 $ExpectedDrainStateSha256 -AttestationVerifierPath $AttestationVerifierPath -ExpectedAttestationVerifierSha256 $ExpectedAttestationVerifierSha256 -EdgeSigningPublicKeyPath $EdgeSigningPublicKeyPath -ExpectedEdgeSigningPublicKeySha256 $ExpectedEdgeSigningPublicKeySha256 -MaximumAgeSeconds 30
    return [pscustomobject]@{stateMode=$EdgeStateMode;processId=$identity.EdgeProcessId;processStartedAt=$identity.EdgeProcessStartedAt;executablePath=$node;executableSha256=$ExpectedNodeSha256.ToLowerInvariant();commandLineSha256=$identity.CommandLineSha256;releaseRoot=$releaseRoot;releaseId=[string]$config.release.id;releaseManifestSha256=$ExpectedEdgeReleaseManifestSha256.ToLowerInvariant();listenerAddress=$identity.ListenerAddress;listenerPort=$identity.ListenerPort;serviceProcessId=$identity.ServiceProcessId;activeRequests=0;drainCompletedAt=$identity.DrainCompletedAt;drainStateSha256=(Hash $drainPath 1048576);identityDigest=$identity.IdentityDigest;proofType='SIGNED_EDGE_DRAIN_V2'}
  }
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue);if($listeners.Count){throw 'ROLLBACK_STOPPED_MODE_EDGE_LISTENER_PRESENT'}
  $service=Get-CimInstance Win32_Service -Filter "Name='$EdgeServiceName'" -ErrorAction SilentlyContinue;if($service-and($service.State-cne'Stopped'-or$service.StartMode-notin@('Manual','Disabled'))){throw 'ROLLBACK_STOPPED_MODE_EDGE_SERVICE_UNSAFE'}
  $serviceState=if($service){"$($service.State)|$($service.StartMode)"}else{'ABSENT'}
  if($EdgeStateMode-eq'STOPPED_LOCAL_EDGE'){
    if($RecoveryPurpose-cne'DAILY_BACKUP_RECOVERY'-or$PreviousReleaseKind-cne'LOCAL_RELEASE'){throw 'ROLLBACK_STOPPED_LOCAL_EDGE_PURPOSE_REJECTED'}
    $stoppedFsPath=Existing $FileSystemEvidencePath $false 'ROLLBACK_FS_NOT_FOUND';AssertHash $stoppedFsPath $ExpectedFileSystemEvidenceSha256 'ROLLBACK_FS_HASH_MISMATCH' 16777216;$stoppedFs=Read-BoundedJson $stoppedFsPath 16777216 'ROLLBACK_FILESYSTEM_EVIDENCE_INVALID'
    $stopped=Assert-StoppedLocalRecoveryBoundary -CoreServiceName $CoreServiceName -EdgeServiceName $EdgeServiceName -ExpectedCoreSid ([string]$stoppedFs.coreServiceSid) -ExpectedEdgeSid ([string]$stoppedFs.edgeServiceSid) -WebPort ([int]$config.internalPorts.web) -ApiPort ([int]$config.internalPorts.api)
    $identityDigest=TextHash (@('stopped-local-recovery-boundary-v2',$ExpectedRuntimeConfigSha256.ToLowerInvariant(),$releaseRoot,$ExpectedEdgeReleaseManifestSha256.ToLowerInvariant(),[string]$config.release.id,$node,$ExpectedNodeSha256.ToLowerInvariant(),$stopped.IdentityDigest)-join"`n")
    return [pscustomobject]@{stateMode=$EdgeStateMode;processId=0;processStartedAt=$null;executablePath=$node;executableSha256=$ExpectedNodeSha256.ToLowerInvariant();commandLineSha256=$null;releaseRoot=$releaseRoot;releaseId=[string]$config.release.id;releaseManifestSha256=$ExpectedEdgeReleaseManifestSha256.ToLowerInvariant();listenerAddress=$null;listenerPort=0;serviceProcessId=0;activeRequests=0;drainCompletedAt=$null;drainStateSha256=$null;identityDigest=$identityDigest;proofType='STOPPED_LOCAL_SERVICES_ABSENCE_V2';edgeServiceState=$stopped.EdgeServiceState;coreServiceState=$stopped.CoreServiceState;coreServiceSid=$stopped.CoreServiceSid;edgeServiceSid=$stopped.EdgeServiceSid;serviceRightsExact=$true;serviceAccountProcessesAbsent=$true;protectedListenersAbsent=$true}
  }
  $identityDigest=TextHash (@('edge-rollback-legacy-no-edge-v1',$ExpectedRuntimeConfigSha256.ToLowerInvariant(),$releaseRoot,$ExpectedEdgeReleaseManifestSha256.ToLowerInvariant(),[string]$config.release.id,$node,$ExpectedNodeSha256.ToLowerInvariant(),$ExpectedLegacyQuiesceEvidenceSha256.ToLowerInvariant(),$serviceState,'443-absent')-join"`n")
  return [pscustomobject]@{stateMode=$EdgeStateMode;processId=0;processStartedAt=$null;executablePath=$node;executableSha256=$ExpectedNodeSha256.ToLowerInvariant();commandLineSha256=$null;releaseRoot=$releaseRoot;releaseId=[string]$config.release.id;releaseManifestSha256=$ExpectedEdgeReleaseManifestSha256.ToLowerInvariant();listenerAddress=$null;listenerPort=0;serviceProcessId=0;activeRequests=0;drainCompletedAt=$null;drainStateSha256=$null;identityDigest=$identityDigest;proofType='SIGNED_LEGACY_QUIESCE_V2';edgeServiceState=$serviceState}
}

function Assert-ActionTimeRecoveryBoundary([string]$ExpectedIdentityDigest) {
  if($RecoveryPurpose-ne'DAILY_BACKUP_RECOVERY'){return}
  $current=Get-CurrentEdgeIdentity
  if($current.proofType-cne'STOPPED_LOCAL_SERVICES_ABSENCE_V2'-or$current.identityDigest-cne$ExpectedIdentityDigest-or-not$current.serviceRightsExact-or-not$current.serviceAccountProcessesAbsent-or-not$current.protectedListenersAbsent){throw 'ROLLBACK_ACTION_TIME_LOCAL_RECOVERY_BOUNDARY_CHANGED'}
}

function New-RollbackPlan([string]$IntendedAction) {
  if ($IntendedAction -notin @('Apply','Recover','VerifyEvidence','VerifyRecovery')) { throw 'ROLLBACK_RESTORE_PLAN_ACTION_REQUIRED' }
  $context = Get-ApprovalContext
  $edge = Get-CurrentEdgeIdentity
  $existingRollbackRecord=$null
  if($IntendedAction-eq'Apply'){$preserved=Get-PreservedSchemaName}else{
    $existingRollbackPath=Existing $RollbackJournalPath $false 'ROLLBACK_DURABLE_JOURNAL_NOT_FOUND';AssertHash $existingRollbackPath $ExpectedRollbackJournalSha256 'ROLLBACK_DURABLE_JOURNAL_HASH_MISMATCH' 1048576;$existingRollbackRecord=Read-BoundedJson $existingRollbackPath 1048576 'ROLLBACK_DURABLE_JOURNAL_INVALID';$preserved=[string]$existingRollbackRecord.preservedSchema
    $allowedState=if($IntendedAction-eq'Recover'){$existingRollbackRecord.state-in@('INTENT','STORAGE_STAGED_RESTORE_PENDING','PRESERVED_ORIGINAL_RESTORE_IN_PROGRESS','DATABASE_RESTORED_STORAGE_SWITCH_PENDING','STORAGE_SWITCHED_MAINTENANCE_REQUIRED','COMPLETE_MAINTENANCE_REQUIRED','RECOVERY_INTENT','FAILED_MAINTENANCE_REQUIRED')}elseif($IntendedAction-eq'VerifyRecovery'){$existingRollbackRecord.state-ceq'RECOVERED_ORIGINAL_MAINTENANCE_REQUIRED'}else{$existingRollbackRecord.state-ceq'COMPLETE_MAINTENANCE_REQUIRED'}
    $existingPurpose=if([string]$existingRollbackRecord.recoveryPurpose){[string]$existingRollbackRecord.recoveryPurpose}else{'MIGRATION_ROLLBACK'}
    if($existingRollbackRecord.version -ne 4 -or $existingPurpose -cne $RecoveryPurpose -or $existingRollbackRecord.previousReleaseKind -cne $PreviousReleaseKind -or -not $allowedState -or $preserved -notmatch '^__metaads_pre_[0-9a-f]{16}$' -or ([string]$existingRollbackRecord.databaseSchema -and [string]$existingRollbackRecord.databaseSchema -cne $ConfirmDatabaseSchema)){throw 'ROLLBACK_EXISTING_JOURNAL_STATE_REJECTED'}
  }
  $parameters = [ordered]@{
    provider='supabase_postgres';recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;projectRef=Get-ApprovalText $ConfirmProjectRef '^[a-z]{20}$' 'ROLLBACK_PROJECT_REQUIRED';host=Get-ApprovalText $ConfirmDatabaseHost '^(?:db\.[a-z]{20}\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$' 'ROLLBACK_HOST_REQUIRED';port=5432;databaseName=Get-ApprovalText $ConfirmDatabaseName '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_DATABASE_REQUIRED';databaseSchema=Get-ApprovalText $ConfirmDatabaseSchema '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_SCHEMA_REQUIRED';preservedSchema=$preserved;databaseUser=Get-ApprovalText $ConfirmDatabaseUser '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_DATABASE_USER_REQUIRED'
    runtimeConfigPath=Get-ApprovalPath $RuntimeConfigPath 'ROLLBACK_RUNTIME_REQUIRED';runtimeConfigSha256=Get-ApprovalHash $ExpectedRuntimeConfigSha256 'ROLLBACK_RUNTIME_HASH_REQUIRED';rollbackJournalPath=Get-ApprovalPath $RollbackJournalPath 'ROLLBACK_DURABLE_JOURNAL_REQUIRED'
    maintenanceFlagPath=Get-ApprovalPath $MaintenanceFlagPath 'ROLLBACK_MAINTENANCE_REQUIRED';maintenanceFlagSha256=Get-ApprovalHash $ExpectedMaintenanceFlagSha256 'ROLLBACK_MAINTENANCE_HASH_REQUIRED';edgeStateMode=$EdgeStateMode;quiescenceProofType=$edge.proofType;coreServiceName=$CoreServiceName;edgeServiceName=$EdgeServiceName
    edgeProcessId=$edge.processId;edgeProcessStartedAt=$edge.processStartedAt;edgeExecutablePath=$edge.executablePath;edgeExecutableSha256=$edge.executableSha256;edgeCommandLineSha256=$edge.commandLineSha256;edgeReleaseRoot=$edge.releaseRoot;edgeReleaseId=$edge.releaseId;edgeReleaseManifestSha256=$edge.releaseManifestSha256;edgeListenerAddress=$edge.listenerAddress;edgeListenerPort=$edge.listenerPort;edgeIdentityDigest=$edge.identityDigest;coreServiceState=$edge.coreServiceState;edgeServiceState=$edge.edgeServiceState;coreServiceSid=$edge.coreServiceSid;edgeServiceSid=$edge.edgeServiceSid;serviceRightsExact=$edge.serviceRightsExact;serviceAccountProcessesAbsent=$edge.serviceAccountProcessesAbsent;protectedListenersAbsent=$edge.protectedListenersAbsent
    backupEvidencePath=Get-ApprovalPath $BackupEvidencePath 'ROLLBACK_BACKUP_EVIDENCE_REQUIRED';backupEvidenceSha256=Get-ApprovalHash $ExpectedBackupEvidenceSha256 'ROLLBACK_BACKUP_EVIDENCE_HASH_REQUIRED';backupPublicKeyPath=Get-ApprovalPath $BackupReceiptPublicKeyPath 'ROLLBACK_BACKUP_KEY_REQUIRED';backupPublicKeySha256=Get-ApprovalHash $ExpectedBackupReceiptPublicKeySha256 'ROLLBACK_BACKUP_KEY_HASH_REQUIRED';backupDirectory=Get-ApprovalPath $BackupDirectory 'ROLLBACK_BACKUP_DIRECTORY_REQUIRED';integrityKeyPath=Get-ApprovalPath $BackupIntegrityKeyFile 'ROLLBACK_INTEGRITY_KEY_REQUIRED';integrityKeySha256=Get-ApprovalHash $ExpectedBackupIntegrityKeySha256 'ROLLBACK_INTEGRITY_KEY_HASH_REQUIRED'
    nodePath=Get-ApprovalPath $NodePath 'ROLLBACK_NODE_REQUIRED';nodeSha256=Get-ApprovalHash $ExpectedNodeSha256 'ROLLBACK_NODE_HASH_REQUIRED';verifierPath=Get-ApprovalPath $AttestationVerifierPath 'ROLLBACK_VERIFIER_REQUIRED';verifierSha256=Get-ApprovalHash $ExpectedAttestationVerifierSha256 'ROLLBACK_VERIFIER_HASH_REQUIRED';recoveryProcessTreeHelperPath=Get-ApprovalPath $recoveryProcessTreeHelper 'ROLLBACK_PROCESS_TREE_HELPER_REQUIRED';recoveryProcessTreeHelperSha256=Get-ApprovalHash $ExpectedRecoveryProcessTreeHelperSha256 'ROLLBACK_PROCESS_TREE_HELPER_HASH_REQUIRED';localRecoverySecurityHelperPath=Get-ApprovalPath $localRecoverySecurityHelper 'ROLLBACK_LOCAL_RECOVERY_SECURITY_HELPER_REQUIRED';localRecoverySecurityHelperSha256=Get-ApprovalHash $ExpectedLocalRecoverySecurityHelperSha256 'ROLLBACK_LOCAL_RECOVERY_SECURITY_HELPER_HASH_REQUIRED';psqlPath=Get-ApprovalPath $PsqlPath 'ROLLBACK_PSQL_REQUIRED';psqlSha256=Get-ApprovalHash $ExpectedPsqlSha256 'ROLLBACK_PSQL_HASH_REQUIRED';pgRestorePath=Get-ApprovalPath $PgRestorePath 'ROLLBACK_PGRESTORE_REQUIRED';pgRestoreSha256=Get-ApprovalHash $ExpectedPgRestoreSha256 'ROLLBACK_PGRESTORE_HASH_REQUIRED';pgPassPath=Get-ApprovalPath $PgPassFile 'ROLLBACK_PGPASS_REQUIRED';pgPassSha256=Get-ApprovalHash $ExpectedPgPassSha256 'ROLLBACK_PGPASS_HASH_REQUIRED';caPath=Get-ApprovalPath $CaCertificatePath 'ROLLBACK_CA_REQUIRED';caSha256=Get-ApprovalHash $ExpectedCaCertificateSha256 'ROLLBACK_CA_HASH_REQUIRED'
    filesystemEvidencePath=Get-ApprovalPath $FileSystemEvidencePath 'ROLLBACK_FS_REQUIRED';filesystemEvidenceSha256=Get-ApprovalHash $ExpectedFileSystemEvidenceSha256 'ROLLBACK_FS_HASH_REQUIRED';evidenceOutputPath=Get-ApprovalPath $EvidenceOutputPath 'ROLLBACK_EVIDENCE_OUTPUT_REQUIRED';maximumRestoreDurationSeconds=$MaximumRestoreDurationSeconds;maximumDatabaseDumpBytes=$MaximumDatabaseDumpBytes;maximumChildOutputBytes=$MaximumChildOutputBytes;approvalInstanceId=$context.instanceId
  }
  if($RecoveryPurpose-eq'MIGRATION_ROLLBACK'){
    $parameters.migrationJournalPath=Get-ApprovalPath $MigrationJournalPath 'ROLLBACK_MIGRATION_JOURNAL_REQUIRED';$parameters.migrationJournalSha256=Get-ApprovalHash $ExpectedMigrationJournalSha256 'ROLLBACK_MIGRATION_JOURNAL_HASH_REQUIRED'
  }else{
    if($PreviousReleaseKind-cne'LOCAL_RELEASE'-or$EdgeStateMode-cne'STOPPED_LOCAL_EDGE'){throw 'ROLLBACK_DAILY_RECOVERY_REQUIRES_STOPPED_EDGE'}
    $parameters.restoreRehearsalEvidencePath=Get-ApprovalPath $RestoreRehearsalEvidencePath 'ROLLBACK_REHEARSAL_REQUIRED';$parameters.restoreRehearsalEvidenceSha256=Get-ApprovalHash $ExpectedRestoreRehearsalEvidenceSha256 'ROLLBACK_REHEARSAL_HASH_REQUIRED';$parameters.rehearsalPublicKeyPath=Get-ApprovalPath $RestoreReceiptPublicKeyPath 'ROLLBACK_REHEARSAL_PUBLIC_KEY_REQUIRED';$parameters.rehearsalPublicKeySha256=Get-ApprovalHash $ExpectedRestoreReceiptPublicKeySha256 'ROLLBACK_REHEARSAL_PUBLIC_KEY_HASH_REQUIRED'
    if($IntendedAction-eq'Apply'){
      $runtimeForPlan=Read-BoundedJson (Existing $RuntimeConfigPath $false 'ROLLBACK_RUNTIME_NOT_FOUND') 16777216 'ROLLBACK_RUNTIME_INVALID';$dataRoot=[IO.Path]::GetFullPath([string]$runtimeForPlan.data.root);$workspace=Get-ApprovalPath $RecoveryWorkspaceRoot 'ROLLBACK_RECOVERY_WORKSPACE_REQUIRED';$suffix=$context.instanceId.Replace('-','').Substring(0,16)
      $parameters.recoveryWorkspaceRoot=$workspace;$parameters.liveStorageRoot=Get-ApprovalPath (Join-Path $dataRoot 'storage') 'ROLLBACK_LIVE_STORAGE_REQUIRED';$parameters.stagingStorageRoot=Get-ApprovalPath (Join-Path $workspace ('storage-recovery-'+$suffix)) 'ROLLBACK_STAGING_STORAGE_REQUIRED';$parameters.preservedStorageRoot=Get-ApprovalPath (Join-Path $workspace ('storage-preserved-'+$suffix)) 'ROLLBACK_PRESERVED_STORAGE_REQUIRED'
    }else{
      $recordedWorkspace=if([string]$existingRollbackRecord.recoveryWorkspaceRoot){[string]$existingRollbackRecord.recoveryWorkspaceRoot}else{Split-Path -Parent ([IO.Path]::GetFullPath([string]$existingRollbackRecord.stagingStorageRoot))}
      $parameters.recoveryWorkspaceRoot=Get-ApprovalPath $recordedWorkspace 'ROLLBACK_RECOVERY_WORKSPACE_REQUIRED';$parameters.liveStorageRoot=Get-ApprovalPath ([string]$existingRollbackRecord.liveStorageRoot) 'ROLLBACK_LIVE_STORAGE_REQUIRED';$parameters.stagingStorageRoot=Get-ApprovalPath ([string]$existingRollbackRecord.stagingStorageRoot) 'ROLLBACK_STAGING_STORAGE_REQUIRED';$parameters.preservedStorageRoot=Get-ApprovalPath ([string]$existingRollbackRecord.preservedStorageRoot) 'ROLLBACK_PRESERVED_STORAGE_REQUIRED'
    }
  }
  if($PreviousReleaseKind-eq'LEGACY_BASELINE'){$parameters.baselinePath=Get-ApprovalPath $LegacyBaselineEvidencePath 'ROLLBACK_BASELINE_REQUIRED';$parameters.baselineSha256=Get-ApprovalHash $ExpectedLegacyBaselineEvidenceSha256 'ROLLBACK_BASELINE_HASH_REQUIRED';$parameters.legacyQuiesceEvidencePath=Get-ApprovalPath $LegacyQuiesceEvidencePath 'ROLLBACK_QUIESCE_EVIDENCE_REQUIRED';$parameters.legacyQuiesceEvidenceSha256=Get-ApprovalHash $ExpectedLegacyQuiesceEvidenceSha256 'ROLLBACK_QUIESCE_EVIDENCE_HASH_REQUIRED';$parameters.quiescePublicKeyPath=Get-ApprovalPath $QuiesceReceiptPublicKeyPath 'ROLLBACK_QUIESCE_PUBLIC_KEY_REQUIRED';$parameters.quiescePublicKeySha256=Get-ApprovalHash $ExpectedQuiesceReceiptPublicKeySha256 'ROLLBACK_QUIESCE_PUBLIC_KEY_HASH_REQUIRED'}elseif($RecoveryPurpose-eq'MIGRATION_ROLLBACK'-and$EdgeStateMode-ne'ACTIVE_LOCAL_EDGE') { throw 'ROLLBACK_LOCAL_RELEASE_REQUIRES_ACTIVE_EDGE_DRAIN' }
  if($EdgeStateMode-eq'ACTIVE_LOCAL_EDGE'){$parameters.drainStatePath=Get-ApprovalPath $DrainStatePath 'ROLLBACK_DRAIN_REQUIRED';$parameters.drainStateSha256=Get-ApprovalHash $ExpectedDrainStateSha256 'ROLLBACK_DRAIN_HASH_REQUIRED';$parameters.maximumDrainAgeSeconds=30;$parameters.edgeDrainHelperPath=Get-ApprovalPath $edgeDrainHelper 'ROLLBACK_EDGE_DRAIN_HELPER_REQUIRED';$parameters.edgeDrainHelperSha256=Get-ApprovalHash $ExpectedEdgeDrainHelperSha256 'ROLLBACK_EDGE_DRAIN_HELPER_HASH_REQUIRED';$parameters.edgeSigningPublicKeyPath=Get-ApprovalPath $EdgeSigningPublicKeyPath 'ROLLBACK_EDGE_PUBLIC_KEY_REQUIRED';$parameters.edgeSigningPublicKeySha256=Get-ApprovalHash $ExpectedEdgeSigningPublicKeySha256 'ROLLBACK_EDGE_PUBLIC_KEY_HASH_REQUIRED'}else{$parameters.edgeListenerAbsent=$true;$parameters.edgeServiceState=$edge.edgeServiceState}
  if ($IntendedAction -eq 'Apply') {
    $parameters.signerPath=Get-ApprovalPath $AttestationSignerPath 'ROLLBACK_SIGNER_REQUIRED';$parameters.signerSha256=Get-ApprovalHash $ExpectedAttestationSignerSha256 'ROLLBACK_SIGNER_HASH_REQUIRED';$parameters.restorePrivateKeyPath=Get-ApprovalPath $RestoreReceiptPrivateKeyPath 'ROLLBACK_PRIVATE_KEY_REQUIRED';$parameters.restorePrivateKeySha256=Get-ApprovalHash $ExpectedRestoreReceiptPrivateKeySha256 'ROLLBACK_PRIVATE_KEY_HASH_REQUIRED'
  } elseif($IntendedAction-eq'VerifyEvidence') {
    $parameters.rollbackJournalSha256=Get-ApprovalHash $ExpectedRollbackJournalSha256 'ROLLBACK_DURABLE_JOURNAL_HASH_REQUIRED';$parameters.evidenceSha256=Get-ApprovalHash $ExpectedEvidenceSha256 'ROLLBACK_EVIDENCE_HASH_REQUIRED';$parameters.restorePublicKeyPath=Get-ApprovalPath $RestoreReceiptPublicKeyPath 'ROLLBACK_PUBLIC_KEY_REQUIRED';$parameters.restorePublicKeySha256=Get-ApprovalHash $ExpectedRestoreReceiptPublicKeySha256 'ROLLBACK_PUBLIC_KEY_HASH_REQUIRED'
  } else {
    $parameters.rollbackJournalSha256=Get-ApprovalHash $ExpectedRollbackJournalSha256 'ROLLBACK_DURABLE_JOURNAL_HASH_REQUIRED';$parameters.recoverySourceState=[string]$existingRollbackRecord.state
  }
  $impact=if($IntendedAction-eq'Apply'){"Keeps maintenance and all writers quiesced; durably records INTENT; preserves the current schema and, for daily recovery, the current local Storage before restoring and proving the signed $PreviousReleaseKind backup"}elseif($IntendedAction-eq'Recover'){'Keeps maintenance and writers quiesced; hash-pins the interrupted recovery journal; returns the exact preserved original schema and local Storage when present'}else{'Read-only verification of the exact completed recovery or recovered-original journal and live schema/storage state while maintenance remains enabled'}
  return New-ApprovalPlan $PSCommandPath $IntendedAction $parameters "Exact existing Supabase target $ConfirmProjectRef/$ConfirmDatabaseHost`:5432/$ConfirmDatabaseName schema $ConfirmDatabaseSchema with preserved schema $preserved" $impact 'Recovery never restarts writers or disables maintenance; a failed recovery remains journaled and requires a new exact hash-pinned approval'
}

$intended = if ($Action -eq 'Apply') { 'Apply' } elseif($Action-eq'Recover'){'Recover'}elseif($Action-eq'VerifyRecovery'){'VerifyRecovery'}else { 'VerifyEvidence' }
$approvalPlan = New-RollbackPlan $(if ($Action -eq 'Plan') { $PlannedAction } else { $intended })
if ($Action -eq 'Plan') { $approvalPlan | ConvertTo-Json -Depth 16;exit 0 }
Assert-ApprovedPlan $approvalPlan ([bool]$Approved) $ApprovedPlanSha256
$edgeIdentity = Get-CurrentEdgeIdentity
if ($edgeIdentity.identityDigest -cne $approvalPlan.exactParameters.edgeIdentityDigest) { throw 'ROLLBACK_EDGE_IDENTITY_DRIFT' }

$runtime = Existing $RuntimeConfigPath $false 'ROLLBACK_RUNTIME_NOT_FOUND'
$baselinePath=$null;$quiescePath=$null;$quiescePublic=$null
if($PreviousReleaseKind-eq'LEGACY_BASELINE'){
  $baselinePath = Existing $LegacyBaselineEvidencePath $false 'ROLLBACK_BASELINE_NOT_FOUND'
  $quiescePath = Existing $LegacyQuiesceEvidencePath $false 'ROLLBACK_QUIESCE_EVIDENCE_NOT_FOUND'
  $quiescePublic = Existing $QuiesceReceiptPublicKeyPath $false 'ROLLBACK_QUIESCE_PUBLIC_KEY_NOT_FOUND'
}
$migrationJournal = if($RecoveryPurpose-eq'MIGRATION_ROLLBACK'){Existing $MigrationJournalPath $false 'ROLLBACK_MIGRATION_JOURNAL_NOT_FOUND'}else{$null}
$restoreRehearsal = if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){Existing $RestoreRehearsalEvidencePath $false 'ROLLBACK_REHEARSAL_NOT_FOUND'}else{$null}
$rehearsalPublic = if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){Existing $RestoreReceiptPublicKeyPath $false 'ROLLBACK_REHEARSAL_PUBLIC_KEY_NOT_FOUND'}else{$null}
$maintenancePath = Existing $MaintenanceFlagPath $false 'ROLLBACK_MAINTENANCE_NOT_FOUND'
$backupEvidence = Existing $BackupEvidencePath $false 'ROLLBACK_BACKUP_EVIDENCE_NOT_FOUND'
$backupPublic = Existing $BackupReceiptPublicKeyPath $false 'ROLLBACK_BACKUP_PUBLIC_KEY_NOT_FOUND'
$backupRoot = Existing $BackupDirectory $true 'ROLLBACK_BACKUP_DIRECTORY_NOT_FOUND'
$integrityKey = Existing $BackupIntegrityKeyFile $false 'ROLLBACK_INTEGRITY_KEY_NOT_FOUND'
$node = Existing $NodePath $false 'ROLLBACK_NODE_NOT_FOUND'
$verifier = Existing $AttestationVerifierPath $false 'ROLLBACK_VERIFIER_NOT_FOUND'
$processTreeHelper = Existing $recoveryProcessTreeHelper $false 'ROLLBACK_PROCESS_TREE_HELPER_NOT_FOUND'
$recoverySecurityHelper = Existing $localRecoverySecurityHelper $false 'ROLLBACK_LOCAL_RECOVERY_SECURITY_HELPER_NOT_FOUND'
$psql = Existing $PsqlPath $false 'ROLLBACK_PSQL_NOT_FOUND'
$pgRestore = Existing $PgRestorePath $false 'ROLLBACK_PGRESTORE_NOT_FOUND'
$pgpass = Existing $PgPassFile $false 'ROLLBACK_PGPASS_NOT_FOUND'
$ca = Existing $CaCertificatePath $false 'ROLLBACK_CA_NOT_FOUND'
$fsPath = Existing $FileSystemEvidencePath $false 'ROLLBACK_FS_NOT_FOUND'
$hashInputs=@(
  @($runtime,$ExpectedRuntimeConfigSha256,'ROLLBACK_RUNTIME_HASH_MISMATCH',16777216),@($maintenancePath,$ExpectedMaintenanceFlagSha256,'ROLLBACK_MAINTENANCE_HASH_MISMATCH',1048576),@($backupEvidence,$ExpectedBackupEvidenceSha256,'ROLLBACK_BACKUP_EVIDENCE_HASH_MISMATCH',16777216),@($backupPublic,$ExpectedBackupReceiptPublicKeySha256,'ROLLBACK_BACKUP_KEY_HASH_MISMATCH',1048576),@($integrityKey,$ExpectedBackupIntegrityKeySha256,'ROLLBACK_INTEGRITY_KEY_HASH_MISMATCH',1024),@($node,$ExpectedNodeSha256,'ROLLBACK_NODE_HASH_MISMATCH',1073741824),@($verifier,$ExpectedAttestationVerifierSha256,'ROLLBACK_VERIFIER_HASH_MISMATCH',16777216),@($processTreeHelper,$ExpectedRecoveryProcessTreeHelperSha256,'ROLLBACK_PROCESS_TREE_HELPER_HASH_MISMATCH',16777216),@($recoverySecurityHelper,$ExpectedLocalRecoverySecurityHelperSha256,'ROLLBACK_LOCAL_RECOVERY_SECURITY_HELPER_HASH_MISMATCH',16777216),@($psql,$ExpectedPsqlSha256,'ROLLBACK_PSQL_HASH_MISMATCH',1073741824),@($pgRestore,$ExpectedPgRestoreSha256,'ROLLBACK_PGRESTORE_HASH_MISMATCH',1073741824),@($pgpass,$ExpectedPgPassSha256,'ROLLBACK_PGPASS_HASH_MISMATCH',1048576),@($ca,$ExpectedCaCertificateSha256,'ROLLBACK_CA_HASH_MISMATCH',1048576),@($fsPath,$ExpectedFileSystemEvidenceSha256,'ROLLBACK_FS_HASH_MISMATCH',16777216)
)
$hashInputs+=if($RecoveryPurpose-eq'MIGRATION_ROLLBACK'){@($migrationJournal,$ExpectedMigrationJournalSha256,'ROLLBACK_MIGRATION_JOURNAL_HASH_MISMATCH',16777216)}else{@($restoreRehearsal,$ExpectedRestoreRehearsalEvidenceSha256,'ROLLBACK_REHEARSAL_HASH_MISMATCH',16777216),@($rehearsalPublic,$ExpectedRestoreReceiptPublicKeySha256,'ROLLBACK_REHEARSAL_PUBLIC_KEY_HASH_MISMATCH',1048576)}
if($PreviousReleaseKind-eq'LEGACY_BASELINE'){$hashInputs+=@(@($baselinePath,$ExpectedLegacyBaselineEvidenceSha256,'ROLLBACK_BASELINE_HASH_MISMATCH',16777216),@($quiescePath,$ExpectedLegacyQuiesceEvidenceSha256,'ROLLBACK_QUIESCE_EVIDENCE_HASH_MISMATCH',16777216),@($quiescePublic,$ExpectedQuiesceReceiptPublicKeySha256,'ROLLBACK_QUIESCE_PUBLIC_KEY_HASH_MISMATCH',1048576))}
foreach ($item in $hashInputs) { AssertHash $item[0] $item[1] $item[2] $item[3] }

$config = Read-BoundedJson $runtime 16777216 'ROLLBACK_RUNTIME_INVALID'
$db = $config.database
if ($db.provider -cne 'supabase_postgres' -or $db.projectRef -cne $ConfirmProjectRef -or $db.host -cne $ConfirmDatabaseHost -or $db.port -ne 5432 -or $db.name -cne $ConfirmDatabaseName -or $db.schema -cne $ConfirmDatabaseSchema -or $db.migrationUser -cne $ConfirmDatabaseUser) { throw 'ROLLBACK_DATABASE_TARGET_MISMATCH' }
if ($db.runtimeUser -notmatch '^[a-z][a-z0-9_]{0,62}$') { throw 'ROLLBACK_RUNTIME_DATABASE_USER_INVALID' }
$maintenance = Read-BoundedJson $maintenancePath 1048576 'ROLLBACK_MAINTENANCE_INVALID'
if ($maintenance.version -ne 1 -or -not $maintenance.enabled -or $maintenance.releaseId -cne $config.release.id -or @(Get-NetTCPConnection -State Listen -LocalPort 3100,4100 -ErrorAction SilentlyContinue).Count) { throw 'ROLLBACK_MAINTENANCE_DRAIN_OR_QUIESCE_REJECTED' }
$releaseManifestPath=Existing (Join-Path ([IO.Path]::GetFullPath($EdgeReleaseRoot)) 'release-manifest.json') $false 'ROLLBACK_RELEASE_MANIFEST_NOT_FOUND'
AssertHash $releaseManifestPath $ExpectedEdgeReleaseManifestSha256 'ROLLBACK_RELEASE_MANIFEST_HASH_MISMATCH' 268435456
$releaseManifest=Read-BoundedJson $releaseManifestPath 268435456 'ROLLBACK_RELEASE_MANIFEST_INVALID'
if($releaseManifest.version-ne4-or$releaseManifest.releaseId-cne$config.release.id-or($PreviousReleaseKind-eq'LOCAL_RELEASE'-and($releaseManifest.migrationDigest-cne$config.release.migrationDigest-or$releaseManifest.appliedMigrationDigest-cne$config.release.appliedMigrationDigest))){throw 'ROLLBACK_RELEASE_IDENTITY_REJECTED'}
$baseline=$null;if($PreviousReleaseKind-eq'LEGACY_BASELINE'){$baseline = Read-BoundedJson $baselinePath 16777216 'ROLLBACK_BASELINE_INVALID'}
$previousMigrationDigest=if($PreviousReleaseKind-eq'LEGACY_BASELINE'){[string]$baseline.migrationDigest}else{[string]$releaseManifest.migrationDigest}
$previousAppliedMigrationDigest=if($PreviousReleaseKind-eq'LOCAL_RELEASE'){[string]$releaseManifest.appliedMigrationDigest}else{$null}
$migration=$null
if($RecoveryPurpose-eq'MIGRATION_ROLLBACK'){
  $migration = Read-BoundedJson $migrationJournal 16777216 'ROLLBACK_MIGRATION_JOURNAL_INVALID'
  $migrationStateRecoverable = $migration.result -in @('INTENT','FAILED_MAINTENANCE_REQUIRED','APPLIED_PENDING_BOUNDARY','APPLIED')
  $failedMigrationBound = $migration.result -cne 'FAILED_MAINTENANCE_REQUIRED' -or ($migration.rollbackRequiresApprovedRestore -and $migration.failureCode -match '^[A-Z0-9_]{3,160}$')
  $commonMigrationProof=(-not $migrationStateRecoverable -or -not $failedMigrationBound -or $migration.version -ne 2 -or $migration.projectRef -cne $ConfirmProjectRef -or $migration.host -cne $ConfirmDatabaseHost -or $migration.databaseName -cne $ConfirmDatabaseName -or $migration.databaseSchema -cne $ConfirmDatabaseSchema -or $migration.previousMigrationDigest -cne $previousMigrationDigest -or $migration.targetMigrationDigest -notmatch '^[0-9a-f]{64}$' -or $migration.prechangeBackupEvidenceSha256 -cne (Hash $backupEvidence 16777216) -or -not $migration.maintenanceMustRemainEnabled)
  if($commonMigrationProof){throw 'ROLLBACK_MIGRATION_JOURNAL_REJECTED'}
}
if($PreviousReleaseKind-eq'LEGACY_BASELINE'){
  if($baseline.version-ne3-or$baseline.proofType-cne'legacy-running-baseline'-or$baseline.migrationDigest-notmatch'^[0-9a-f]{64}$'-or$migration.quiescenceProofType-cne'SIGNED_LEGACY_QUIESCE_V2'-or$migration.legacyQuiesceEvidenceSha256-cne$ExpectedLegacyQuiesceEvidenceSha256.ToLowerInvariant()){throw 'ROLLBACK_BASELINE_OR_JOURNAL_REJECTED'}
  $quiesceIdentity=Assert-LegacyQuiesceState $baseline $migration (Hash $baselinePath 16777216)
}else{
  if($RecoveryPurpose-eq'MIGRATION_ROLLBACK'-and($migration.previousReleaseId-cne$config.release.id-or$migration.quiescenceProofType-cne'SIGNED_EDGE_DRAIN_V2'-or$migration.drainEvidenceSha256-cne$ExpectedDrainStateSha256.ToLowerInvariant()-or$migration.legacyQuiesceEvidenceSha256)){throw 'ROLLBACK_LOCAL_RELEASE_JOURNAL_REJECTED'}
  $quiesceIdentity=[pscustomobject]@{EvidenceSha256=$null;PublicKeySha256=$null;CompletedAt=$null;ProcessIdentityDigest=$null;RestartCanonicalDigest=$null;WebProcessId=0;ApiProcessId=0;SigningKeyId=$null}
}
[void](Invoke-Bounded $node @($verifier,$backupPublic,$backupEvidence,'backup-latest') @{} 'ROLLBACK_BACKUP_SIGNATURE_VERIFY')
$receipt = Read-BoundedJson $backupEvidence 16777216 'ROLLBACK_BACKUP_EVIDENCE_INVALID'
if ($receipt.attestationType -cne 'backup-latest' -or $receipt.result -cne 'COMPLETE' -or $receipt.backupMode -cne $PreviousReleaseKind -or $receipt.databaseProjectRef -cne $ConfirmProjectRef -or $receipt.databaseHost -cne $ConfirmDatabaseHost -or $receipt.databaseName -cne $ConfirmDatabaseName -or $receipt.databaseSchema -cne $ConfirmDatabaseSchema) { throw 'ROLLBACK_BACKUP_CHAIN_REJECTED' }
if($PreviousReleaseKind-eq'LEGACY_BASELINE'){
  if($receipt.legacyBaselineSha256-cne(Hash $baselinePath 16777216)-or$receipt.migrationDigest-cne$baseline.migrationDigest){throw 'ROLLBACK_LEGACY_BACKUP_CHAIN_REJECTED'}
}elseif($receipt.releaseId-cne$config.release.id-or$receipt.migrationDigest-cne$releaseManifest.migrationDigest-or$receipt.appliedMigrationDigest-cne$releaseManifest.appliedMigrationDigest-or$receipt.legacyBaselineSha256-or$receipt.legacyStorageStageEvidenceSha256-or$receipt.storageReferenceConversionSha256){throw 'ROLLBACK_LOCAL_BACKUP_CHAIN_REJECTED'}
$manifestPath = Existing (Join-Path $backupRoot 'backup-manifest.json') $false 'ROLLBACK_MANIFEST_NOT_FOUND'
$dumpPath = Existing (Join-Path $backupRoot 'database.dump') $false 'ROLLBACK_DUMP_NOT_FOUND'
if ((Hash $manifestPath 16777216) -cne $receipt.manifestSha256) { throw 'ROLLBACK_MANIFEST_HASH_MISMATCH' }
$manifest = Read-BoundedJson $manifestPath 16777216 'ROLLBACK_MANIFEST_INVALID'
if ($manifest.version -ne 6 -or $manifest.backupMode-cne$PreviousReleaseKind-or $manifest.backupId -cne $receipt.backupId -or $manifest.databaseDumpBytes -gt $MaximumDatabaseDumpBytes -or (Get-Item -LiteralPath $dumpPath).Length -ne $manifest.databaseDumpBytes -or (Hash $dumpPath $MaximumDatabaseDumpBytes 'ROLLBACK_DUMP_HASH_REJECTED') -cne $manifest.databaseDumpSha256 -or (Hash $integrityKey 1024) -cne $manifest.integrityKeyId -or (Hmac $integrityKey (SignatureInput $manifest)) -cne $manifest.integritySignature) { throw 'ROLLBACK_BACKUP_INTEGRITY_REJECTED' }
if($PreviousReleaseKind-eq'LOCAL_RELEASE'-and($manifest.releaseId-cne$config.release.id-or$manifest.migrationDigest-cne$releaseManifest.migrationDigest-or$manifest.appliedMigrationDigest-cne$releaseManifest.appliedMigrationDigest)){throw 'ROLLBACK_LOCAL_BACKUP_MANIFEST_REJECTED'}
if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){
  [void](Invoke-Bounded $node @($verifier,$rehearsalPublic,$restoreRehearsal,'restore-verification') @{} 'ROLLBACK_REHEARSAL_SIGNATURE_VERIFY')
  $rehearsal=Read-BoundedJson $restoreRehearsal 16777216 'ROLLBACK_REHEARSAL_INVALID'
  try{$backupCompleted=[datetimeoffset]::Parse([string]$receipt.completedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);$rehearsalCompleted=[datetimeoffset]::Parse([string]$rehearsal.completedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)}catch{throw 'ROLLBACK_DAILY_RECOVERY_TIME_INVALID'}
  $now=[datetimeoffset]::UtcNow
  if($backupCompleted-lt$now.AddHours(-24)-or$backupCompleted-gt$now.AddMinutes(5)-or$rehearsalCompleted-lt$backupCompleted-or$rehearsalCompleted-gt$now.AddMinutes(5)-or$rehearsal.attestationType-cne'restore-verification'-or$rehearsal.version-ne6-or$rehearsal.result-cne'PASS'-or$rehearsal.backupId-cne$manifest.backupId-or$rehearsal.backupManifestSha256-cne(Hash $manifestPath 16777216)-or$rehearsal.releaseId-cne$config.release.id-or$rehearsal.backupMode-cne'LOCAL_RELEASE'-or$rehearsal.sourceDatabaseProjectRef-cne$ConfirmProjectRef-or-not$rehearsal.isolatedRestoreTarget-or$rehearsal.productionDatabaseMutated-or-not$rehearsal.databaseRestored-or-not$rehearsal.storageHashVerified-or-not$rehearsal.storageReferenceVerified-or-not$rehearsal.businessKpiVerified-or-not$rehearsal.businessMutationVerified-or$rehearsal.rpoHours-ne24-or$rehearsal.rtoHours-ne4-or[double]$rehearsal.elapsedSeconds-gt14400-or$rehearsal.migrationDigest-cne$manifest.migrationDigest-or$rehearsal.appliedMigrationDigest-cne$manifest.appliedMigrationDigest-or$rehearsal.businessKpiDigest-cne$manifest.businessKpiDigest-or$rehearsal.storageReferenceDigest-cne$manifest.storageReferenceDigest){throw 'ROLLBACK_DAILY_RECOVERY_REHEARSAL_REJECTED'}
}
$fs = Read-BoundedJson $fsPath 16777216 'ROLLBACK_FILESYSTEM_EVIDENCE_INVALID';$sharedRuntimeItems=@($node,$verifier,$processTreeHelper,$recoverySecurityHelper,$psql,$pgRestore,$EdgeReleaseRoot);if($PreviousReleaseKind-eq'LEGACY_BASELINE'){$sharedRuntimeItems+=$quiescePublic};if($EdgeStateMode-eq'ACTIVE_LOCAL_EDGE'){$sharedRuntimeItems+=@($edgeDrainHelper,$EdgeSigningPublicKeyPath)}
$legacyAclInvalid=$PreviousReleaseKind-eq'LEGACY_BASELINE'-and-not(Under $quiescePath $fs.classRoots.ADMIN_EVIDENCE)
if ($fs.result -ne 'PASS' -or -not $fs.exactAcl -or @($sharedRuntimeItems | Where-Object { -not(Under $_ $fs.classRoots.SHARED_RUNTIME) }).Count -or $legacyAclInvalid -or -not(Under $pgpass $fs.classRoots.ADMIN_ONLY) -or -not(Under $integrityKey $fs.classRoots.BACKUP_ONLY) -or -not(Under $EvidenceOutputPath $fs.classRoots.ADMIN_EVIDENCE) -or -not(Under $RollbackJournalPath $fs.classRoots.ADMIN_EVIDENCE)) { throw 'ROLLBACK_FILESYSTEM_BOUNDARY_REJECTED' }
if ([IO.Path]::GetFullPath($RollbackJournalPath) -ieq [IO.Path]::GetFullPath($EvidenceOutputPath) -or ($RecoveryPurpose-eq'MIGRATION_ROLLBACK'-and[IO.Path]::GetFullPath($RollbackJournalPath) -ieq [IO.Path]::GetFullPath($MigrationJournalPath))) { throw 'ROLLBACK_JOURNAL_PATH_COLLISION' }
$recoveryWorkspaceRoot=$null;$liveStorageRoot=$null;$stagingStorageRoot=$null;$preservedStorageRoot=$null;$backupPayloadRoot=$null
if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){
  $recoveryWorkspaceRoot=[IO.Path]::GetFullPath([string]$approvalPlan.exactParameters.recoveryWorkspaceRoot);$liveStorageRoot=[IO.Path]::GetFullPath([string]$approvalPlan.exactParameters.liveStorageRoot);$stagingStorageRoot=[IO.Path]::GetFullPath([string]$approvalPlan.exactParameters.stagingStorageRoot);$preservedStorageRoot=[IO.Path]::GetFullPath([string]$approvalPlan.exactParameters.preservedStorageRoot);$backupPayloadRoot=Existing (Join-Path $backupRoot 'storage-payload') $true 'ROLLBACK_STORAGE_PAYLOAD_NOT_FOUND';Assert-DailyStoragePaths $liveStorageRoot $stagingStorageRoot $preservedStorageRoot $recoveryWorkspaceRoot
  if(-not(Under $liveStorageRoot $fs.classRoots.CORE_MODIFY)-or-not(Under $recoveryWorkspaceRoot $fs.classRoots.ADMIN_ONLY)-or-not(Under $stagingStorageRoot $fs.classRoots.ADMIN_ONLY)-or-not(Under $preservedStorageRoot $fs.classRoots.ADMIN_ONLY)){throw 'ROLLBACK_DAILY_STORAGE_ACL_BOUNDARY_REJECTED'}
  Assert-LocalRecoveryExactAcl $liveStorageRoot 'CORE_MODIFY' $fs|Out-Null;Assert-LocalRecoveryExactAcl $recoveryWorkspaceRoot 'ADMIN_ONLY' $fs|Out-Null
  if(Test-Path -LiteralPath $stagingStorageRoot -PathType Container){Assert-LocalRecoveryExactAcl $stagingStorageRoot 'ADMIN_ONLY' $fs|Out-Null};if(Test-Path -LiteralPath $preservedStorageRoot -PathType Container){Assert-LocalRecoveryExactAcl $preservedStorageRoot 'ADMIN_ONLY' $fs|Out-Null}
}

$connectionUser = if ($db.connectionMode -eq 'session_pooler') { "$($db.migrationUser).$($db.projectRef)" } else { [string]$db.migrationUser }
$environment = @{PGPASSFILE=$pgpass;PGSSLMODE='verify-full';PGSSLROOTCERT=$ca;PGCONNECT_TIMEOUT='15';PGOPTIONS='-c lock_timeout=30000 -c statement_timeout=3600000 -c idle_in_transaction_session_timeout=60000';PGAPPNAME='meta-ads-release-rollback'}
$base = @("--host=$($db.host)",'--port=5432',"--username=$connectionUser","--dbname=$($db.name)",'--no-password')
$quotedSchema = Quote-Identifier $ConfirmDatabaseSchema
$preservedSchema = [string]$approvalPlan.exactParameters.preservedSchema
$quotedPreserved = Quote-Identifier $preservedSchema
$quotedRuntimeUser = Quote-Identifier $db.runtimeUser
$privilegeSql = @"
WITH app_tables AS (
  SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS relation_name,c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='$ConfirmDatabaseSchema' AND c.relkind IN ('r','p')
), app_sequences AS (
  SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='$ConfirmDatabaseSchema' AND c.relkind='S'
), app_functions AS (
  SELECT p.oid,p.proowner,p.proacl,p.prosecdef,p.proleakproof FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='$ConfirmDatabaseSchema'
), migration_defaults AS (
  SELECT d.defaclrole,d.defaclobjtype,x.grantee,x.privilege_type
  FROM pg_default_acl d
  CROSS JOIN LATERAL aclexplode(COALESCE(d.defaclacl,'{}'::aclitem[])) x
  WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='$($db.migrationUser)')
    AND d.defaclnamespace=(SELECT oid FROM pg_namespace WHERE nspname='$ConfirmDatabaseSchema')
)
SELECT concat_ws('|',
  NOT has_database_privilege('$($db.runtimeUser)',current_database(),'CREATE') AND NOT has_database_privilege('$($db.runtimeUser)',current_database(),'TEMPORARY'),
  has_schema_privilege('$($db.runtimeUser)','$ConfirmDatabaseSchema','USAGE') AND NOT has_schema_privilege('$($db.runtimeUser)','$ConfirmDatabaseSchema','CREATE'),
  NOT EXISTS(SELECT 1 FROM app_tables WHERE relname<>'_prisma_migrations' AND NOT (has_table_privilege('$($db.runtimeUser)',relation_name,'SELECT') AND has_table_privilege('$($db.runtimeUser)',relation_name,'INSERT') AND has_table_privilege('$($db.runtimeUser)',relation_name,'UPDATE') AND has_table_privilege('$($db.runtimeUser)',relation_name,'DELETE'))),
  NOT EXISTS(SELECT 1 FROM app_tables WHERE has_table_privilege('$($db.runtimeUser)',relation_name,'TRUNCATE') OR has_table_privilege('$($db.runtimeUser)',relation_name,'REFERENCES') OR has_table_privilege('$($db.runtimeUser)',relation_name,'TRIGGER')),
  NOT EXISTS(SELECT 1 FROM app_tables WHERE relname='_prisma_migrations' AND (has_table_privilege('$($db.runtimeUser)',relation_name,'SELECT') OR has_table_privilege('$($db.runtimeUser)',relation_name,'INSERT') OR has_table_privilege('$($db.runtimeUser)',relation_name,'UPDATE') OR has_table_privilege('$($db.runtimeUser)',relation_name,'DELETE') OR has_table_privilege('$($db.runtimeUser)',relation_name,'TRUNCATE') OR has_table_privilege('$($db.runtimeUser)',relation_name,'REFERENCES') OR has_table_privilege('$($db.runtimeUser)',relation_name,'TRIGGER'))),
  NOT EXISTS(SELECT 1 FROM app_sequences WHERE NOT has_sequence_privilege('$($db.runtimeUser)',oid,'USAGE') OR NOT has_sequence_privilege('$($db.runtimeUser)',oid,'SELECT') OR has_sequence_privilege('$($db.runtimeUser)',oid,'UPDATE')),
  NOT EXISTS(SELECT 1 FROM app_functions f WHERE prosecdef OR proleakproof OR has_function_privilege('$($db.runtimeUser)',oid,'EXECUTE') OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) x WHERE x.grantee=0 AND x.privilege_type='EXECUTE')),
  NOT EXISTS(SELECT 1 FROM migration_defaults d LEFT JOIN pg_roles r ON r.oid=d.grantee WHERE d.grantee=0 OR (d.grantee<>d.defaclrole AND (r.rolname IS NULL OR (d.defaclobjtype='r' AND NOT (r.rolname='$($db.runtimeUser)' AND d.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))) OR (d.defaclobjtype='S' AND NOT (r.rolname='$($db.runtimeUser)' AND d.privilege_type IN ('USAGE','SELECT'))) OR d.defaclobjtype NOT IN ('r','S','f') OR d.defaclobjtype='f')))
)
"@
$schemaStateSql = "SELECT (to_regnamespace('$ConfirmDatabaseSchema') IS NOT NULL)::int || '|' || (to_regnamespace('$preservedSchema') IS NOT NULL)::int"

if($Action-eq'Recover'){
  $recoveryJournal=Existing $RollbackJournalPath $false 'ROLLBACK_DURABLE_JOURNAL_NOT_FOUND';AssertHash $recoveryJournal $ExpectedRollbackJournalSha256 'ROLLBACK_DURABLE_JOURNAL_HASH_MISMATCH' 1048576
  $recoverySource=Read-BoundedJson $recoveryJournal 1048576 'ROLLBACK_DURABLE_JOURNAL_INVALID';$recoverySourceHash=Hash $recoveryJournal 1048576
  $sourcePurpose=if([string]$recoverySource.recoveryPurpose){[string]$recoverySource.recoveryPurpose}else{'MIGRATION_ROLLBACK'}
  if($recoverySource.version -ne 4 -or $sourcePurpose-cne$RecoveryPurpose-or $recoverySource.previousReleaseKind-cne$PreviousReleaseKind-or $recoverySource.state -notin @('INTENT','STORAGE_STAGED_RESTORE_PENDING','PRESERVED_ORIGINAL_RESTORE_IN_PROGRESS','DATABASE_RESTORED_STORAGE_SWITCH_PENDING','STORAGE_SWITCHED_MAINTENANCE_REQUIRED','COMPLETE_MAINTENANCE_REQUIRED','RECOVERY_INTENT','FAILED_MAINTENANCE_REQUIRED') -or [string]$recoverySource.preservedSchema -cne $preservedSchema -or($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'-and([IO.Path]::GetFullPath([string]$recoverySource.recoveryWorkspaceRoot)-ine$recoveryWorkspaceRoot))-or -not $recoverySource.maintenanceMustRemainEnabled -or -not $recoverySource.legacyWritersMustRemainQuiesced){throw 'ROLLBACK_RECOVERY_SOURCE_REJECTED'}
  $recoveryEdge=Get-CurrentEdgeIdentity;if($recoveryEdge.identityDigest-cne$approvalPlan.exactParameters.edgeIdentityDigest){throw 'ROLLBACK_RECOVERY_EDGE_IDENTITY_DRIFT'}
  AssertHash $maintenancePath $ExpectedMaintenanceFlagSha256 'ROLLBACK_RECOVERY_MAINTENANCE_HASH_DRIFT' 1048576
  $schemaState=Invoke-Bounded $psql ($base+@('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$schemaStateSql")) $environment 'ROLLBACK_RECOVERY_SCHEMA_STATE'
  if($schemaState-notin@('1|0','0|1','1|1')){throw 'ROLLBACK_RECOVERY_SCHEMA_STATE_REJECTED'}
  $recoveryIntent=[ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='RECOVERY_INTENT';sourceJournalSha256=$recoverySourceHash;sourceState=[string]$recoverySource.state;recoveryPlanSha256=$approvalPlan.planSha256;databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;observedSchemaState=$schemaState;recoveryWorkspaceRoot=$recoveryWorkspaceRoot;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=[string]$recoverySource.originalStorageInventoryDigest;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;edgeStateMode=$EdgeStateMode;quiescenceProofType=$edgeIdentity.proofType;edgeIdentityDigest=$edgeIdentity.identityDigest;legacyQuiesceEvidenceSha256=$quiesceIdentity.EvidenceSha256;createdAt=[datetimeoffset]::UtcNow.ToString('o')}
  Write-AtomicJson $RollbackJournalPath $recoveryIntent
  try{
    Assert-ActionTimeRecoveryBoundary $approvalPlan.exactParameters.edgeIdentityDigest
    if($schemaState-in@('0|1','1|1')){
      $recoverSql="BEGIN; DROP SCHEMA IF EXISTS $quotedSchema CASCADE; ALTER SCHEMA $quotedPreserved RENAME TO $quotedSchema; COMMIT;"
      [void](Invoke-Bounded $psql ($base+@('--set=ON_ERROR_STOP=1',"--command=$recoverSql")) $environment 'ROLLBACK_RECOVERY_RETURN_ORIGINAL')
    }
    $recoveredState=Invoke-Bounded $psql ($base+@('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$schemaStateSql")) $environment 'ROLLBACK_RECOVERY_STATE_VERIFY'
    if($recoveredState-cne'1|0'){throw 'ROLLBACK_RECOVERY_POST_STATE_REJECTED'}
    $storageOriginalRestored=$true;if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){Assert-ActionTimeRecoveryBoundary $approvalPlan.exactParameters.edgeIdentityDigest;$storageOriginalRestored=Restore-OriginalStorage $liveStorageRoot $stagingStorageRoot $preservedStorageRoot $recoveryWorkspaceRoot ([string]$recoverySource.originalStorageInventoryDigest) $fs}
    Write-AtomicJson $RollbackJournalPath ([ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='RECOVERED_ORIGINAL_MAINTENANCE_REQUIRED';sourceJournalSha256=$recoverySourceHash;sourceState=[string]$recoverySource.state;recoveryPlanSha256=$approvalPlan.planSha256;databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;observedSchemaState=$recoveredState;originalSchemaRestored=$true;preservedSchemaAbsent=$true;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=[string]$recoverySource.originalStorageInventoryDigest;originalStorageRestored=$storageOriginalRestored;preservedStorageAbsent=$(if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){-not(Test-Path -LiteralPath $preservedStorageRoot)}else{$true});partialTargetPossible=$false;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;edgeStateMode=$EdgeStateMode;quiescenceProofType=$edgeIdentity.proofType;edgeIdentityDigest=$edgeIdentity.identityDigest;legacyQuiesceEvidenceSha256=$quiesceIdentity.EvidenceSha256;completedAt=[datetimeoffset]::UtcNow.ToString('o')})
    [pscustomobject]@{Result='RECOVERED_ORIGINAL_MAINTENANCE_REQUIRED';CurrentSchemaPresent=$true;PreservedSchemaAbsent=$true;OriginalStorageRestored=$storageOriginalRestored;MaintenanceRetained=$true;WritersRemainQuiesced=$true;VerifyRecoveryRequired=$true;NewRollbackApprovalRequired=$true}|ConvertTo-Json;exit 0
  }catch{
    $failureCode=if($_.Exception.Message-match'^[A-Z0-9_]{3,160}$'){$_.Exception.Message}else{'ROLLBACK_RECOVERY_UNCLASSIFIED_FAILURE'}
    try{$observed=Invoke-Bounded $psql ($base+@('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$schemaStateSql")) $environment 'ROLLBACK_RECOVERY_FAILURE_STATE'}catch{$observed='UNKNOWN'}
    if($observed-ceq'1|0'){
      $storageOriginalRestored=$true
      if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){
        try{Assert-ActionTimeRecoveryBoundary $approvalPlan.exactParameters.edgeIdentityDigest;$storageOriginalRestored=Restore-OriginalStorage $liveStorageRoot $stagingStorageRoot $preservedStorageRoot $recoveryWorkspaceRoot ([string]$recoverySource.originalStorageInventoryDigest) $fs}catch{$storageOriginalRestored=$false}
      }
      if(-not$storageOriginalRestored){
        Write-AtomicJson $RollbackJournalPath ([ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='FAILED_MAINTENANCE_REQUIRED';sourceJournalSha256=$recoverySourceHash;sourceState=[string]$recoverySource.state;recoveryPlanSha256=$approvalPlan.planSha256;failureCode=$failureCode;databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;observedSchemaState=$observed;originalSchemaRestored=$true;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=[string]$recoverySource.originalStorageInventoryDigest;originalStorageRestored=$false;partialTargetPossible=$true;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;recoveryProcedure='KEEP MAINTENANCE AND WRITERS QUIESCED. HASH-PIN THIS JOURNAL AND CREATE A NEW EXACT RECOVER PLAN.';failedAt=[datetimeoffset]::UtcNow.ToString('o')})
        throw 'ROLLBACK_RECOVERY_FAILED_MAINTENANCE_REQUIRED'
      }
      Write-AtomicJson $RollbackJournalPath ([ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='RECOVERED_ORIGINAL_MAINTENANCE_REQUIRED';sourceJournalSha256=$recoverySourceHash;sourceState=[string]$recoverySource.state;recoveryPlanSha256=$approvalPlan.planSha256;databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;observedSchemaState=$observed;originalSchemaRestored=$true;preservedSchemaAbsent=$true;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=[string]$recoverySource.originalStorageInventoryDigest;originalStorageRestored=$storageOriginalRestored;preservedStorageAbsent=$(if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){-not(Test-Path -LiteralPath $preservedStorageRoot)}else{$true});partialTargetPossible=$false;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;reconciledAfterFailure=$true;completedAt=[datetimeoffset]::UtcNow.ToString('o')})
      [pscustomobject]@{Result='RECOVERED_ORIGINAL_MAINTENANCE_REQUIRED';CrashStateReconciled=$true;VerifyRecoveryRequired=$true;MaintenanceRetained=$true}|ConvertTo-Json;exit 0
    }
    Write-AtomicJson $RollbackJournalPath ([ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='FAILED_MAINTENANCE_REQUIRED';sourceJournalSha256=$recoverySourceHash;sourceState=[string]$recoverySource.state;recoveryPlanSha256=$approvalPlan.planSha256;failureCode=$failureCode;databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;observedSchemaState=$observed;originalSchemaRestored=$false;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=[string]$recoverySource.originalStorageInventoryDigest;originalStorageRestored=$false;partialTargetPossible=$true;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;recoveryProcedure='KEEP MAINTENANCE AND WRITERS QUIESCED. HASH-PIN THIS JOURNAL AND CREATE A NEW EXACT RECOVER PLAN.';failedAt=[datetimeoffset]::UtcNow.ToString('o')})
    throw 'ROLLBACK_RECOVERY_FAILED_MAINTENANCE_REQUIRED'
  }
}

if($Action-eq'VerifyRecovery'){
  $recoveryJournal=Existing $RollbackJournalPath $false 'ROLLBACK_DURABLE_JOURNAL_NOT_FOUND';AssertHash $recoveryJournal $ExpectedRollbackJournalSha256 'ROLLBACK_DURABLE_JOURNAL_HASH_MISMATCH' 1048576;$recoveryRecord=Read-BoundedJson $recoveryJournal 1048576 'ROLLBACK_DURABLE_JOURNAL_INVALID'
  $schemaState=Invoke-Bounded $psql ($base+@('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$schemaStateSql")) $environment 'ROLLBACK_VERIFY_RECOVERY_STATE'
  $recordPurpose=if([string]$recoveryRecord.recoveryPurpose){[string]$recoveryRecord.recoveryPurpose}else{'MIGRATION_ROLLBACK'};$storageRecoveryVerified=$true;if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){$storageRecoveryVerified=$recoveryRecord.originalStorageRestored-and$recoveryRecord.preservedStorageAbsent-and-not(Test-Path -LiteralPath $preservedStorageRoot)-and(InventoryDigest $liveStorageRoot)-ceq[string]$recoveryRecord.originalStorageInventoryDigest}
  if($recoveryRecord.version-ne4-or$recordPurpose-cne$RecoveryPurpose-or$recoveryRecord.previousReleaseKind-cne$PreviousReleaseKind-or$recoveryRecord.state-cne'RECOVERED_ORIGINAL_MAINTENANCE_REQUIRED'-or$recoveryRecord.databaseProjectRef-cne$ConfirmProjectRef-or$recoveryRecord.databaseHost-cne$ConfirmDatabaseHost-or$recoveryRecord.databaseName-cne$ConfirmDatabaseName-or$recoveryRecord.databaseSchema-cne$ConfirmDatabaseSchema-or$recoveryRecord.preservedSchema-cne$preservedSchema-or-not$recoveryRecord.originalSchemaRestored-or-not$recoveryRecord.preservedSchemaAbsent-or-not$storageRecoveryVerified-or$recoveryRecord.partialTargetPossible-or-not$recoveryRecord.maintenanceMustRemainEnabled-or-not$recoveryRecord.legacyWritersMustRemainQuiesced-or$schemaState-cne'1|0'){throw 'ROLLBACK_RECOVERY_EVIDENCE_REJECTED'}
  [pscustomobject]@{Result='PASS';RecoveryVerified=$true;CurrentSchemaPresent=$true;PreservedSchemaAbsent=$true;OriginalStorageRestored=$storageRecoveryVerified;MaintenanceRetained=$true;WritersRemainQuiesced=$true;NewRollbackApprovalRequired=$true}|ConvertTo-Json;exit 0
}

if ($Action -eq 'Apply') {
  if (Test-Path -LiteralPath $RollbackJournalPath) { throw 'ROLLBACK_JOURNAL_ALREADY_EXISTS' }
  if (Test-Path -LiteralPath $EvidenceOutputPath) { throw 'ROLLBACK_EVIDENCE_ALREADY_EXISTS' }
  $signer = Existing $AttestationSignerPath $false 'ROLLBACK_SIGNER_NOT_FOUND'
  $private = Existing $RestoreReceiptPrivateKeyPath $false 'ROLLBACK_PRIVATE_KEY_NOT_FOUND'
  AssertHash $signer $ExpectedAttestationSignerSha256 'ROLLBACK_SIGNER_HASH_MISMATCH' 16777216
  AssertHash $private $ExpectedRestoreReceiptPrivateKeySha256 'ROLLBACK_PRIVATE_KEY_HASH_MISMATCH' 1048576
  if (-not(Under $signer $fs.classRoots.SHARED_RUNTIME) -or -not(Under $private $fs.classRoots.ADMIN_ONLY)) { throw 'ROLLBACK_SIGNER_BOUNDARY_REJECTED' }
  $schemaState = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$schemaStateSql")) $environment 'ROLLBACK_SCHEMA_PREFLIGHT'
  if ($schemaState -cne '1|0') { throw 'ROLLBACK_SCHEMA_PREFLIGHT_REJECTED' }
  if($PreviousReleaseKind-eq'LEGACY_BASELINE'){$quiesceIdentity=Assert-LegacyQuiesceState $baseline $migration (Hash $baselinePath 16777216)}
  $originalStorageDigest=$null;$backupStorageDigest=$null;$stagedStorageDigest=$null
  if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){
    [void](Existing $liveStorageRoot $true 'ROLLBACK_LIVE_STORAGE_NOT_FOUND');if((Test-Path -LiteralPath $stagingStorageRoot)-or(Test-Path -LiteralPath $preservedStorageRoot)){throw 'ROLLBACK_DAILY_STORAGE_OUTPUT_ALREADY_EXISTS'}
    $originalStorageDigest=InventoryDigest $liveStorageRoot;$backupStorageDigest=InventoryDigest $backupPayloadRoot
  }
  $freshEdgeIdentity=Get-CurrentEdgeIdentity
  if($freshEdgeIdentity.identityDigest-cne$approvalPlan.exactParameters.edgeIdentityDigest){throw 'ROLLBACK_PREMUTATION_EDGE_IDENTITY_DRIFT'}
  $edgeIdentity=$freshEdgeIdentity

  $intent = [ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='INTENT';maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;planSha256=$approvalPlan.planSha256;approvalInstanceId=$approvalPlan.approvalInstanceId;recoveryProcessTreeHelperPath=$processTreeHelper;recoveryProcessTreeHelperSha256=$ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant();databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;migrationRecoverySourceState=$(if($migration){[string]$migration.result}else{$null});migrationJournalSha256=$(if($migrationJournal){Hash $migrationJournal 16777216}else{$null});restoreRehearsalEvidenceSha256=$(if($restoreRehearsal){Hash $restoreRehearsal 16777216}else{$null});edgeStateMode=$EdgeStateMode;quiescenceProofType=$edgeIdentity.proofType;edgeIdentityDigest=$edgeIdentity.identityDigest;edgeProcessId=$edgeIdentity.processId;edgeProcessStartedAt=$edgeIdentity.processStartedAt;edgeExecutableSha256=$edgeIdentity.executableSha256;edgeReleaseId=$edgeIdentity.releaseId;edgeReleaseManifestSha256=$edgeIdentity.releaseManifestSha256;edgeListenerAddress=$edgeIdentity.listenerAddress;edgeListenerPort=$edgeIdentity.listenerPort;drainStateSha256=$edgeIdentity.drainStateSha256;drainCompletedAt=$edgeIdentity.drainCompletedAt;activeRequests=0;legacyQuiesceEvidenceSha256=$quiesceIdentity.EvidenceSha256;quiescePublicKeySha256=$quiesceIdentity.PublicKeySha256;quiesceSigningKeyId=$quiesceIdentity.SigningKeyId;quiesceCompletedAt=$quiesceIdentity.CompletedAt;legacyProcessIdentityDigest=$quiesceIdentity.ProcessIdentityDigest;legacyRestartCanonicalDigest=$quiesceIdentity.RestartCanonicalDigest;legacyWebProcessId=$quiesceIdentity.WebProcessId;legacyApiProcessId=$quiesceIdentity.ApiProcessId;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=$originalStorageDigest;backupStorageInventoryDigest=$backupStorageDigest;stagedStorageInventoryDigest=$stagedStorageDigest;backupEvidenceSha256=(Hash $backupEvidence 16777216);backupManifestSha256=(Hash $manifestPath 16777216);createdAt=[datetimeoffset]::UtcNow.ToString('o')}
  if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){$intent.recoveryWorkspaceRoot=$recoveryWorkspaceRoot;$intent.localRecoverySecurityHelperPath=$recoverySecurityHelper;$intent.localRecoverySecurityHelperSha256=$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()}
  $intentSha256 = TextHash ($intent | ConvertTo-Json -Depth 32 -Compress)
  Write-AtomicJson $RollbackJournalPath $intent -CreateOnly
  $boundaryCreated = $false
  $boundaryMutationAttempted = $false
  $evidencePublished = $false
  try {
    if ((Hash $RollbackJournalPath 1048576) -cne $intentSha256) { throw 'ROLLBACK_INTENT_DURABILITY_VERIFY_FAILED' }
    if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){
      Assert-ActionTimeRecoveryBoundary $approvalPlan.exactParameters.edgeIdentityDigest
      $stagedStorageDigest=Copy-VerifiedStoragePayload $backupPayloadRoot $stagingStorageRoot $fs
      if($stagedStorageDigest-cne$backupStorageDigest){throw 'ROLLBACK_DAILY_STORAGE_STAGE_REJECTED'}
      Write-AtomicJson $RollbackJournalPath ([ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='STORAGE_STAGED_RESTORE_PENDING';intentSha256=$intentSha256;edgeStateMode=$EdgeStateMode;quiescenceProofType=$edgeIdentity.proofType;edgeIdentityDigest=$edgeIdentity.identityDigest;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=$originalStorageDigest;backupStorageInventoryDigest=$backupStorageDigest;stagedStorageInventoryDigest=$stagedStorageDigest;updatedAt=[datetimeoffset]::UtcNow.ToString('o')})
    }
    Assert-ActionTimeRecoveryBoundary $approvalPlan.exactParameters.edgeIdentityDigest
    $boundarySql = "BEGIN; ALTER SCHEMA $quotedSchema RENAME TO $quotedPreserved; COMMIT;"
    $boundaryMutationAttempted = $true
    [void](Invoke-Bounded $psql ($base + @('--set=ON_ERROR_STOP=1',"--command=$boundarySql")) $environment 'ROLLBACK_PRESERVE_SCHEMA_BOUNDARY')
    $schemaState = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$schemaStateSql")) $environment 'ROLLBACK_PRESERVE_SCHEMA_STATE_VERIFY'
    if ($schemaState -cne '0|1') { throw 'ROLLBACK_PRESERVE_SCHEMA_STATE_REJECTED' }
    $boundaryCreated = $true
    Write-AtomicJson $RollbackJournalPath ([ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='PRESERVED_ORIGINAL_RESTORE_IN_PROGRESS';intentSha256=$intentSha256;edgeStateMode=$EdgeStateMode;quiescenceProofType=$edgeIdentity.proofType;edgeIdentityDigest=$edgeIdentity.identityDigest;recoveryProcessTreeHelperPath=$processTreeHelper;recoveryProcessTreeHelperSha256=$ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant();maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;legacyQuiesceEvidenceSha256=$quiesceIdentity.EvidenceSha256;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;originalSchemaPreserved=$true;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=$originalStorageDigest;backupStorageInventoryDigest=$backupStorageDigest;partialTargetPossible=$true;updatedAt=[datetimeoffset]::UtcNow.ToString('o')})
    [void](Invoke-Bounded $pgRestore @("--host=$($db.host)",'--port=5432',"--username=$connectionUser","--dbname=$($db.name)",'--no-password','--exit-on-error','--no-owner','--no-privileges',"--schema=$ConfirmDatabaseSchema",$dumpPath) $environment 'ROLLBACK_PG_RESTORE')
    $grantSql = "REVOKE CREATE, TEMPORARY ON DATABASE $(Quote-Identifier $db.name) FROM $quotedRuntimeUser; REVOKE TEMPORARY ON DATABASE $(Quote-Identifier $db.name) FROM PUBLIC; REVOKE CREATE ON SCHEMA $quotedSchema FROM $quotedRuntimeUser; GRANT USAGE ON SCHEMA $quotedSchema TO $quotedRuntimeUser; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA $quotedSchema TO $quotedRuntimeUser; REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA $quotedSchema FROM $quotedRuntimeUser; REVOKE ALL PRIVILEGES ON TABLE $quotedSchema.""_prisma_migrations"" FROM $quotedRuntimeUser; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA $quotedSchema TO $quotedRuntimeUser; REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA $quotedSchema FROM $quotedRuntimeUser; REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA $quotedSchema FROM $quotedRuntimeUser; REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA $quotedSchema FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE $(Quote-Identifier $db.migrationUser) IN SCHEMA $quotedSchema GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $quotedRuntimeUser; ALTER DEFAULT PRIVILEGES FOR ROLE $(Quote-Identifier $db.migrationUser) IN SCHEMA $quotedSchema GRANT USAGE, SELECT ON SEQUENCES TO $quotedRuntimeUser; ALTER DEFAULT PRIVILEGES FOR ROLE $(Quote-Identifier $db.migrationUser) IN SCHEMA $quotedSchema REVOKE UPDATE ON SEQUENCES FROM $quotedRuntimeUser; ALTER DEFAULT PRIVILEGES FOR ROLE $(Quote-Identifier $db.migrationUser) IN SCHEMA $quotedSchema REVOKE EXECUTE ON FUNCTIONS FROM $quotedRuntimeUser; ALTER DEFAULT PRIVILEGES FOR ROLE $(Quote-Identifier $db.migrationUser) IN SCHEMA $quotedSchema REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;"
    [void](Invoke-Bounded $psql ($base + @('--set=ON_ERROR_STOP=1',"--command=$grantSql")) $environment 'ROLLBACK_RUNTIME_ROLE_GRANTS')
    $privilegeProof = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$privilegeSql")) $environment 'ROLLBACK_RUNTIME_ROLE_VERIFY'
    if ($privilegeProof -cne 't|t|t|t|t|t|t|t') { throw 'ROLLBACK_RUNTIME_ROLE_PRIVILEGES_REJECTED' }
    $kpi = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=SET search_path TO $quotedSchema; $(KpiSql)")) $environment 'ROLLBACK_KPI_VERIFY'
    if ((TextHash $kpi) -cne $manifest.businessKpiDigest) { throw 'ROLLBACK_KPI_MISMATCH' }
    if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){
      Write-AtomicJson $RollbackJournalPath ([ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='DATABASE_RESTORED_STORAGE_SWITCH_PENDING';intentSha256=$intentSha256;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;originalSchemaPreserved=$true;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=$originalStorageDigest;backupStorageInventoryDigest=$backupStorageDigest;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;updatedAt=[datetimeoffset]::UtcNow.ToString('o')})
      Assert-ActionTimeRecoveryBoundary $approvalPlan.exactParameters.edgeIdentityDigest
      [IO.Directory]::Move($liveStorageRoot,$preservedStorageRoot);Set-LocalRecoveryExactAcl $preservedStorageRoot 'ADMIN_ONLY' $fs;Assert-LocalRecoveryExactAcl $preservedStorageRoot 'ADMIN_ONLY' $fs|Out-Null
      [IO.Directory]::Move($stagingStorageRoot,$liveStorageRoot);Set-LocalRecoveryExactAcl $liveStorageRoot 'CORE_MODIFY' $fs;Assert-LocalRecoveryExactAcl $liveStorageRoot 'CORE_MODIFY' $fs|Out-Null
      if((InventoryDigest $liveStorageRoot)-cne$backupStorageDigest-or(InventoryDigest $preservedStorageRoot)-cne$originalStorageDigest){throw 'ROLLBACK_DAILY_STORAGE_SWITCH_VERIFY_FAILED'}
      Write-AtomicJson $RollbackJournalPath ([ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='STORAGE_SWITCHED_MAINTENANCE_REQUIRED';intentSha256=$intentSha256;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;originalSchemaPreserved=$true;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=$originalStorageDigest;backupStorageInventoryDigest=$backupStorageDigest;productionStorageRestored=$true;preservedOriginalStorage=$true;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;updatedAt=[datetimeoffset]::UtcNow.ToString('o')})
    }
    $storageDigest = Get-RollbackStorageDigest
    Assert-RestoreDeadline
    $unsigned = "$EvidenceOutputPath.unsigned"
    $signed = "$EvidenceOutputPath.pending"
    try {
      $unsignedEvidence = [ordered]@{attestationType='database-rollback';version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;result='PASS';rollbackIntentSha256=$intentSha256;rollbackPlanSha256=$approvalPlan.planSha256;recoveryProcessTreeHelperPath=$processTreeHelper;recoveryProcessTreeHelperSha256=$ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant();baselineSha256=if($PreviousReleaseKind-eq'LEGACY_BASELINE'){(Hash $baselinePath 16777216)}else{$null};legacyQuiesceEvidenceSha256=$quiesceIdentity.EvidenceSha256;quiescePublicKeySha256=$quiesceIdentity.PublicKeySha256;quiesceSigningKeyId=$quiesceIdentity.SigningKeyId;quiesceCompletedAt=$quiesceIdentity.CompletedAt;legacyProcessIdentityDigest=$quiesceIdentity.ProcessIdentityDigest;legacyRestartCanonicalDigest=$quiesceIdentity.RestartCanonicalDigest;legacyWebProcessId=$quiesceIdentity.WebProcessId;legacyApiProcessId=$quiesceIdentity.ApiProcessId;migrationJournalSha256=$(if($migrationJournal){Hash $migrationJournal 16777216}else{$null});restoreRehearsalEvidenceSha256=$(if($restoreRehearsal){Hash $restoreRehearsal 16777216}else{$null});migrationDigest=$previousMigrationDigest;appliedMigrationDigest=$previousAppliedMigrationDigest;releaseId=if($PreviousReleaseKind-eq'LOCAL_RELEASE'){$config.release.id}else{$baseline.releaseId};releaseManifestSha256=if($PreviousReleaseKind-eq'LOCAL_RELEASE'){$ExpectedEdgeReleaseManifestSha256.ToLowerInvariant()}else{$null};backupEvidenceSha256=(Hash $backupEvidence 16777216);backupId=$manifest.backupId;backupManifestSha256=(Hash $manifestPath 16777216);databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preRollbackSchemaPreserved=$true;preservedSchema=$preservedSchema;productionDatabaseRestored=$true;runtimeRolePrivilegesVerified=$true;maintenanceVerified=$true;edgeStateMode=$EdgeStateMode;quiescenceProofType=$edgeIdentity.proofType;quiescenceVerified=$true;drainVerified=($EdgeStateMode-eq'ACTIVE_LOCAL_EDGE');legacyNoEdgeVerified=($EdgeStateMode-eq'LEGACY_QUIESCED_NO_EDGE');stoppedLocalEdgeVerified=($EdgeStateMode-eq'STOPPED_LOCAL_EDGE');drainStateSha256=$edgeIdentity.drainStateSha256;drainCompletedAt=$edgeIdentity.drainCompletedAt;edgeIdentityDigest=$edgeIdentity.identityDigest;edgeProcessId=$edgeIdentity.processId;edgeProcessStartedAt=$edgeIdentity.processStartedAt;edgeExecutableSha256=$edgeIdentity.executableSha256;edgeReleaseId=$edgeIdentity.releaseId;edgeReleaseManifestSha256=$edgeIdentity.releaseManifestSha256;edgeListenerAddress=$edgeIdentity.listenerAddress;edgeListenerPort=$edgeIdentity.listenerPort;activeRequestsAtMutation=0;legacyWritersQuiesced=$true;businessKpiVerified=$true;businessKpiDigest=$manifest.businessKpiDigest;storageHashVerified=$true;storageInventoryDigest=$storageDigest;productionStorageRestored=($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY');preservedOriginalStorage=($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY');liveStorageRoot=$liveStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=$originalStorageDigest;hardDeadlineEnforced=$true;processTreeKillOnDeadline=$true;allReadsAndHashesDeadlineBound=$true;elapsedSeconds=[int][Math]::Ceiling($script:RestoreWatch.Elapsed.TotalSeconds);maintenanceMustRemainEnabled=$true;recoveryProcedure=$(if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){'KEEP MAINTENANCE AND ALL WRITERS STOPPED. USE A NEW EXACT RECOVER APPROVAL TO RETURN BOTH ORIGINAL SCHEMA AND STORAGE BEFORE FINAL ACCEPTANCE.'}else{"KEEP MAINTENANCE AND ALL WRITERS QUIESCED. RETURN FORWARD ONLY WITH A NEW EXACT APPROVED TRANSACTIONAL DROP-CURRENT AND RENAME-PRESERVED PLAN. RETRY $PreviousReleaseKind RESTORE ONLY WITH A NEW EXACT APPROVED RESTORE. TRANSITION ONLY AFTER SIGNED VERIFY."});completedAt=[datetimeoffset]::UtcNow.ToString('o')}
      if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){$unsignedEvidence.recoveryWorkspaceRoot=$recoveryWorkspaceRoot;$unsignedEvidence.localRecoverySecurityHelperPath=$recoverySecurityHelper;$unsignedEvidence.localRecoverySecurityHelperSha256=$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant();$unsignedEvidence.coreServiceSid=$edgeIdentity.coreServiceSid;$unsignedEvidence.edgeServiceSid=$edgeIdentity.edgeServiceSid;$unsignedEvidence.serviceRightsExact=$edgeIdentity.serviceRightsExact;$unsignedEvidence.serviceAccountProcessesAbsent=$edgeIdentity.serviceAccountProcessesAbsent;$unsignedEvidence.protectedListenersAbsent=$edgeIdentity.protectedListenersAbsent}
      Write-AtomicJson $unsigned $unsignedEvidence -CreateOnly
      [void](Invoke-Bounded $node @($signer,$private,$unsigned,$signed) @{} 'ROLLBACK_EVIDENCE_SIGN')
      [IO.File]::Move($signed,[IO.Path]::GetFullPath($EvidenceOutputPath),$false)
      $evidencePublished = $true
    } finally { Remove-Item -LiteralPath $unsigned,$signed -Force -ErrorAction SilentlyContinue }
    $evidenceHash = Hash $EvidenceOutputPath 16777216
    $completeRecord=[ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='COMPLETE_MAINTENANCE_REQUIRED';intentSha256=$intentSha256;evidenceSha256=$evidenceHash;edgeStateMode=$EdgeStateMode;quiescenceProofType=$edgeIdentity.proofType;edgeIdentityDigest=$edgeIdentity.identityDigest;recoveryProcessTreeHelperPath=$processTreeHelper;recoveryProcessTreeHelperSha256=$ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant();maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;legacyQuiesceEvidenceSha256=$quiesceIdentity.EvidenceSha256;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;originalSchemaPreserved=$true;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=$originalStorageDigest;storageInventoryDigest=$storageDigest;productionStorageRestored=($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY');preservedOriginalStorage=($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY');partialTargetPossible=$false;productionDatabaseRestored=$true;completedAt=[datetimeoffset]::UtcNow.ToString('o')}
    if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){$completeRecord.recoveryWorkspaceRoot=$recoveryWorkspaceRoot;$completeRecord.localRecoverySecurityHelperSha256=$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()}
    Write-AtomicJson $RollbackJournalPath $completeRecord
    Assert-RestoreDeadline -Finalization
    [pscustomobject]@{Result='RESTORED_PENDING_EXPLICIT_TRANSITION';PreviousReleaseKind=$PreviousReleaseKind;EvidenceSha256=$evidenceHash;RollbackJournalSha256=(Hash $RollbackJournalPath 1048576);PreRollbackSchemaPreserved=$true;MaintenanceRetained=$true;AllWritersRetainedQuiesced=$true;LegacyRestartStillSeparatelyApprovalGated=($PreviousReleaseKind-eq'LEGACY_BASELINE');LocalReleaseTransitionStillSeparatelyApprovalGated=($PreviousReleaseKind-eq'LOCAL_RELEASE')} | ConvertTo-Json
    exit 0
  } catch {
    $failureCode = if ($_.Exception.Message -match '^[A-Z0-9_]{3,160}$') { $_.Exception.Message } else { 'ROLLBACK_RESTORE_UNCLASSIFIED_FAILURE' }
    $originalRestored = $false;$originalStorageRestored=($RecoveryPurpose-ne'DAILY_BACKUP_RECOVERY');$observedSchemaState = 'UNKNOWN';$preservedObserved = $false
    try {
      $observedSchemaState = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$schemaStateSql")) $environment 'ROLLBACK_FAILURE_SCHEMA_STATE_RECONCILE' -Cleanup
      if ($observedSchemaState -eq '1|0') { $originalRestored = $true }
      elseif ($observedSchemaState -in @('0|1','1|1')) {
        $preservedObserved = $true
        $repairSql = "BEGIN; DROP SCHEMA IF EXISTS $quotedSchema CASCADE; ALTER SCHEMA $quotedPreserved RENAME TO $quotedSchema; COMMIT;"
        [void](Invoke-Bounded $psql ($base + @('--set=ON_ERROR_STOP=1',"--command=$repairSql")) $environment 'ROLLBACK_AUTOMATIC_PRESERVED_SCHEMA_RECOVERY' -Cleanup)
        $repairState = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$schemaStateSql")) $environment 'ROLLBACK_AUTOMATIC_RECOVERY_STATE_VERIFY' -Cleanup
        if ($repairState -cne '1|0') { throw 'ROLLBACK_AUTOMATIC_RECOVERY_STATE_REJECTED' };$originalRestored = $true;$observedSchemaState = $repairState
      } elseif ($observedSchemaState -ne '0|0') { throw 'ROLLBACK_SCHEMA_STATE_UNRECOGNIZED' }
    } catch { $originalRestored = $false }
    if($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'-and$originalStorageDigest){try{Assert-ActionTimeRecoveryBoundary $approvalPlan.exactParameters.edgeIdentityDigest;$originalStorageRestored=Restore-OriginalStorage $liveStorageRoot $stagingStorageRoot $preservedStorageRoot $recoveryWorkspaceRoot $originalStorageDigest $fs}catch{$originalStorageRestored=$false}}
    if ($evidencePublished -and (Test-Path -LiteralPath $EvidenceOutputPath)) { Remove-Item -LiteralPath $EvidenceOutputPath -Force -ErrorAction SilentlyContinue }
    try {
      $recoveryProcedure = if ($originalRestored-and$originalStorageRestored) { 'ORIGINAL PRE-RECOVERY SCHEMA AND STORAGE WERE RESTORED; KEEP MAINTENANCE UNTIL A NEW APPROVED VERIFY.' } else { 'PRESERVED ORIGINAL SCHEMA OR STORAGE MUST NOT BE DELETED; KEEP MAINTENANCE AND QUIESCE; USE A NEW EXACT APPROVED RECOVER PLAN BEFORE ANY WRITER RESTART.' }
      Write-AtomicJson $RollbackJournalPath ([ordered]@{version=4;recoveryPurpose=$RecoveryPurpose;previousReleaseKind=$PreviousReleaseKind;state='FAILED_MAINTENANCE_REQUIRED';intentSha256=$intentSha256;failureCode=$failureCode;edgeStateMode=$EdgeStateMode;quiescenceProofType=$edgeIdentity.proofType;edgeIdentityDigest=$edgeIdentity.identityDigest;recoveryProcessTreeHelperPath=$processTreeHelper;recoveryProcessTreeHelperSha256=$ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant();maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;legacyQuiesceEvidenceSha256=$quiesceIdentity.EvidenceSha256;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;liveStorageRoot=$liveStorageRoot;stagingStorageRoot=$stagingStorageRoot;preservedStorageRoot=$preservedStorageRoot;originalStorageInventoryDigest=$originalStorageDigest;originalStorageRestored=$originalStorageRestored;firstMutationAttempted=$boundaryMutationAttempted;boundaryCommandReportedSuccess=$boundaryCreated;observedSchemaState=$observedSchemaState;originalSchemaRestored=$originalRestored;originalSchemaPreserved=($preservedObserved -and -not $originalRestored);partialTargetPossible=($boundaryMutationAttempted -and (-not$originalRestored-or-not$originalStorageRestored));freshSchemaStateReconciled=($observedSchemaState-ne'UNKNOWN');recoveryProcedure=$recoveryProcedure;failedAt=[datetimeoffset]::UtcNow.ToString('o')})
    } catch { throw 'ROLLBACK_RESTORE_FAILED_AND_DURABLE_JOURNAL_WRITE_FAILED' }
    throw 'ROLLBACK_RESTORE_FAILED_MAINTENANCE_REQUIRED'
  }
}

$journal = Existing $RollbackJournalPath $false 'ROLLBACK_DURABLE_JOURNAL_NOT_FOUND'
AssertHash $journal $ExpectedRollbackJournalSha256 'ROLLBACK_DURABLE_JOURNAL_HASH_MISMATCH' 1048576
$journalValue = Read-BoundedJson $journal 1048576 'ROLLBACK_DURABLE_JOURNAL_INVALID'
$evidence = Existing $EvidenceOutputPath $false 'ROLLBACK_EVIDENCE_NOT_FOUND'
AssertHash $evidence $ExpectedEvidenceSha256 'ROLLBACK_EVIDENCE_HASH_MISMATCH' 16777216
$restorePublic = Existing $RestoreReceiptPublicKeyPath $false 'ROLLBACK_PUBLIC_KEY_NOT_FOUND'
AssertHash $restorePublic $ExpectedRestoreReceiptPublicKeySha256 'ROLLBACK_PUBLIC_KEY_HASH_MISMATCH' 1048576
[void](Invoke-Bounded $node @($verifier,$restorePublic,$evidence,'database-rollback') @{} 'ROLLBACK_EVIDENCE_SIGNATURE_VERIFY')
$value = Read-BoundedJson $evidence 16777216 'ROLLBACK_EVIDENCE_INVALID'
$kpi = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=SET search_path TO $quotedSchema; $(KpiSql)")) $environment 'ROLLBACK_VERIFY_KPI'
$privilegeProof = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$privilegeSql")) $environment 'ROLLBACK_VERIFY_RUNTIME_ROLE'
$storageDigest = Get-RollbackStorageDigest
$edgeModeProof=if($EdgeStateMode-eq'ACTIVE_LOCAL_EDGE'){$value.quiescenceProofType-ceq'SIGNED_EDGE_DRAIN_V2'-and$value.drainVerified-and-not$value.legacyNoEdgeVerified-and-not$value.stoppedLocalEdgeVerified}elseif($EdgeStateMode-eq'LEGACY_QUIESCED_NO_EDGE'){$value.quiescenceProofType-ceq'SIGNED_LEGACY_QUIESCE_V2'-and$value.legacyNoEdgeVerified-and-not$value.drainVerified-and-not$value.stoppedLocalEdgeVerified}else{$value.quiescenceProofType-ceq'STOPPED_LOCAL_SERVICES_ABSENCE_V2'-and$value.stoppedLocalEdgeVerified-and$value.serviceRightsExact-and$value.serviceAccountProcessesAbsent-and$value.protectedListenersAbsent-and-not$value.drainVerified-and-not$value.legacyNoEdgeVerified}
$legacyEvidenceInvalid=$PreviousReleaseKind-eq'LEGACY_BASELINE'-and($value.baselineSha256-cne(Hash $baselinePath 16777216)-or$value.legacyQuiesceEvidenceSha256-cne$quiesceIdentity.EvidenceSha256-or$value.quiescePublicKeySha256-cne$quiesceIdentity.PublicKeySha256-or$value.quiesceSigningKeyId-cne$quiesceIdentity.SigningKeyId-or$value.legacyProcessIdentityDigest-cne$quiesceIdentity.ProcessIdentityDigest-or$value.legacyRestartCanonicalDigest-cne$quiesceIdentity.RestartCanonicalDigest-or$value.migrationDigest-cne$baseline.migrationDigest)
$localEvidenceInvalid=$PreviousReleaseKind-eq'LOCAL_RELEASE'-and($value.baselineSha256-or$value.legacyQuiesceEvidenceSha256-or$value.quiescePublicKeySha256-or$value.releaseId-cne$config.release.id-or$value.releaseManifestSha256-cne$ExpectedEdgeReleaseManifestSha256.ToLowerInvariant()-or$value.migrationDigest-cne$releaseManifest.migrationDigest-or$value.appliedMigrationDigest-cne$releaseManifest.appliedMigrationDigest)
$recordPurpose=if([string]$journalValue.recoveryPurpose){[string]$journalValue.recoveryPurpose}else{'MIGRATION_ROLLBACK'};$evidencePurpose=if([string]$value.recoveryPurpose){[string]$value.recoveryPurpose}else{'MIGRATION_ROLLBACK'}
$sourceProofInvalid=if($RecoveryPurpose-eq'MIGRATION_ROLLBACK'){$value.migrationJournalSha256-cne(Hash $migrationJournal 16777216)-or$value.restoreRehearsalEvidenceSha256}else{$value.migrationJournalSha256-or$value.restoreRehearsalEvidenceSha256-cne(Hash $restoreRehearsal 16777216)}
$dailyStorageInvalid=$RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'-and(-not$value.productionStorageRestored-or-not$value.preservedOriginalStorage-or-not$journalValue.productionStorageRestored-or-not$journalValue.preservedOriginalStorage-or$value.recoveryWorkspaceRoot-ine$recoveryWorkspaceRoot-or$journalValue.recoveryWorkspaceRoot-ine$recoveryWorkspaceRoot-or$value.localRecoverySecurityHelperSha256-cne$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()-or$journalValue.localRecoverySecurityHelperSha256-cne$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()-or$value.liveStorageRoot-ine$liveStorageRoot-or$value.preservedStorageRoot-ine$preservedStorageRoot-or$journalValue.liveStorageRoot-ine$liveStorageRoot-or$journalValue.preservedStorageRoot-ine$preservedStorageRoot-or$value.originalStorageInventoryDigest-cne$journalValue.originalStorageInventoryDigest-or-not(Test-Path -LiteralPath $preservedStorageRoot -PathType Container)-or(InventoryDigest $preservedStorageRoot)-cne$value.originalStorageInventoryDigest)
if ($journalValue.version -ne 4 -or $recordPurpose-cne$RecoveryPurpose-or$journalValue.previousReleaseKind-cne$PreviousReleaseKind-or$journalValue.state -cne 'COMPLETE_MAINTENANCE_REQUIRED' -or $journalValue.edgeStateMode-cne$EdgeStateMode -or $journalValue.quiescenceProofType-cne$value.quiescenceProofType -or $journalValue.edgeIdentityDigest-cne$edgeIdentity.identityDigest -or $journalValue.intentSha256 -cne $value.rollbackIntentSha256 -or $journalValue.evidenceSha256 -cne (Hash $evidence 16777216) -or $journalValue.recoveryProcessTreeHelperPath -ine $processTreeHelper -or $journalValue.recoveryProcessTreeHelperSha256 -cne $ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant() -or $journalValue.legacyQuiesceEvidenceSha256 -cne $quiesceIdentity.EvidenceSha256 -or -not $journalValue.originalSchemaPreserved -or $journalValue.partialTargetPossible -or $value.attestationType-cne'database-rollback'-or$value.version -ne 4 -or$evidencePurpose-cne$RecoveryPurpose-or$value.previousReleaseKind-cne$PreviousReleaseKind-or$legacyEvidenceInvalid-or$localEvidenceInvalid-or$sourceProofInvalid-or$dailyStorageInvalid-or$value.result -cne 'PASS' -or $value.edgeStateMode-cne$EdgeStateMode -or $value.edgeIdentityDigest-cne$edgeIdentity.identityDigest -or -not$value.quiescenceVerified -or -not$edgeModeProof -or $value.recoveryProcessTreeHelperPath -ine $processTreeHelper -or $value.recoveryProcessTreeHelperSha256 -cne $ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant() -or $value.backupEvidenceSha256 -cne (Hash $backupEvidence 16777216) -or -not $value.productionDatabaseRestored -or -not $value.preRollbackSchemaPreserved -or -not $value.runtimeRolePrivilegesVerified -or $privilegeProof -cne 't|t|t|t|t|t|t|t' -or -not $value.maintenanceVerified -or -not $value.businessKpiVerified -or (TextHash $kpi) -cne $value.businessKpiDigest -or -not $value.storageHashVerified -or $storageDigest -cne $value.storageInventoryDigest -or -not $value.hardDeadlineEnforced -or -not $value.processTreeKillOnDeadline -or -not $value.allReadsAndHashesDeadlineBound -or $value.elapsedSeconds -gt $MaximumRestoreDurationSeconds) { throw 'ROLLBACK_EVIDENCE_INVALID' }
Assert-RestoreDeadline -Finalization
[pscustomobject]@{Result='PASS';RecoveryPurpose=$RecoveryPurpose;PreviousReleaseKind=$PreviousReleaseKind;SignedRollbackEvidence=$true;DurableJournalVerified=$true;ProductionDatabaseRestored=$true;ProductionStorageRestored=($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY');PreRollbackSchemaPreserved=$true;PreRecoveryStoragePreserved=($RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY');MaintenanceRetained=$true;LegacyRestartStillSeparatelyApprovalGated=($PreviousReleaseKind-eq'LEGACY_BASELINE');LocalReleaseTransitionStillSeparatelyApprovalGated=($PreviousReleaseKind-eq'LOCAL_RELEASE')} | ConvertTo-Json
