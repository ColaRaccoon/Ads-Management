#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Apply','Verify')][string]$Action = 'Plan',
  [string]$RuntimeConfigPath,[string]$ExpectedRuntimeConfigSha256,
  [string]$LegacyBaselineEvidencePath,[string]$ExpectedLegacyBaselineEvidenceSha256,
  [string]$MigrationJournalPath,[string]$ExpectedMigrationJournalSha256,
  [string]$MaintenanceFlagPath,[string]$ExpectedMaintenanceFlagSha256,[string]$DrainStatePath,
  [string]$EdgeReleaseRoot,[string]$ExpectedEdgeReleaseManifestSha256,
  [string]$BackupEvidencePath,[string]$ExpectedBackupEvidenceSha256,[string]$BackupReceiptPublicKeyPath,[string]$ExpectedBackupReceiptPublicKeySha256,
  [string]$BackupDirectory,[string]$BackupIntegrityKeyFile,[string]$ExpectedBackupIntegrityKeySha256,
  [string]$NodePath,[string]$ExpectedNodeSha256,[string]$AttestationVerifierPath,[string]$ExpectedAttestationVerifierSha256,
  [string]$AttestationSignerPath,[string]$ExpectedAttestationSignerSha256,[string]$RestoreReceiptPrivateKeyPath,[string]$ExpectedRestoreReceiptPrivateKeySha256,[string]$RestoreReceiptPublicKeyPath,[string]$ExpectedRestoreReceiptPublicKeySha256,
  [string]$PsqlPath,[string]$ExpectedPsqlSha256,[string]$PgRestorePath,[string]$ExpectedPgRestoreSha256,[string]$PgPassFile,[string]$ExpectedPgPassSha256,[string]$CaCertificatePath,[string]$ExpectedCaCertificateSha256,
  [string]$FileSystemEvidencePath,[string]$ExpectedFileSystemEvidenceSha256,[string]$RollbackJournalPath,[string]$ExpectedRollbackJournalSha256,[string]$EvidenceOutputPath,[string]$ExpectedEvidenceSha256,
  [string]$ConfirmProjectRef,[string]$ConfirmDatabaseHost,[string]$ConfirmDatabaseName,[string]$ConfirmDatabaseSchema,[string]$ConfirmDatabaseUser,
  [ValidateSet(14400)][int]$MaximumRestoreDurationSeconds = 14400,[ValidateRange(1048576,274877906944)][long]$MaximumDatabaseDumpBytes = 68719476736,[ValidateRange(4096,8388608)][int]$MaximumChildOutputBytes = 1048576,
  [ValidateSet('Apply','VerifyEvidence')][string]$PlannedAction,[string]$ApprovedPlanSha256,[string]$ApprovalNonce,[string]$ApprovalIssuedAt,[string]$ApprovalExpiresAt,[string]$ApprovalInstanceId,[string]$ApprovalLedgerPath,[switch]$Approved
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
. (Join-Path $PSScriptRoot 'recovery-process-tree.ps1')
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
  if (-not(Test-Path -LiteralPath $parent -PathType Container)) { throw 'ROLLBACK_JOURNAL_PARENT_NOT_FOUND' };if ($CreateOnly -and (Test-Path -LiteralPath $full)) { throw 'ROLLBACK_JOURNAL_ALREADY_EXISTS' }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 32 -Compress));if ($bytes.Length -gt 1048576) { throw 'ROLLBACK_JOURNAL_SIZE_LIMIT' };$pending = Join-Path $parent ('.rollback-' + [guid]::NewGuid().ToString('N') + '.pending')
  try { $stream = [IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough);try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() };[IO.File]::Move($pending,$full,-not $CreateOnly) } finally { [Array]::Clear($bytes,0,$bytes.Length);if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force } }
  Assert-RestoreDeadline -Finalization
}
function Get-TreeIds([int]$RootProcessId) {
  Assert-RestoreDeadline -Finalization;$ids = @(Get-RecoveryProcessTreeIds $RootProcessId);if ($ids.Count -gt 4096) { throw 'ROLLBACK_PROCESS_SNAPSHOT_LIMIT' };return $ids
}
function Stop-TreeVerified([Diagnostics.Process]$Process) {
  if ($null -eq $Process) { return };$treeIds = [Collections.Generic.HashSet[int]]::new();foreach ($id in @(Get-TreeIds $Process.Id)) { [void]$treeIds.Add([int]$id) }
  if (-not $Process.HasExited) { try { $Process.Kill($true) } catch { throw 'ROLLBACK_PROCESS_TREE_KILL_FAILED' } }
  foreach ($id in @(Get-TreeIds $Process.Id)) { [void]$treeIds.Add([int]$id) }
  $remainingMilliseconds = [Math]::Max(1,[Math]::Min(5000,[int](($MaximumRestoreDurationSeconds - $script:RestoreWatch.Elapsed.TotalSeconds) * 1000)))
  if (-not $Process.WaitForExit($remainingMilliseconds) -or -not $Process.HasExited) { throw 'ROLLBACK_PROCESS_TREE_EXIT_UNCONFIRMED' }
  foreach ($id in @(Get-TreeIds $Process.Id)) { [void]$treeIds.Add([int]$id) }
  $watch = [Diagnostics.Stopwatch]::StartNew();do { $survivors = @($treeIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue });if ($survivors.Count -eq 0) { return };[Threading.Thread]::Sleep(25) } while ($watch.ElapsedMilliseconds -lt $remainingMilliseconds)
  throw 'ROLLBACK_PROCESS_TREE_DESCENDANT_SURVIVED'
}
function Invoke-Bounded([string]$Executable,[string[]]$Arguments,[hashtable]$Environment,[string]$Code,[switch]$Cleanup) {
  if ($Cleanup) { Assert-RestoreDeadline -Finalization } else { Assert-RestoreDeadline }
  $info = [Diagnostics.ProcessStartInfo]::new();$info.FileName = $Executable;$info.UseShellExecute = $false;$info.CreateNoWindow = $true;$info.RedirectStandardOutput = $true;$info.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) };foreach ($name in @('DATABASE_URL','PGPASSWORD','PGPASSFILE','PGSSLMODE','PGSSLROOTCERT','PGOPTIONS','PGCONNECT_TIMEOUT')) { [void]$info.Environment.Remove($name) };foreach ($name in $Environment.Keys) { $info.Environment[$name] = [string]$Environment[$name] }
  $process = [Diagnostics.Process]::new();$process.StartInfo = $info;$started = $false;$stdout = [IO.MemoryStream]::new();$stderr = [IO.MemoryStream]::new();$outBuffer = New-Object byte[] 8192;$errBuffer = New-Object byte[] 8192
  try {
    if (-not $process.Start()) { throw "$Code`_START_FAILED" };$started = $true;$outTask = $process.StandardOutput.BaseStream.ReadAsync($outBuffer,0,$outBuffer.Length);$errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer,0,$errBuffer.Length);$outDone = $false;$errDone = $false
    while (-not($process.HasExited -and $outDone -and $errDone)) {
      if ($Cleanup) { Assert-RestoreDeadline -Finalization } else { Assert-RestoreDeadline }
      if (-not $outDone -and $outTask.IsCompleted) { $count = $outTask.GetAwaiter().GetResult();if ($count -eq 0) { $outDone = $true } else { if ($stdout.Length + $stderr.Length + $count -gt $MaximumChildOutputBytes) { Stop-TreeVerified $process;throw "$Code`_OUTPUT_LIMIT" };$stdout.Write($outBuffer,0,$count);$outTask = $process.StandardOutput.BaseStream.ReadAsync($outBuffer,0,$outBuffer.Length) } }
      if (-not $errDone -and $errTask.IsCompleted) { $count = $errTask.GetAwaiter().GetResult();if ($count -eq 0) { $errDone = $true } else { if ($stdout.Length + $stderr.Length + $count -gt $MaximumChildOutputBytes) { Stop-TreeVerified $process;throw "$Code`_OUTPUT_LIMIT" };$stderr.Write($errBuffer,0,$count);$errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer,0,$errBuffer.Length) } }
      if (-not($process.HasExited -and $outDone -and $errDone)) { [Threading.Thread]::Sleep(10) }
    }
    if ($process.ExitCode -ne 0) { throw "$Code`_FAILED" };return [Text.Encoding]::UTF8.GetString($stdout.ToArray()).Trim()
  } finally { try { if ($started) { Stop-TreeVerified $process } } finally { $process.Dispose();$stdout.Dispose();$stderr.Dispose();[Array]::Clear($outBuffer,0,$outBuffer.Length);[Array]::Clear($errBuffer,0,$errBuffer.Length) } }
}
function Hmac([string]$KeyFile,[string]$Value) { $bytes = Read-BoundedBytes $KeyFile 1024 'ROLLBACK_INTEGRITY_KEY_INVALID';if ($bytes.Length -lt 32) { throw 'ROLLBACK_INTEGRITY_KEY_INVALID' };$h = [Security.Cryptography.HMACSHA256]::new($bytes);try { return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant()) } finally { $h.Dispose();[Array]::Clear($bytes,0,$bytes.Length) } }
function SignatureInput($m) { return @('6',$m.backupId,$m.createdAt,$m.backupMode,$m.sourceDataRoot,$m.backupRoot,$m.databaseProvider,$m.databaseProjectRef,$m.databaseConnectionMode,$m.databaseHost,[string]$m.databasePort,$m.databaseName,$m.databaseSchema,$m.releaseId,$m.databaseDumpSha256,[string]$m.databaseDumpBytes,[string]$m.maximumDatabaseDumpBytes,[string]$m.maximumBackupDurationSeconds,[string]$m.backupSafetyMarginBytes,[string]$m.elapsedSeconds,[string]$m.databaseSizePreflightVerified,[string]$m.databaseDumpRealtimeCapEnforced,[string]$m.databaseDumpFinalCapVerified,[string]$m.hardDeadlineEnforced,[string]$m.processTreeKillOnDeadline,[string]$m.incompleteStagingCleanupContract,$m.storageManifestSha256,$m.storageReferenceDigest,$m.storageReferenceConversionSha256,[string]$m.storageReferenceCount,[string]$m.storageReferenceZeroVerified,$m.legacyBaselineSha256,$m.legacyStorageStageEvidenceSha256,$m.migrationDigest,$m.appliedMigrationDigest,$m.businessKpiDigest,$m.targetEvidenceFingerprint,$m.configFingerprint,$m.fileCount,$m.totalBytes,$m.integrityKeyId,$m.nodeSha256,$m.psqlSha256,$m.pgDumpSha256,$m.executorSetDigest,$m.filesystemEvidenceSha256) -join "`n" }
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
function KpiSql { return "SELECT concat_ws('|',(SELECT count(*) FROM meta_adset_daily_metrics WHERE is_current),(SELECT coalesce(sum(spend_usd),0)::text FROM meta_adset_daily_metrics WHERE is_current),(SELECT coalesce(sum(result_count),0)::text FROM meta_adset_daily_metrics WHERE is_current),(SELECT count(*) FROM meta_ad_daily_metrics WHERE is_current),(SELECT coalesce(sum(purchase_count),0)::text FROM meta_ad_daily_metrics WHERE is_current),(SELECT count(*) FROM cafe24_order_lines WHERE is_current),(SELECT coalesce(sum(total_paid_krw),0)::text FROM cafe24_order_lines WHERE is_current),(SELECT count(*) FROM coupang_sale_lines WHERE is_current),(SELECT coalesce(sum(net_sales_krw),0)::text FROM coupang_sale_lines WHERE is_current),(SELECT count(*) FROM coupang_ad_metrics WHERE is_current),(SELECT coalesce(sum(ad_spend_krw),0)::text FROM coupang_ad_metrics WHERE is_current),(SELECT coalesce(sum(total_orders_1d),0)::text FROM coupang_ad_metrics WHERE is_current),(SELECT count(*) FROM coupang_manual_purchases),(SELECT coalesce(sum(quantity),0)::text FROM coupang_manual_purchases),(SELECT coalesce(sum(sales_amount_krw),0)::text FROM coupang_manual_purchases),(SELECT coalesce(sum(total_cost_krw),0)::text FROM coupang_manual_purchases),(SELECT count(*) FROM decision_logs),(SELECT count(*) FROM change_logs),(SELECT count(*) FROM report_exports))" }
function Quote-Identifier([string]$Value) { return '"' + $Value.Replace('"','""') + '"' }
function Get-PreservedSchemaName { $context = Get-ApprovalContext;return '__metaads_pre_' + $context.instanceId.Replace('-','').Substring(0,16) }

