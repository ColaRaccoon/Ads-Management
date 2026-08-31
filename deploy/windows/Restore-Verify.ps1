#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Run')][string]$Action = 'Plan',
  [string]$BackupDirectory,
  [string]$PgRestorePath,
  [string]$ExpectedPgRestoreSha256,
  [string]$PsqlPath,
  [string]$ExpectedPsqlSha256,
  [string]$RestoreTargetProjectRef,[ValidateSet('direct','session_pooler')][string]$RestoreConnectionMode,[string]$RestoreDatabaseHost,[int]$RestoreDatabasePort=5432,
  [string]$RestoreDatabaseName,
  [string]$RestoreDatabaseUser,
  [string]$PgPassFile,[string]$ExpectedPgPassSha256,
  [string]$RestoreCaCertificatePath,[string]$ExpectedRestoreCaCertificateSha256,
  [string]$BackupIntegrityKeyFile,[string]$ExpectedBackupIntegrityKeySha256,
  [string]$MigrationsRoot,
  [string]$ApprovedScratchRoot,
  [string]$RestoreStorageRoot,
  [string]$EvidenceOutputPath,
  [string]$VerifiedTargetDataRoot,
  [string]$VerifiedTargetFilesystemEvidencePath,
  [string]$FileSystemEvidencePath,
  [string]$ExpectedFileSystemEvidenceSha256,
  [string]$DatabaseBoundaryEvidencePath,
  [string]$ExpectedDatabaseBoundaryEvidenceSha256,
  [long]$MaximumDatabaseDumpBytes=68719476736,
  [string]$RestoreVerifierAccount,
  [string]$NodePath,[string]$ExpectedNodeSha256,
  [string]$AttestationSignerPath,
  [string]$ExpectedAttestationSignerSha256,
  [string]$RestoreReceiptPrivateKeyPath,[string]$ExpectedRestoreReceiptPrivateKeySha256,
  [ValidateSet('LOCAL_RELEASE','LEGACY_BASELINE')][string]$PreviousReleaseKind='LOCAL_RELEASE',
  [string]$PreviousReleaseRoot,[string]$TargetReleaseRoot,[string]$LegacyBaselineEvidencePath,[string]$ExpectedLegacyBaselineEvidenceSha256,
  [string]$ExpectedPreviousManifestSha256,[string]$ExpectedTargetManifestSha256,
  [string]$ReleaseVerifierPath,[string]$ExpectedReleaseVerifierSha256,
  [string]$TargetPrismaCliPath,[string]$ExpectedTargetPrismaCliSha256,[string]$TargetPrismaSchemaPath,[string]$TargetMigrationsRoot,
  [string]$PreviousApiConfigPath,[string]$ExpectedPreviousApiConfigSha256,[string]$TargetApiConfigPath,[string]$ExpectedTargetApiConfigSha256,[string]$InternalProbeTokenFile,[string]$ExpectedInternalProbeTokenSha256,
  [ValidateRange(1024,65535)][int]$CompatibilityApiPort=42991,
  [string]$CompatibilityEvidenceOutputPath,
  [ValidateSet('Run')][string]$PlannedAction,[string]$ApprovedPlanSha256,[string]$ApprovalNonce,[string]$ApprovalIssuedAt,[string]$ApprovalExpiresAt,[string]$ApprovalInstanceId,[string]$ApprovalLedgerPath,[switch]$Approved
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
$script:RestoreDeadline=$null
$script:RestoreStopwatch=$null
$script:RestoreMaximumMilliseconds=[long]0