function Get-CurrentEdgeIdentity {
  $runtime = Existing $RuntimeConfigPath $false 'ROLLBACK_RUNTIME_NOT_FOUND'
  AssertHash $runtime $ExpectedRuntimeConfigSha256 'ROLLBACK_RUNTIME_HASH_MISMATCH' 16777216
  $config = Read-BoundedJson $runtime 16777216 'ROLLBACK_RUNTIME_INVALID'
  $drainPath = Existing $DrainStatePath $false 'ROLLBACK_DRAIN_NOT_FOUND'
  $drainSnapshot = Read-BoundedJsonSnapshot $drainPath 1048576 'ROLLBACK_DRAIN_INVALID';$drain = $drainSnapshot.Value
  try { $completed = [datetimeoffset]::Parse([string]$drain.completedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind) } catch { throw 'ROLLBACK_DRAIN_TIME_INVALID' }
  $now = [datetimeoffset]::UtcNow
  if ($drain.version -ne 1 -or $drain.result -cne 'DRAINED' -or $drain.activeRequests -ne 0 -or $completed -lt $now.AddSeconds(-30) -or $completed -gt $now.AddSeconds(5)) { throw 'ROLLBACK_DRAIN_NOT_FRESH' }
  $processId = [int]$drain.processId
  $process = Get-Process -Id $processId -ErrorAction Stop
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
  $node = Existing $NodePath $false 'ROLLBACK_NODE_NOT_FOUND'
  AssertHash $node $ExpectedNodeSha256 'ROLLBACK_NODE_HASH_MISMATCH'
  if (-not $cim.ExecutablePath -or [IO.Path]::GetFullPath([string]$cim.ExecutablePath) -cne $node -or [IO.Path]::GetFullPath([string]$config.hostSecurity.nodeProgramPath) -cne $node -or [string]$config.hostSecurity.nodeProgramSha256 -cne $ExpectedNodeSha256.ToLowerInvariant()) { throw 'ROLLBACK_EDGE_EXECUTABLE_IDENTITY_REJECTED' }
  $releaseRoot = Existing $EdgeReleaseRoot $true 'ROLLBACK_EDGE_RELEASE_ROOT_NOT_FOUND'
  $releaseManifestPath = Existing (Join-Path $releaseRoot 'release-manifest.json') $false 'ROLLBACK_EDGE_RELEASE_MANIFEST_NOT_FOUND'
  AssertHash $releaseManifestPath $ExpectedEdgeReleaseManifestSha256 'ROLLBACK_EDGE_RELEASE_MANIFEST_HASH_MISMATCH' 16777216
  $releaseManifest = Read-BoundedJson $releaseManifestPath 16777216 'ROLLBACK_EDGE_RELEASE_MANIFEST_INVALID'
  $commandLine = [string]$cim.CommandLine
  if ($releaseManifest.releaseId -cne $config.release.id -or $commandLine.IndexOf($releaseRoot,[StringComparison]::OrdinalIgnoreCase) -lt 0 -or $commandLine.IndexOf([IO.Path]::GetFullPath($RuntimeConfigPath),[StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'ROLLBACK_EDGE_RELEASE_IDENTITY_REJECTED' }
  $service = Get-CimInstance Win32_Service -Filter "Name='MetaAdsPerformanceEdge'" -ErrorAction Stop
  if (-not $service -or $service.State -cne 'Running' -or [int]$service.ProcessId -le 0 -or @(Get-TreeIds ([int]$service.ProcessId)) -notcontains $processId) { throw 'ROLLBACK_EDGE_SERVICE_IDENTITY_REJECTED' }
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction Stop)
  if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -cne [string]$config.lan.bindAddress -or [int]$listeners[0].OwningProcess -ne $processId) { throw 'ROLLBACK_EDGE_LISTENER_IDENTITY_REJECTED' }
  $startedAt = $process.StartTime.ToUniversalTime().ToString('o')
  $commandLineSha256 = TextHash $commandLine
  $identityDigest = TextHash (@('edge-rollback-v1',[string]$processId,$startedAt,$node,$ExpectedNodeSha256.ToLowerInvariant(),$commandLineSha256,$releaseRoot,$ExpectedEdgeReleaseManifestSha256.ToLowerInvariant(),[string]$config.release.id,[string]$config.lan.bindAddress,'443',[string]$service.ProcessId) -join "`n")
  $finalDrainSnapshot = Read-BoundedJsonSnapshot $drainPath 1048576 'ROLLBACK_DRAIN_INVALID';$finalDrain = $finalDrainSnapshot.Value
  try { $finalCompleted = [datetimeoffset]::Parse([string]$finalDrain.completedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind) } catch { throw 'ROLLBACK_DRAIN_TIME_INVALID' }
  $finalListeners = @(Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction Stop);$finalProcess = Get-Process -Id $processId -ErrorAction Stop
  $finalNow = [datetimeoffset]::UtcNow
  if ($finalDrain.version -ne 1 -or $finalDrain.result -cne 'DRAINED' -or [int]$finalDrain.processId -ne $processId -or $finalDrain.activeRequests -ne 0 -or $finalCompleted -lt $finalNow.AddSeconds(-30) -or $finalCompleted -gt $finalNow.AddSeconds(5) -or $finalListeners.Count -ne 1 -or [int]$finalListeners[0].OwningProcess -ne $processId -or $finalListeners[0].LocalAddress -cne [string]$config.lan.bindAddress -or $finalProcess.StartTime.ToUniversalTime().ToString('o') -cne $startedAt) { throw 'ROLLBACK_EDGE_IDENTITY_CHANGED_DURING_CAPTURE' }
  return [pscustomobject]@{processId=$processId;processStartedAt=$startedAt;executablePath=$node;executableSha256=$ExpectedNodeSha256.ToLowerInvariant();commandLineSha256=$commandLineSha256;releaseRoot=$releaseRoot;releaseId=[string]$config.release.id;releaseManifestSha256=$ExpectedEdgeReleaseManifestSha256.ToLowerInvariant();listenerAddress=[string]$config.lan.bindAddress;listenerPort=443;serviceProcessId=[int]$service.ProcessId;activeRequests=0;drainCompletedAt=$finalCompleted.ToUniversalTime().ToString('o');drainStateSha256=$finalDrainSnapshot.Sha256;identityDigest=$identityDigest}
}