function Assert-NotReparsePoint([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_POINT_REJECTED' }
}
function Assert-TreeHasNoReparsePoint([string]$Path) {
  Assert-NotReparsePoint -Path $Path
  foreach ($item in Get-DeadlineBoundTreeItems -Path $Path) { if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_POINT_REJECTED' } }
}
function Assert-ExistingAncestorsNoReparse([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) { Assert-NotReparsePoint -Path $current }
    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
}
function Assert-PinnedFile([string]$Path,[string]$Expected,[string]$Code){Assert-ExistingAncestorsNoReparse $Path;if($Expected-notmatch'^[A-Fa-f0-9]{64}$'-or(FileHash $Path)-ine$Expected){throw $Code}}
function UnderAny([string]$Path,[string[]]$Roots){$full=[IO.Path]::GetFullPath($Path);return @($Roots|Where-Object{$root=[IO.Path]::GetFullPath([string]$_).TrimEnd('\');$full-ieq$root-or$full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)}).Count-gt0}
function Assert-ExactKeys($Value,[string[]]$Keys,[string]$Code) {
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expected = @($Keys | Sort-Object)
  if (($actual -join "`n") -cne ($expected -join "`n")) { throw $Code }
}
function ValidatedRelativeKey([string]$Key) {
  if (-not $Key -or $Key.Length -gt 1024 -or $Key.StartsWith('/') -or $Key.StartsWith('\') -or $Key -match '(^|/)\.\.?(/|$)' -or $Key.Contains(':') -or $Key.Contains('\') -or $Key -match '[\x00-\x1f\x7f]') { throw 'STORAGE_KEY_REJECTED' }
  foreach ($segment in $Key.Split('/')) { if (-not $segment -or$segment.EndsWith('.')-or$segment.EndsWith(' ')-or$segment-match'^(?i:(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$))') { throw 'STORAGE_KEY_REJECTED' } }
  return $Key
}
function ContainedPath([string]$Root,[string]$Key) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $target = [IO.Path]::GetFullPath((Join-Path $rootFull $Key.Replace('/','\')))
  if (-not $target.StartsWith($rootFull,[StringComparison]::OrdinalIgnoreCase)) { throw 'STORAGE_KEY_ESCAPES_ROOT' }
  return $target
}
function Under([string]$Path,[string]$Root){$full=[IO.Path]::GetFullPath($Path);$boundary=[IO.Path]::GetFullPath($Root).TrimEnd('\');return $full-ieq$boundary-or$full.StartsWith($boundary+'\',[StringComparison]::OrdinalIgnoreCase)}
function Hex([byte[]]$Bytes) { return -join @($Bytes | ForEach-Object { $_.ToString('x2') }) }
function Sha256Text([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return Hex -Bytes $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)) } finally { $sha.Dispose() }
}
function HmacFile([string]$KeyFile,[string]$Value) {
  Assert-RestoreDeadline;$item=Get-Item -LiteralPath ([IO.Path]::GetFullPath($KeyFile)) -Force;if($item.Length-lt32-or$item.Length-gt4096){throw 'BACKUP_INTEGRITY_KEY_INVALID'};$key = [IO.File]::ReadAllBytes($item.FullName);Assert-RestoreDeadline
  try { $hmac = New-Object -TypeName Security.Cryptography.HMACSHA256 -ArgumentList (,$key); return Hex -Bytes $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)) }
  finally { if ($hmac) { $hmac.Dispose() }; [Array]::Clear($key,0,$key.Length) }
}
function SignatureInput($Manifest) {
  return @('6',$Manifest.backupId,$Manifest.createdAt,$Manifest.backupMode,$Manifest.sourceDataRoot,$Manifest.backupRoot,$Manifest.databaseProvider,$Manifest.databaseProjectRef,$Manifest.databaseConnectionMode,$Manifest.databaseHost,[string]$Manifest.databasePort,$Manifest.databaseName,$Manifest.databaseSchema,$Manifest.releaseId,$Manifest.databaseDumpSha256,[string]$Manifest.databaseDumpBytes,[string]$Manifest.maximumDatabaseDumpBytes,[string]$Manifest.maximumBackupDurationSeconds,[string]$Manifest.backupSafetyMarginBytes,[string]$Manifest.elapsedSeconds,[string]$Manifest.databaseSizePreflightVerified,[string]$Manifest.databaseDumpRealtimeCapEnforced,[string]$Manifest.databaseDumpFinalCapVerified,[string]$Manifest.hardDeadlineEnforced,[string]$Manifest.processTreeKillOnDeadline,[string]$Manifest.incompleteStagingCleanupContract,$Manifest.storageManifestSha256,$Manifest.storageReferenceDigest,$Manifest.storageReferenceConversionSha256,[string]$Manifest.storageReferenceCount,[string]$Manifest.storageReferenceZeroVerified,$Manifest.legacyBaselineSha256,$Manifest.legacyStorageStageEvidenceSha256,$Manifest.migrationDigest,$Manifest.appliedMigrationDigest,$Manifest.businessKpiDigest,$Manifest.targetEvidenceFingerprint,$Manifest.configFingerprint,$Manifest.fileCount,$Manifest.totalBytes,$Manifest.integrityKeyId,$Manifest.nodeSha256,$Manifest.psqlSha256,$Manifest.pgDumpSha256,$Manifest.executorSetDigest,$Manifest.filesystemEvidenceSha256,$Manifest.nasIdentityHelperSha256) -join "`n"
}
function RestoreConnectionUser(){if($RestoreConnectionMode-eq'session_pooler'){return "$RestoreDatabaseUser.$RestoreTargetProjectRef"};return $RestoreDatabaseUser}
function Assert-PgPassTarget([string]$Path){$lines=@((Read-DeadlineBoundText $Path 4096)-split"`r?`n"|Where-Object{$_-and-not$_.StartsWith('#')});if($lines.Count-ne1){throw 'RESTORE_PGPASS_FORMAT_INVALID'};$parts=[Collections.Generic.List[string]]::new();$current=New-Object Text.StringBuilder;$escaped=$false;foreach($character in $lines[0].ToCharArray()){if($escaped){$current.Append($character)|Out-Null;$escaped=$false;continue};if($character-eq'\'){$escaped=$true;continue};if($character-eq':'-and$parts.Count-lt4){$parts.Add($current.ToString());$current.Clear()|Out-Null}else{$current.Append($character)|Out-Null}};if($escaped){throw 'RESTORE_PGPASS_FORMAT_INVALID'};$parts.Add($current.ToString());if($parts.Count-ne5-or$parts[0]-cne$RestoreDatabaseHost-or$parts[1]-ne'5432'-or$parts[2]-cne$RestoreDatabaseName-or$parts[3]-cne(RestoreConnectionUser)-or-not$parts[4]){throw 'RESTORE_PGPASS_TARGET_INVALID'};return $parts[4]}
function DbArgs([string]$Sql){return @("--host=$RestoreDatabaseHost","--port=$RestoreDatabasePort","--username=$(RestoreConnectionUser)","--dbname=$RestoreDatabaseName",'--no-password','--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$Sql")}
function Remaining-Milliseconds([int]$LocalMaximum){
  if(-not$script:RestoreStopwatch){return $LocalMaximum}
  $remaining=[long]$script:RestoreMaximumMilliseconds-$script:RestoreStopwatch.ElapsedMilliseconds
  if($script:RestoreDeadline){$remaining=[Math]::Min($remaining,[long][Math]::Floor(($script:RestoreDeadline-(Get-Date)).TotalMilliseconds))}
  if($remaining-le0){throw 'RESTORE_RTO_DEADLINE_EXCEEDED'}
  return [int][Math]::Min([long]$LocalMaximum,$remaining)
}
function Assert-RestoreDeadline {[void](Remaining-Milliseconds 2147483647)}
function Get-DeadlineBoundTreeItems([string]$Path,[switch]$FilesOnly,[string]$Filter,[switch]$TopLevelOnly) {
  $root=[IO.DirectoryInfo]::new([IO.Path]::GetFullPath($Path));$pending=[Collections.Generic.Stack[IO.DirectoryInfo]]::new();$pending.Push($root);$items=[Collections.Generic.List[IO.FileSystemInfo]]::new()
  while($pending.Count){Assert-RestoreDeadline;$directory=$pending.Pop();$children=$directory.GetFileSystemInfos();Assert-RestoreDeadline;foreach($child in $children){Assert-RestoreDeadline;if(($child.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'REPARSE_POINT_REJECTED'};if($child-is[IO.DirectoryInfo]){if(-not$TopLevelOnly){$pending.Push($child)};if(-not$FilesOnly){$items.Add($child)}}elseif(-not$Filter-or$child.Name-ceq$Filter){$items.Add($child)}};if($TopLevelOnly){break}}
  return @($items|Sort-Object FullName)
}
function Remove-DeadlineBoundPath([string]$Path,[switch]$CleanupWindow) {
  if(-not(Test-Path -LiteralPath $Path)){return}
  $savedDeadline=$script:RestoreDeadline;$savedStopwatch=$script:RestoreStopwatch;$savedMaximum=$script:RestoreMaximumMilliseconds
  try{
    if($CleanupWindow){$script:RestoreDeadline=(Get-Date).AddMinutes(2);$script:RestoreStopwatch=[Diagnostics.Stopwatch]::StartNew();$script:RestoreMaximumMilliseconds=120000}
    Assert-RestoreDeadline;$root=Get-Item -LiteralPath $Path -Force
    if(-not$root.PSIsContainer){$root.Delete();Assert-RestoreDeadline;return}
    $items=@(Get-DeadlineBoundTreeItems -Path $root.FullName|Sort-Object {$_.FullName.Length} -Descending)
    foreach($item in $items){Assert-RestoreDeadline;if($item-is[IO.DirectoryInfo]){$item.Delete($false)}else{$item.Delete()};Assert-RestoreDeadline}
    $root.Delete($false);Assert-RestoreDeadline
  }finally{if($CleanupWindow){$script:RestoreDeadline=$savedDeadline;$script:RestoreStopwatch=$savedStopwatch;$script:RestoreMaximumMilliseconds=$savedMaximum}}
}
function Start-DeadlineBoundCapture($Process) {
  $stdoutBuffer=New-Object char[] 4096;$stderrBuffer=New-Object char[] 4096
  return [pscustomobject]@{Process=$Process;Stdout=$([Text.StringBuilder]::new());Stderr=$([Text.StringBuilder]::new());StdoutBuffer=$stdoutBuffer;StderrBuffer=$stderrBuffer;StdoutTask=$($Process.StandardOutput.ReadAsync($stdoutBuffer,0,$stdoutBuffer.Length));StderrTask=$($Process.StandardError.ReadAsync($stderrBuffer,0,$stderrBuffer.Length));StdoutDone=$false;StderrDone=$false}
}
function Pump-DeadlineBoundCapture($State,[int]$MaximumOutputChars,[string]$Code) {
  foreach($name in @('Stdout','Stderr')){$doneName=$name+'Done';if($State.$doneName){continue};$taskName=$name+'Task';$bufferName=$name+'Buffer';$task=$State.$taskName;if($task.IsCompleted){try{$count=$task.GetAwaiter().GetResult()}catch{throw "$Code`_OUTPUT_READ_FAILED"};if($count-eq0){$State.$doneName=$true;continue};if(($State.Stdout.Length+$State.Stderr.Length+$count)-gt$MaximumOutputChars){throw "$Code`_OUTPUT_LIMIT"};[void]$State.$name.Append($State.$bufferName,0,$count);$stream=if($name-eq'Stdout'){$State.Process.StandardOutput}else{$State.Process.StandardError};$State.$taskName=$stream.ReadAsync($State.$bufferName,0,$State.$bufferName.Length)}}
}
function Stop-RestoreProcessTree($Process) {if($Process-and-not$Process.HasExited){try{$Process.Kill($true)}catch{throw 'RESTORE_PROCESS_TREE_KILL_FAILED'};if(-not$Process.WaitForExit(5000)){throw 'RESTORE_PROCESS_TREE_CLEANUP_TIMEOUT'}}}
function Wait-DeadlineBoundStartedProcess($Process,[int]$MaximumMilliseconds,[int]$MaximumOutputChars,[string]$Code) {
  $capture=Start-DeadlineBoundCapture $Process;$localClock=[Diagnostics.Stopwatch]::StartNew()
  while(-not$Process.HasExited){Assert-RestoreDeadline;Pump-DeadlineBoundCapture $capture $MaximumOutputChars $Code;if($localClock.ElapsedMilliseconds-ge$MaximumMilliseconds){Stop-RestoreProcessTree $Process;throw "$Code`_TIMEOUT"};Start-Sleep -Milliseconds 10}
  $drainClock=[Diagnostics.Stopwatch]::StartNew();while(-not($capture.StdoutDone-and$capture.StderrDone)){Assert-RestoreDeadline;Pump-DeadlineBoundCapture $capture $MaximumOutputChars $Code;if($drainClock.ElapsedMilliseconds-ge2000){throw "$Code`_OUTPUT_DRAIN_TIMEOUT"};Start-Sleep -Milliseconds 10}
  if($Process.ExitCode-ne0){throw $Code};return [pscustomobject]@{Output=$($capture.Stdout.ToString());Error=$($capture.Stderr.ToString());ExitCode=$Process.ExitCode}
}
function Invoke-BoundedProcess([string]$File,[string[]]$Arguments,[int]$MaximumMilliseconds,[int]$MaximumOutputChars=8388608,[string]$Code='RESTORE_PROCESS_FAILED'){
  $executable=[IO.Path]::GetFullPath($File);if($executable-ieq[IO.Path]::GetFullPath($NodePath)){Assert-PinnedFile $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH'}elseif($executable-ieq[IO.Path]::GetFullPath($PsqlPath)){Assert-PinnedFile $PsqlPath $ExpectedPsqlSha256 'PSQL_HASH_MISMATCH'}elseif($executable-ieq[IO.Path]::GetFullPath($PgRestorePath)){Assert-PinnedFile $PgRestorePath $ExpectedPgRestoreSha256 'PG_RESTORE_HASH_MISMATCH'}else{throw 'UNPINNED_RESTORE_EXECUTABLE_REJECTED'}
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=[IO.Path]::GetFullPath($File);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;foreach($argument in $Arguments){$info.ArgumentList.Add($argument)}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$startedProcess=$false
  try{
    if(-not$process.Start()){throw $Code};$startedProcess=$true;return Wait-DeadlineBoundStartedProcess $process $MaximumMilliseconds $MaximumOutputChars $Code
  }finally{if($startedProcess){Stop-RestoreProcessTree $process};$process.Dispose()}
}
function Invoke-Db([string]$Sql){$arguments=DbArgs $Sql;$run=Invoke-BoundedProcess $PsqlPath $arguments 120000 8388608 'RESTORE_DATABASE_QUERY_FAILED';return ([string]$run.Output).Trim()}
function Set-IsolatedRuntimePrivileges([string]$Schema,[string]$RuntimeRole) {
  $quotedSchema='"'+$Schema.Replace('"','""')+'"';$quotedRole='"'+$RuntimeRole.Replace('"','""')+'"';$roleLiteral=$RuntimeRole.Replace("'","''");$schemaLiteral=$Schema.Replace("'","''")
  Invoke-Db ("REVOKE CREATE ON SCHEMA $quotedSchema FROM $quotedRole; GRANT USAGE ON SCHEMA $quotedSchema TO $quotedRole; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA $quotedSchema TO $quotedRole; REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA $quotedSchema FROM $quotedRole; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA $quotedSchema TO $quotedRole; REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA $quotedSchema FROM $quotedRole; REVOKE ALL PRIVILEGES ON TABLE $quotedSchema.""_prisma_migrations"" FROM $quotedRole")|Out-Null
  $proof=Invoke-Db @"
WITH app_tables AS (
  SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS relation_name
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='$schemaLiteral' AND c.relkind IN ('r','p') AND c.relname<>'_prisma_migrations'
), app_sequences AS (
  SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS relation_name
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='$schemaLiteral' AND c.relkind='S'
)
SELECT concat_ws('|',
  has_schema_privilege('$roleLiteral','$schemaLiteral','USAGE'),
  NOT has_schema_privilege('$roleLiteral','$schemaLiteral','CREATE'),
  COALESCE((SELECT bool_and(has_table_privilege('$roleLiteral',relation_name,'SELECT')) FROM app_tables),false),
  COALESCE((SELECT bool_and(has_table_privilege('$roleLiteral',relation_name,'INSERT')) FROM app_tables),false),
  COALESCE((SELECT bool_and(has_table_privilege('$roleLiteral',relation_name,'UPDATE')) FROM app_tables),false),
  COALESCE((SELECT bool_and(has_table_privilege('$roleLiteral',relation_name,'DELETE')) FROM app_tables),false),
  COALESCE((SELECT bool_and(NOT has_table_privilege('$roleLiteral',relation_name,'TRUNCATE')) FROM app_tables),false),
  COALESCE((SELECT bool_and(NOT has_table_privilege('$roleLiteral',relation_name,'REFERENCES')) FROM app_tables),false),
  COALESCE((SELECT bool_and(NOT has_table_privilege('$roleLiteral',relation_name,'TRIGGER')) FROM app_tables),false),
  NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='$schemaLiteral' AND c.relname='_prisma_migrations' AND (has_table_privilege('$roleLiteral',c.oid,'SELECT') OR has_table_privilege('$roleLiteral',c.oid,'INSERT') OR has_table_privilege('$roleLiteral',c.oid,'UPDATE') OR has_table_privilege('$roleLiteral',c.oid,'DELETE') OR has_table_privilege('$roleLiteral',c.oid,'TRUNCATE') OR has_table_privilege('$roleLiteral',c.oid,'REFERENCES') OR has_table_privilege('$roleLiteral',c.oid,'TRIGGER'))),
  COALESCE((SELECT bool_and(has_sequence_privilege('$roleLiteral',relation_name,'USAGE')) FROM app_sequences),false),
  COALESCE((SELECT bool_and(has_sequence_privilege('$roleLiteral',relation_name,'SELECT')) FROM app_sequences),false),
  COALESCE((SELECT bool_and(NOT has_sequence_privilege('$roleLiteral',relation_name,'UPDATE')) FROM app_sequences),false)
)
"@
  if($proof-cne't|t|t|t|t|t|t|t|t|t|t|t|t'){throw 'ISOLATED_RUNTIME_PRIVILEGE_CONTRACT_FAILED'}
}
function Invoke-CleanupDb([string]$Sql){
  $primaryDeadline=$script:RestoreDeadline;$primaryStopwatch=$script:RestoreStopwatch;$primaryMaximum=$script:RestoreMaximumMilliseconds
  try{$script:RestoreDeadline=(Get-Date).AddMinutes(2);$script:RestoreStopwatch=[Diagnostics.Stopwatch]::StartNew();$script:RestoreMaximumMilliseconds=120000;return Invoke-Db $Sql}
  finally{$script:RestoreDeadline=$primaryDeadline;$script:RestoreStopwatch=$primaryStopwatch;$script:RestoreMaximumMilliseconds=$primaryMaximum}
}
function Write-Utf8NoBom([string]$Path,[string]$Value) {
  Assert-RestoreDeadline;$encoding=New-Object Text.UTF8Encoding($false);$stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$writer=[IO.StreamWriter]::new($stream,$encoding,65536,$false)
  try{for($offset=0;$offset-lt$Value.Length;$offset+=65536){Assert-RestoreDeadline;$count=[Math]::Min(65536,$Value.Length-$offset);$writer.Write($Value.ToCharArray($offset,$count));Assert-RestoreDeadline};$writer.Flush();$stream.Flush($true);Assert-RestoreDeadline}finally{$writer.Dispose()}
}
function Read-DeadlineBoundText([string]$Path,[long]$MaximumBytes=1048576) {
  Assert-RestoreDeadline;$item=Get-Item -LiteralPath $Path -Force;if($item.PSIsContainer-or$item.Length-lt0-or$item.Length-gt$MaximumBytes-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'RESTORE_TEXT_INPUT_INVALID'}
  $stream=[IO.File]::Open($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$true,65536,$false);$builder=[Text.StringBuilder]::new()
  try{$buffer=New-Object char[] 65536;while(($read=$reader.Read($buffer,0,$buffer.Length))-gt0){Assert-RestoreDeadline;if($builder.Length+$read-gt$MaximumBytes){throw 'RESTORE_TEXT_INPUT_LIMIT_EXCEEDED'};[void]$builder.Append($buffer,0,$read)};Assert-RestoreDeadline;return $($builder.ToString())}finally{$reader.Dispose()}
}
function FileHash([string]$Path,[long]$MaximumBytes=[long]::MaxValue){
  Assert-RestoreDeadline;$item=Get-Item -LiteralPath $Path -Force;if($item.PSIsContainer-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0-or$item.Length-gt$MaximumBytes){throw 'RESTORE_HASH_SOURCE_INVALID'}
  $stream=[IO.File]::Open($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$sha=[Security.Cryptography.SHA256]::Create()
  try{$buffer=New-Object byte[] 1048576;[long]$total=0;while(($read=$stream.Read($buffer,0,$buffer.Length))-gt0){Assert-RestoreDeadline;$total+=$read;if($total-gt$MaximumBytes){throw 'RESTORE_HASH_LIMIT_EXCEEDED'};[void]$sha.TransformBlock($buffer,0,$read,$null,0)};[void]$sha.TransformFinalBlock([byte[]]::new(0),0,0);Assert-RestoreDeadline;return Hex $sha.Hash}finally{$sha.Dispose();$stream.Dispose()}
}
function Copy-BoundedFile([string]$Source,[string]$Destination,[long]$MaximumBytes,[long]$ExpectedBytes=-1) {
  Assert-ExistingAncestorsNoReparse $Source
  $item=Get-Item -LiteralPath $Source -Force
  if(-not$item.PSIsContainer-and($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-eq0-and$item.Length-ge0-and$item.Length-le$MaximumBytes-and($ExpectedBytes-lt0-or$item.Length-eq$ExpectedBytes)){
    $parent=Split-Path -Parent $Destination;New-Item -ItemType Directory -Path $parent -Force|Out-Null;Assert-ExistingAncestorsNoReparse $parent
    $input=[IO.File]::Open($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{$output=[IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$buffer=New-Object byte[] 1048576;$copied=[long]0;while(($read=$input.Read($buffer,0,$buffer.Length))-gt0){Assert-RestoreDeadline;$copied+=$read;if($copied-gt$MaximumBytes){throw 'BOUNDED_COPY_LIMIT_EXCEEDED'};$output.Write($buffer,0,$read);Assert-RestoreDeadline};$output.Flush($true);Assert-RestoreDeadline;if($ExpectedBytes-ge0-and$copied-ne$ExpectedBytes){throw 'BOUNDED_COPY_LENGTH_CHANGED'}}finally{if($output){$output.Dispose()}}}finally{$input.Dispose()}
    Assert-NotReparsePoint $Destination;return
  }
  throw 'BOUNDED_COPY_SOURCE_INVALID'
}
function Read-EnvMap([string]$Path){$item=Get-Item -LiteralPath $Path -Force;if($item.Length-lt1-or$item.Length-gt1048576){throw 'COMPATIBILITY_API_CONFIG_SIZE_INVALID'};$map=@{};foreach($line in (Read-DeadlineBoundText $item.FullName 1048576)-split"`r?`n"){if(-not$line-or$line.TrimStart().StartsWith('#')){continue};if($line-notmatch'^([A-Z][A-Z0-9_]*)=(.*)$'-or$map.ContainsKey($Matches[1])){throw 'COMPATIBILITY_API_CONFIG_PARSE_FAILED'};$value=$Matches[2].Trim();if($value.Length-ge2-and(($value[0]-eq'"'-and$value[-1]-eq'"')-or($value[0]-eq"'"-and$value[-1]-eq"'"))){$value=$value.Substring(1,$value.Length-2)};$map[$Matches[1]]=$value};return $map}
function Assert-IsolatedApiConfig([string]$Path,$Manifest,$Boundary,[string]$RestoreDataRoot){
  $envMap=Read-EnvMap $Path;try{$uri=[Uri]$envMap.DATABASE_URL}catch{throw 'COMPATIBILITY_API_DATABASE_URL_INVALID'}
  $query=@{};foreach($part in $uri.Query.TrimStart('?').Split('&',[StringSplitOptions]::RemoveEmptyEntries)){if($part-notmatch'^([^=]+)=(.*)$'-or$query.ContainsKey($Matches[1])){throw 'COMPATIBILITY_API_DATABASE_QUERY_INVALID'};$query[[Uri]::UnescapeDataString($Matches[1])]=[Uri]::UnescapeDataString($Matches[2])}
  $expectedUser=if($RestoreConnectionMode-eq'session_pooler'){"$([string]$Boundary.databaseUser).$RestoreTargetProjectRef"}else{[string]$Boundary.databaseUser};$actualUser=[Uri]::UnescapeDataString($uri.UserInfo.Split(':',2)[0])
  if($envMap.APP_ENV-cne'production'-or$envMap.DEPLOYMENT_MODE-cne'local_lan'-or$envMap.AUTH_PROVIDER-cne'local'-or$envMap.STORAGE_PROVIDER-cne'local'-or$envMap.SUPABASE_DATABASE_PROJECT_REF-cne$RestoreTargetProjectRef-or$envMap.SUPABASE_DATABASE_CONNECTION_MODE-cne$RestoreConnectionMode-or$envMap.SUPABASE_DATABASE_HOST-cne$RestoreDatabaseHost-or$envMap.SUPABASE_DATABASE_RUNTIME_USER-cne[string]$Boundary.databaseUser-or$uri.Scheme-cne'postgresql'-or$uri.Host-cne$RestoreDatabaseHost-or$uri.Port-ne5432-or$uri.AbsolutePath.TrimStart('/')-cne$RestoreDatabaseName-or$actualUser-cne$expectedUser-or$query.schema-cne[string]$Manifest.databaseSchema-or$query.sslmode-cne'verify-full'-or[IO.Path]::GetFullPath($query.sslrootcert)-ine[IO.Path]::GetFullPath($RestoreCaCertificatePath)-or[IO.Path]::GetFullPath($envMap.SUPABASE_DATABASE_CA_CERT_PATH)-ine[IO.Path]::GetFullPath($RestoreCaCertificatePath)-or[IO.Path]::GetFullPath($envMap.APP_DATA_ROOT)-ine$RestoreDataRoot-or[IO.Path]::GetFullPath($envMap.UPLOAD_STORAGE_DIR)-ine(Join-Path $RestoreDataRoot 'storage\uploads')-or[IO.Path]::GetFullPath($envMap.REPORT_STORAGE_DIR)-ine(Join-Path $RestoreDataRoot 'storage\reports')){throw 'COMPATIBILITY_API_CONFIG_NOT_BOUND_TO_ISOLATED_RESTORE'}
}
function Probe-Api([int]$Port,[string]$Target,[string]$Expected,[string]$Release,[string]$Token){$timeout=Remaining-Milliseconds 2000;try{$request=[Net.HttpWebRequest]::Create("http://127.0.0.1:$Port$Target");$request.Proxy=$null;$request.Timeout=$timeout;$request.ReadWriteTimeout=$timeout;if($Token){$request.Headers.Add('x-internal-probe-token',$Token)};$response=$request.GetResponse();try{$reader=New-Object IO.StreamReader($response.GetResponseStream());$buffer=New-Object char[] 1024;$builder=[Text.StringBuilder]::new();while(($read=$reader.Read($buffer,0,$buffer.Length))-gt0){Assert-RestoreDeadline;if($builder.Length+$read-gt4096){return $false};[void]$builder.Append($buffer,0,$read)};$value=$builder.ToString()|ConvertFrom-Json;return [int]$response.StatusCode-eq200-and$value.status-eq$Expected-and(-not$Release-or$value.releaseId-eq$Release)}finally{$response.Dispose()}}catch{return $false}}
function Invoke-ApiSmoke([string]$ReleaseRoot,[string]$ReleaseId,[string]$ApiConfig,[string]$Token,[string]$Label){
  Assert-PinnedFile $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH'
  if(Get-NetTCPConnection -LocalPort $CompatibilityApiPort -State Listen -ErrorAction SilentlyContinue){throw 'COMPATIBILITY_API_PORT_IN_USE'}
  $entry=Join-Path $ReleaseRoot 'api\dist\main.js';if(-not(Test-Path -LiteralPath $entry -PathType Leaf)){throw 'COMPATIBILITY_API_ENTRYPOINT_MISSING'}
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=[IO.Path]::GetFullPath($NodePath);$info.WorkingDirectory=[IO.Path]::GetFullPath($ReleaseRoot);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.ArgumentList.Add($entry)
  $info.Environment.Clear();foreach($name in @('SystemRoot','WINDIR','TEMP','TMP','PATH','PATHEXT')){if([Environment]::GetEnvironmentVariable($name)){$info.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}}
  $info.Environment['CONFIG_PATH']=[IO.Path]::GetFullPath($ApiConfig);$info.Environment['PORT']=[string]$CompatibilityApiPort;$info.Environment['NODE_ENV']='production';$info.Environment['APP_ENV']='production';$info.Environment['DEPLOYMENT_MODE']='local_lan';$info.Environment['LOCAL_RELEASE_ID']=$ReleaseId
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$startedProcess=$false
  try{
    if(-not$process.Start()){throw 'COMPATIBILITY_API_START_FAILED'};$startedProcess=$true
    $capture=Start-DeadlineBoundCapture $process;$probeClock=[Diagnostics.Stopwatch]::StartNew();$pass=$false
    do{Assert-RestoreDeadline;Pump-DeadlineBoundCapture $capture 1048576 'COMPATIBILITY_API';if($process.HasExited){break};if((Probe-Api $CompatibilityApiPort '/api/health/live' 'live' $ReleaseId $null)-and(Probe-Api $CompatibilityApiPort '/api/health/ready' 'ready' $null $Token)){$pass=$true;break};Start-Sleep -Milliseconds 250}while($probeClock.ElapsedMilliseconds-lt90000)
    Stop-RestoreProcessTree $process;$drainClock=[Diagnostics.Stopwatch]::StartNew();while(-not($capture.StdoutDone-and$capture.StderrDone)){Assert-RestoreDeadline;Pump-DeadlineBoundCapture $capture 1048576 'COMPATIBILITY_API';if($drainClock.ElapsedMilliseconds-ge2000){throw 'COMPATIBILITY_API_OUTPUT_DRAIN_TIMEOUT'};Start-Sleep -Milliseconds 10};$out=$capture.Stdout.ToString();$err=$capture.Stderr.ToString()
    $digest=Sha256Text ((Sha256Text $out)+"`n"+(Sha256Text $err));if(-not$pass){throw 'COMPATIBILITY_API_SMOKE_FAILED'};return $digest
  }finally{if($startedProcess){Stop-RestoreProcessTree $process};$process.Dispose()}
}
function Invoke-BusinessSmoke([string]$ReleaseRoot,[string]$ReleaseId,[string]$ApiConfig,[string]$From,[string]$To){
  Assert-PinnedFile $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH'
  $entry=Join-Path $ReleaseRoot 'api\dist\staging\business-compatibility-smoke.cli.js';if(-not(Test-Path -LiteralPath $entry -PathType Leaf)){throw 'BUSINESS_COMPATIBILITY_ENTRYPOINT_MISSING'}
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=[IO.Path]::GetFullPath($NodePath);$info.WorkingDirectory=[IO.Path]::GetFullPath($ReleaseRoot);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.ArgumentList.Add($entry)
  $info.Environment.Clear();foreach($name in @('SystemRoot','WINDIR','TEMP','TMP','PATH','PATHEXT')){if([Environment]::GetEnvironmentVariable($name)){$info.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}}
  $info.Environment['CONFIG_PATH']=[IO.Path]::GetFullPath($ApiConfig);$info.Environment['NODE_ENV']='production';$info.Environment['APP_ENV']='production';$info.Environment['DEPLOYMENT_MODE']='local_lan';$info.Environment['LOCAL_RELEASE_ID']=$ReleaseId;$info.Environment['COMPATIBILITY_SMOKE_FROM']=$From;$info.Environment['COMPATIBILITY_SMOKE_TO']=$To
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$startedProcess=$false
  try{if(-not$process.Start()){throw 'BUSINESS_COMPATIBILITY_START_FAILED'};$startedProcess=$true;$run=Wait-DeadlineBoundStartedProcess $process 300000 8192 'BUSINESS_COMPATIBILITY_FAILED';$out=[string]$run.Output;if($out.Length-gt4096){throw 'BUSINESS_COMPATIBILITY_FAILED'};$value=$out.Trim()|ConvertFrom-Json;if($value.event-ne'business-compatibility-smoke'-or$value.releaseId-cne$ReleaseId-or$value.contractVersion-ne2-or$value.digest-notmatch'^[0-9a-f]{64}$'-or-not$value.outputCapsVerified-or$value.canonicalBytes-lt2-or$value.canonicalBytes-gt67108864-or$value.arrayItems-lt0-or$value.arrayItems-gt100000-or(@($value.services)-join'|')-cne'HealthService|MetricsService|SalesMetricsService|CoupangService|Cafe24UploadsService'){throw 'BUSINESS_COMPATIBILITY_RESULT_INVALID'};return [string]$value.digest}
  finally{if($startedProcess){Stop-RestoreProcessTree $process};$process.Dispose()}
}
function Invoke-MutationSmoke([string]$ReleaseRoot,[string]$ReleaseId,[string]$ApiConfig){
  Assert-PinnedFile $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH'
  $entry=Join-Path $ReleaseRoot 'api\dist\staging\mutation-compatibility-smoke.cli.js';if(-not(Test-Path -LiteralPath $entry -PathType Leaf)){throw 'MUTATION_COMPATIBILITY_ENTRYPOINT_MISSING'}
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=[IO.Path]::GetFullPath($NodePath);$info.WorkingDirectory=[IO.Path]::GetFullPath($ReleaseRoot);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.ArgumentList.Add($entry)
  $info.Environment.Clear();foreach($name in @('SystemRoot','WINDIR','TEMP','TMP','PATH','PATHEXT')){if([Environment]::GetEnvironmentVariable($name)){$info.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}}
  $info.Environment['CONFIG_PATH']=[IO.Path]::GetFullPath($ApiConfig);$info.Environment['NODE_ENV']='production';$info.Environment['APP_ENV']='production';$info.Environment['DEPLOYMENT_MODE']='local_lan';$info.Environment['LOCAL_RELEASE_ID']=$ReleaseId
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$startedProcess=$false
  try{if(-not$process.Start()){throw 'MUTATION_COMPATIBILITY_START_FAILED'};$startedProcess=$true;$run=Wait-DeadlineBoundStartedProcess $process 300000 8192 'MUTATION_COMPATIBILITY_FAILED';$out=[string]$run.Output;if($out.Length-gt4096){throw 'MUTATION_COMPATIBILITY_FAILED'};$value=$out.Trim()|ConvertFrom-Json;$expectedFlows='MetaAdsetImportService.importMetaAdsetCsv:duplicate-replay|MappingsService.createProductRule+rematchCurrentMetrics|Cafe24UploadsService.import+rematch+deleteUpload|CoupangService.importSales+rematch+deleteUpload|CoupangService.replaceManualPurchasesForDate|DecisionsService.run|ReportsService.export+download:hash-verified|UploadLifecycleService.deleteUpload+StorageTombstoneService.restore:hash-verified';if($value.event-ne'mutation-compatibility-smoke'-or$value.releaseId-cne$ReleaseId-or$value.contractVersion-ne2-or$value.digest-notmatch'^[0-9a-f]{64}$'-or$value.flowCount-ne8-or(@($value.flows)-join'|')-cne$expectedFlows-or$value.databaseMutations-ne8-or$value.storageMutations-ne6-or-not$value.rollbackVerified-or-not$value.storageHashVerified){throw 'MUTATION_COMPATIBILITY_RESULT_INVALID'};return [string]$value.digest}
  finally{if($startedProcess){Stop-RestoreProcessTree $process};$process.Dispose()}
}
function Invoke-TargetLegacyDataProjectionSmoke([string]$ReleaseRoot,[string]$ReleaseId,[string]$ApiConfig,[string]$From,[string]$To){
  Assert-PinnedFile $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH'
  $entry=Join-Path $ReleaseRoot 'api\dist\staging\legacy-business-compatibility-smoke.cli.js';if(-not(Test-Path -LiteralPath $entry -PathType Leaf)){throw 'LEGACY_BUSINESS_COMPATIBILITY_ENTRYPOINT_MISSING'}
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=[IO.Path]::GetFullPath($NodePath);$info.WorkingDirectory=[IO.Path]::GetFullPath($ReleaseRoot);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.ArgumentList.Add($entry)
  $info.Environment.Clear();foreach($name in @('SystemRoot','WINDIR','TEMP','TMP','PATH','PATHEXT')){if([Environment]::GetEnvironmentVariable($name)){$info.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}}
  $info.Environment['CONFIG_PATH']=[IO.Path]::GetFullPath($ApiConfig);$info.Environment['NODE_ENV']='production';$info.Environment['APP_ENV']='production';$info.Environment['DEPLOYMENT_MODE']='local_lan';$info.Environment['LOCAL_RELEASE_ID']=$ReleaseId;$info.Environment['COMPATIBILITY_SMOKE_FROM']=$From;$info.Environment['COMPATIBILITY_SMOKE_TO']=$To
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$startedProcess=$false
  try{if(-not$process.Start()){throw 'LEGACY_BUSINESS_COMPATIBILITY_START_FAILED'};$startedProcess=$true;$run=Wait-DeadlineBoundStartedProcess $process 300000 8192 'LEGACY_BUSINESS_COMPATIBILITY_FAILED';$out=[string]$run.Output;if($out.Length-gt4096){throw 'LEGACY_BUSINESS_COMPATIBILITY_FAILED'};$value=$out.Trim()|ConvertFrom-Json;if($value.event-ne'legacy-business-compatibility-smoke'-or$value.releaseId-cne$ReleaseId-or$value.contractVersion-ne2-or$value.digest-notmatch'^[0-9a-f]{64}$'-or-not$value.outputCapsVerified-or$value.canonicalBytes-lt2-or$value.canonicalBytes-gt67108864-or$value.arrayItems-lt0-or$value.arrayItems-gt100000-or(@($value.services)-join'|')-cne'MetricsService|SalesMetricsService|CoupangService|Cafe24UploadsService'-or$value.authCalled-or$value.storageCalled){throw 'LEGACY_BUSINESS_COMPATIBILITY_RESULT_INVALID'};return [string]$value.digest}
  finally{if($startedProcess){Stop-RestoreProcessTree $process};$process.Dispose()}
}
function Invoke-RoleMatrixSmoke([string]$ReleaseRoot,[string]$ReleaseId){
  Assert-PinnedFile $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH'
  $entry=Join-Path $ReleaseRoot 'api\dist\staging\auth-role-matrix-smoke.cli.js';if(-not(Test-Path -LiteralPath $entry -PathType Leaf)){throw 'ROLE_MATRIX_ENTRYPOINT_MISSING'}
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=[IO.Path]::GetFullPath($NodePath);$info.WorkingDirectory=[IO.Path]::GetFullPath($ReleaseRoot);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.ArgumentList.Add($entry);$info.Environment.Clear();foreach($name in @('SystemRoot','WINDIR','TEMP','TMP','PATH','PATHEXT')){if([Environment]::GetEnvironmentVariable($name)){$info.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}};$info.Environment['NODE_ENV']='production';$info.Environment['LOCAL_RELEASE_ID']=$ReleaseId
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$startedProcess=$false
  try{if(-not$process.Start()){throw 'ROLE_MATRIX_START_FAILED'};$startedProcess=$true;$run=Wait-DeadlineBoundStartedProcess $process 120000 8192 'ROLE_MATRIX_FAILED';$out=[string]$run.Output;if($out.Length-gt4096){throw 'ROLE_MATRIX_FAILED'};$value=$out.Trim()|ConvertFrom-Json;if($value.event-ne'auth-role-matrix-smoke'-or$value.releaseId-cne$ReleaseId-or$value.digest-notmatch'^[0-9a-f]{64}$'-or$value.routeInventoryDigest-notmatch'^[0-9a-f]{64}$'-or$value.fullMatrixDigest-notmatch'^[0-9a-f]{64}$'-or$value.httpMatrixDigest-notmatch'^[0-9a-f]{64}$'-or$value.roles-ne7-or$value.routes-ne121-or$value.httpRoutes-ne10-or$value.permissionClasses-ne10-or$value.blockedHandlerInvocations-ne500-or$value.deniedServiceInvocations-ne0){throw 'ROLE_MATRIX_RESULT_INVALID'};return [string]$value.digest}
  finally{if($startedProcess){Stop-RestoreProcessTree $process};$process.Dispose()}
}
function BusinessKpiSql { return "SELECT concat_ws('|',(SELECT count(*) FROM meta_adset_daily_metrics WHERE is_current),(SELECT coalesce(sum(spend_usd),0)::text FROM meta_adset_daily_metrics WHERE is_current),(SELECT coalesce(sum(result_count),0)::text FROM meta_adset_daily_metrics WHERE is_current),(SELECT count(*) FROM meta_ad_daily_metrics WHERE is_current),(SELECT coalesce(sum(purchase_count),0)::text FROM meta_ad_daily_metrics WHERE is_current),(SELECT count(*) FROM cafe24_order_lines WHERE is_current),(SELECT coalesce(sum(total_paid_krw),0)::text FROM cafe24_order_lines WHERE is_current),(SELECT count(*) FROM coupang_sale_lines WHERE is_current),(SELECT coalesce(sum(net_sales_krw),0)::text FROM coupang_sale_lines WHERE is_current),(SELECT count(*) FROM coupang_ad_metrics WHERE is_current),(SELECT coalesce(sum(ad_spend_krw),0)::text FROM coupang_ad_metrics WHERE is_current),(SELECT coalesce(sum(total_orders_1d),0)::text FROM coupang_ad_metrics WHERE is_current),(SELECT count(*) FROM coupang_manual_purchases),(SELECT coalesce(sum(quantity),0)::text FROM coupang_manual_purchases),(SELECT coalesce(sum(sales_amount_krw),0)::text FROM coupang_manual_purchases),(SELECT coalesce(sum(total_cost_krw),0)::text FROM coupang_manual_purchases),(SELECT count(*) FROM decision_logs),(SELECT count(*) FROM change_logs),(SELECT count(*) FROM report_exports))" }
function AppliedMigrationSql { return 'SELECT coalesce(string_agg(migration_name || ''='' || checksum, E''\n'' ORDER BY migration_name),'''') FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' }
function StorageTransitionSql { return "SELECT CASE WHEN EXISTS (SELECT 1 FROM storage_tombstones WHERE state::text IN ('PENDING','FAILED')) OR EXISTS (SELECT 1 FROM report_exports WHERE status::text = 'CREATING') THEN 'UNSTABLE' ELSE 'PASS' END" }
function New-RestoreApprovalPlan([string]$IntendedAction) {
  if($IntendedAction-cne'Run'){throw 'RESTORE_PLAN_ACTION_REQUIRED'}
  $p=[ordered]@{
    backupDirectory=Get-ApprovalPath $BackupDirectory 'RESTORE_PLAN_BACKUP_DIRECTORY_REQUIRED'
    pgRestorePath=Get-ApprovalPath $PgRestorePath 'RESTORE_PLAN_PG_RESTORE_PATH_REQUIRED';pgRestoreSha256=Get-ApprovalHash $ExpectedPgRestoreSha256 'RESTORE_PLAN_PG_RESTORE_HASH_REQUIRED'
    psqlPath=Get-ApprovalPath $PsqlPath 'RESTORE_PLAN_PSQL_PATH_REQUIRED';psqlSha256=Get-ApprovalHash $ExpectedPsqlSha256 'RESTORE_PLAN_PSQL_HASH_REQUIRED'
    databaseProjectRef=Get-ApprovalText $RestoreTargetProjectRef '^[a-z0-9]{20}$' 'RESTORE_PLAN_PROJECT_REF_REQUIRED';connectionMode=$RestoreConnectionMode
    databaseHost=Get-ApprovalText $RestoreDatabaseHost '^([a-z0-9-]+\.)+supabase\.(co|com)$' 'RESTORE_PLAN_DATABASE_HOST_REQUIRED';databasePort=$RestoreDatabasePort
    databaseName=Get-ApprovalText $RestoreDatabaseName '^[A-Za-z0-9_.-]{1,63}$' 'RESTORE_PLAN_DATABASE_NAME_REQUIRED';databaseUser=Get-ApprovalText $RestoreDatabaseUser '^[A-Za-z_][A-Za-z0-9_.-]{0,62}$' 'RESTORE_PLAN_DATABASE_USER_REQUIRED'
    pgPassFile=Get-ApprovalPath $PgPassFile 'RESTORE_PLAN_PGPASS_PATH_REQUIRED';pgPassSha256=Get-ApprovalHash $ExpectedPgPassSha256 'RESTORE_PLAN_PGPASS_HASH_REQUIRED';caCertificatePath=Get-ApprovalPath $RestoreCaCertificatePath 'RESTORE_PLAN_CA_PATH_REQUIRED';caCertificateSha256=Get-ApprovalHash $ExpectedRestoreCaCertificateSha256 'RESTORE_PLAN_CA_HASH_REQUIRED'
    integrityKeyFile=Get-ApprovalPath $BackupIntegrityKeyFile 'RESTORE_PLAN_INTEGRITY_KEY_PATH_REQUIRED';integrityKeySha256=Get-ApprovalHash $ExpectedBackupIntegrityKeySha256 'RESTORE_PLAN_INTEGRITY_KEY_HASH_REQUIRED';migrationsRoot=Get-ApprovalPath $MigrationsRoot 'RESTORE_PLAN_MIGRATIONS_ROOT_REQUIRED'
    scratchRoot=Get-ApprovalPath $ApprovedScratchRoot 'RESTORE_PLAN_SCRATCH_ROOT_REQUIRED';storageRoot=Get-ApprovalPath $RestoreStorageRoot 'RESTORE_PLAN_STORAGE_ROOT_REQUIRED';evidenceOutputPath=Get-ApprovalPath $EvidenceOutputPath 'RESTORE_PLAN_EVIDENCE_PATH_REQUIRED'
    verifiedTargetDataRoot=Get-ApprovalPath $VerifiedTargetDataRoot 'RESTORE_PLAN_VERIFIED_DATA_ROOT_REQUIRED';verifiedTargetFilesystemEvidencePath=Get-ApprovalPath $VerifiedTargetFilesystemEvidencePath 'RESTORE_PLAN_VERIFIED_FS_EVIDENCE_REQUIRED'
    filesystemEvidencePath=Get-ApprovalPath $FileSystemEvidencePath 'RESTORE_PLAN_FILESYSTEM_EVIDENCE_PATH_REQUIRED';filesystemEvidenceSha256=Get-ApprovalHash $ExpectedFileSystemEvidenceSha256 'RESTORE_PLAN_FILESYSTEM_EVIDENCE_HASH_REQUIRED'
    databaseBoundaryEvidencePath=Get-ApprovalPath $DatabaseBoundaryEvidencePath 'RESTORE_PLAN_DATABASE_BOUNDARY_PATH_REQUIRED';databaseBoundaryEvidenceSha256=Get-ApprovalHash $ExpectedDatabaseBoundaryEvidenceSha256 'RESTORE_PLAN_DATABASE_BOUNDARY_HASH_REQUIRED'
    maximumDatabaseDumpBytes=$MaximumDatabaseDumpBytes;restoreVerifierAccount=Get-ApprovalText $RestoreVerifierAccount '^.{1,256}$' 'RESTORE_PLAN_VERIFIER_ACCOUNT_REQUIRED'
    nodePath=Get-ApprovalPath $NodePath 'RESTORE_PLAN_NODE_PATH_REQUIRED';nodeSha256=Get-ApprovalHash $ExpectedNodeSha256 'RESTORE_PLAN_NODE_HASH_REQUIRED'
    signerPath=Get-ApprovalPath $AttestationSignerPath 'RESTORE_PLAN_SIGNER_PATH_REQUIRED';signerSha256=Get-ApprovalHash $ExpectedAttestationSignerSha256 'RESTORE_PLAN_SIGNER_HASH_REQUIRED';receiptPrivateKeyPath=Get-ApprovalPath $RestoreReceiptPrivateKeyPath 'RESTORE_PLAN_PRIVATE_KEY_PATH_REQUIRED';receiptPrivateKeySha256=Get-ApprovalHash $ExpectedRestoreReceiptPrivateKeySha256 'RESTORE_PLAN_PRIVATE_KEY_HASH_REQUIRED'
    previousReleaseKind=$PreviousReleaseKind;targetReleaseRoot=Get-ApprovalPath $TargetReleaseRoot 'RESTORE_PLAN_TARGET_RELEASE_REQUIRED';targetManifestSha256=Get-ApprovalHash $ExpectedTargetManifestSha256 'RESTORE_PLAN_TARGET_MANIFEST_HASH_REQUIRED'
    releaseVerifierPath=Get-ApprovalPath $ReleaseVerifierPath 'RESTORE_PLAN_RELEASE_VERIFIER_PATH_REQUIRED';releaseVerifierSha256=Get-ApprovalHash $ExpectedReleaseVerifierSha256 'RESTORE_PLAN_RELEASE_VERIFIER_HASH_REQUIRED'
    targetPrismaCliPath=Get-ApprovalPath $TargetPrismaCliPath 'RESTORE_PLAN_PRISMA_PATH_REQUIRED';targetPrismaCliSha256=Get-ApprovalHash $ExpectedTargetPrismaCliSha256 'RESTORE_PLAN_PRISMA_HASH_REQUIRED';targetPrismaSchemaPath=Get-ApprovalPath $TargetPrismaSchemaPath 'RESTORE_PLAN_PRISMA_SCHEMA_REQUIRED';targetMigrationsRoot=Get-ApprovalPath $TargetMigrationsRoot 'RESTORE_PLAN_TARGET_MIGRATIONS_REQUIRED'
    targetApiConfigPath=Get-ApprovalPath $TargetApiConfigPath 'RESTORE_PLAN_TARGET_API_CONFIG_REQUIRED';targetApiConfigSha256=Get-ApprovalHash $ExpectedTargetApiConfigSha256 'RESTORE_PLAN_TARGET_API_CONFIG_HASH_REQUIRED';internalProbeTokenFile=Get-ApprovalPath $InternalProbeTokenFile 'RESTORE_PLAN_PROBE_TOKEN_PATH_REQUIRED';internalProbeTokenSha256=Get-ApprovalHash $ExpectedInternalProbeTokenSha256 'RESTORE_PLAN_PROBE_TOKEN_HASH_REQUIRED';compatibilityApiPort=$CompatibilityApiPort;compatibilityEvidenceOutputPath=Get-ApprovalPath $CompatibilityEvidenceOutputPath 'RESTORE_PLAN_COMPATIBILITY_EVIDENCE_REQUIRED'
  }
  if($PreviousReleaseKind-eq'LOCAL_RELEASE'){$p.previousReleaseRoot=Get-ApprovalPath $PreviousReleaseRoot 'RESTORE_PLAN_PREVIOUS_RELEASE_REQUIRED';$p.previousManifestSha256=Get-ApprovalHash $ExpectedPreviousManifestSha256 'RESTORE_PLAN_PREVIOUS_MANIFEST_HASH_REQUIRED';$p.previousApiConfigPath=Get-ApprovalPath $PreviousApiConfigPath 'RESTORE_PLAN_PREVIOUS_API_CONFIG_REQUIRED';$p.previousApiConfigSha256=Get-ApprovalHash $ExpectedPreviousApiConfigSha256 'RESTORE_PLAN_PREVIOUS_API_CONFIG_HASH_REQUIRED'}
  else{$p.legacyBaselineEvidencePath=Get-ApprovalPath $LegacyBaselineEvidencePath 'RESTORE_PLAN_LEGACY_BASELINE_REQUIRED';$p.legacyBaselineEvidenceSha256=Get-ApprovalHash $ExpectedLegacyBaselineEvidenceSha256 'RESTORE_PLAN_LEGACY_BASELINE_HASH_REQUIRED'}
  New-ApprovalPlan $PSCommandPath 'Run' $p "Empty isolated schema in exact Supabase project $RestoreTargetProjectRef and bounded scratch/storage roots" 'Authenticates the backup chain, restores only into the approved isolated schema, writes signed restore and compatibility evidence, then removes bounded scratch state' 'Drop only the isolated schema, remove exact scratch/storage outputs, and preserve production data and the backup payload'
}
function StorageReferenceSql { return @"
WITH meta_refs AS (
  SELECT 'uploads/' || substring(stored_file_path from 7) AS key,
    COALESCE(column_schema->>'originalFileHashSha256', file_hash_sha256::text) AS sha256,
    column_schema
  FROM upload_batches WHERE stored_file_path LIKE 'local:%'
), refs AS (
  SELECT key, sha256, NULL::bigint AS size FROM meta_refs
  UNION SELECT 'uploads/' || substring(stored_file_path from 7), lower(file_hash_sha256), NULL::bigint FROM cafe24_upload_batches WHERE stored_file_path LIKE 'local:%'
  UNION SELECT 'uploads/' || substring(stored_file_path from 7), lower(file_hash_sha256), NULL::bigint FROM coupang_upload_batches WHERE stored_file_path LIKE 'local:%'
  UNION SELECT 'reports/' || substring(file_path from 7), lower(file_hash_sha256), NULL::bigint FROM report_exports WHERE status = 'CREATED' AND file_path LIKE 'local:%' AND file_hash_sha256 IS NOT NULL
  UNION SELECT CASE WHEN domain::text = 'META_UPLOAD' THEN 'uploads/' ELSE 'reports/' END || CASE WHEN state::text = 'RETAINED' THEN trash_key ELSE original_key END, lower(hash_sha256), byte_size FROM storage_tombstones WHERE provider = 'local' AND state::text IN ('RETAINED','RESTORED')
), invalid_refs AS (
  SELECT 1 FROM upload_batches WHERE stored_file_path IS NOT NULL AND stored_file_path NOT LIKE 'local:%'
  UNION ALL SELECT 1 FROM meta_refs WHERE sha256 !~ '^[0-9a-f]{64}$'
    OR (column_schema ? 'originalFileHashSha256' AND (
      jsonb_typeof(column_schema->'originalFileHashSha256') IS DISTINCT FROM 'string'
      OR column_schema->>'originalFileHashSha256' !~ '^[0-9a-f]{64}$'
    ))
  UNION ALL SELECT 1 FROM cafe24_upload_batches WHERE stored_file_path IS NOT NULL AND stored_file_path NOT LIKE 'local:%'
  UNION ALL SELECT 1 FROM coupang_upload_batches WHERE stored_file_path IS NOT NULL AND stored_file_path NOT LIKE 'local:%'
  UNION ALL SELECT 1 FROM report_exports WHERE status = 'CREATED' AND file_path IS NOT NULL AND file_path NOT LIKE 'local:%'
  UNION ALL SELECT 1 FROM storage_tombstones WHERE state::text IN ('RETAINED','RESTORED') AND provider <> 'local'
), canonical AS (SELECT key, sha256, max(size) AS size FROM refs GROUP BY key, sha256)
SELECT CASE WHEN EXISTS (SELECT 1 FROM invalid_refs) OR EXISTS (SELECT 1 FROM canonical GROUP BY key HAVING count(*) <> 1)
  THEN 'INVALID' ELSE coalesce(json_agg(json_build_object('key',key,'sha256',sha256,'size',size) ORDER BY key)::text,'[]') END FROM canonical
"@ }

if ($Action -eq 'Plan') { New-RestoreApprovalPlan $PlannedAction|ConvertTo-Json -Depth 12;exit 0 }
$approvalPlan=New-RestoreApprovalPlan 'Run';Assert-ApprovedPlan $approvalPlan ([bool]$Approved) $ApprovedPlanSha256
$cleanupSensitive=$false;$verifiedInputRoot=$null;$unsignedEvidence=$null;$unsignedRehearsal=$null;$restoreDataRoot=$null
try {
$started = Get-Date
$script:RestoreDeadline=$started.AddHours(4)
$script:RestoreStopwatch=[Diagnostics.Stopwatch]::StartNew()
$script:RestoreMaximumMilliseconds=14400000
$requiredFiles=@($PgRestorePath,$PsqlPath,$PgPassFile,$RestoreCaCertificatePath,$BackupIntegrityKeyFile,$NodePath,$AttestationSignerPath,$RestoreReceiptPrivateKeyPath,$ReleaseVerifierPath,$TargetPrismaCliPath,$TargetPrismaSchemaPath,$TargetApiConfigPath,$InternalProbeTokenFile,$FileSystemEvidencePath)
if($PreviousReleaseKind-eq'LOCAL_RELEASE'){$requiredFiles+=$PreviousApiConfigPath}else{$requiredFiles+=$LegacyBaselineEvidencePath}
foreach ($file in $requiredFiles) {
  if (-not $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'RESTORE_REQUIRED_FILE_NOT_FOUND' }
  Assert-NotReparsePoint -Path $file
  Assert-ExistingAncestorsNoReparse -Path $file
}
if(-not(Test-Path -LiteralPath $DatabaseBoundaryEvidencePath -PathType Leaf)){throw 'DATABASE_BOUNDARY_EVIDENCE_NOT_FOUND'};Assert-ExistingAncestorsNoReparse $DatabaseBoundaryEvidencePath
if($ExpectedDatabaseBoundaryEvidenceSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(FileHash $DatabaseBoundaryEvidencePath)-ine$ExpectedDatabaseBoundaryEvidenceSha256){throw 'DATABASE_BOUNDARY_EVIDENCE_HASH_MISMATCH'}
if($MaximumDatabaseDumpBytes-lt1048576-or$MaximumDatabaseDumpBytes-gt274877906944){throw 'DATABASE_DUMP_LIMIT_INVALID'}
if($ExpectedNodeSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(FileHash $NodePath)-ine$ExpectedNodeSha256){throw 'NODE_HASH_MISMATCH'}
Assert-PinnedFile $PsqlPath $ExpectedPsqlSha256 'PSQL_HASH_MISMATCH';Assert-PinnedFile $PgRestorePath $ExpectedPgRestoreSha256 'PG_RESTORE_HASH_MISMATCH'
Assert-PinnedFile $FileSystemEvidencePath $ExpectedFileSystemEvidenceSha256 'FILESYSTEM_EVIDENCE_HASH_MISMATCH'
Assert-PinnedFile $PgPassFile $ExpectedPgPassSha256 'RESTORE_PGPASS_HASH_MISMATCH';Assert-PinnedFile $BackupIntegrityKeyFile $ExpectedBackupIntegrityKeySha256 'BACKUP_INTEGRITY_KEY_HASH_MISMATCH';Assert-PinnedFile $RestoreReceiptPrivateKeyPath $ExpectedRestoreReceiptPrivateKeySha256 'RESTORE_PRIVATE_KEY_HASH_MISMATCH';Assert-PinnedFile $TargetApiConfigPath $ExpectedTargetApiConfigSha256 'TARGET_API_CONFIG_HASH_MISMATCH';Assert-PinnedFile $InternalProbeTokenFile $ExpectedInternalProbeTokenSha256 'INTERNAL_PROBE_TOKEN_HASH_MISMATCH';if($PreviousReleaseKind-eq'LOCAL_RELEASE'){Assert-PinnedFile $PreviousApiConfigPath $ExpectedPreviousApiConfigSha256 'PREVIOUS_API_CONFIG_HASH_MISMATCH'}
if ($ExpectedAttestationSignerSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or (FileHash $AttestationSignerPath) -ine $ExpectedAttestationSignerSha256) { throw 'ATTESTATION_SIGNER_HASH_MISMATCH' }
$runtimeFs=Read-DeadlineBoundText $FileSystemEvidencePath|ConvertFrom-Json
$restoreExecutors=@($NodePath,$PsqlPath,$PgRestorePath,$AttestationSignerPath,$ReleaseVerifierPath,$TargetPrismaCliPath);if($runtimeFs.result-ne'PASS'-or-not$runtimeFs.exactAcl-or@($restoreExecutors|Where-Object{-not(UnderAny $_ $runtimeFs.classRoots.SHARED_RUNTIME)}).Count){throw 'RESTORE_EXECUTOR_OUTSIDE_SHARED_RUNTIME'}
if (-not (Test-Path -LiteralPath $BackupDirectory -PathType Container) -or -not (Test-Path -LiteralPath $MigrationsRoot -PathType Container) -or -not(Test-Path -LiteralPath $TargetMigrationsRoot -PathType Container) -or ($PreviousReleaseKind-eq'LOCAL_RELEASE'-and-not(Test-Path -LiteralPath $PreviousReleaseRoot -PathType Container)) -or -not(Test-Path -LiteralPath $TargetReleaseRoot -PathType Container) -or -not (Test-Path -LiteralPath $ApprovedScratchRoot -PathType Container) -or -not(Test-Path -LiteralPath $VerifiedTargetDataRoot -PathType Container) -or -not(Test-Path -LiteralPath $VerifiedTargetFilesystemEvidencePath -PathType Leaf)) { throw 'RESTORE_REQUIRED_DIRECTORY_NOT_FOUND' }
Assert-NotReparsePoint -Path $BackupDirectory
Assert-TreeHasNoReparsePoint -Path $MigrationsRoot
Assert-TreeHasNoReparsePoint -Path $TargetMigrationsRoot
if($PreviousReleaseKind-eq'LOCAL_RELEASE'){Assert-TreeHasNoReparsePoint -Path $PreviousReleaseRoot}
Assert-TreeHasNoReparsePoint -Path $TargetReleaseRoot
Assert-NotReparsePoint -Path $ApprovedScratchRoot
if ($RestoreTargetProjectRef-notmatch'^[a-z]{20}$'-or$RestoreDatabasePort-ne5432-or$RestoreDatabaseName-notmatch'^[a-z][a-z0-9_]{0,62}$'-or$RestoreDatabaseUser-notmatch'^[a-z][a-z0-9_]{0,62}$') { throw 'RESTORE_DATABASE_TARGET_REJECTED' }
if($RestoreConnectionMode-eq'direct'-and$RestoreDatabaseHost-cne"db.$RestoreTargetProjectRef.supabase.co"){throw 'RESTORE_DATABASE_TARGET_REJECTED'}
if($RestoreConnectionMode-eq'session_pooler'-and$RestoreDatabaseHost-notmatch'^[a-z0-9-]+\.pooler\.supabase\.com$'){throw 'RESTORE_DATABASE_TARGET_REJECTED'}
if($ExpectedRestoreCaCertificateSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(FileHash $RestoreCaCertificatePath)-ine$ExpectedRestoreCaCertificateSha256){throw 'RESTORE_DATABASE_CA_HASH_MISMATCH'}
$restorePassword=Assert-PgPassTarget $PgPassFile
$restoreDataRoot = [IO.Path]::GetFullPath($RestoreStorageRoot).TrimEnd('\')
$restoreRoot = Join-Path $restoreDataRoot 'storage'
$verifiedTargetRoot = [IO.Path]::GetFullPath($VerifiedTargetDataRoot)
$sourceBackupRoot = [IO.Path]::GetFullPath($BackupDirectory)
$backupRoot = $sourceBackupRoot
$scratchRoot = [IO.Path]::GetFullPath($ApprovedScratchRoot).TrimEnd('\')
$expectedScratchRoot=(Join-Path $verifiedTargetRoot 'restore-verification').TrimEnd('\')
$expectedParent = (Split-Path -Parent $restoreDataRoot).TrimEnd('\')
if ($scratchRoot-ine$expectedScratchRoot-or$expectedParent -ine $scratchRoot -or (Split-Path -Leaf $restoreDataRoot) -notmatch '^[A-Za-z0-9._-]+_restore_verify$') { throw 'RESTORE_STORAGE_TARGET_REJECTED' }
if((Get-Volume -FilePath $verifiedTargetRoot).FileSystem-ne'NTFS'){throw 'VERIFIED_TARGET_MUST_BE_NTFS'}
Assert-NotReparsePoint $verifiedTargetRoot
$fsEvidence=Read-DeadlineBoundText $VerifiedTargetFilesystemEvidencePath|ConvertFrom-Json
if($fsEvidence.result-ne'PASS'-or[IO.Path]::GetFullPath([string]$fsEvidence.dataRoot)-ine$verifiedTargetRoot-or$fsEvidence.filesystem-ne'NTFS'-or-not$fsEvidence.nonReparse-or-not$fsEvidence.leastPrivilege-or$fsEvidence.descriptorDigest-notmatch'^[0-9a-f]{64}$'){throw 'VERIFIED_TARGET_FILESYSTEM_EVIDENCE_REJECTED'}
$verifierSid=([Security.Principal.NTAccount]$RestoreVerifierAccount).Translate([Security.Principal.SecurityIdentifier]).Value
$systemSid='S-1-5-18';$administratorsSid='S-1-5-32-544'
if($verifierSid-in@($systemSid,$administratorsSid)){throw 'RESTORE_VERIFIER_MUST_BE_UNPRIVILEGED'}
$executionSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($executionSid-cne$verifierSid){throw 'RESTORE_MUST_RUN_AS_VERIFIER_ACCOUNT'}
$scratchAcl=Get-Acl -LiteralPath $scratchRoot
if(-not$scratchAcl.AreAccessRulesProtected-or$scratchAcl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value-cne$verifierSid){throw 'RESTORE_SCRATCH_ACL_INVALID'}
$allowedScratchSids=@($systemSid,$administratorsSid,$verifierSid)|Sort-Object -Unique
if(@($scratchAcl.Access).Count-ne$allowedScratchSids.Count){throw 'RESTORE_SCRATCH_ACL_INVALID'}
$full=[Security.AccessControl.FileSystemRights]::FullControl;$modify=[Security.AccessControl.FileSystemRights]'Modify,Synchronize';$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
foreach($rule in $scratchAcl.Access){
  $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  $rights=if($sid-in@($systemSid,$administratorsSid)){$full}elseif($sid-eq$verifierSid){$modify}else{$null}
  if($null-eq$rights-or$rule.AccessControlType-ne'Allow'-or$rule.FileSystemRights-ne$rights-or$rule.InheritanceFlags-ne$inherit-or$rule.PropagationFlags-ne[Security.AccessControl.PropagationFlags]::None){throw 'RESTORE_SCRATCH_ACL_INVALID'}
}
$executionIdentity=[Security.Principal.WindowsIdentity]::GetCurrent();$executionPrincipal=[Security.Principal.WindowsPrincipal]::new($executionIdentity)
foreach($privilegedSid in @('S-1-5-18','S-1-5-32-544','S-1-5-32-547','S-1-5-32-548','S-1-5-32-549','S-1-5-32-550','S-1-5-32-551','S-1-5-32-555','S-1-5-32-556','S-1-5-32-562','S-1-5-32-569','S-1-5-32-573','S-1-5-32-580')){if($executionPrincipal.IsInRole([Security.Principal.SecurityIdentifier]::new($privilegedSid))){throw 'RESTORE_VERIFIER_PRIVILEGED_TOKEN_REJECTED'}}
$scratchFiles=@($PgPassFile,$BackupIntegrityKeyFile,$RestoreReceiptPrivateKeyPath,$DatabaseBoundaryEvidencePath,$VerifiedTargetFilesystemEvidencePath,$FileSystemEvidencePath,$TargetApiConfigPath,$InternalProbeTokenFile,$EvidenceOutputPath,$CompatibilityEvidenceOutputPath);if($PreviousReleaseKind-eq'LOCAL_RELEASE'){$scratchFiles+=$PreviousApiConfigPath}else{$scratchFiles+=$LegacyBaselineEvidencePath};foreach($scratchFile in $scratchFiles){if(-not(Under $scratchFile $scratchRoot)){throw 'RESTORE_VERIFIER_INPUT_MUST_BE_IN_SCRATCH'};Assert-ExistingAncestorsNoReparse $scratchFile}
$sensitiveScratchInputs=@($PgPassFile,$BackupIntegrityKeyFile,$RestoreReceiptPrivateKeyPath,$TargetApiConfigPath,$InternalProbeTokenFile);if($PreviousReleaseKind-eq'LOCAL_RELEASE'){$sensitiveScratchInputs+=$PreviousApiConfigPath};$sensitiveScratchInputs=$sensitiveScratchInputs|ForEach-Object{[IO.Path]::GetFullPath($_)}
$reservedOutputs=@([IO.Path]::GetFullPath($EvidenceOutputPath),[IO.Path]::GetFullPath($CompatibilityEvidenceOutputPath));if(@($sensitiveScratchInputs|Sort-Object -Unique).Count-ne$sensitiveScratchInputs.Count-or@($sensitiveScratchInputs|Where-Object{$_-in$reservedOutputs}).Count){throw 'RESTORE_SCRATCH_INPUT_PATH_COLLISION'};$cleanupSensitive=$true
if ($restoreDataRoot -eq [IO.Path]::GetPathRoot($restoreDataRoot) -or $restoreDataRoot -eq [Environment]::GetFolderPath('UserProfile') -or $restoreDataRoot -eq $sourceBackupRoot -or $restoreDataRoot.StartsWith($sourceBackupRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'RESTORE_STORAGE_TARGET_REJECTED' }
Assert-ExistingAncestorsNoReparse -Path $restoreDataRoot
if (Test-Path -LiteralPath $restoreDataRoot) { if (@(Get-DeadlineBoundTreeItems -Path $restoreDataRoot -TopLevelOnly).Count) { throw 'RESTORE_STORAGE_ROOT_NOT_EMPTY' }; Assert-NotReparsePoint -Path $restoreDataRoot }

Assert-NotReparsePoint $sourceBackupRoot
$sourceTopLevel=@(Get-DeadlineBoundTreeItems -Path $sourceBackupRoot -TopLevelOnly|ForEach-Object{$_.Name}|Sort-Object);$sourceHasConversion=Test-Path -LiteralPath (Join-Path $sourceBackupRoot 'storage-reference-conversion.sql') -PathType Leaf;$expectedSourceTop=@('backup-manifest.json','database.dump','receipt-request.json','storage-manifest.json','storage-payload');if($sourceHasConversion){$expectedSourceTop+='storage-reference-conversion.sql'}
if(($sourceTopLevel-join"`n")-cne(($expectedSourceTop|Sort-Object)-join"`n")){throw 'BACKUP_ARTIFACT_SET_INVALID'}
$verifiedInputRoot=Join-Path $scratchRoot ('verified-input-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $verifiedInputRoot|Out-Null
try{
  Copy-BoundedFile (Join-Path $sourceBackupRoot 'backup-manifest.json') (Join-Path $verifiedInputRoot 'backup-manifest.json') 65536
  Copy-BoundedFile (Join-Path $sourceBackupRoot 'storage-manifest.json') (Join-Path $verifiedInputRoot 'storage-manifest.json') 268435456
  if($sourceHasConversion){Copy-BoundedFile (Join-Path $sourceBackupRoot 'storage-reference-conversion.sql') (Join-Path $verifiedInputRoot 'storage-reference-conversion.sql') 16777216}
}catch{try{Remove-DeadlineBoundPath -Path $verifiedInputRoot -CleanupWindow}catch{};throw}
$backupRoot=$verifiedInputRoot
$releaseVerifier=[IO.Path]::GetFullPath($ReleaseVerifierPath);if($ExpectedReleaseVerifierSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(FileHash $releaseVerifier)-cne$ExpectedReleaseVerifierSha256.ToLowerInvariant()){throw 'RELEASE_VERIFIER_HASH_MISMATCH'}
if($ExpectedTargetPrismaCliSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(FileHash $TargetPrismaCliPath)-cne$ExpectedTargetPrismaCliSha256.ToLowerInvariant()){throw 'TARGET_PRISMA_CLI_HASH_MISMATCH'}
$targetManifestPath=Join-Path ([IO.Path]::GetFullPath($TargetReleaseRoot)) 'release-manifest.json'
$releaseEntries=@(@{Root=$TargetReleaseRoot;Path=$targetManifestPath;Hash=$ExpectedTargetManifestSha256;Code='TARGET'});if($PreviousReleaseKind-eq'LOCAL_RELEASE'){$previousManifestPath=Join-Path ([IO.Path]::GetFullPath($PreviousReleaseRoot)) 'release-manifest.json';$releaseEntries+=@{Root=$PreviousReleaseRoot;Path=$previousManifestPath;Hash=$ExpectedPreviousManifestSha256;Code='PREVIOUS'}}
foreach($entry in $releaseEntries){
  if(-not(Test-Path -LiteralPath $entry.Path -PathType Leaf)-or$entry.Hash-notmatch'^[A-Fa-f0-9]{64}$'-or(FileHash $entry.Path)-cne$entry.Hash.ToLowerInvariant()){throw "$($entry.Code)_RELEASE_MANIFEST_HASH_MISMATCH"}
  Assert-PinnedFile $ReleaseVerifierPath $ExpectedReleaseVerifierSha256 'RELEASE_VERIFIER_HASH_MISMATCH'
  Invoke-BoundedProcess $NodePath @($releaseVerifier,"--root=$($entry.Root)","--manifest-sha256=$($entry.Hash)") 300000 1048576 "$($entry.Code)_RELEASE_VERIFICATION_FAILED"|Out-Null
}
$targetRelease=Read-DeadlineBoundText $targetManifestPath 268435456|ConvertFrom-Json;if($targetRelease.version-ne4-or$targetRelease.migrationDigest-notmatch'^[0-9a-f]{64}$'-or$targetRelease.windowsHostBundleDigest-notmatch'^[0-9a-f]{64}$'-or$targetRelease.runtimeSmokeContractDigest-notmatch'^[0-9a-f]{64}$'-or-not$targetRelease.runtimeSmokeVerified){throw 'COMPATIBILITY_RELEASE_MANIFEST_INVALID'}
if($PreviousReleaseKind-eq'LOCAL_RELEASE'){$previousRelease=Read-DeadlineBoundText $previousManifestPath 268435456|ConvertFrom-Json;if($previousRelease.version-ne4-or$previousRelease.targetPlatform-cne$targetRelease.targetPlatform-or$previousRelease.targetArch-cne$targetRelease.targetArch-or$previousRelease.nodeModulesAbi-cne$targetRelease.nodeModulesAbi-or$previousRelease.migrationDigest-notmatch'^[0-9a-f]{64}$'-or$previousRelease.windowsHostBundleDigest-notmatch'^[0-9a-f]{64}$'-or$previousRelease.runtimeSmokeContractDigest-notmatch'^[0-9a-f]{64}$'-or-not$previousRelease.runtimeSmokeVerified){throw 'COMPATIBILITY_RELEASE_MANIFEST_INVALID'}}else{if($ExpectedLegacyBaselineEvidenceSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(FileHash $LegacyBaselineEvidencePath)-cne$ExpectedLegacyBaselineEvidenceSha256.ToLowerInvariant()){throw 'LEGACY_BASELINE_HASH_MISMATCH'};$previousRelease=Read-DeadlineBoundText $LegacyBaselineEvidencePath|ConvertFrom-Json;if($previousRelease.version-ne3-or-not$previousRelease.launchIdentityMatchesProtectedRestartSpec-or-not$previousRelease.legacyIdentityHealthSmokeVerified-or$previousRelease.restartCanonicalDigest-notmatch'^[0-9a-f]{64}$'-or$previousRelease.result-cne'PASS'-or$previousRelease.proofType-cne'legacy-running-baseline'-or$previousRelease.releaseId-notmatch'^[a-z0-9][a-z0-9._-]{0,62}$'-or$previousRelease.gitCommit-notmatch'^[0-9a-f]{40}$'-or$previousRelease.gitTree-notmatch'^[0-9a-f]{40}$'-or$previousRelease.sourceInventoryDigest-notmatch'^[0-9a-f]{64}$'-or$previousRelease.storageInventoryDigest-notmatch'^[0-9a-f]{64}$'-or$previousRelease.processIdentityDigest-notmatch'^[0-9a-f]{64}$'-or$previousRelease.migrationDigest-notmatch'^[0-9a-f]{64}$'-or$previousRelease.originalWebPort-ne3100-or$previousRelease.originalApiPort-ne4100-or$previousRelease.legacyAuthProvider-cne'supabase'-or$previousRelease.legacyStorageProvider-cne'repository_local_ntfs'-or$previousRelease.localReleaseManifestApplicable-or$previousRelease.localRoleMatrixApplicable-or-not$previousRelease.referenceConversionRequired){throw 'LEGACY_BASELINE_INVALID'}}
if([IO.Path]::GetFullPath($TargetPrismaCliPath)-ine[IO.Path]::GetFullPath((Join-Path $TargetReleaseRoot 'api\node_modules\prisma\build\index.js'))-or[IO.Path]::GetFullPath($TargetPrismaSchemaPath)-ine[IO.Path]::GetFullPath((Join-Path $TargetReleaseRoot 'api\prisma\schema.prisma'))-or[IO.Path]::GetFullPath($TargetMigrationsRoot).TrimEnd('\')-ine[IO.Path]::GetFullPath((Join-Path $TargetReleaseRoot 'api\prisma\migrations')).TrimEnd('\')){throw 'TARGET_MIGRATION_TOOLS_NOT_BOUND_TO_RELEASE'}
if(Test-Path -LiteralPath $CompatibilityEvidenceOutputPath){throw 'COMPATIBILITY_EVIDENCE_ALREADY_EXISTS'}

$manifestPath = Join-Path $backupRoot 'backup-manifest.json'
$dumpPath = Join-Path $backupRoot 'database.dump'
$storageManifestPath = Join-Path $backupRoot 'storage-manifest.json'
$payloadRoot = Join-Path $backupRoot 'storage-payload'
foreach ($file in @($manifestPath,$storageManifestPath)) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'BACKUP_ARTIFACT_MISSING' } }

$manifest = Read-DeadlineBoundText $manifestPath 65536 | ConvertFrom-Json
Assert-ExactKeys -Value $manifest -Keys @('version','result','backupId','createdAt','rpoHours','rtoHours','backupMode','sourceDataRoot','backupRoot','databaseProvider','databaseProjectRef','databaseConnectionMode','databaseHost','databasePort','databaseName','databaseSchema','releaseId','databaseDumpSha256','databaseDumpBytes','maximumDatabaseDumpBytes','maximumBackupDurationSeconds','backupSafetyMarginBytes','elapsedSeconds','databaseSizePreflightVerified','databaseDumpRealtimeCapEnforced','databaseDumpFinalCapVerified','hardDeadlineEnforced','processTreeKillOnDeadline','incompleteStagingCleanupContract','storageManifestSha256','storageReferenceDigest','storageReferenceConversionSha256','storageReferenceCount','storageReferenceZeroVerified','legacyBaselineSha256','legacyStorageStageEvidenceSha256','migrationDigest','appliedMigrationDigest','businessKpiDigest','targetEvidenceFingerprint','configFingerprint','fileCount','totalBytes','integrityAlgorithm','integrityKeyId','integritySignature','nodeSha256','psqlSha256','pgDumpSha256','executorSetDigest','filesystemEvidenceSha256','nasIdentityHelperSha256') -Code 'BACKUP_MANIFEST_KEYS_INVALID'
if ($manifest.version-ne6-or$manifest.result-ne'COMPLETE'-or$manifest.rpoHours-ne24-or$manifest.rtoHours-ne4-or$manifest.backupMode-cne$PreviousReleaseKind-or$manifest.databaseProvider-ne'supabase_postgres'-or$manifest.databaseProjectRef-notmatch'^[a-z]{20}$'-or$manifest.databasePort-ne5432-or$manifest.databaseHost-notmatch'^(?:db\.[a-z]{20}\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$'-or$manifest.integrityAlgorithm-ne'HMAC-SHA256'-or($RestoreTargetProjectRef-ceq$manifest.databaseProjectRef-and$RestoreDatabaseName-ceq$manifest.databaseName)-or$manifest.databaseSchema-notmatch'^[a-z][a-z0-9_]{0,62}$'-or$manifest.storageReferenceCount-lt0-or([bool]$manifest.storageReferenceZeroVerified-ne($manifest.storageReferenceCount-eq0))-or$manifest.databaseDumpBytes-lt1024-or$manifest.maximumDatabaseDumpBytes-lt1048576-or$manifest.maximumDatabaseDumpBytes-gt274877906944-or$manifest.databaseDumpBytes-gt$manifest.maximumDatabaseDumpBytes-or$manifest.maximumDatabaseDumpBytes-gt$MaximumDatabaseDumpBytes-or$manifest.maximumBackupDurationSeconds-ne14400-or$manifest.backupSafetyMarginBytes-ne1073741824-or$manifest.elapsedSeconds-lt0-or$manifest.elapsedSeconds-gt$manifest.maximumBackupDurationSeconds-or-not$manifest.databaseSizePreflightVerified-or-not$manifest.databaseDumpRealtimeCapEnforced-or-not$manifest.databaseDumpFinalCapVerified-or-not$manifest.hardDeadlineEnforced-or-not$manifest.processTreeKillOnDeadline-or-not$manifest.incompleteStagingCleanupContract) { throw 'BACKUP_MANIFEST_INVALID' }
if($PreviousReleaseKind-eq'LEGACY_BASELINE'){if(-not$sourceHasConversion-or$manifest.legacyBaselineSha256-cne$ExpectedLegacyBaselineEvidenceSha256.ToLowerInvariant()-or$manifest.storageReferenceConversionSha256-notmatch'^[0-9a-f]{64}$'-or$manifest.legacyStorageStageEvidenceSha256-notmatch'^[0-9a-f]{64}$'){throw 'LEGACY_BACKUP_CONVERSION_CONTRACT_INVALID'}}elseif($sourceHasConversion-or$null-ne$manifest.storageReferenceConversionSha256-or$null-ne$manifest.legacyBaselineSha256-or$null-ne$manifest.legacyStorageStageEvidenceSha256){throw 'LOCAL_BACKUP_CONVERSION_ARTIFACT_REJECTED'}
if($previousRelease.releaseId-cne$manifest.releaseId-or$previousRelease.migrationDigest-cne$manifest.migrationDigest){throw 'BACKUP_PREVIOUS_RELEASE_IDENTITY_MISMATCH'}
$previousMigrationInventory=@{};if($PreviousReleaseKind-eq'LOCAL_RELEASE'){foreach($property in $previousRelease.files.PSObject.Properties){Assert-RestoreDeadline;if($property.Name-match'^api/prisma/migrations/([^/]+)/migration\.sql$'){$previousMigrationInventory[$Matches[1]]=[string]$property.Value}}}else{foreach($file in Get-DeadlineBoundTreeItems -Path $MigrationsRoot -FilesOnly -Filter 'migration.sql'){$previousMigrationInventory[$file.Directory.Name]=(FileHash $file.FullName)}}
$targetMigrationInventory=@{};foreach($property in $targetRelease.files.PSObject.Properties){if($property.Name-match'^api/prisma/migrations/([^/]+)/migration\.sql$'){$targetMigrationInventory[$Matches[1]]=[string]$property.Value}}
foreach($name in $previousMigrationInventory.Keys){if(-not$targetMigrationInventory.ContainsKey($name)-or$targetMigrationInventory[$name]-cne$previousMigrationInventory[$name]){throw 'PREVIOUS_MIGRATION_CHAIN_CHANGED'}}
$databaseBoundary=Read-DeadlineBoundText $DatabaseBoundaryEvidencePath|ConvertFrom-Json
if($databaseBoundary.version-ne6-or$databaseBoundary.result-ne'PASS'-or-not$databaseBoundary.executorHashesVerified-or$databaseBoundary.psqlSha256-notmatch'^[0-9a-f]{64}$'-or-not$databaseBoundary.tlsVerified-or-not$databaseBoundary.hostnameVerified-or-not$databaseBoundary.caVerified-or-not$databaseBoundary.roleAttributesRestricted-or-not$databaseBoundary.boundedConnectionLimits-or-not$databaseBoundary.scramCredentialsVerified-or-not$databaseBoundary.roleMembershipsAbsent-or-not$databaseBoundary.privilegeContractVerified-or-not$databaseBoundary.functionEscalationAbsent-or-not$databaseBoundary.defaultPrivilegesVerified-or-not$databaseBoundary.productionRestoreRoleAccessAbsent-or-not$databaseBoundary.migrationRoleFullDataPrivileged-or-not$databaseBoundary.migrationCredentialAdminOnly-or-not$databaseBoundary.migrationCredentialMaintenanceOnly-or-not$databaseBoundary.auditAppendOnlyGuardVerified-or$databaseBoundary.projectRef-cne$manifest.databaseProjectRef-or$databaseBoundary.host-cne$manifest.databaseHost-or$databaseBoundary.databaseName-cne$manifest.databaseName-or$databaseBoundary.databaseSchema-cne$manifest.databaseSchema-or$databaseBoundary.restoreRoleDigest-cne(Sha256Text $RestoreDatabaseUser)){throw 'DATABASE_BOUNDARY_EVIDENCE_REJECTED'}
if($PreviousReleaseKind-eq'LOCAL_RELEASE'){Assert-IsolatedApiConfig $PreviousApiConfigPath $manifest $databaseBoundary $restoreDataRoot}
Assert-IsolatedApiConfig $TargetApiConfigPath $manifest $databaseBoundary $restoreDataRoot
$schemaSearchPath='SET search_path TO "'+$manifest.databaseSchema+'", pg_catalog; '
if (-not [IO.Path]::IsPathRooted([string]$manifest.sourceDataRoot)) { throw 'BACKUP_SOURCE_ROOT_INVALID' }
$sourceDataRoot = [IO.Path]::GetFullPath([string]$manifest.sourceDataRoot).TrimEnd('\')
$sourceStorageRoot=Join-Path $sourceDataRoot 'storage';if($restoreRoot-ieq$sourceDataRoot-or$restoreRoot-ieq$sourceStorageRoot-or$restoreRoot.StartsWith($sourceStorageRoot+'\',[StringComparison]::OrdinalIgnoreCase)-or$sourceStorageRoot.StartsWith($restoreRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'RESTORE_STORAGE_TARGET_REJECTED'}
foreach ($hash in @($manifest.databaseDumpSha256,$manifest.storageManifestSha256,$manifest.storageReferenceDigest,$manifest.migrationDigest,$manifest.appliedMigrationDigest,$manifest.businessKpiDigest,$manifest.targetEvidenceFingerprint,$manifest.configFingerprint,$manifest.integrityKeyId,$manifest.integritySignature,$manifest.nodeSha256,$manifest.psqlSha256,$manifest.pgDumpSha256,$manifest.executorSetDigest,$manifest.filesystemEvidenceSha256,$manifest.nasIdentityHelperSha256)) { if ($hash -notmatch '^[0-9a-f]{64}$') { throw 'BACKUP_MANIFEST_HASH_INVALID' } }
if((Sha256Text (@($manifest.nodeSha256,$manifest.psqlSha256,$manifest.pgDumpSha256)-join"`n"))-cne$manifest.executorSetDigest){throw 'BACKUP_EXECUTOR_SET_DIGEST_MISMATCH'}
$expectedSignature = HmacFile -KeyFile $BackupIntegrityKeyFile -Value (SignatureInput -Manifest $manifest)
if ($expectedSignature -cne $manifest.integritySignature) { throw 'BACKUP_SIGNATURE_MISMATCH' }
if((FileHash $BackupIntegrityKeyFile)-cne$manifest.integrityKeyId){throw 'BACKUP_INTEGRITY_KEY_ID_MISMATCH'}
if ((FileHash $storageManifestPath 268435456) -cne $manifest.storageManifestSha256) { throw 'STORAGE_MANIFEST_HASH_MISMATCH' }
$conversionPath=Join-Path $backupRoot 'storage-reference-conversion.sql';if($PreviousReleaseKind-eq'LEGACY_BASELINE'-and(FileHash $conversionPath)-cne$manifest.storageReferenceConversionSha256){throw 'LEGACY_STORAGE_CONVERSION_HASH_MISMATCH'}
$migrationRootFull = [IO.Path]::GetFullPath($MigrationsRoot)
$migrationFiles=@(Get-DeadlineBoundTreeItems -Path $migrationRootFull -FilesOnly -Filter 'migration.sql')
$migrationLines = @($migrationFiles | ForEach-Object {
  Assert-RestoreDeadline
  $rootPrefix = $migrationRootFull.TrimEnd('\') + '\'
  $fileFull = [IO.Path]::GetFullPath($_.FullName)
  if (-not $fileFull.StartsWith($rootPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'MIGRATION_PATH_INVALID' }
  $relative = $fileFull.Substring($rootPrefix.Length).Replace('\','/')
  "$relative=$(FileHash $_.FullName)"
})
if ((Sha256Text -Value ($migrationLines -join "`n")) -cne $manifest.migrationDigest) { throw 'MIGRATION_DIGEST_MISMATCH' }
$targetMigrationRootFull=[IO.Path]::GetFullPath($TargetMigrationsRoot);$targetPrefix=$targetMigrationRootFull.TrimEnd('\')+'\'
$targetMigrationFiles=@(Get-DeadlineBoundTreeItems -Path $targetMigrationRootFull -FilesOnly -Filter 'migration.sql')
$targetMigrationLines=@($targetMigrationFiles|ForEach-Object{Assert-RestoreDeadline;$fileFull=[IO.Path]::GetFullPath($_.FullName);if(-not$fileFull.StartsWith($targetPrefix,[StringComparison]::OrdinalIgnoreCase)){throw 'TARGET_MIGRATION_PATH_INVALID'};$relative=$fileFull.Substring($targetPrefix.Length).Replace('\','/');"$relative=$(FileHash $_.FullName)"})
if($targetMigrationLines.Count-eq0-or(Sha256Text ($targetMigrationLines-join"`n"))-cne$targetRelease.migrationDigest){throw 'TARGET_MIGRATION_DIGEST_MISMATCH'}
$expectedAppliedCanonical=@($migrationFiles|ForEach-Object{Assert-RestoreDeadline;"$($_.Directory.Name)=$(FileHash $_.FullName)"}|Sort-Object)-join"`n"
if((Sha256Text -Value $expectedAppliedCanonical)-cne$manifest.appliedMigrationDigest){throw 'APPLIED_MIGRATION_RELEASE_DIGEST_MISMATCH'}
$targetAppliedCanonical=@($targetMigrationFiles|ForEach-Object{Assert-RestoreDeadline;"$($_.Directory.Name)=$(FileHash $_.FullName)"}|Sort-Object)-join"`n"

$storageManifest = @(Read-DeadlineBoundText $storageManifestPath 268435456 | ConvertFrom-Json)
if ($storageManifest.Count -ne [long]$manifest.fileCount -or $storageManifest.Count -gt 1000000) { throw 'STORAGE_MANIFEST_COUNT_INVALID' }
$seen = New-Object -TypeName 'System.Collections.Generic.HashSet[string]' -ArgumentList ([StringComparer]::OrdinalIgnoreCase)
$computedTotal = [long]0
foreach ($entry in $storageManifest) {
  Assert-ExactKeys -Value $entry -Keys @('key','size','sha256') -Code 'STORAGE_MANIFEST_ENTRY_KEYS_INVALID'
  $key = ValidatedRelativeKey -Key ([string]$entry.key)
  if (-not $seen.Add($key) -or $entry.sha256 -notmatch '^[0-9a-f]{64}$' -or $entry.size -isnot [long] -and $entry.size -isnot [int]) { throw 'STORAGE_MANIFEST_ENTRY_INVALID' }
  $size = [long]$entry.size
  if ($size -lt 0 -or $size -gt 536870912) { throw 'STORAGE_MANIFEST_SIZE_INVALID' }
  $computedTotal += $size
  if ($computedTotal -gt 1099511627776) { throw 'STORAGE_MANIFEST_TOTAL_INVALID' }
}
if ($computedTotal -ne [long]$manifest.totalBytes) { throw 'STORAGE_MANIFEST_TOTAL_MISMATCH' }
$sourceDump=Join-Path $sourceBackupRoot 'database.dump';$sourceDumpItem=Get-Item -LiteralPath $sourceDump -Force;if($sourceDumpItem.PSIsContainer-or($sourceDumpItem.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0-or$sourceDumpItem.Length-lt1024-or$sourceDumpItem.Length-ne[long]$manifest.databaseDumpBytes-or$sourceDumpItem.Length-gt[long]$manifest.maximumDatabaseDumpBytes-or$sourceDumpItem.Length-gt$MaximumDatabaseDumpBytes){throw 'DATABASE_DUMP_SIZE_LIMIT_EXCEEDED'}
$storageVolume=Get-Volume -FilePath $verifiedTargetRoot;if([long]$storageVolume.SizeRemaining-lt([long]$computedTotal+[long]$sourceDumpItem.Length+1073741824)){throw 'STORAGE_RESTORE_CAPACITY_RESERVE_INSUFFICIENT'}
Copy-BoundedFile $sourceDump $dumpPath $MaximumDatabaseDumpBytes ([long]$sourceDumpItem.Length)
if ((FileHash $dumpPath $MaximumDatabaseDumpBytes) -cne $manifest.databaseDumpSha256) { throw 'DATABASE_DUMP_HASH_MISMATCH' }
New-Item -ItemType Directory -Path $payloadRoot|Out-Null
$sourcePayloadRoot=Join-Path $sourceBackupRoot 'storage-payload';Assert-NotReparsePoint $sourcePayloadRoot
foreach($entry in $storageManifest){$key=ValidatedRelativeKey ([string]$entry.key);$source=ContainedPath $sourcePayloadRoot $key;$destination=ContainedPath $payloadRoot $key;Copy-BoundedFile $source $destination ([long]$entry.size) ([long]$entry.size);if((FileHash $destination)-cne$entry.sha256){throw 'BACKUP_PAYLOAD_HASH_MISMATCH'}}
$topLevel=@(Get-DeadlineBoundTreeItems -Path $backupRoot -TopLevelOnly|ForEach-Object{$_.Name}|Sort-Object);$expectedVerifiedTop=@('backup-manifest.json','database.dump','storage-manifest.json','storage-payload');if($PreviousReleaseKind-eq'LEGACY_BASELINE'){$expectedVerifiedTop+='storage-reference-conversion.sql'};if(($topLevel-join"`n")-cne(($expectedVerifiedTop|Sort-Object)-join"`n")){throw 'BACKUP_ARTIFACT_SET_INVALID'}
$tocRun=Invoke-BoundedProcess $PgRestorePath @('--list',$dumpPath) 300000 8388608 'DATABASE_DUMP_TOC_INVALID';$tocLines=@($tocRun.Output-split"`r?`n");if($tocLines.Count-lt1-or$tocLines.Count-gt100000-or(($tocLines-join"`n").Length)-gt8388608){throw 'DATABASE_DUMP_TOC_INVALID'}
$tocSchema=[regex]::Escape([string]$manifest.databaseSchema)
foreach($line in $tocLines){$text=[string]$line;if(-not$text-or$text.StartsWith(';')){continue};$safeGlobal=$text-match'^\d+;\s+\d+\s+\d+\s+(?:ENCODING|STDSTRINGS|SEARCHPATH)(?:\s|$)';$safeSchema=$text-match("^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+"+$tocSchema+'(?:\s|$)');$safeObject=$text-match("^\d+;\s+\d+\s+\d+\s+(?:TYPE|TABLE|SEQUENCE OWNED BY|SEQUENCE|DEFAULT|TABLE DATA|CONSTRAINT|INDEX|FK CONSTRAINT)\s+"+$tocSchema+'\s+');$safeAuditFunction=$text-match("^\d+;\s+\d+\s+\d+\s+FUNCTION\s+"+$tocSchema+'\s+security_audit_events_append_only(?:\(\))?\s');$safeAuditTrigger=$text-match("^\d+;\s+\d+\s+\d+\s+TRIGGER\s+"+$tocSchema+'\s+security_audit_events\s+(?:security_audit_events_append_only_trigger|security_audit_events_reject_truncate)\s');if(-not($safeGlobal-or$safeSchema-or$safeObject-or$safeAuditFunction-or$safeAuditTrigger)){throw 'DATABASE_DUMP_TOC_OBJECT_REJECTED'}}

$previousPgPassFile = $env:PGPASSFILE;$previousPgSslMode=$env:PGSSLMODE;$previousPgSslRootCert=$env:PGSSLROOTCERT;$previousPgConnectTimeout=$env:PGCONNECT_TIMEOUT;$previousPgOptions=$env:PGOPTIONS
$restoreSchemaCreated=$false;$restoreSchemaCleaned=$false
try {
  $env:PGPASSFILE = [IO.Path]::GetFullPath($PgPassFile)
  $env:PGSSLMODE='verify-full';$env:PGSSLROOTCERT=[IO.Path]::GetFullPath($RestoreCaCertificatePath);$env:PGCONNECT_TIMEOUT='15';$env:PGOPTIONS='-c statement_timeout=120000 -c lock_timeout=30000 -c idle_in_transaction_session_timeout=60000 -c idle_session_timeout=120000'
  $restoreRoleProof=Invoke-Db "SELECT concat_ws('|',current_user,current_database(),(SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user),NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=(SELECT oid FROM pg_roles WHERE rolname=current_user)),(SELECT datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT datistemplate AND datallowconn FROM pg_database WHERE datname=current_database()),NOT has_database_privilege('PUBLIC',current_database(),'CONNECT'),(SELECT ssl AND version IN ('TLSv1.2','TLSv1.3') FROM pg_stat_ssl WHERE pid=pg_backend_pid()))"
  if($restoreRoleProof-cne"$RestoreDatabaseUser|$RestoreDatabaseName|t|t|t|t|t"){throw 'RESTORE_DATABASE_ROLE_BOUNDARY_FAILED'}
  $pristineSql = @"
WITH user_objects AS (
 SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg\_%' ESCAPE '\' AND n.nspname<>'information_schema' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
 UNION ALL SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg\_%' ESCAPE '\' AND n.nspname<>'information_schema' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
 UNION ALL SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname NOT LIKE 'pg\_%' ESCAPE '\' AND n.nspname<>'information_schema' AND t.typtype<>'p' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
), user_schemas AS (
 SELECT n.oid FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\_%' ESCAPE '\' AND n.nspname NOT IN ('information_schema','public') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_namespace'::regclass AND d.objid=n.oid AND d.deptype='e')
) SELECT concat_ws('|',(SELECT count(*) FROM user_schemas),(SELECT count(*) FROM user_objects),(SELECT count(*) FROM pg_event_trigger WHERE evtenabled<>'D'))
"@
  $emptyProof = Invoke-Db $pristineSql
  if ($emptyProof -cne '0|0|0') { throw 'RESTORE_DATABASE_NOT_PRISTINE' }
  Invoke-Db ('DROP SCHEMA IF EXISTS "'+$manifest.databaseSchema+'" CASCADE')|Out-Null
  $restoreSchemaCreated=$true
  Invoke-BoundedProcess $PgRestorePath @("--host=$RestoreDatabaseHost","--port=$RestoreDatabasePort","--username=$(RestoreConnectionUser)","--dbname=$RestoreDatabaseName",'--no-password','--exit-on-error','--no-owner','--no-privileges',$dumpPath) 10800000 8388608 'PG_RESTORE_FAILED'|Out-Null
  if($PreviousReleaseKind-eq'LEGACY_BASELINE'){Invoke-BoundedProcess $PsqlPath @("--host=$RestoreDatabaseHost","--port=$RestoreDatabasePort","--username=$(RestoreConnectionUser)","--dbname=$RestoreDatabaseName",'--no-password','--set=ON_ERROR_STOP=1',"--file=$conversionPath") 600000 8388608 'LEGACY_STORAGE_REFERENCE_CONVERSION_FAILED'|Out-Null}
  $auditGuardProof=Invoke-Db "$schemaSearchPath SELECT (SELECT count(*)=1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='$($manifest.databaseSchema)' AND p.proname='security_audit_events_append_only' AND p.prorettype='trigger'::regtype AND p.pronargs=0 AND l.lanname='plpgsql' AND NOT p.prosecdef AND NOT p.proleakproof AND regexp_replace(trim(p.prosrc),'\s+',' ','g')='BEGIN RAISE EXCEPTION ''security_audit_events is append-only''; END;') AND (SELECT count(*)=2 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='$($manifest.databaseSchema)' AND c.relname='security_audit_events' AND pn.nspname='$($manifest.databaseSchema)' AND p.proname='security_audit_events_append_only' AND NOT t.tgisinternal AND t.tgenabled='O' AND ((t.tgname='security_audit_events_append_only_trigger' AND t.tgtype=27) OR (t.tgname='security_audit_events_reject_truncate' AND t.tgtype=34)))"
  if($auditGuardProof-cne't'){throw 'RESTORED_AUDIT_APPEND_ONLY_GUARD_INVALID'}
  $kpiCanonical = Invoke-Db "$schemaSearchPath$(BusinessKpiSql)"
  if (-not $kpiCanonical -or $kpiCanonical.Contains("`n") -or (Sha256Text -Value $kpiCanonical) -cne $manifest.businessKpiDigest) { throw 'RESTORED_BUSINESS_KPI_MISMATCH' }
  $appliedMigrationCanonical = Invoke-Db "$schemaSearchPath$(AppliedMigrationSql)"
  if (-not $appliedMigrationCanonical -or $appliedMigrationCanonical.Contains("`r") -or $appliedMigrationCanonical -cne $expectedAppliedCanonical -or (Sha256Text -Value $appliedMigrationCanonical) -cne $manifest.appliedMigrationDigest) { throw 'RESTORED_APPLIED_MIGRATIONS_MISMATCH' }
  $storageTransition = Invoke-Db "$schemaSearchPath$(StorageTransitionSql)"
  if ($storageTransition -cne 'PASS') { throw 'RESTORED_STORAGE_TRANSITION_UNSTABLE' }
  $storageReferenceCanonical = Invoke-Db "$schemaSearchPath$(StorageReferenceSql)"
  if (-not $storageReferenceCanonical -or $storageReferenceCanonical -eq 'INVALID' -or $storageReferenceCanonical.Contains("`n")) { throw 'RESTORED_STORAGE_REFERENCE_MISMATCH' }
  try { $storageReferences = @($storageReferenceCanonical | ConvertFrom-Json);if($PreviousReleaseKind-eq'LEGACY_BASELINE'){$storageReferenceCanonical=ConvertTo-Json -InputObject @($storageReferences) -Compress;if(-not$storageReferenceCanonical){$storageReferenceCanonical='[]'}} } catch { throw 'RESTORED_STORAGE_REFERENCE_INVALID' }
  if((Sha256Text -Value $storageReferenceCanonical)-cne$manifest.storageReferenceDigest){throw 'RESTORED_STORAGE_REFERENCE_MISMATCH'}
  Set-IsolatedRuntimePrivileges ([string]$manifest.databaseSchema) ([string]$databaseBoundary.databaseUser)
  $smokeFrom='2000-01-01';$smokeTo=(Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
  $tokenItem=Get-Item -LiteralPath $InternalProbeTokenFile -Force;if($tokenItem.Length-lt32-or$tokenItem.Length-gt4096){throw 'COMPATIBILITY_PROBE_TOKEN_INVALID'};$probeToken=(Read-DeadlineBoundText $InternalProbeTokenFile 4096).Trim();if($probeToken.Length-lt32){throw 'COMPATIBILITY_PROBE_TOKEN_INVALID'}
  if($PreviousReleaseKind-eq'LOCAL_RELEASE'){$previousSmokeBeforeDigest=Invoke-ApiSmoke ([IO.Path]::GetFullPath($PreviousReleaseRoot)) ([string]$previousRelease.releaseId) $PreviousApiConfigPath $probeToken 'previous-before';$previousBusinessBeforeDigest=Invoke-BusinessSmoke ([IO.Path]::GetFullPath($PreviousReleaseRoot)) ([string]$previousRelease.releaseId) $PreviousApiConfigPath $smokeFrom $smokeTo;$previousMutationBeforeDigest=Invoke-MutationSmoke ([IO.Path]::GetFullPath($PreviousReleaseRoot)) ([string]$previousRelease.releaseId) $PreviousApiConfigPath;$previousRoleMatrixBeforeDigest=Invoke-RoleMatrixSmoke ([IO.Path]::GetFullPath($PreviousReleaseRoot)) ([string]$previousRelease.releaseId)}else{$previousSmokeBeforeDigest=Sha256Text 'ACTUAL_LEGACY_CODE_NOT_EXECUTED_IN_ISOLATED_RESTORE';$previousRoleMatrixBeforeDigest=Sha256Text 'LEGACY_LOCAL_ROLE_MATRIX_NOT_APPLICABLE';$previousMutationBeforeDigest=Sha256Text 'LEGACY_LOCAL_MUTATION_SMOKE_NOT_APPLICABLE';$previousBusinessBeforeDigest=Invoke-TargetLegacyDataProjectionSmoke ([IO.Path]::GetFullPath($TargetReleaseRoot)) ([string]$targetRelease.releaseId) $TargetApiConfigPath $smokeFrom $smokeTo}
  $priorDatabaseUrl=$env:DATABASE_URL
  try{
    $escapedUser=[Uri]::EscapeDataString((RestoreConnectionUser));$escapedPassword=[Uri]::EscapeDataString($restorePassword);$escapedCa=[Uri]::EscapeDataString([IO.Path]::GetFullPath($RestoreCaCertificatePath))
    $env:DATABASE_URL="postgresql://$escapedUser`:$escapedPassword@$RestoreDatabaseHost`:$RestoreDatabasePort/$RestoreDatabaseName?schema=$($manifest.databaseSchema)&sslmode=verify-full&sslrootcert=$escapedCa"
    Assert-PinnedFile $TargetPrismaCliPath $ExpectedTargetPrismaCliSha256 'TARGET_PRISMA_CLI_HASH_MISMATCH'
    Invoke-BoundedProcess $NodePath @($TargetPrismaCliPath,'migrate','deploy',"--schema=$TargetPrismaSchemaPath") 1800000 8388608 'TARGET_MIGRATION_REHEARSAL_FAILED'|Out-Null
  }finally{if($null-eq$priorDatabaseUrl){Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue}else{$env:DATABASE_URL=$priorDatabaseUrl}}
  $targetApplied=Invoke-Db "$schemaSearchPath$(AppliedMigrationSql)";if($targetApplied-cne$targetAppliedCanonical){throw 'TARGET_APPLIED_MIGRATIONS_MISMATCH'}
  Set-IsolatedRuntimePrivileges ([string]$manifest.databaseSchema) ([string]$databaseBoundary.databaseUser)
  $postMigrationKpi=Invoke-Db "$schemaSearchPath$(BusinessKpiSql)";if($postMigrationKpi-cne$kpiCanonical-or(Sha256Text $postMigrationKpi)-cne$manifest.businessKpiDigest){throw 'TARGET_MIGRATION_CHANGED_BUSINESS_KPI'}
  $postMigrationStorage=Invoke-Db "$schemaSearchPath$(StorageReferenceSql)";if($PreviousReleaseKind-eq'LEGACY_BASELINE'){try{$postMigrationStorage=ConvertTo-Json -InputObject @($postMigrationStorage|ConvertFrom-Json) -Compress}catch{throw 'TARGET_MIGRATION_STORAGE_REFERENCE_INVALID'}};if($postMigrationStorage-cne$storageReferenceCanonical){throw 'TARGET_MIGRATION_CHANGED_STORAGE_REFERENCES'}
  $postMigrationAuditGuard=Invoke-Db "$schemaSearchPath SELECT (SELECT count(*)=1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='$($manifest.databaseSchema)' AND p.proname='security_audit_events_append_only' AND p.prorettype='trigger'::regtype AND p.pronargs=0 AND l.lanname='plpgsql' AND NOT p.prosecdef AND NOT p.proleakproof AND regexp_replace(trim(p.prosrc),'\s+',' ','g')='BEGIN RAISE EXCEPTION ''security_audit_events is append-only''; END;') AND (SELECT count(*)=2 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='$($manifest.databaseSchema)' AND c.relname='security_audit_events' AND pn.nspname='$($manifest.databaseSchema)' AND p.proname='security_audit_events_append_only' AND NOT t.tgisinternal AND t.tgenabled='O' AND ((t.tgname='security_audit_events_append_only_trigger' AND t.tgtype=27) OR (t.tgname='security_audit_events_reject_truncate' AND t.tgtype=34)))";if($postMigrationAuditGuard-cne't'){throw 'TARGET_MIGRATION_AUDIT_GUARD_INVALID'}
  $roleMatrixProof=Invoke-Db "$schemaSearchPath SELECT concat_ws('|',(SELECT array_agg(v::text ORDER BY v::text)::text FROM unnest(enum_range(NULL::app_role)) v),(SELECT count(*) FROM app_users WHERE role::text NOT IN ('SUPER_ADMIN','ADMIN','USER','GUEST')),(SELECT count(*) FROM app_users WHERE NOT is_active AND deactivated_at IS NULL),(SELECT count(*) FROM app_users WHERE (username IS NULL)<>(normalized_username IS NULL)))"
  if($roleMatrixProof-cne'{ADMIN,GUEST,SUPER_ADMIN,USER}|0|0|0'){throw 'COMPATIBILITY_AUTH_ROLE_MATRIX_FAILED'}
  if($PreviousReleaseKind-eq'LOCAL_RELEASE'){$previousSmokeAfterDigest=Invoke-ApiSmoke ([IO.Path]::GetFullPath($PreviousReleaseRoot)) ([string]$previousRelease.releaseId) $PreviousApiConfigPath $probeToken 'previous-after';$previousBusinessAfterDigest=Invoke-BusinessSmoke ([IO.Path]::GetFullPath($PreviousReleaseRoot)) ([string]$previousRelease.releaseId) $PreviousApiConfigPath $smokeFrom $smokeTo;$previousMutationAfterDigest=Invoke-MutationSmoke ([IO.Path]::GetFullPath($PreviousReleaseRoot)) ([string]$previousRelease.releaseId) $PreviousApiConfigPath;$previousRoleMatrixAfterDigest=Invoke-RoleMatrixSmoke ([IO.Path]::GetFullPath($PreviousReleaseRoot)) ([string]$previousRelease.releaseId);if($previousRoleMatrixAfterDigest-cne$previousRoleMatrixBeforeDigest){throw 'PREVIOUS_RELEASE_ROLE_MATRIX_REGRESSION'}}else{$previousSmokeAfterDigest=$previousSmokeBeforeDigest;$previousRoleMatrixAfterDigest=$previousRoleMatrixBeforeDigest;$previousMutationAfterDigest=$previousMutationBeforeDigest;$previousBusinessAfterDigest=Invoke-TargetLegacyDataProjectionSmoke ([IO.Path]::GetFullPath($TargetReleaseRoot)) ([string]$targetRelease.releaseId) $TargetApiConfigPath $smokeFrom $smokeTo};if($previousBusinessAfterDigest-cne$previousBusinessBeforeDigest-or$previousMutationAfterDigest-cne$previousMutationBeforeDigest){throw 'PREVIOUS_RELEASE_BUSINESS_REGRESSION_AFTER_TARGET_MIGRATION'}
  $targetSmokeAfterDigest=Invoke-ApiSmoke ([IO.Path]::GetFullPath($TargetReleaseRoot)) ([string]$targetRelease.releaseId) $TargetApiConfigPath $probeToken 'target-after'
  $targetBusinessAfterDigest=Invoke-BusinessSmoke ([IO.Path]::GetFullPath($TargetReleaseRoot)) ([string]$targetRelease.releaseId) $TargetApiConfigPath $smokeFrom $smokeTo;if($targetBusinessAfterDigest-cne$previousBusinessBeforeDigest){throw 'TARGET_RELEASE_BUSINESS_REGRESSION'}
  $targetMutationAfterDigest=Invoke-MutationSmoke ([IO.Path]::GetFullPath($TargetReleaseRoot)) ([string]$targetRelease.releaseId) $TargetApiConfigPath;if($PreviousReleaseKind-eq'LOCAL_RELEASE'-and$targetMutationAfterDigest-cne$previousMutationBeforeDigest){throw 'TARGET_RELEASE_MUTATION_CONTRACT_REGRESSION'}
  $targetRoleMatrixAfterDigest=Invoke-RoleMatrixSmoke ([IO.Path]::GetFullPath($TargetReleaseRoot)) ([string]$targetRelease.releaseId);if($PreviousReleaseKind-eq'LOCAL_RELEASE'-and$targetRoleMatrixAfterDigest-cne$previousRoleMatrixBeforeDigest){throw 'TARGET_RELEASE_ROLE_MATRIX_REGRESSION'}
  $probeToken=$null
  Invoke-Db ('DROP SCHEMA "'+$manifest.databaseSchema+'" CASCADE')|Out-Null
  $restoreSchemaCreated=$false
  if((Invoke-Db $pristineSql)-cne'0|0|0'){throw 'RESTORE_SCHEMA_CLEANUP_FAILED'}
  $restoreSchemaCleaned=$true
} catch {
  $restoreFailure=$_
  if($restoreSchemaCreated){
    try{
      Invoke-CleanupDb ('DROP SCHEMA IF EXISTS "'+$manifest.databaseSchema+'" CASCADE')|Out-Null
      $restoreSchemaCreated=$false
      if((Invoke-CleanupDb $pristineSql)-cne'0|0|0'){throw 'RESTORE_DATABASE_NOT_PRISTINE_AFTER_FAILURE'}
      $restoreSchemaCleaned=$true
    }catch{throw 'RESTORE_SCHEMA_CLEANUP_FAILED'}
  }
  throw $restoreFailure
} finally {
  if ($null -eq $previousPgPassFile) { Remove-Item Env:PGPASSFILE -ErrorAction SilentlyContinue } else { $env:PGPASSFILE = $previousPgPassFile }
  if($null-eq$previousPgSslMode){Remove-Item Env:PGSSLMODE -ErrorAction SilentlyContinue}else{$env:PGSSLMODE=$previousPgSslMode};if($null-eq$previousPgSslRootCert){Remove-Item Env:PGSSLROOTCERT -ErrorAction SilentlyContinue}else{$env:PGSSLROOTCERT=$previousPgSslRootCert}
  if($null-eq$previousPgConnectTimeout){Remove-Item Env:PGCONNECT_TIMEOUT -ErrorAction SilentlyContinue}else{$env:PGCONNECT_TIMEOUT=$previousPgConnectTimeout};if($null-eq$previousPgOptions){Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue}else{$env:PGOPTIONS=$previousPgOptions}
}
New-Item -ItemType Directory -Path $restoreRoot -Force | Out-Null
foreach ($entry in $storageManifest) {
  Assert-RestoreDeadline
  $key = ValidatedRelativeKey -Key ([string]$entry.key)
  $source = ContainedPath -Root $payloadRoot -Key $key
  $target = ContainedPath -Root $restoreRoot -Key $key
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-BoundedFile -Source $source -Destination $target -MaximumBytes ([long]$entry.size) -ExpectedBytes ([long]$entry.size)
  Assert-NotReparsePoint -Path $target
  if ((Get-Item -LiteralPath $target).Length -ne [long]$entry.size -or (FileHash $target ([long]$entry.size)) -cne $entry.sha256) { throw 'RESTORED_STORAGE_HASH_MISMATCH' }
}
Assert-TreeHasNoReparsePoint -Path $restoreRoot
$restoredByKey = New-Object -TypeName 'System.Collections.Generic.Dictionary[string,object]' -ArgumentList ([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $storageManifest) { $restoredByKey.Add([string]$entry.key,$entry) }
foreach ($reference in $storageReferences) {
  Assert-ExactKeys -Value $reference -Keys @('key','sha256','size') -Code 'RESTORED_STORAGE_REFERENCE_KEYS_INVALID'
  $referenceKey = ValidatedRelativeKey -Key ([string]$reference.key)
  if (-not ($referenceKey.StartsWith('uploads/') -or $referenceKey.StartsWith('reports/')) -or -not $restoredByKey.ContainsKey($referenceKey)) { throw 'RESTORED_STORAGE_REFERENCE_MISSING' }
  $entry = $restoredByKey[$referenceKey]
  if ($entry.sha256 -cne $reference.sha256 -or ($null -ne $reference.size -and [long]$entry.size -ne [long]$reference.size)) { throw 'RESTORED_STORAGE_REFERENCE_HASH_MISMATCH' }
}
$restoredStorageHashCount=$storageManifest.Count
Remove-DeadlineBoundPath -Path $restoreDataRoot
if(Test-Path -LiteralPath $restoreDataRoot){throw 'RESTORE_STORAGE_CLEANUP_FAILED'}
Assert-RestoreDeadline
$elapsed = $script:RestoreStopwatch.Elapsed.TotalSeconds
$restoreExecutorSetDigest=Sha256Text (@($ExpectedNodeSha256.ToLowerInvariant(),$ExpectedPsqlSha256.ToLowerInvariant(),$ExpectedPgRestoreSha256.ToLowerInvariant())-join"`n")
$evidence = [ordered]@{
  attestationType='restore-verification'; version=6; result=if($elapsed -le 14400){'PASS'}else{'FAIL'}; backupId=$manifest.backupId; backupIntegritySignature=$manifest.integritySignature
  rpoHours=24; rtoHours=4; elapsedSeconds=$elapsed; databaseRestored=$true; storageHashVerified=$true; storageReferenceVerified=$true; businessKpiVerified=$true; businessMutationVerified=$true
  sourceDataRoot=$manifest.sourceDataRoot; verifiedTargetDataRoot=$verifiedTargetRoot; verifiedStorageRoot=$restoreRoot; verifiedStorageFileCount=$restoredStorageHashCount; verifiedTargetDescriptorDigest=$fsEvidence.descriptorDigest; completedAt=(Get-Date).ToUniversalTime().ToString('o')
  releaseId=$manifest.releaseId;databaseProvider='supabase_postgres';sourceDatabaseProjectRef=$manifest.databaseProjectRef;restoreTargetProjectRef=$RestoreTargetProjectRef;restoreTargetDatabaseName=$RestoreDatabaseName;isolatedRestoreTarget=$true;productionDatabaseMutated=$false;databaseName=$manifest.databaseName; databaseSchema=$manifest.databaseSchema; configFingerprint=$manifest.configFingerprint; targetEvidenceFingerprint=$manifest.targetEvidenceFingerprint; integrityKeyId=$manifest.integrityKeyId
  migrationDigest=$manifest.migrationDigest; appliedMigrationDigest=$manifest.appliedMigrationDigest; businessKpiDigest=$manifest.businessKpiDigest; storageReferenceDigest=$manifest.storageReferenceDigest;businessCompatibilityContractVersion=2;mutationCompatibilityContractVersion=2;targetBusinessContractDigest=$targetBusinessAfterDigest;targetMutationContractDigest=$targetMutationAfterDigest
  databaseBoundaryEvidenceSha256=$ExpectedDatabaseBoundaryEvidenceSha256.ToLowerInvariant();restoreRoleRestricted=$true;restoreVerifierIdentityBound=$true;isolatedDatabaseSchemaCleaned=$restoreSchemaCleaned;isolatedDatabasePristineBeforeRestore=$true;eventTriggersAbsentBeforeRestore=$true;isolatedStorageRootCleaned=$true;fullCatalogCleanupVerified=$true;archiveTocAllowlisted=$true;uncompressedTarArchive=$true;capacityReserveVerified=$true;verifiedInputSnapshot=$true;boundedManifestCopy=$true;isolatedApiConfigsBound=$true;hardDeadlineEnforced=$true;processTreeKillOnDeadline=$true;backupMode=$manifest.backupMode;storageReferenceConversionVerified=($PreviousReleaseKind-eq'LEGACY_BASELINE');storageReferenceCount=$manifest.storageReferenceCount;storageReferenceZeroVerified=$manifest.storageReferenceZeroVerified
  nodeSha256=$ExpectedNodeSha256.ToLowerInvariant();psqlSha256=$ExpectedPsqlSha256.ToLowerInvariant();pgRestoreSha256=$ExpectedPgRestoreSha256.ToLowerInvariant();restoreExecutorSetDigest=$restoreExecutorSetDigest;filesystemEvidenceSha256=$ExpectedFileSystemEvidenceSha256.ToLowerInvariant()
  backupManifestSha256=(FileHash $manifestPath 65536)
}
if (Test-Path -LiteralPath $EvidenceOutputPath) { throw 'RESTORE_EVIDENCE_ALREADY_EXISTS' }
$unsignedEvidence = Join-Path $scratchRoot ('.restore-evidence-'+[Guid]::NewGuid().ToString('N')+'.unsigned.json')
Write-Utf8NoBom -Path $unsignedEvidence -Value ($evidence | ConvertTo-Json -Depth 4)
Assert-PinnedFile $AttestationSignerPath $ExpectedAttestationSignerSha256 'ATTESTATION_SIGNER_HASH_MISMATCH'
Invoke-BoundedProcess $NodePath @($AttestationSignerPath,$RestoreReceiptPrivateKeyPath,$unsignedEvidence,$EvidenceOutputPath) 120000 1048576 'RESTORE_RECEIPT_SIGNING_FAILED'|Out-Null
if (-not (Test-Path -LiteralPath $EvidenceOutputPath -PathType Leaf)) { throw 'RESTORE_RECEIPT_SIGNING_FAILED' }
Remove-DeadlineBoundPath -Path $unsignedEvidence
$rehearsal=[ordered]@{
  attestationType='release-compatibility';version=2;result='PASS';compatibilityMode=$PreviousReleaseKind;previousReleaseId=$previousRelease.releaseId;targetReleaseId=$targetRelease.releaseId
  previousManifestSha256=if($PreviousReleaseKind-eq'LOCAL_RELEASE'){$ExpectedPreviousManifestSha256.ToLowerInvariant()}else{$ExpectedLegacyBaselineEvidenceSha256.ToLowerInvariant()};targetManifestSha256=$ExpectedTargetManifestSha256.ToLowerInvariant();previousMigrationDigest=$previousRelease.migrationDigest;targetMigrationDigest=$targetRelease.migrationDigest
  restoreEvidenceSha256=(FileHash $EvidenceOutputPath);isolatedDatabasePristineBeforeRestore=$true;previousReleaseSmokeBeforeMigration=($PreviousReleaseKind-eq'LOCAL_RELEASE');targetMigrationsAppliedToIsolatedRestore=$true;previousReleaseSmokeAfterMigration=($PreviousReleaseKind-eq'LOCAL_RELEASE');targetReleaseSmokeAfterMigration=$true;targetLegacyDataProjectionBeforeMigration=($PreviousReleaseKind-eq'LEGACY_BASELINE');targetLegacyDataProjectionAfterMigration=($PreviousReleaseKind-eq'LEGACY_BASELINE');actualLegacyCodeExecuted=($PreviousReleaseKind-eq'LOCAL_RELEASE');rollbackCodeCompatible=($PreviousReleaseKind-eq'LOCAL_RELEASE');databaseRestoreRequiredForRollback=($PreviousReleaseKind-eq'LEGACY_BASELINE');legacyRestartRequiredForRollback=($PreviousReleaseKind-eq'LEGACY_BASELINE');legacyLocalRoleMatrixNotClaimed=($PreviousReleaseKind-eq'LEGACY_BASELINE')
  previousSmokeBeforeDigest=$previousSmokeBeforeDigest;previousSmokeAfterDigest=$previousSmokeAfterDigest;targetSmokeAfterDigest=$targetSmokeAfterDigest;businessCompatibilityContractVersion=2;mutationCompatibilityContractVersion=2;previousBusinessBeforeDigest=$previousBusinessBeforeDigest;previousBusinessAfterDigest=$previousBusinessAfterDigest;targetBusinessAfterDigest=$targetBusinessAfterDigest;previousMutationBeforeDigest=$previousMutationBeforeDigest;previousMutationAfterDigest=$previousMutationAfterDigest;targetMutationAfterDigest=$targetMutationAfterDigest;previousRoleMatrixBeforeDigest=$previousRoleMatrixBeforeDigest;previousRoleMatrixAfterDigest=$previousRoleMatrixAfterDigest;targetRoleMatrixAfterDigest=$targetRoleMatrixAfterDigest;targetAppliedMigrationDigest=(Sha256Text $targetAppliedCanonical)
  authRoleMatrixVerified=$true;businessKpiVerified=$true;businessMutationVerified=$true;mutationRollbackVerified=$true;storageMutationHashVerified=$true;businessKpiDigest=$manifest.businessKpiDigest;storageHashVerified=$true;storageReferenceVerified=$true;storageReferenceDigest=$manifest.storageReferenceDigest
  isolatedDatabaseCleaned=$restoreSchemaCleaned;isolatedStorageCleaned=$true;verifiedInputSnapshot=$true;productionDatabaseMutated=$false;completedAt=(Get-Date).ToUniversalTime().ToString('o')
}
$unsignedRehearsal=Join-Path $scratchRoot ('.compatibility-evidence-'+[Guid]::NewGuid().ToString('N')+'.unsigned.json')
Write-Utf8NoBom $unsignedRehearsal ($rehearsal|ConvertTo-Json -Depth 4)
Assert-PinnedFile $AttestationSignerPath $ExpectedAttestationSignerSha256 'ATTESTATION_SIGNER_HASH_MISMATCH'
Invoke-BoundedProcess $NodePath @($AttestationSignerPath,$RestoreReceiptPrivateKeyPath,$unsignedRehearsal,$CompatibilityEvidenceOutputPath) 120000 1048576 'COMPATIBILITY_RECEIPT_SIGNING_FAILED'|Out-Null
if(-not(Test-Path -LiteralPath $CompatibilityEvidenceOutputPath -PathType Leaf)){throw 'COMPATIBILITY_RECEIPT_SIGNING_FAILED'}
Remove-DeadlineBoundPath -Path $unsignedRehearsal
[pscustomobject]@{ Result=$evidence.result; BackupId=$manifest.backupId; ElapsedSeconds=$elapsed } | ConvertTo-Json
if ($evidence.result -ne 'PASS') { exit 1 }
} finally {
  $cleanupFailed=$false
  foreach($temporary in @($unsignedEvidence,$unsignedRehearsal,$verifiedInputRoot)){if($temporary-and(Test-Path -LiteralPath $temporary)){try{Remove-DeadlineBoundPath -Path $temporary -CleanupWindow}catch{$cleanupFailed=$true}}}
  if($restoreDataRoot-and(Under $restoreDataRoot $scratchRoot)-and(Test-Path -LiteralPath $restoreDataRoot)){try{Remove-DeadlineBoundPath -Path $restoreDataRoot -CleanupWindow}catch{$cleanupFailed=$true}}
  if($cleanupSensitive){foreach($secretInput in $sensitiveScratchInputs){if(Test-Path -LiteralPath $secretInput){try{Remove-DeadlineBoundPath -Path $secretInput -CleanupWindow}catch{$cleanupFailed=$true}};if(Test-Path -LiteralPath $secretInput){$cleanupFailed=$true}}}
  $restorePassword=$null;$probeToken=$null
  if($cleanupFailed){throw 'RESTORE_SCRATCH_CLEANUP_FAILED'}
}