function New-RollbackPlan([string]$IntendedAction) {
  if ($IntendedAction -notin @('Apply','VerifyEvidence')) { throw 'ROLLBACK_RESTORE_PLAN_ACTION_REQUIRED' }
  $context = Get-ApprovalContext
  $edge = Get-CurrentEdgeIdentity
  $preserved = Get-PreservedSchemaName
  $parameters = [ordered]@{
    provider='supabase_postgres';projectRef=Get-ApprovalText $ConfirmProjectRef '^[a-z]{20}$' 'ROLLBACK_PROJECT_REQUIRED';host=Get-ApprovalText $ConfirmDatabaseHost '^(?:db\.[a-z]{20}\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$' 'ROLLBACK_HOST_REQUIRED';port=5432;databaseName=Get-ApprovalText $ConfirmDatabaseName '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_DATABASE_REQUIRED';databaseSchema=Get-ApprovalText $ConfirmDatabaseSchema '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_SCHEMA_REQUIRED';preservedSchema=$preserved;databaseUser=Get-ApprovalText $ConfirmDatabaseUser '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_DATABASE_USER_REQUIRED'
    runtimeConfigPath=Get-ApprovalPath $RuntimeConfigPath 'ROLLBACK_RUNTIME_REQUIRED';runtimeConfigSha256=Get-ApprovalHash $ExpectedRuntimeConfigSha256 'ROLLBACK_RUNTIME_HASH_REQUIRED';baselinePath=Get-ApprovalPath $LegacyBaselineEvidencePath 'ROLLBACK_BASELINE_REQUIRED';baselineSha256=Get-ApprovalHash $ExpectedLegacyBaselineEvidenceSha256 'ROLLBACK_BASELINE_HASH_REQUIRED';migrationJournalPath=Get-ApprovalPath $MigrationJournalPath 'ROLLBACK_MIGRATION_JOURNAL_REQUIRED';migrationJournalSha256=Get-ApprovalHash $ExpectedMigrationJournalSha256 'ROLLBACK_MIGRATION_JOURNAL_HASH_REQUIRED';rollbackJournalPath=Get-ApprovalPath $RollbackJournalPath 'ROLLBACK_DURABLE_JOURNAL_REQUIRED'
    maintenanceFlagPath=Get-ApprovalPath $MaintenanceFlagPath 'ROLLBACK_MAINTENANCE_REQUIRED';maintenanceFlagSha256=Get-ApprovalHash $ExpectedMaintenanceFlagSha256 'ROLLBACK_MAINTENANCE_HASH_REQUIRED';drainStatePath=Get-ApprovalPath $DrainStatePath 'ROLLBACK_DRAIN_REQUIRED';maximumDrainAgeSeconds=30
    edgeProcessId=$edge.processId;edgeProcessStartedAt=$edge.processStartedAt;edgeExecutablePath=$edge.executablePath;edgeExecutableSha256=$edge.executableSha256;edgeCommandLineSha256=$edge.commandLineSha256;edgeReleaseRoot=$edge.releaseRoot;edgeReleaseId=$edge.releaseId;edgeReleaseManifestSha256=$edge.releaseManifestSha256;edgeListenerAddress=$edge.listenerAddress;edgeListenerPort=443;edgeIdentityDigest=$edge.identityDigest
    backupEvidencePath=Get-ApprovalPath $BackupEvidencePath 'ROLLBACK_BACKUP_EVIDENCE_REQUIRED';backupEvidenceSha256=Get-ApprovalHash $ExpectedBackupEvidenceSha256 'ROLLBACK_BACKUP_EVIDENCE_HASH_REQUIRED';backupPublicKeyPath=Get-ApprovalPath $BackupReceiptPublicKeyPath 'ROLLBACK_BACKUP_KEY_REQUIRED';backupPublicKeySha256=Get-ApprovalHash $ExpectedBackupReceiptPublicKeySha256 'ROLLBACK_BACKUP_KEY_HASH_REQUIRED';backupDirectory=Get-ApprovalPath $BackupDirectory 'ROLLBACK_BACKUP_DIRECTORY_REQUIRED';integrityKeyPath=Get-ApprovalPath $BackupIntegrityKeyFile 'ROLLBACK_INTEGRITY_KEY_REQUIRED';integrityKeySha256=Get-ApprovalHash $ExpectedBackupIntegrityKeySha256 'ROLLBACK_INTEGRITY_KEY_HASH_REQUIRED'
    nodePath=Get-ApprovalPath $NodePath 'ROLLBACK_NODE_REQUIRED';nodeSha256=Get-ApprovalHash $ExpectedNodeSha256 'ROLLBACK_NODE_HASH_REQUIRED';verifierPath=Get-ApprovalPath $AttestationVerifierPath 'ROLLBACK_VERIFIER_REQUIRED';verifierSha256=Get-ApprovalHash $ExpectedAttestationVerifierSha256 'ROLLBACK_VERIFIER_HASH_REQUIRED';psqlPath=Get-ApprovalPath $PsqlPath 'ROLLBACK_PSQL_REQUIRED';psqlSha256=Get-ApprovalHash $ExpectedPsqlSha256 'ROLLBACK_PSQL_HASH_REQUIRED';pgRestorePath=Get-ApprovalPath $PgRestorePath 'ROLLBACK_PGRESTORE_REQUIRED';pgRestoreSha256=Get-ApprovalHash $ExpectedPgRestoreSha256 'ROLLBACK_PGRESTORE_HASH_REQUIRED';pgPassPath=Get-ApprovalPath $PgPassFile 'ROLLBACK_PGPASS_REQUIRED';pgPassSha256=Get-ApprovalHash $ExpectedPgPassSha256 'ROLLBACK_PGPASS_HASH_REQUIRED';caPath=Get-ApprovalPath $CaCertificatePath 'ROLLBACK_CA_REQUIRED';caSha256=Get-ApprovalHash $ExpectedCaCertificateSha256 'ROLLBACK_CA_HASH_REQUIRED'
    filesystemEvidencePath=Get-ApprovalPath $FileSystemEvidencePath 'ROLLBACK_FS_REQUIRED';filesystemEvidenceSha256=Get-ApprovalHash $ExpectedFileSystemEvidenceSha256 'ROLLBACK_FS_HASH_REQUIRED';evidenceOutputPath=Get-ApprovalPath $EvidenceOutputPath 'ROLLBACK_EVIDENCE_OUTPUT_REQUIRED';maximumRestoreDurationSeconds=$MaximumRestoreDurationSeconds;maximumDatabaseDumpBytes=$MaximumDatabaseDumpBytes;maximumChildOutputBytes=$MaximumChildOutputBytes;approvalInstanceId=$context.instanceId
  }
  if ($IntendedAction -eq 'Apply') {
    $parameters.signerPath=Get-ApprovalPath $AttestationSignerPath 'ROLLBACK_SIGNER_REQUIRED';$parameters.signerSha256=Get-ApprovalHash $ExpectedAttestationSignerSha256 'ROLLBACK_SIGNER_HASH_REQUIRED';$parameters.restorePrivateKeyPath=Get-ApprovalPath $RestoreReceiptPrivateKeyPath 'ROLLBACK_PRIVATE_KEY_REQUIRED';$parameters.restorePrivateKeySha256=Get-ApprovalHash $ExpectedRestoreReceiptPrivateKeySha256 'ROLLBACK_PRIVATE_KEY_HASH_REQUIRED'
  } else {
    $parameters.rollbackJournalSha256=Get-ApprovalHash $ExpectedRollbackJournalSha256 'ROLLBACK_DURABLE_JOURNAL_HASH_REQUIRED';$parameters.evidenceSha256=Get-ApprovalHash $ExpectedEvidenceSha256 'ROLLBACK_EVIDENCE_HASH_REQUIRED';$parameters.restorePublicKeyPath=Get-ApprovalPath $RestoreReceiptPublicKeyPath 'ROLLBACK_PUBLIC_KEY_REQUIRED';$parameters.restorePublicKeySha256=Get-ApprovalHash $ExpectedRestoreReceiptPublicKeySha256 'ROLLBACK_PUBLIC_KEY_HASH_REQUIRED'
  }
  return New-ApprovalPlan $PSCommandPath $IntendedAction $parameters "Exact existing Supabase target $ConfirmProjectRef/$ConfirmDatabaseHost`:5432/$ConfirmDatabaseName schema $ConfirmDatabaseSchema with preserved schema $preserved" 'Keeps maintenance, drain, and legacy quiesce active; durably records INTENT; transactionally preserves the current schema before restoring and proving the signed legacy backup' 'On failure, atomically restore the preserved schema when possible; otherwise retain it with FAILED_MAINTENANCE_REQUIRED and do not restart writers until a new exact approved repair'
}

$intended = if ($Action -eq 'Apply') { 'Apply' } else { 'VerifyEvidence' }
$approvalPlan = New-RollbackPlan $(if ($Action -eq 'Plan') { $PlannedAction } else { $intended })
if ($Action -eq 'Plan') { $approvalPlan | ConvertTo-Json -Depth 16;exit 0 }
Assert-ApprovedPlan $approvalPlan ([bool]$Approved) $ApprovedPlanSha256
$edgeIdentity = Get-CurrentEdgeIdentity
if ($edgeIdentity.identityDigest -cne $approvalPlan.exactParameters.edgeIdentityDigest) { throw 'ROLLBACK_EDGE_IDENTITY_DRIFT' }

$runtime = Existing $RuntimeConfigPath $false 'ROLLBACK_RUNTIME_NOT_FOUND'
$baselinePath = Existing $LegacyBaselineEvidencePath $false 'ROLLBACK_BASELINE_NOT_FOUND'
$migrationJournal = Existing $MigrationJournalPath $false 'ROLLBACK_MIGRATION_JOURNAL_NOT_FOUND'
$maintenancePath = Existing $MaintenanceFlagPath $false 'ROLLBACK_MAINTENANCE_NOT_FOUND'
$backupEvidence = Existing $BackupEvidencePath $false 'ROLLBACK_BACKUP_EVIDENCE_NOT_FOUND'
$backupPublic = Existing $BackupReceiptPublicKeyPath $false 'ROLLBACK_BACKUP_PUBLIC_KEY_NOT_FOUND'
$backupRoot = Existing $BackupDirectory $true 'ROLLBACK_BACKUP_DIRECTORY_NOT_FOUND'
$integrityKey = Existing $BackupIntegrityKeyFile $false 'ROLLBACK_INTEGRITY_KEY_NOT_FOUND'
$node = Existing $NodePath $false 'ROLLBACK_NODE_NOT_FOUND'
$verifier = Existing $AttestationVerifierPath $false 'ROLLBACK_VERIFIER_NOT_FOUND'
$psql = Existing $PsqlPath $false 'ROLLBACK_PSQL_NOT_FOUND'
$pgRestore = Existing $PgRestorePath $false 'ROLLBACK_PGRESTORE_NOT_FOUND'
$pgpass = Existing $PgPassFile $false 'ROLLBACK_PGPASS_NOT_FOUND'
$ca = Existing $CaCertificatePath $false 'ROLLBACK_CA_NOT_FOUND'
$fsPath = Existing $FileSystemEvidencePath $false 'ROLLBACK_FS_NOT_FOUND'
foreach ($item in @(
  @($runtime,$ExpectedRuntimeConfigSha256,'ROLLBACK_RUNTIME_HASH_MISMATCH',16777216),@($baselinePath,$ExpectedLegacyBaselineEvidenceSha256,'ROLLBACK_BASELINE_HASH_MISMATCH',16777216),@($migrationJournal,$ExpectedMigrationJournalSha256,'ROLLBACK_MIGRATION_JOURNAL_HASH_MISMATCH',16777216),@($maintenancePath,$ExpectedMaintenanceFlagSha256,'ROLLBACK_MAINTENANCE_HASH_MISMATCH',1048576),@($backupEvidence,$ExpectedBackupEvidenceSha256,'ROLLBACK_BACKUP_EVIDENCE_HASH_MISMATCH',16777216),@($backupPublic,$ExpectedBackupReceiptPublicKeySha256,'ROLLBACK_BACKUP_KEY_HASH_MISMATCH',1048576),@($integrityKey,$ExpectedBackupIntegrityKeySha256,'ROLLBACK_INTEGRITY_KEY_HASH_MISMATCH',1024),@($node,$ExpectedNodeSha256,'ROLLBACK_NODE_HASH_MISMATCH',1073741824),@($verifier,$ExpectedAttestationVerifierSha256,'ROLLBACK_VERIFIER_HASH_MISMATCH',16777216),@($psql,$ExpectedPsqlSha256,'ROLLBACK_PSQL_HASH_MISMATCH',1073741824),@($pgRestore,$ExpectedPgRestoreSha256,'ROLLBACK_PGRESTORE_HASH_MISMATCH',1073741824),@($pgpass,$ExpectedPgPassSha256,'ROLLBACK_PGPASS_HASH_MISMATCH',1048576),@($ca,$ExpectedCaCertificateSha256,'ROLLBACK_CA_HASH_MISMATCH',1048576),@($fsPath,$ExpectedFileSystemEvidenceSha256,'ROLLBACK_FS_HASH_MISMATCH',16777216)
)) { AssertHash $item[0] $item[1] $item[2] $item[3] }

$config = Read-BoundedJson $runtime 16777216 'ROLLBACK_RUNTIME_INVALID'
$db = $config.database
if ($db.provider -cne 'supabase_postgres' -or $db.projectRef -cne $ConfirmProjectRef -or $db.host -cne $ConfirmDatabaseHost -or $db.port -ne 5432 -or $db.name -cne $ConfirmDatabaseName -or $db.schema -cne $ConfirmDatabaseSchema -or $db.migrationUser -cne $ConfirmDatabaseUser) { throw 'ROLLBACK_DATABASE_TARGET_MISMATCH' }
if ($db.runtimeUser -notmatch '^[a-z][a-z0-9_]{0,62}$') { throw 'ROLLBACK_RUNTIME_DATABASE_USER_INVALID' }
$maintenance = Read-BoundedJson $maintenancePath 1048576 'ROLLBACK_MAINTENANCE_INVALID'
if ($maintenance.version -ne 1 -or -not $maintenance.enabled -or $maintenance.releaseId -cne $config.release.id -or @(Get-NetTCPConnection -State Listen -LocalPort 3100,4100 -ErrorAction SilentlyContinue).Count) { throw 'ROLLBACK_MAINTENANCE_DRAIN_OR_QUIESCE_REJECTED' }
$baseline = Read-BoundedJson $baselinePath 16777216 'ROLLBACK_BASELINE_INVALID'
$migration = Read-BoundedJson $migrationJournal 16777216 'ROLLBACK_MIGRATION_JOURNAL_INVALID'
if ($baseline.version -ne 3 -or $baseline.proofType -cne 'legacy-running-baseline' -or $baseline.migrationDigest -notmatch '^[0-9a-f]{64}$' -or ($migration.result -cne 'APPLIED_PENDING_BOUNDARY' -and $migration.result -cne 'APPLIED')) { throw 'ROLLBACK_BASELINE_OR_JOURNAL_REJECTED' }
[void](Invoke-Bounded $node @($verifier,$backupPublic,$backupEvidence,'backup-latest') @{} 'ROLLBACK_BACKUP_SIGNATURE_VERIFY')
$receipt = Read-BoundedJson $backupEvidence 16777216 'ROLLBACK_BACKUP_EVIDENCE_INVALID'
if ($receipt.attestationType -cne 'backup-latest' -or $receipt.result -cne 'COMPLETE' -or $receipt.backupMode -cne 'LEGACY_BASELINE' -or $receipt.legacyBaselineSha256 -cne (Hash $baselinePath 16777216) -or $receipt.databaseProjectRef -cne $ConfirmProjectRef -or $receipt.databaseHost -cne $ConfirmDatabaseHost -or $receipt.databaseName -cne $ConfirmDatabaseName -or $receipt.databaseSchema -cne $ConfirmDatabaseSchema) { throw 'ROLLBACK_BACKUP_CHAIN_REJECTED' }
$manifestPath = Existing (Join-Path $backupRoot 'backup-manifest.json') $false 'ROLLBACK_MANIFEST_NOT_FOUND'
$dumpPath = Existing (Join-Path $backupRoot 'database.dump') $false 'ROLLBACK_DUMP_NOT_FOUND'
if ((Hash $manifestPath 16777216) -cne $receipt.manifestSha256) { throw 'ROLLBACK_MANIFEST_HASH_MISMATCH' }
$manifest = Read-BoundedJson $manifestPath 16777216 'ROLLBACK_MANIFEST_INVALID'
if ($manifest.version -ne 6 -or $manifest.backupId -cne $receipt.backupId -or $manifest.databaseDumpBytes -gt $MaximumDatabaseDumpBytes -or (Get-Item -LiteralPath $dumpPath).Length -ne $manifest.databaseDumpBytes -or (Hash $dumpPath $MaximumDatabaseDumpBytes 'ROLLBACK_DUMP_HASH_REJECTED') -cne $manifest.databaseDumpSha256 -or (Hash $integrityKey 1024) -cne $manifest.integrityKeyId -or (Hmac $integrityKey (SignatureInput $manifest)) -cne $manifest.integritySignature) { throw 'ROLLBACK_BACKUP_INTEGRITY_REJECTED' }
$fs = Read-BoundedJson $fsPath 16777216 'ROLLBACK_FILESYSTEM_EVIDENCE_INVALID'
if ($fs.result -ne 'PASS' -or -not $fs.exactAcl -or @(@($node,$verifier,$psql,$pgRestore,$EdgeReleaseRoot) | Where-Object { -not(Under $_ $fs.classRoots.SHARED_RUNTIME) }).Count -or -not(Under $pgpass $fs.classRoots.ADMIN_ONLY) -or -not(Under $integrityKey $fs.classRoots.BACKUP_ONLY) -or -not(Under $EvidenceOutputPath $fs.classRoots.ADMIN_EVIDENCE) -or -not(Under $RollbackJournalPath $fs.classRoots.ADMIN_EVIDENCE)) { throw 'ROLLBACK_FILESYSTEM_BOUNDARY_REJECTED' }
if ([IO.Path]::GetFullPath($RollbackJournalPath) -ieq [IO.Path]::GetFullPath($EvidenceOutputPath) -or [IO.Path]::GetFullPath($RollbackJournalPath) -ieq [IO.Path]::GetFullPath($MigrationJournalPath)) { throw 'ROLLBACK_JOURNAL_PATH_COLLISION' }

$connectionUser = if ($db.connectionMode -eq 'session_pooler') { "$($db.migrationUser).$($db.projectRef)" } else { [string]$db.migrationUser }
$environment = @{PGPASSFILE=$pgpass;PGSSLMODE='verify-full';PGSSLROOTCERT=$ca;PGCONNECT_TIMEOUT='15';PGOPTIONS='-c lock_timeout=30000 -c statement_timeout=3600000 -c idle_in_transaction_session_timeout=60000';PGAPPNAME='meta-ads-legacy-rollback'}
$base = @("--host=$($db.host)",'--port=5432',"--username=$connectionUser","--dbname=$($db.name)",'--no-password')
$quotedSchema = Quote-Identifier $ConfirmDatabaseSchema
$preservedSchema = [string]$approvalPlan.exactParameters.preservedSchema
$quotedPreserved = Quote-Identifier $preservedSchema
$quotedRuntimeUser = Quote-Identifier $db.runtimeUser
$privilegeSql = "SELECT concat_ws('|',has_schema_privilege('$($db.runtimeUser)','$ConfirmDatabaseSchema','USAGE'),coalesce((SELECT bool_and(has_table_privilege('$($db.runtimeUser)',format('%I.%I',schemaname,tablename),'SELECT') AND has_table_privilege('$($db.runtimeUser)',format('%I.%I',schemaname,tablename),'INSERT') AND has_table_privilege('$($db.runtimeUser)',format('%I.%I',schemaname,tablename),'UPDATE') AND has_table_privilege('$($db.runtimeUser)',format('%I.%I',schemaname,tablename),'DELETE')) FROM pg_tables WHERE schemaname='$ConfirmDatabaseSchema'),true),coalesce((SELECT bool_and(has_sequence_privilege('$($db.runtimeUser)',format('%I.%I',schemaname,sequencename),'USAGE') AND has_sequence_privilege('$($db.runtimeUser)',format('%I.%I',schemaname,sequencename),'SELECT') AND has_sequence_privilege('$($db.runtimeUser)',format('%I.%I',schemaname,sequencename),'UPDATE')) FROM pg_sequences WHERE schemaname='$ConfirmDatabaseSchema'),true))"

if ($Action -eq 'Apply') {
  if (Test-Path -LiteralPath $RollbackJournalPath) { throw 'ROLLBACK_JOURNAL_ALREADY_EXISTS' }
  if (Test-Path -LiteralPath $EvidenceOutputPath) { throw 'ROLLBACK_EVIDENCE_ALREADY_EXISTS' }
  $signer = Existing $AttestationSignerPath $false 'ROLLBACK_SIGNER_NOT_FOUND'
  $private = Existing $RestoreReceiptPrivateKeyPath $false 'ROLLBACK_PRIVATE_KEY_NOT_FOUND'
  AssertHash $signer $ExpectedAttestationSignerSha256 'ROLLBACK_SIGNER_HASH_MISMATCH' 16777216
  AssertHash $private $ExpectedRestoreReceiptPrivateKeySha256 'ROLLBACK_PRIVATE_KEY_HASH_MISMATCH' 1048576
  if (-not(Under $signer $fs.classRoots.SHARED_RUNTIME) -or -not(Under $private $fs.classRoots.ADMIN_ONLY)) { throw 'ROLLBACK_SIGNER_BOUNDARY_REJECTED' }
  $schemaState = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=SELECT (to_regnamespace('$ConfirmDatabaseSchema') IS NOT NULL)::int || '|' || (to_regnamespace('$preservedSchema') IS NOT NULL)::int")) $environment 'ROLLBACK_SCHEMA_PREFLIGHT'
  if ($schemaState -cne '1|0') { throw 'ROLLBACK_SCHEMA_PREFLIGHT_REJECTED' }

  $intent = [ordered]@{version=1;state='INTENT';maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;planSha256=$approvalPlan.planSha256;approvalInstanceId=$approvalPlan.approvalInstanceId;databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;edgeIdentityDigest=$edgeIdentity.identityDigest;edgeProcessId=$edgeIdentity.processId;edgeProcessStartedAt=$edgeIdentity.processStartedAt;edgeExecutableSha256=$edgeIdentity.executableSha256;edgeReleaseId=$edgeIdentity.releaseId;edgeReleaseManifestSha256=$edgeIdentity.releaseManifestSha256;edgeListenerAddress=$edgeIdentity.listenerAddress;edgeListenerPort=443;drainStateSha256=$edgeIdentity.drainStateSha256;drainCompletedAt=$edgeIdentity.drainCompletedAt;activeRequests=0;backupEvidenceSha256=(Hash $backupEvidence 16777216);backupManifestSha256=(Hash $manifestPath 16777216);createdAt=[datetimeoffset]::UtcNow.ToString('o')}
  $intentSha256 = TextHash ($intent | ConvertTo-Json -Depth 32 -Compress)
  Write-AtomicJson $RollbackJournalPath $intent -CreateOnly
  $boundaryCreated = $false
  $evidencePublished = $false
  try {
    if ((Hash $RollbackJournalPath 1048576) -cne $intentSha256) { throw 'ROLLBACK_INTENT_DURABILITY_VERIFY_FAILED' }
    $boundarySql = "BEGIN; ALTER SCHEMA $quotedSchema RENAME TO $quotedPreserved; COMMIT;"
    [void](Invoke-Bounded $psql ($base + @('--set=ON_ERROR_STOP=1',"--command=$boundarySql")) $environment 'ROLLBACK_PRESERVE_SCHEMA_BOUNDARY')
    $boundaryCreated = $true
    Write-AtomicJson $RollbackJournalPath ([ordered]@{version=1;state='PRESERVED_ORIGINAL_RESTORE_IN_PROGRESS';intentSha256=$intentSha256;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;originalSchemaPreserved=$true;partialTargetPossible=$true;updatedAt=[datetimeoffset]::UtcNow.ToString('o')})
    [void](Invoke-Bounded $pgRestore @("--host=$($db.host)",'--port=5432',"--username=$connectionUser","--dbname=$($db.name)",'--no-password','--exit-on-error','--no-owner','--no-privileges',"--schema=$ConfirmDatabaseSchema",$dumpPath) $environment 'ROLLBACK_PG_RESTORE')
    $grantSql = "GRANT USAGE ON SCHEMA $quotedSchema TO $quotedRuntimeUser; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA $quotedSchema TO $quotedRuntimeUser; GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA $quotedSchema TO $quotedRuntimeUser; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA $quotedSchema TO $quotedRuntimeUser; ALTER DEFAULT PRIVILEGES FOR ROLE $(Quote-Identifier $db.migrationUser) IN SCHEMA $quotedSchema GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $quotedRuntimeUser; ALTER DEFAULT PRIVILEGES FOR ROLE $(Quote-Identifier $db.migrationUser) IN SCHEMA $quotedSchema GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO $quotedRuntimeUser;"
    [void](Invoke-Bounded $psql ($base + @('--set=ON_ERROR_STOP=1',"--command=$grantSql")) $environment 'ROLLBACK_RUNTIME_ROLE_GRANTS')
    $privilegeProof = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$privilegeSql")) $environment 'ROLLBACK_RUNTIME_ROLE_VERIFY'
    if ($privilegeProof -cne 't|t|t') { throw 'ROLLBACK_RUNTIME_ROLE_PRIVILEGES_REJECTED' }
    $kpi = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=SET search_path TO $quotedSchema; $(KpiSql)")) $environment 'ROLLBACK_KPI_VERIFY'
    if ((TextHash $kpi) -cne $manifest.businessKpiDigest) { throw 'ROLLBACK_KPI_MISMATCH' }
    $storageDigest = TextHash (@("uploads=$(InventoryDigest ([string]$baseline.legacyUploadsRoot))","reports=$(InventoryDigest ([string]$baseline.legacyReportsRoot))") -join "`n")
    if ($storageDigest -cne $baseline.storageInventoryDigest) { throw 'ROLLBACK_STORAGE_HASH_MISMATCH' }
    Assert-RestoreDeadline
    $unsigned = "$EvidenceOutputPath.unsigned"
    $signed = "$EvidenceOutputPath.pending"
    try {
      $unsignedEvidence = [ordered]@{attestationType='legacy-database-rollback';version=2;result='PASS';rollbackIntentSha256=$intentSha256;rollbackPlanSha256=$approvalPlan.planSha256;baselineSha256=(Hash $baselinePath 16777216);migrationJournalSha256=(Hash $migrationJournal 16777216);migrationDigest=$baseline.migrationDigest;backupEvidenceSha256=(Hash $backupEvidence 16777216);backupId=$manifest.backupId;backupManifestSha256=(Hash $manifestPath 16777216);databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preRollbackSchemaPreserved=$true;preservedSchema=$preservedSchema;productionDatabaseRestored=$true;runtimeRolePrivilegesVerified=$true;maintenanceVerified=$true;drainVerified=$true;drainStateSha256=$edgeIdentity.drainStateSha256;drainCompletedAt=$edgeIdentity.drainCompletedAt;edgeIdentityDigest=$edgeIdentity.identityDigest;edgeProcessId=$edgeIdentity.processId;edgeProcessStartedAt=$edgeIdentity.processStartedAt;edgeExecutableSha256=$edgeIdentity.executableSha256;edgeReleaseId=$edgeIdentity.releaseId;edgeReleaseManifestSha256=$edgeIdentity.releaseManifestSha256;edgeListenerAddress=$edgeIdentity.listenerAddress;edgeListenerPort=443;activeRequestsAtMutation=0;legacyWritersQuiesced=$true;businessKpiVerified=$true;businessKpiDigest=$manifest.businessKpiDigest;storageHashVerified=$true;storageInventoryDigest=$storageDigest;hardDeadlineEnforced=$true;processTreeKillOnDeadline=$true;allReadsAndHashesDeadlineBound=$true;elapsedSeconds=[int][Math]::Ceiling($script:RestoreWatch.Elapsed.TotalSeconds);maintenanceMustRemainEnabled=$true;recoveryProcedure='KEEP MAINTENANCE AND LEGACY QUIESCE. RETURN FORWARD ONLY WITH A NEW EXACT APPROVED TRANSACTIONAL DROP-CURRENT AND RENAME-PRESERVED PLAN. RETRY LEGACY RESTORE ONLY WITH A NEW EXACT APPROVED RESTORE. RESTART LEGACY ONLY AFTER SIGNED VERIFY.';completedAt=[datetimeoffset]::UtcNow.ToString('o')}
      Write-AtomicJson $unsigned $unsignedEvidence -CreateOnly
      [void](Invoke-Bounded $node @($signer,$private,$unsigned,$signed) @{} 'ROLLBACK_EVIDENCE_SIGN')
      [IO.File]::Move($signed,[IO.Path]::GetFullPath($EvidenceOutputPath),$false)
      $evidencePublished = $true
    } finally { Remove-Item -LiteralPath $unsigned,$signed -Force -ErrorAction SilentlyContinue }
    $evidenceHash = Hash $EvidenceOutputPath 16777216
    Write-AtomicJson $RollbackJournalPath ([ordered]@{version=1;state='COMPLETE_MAINTENANCE_REQUIRED';intentSha256=$intentSha256;evidenceSha256=$evidenceHash;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;originalSchemaPreserved=$true;partialTargetPossible=$false;productionDatabaseRestored=$true;completedAt=[datetimeoffset]::UtcNow.ToString('o')})
    Assert-RestoreDeadline -Finalization
    [pscustomobject]@{Result='RESTORED_PENDING_LEGACY_RESTART';EvidenceSha256=$evidenceHash;RollbackJournalSha256=(Hash $RollbackJournalPath 1048576);PreRollbackSchemaPreserved=$true;MaintenanceRetained=$true;LegacyWritersRetainedQuiesced=$true} | ConvertTo-Json
    exit 0
  } catch {
    $failureCode = if ($_.Exception.Message -match '^[A-Z0-9_]{3,160}$') { $_.Exception.Message } else { 'ROLLBACK_RESTORE_UNCLASSIFIED_FAILURE' }
    $originalRestored = $false
    if ($boundaryCreated) {
      try {
        $repairSql = "BEGIN; DROP SCHEMA IF EXISTS $quotedSchema CASCADE; ALTER SCHEMA $quotedPreserved RENAME TO $quotedSchema; COMMIT;"
        [void](Invoke-Bounded $psql ($base + @('--set=ON_ERROR_STOP=1',"--command=$repairSql")) $environment 'ROLLBACK_AUTOMATIC_PRESERVED_SCHEMA_RECOVERY' -Cleanup)
        $originalRestored = $true
      } catch { $originalRestored = $false }
    }
    if ($evidencePublished -and (Test-Path -LiteralPath $EvidenceOutputPath)) { Remove-Item -LiteralPath $EvidenceOutputPath -Force -ErrorAction SilentlyContinue }
    try {
      $recoveryProcedure = if ($originalRestored) { 'ORIGINAL PRE-ROLLBACK SCHEMA WAS TRANSACTIONALLY RESTORED; KEEP MAINTENANCE UNTIL A NEW APPROVED VERIFY.' } else { 'PRESERVED SCHEMA MUST NOT BE DELETED; KEEP MAINTENANCE AND QUIESCE; USE A NEW EXACT APPROVED TRANSACTIONAL REPAIR BEFORE ANY WRITER RESTART.' }
      Write-AtomicJson $RollbackJournalPath ([ordered]@{version=1;state='FAILED_MAINTENANCE_REQUIRED';intentSha256=$intentSha256;failureCode=$failureCode;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$preservedSchema;firstMutationAttempted=$boundaryCreated;originalSchemaRestored=$originalRestored;originalSchemaPreserved=($boundaryCreated -and -not $originalRestored);partialTargetPossible=($boundaryCreated -and -not $originalRestored);recoveryProcedure=$recoveryProcedure;failedAt=[datetimeoffset]::UtcNow.ToString('o')})
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
[void](Invoke-Bounded $node @($verifier,$restorePublic,$evidence,'legacy-database-rollback') @{} 'ROLLBACK_EVIDENCE_SIGNATURE_VERIFY')
$value = Read-BoundedJson $evidence 16777216 'ROLLBACK_EVIDENCE_INVALID'
$kpi = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=SET search_path TO $quotedSchema; $(KpiSql)")) $environment 'ROLLBACK_VERIFY_KPI'
$privilegeProof = Invoke-Bounded $psql ($base + @('--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$privilegeSql")) $environment 'ROLLBACK_VERIFY_RUNTIME_ROLE'
$storageDigest = TextHash (@("uploads=$(InventoryDigest ([string]$baseline.legacyUploadsRoot))","reports=$(InventoryDigest ([string]$baseline.legacyReportsRoot))") -join "`n")
if ($journalValue.version -ne 1 -or $journalValue.state -cne 'COMPLETE_MAINTENANCE_REQUIRED' -or $journalValue.intentSha256 -cne $value.rollbackIntentSha256 -or $journalValue.evidenceSha256 -cne (Hash $evidence 16777216) -or -not $journalValue.originalSchemaPreserved -or $journalValue.partialTargetPossible -or $value.version -ne 2 -or $value.result -cne 'PASS' -or $value.baselineSha256 -cne (Hash $baselinePath 16777216) -or $value.migrationJournalSha256 -cne (Hash $migrationJournal 16777216) -or $value.backupEvidenceSha256 -cne (Hash $backupEvidence 16777216) -or -not $value.productionDatabaseRestored -or -not $value.preRollbackSchemaPreserved -or -not $value.runtimeRolePrivilegesVerified -or $privilegeProof -cne 't|t|t' -or -not $value.maintenanceVerified -or -not $value.drainVerified -or -not $value.businessKpiVerified -or (TextHash $kpi) -cne $value.businessKpiDigest -or -not $value.storageHashVerified -or $storageDigest -cne $value.storageInventoryDigest -or -not $value.hardDeadlineEnforced -or -not $value.processTreeKillOnDeadline -or -not $value.allReadsAndHashesDeadlineBound -or $value.elapsedSeconds -gt $MaximumRestoreDurationSeconds) { throw 'ROLLBACK_EVIDENCE_INVALID' }
Assert-RestoreDeadline -Finalization
[pscustomobject]@{Result='PASS';SignedRollbackEvidence=$true;DurableJournalVerified=$true;ProductionDatabaseRestored=$true;PreRollbackSchemaPreserved=$true;MaintenanceRetained=$true;LegacyRestartStillSeparatelyApprovalGated=$true} | ConvertTo-Json
