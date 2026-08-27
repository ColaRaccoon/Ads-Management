#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Run')][string]$Action = 'Plan',
  [ValidateSet('LOCAL_RELEASE','LEGACY_BASELINE')][string]$BackupMode='LOCAL_RELEASE',
  [string]$RuntimeConfigPath,
  [string]$PgDumpPath,
  [string]$ExpectedPgDumpSha256,
  [string]$PsqlPath,
  [string]$ExpectedPsqlSha256,
  [string]$DatabaseName,
  [string]$DatabaseSchema,
  [string]$DatabaseUser,
  [string]$PgPassFile,
  [string]$BackupIntegrityKeyFile,
  [string]$NodePath,
  [string]$ExpectedNodeSha256,
  [string]$ReleaseRoot,
  [string]$ExpectedReleaseManifestSha256,
  [string]$ReleaseVerifierPath,
  [string]$ExpectedReleaseVerifierSha256,
  [string]$AttestationSignerPath,
  [string]$ExpectedAttestationSignerSha256,
  [string]$BackupReceiptPrivateKeyPath,
  [string]$FileSystemEvidencePath,
  [string]$ExpectedFileSystemEvidenceSha256,
  [string]$LegacyBaselineEvidencePath,[string]$ExpectedLegacyBaselineEvidenceSha256,
  [string]$LegacyStorageStageEvidencePath,[string]$ExpectedLegacyStorageStageEvidenceSha256,
  [ValidateRange(1048576,274877906944)][long]$MaximumDatabaseDumpBytes=68719476736,
  [ValidateSet(14400)][int]$MaximumBackupDurationSeconds=14400,
  [switch]$Approved
)
$ErrorActionPreference = 'Stop'
$script:BackupDeadline=$null
$script:BackupStopwatch=$null
$script:BackupMaximumMilliseconds=[long]0
$script:BackupSafetyMarginBytes=[long]1073741824

function Assert-NotReparsePoint([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_POINT_REJECTED' }
}
function Assert-ExistingAncestorsNoReparse([string]$Path) { $cursor=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force; while($cursor){ if(($cursor.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw'REPARSE_POINT_REJECTED'}; $cursor=$cursor.Parent } }
function Assert-PinnedFile([string]$Path,[string]$Expected,[string]$Code) { Assert-ExistingAncestorsNoReparse $Path; if($Expected-notmatch'^[A-Fa-f0-9]{64}$'-or(Deadline-BoundFileHash $Path)-ine$Expected){throw$Code} }
function UnderAny([string]$Path,[string[]]$Roots){$full=[IO.Path]::GetFullPath($Path);return@($Roots|Where-Object{$root=[IO.Path]::GetFullPath([string]$_).TrimEnd('\');$full-ieq$root-or$full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)}).Count-gt0}
function Assert-TreeHasNoReparsePoint([string]$Path) {
  Assert-NotReparsePoint -Path $Path
  foreach ($item in Get-DeadlineBoundTreeItems -Path $Path) { if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_POINT_REJECTED' } }
}
function RelativePath([string]$Root,[string]$Path) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $pathFull = [IO.Path]::GetFullPath($Path)
  if (-not $pathFull.StartsWith($rootFull,[StringComparison]::OrdinalIgnoreCase)) { throw 'PATH_OUTSIDE_ROOT' }
  return $pathFull.Substring($rootFull.Length).Replace('\','/')
}
function ValidatedRelativeKey([string]$Root,[string]$Path) {
  $relative = RelativePath -Root $Root -Path $Path
  if (-not $relative -or $relative.StartsWith('/') -or $relative -match '(^|/)\.\.?(/|$)' -or $relative.Contains(':') -or $relative.Contains("`0")) { throw 'STORAGE_KEY_REJECTED' }
  foreach ($segment in $relative.Split('/')) { if (-not $segment -or $segment.EndsWith('.') -or $segment.EndsWith(' ')) { throw 'STORAGE_KEY_REJECTED' } }
  return $relative
}
function ContainedPayloadPath([string]$Root,[string]$Key) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $target = [IO.Path]::GetFullPath((Join-Path $rootFull $Key.Replace('/','\')))
  if (-not $target.StartsWith($rootFull,[StringComparison]::OrdinalIgnoreCase)) { throw 'STORAGE_KEY_ESCAPES_PAYLOAD' }
  return $target
}
function Assert-UniqueKeys([string[]]$Keys) {
  $seen = New-Object -TypeName 'System.Collections.Generic.HashSet[string]' -ArgumentList ([StringComparer]::OrdinalIgnoreCase)
  foreach ($key in $Keys) { if (-not $seen.Add($key)) { throw 'STORAGE_KEY_COLLISION' } }
}
function Write-Utf8NoBom([string]$Path,[string]$Value) {
  Assert-BackupDeadline;$encoding=New-Object Text.UTF8Encoding($false);$stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$writer=[IO.StreamWriter]::new($stream,$encoding,65536,$false)
  try{for($offset=0;$offset-lt$Value.Length;$offset+=65536){Assert-BackupDeadline;$count=[Math]::Min(65536,$Value.Length-$offset);$writer.Write($Value.ToCharArray($offset,$count));Assert-BackupDeadline};$writer.Flush();$stream.Flush($true);Assert-BackupDeadline}finally{$writer.Dispose()}
}
function Read-DeadlineBoundText([string]$Path,[long]$MaximumBytes=1048576) {
  Assert-BackupDeadline;$item=Get-Item -LiteralPath $Path -Force;if($item.PSIsContainer-or$item.Length-lt0-or$item.Length-gt$MaximumBytes-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw'BACKUP_TEXT_INPUT_INVALID'}
  $stream=[IO.File]::Open($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$true,65536,$false);$builder=[Text.StringBuilder]::new()
  try{$buffer=New-Object char[] 65536;while(($read=$reader.Read($buffer,0,$buffer.Length))-gt0){Assert-BackupDeadline;if($builder.Length+$read-gt$MaximumBytes){throw'BACKUP_TEXT_INPUT_LIMIT_EXCEEDED'};[void]$builder.Append($buffer,0,$read)};Assert-BackupDeadline;return$($builder.ToString())}finally{$reader.Dispose()}
}
function Hex([byte[]]$Bytes) { return -join @($Bytes | ForEach-Object { $_.ToString('x2') }) }
function Sha256Text([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return Hex -Bytes $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)) } finally { $sha.Dispose() }
}
function Resolve-ConfiguredDataRoot($Value) {
  if ($Value) { return [IO.Path]::GetFullPath([string]$Value) }
  $base = if ($env:ProgramData) { $env:ProgramData } elseif ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $null }
  if (-not $base) { throw 'OS_APPLICATION_DATA_ROOT_UNAVAILABLE' }
  return [IO.Path]::GetFullPath((Join-Path $base 'MetaAdsPerformance'))
}
function IntegrityKeyId([string]$KeyFile) {
  Assert-BackupDeadline;$item=Get-Item -LiteralPath ([IO.Path]::GetFullPath($KeyFile)) -Force;if($item.Length-lt32-or$item.Length-gt4096){throw'BACKUP_INTEGRITY_KEY_INVALID'};$key=[IO.File]::ReadAllBytes($item.FullName);Assert-BackupDeadline;try{$sha=[Security.Cryptography.SHA256]::Create();try{return Hex -Bytes $sha.ComputeHash($key)}finally{$sha.Dispose()}}finally{[Array]::Clear($key,0,$key.Length)}
}
function TargetFingerprint($Evidence) {
  return Sha256Text -Value (@('5',$Evidence.result,$Evidence.targetType,$Evidence.dataRoot,$Evidence.backupRoot,$Evidence.dataDiskUniqueId,$Evidence.backupDiskUniqueId,$Evidence.nasServer,$Evidence.nasShare,$Evidence.backupWriterSid,$Evidence.encryptionProof,$Evidence.retentionControl,$Evidence.completedAt) -join "`n")
}
function Assert-CurrentBackupTarget($Evidence,[string]$DataRoot,[string]$Root){
  $system='S-1-5-18';$admin='S-1-5-32-544';$acl=Get-Acl -LiteralPath $Root;$expected=@($system,$admin,[string]$Evidence.backupWriterSid)|Sort-Object -Unique
  if(-not$acl.AreAccessRulesProtected-or$acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value-notin@($system,$admin)-or@($acl.Access).Count-ne3){throw'BACKUP_TARGET_ACL_DRIFT'}
  $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  foreach($rule in $acl.Access){$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;$rights=if($sid-in@($system,$admin)){[Security.AccessControl.FileSystemRights]::FullControl}elseif($sid-eq$Evidence.backupWriterSid){[Security.AccessControl.FileSystemRights]'Modify,Synchronize'}else{$null};if($null-eq$rights-or$rule.AccessControlType-ne'Allow'-or$rule.FileSystemRights-ne$rights-or$rule.IsInherited-or$rule.InheritanceFlags-ne$inherit-or$rule.PropagationFlags-ne[Security.AccessControl.PropagationFlags]::None){throw'BACKUP_TARGET_ACL_DRIFT'}}
  $dataVolume=Get-Volume -FilePath $DataRoot;if(-not$dataVolume.DriveLetter){throw'BACKUP_DATA_VOLUME_IDENTITY_UNAVAILABLE'};$dataPartition=Get-Partition -DriveLetter $dataVolume.DriveLetter;$dataDisk=Get-Disk -Number $dataPartition.DiskNumber
  if([string]$dataDisk.UniqueId-cne[string]$Evidence.dataDiskUniqueId-or[int]$dataDisk.Number-ne[int]$Evidence.dataDiskNumber){throw'BACKUP_DATA_DISK_IDENTITY_DRIFT'}
  if($Evidence.targetType-eq'LOCAL_DISK'){$volume=Get-Volume -FilePath $Root;if(-not$volume.DriveLetter){throw'BACKUP_TARGET_VOLUME_IDENTITY_UNAVAILABLE'};$partition=Get-Partition -DriveLetter $volume.DriveLetter;$disk=Get-Disk -Number $partition.DiskNumber;if([string]$disk.UniqueId-cne[string]$Evidence.backupDiskUniqueId-or[int]$disk.Number-ne[int]$Evidence.backupDiskNumber-or$disk.Number-eq$dataDisk.Number){throw'BACKUP_TARGET_IDENTITY_DRIFT'};$bitlocker=Get-BitLockerVolume -MountPoint ($volume.DriveLetter+':') -ErrorAction Stop;if([string]$bitlocker.ProtectionStatus-ne'On'-or[string]$bitlocker.VolumeStatus-ne'FullyEncrypted'){throw'BACKUP_TARGET_ENCRYPTION_DRIFT'}}elseif($Evidence.targetType-eq'NAS'){$connections=@(Get-SmbConnection -ServerName ([string]$Evidence.nasServer)-ErrorAction Stop|Where-Object{$_.ShareName-ceq[string]$Evidence.nasShare});if($connections.Count-ne1-or-not$connections[0].Encrypted-or[version]$connections[0].Dialect-lt[version]'3.1.1'){throw'BACKUP_TARGET_ENCRYPTION_DRIFT'}}else{throw'BACKUP_TARGET_TYPE_INVALID'}
}
function ConfigFingerprint($Config,[string]$DataRoot,[string]$BackupRoot,[string]$TargetFingerprint) {
  return Sha256Text -Value (@('2',$Config.release.id,$Config.release.migrationDigest,$DataRoot,$BackupRoot,$Config.backup.dailyTime,$Config.database.provider,$Config.database.projectRef,$Config.database.connectionMode,$Config.database.host,[string]$Config.database.port,$Config.database.name,$Config.database.runtimeUser,$Config.database.migrationUser,$Config.database.backupUser,$Config.database.restoreUser,$Config.database.schema,$Config.database.caCertificateSha256,'24','4',$TargetFingerprint) -join "`n")
}
function HmacFile([string]$KeyFile,[string]$Value) {
  Assert-BackupDeadline;$keyItem=Get-Item -LiteralPath ([IO.Path]::GetFullPath($KeyFile)) -Force;if($keyItem.Length-lt32-or$keyItem.Length-gt4096){throw'BACKUP_INTEGRITY_KEY_INVALID'};$key = [IO.File]::ReadAllBytes($keyItem.FullName);Assert-BackupDeadline
  try { $hmac = New-Object -TypeName Security.Cryptography.HMACSHA256 -ArgumentList (,$key); return Hex -Bytes $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)) }
  finally { if ($hmac) { $hmac.Dispose() }; [Array]::Clear($key,0,$key.Length) }
}
function Assert-BackupDeadline {
  if(($script:BackupStopwatch-and$script:BackupStopwatch.ElapsedMilliseconds-ge$script:BackupMaximumMilliseconds)-or($script:BackupDeadline-and(Get-Date)-ge$script:BackupDeadline)){throw'BACKUP_DEADLINE_EXCEEDED'}
}
function Remove-DeadlineBoundBackupPath([string]$Path,[switch]$CleanupWindow) {
  if(-not(Test-Path -LiteralPath $Path)){return}
  $savedDeadline=$script:BackupDeadline;$savedStopwatch=$script:BackupStopwatch;$savedMaximum=$script:BackupMaximumMilliseconds
  try{
    if($CleanupWindow){$script:BackupDeadline=(Get-Date).AddMinutes(2);$script:BackupStopwatch=[Diagnostics.Stopwatch]::StartNew();$script:BackupMaximumMilliseconds=120000}
    Assert-BackupDeadline;$root=Get-Item -LiteralPath $Path -Force
    if(-not$root.PSIsContainer){$root.Delete();Assert-BackupDeadline;return}
    $items=@(Get-DeadlineBoundTreeItems -Path $root.FullName|Sort-Object {$_.FullName.Length} -Descending)
    foreach($item in $items){Assert-BackupDeadline;if($item-is[IO.DirectoryInfo]){$item.Delete($false)}else{$item.Delete()};Assert-BackupDeadline}
    $root.Delete($false);Assert-BackupDeadline
  }finally{if($CleanupWindow){$script:BackupDeadline=$savedDeadline;$script:BackupStopwatch=$savedStopwatch;$script:BackupMaximumMilliseconds=$savedMaximum}}
}
function Get-DeadlineBoundTreeItems([string]$Path,[switch]$FilesOnly,[string]$Filter) {
  $root=[IO.DirectoryInfo]::new([IO.Path]::GetFullPath($Path));$pending=[Collections.Generic.Stack[IO.DirectoryInfo]]::new();$pending.Push($root);$items=[Collections.Generic.List[IO.FileSystemInfo]]::new()
  while($pending.Count){Assert-BackupDeadline;$directory=$pending.Pop();$children=$directory.GetFileSystemInfos();Assert-BackupDeadline;foreach($child in $children){Assert-BackupDeadline;if(($child.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw'REPARSE_POINT_REJECTED'};if($child-is[IO.DirectoryInfo]){$pending.Push($child);if(-not$FilesOnly){$items.Add($child)}}elseif(-not$Filter-or$child.Name-ceq$Filter){$items.Add($child)}}}
  return @($items|Sort-Object FullName)
}
function Deadline-BoundFileHash([string]$Path,[long]$MaximumBytes=[long]::MaxValue) {
  Assert-BackupDeadline;$item=Get-Item -LiteralPath $Path -Force;if($item.PSIsContainer-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0-or$item.Length-gt$MaximumBytes){throw'BACKUP_HASH_SOURCE_INVALID'}
  $stream=[IO.File]::Open($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$sha=[Security.Cryptography.SHA256]::Create()
  try{$buffer=New-Object byte[] 1048576;[long]$total=0;while(($read=$stream.Read($buffer,0,$buffer.Length))-gt0){Assert-BackupDeadline;$total+=$read;if($total-gt$MaximumBytes){throw'BACKUP_HASH_LIMIT_EXCEEDED'};[void]$sha.TransformBlock($buffer,0,$read,$null,0)};[void]$sha.TransformFinalBlock([byte[]]::new(0),0,0);Assert-BackupDeadline;return Hex $sha.Hash}finally{$sha.Dispose();$stream.Dispose()}
}
function Copy-DeadlineBoundFile([string]$Source,[string]$Destination,[long]$MaximumBytes,[long]$ExpectedBytes=-1) {
  Assert-BackupDeadline;Assert-ExistingAncestorsNoReparse $Source;$item=Get-Item -LiteralPath $Source -Force
  if($item.PSIsContainer-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0-or$item.Length-lt0-or$item.Length-gt$MaximumBytes-or($ExpectedBytes-ge0-and$item.Length-ne$ExpectedBytes)){throw'BACKUP_COPY_SOURCE_INVALID'}
  $parent=Split-Path -Parent $Destination;New-Item -ItemType Directory -Path $parent -Force|Out-Null;Assert-ExistingAncestorsNoReparse $parent
  $input=[IO.File]::Open($item.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$sha=[Security.Cryptography.SHA256]::Create();$output=$null
  try{$output=[IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$buffer=New-Object byte[] 1048576;[long]$copied=0;while(($read=$input.Read($buffer,0,$buffer.Length))-gt0){Assert-BackupDeadline;$copied+=$read;if($copied-gt$MaximumBytes){throw'BACKUP_COPY_LIMIT_EXCEEDED'};[void]$sha.TransformBlock($buffer,0,$read,$null,0);$output.Write($buffer,0,$read);Assert-BackupDeadline};[void]$sha.TransformFinalBlock([byte[]]::new(0),0,0);$output.Flush($true);Assert-BackupDeadline;if(($ExpectedBytes-ge0-and$copied-ne$ExpectedBytes)-or$copied-ne$item.Length){throw'BACKUP_COPY_LENGTH_CHANGED'};return[pscustomobject]@{Length=$copied;Sha256=(Hex $sha.Hash)}}finally{if($output){$output.Dispose()};$sha.Dispose();$input.Dispose()}
}
function Assert-PinnedExecutable([string]$File) {
  $executable=[IO.Path]::GetFullPath($File)
  if($executable-ieq[IO.Path]::GetFullPath($NodePath)){Assert-PinnedFile $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH'}
  elseif($executable-ieq[IO.Path]::GetFullPath($PsqlPath)){Assert-PinnedFile $PsqlPath $ExpectedPsqlSha256 'PSQL_HASH_MISMATCH'}
  elseif($executable-ieq[IO.Path]::GetFullPath($PgDumpPath)){Assert-PinnedFile $PgDumpPath $ExpectedPgDumpSha256 'PG_DUMP_HASH_MISMATCH'}
  else{throw'UNPINNED_BACKUP_EXECUTABLE_REJECTED'}
}
function Stop-ProcessTree($Process) {
  if($Process-and-not$Process.HasExited){try{$Process.Kill($true)}catch{throw'BACKUP_PROCESS_TREE_KILL_FAILED'};if(-not$Process.WaitForExit(5000)){throw'BACKUP_PROCESS_TREE_CLEANUP_TIMEOUT'}}
}
function Start-BoundedProcessState([string]$File,[string[]]$Arguments) {
  Assert-BackupDeadline;Assert-PinnedExecutable $File
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=[IO.Path]::GetFullPath($File);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  foreach($argument in $Arguments){$info.ArgumentList.Add($argument)}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info
  try{if(-not$process.Start()){throw'BACKUP_PROCESS_START_FAILED'}}catch{$process.Dispose();throw}
  $stdoutBuffer=New-Object char[] 4096;$stderrBuffer=New-Object char[] 4096
  return [pscustomobject]@{Process=$process;Stdout=$([Text.StringBuilder]::new());Stderr=$([Text.StringBuilder]::new());StdoutBuffer=$stdoutBuffer;StderrBuffer=$stderrBuffer;StdoutTask=$($process.StandardOutput.ReadAsync($stdoutBuffer,0,$stdoutBuffer.Length));StderrTask=$($process.StandardError.ReadAsync($stderrBuffer,0,$stderrBuffer.Length));StdoutDone=$false;StderrDone=$false}
}
function Pump-BoundedProcessStreams($State,[int]$MaximumOutputChars,[string]$Code) {
  foreach($name in @('Stdout','Stderr')){
    $doneName=$name+'Done';if($State.$doneName){continue};$taskName=$name+'Task';$bufferName=$name+'Buffer';$task=$State.$taskName
    if($task.IsCompleted){
      try{$count=$task.GetAwaiter().GetResult()}catch{Stop-ProcessTree $State.Process;throw "$Code`_OUTPUT_READ_FAILED"}
      if($count-eq0){$State.$doneName=$true;continue}
      if(($State.Stdout.Length+$State.Stderr.Length+$count)-gt$MaximumOutputChars){Stop-ProcessTree $State.Process;throw "$Code`_OUTPUT_LIMIT"}
      [void]$State.$name.Append($State.$bufferName,0,$count)
      $stream=if($name-eq'Stdout'){$State.Process.StandardOutput}else{$State.Process.StandardError}
      $State.$taskName=$stream.ReadAsync($State.$bufferName,0,$State.$bufferName.Length)
    }
  }
}
function Complete-BoundedProcessState($State,[int]$MaximumOutputChars,[string]$Code) {
  $drainDeadline=(Get-Date).AddSeconds(2)
  while(-not($State.StdoutDone-and$State.StderrDone)){Assert-BackupDeadline;Pump-BoundedProcessStreams $State $MaximumOutputChars $Code;if(-not($State.StdoutDone-and$State.StderrDone)){if((Get-Date)-ge$drainDeadline){throw "$Code`_OUTPUT_DRAIN_TIMEOUT"};Start-Sleep -Milliseconds 10}}
  if($State.Process.ExitCode-ne0){throw $Code}
  return [pscustomobject]@{Output=$($State.Stdout.ToString());Error=$($State.Stderr.ToString());ExitCode=$State.Process.ExitCode}
}
function Invoke-BoundedProcess([string]$File,[string[]]$Arguments,[int]$MaximumMilliseconds,[int]$MaximumOutputChars=8388608,[string]$Code='BACKUP_PROCESS_FAILED',[string]$MonitoredFile=$null,[long]$MaximumFileBytes=-1,$CompanionState=$null,[int]$CompanionMaximumOutputChars=1048576) {
  $state=Start-BoundedProcessState $File $Arguments;$localDeadline=(Get-Date).AddMilliseconds($MaximumMilliseconds)
  if($script:BackupDeadline-and$script:BackupDeadline-lt$localDeadline){$localDeadline=$script:BackupDeadline}
  try{
    while(-not$state.Process.HasExited){
      Pump-BoundedProcessStreams $state $MaximumOutputChars $Code
      if($CompanionState){Pump-BoundedProcessStreams $CompanionState $CompanionMaximumOutputChars 'SNAPSHOT_OWNER';if($CompanionState.Process.HasExited){Stop-ProcessTree $state.Process;throw'SNAPSHOT_OWNER_EXITED'}}
      if($MonitoredFile-and(Test-Path -LiteralPath $MonitoredFile -PathType Leaf)-and(Get-Item -LiteralPath $MonitoredFile -Force).Length-gt$MaximumFileBytes){Stop-ProcessTree $state.Process;throw "$Code`_FILE_LIMIT"}
      if((Get-Date)-ge$localDeadline){Stop-ProcessTree $state.Process;throw "$Code`_TIMEOUT"}
      Start-Sleep -Milliseconds 25
    }
    $result=Complete-BoundedProcessState $state $MaximumOutputChars $Code
    if($MonitoredFile){if(-not(Test-Path -LiteralPath $MonitoredFile -PathType Leaf)-or(Get-Item -LiteralPath $MonitoredFile -Force).Length-gt$MaximumFileBytes){throw "$Code`_FILE_LIMIT"}}
    return $result
  }finally{Stop-ProcessTree $state.Process;$state.Process.Dispose()}
}
function DatabaseArguments([string]$Sql) { return@("--host=$databaseHost","--port=$databasePort","--username=$databaseConnectionUser","--dbname=$DatabaseName",'--no-password','--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--command=$Sql") }
function Invoke-DatabaseQuery([string]$Sql,[int]$MaximumOutputChars,[string]$Code,$CompanionState=$null) {
  $run=Invoke-BoundedProcess $PsqlPath (DatabaseArguments $Sql) 120000 $MaximumOutputChars $Code $null -1 $CompanionState 1048576
  return ([string]$run.Output).Trim()
}
function SignatureInput($Manifest) {
  return @('5',$Manifest.backupId,$Manifest.createdAt,$Manifest.backupMode,$Manifest.sourceDataRoot,$Manifest.backupRoot,$Manifest.databaseProvider,$Manifest.databaseProjectRef,$Manifest.databaseConnectionMode,$Manifest.databaseHost,[string]$Manifest.databasePort,$Manifest.databaseName,$Manifest.databaseSchema,$Manifest.releaseId,$Manifest.databaseDumpSha256,[string]$Manifest.databaseDumpBytes,[string]$Manifest.maximumDatabaseDumpBytes,[string]$Manifest.maximumBackupDurationSeconds,[string]$Manifest.backupSafetyMarginBytes,[string]$Manifest.elapsedSeconds,[string]$Manifest.databaseSizePreflightVerified,[string]$Manifest.databaseDumpRealtimeCapEnforced,[string]$Manifest.databaseDumpFinalCapVerified,[string]$Manifest.hardDeadlineEnforced,[string]$Manifest.processTreeKillOnDeadline,[string]$Manifest.incompleteStagingCleanupContract,$Manifest.storageManifestSha256,$Manifest.storageReferenceDigest,$Manifest.storageReferenceConversionSha256,[string]$Manifest.storageReferenceCount,[string]$Manifest.storageReferenceZeroVerified,$Manifest.legacyBaselineSha256,$Manifest.legacyStorageStageEvidenceSha256,$Manifest.migrationDigest,$Manifest.appliedMigrationDigest,$Manifest.businessKpiDigest,$Manifest.targetEvidenceFingerprint,$Manifest.configFingerprint,$Manifest.fileCount,$Manifest.totalBytes,$Manifest.integrityKeyId,$Manifest.nodeSha256,$Manifest.psqlSha256,$Manifest.pgDumpSha256,$Manifest.executorSetDigest,$Manifest.filesystemEvidenceSha256) -join "`n"
}
function BusinessKpiSql { return "SELECT concat_ws('|',(SELECT count(*) FROM meta_adset_daily_metrics WHERE is_current),(SELECT coalesce(sum(spend_usd),0)::text FROM meta_adset_daily_metrics WHERE is_current),(SELECT coalesce(sum(result_count),0)::text FROM meta_adset_daily_metrics WHERE is_current),(SELECT count(*) FROM meta_ad_daily_metrics WHERE is_current),(SELECT coalesce(sum(purchase_count),0)::text FROM meta_ad_daily_metrics WHERE is_current),(SELECT count(*) FROM cafe24_order_lines WHERE is_current),(SELECT coalesce(sum(total_paid_krw),0)::text FROM cafe24_order_lines WHERE is_current),(SELECT count(*) FROM coupang_sale_lines WHERE is_current),(SELECT coalesce(sum(net_sales_krw),0)::text FROM coupang_sale_lines WHERE is_current),(SELECT count(*) FROM coupang_ad_metrics WHERE is_current),(SELECT coalesce(sum(ad_spend_krw),0)::text FROM coupang_ad_metrics WHERE is_current),(SELECT coalesce(sum(total_orders_1d),0)::text FROM coupang_ad_metrics WHERE is_current),(SELECT count(*) FROM coupang_manual_purchases),(SELECT coalesce(sum(quantity),0)::text FROM coupang_manual_purchases),(SELECT coalesce(sum(sales_amount_krw),0)::text FROM coupang_manual_purchases),(SELECT coalesce(sum(total_cost_krw),0)::text FROM coupang_manual_purchases),(SELECT count(*) FROM decision_logs),(SELECT count(*) FROM change_logs),(SELECT count(*) FROM report_exports))" }
function AppliedMigrationSql { return 'SELECT coalesce(string_agg(migration_name || ''='' || checksum, E''\n'' ORDER BY migration_name),'''') FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' }
function StorageTransitionSql { return "SELECT CASE WHEN EXISTS (SELECT 1 FROM storage_tombstones WHERE state::text IN ('PENDING','FAILED')) THEN 'UNSTABLE' ELSE 'PASS' END" }
function StorageReferenceSql { return @"
WITH meta_refs AS (
  SELECT 'uploads/' || substring(stored_file_path from 7) AS key,
    COALESCE(column_schema->>'originalFileHashSha256', file_hash_sha256::text) AS sha256,
    column_schema
  FROM upload_batches WHERE stored_file_path LIKE 'local:%'
), refs AS (
  SELECT key, sha256, NULL::bigint AS size FROM meta_refs
  UNION SELECT 'uploads/' || substring(stored_file_path from 7), lower(file_hash_sha256), NULL::bigint
  FROM cafe24_upload_batches WHERE stored_file_path LIKE 'local:%'
  UNION SELECT 'uploads/' || substring(stored_file_path from 7), lower(file_hash_sha256), NULL::bigint
  FROM coupang_upload_batches WHERE stored_file_path LIKE 'local:%'
  UNION SELECT 'reports/' || substring(file_path from 7), lower(file_hash_sha256), NULL::bigint
  FROM report_exports WHERE status = 'CREATED' AND file_path LIKE 'local:%' AND file_hash_sha256 IS NOT NULL
  UNION SELECT CASE WHEN domain::text = 'META_UPLOAD' THEN 'uploads/' ELSE 'reports/' END ||
    CASE WHEN state::text = 'RETAINED' THEN trash_key ELSE original_key END,
    lower(hash_sha256), byte_size
  FROM storage_tombstones WHERE provider = 'local' AND state::text IN ('RETAINED','RESTORED')
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
), canonical AS (
  SELECT key, sha256, max(size) AS size FROM refs GROUP BY key, sha256
)
SELECT CASE WHEN EXISTS (SELECT 1 FROM invalid_refs)
  OR EXISTS (SELECT 1 FROM canonical GROUP BY key HAVING count(*) <> 1)
  THEN 'INVALID' ELSE coalesce(json_agg(json_build_object('key',key,'sha256',sha256,'size',size) ORDER BY key)::text,'[]') END
FROM canonical
"@ }
function LegacyStorageReferenceSql { return @"
WITH refs AS (
  SELECT 'uploads'::text AS domain, 'upload_batches'::text AS table_name, 'stored_file_path'::text AS column_name, id::text,
    stored_file_path AS reference, COALESCE(column_schema->>'originalFileHashSha256',file_hash_sha256::text) AS sha256
  FROM upload_batches WHERE stored_file_path IS NOT NULL
  UNION ALL SELECT 'uploads','cafe24_upload_batches','stored_file_path',id::text,stored_file_path,lower(file_hash_sha256) FROM cafe24_upload_batches WHERE stored_file_path IS NOT NULL
  UNION ALL SELECT 'uploads','coupang_upload_batches','stored_file_path',id::text,stored_file_path,lower(file_hash_sha256) FROM coupang_upload_batches WHERE stored_file_path IS NOT NULL
  UNION ALL SELECT 'reports','report_exports','file_path',id::text,file_path,lower(file_hash_sha256) FROM report_exports WHERE status='CREATED' AND file_path IS NOT NULL AND file_hash_sha256 IS NOT NULL
), invalid AS (
  SELECT 1 FROM refs WHERE id !~ '^[0-9a-f-]{36}$' OR sha256 !~ '^[0-9a-f]{64}$'
  UNION ALL SELECT 1 FROM storage_tombstones WHERE state::text IN ('RETAINED','RESTORED')
)
SELECT CASE WHEN EXISTS(SELECT 1 FROM invalid) THEN 'INVALID'
  ELSE coalesce(json_agg(json_build_object('domain',domain,'table',table_name,'column',column_name,'id',id,'reference',reference,'sha256',sha256) ORDER BY table_name,id)::text,'[]') END
FROM refs
"@ }
function SqlLiteral([string]$Value){return"'"+$Value.Replace("'","''")+"'"}
function LegacyReferenceKey([string]$Reference,[string]$Domain,$Baseline){
  if($Domain-notin@('uploads','reports')-or-not$Reference-or$Reference.Length-gt4096){throw'LEGACY_STORAGE_REFERENCE_INVALID'}
  $root=if($Domain-eq'uploads'){[IO.Path]::GetFullPath([string]$Baseline.legacyUploadsRoot).TrimEnd('\')}else{[IO.Path]::GetFullPath([string]$Baseline.legacyReportsRoot).TrimEnd('\')}
  if($Reference.StartsWith('local:')){$relative=$Reference.Substring(6).Replace('/','\');$absolute=[IO.Path]::GetFullPath((Join-Path $root $relative))}
  elseif([IO.Path]::IsPathRooted($Reference)){$absolute=[IO.Path]::GetFullPath($Reference)}
  else{$absolute=[IO.Path]::GetFullPath((Join-Path ([string]$Baseline.legacySourceRoot) $Reference))}
  $prefix=$root+'\';if(-not$absolute.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw'LEGACY_STORAGE_REFERENCE_OUTSIDE_BASELINE_ROOT'}
  $relative=$absolute.Substring($prefix.Length).Replace('\','/');ValidatedRelativeKey -Root $root -Path $absolute|Out-Null;return"$Domain/$relative"
}

if ($Action -eq 'Plan') {
  [pscustomobject]@{
    Target=if($BackupMode-eq'LEGACY_BASELINE'){'Exact baseline-bound existing Supabase PostgreSQL database plus hash-staged repository-local payload'}else{'Configured existing Supabase PostgreSQL database plus dataRoot/storage immutable objects'}
    Impact=if($BackupMode-eq'LEGACY_BASELINE'){'Copies only the verified local stage, creates a bounded DB-reference conversion artifact without calling cloud Storage, and publishes a signed prechange manifest'}else{'Copies file payload and an uncompressed tar-format DB dump to a verified separate physical target, then atomically publishes a signed manifest'}
    Rollback='Remove only the newly created .pending directory; published backups require the separate retention procedure'
    SecretHandling='Database password is read by libpq from an ACL-protected PGPASSFILE and is never placed in argv or output'
    RPOHours=24; Schedule='Daily, install-time value'; RequiresApproval=$true
  } | ConvertTo-Json
  exit 0
}
if (-not $Approved) { throw 'EXPLICIT_APPROVAL_REQUIRED' }
$started=Get-Date
$script:BackupDeadline=$started.AddSeconds($MaximumBackupDurationSeconds)
$script:BackupStopwatch=[Diagnostics.Stopwatch]::StartNew()
$script:BackupMaximumMilliseconds=[long]$MaximumBackupDurationSeconds*1000
$requiredFiles=@($RuntimeConfigPath,$PgDumpPath,$PsqlPath,$PgPassFile,$BackupIntegrityKeyFile,$NodePath,$AttestationSignerPath,$BackupReceiptPrivateKeyPath,$FileSystemEvidencePath)
if($BackupMode-eq'LOCAL_RELEASE'){$requiredFiles+=@($ReleaseVerifierPath)}else{$requiredFiles+=@($LegacyBaselineEvidencePath,$LegacyStorageStageEvidencePath)}
foreach ($file in $requiredFiles) {
  if (-not $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'BACKUP_REQUIRED_FILE_NOT_FOUND' }
  Assert-BackupDeadline
  Assert-NotReparsePoint -Path $file
  Assert-ExistingAncestorsNoReparse -Path $file
}
Assert-PinnedFile $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH'
Assert-PinnedFile $PsqlPath $ExpectedPsqlSha256 'PSQL_HASH_MISMATCH'
Assert-PinnedFile $PgDumpPath $ExpectedPgDumpSha256 'PG_DUMP_HASH_MISMATCH'
Assert-PinnedFile $FileSystemEvidencePath $ExpectedFileSystemEvidenceSha256 'FILESYSTEM_EVIDENCE_HASH_MISMATCH'
$fs=Read-DeadlineBoundText $FileSystemEvidencePath|ConvertFrom-Json
$sharedExecutors=@($NodePath,$PsqlPath,$PgDumpPath,$AttestationSignerPath);if($BackupMode-eq'LOCAL_RELEASE'){$sharedExecutors+=$ReleaseVerifierPath}
if($fs.result-ne'PASS'-or-not$fs.exactAcl-or@($sharedExecutors|Where-Object{-not(UnderAny $_ $fs.classRoots.SHARED_RUNTIME)}).Count){throw'BACKUP_EXECUTOR_OUTSIDE_SHARED_RUNTIME'}
$legacyBaseline=$null;$legacyStage=$null;$releaseRootFull=$null
if($BackupMode-eq'LOCAL_RELEASE'){
  if (-not $ReleaseRoot -or -not (Test-Path -LiteralPath $ReleaseRoot -PathType Container)) { throw 'RELEASE_ROOT_NOT_FOUND' };Assert-NotReparsePoint -Path $ReleaseRoot;Assert-ExistingAncestorsNoReparse -Path $ReleaseRoot
  $releaseRootFull=[IO.Path]::GetFullPath($ReleaseRoot);Assert-PinnedFile $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH';Assert-PinnedFile $ReleaseVerifierPath $ExpectedReleaseVerifierSha256 'RELEASE_VERIFIER_HASH_MISMATCH'
  $releaseVerification=(Invoke-BoundedProcess $NodePath @($ReleaseVerifierPath,"--root=$releaseRootFull","--manifest-sha256=$ExpectedReleaseManifestSha256") 300000 1048576 'RELEASE_VERIFICATION_FAILED').Output;try{$releaseResult=$releaseVerification|ConvertFrom-Json}catch{throw 'RELEASE_VERIFICATION_OUTPUT_INVALID'}
}else{
  Assert-PinnedFile $LegacyBaselineEvidencePath $ExpectedLegacyBaselineEvidenceSha256 'LEGACY_BASELINE_HASH_MISMATCH';Assert-PinnedFile $LegacyStorageStageEvidencePath $ExpectedLegacyStorageStageEvidenceSha256 'LEGACY_STORAGE_STAGE_EVIDENCE_HASH_MISMATCH'
  $legacyBaseline=Read-DeadlineBoundText $LegacyBaselineEvidencePath|ConvertFrom-Json;$legacyStage=Read-DeadlineBoundText $LegacyStorageStageEvidencePath|ConvertFrom-Json
  if($legacyBaseline.version-ne3-or-not$legacyBaseline.launchIdentityMatchesProtectedRestartSpec-or-not$legacyBaseline.legacyIdentityHealthSmokeVerified-or$legacyBaseline.result-cne'PASS'-or$legacyBaseline.proofType-cne'legacy-running-baseline'-or$legacyBaseline.legacyStorageProvider-cne'repository_local_ntfs'-or$legacyBaseline.localReleaseManifestApplicable-or-not$legacyBaseline.referenceConversionRequired-or$legacyStage.version-ne1-or$legacyStage.result-cne'PASS'-or$legacyStage.proofType-cne'legacy-local-storage-stage'-or$legacyStage.baselineSha256-cne(Deadline-BoundFileHash $LegacyBaselineEvidencePath)-or-not$legacyStage.sourceDestinationHashesVerified-or$legacyStage.cloudStorageCalled){throw'LEGACY_BACKUP_EVIDENCE_REJECTED'}
  if((Get-Process -Id ([int]$legacyBaseline.webProcessId),([int]$legacyBaseline.apiProcessId) -ErrorAction SilentlyContinue)-or@(Get-NetTCPConnection -State Listen -LocalPort 3100,4100 -ErrorAction SilentlyContinue).Count){throw'LEGACY_BACKUP_REQUIRES_QUIESCED_PROCESSES'}
  $releaseResult=[pscustomobject]@{releaseId=[string]$legacyBaseline.releaseId;migrationDigest=[string]$legacyBaseline.migrationDigest}
}
if ($ExpectedAttestationSignerSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or (Deadline-BoundFileHash $AttestationSignerPath) -ine $ExpectedAttestationSignerSha256) { throw 'ATTESTATION_SIGNER_HASH_MISMATCH' }
if ($DatabaseName -notmatch '^[a-z][a-z0-9_]{0,62}$' -or $DatabaseSchema -notmatch '^[a-z][a-z0-9_]{0,62}$' -or $DatabaseUser -notmatch '^[a-z][a-z0-9_]{0,62}$') { throw 'BACKUP_DATABASE_IDENTITY_REJECTED' }

$config = Read-DeadlineBoundText $RuntimeConfigPath | ConvertFrom-Json
if($BackupMode-eq'LOCAL_RELEASE'-and$releaseResult.releaseId-cne$config.release.id){throw 'BACKUP_RELEASE_ID_MISMATCH'}
if (-not $config.backup.root -or -not $config.backup.dailyTime -or -not $config.backup.physicalTargetEvidencePath -or -not $config.backup.latestBackupEvidencePath -or -not $config.backup.backupReceiptPublicKeyPath) { throw 'BACKUP_NOT_CONFIGURED' }
$evidence = Read-DeadlineBoundText $config.backup.physicalTargetEvidencePath | ConvertFrom-Json
$backupRoot = if ($config.backup.root.StartsWith('\\')) { $config.backup.root.TrimEnd('\') } else { [IO.Path]::GetFullPath($config.backup.root) }
$dataRoot = Resolve-ConfiguredDataRoot $config.data.root
if($BackupMode-eq'LEGACY_BASELINE'-and[IO.Path]::GetFullPath([string]$legacyStage.targetDataRoot).TrimEnd('\')-ine$dataRoot){throw'LEGACY_STORAGE_STAGE_TARGET_MISMATCH'}
if ($evidence.version-ne5-or$evidence.result-ne'PASS'-or$evidence.backupRoot-cne$backupRoot-or$evidence.dataRoot-cne$dataRoot-or-not$evidence.encryptedAtRestOrTransport) { throw 'BACKUP_TARGET_NOT_VERIFIED' }
Assert-CurrentBackupTarget $evidence $dataRoot $backupRoot
if ($config.database.provider-cne'supabase_postgres'-or$config.database.name-cne$DatabaseName-or$config.database.backupUser-cne$DatabaseUser-or$config.database.schema-cne$DatabaseSchema-or$config.database.port-ne5432) { throw 'BACKUP_DATABASE_CONFIG_MISMATCH' }
$databaseHost=[string]$config.database.host;$databasePort=[int]$config.database.port;$databaseConnectionUser=if($config.database.connectionMode-eq'session_pooler'){"$DatabaseUser.$($config.database.projectRef)"}else{$DatabaseUser}
$databaseCa=[IO.Path]::GetFullPath([string]$config.database.caCertificatePath);if(-not(Test-Path -LiteralPath $databaseCa -PathType Leaf)){throw'BACKUP_DATABASE_CA_NOT_FOUND'};Assert-ExistingAncestorsNoReparse $databaseCa;if((Deadline-BoundFileHash $databaseCa)-ine[string]$config.database.caCertificateSha256){throw'BACKUP_DATABASE_CA_HASH_MISMATCH'}
$schemaSearchPath='SET search_path TO "'+$DatabaseSchema+'", pg_catalog; '
$targetFingerprint = TargetFingerprint $evidence
$configFingerprint = ConfigFingerprint $config $dataRoot $backupRoot $targetFingerprint
$storageRoot = Join-Path $dataRoot 'storage'
if (-not (Test-Path -LiteralPath $storageRoot -PathType Container)) { throw 'STORAGE_ROOT_NOT_FOUND' }
Assert-TreeHasNoReparsePoint -Path $storageRoot
if (-not (Test-Path -LiteralPath $backupRoot -PathType Container)) { throw 'BACKUP_ROOT_NOT_FOUND' }
Assert-NotReparsePoint -Path $backupRoot
Assert-ExistingAncestorsNoReparse -Path $backupRoot

$backupId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N')
$staging = Join-Path $backupRoot ".pending-$backupId"
$final = Join-Path $backupRoot $backupId
$latestEvidencePath = if ($config.backup.latestBackupEvidencePath.StartsWith('\\')) { $config.backup.latestBackupEvidencePath } else { [IO.Path]::GetFullPath($config.backup.latestBackupEvidencePath) }
$receiptRoot = Join-Path $dataRoot 'backup-receipt'
if ((Split-Path -Parent $latestEvidencePath).TrimEnd('\') -ine $receiptRoot.TrimEnd('\')) { throw 'LATEST_BACKUP_EVIDENCE_MUST_BE_IN_BACKUP_RECEIPT_ROOT' }
if ((Test-Path -LiteralPath $staging) -or (Test-Path -LiteralPath $final)) { throw 'BACKUP_TARGET_COLLISION' }
$latestUnsigned=$null;$latestPending=$null
try {
  New-Item -ItemType Directory -Path $staging | Out-Null
  $payloadRoot = Join-Path $staging 'storage-payload'
  New-Item -ItemType Directory -Path $payloadRoot | Out-Null
  $sourceFiles = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]';[long]$sourceTotalBytes=0
  foreach($sourceFile in (Get-DeadlineBoundTreeItems -Path $storageRoot -FilesOnly)){
    Assert-BackupDeadline
    if($sourceFile.Length-gt536870912){throw 'STORAGE_FILE_EXCEEDS_RESTORE_LIMIT'}
    $sourceFiles.Add($sourceFile);$sourceTotalBytes+=$sourceFile.Length
    if($sourceFiles.Count-gt1000000-or$sourceTotalBytes-gt1099511627776){throw 'STORAGE_SET_EXCEEDS_RESTORE_LIMIT'}
  }
  $sourceKeys = @($sourceFiles | ForEach-Object { ValidatedRelativeKey -Root $storageRoot -Path $_.FullName })
  Assert-UniqueKeys -Keys $sourceKeys
  if($BackupMode-eq'LEGACY_BASELINE'){
    $uploadLines=New-Object 'System.Collections.Generic.List[string]';$reportLines=New-Object 'System.Collections.Generic.List[string]'
    for($inventoryIndex=0;$inventoryIndex-lt$sourceFiles.Count;$inventoryIndex++){Assert-BackupDeadline;$key=$sourceKeys[$inventoryIndex];$line=$key.Substring($key.IndexOf('/')+1)+"|$($sourceFiles[$inventoryIndex].Length)|$(Deadline-BoundFileHash $sourceFiles[$inventoryIndex].FullName)";if($key.StartsWith('uploads/')){$uploadLines.Add($line)}elseif($key.StartsWith('reports/')){$reportLines.Add($line)}else{throw'LEGACY_STAGE_DOMAIN_INVALID'}}
    $stageDigest=Sha256Text -Value (@("uploads=$(Sha256Text -Value ($uploadLines-join"`n"))","reports=$(Sha256Text -Value ($reportLines-join"`n"))")-join"`n")
    if($stageDigest-cne$legacyBaseline.storageInventoryDigest-or$stageDigest-cne$legacyStage.storageInventoryDigest){throw'LEGACY_STAGE_INVENTORY_CHANGED'}
  }

  $dumpPath = Join-Path $staging 'database.dump'
  $snapshotSqlPath = Join-Path $staging '.snapshot-owner.sql'
  $snapshotOutputPath = Join-Path $staging '.snapshot-owner.out'
  $snapshotOutputSql=$snapshotOutputPath.Replace('\','/').Replace("'","''")
  Write-Utf8NoBom -Path $snapshotSqlPath -Value "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;`n\o '$snapshotOutputSql'`nSELECT pg_export_snapshot();`n\o 'NUL'`nSELECT pg_sleep($MaximumBackupDurationSeconds);`nROLLBACK;"
  $previousPgPassFile = $env:PGPASSFILE
  $previousPgSslMode = $env:PGSSLMODE;$previousPgSslRootCert=$env:PGSSLROOTCERT
  $snapshotOwner = $null
  $conversionSql=$null;$conversionReferenceCount=0;$conversionUpdateCount=0
  try {
    $env:PGPASSFILE = [IO.Path]::GetFullPath($PgPassFile)
    $env:PGSSLMODE='verify-full';$env:PGSSLROOTCERT=$databaseCa
    $databaseSizeText=Invoke-DatabaseQuery 'SELECT pg_database_size(current_database())' 1024 'DATABASE_SIZE_PREFLIGHT_FAILED'
    [long]$databaseSizeBytes=0
    if(-not[long]::TryParse($databaseSizeText,[ref]$databaseSizeBytes)-or$databaseSizeBytes-lt0){throw'DATABASE_SIZE_PREFLIGHT_INVALID'}
    if($databaseSizeBytes-gt$MaximumDatabaseDumpBytes){throw'DATABASE_SIZE_EXCEEDS_DUMP_CAP'}
    if(-not$config.backup.root.StartsWith('\\')){
      $volume=Get-Volume -FilePath $backupRoot
      [long]$requiredFreeBytes=$sourceTotalBytes+$MaximumDatabaseDumpBytes+$script:BackupSafetyMarginBytes
      if([long]$volume.SizeRemaining-lt$requiredFreeBytes){throw'BACKUP_TARGET_FREE_SPACE_INSUFFICIENT'}
    }
    $snapshotOwner = Start-BoundedProcessState $PsqlPath @("--host=$databaseHost","--port=$databasePort","--username=$databaseConnectionUser","--dbname=$DatabaseName",'--no-password','--tuples-only','--no-align','--set=ON_ERROR_STOP=1',"--file=$snapshotSqlPath")
    $snapshotId = $null
    $snapshotAcquireDeadline=(Get-Date).AddSeconds(30);if($script:BackupDeadline-lt$snapshotAcquireDeadline){$snapshotAcquireDeadline=$script:BackupDeadline}
    while(-not$snapshotId) {
      Pump-BoundedProcessStreams $snapshotOwner 1048576 'SNAPSHOT_OWNER'
      if ($snapshotOwner.Process.HasExited) { throw 'SNAPSHOT_OWNER_EXITED' }
      if (Test-Path -LiteralPath $snapshotOutputPath) {
        if((Get-Item -LiteralPath $snapshotOutputPath -Force).Length-gt4096){throw'SNAPSHOT_OWNER_OUTPUT_LIMIT'}
        $snapshotId = @((Read-DeadlineBoundText $snapshotOutputPath 4096)-split"`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+:\d+:\d+$' } | Select-Object -First 1)
        if ($snapshotId.Count -eq 1) { $snapshotId = [string]$snapshotId[0] } else { $snapshotId = $null }
      }
      if(-not$snapshotId-and(Get-Date)-ge$snapshotAcquireDeadline){throw'SNAPSHOT_EXPORT_TIMEOUT'}
      if (-not $snapshotId) { Start-Sleep -Milliseconds 100 }
    }
    Invoke-BoundedProcess $PgDumpPath @("--host=$databaseHost","--port=$databasePort","--username=$databaseConnectionUser","--dbname=$DatabaseName",'--no-password','--format=tar','--compress=0',"--snapshot=$snapshotId","--schema=$DatabaseSchema",'--no-owner','--no-privileges',"--file=$dumpPath") ([int]($MaximumBackupDurationSeconds*1000)) 1048576 'PG_DUMP_FAILED' $dumpPath $MaximumDatabaseDumpBytes $snapshotOwner 1048576|Out-Null
    $dumpItem=Get-Item -LiteralPath $dumpPath -Force
    if($dumpItem.Length-lt1024-or$dumpItem.Length-gt$MaximumDatabaseDumpBytes){throw'DATABASE_DUMP_FINAL_SIZE_INVALID'}
    $snapshotPrefix = "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '$snapshotId'; $schemaSearchPath"
    $kpiCanonical = Invoke-DatabaseQuery "$snapshotPrefix$(BusinessKpiSql); COMMIT;" 1048576 'BUSINESS_KPI_SNAPSHOT_FAILED' $snapshotOwner
    if (-not $kpiCanonical -or $kpiCanonical.Contains("`n")) { throw 'BUSINESS_KPI_SNAPSHOT_FAILED' }
    $kpiDigest = Sha256Text -Value $kpiCanonical
    $appliedMigrationCanonical = Invoke-DatabaseQuery "$snapshotPrefix$(AppliedMigrationSql); COMMIT;" 16777216 'APPLIED_MIGRATION_SNAPSHOT_FAILED' $snapshotOwner
    if (-not $appliedMigrationCanonical -or $appliedMigrationCanonical.Contains("`r")) { throw 'APPLIED_MIGRATION_SNAPSHOT_FAILED' }
    $appliedMigrationDigest = Sha256Text -Value $appliedMigrationCanonical
    $storageTransition = Invoke-DatabaseQuery "$snapshotPrefix$(StorageTransitionSql); COMMIT;" 1024 'STORAGE_TRANSITION_QUERY_FAILED' $snapshotOwner
    if ($storageTransition -cne 'PASS') { throw 'STORAGE_TRANSITION_IN_PROGRESS' }
    if($BackupMode-eq'LOCAL_RELEASE'){
      $storageReferenceCanonical = Invoke-DatabaseQuery "$snapshotPrefix$(StorageReferenceSql); COMMIT;" 268435456 'STORAGE_REFERENCE_SNAPSHOT_FAILED' $snapshotOwner
      if (-not $storageReferenceCanonical -or $storageReferenceCanonical -eq 'INVALID' -or $storageReferenceCanonical.Contains("`n")) { throw 'STORAGE_REFERENCE_SNAPSHOT_FAILED' }
      try { $storageReferences = @($storageReferenceCanonical | ConvertFrom-Json) } catch { throw 'STORAGE_REFERENCE_SNAPSHOT_INVALID' }
      $conversionReferenceCount=$storageReferences.Count
    }else{
      $legacyCanonical=Invoke-DatabaseQuery "$snapshotPrefix$(LegacyStorageReferenceSql); COMMIT;" 268435456 'LEGACY_STORAGE_REFERENCE_SNAPSHOT_FAILED' $snapshotOwner
      if(-not$legacyCanonical-or$legacyCanonical-eq'INVALID'-or$legacyCanonical.Contains("`n")){throw'LEGACY_STORAGE_REFERENCE_SNAPSHOT_FAILED'}
      try{$legacyReferences=@($legacyCanonical|ConvertFrom-Json)}catch{throw'LEGACY_STORAGE_REFERENCE_SNAPSHOT_INVALID'}
      $storageReferences=@();$sqlLines=New-Object 'System.Collections.Generic.List[string]';$sqlLines.Add('BEGIN;');$sqlLines.Add($schemaSearchPath)
      foreach($reference in $legacyReferences){
        $keys=@($reference.PSObject.Properties.Name|Sort-Object);if(($keys-join"`n")-cne((@('column','domain','id','reference','sha256','table')|Sort-Object)-join"`n")){throw'LEGACY_STORAGE_REFERENCE_KEYS_INVALID'}
        $pair="$($reference.table).$($reference.column)";if($pair-notin@('upload_batches.stored_file_path','cafe24_upload_batches.stored_file_path','coupang_upload_batches.stored_file_path','report_exports.file_path')-or$reference.id-notmatch'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'-or$reference.sha256-notmatch'^[0-9a-f]{64}$'){throw'LEGACY_STORAGE_REFERENCE_INVALID'}
        $key=LegacyReferenceKey ([string]$reference.reference) ([string]$reference.domain) $legacyBaseline;$storageReferences+=@([pscustomobject]@{key=$key;sha256=[string]$reference.sha256;size=$null});$conversionReferenceCount++
        $newReference='local:'+$key.Substring(([string]$reference.domain).Length+1);if([string]$reference.reference-cne$newReference){$conversionUpdateCount++;$sqlLines.Add('DO $legacy_ref$ BEGIN UPDATE "'+$DatabaseSchema+'"."'+[string]$reference.table+'" SET "'+[string]$reference.column+'"='+$(SqlLiteral $newReference)+' WHERE "id"='+$(SqlLiteral ([string]$reference.id))+'::uuid AND "'+[string]$reference.column+'"='+$(SqlLiteral ([string]$reference.reference))+'; IF NOT FOUND THEN RAISE EXCEPTION ''LEGACY_STORAGE_REFERENCE_CONVERSION_MISMATCH''; END IF; END $legacy_ref$;')}
      }
      $sqlLines.Add('DO $legacy_verify$ BEGIN IF EXISTS (SELECT 1 FROM "'+$DatabaseSchema+'"."upload_batches" WHERE "stored_file_path" IS NOT NULL AND "stored_file_path" NOT LIKE ''local:%'') OR EXISTS (SELECT 1 FROM "'+$DatabaseSchema+'"."cafe24_upload_batches" WHERE "stored_file_path" IS NOT NULL AND "stored_file_path" NOT LIKE ''local:%'') OR EXISTS (SELECT 1 FROM "'+$DatabaseSchema+'"."coupang_upload_batches" WHERE "stored_file_path" IS NOT NULL AND "stored_file_path" NOT LIKE ''local:%'') OR EXISTS (SELECT 1 FROM "'+$DatabaseSchema+'"."report_exports" WHERE "status"=''CREATED'' AND "file_path" IS NOT NULL AND "file_path" NOT LIKE ''local:%'') THEN RAISE EXCEPTION ''LEGACY_STORAGE_REFERENCE_CONVERSION_INCOMPLETE''; END IF; END $legacy_verify$;');$sqlLines.Add('COMMIT;')
      $conversionSql=$sqlLines-join"`n";$storageReferences=@($storageReferences|Sort-Object -Property key,sha256 -Unique);$storageReferenceCanonical=ConvertTo-Json -InputObject @($storageReferences) -Compress;$storageReferenceCanonical=if($storageReferenceCanonical){$storageReferenceCanonical}else{'[]'}
    }
    $storageReferenceDigest = Sha256Text -Value $storageReferenceCanonical
  } finally {
    if ($snapshotOwner) { Stop-ProcessTree $snapshotOwner.Process;try{for($drain=0;$drain-lt100-and-not($snapshotOwner.StdoutDone-and$snapshotOwner.StderrDone);$drain++){Pump-BoundedProcessStreams $snapshotOwner 1048576 'SNAPSHOT_OWNER';Start-Sleep -Milliseconds 10}}finally{$snapshotOwner.Process.Dispose()} }
    if ($null -eq $previousPgPassFile) { Remove-Item Env:PGPASSFILE -ErrorAction SilentlyContinue } else { $env:PGPASSFILE = $previousPgPassFile }
    if ($null -eq $previousPgSslMode) { Remove-Item Env:PGSSLMODE -ErrorAction SilentlyContinue } else { $env:PGSSLMODE=$previousPgSslMode };if($null-eq$previousPgSslRootCert){Remove-Item Env:PGSSLROOTCERT -ErrorAction SilentlyContinue}else{$env:PGSSLROOTCERT=$previousPgSslRootCert}
    foreach ($temporarySnapshotFile in @($snapshotSqlPath,$snapshotOutputPath)) { if (Test-Path -LiteralPath $temporarySnapshotFile) { Remove-DeadlineBoundBackupPath -Path $temporarySnapshotFile -CleanupWindow } }
    foreach ($temporarySnapshotFile in @($snapshotSqlPath,$snapshotOutputPath)) { if (Test-Path -LiteralPath $temporarySnapshotFile) { throw 'SNAPSHOT_TEMPORARY_CLEANUP_FAILED' } }
  }

  $storageManifest = @()
  for ($index = 0; $index -lt $sourceFiles.Count; $index += 1) {
    Assert-BackupDeadline
    $source = $sourceFiles[$index]
    if (($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'STORAGE_REPARSE_POINT_REJECTED' }
    $key = $sourceKeys[$index]
    $target = ContainedPayloadPath -Root $payloadRoot -Key $key
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    $beforeLength = $source.Length
    $copied = Copy-DeadlineBoundFile -Source $source.FullName -Destination $target -MaximumBytes 536870912 -ExpectedBytes $beforeLength
    $after = Deadline-BoundFileHash $source.FullName 536870912
    $afterLength = (Get-Item -LiteralPath $source.FullName).Length
    Assert-BackupDeadline
    if ($copied.Sha256 -cne $after -or $beforeLength -ne $copied.Length -or $beforeLength -ne $afterLength) { throw 'STORAGE_CHANGED_DURING_BACKUP' }
    $storageManifest += [ordered]@{ key=$key; size=$copied.Length; sha256=$copied.Sha256 }
  }
  Assert-BackupDeadline
  $endingKeys = @(Get-DeadlineBoundTreeItems -Path $storageRoot -FilesOnly | ForEach-Object { Assert-BackupDeadline; ValidatedRelativeKey -Root $storageRoot -Path $_.FullName })
  if (($sourceKeys -join "`n") -cne ($endingKeys -join "`n")) { throw 'STORAGE_SET_CHANGED_DURING_BACKUP' }

  $storageManifestPath = Join-Path $staging 'storage-manifest.json'
  Write-Utf8NoBom -Path $storageManifestPath -Value (ConvertTo-Json -InputObject @($storageManifest) -Depth 4)
  $conversionPath=$null;$conversionHash=$null
  if($BackupMode-eq'LEGACY_BASELINE'){$conversionPath=Join-Path $staging 'storage-reference-conversion.sql';Write-Utf8NoBom -Path $conversionPath -Value $conversionSql;$conversionHash=Deadline-BoundFileHash $conversionPath}
  $manifestByKey = New-Object -TypeName 'System.Collections.Generic.Dictionary[string,object]' -ArgumentList ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $storageManifest) { $manifestByKey.Add([string]$entry.key,$entry) }
  foreach ($reference in $storageReferences) {
    Assert-BackupDeadline
    $referenceKeys = @($reference.PSObject.Properties.Name | Sort-Object)
    if (($referenceKeys -join "`n") -cne ((@('key','sha256','size') | Sort-Object) -join "`n")) { throw 'STORAGE_REFERENCE_KEYS_INVALID' }
    $referenceKey = [string]$reference.key
    if (-not ($referenceKey.StartsWith('uploads/') -or $referenceKey.StartsWith('reports/')) -or $referenceKey -match '(^|/)[.][.]?(/|$)' -or $reference.sha256 -notmatch '^[0-9a-f]{64}$' -or -not $manifestByKey.ContainsKey($referenceKey)) { throw 'STORAGE_REFERENCE_MISSING_FROM_PAYLOAD' }
    $entry = $manifestByKey[$referenceKey]
    if ($entry.sha256 -cne $reference.sha256 -or ($null -ne $reference.size -and [long]$entry.size -ne [long]$reference.size)) { throw 'STORAGE_REFERENCE_PAYLOAD_MISMATCH' }
  }
  $migrationRoot = if($BackupMode-eq'LEGACY_BASELINE'){[IO.Path]::GetFullPath([string]$legacyBaseline.legacyMigrationsRoot)}else{[IO.Path]::GetFullPath((Join-Path $releaseRootFull 'api\prisma\migrations'))}
  Assert-BackupDeadline
  if(-not(Test-Path -LiteralPath $migrationRoot -PathType Container)){throw 'RELEASE_MIGRATIONS_NOT_FOUND'}
  Assert-TreeHasNoReparsePoint -Path $migrationRoot
  $migrationFiles=@(Get-DeadlineBoundTreeItems -Path $migrationRoot -FilesOnly -Filter 'migration.sql')
  $migrationLines = @($migrationFiles | ForEach-Object {
    Assert-BackupDeadline
    $relative = RelativePath -Root $migrationRoot -Path $_.FullName
    "$relative=$(Deadline-BoundFileHash $_.FullName)"
  })
  $migrationDigest = Sha256Text -Value ($migrationLines -join "`n")
  if($migrationDigest-cne[string]$releaseResult.migrationDigest-or($BackupMode-eq'LOCAL_RELEASE'-and$migrationDigest-cne[string]$config.release.migrationDigest)){throw 'BACKUP_RELEASE_MIGRATION_DIGEST_MISMATCH'}
  $expectedAppliedCanonical=@($migrationFiles|ForEach-Object{Assert-BackupDeadline;"$($_.Directory.Name)=$(Deadline-BoundFileHash $_.FullName)"}|Sort-Object)-join"`n"
  if($appliedMigrationCanonical-cne$expectedAppliedCanonical){throw 'DATABASE_MIGRATION_CHAIN_DRIFT'}
  Assert-BackupDeadline
  $dumpHash = Deadline-BoundFileHash $dumpPath $MaximumDatabaseDumpBytes
  $storageManifestHash = Deadline-BoundFileHash $storageManifestPath 268435456
  Assert-BackupDeadline;$elapsedSeconds=[int][Math]::Ceiling($script:BackupStopwatch.Elapsed.TotalSeconds)
  $createdAt = (Get-Date).ToUniversalTime().ToString('o')
  $fileCount = $storageManifest.Count
  $measured = $storageManifest | Measure-Object -Property size -Sum
  $totalBytes = if ($null -eq $measured.Sum) { [long]0 } else { [long]$measured.Sum }
  $integrityKeyId=IntegrityKeyId $BackupIntegrityKeyFile
  $executorSetDigest=Sha256Text -Value (@($ExpectedNodeSha256.ToLowerInvariant(),$ExpectedPsqlSha256.ToLowerInvariant(),$ExpectedPgDumpSha256.ToLowerInvariant())-join"`n")
  $manifestSourceRoot=if($BackupMode-eq'LEGACY_BASELINE'){[string]$legacyBaseline.legacySourceRoot}else{$dataRoot};$manifestReleaseId=[string]$releaseResult.releaseId
  $manifest = [ordered]@{
    version=5; result='COMPLETE'; backupId=$backupId; createdAt=$createdAt; rpoHours=24; rtoHours=4
    backupMode=$BackupMode;sourceDataRoot=$manifestSourceRoot; backupRoot=$backupRoot; databaseProvider='supabase_postgres';databaseProjectRef=$config.database.projectRef;databaseConnectionMode=$config.database.connectionMode;databaseHost=$databaseHost; databasePort=$databasePort; databaseName=$DatabaseName; databaseSchema=$DatabaseSchema; releaseId=$manifestReleaseId
    databaseDumpSha256=$dumpHash;databaseDumpBytes=[long]$dumpItem.Length;maximumDatabaseDumpBytes=$MaximumDatabaseDumpBytes;maximumBackupDurationSeconds=$MaximumBackupDurationSeconds;backupSafetyMarginBytes=$script:BackupSafetyMarginBytes;elapsedSeconds=$elapsedSeconds;databaseSizePreflightVerified=$true;databaseDumpRealtimeCapEnforced=$true;databaseDumpFinalCapVerified=$true;hardDeadlineEnforced=$true;processTreeKillOnDeadline=$true;incompleteStagingCleanupContract=$true; storageManifestSha256=$storageManifestHash; storageReferenceDigest=$storageReferenceDigest;storageReferenceConversionSha256=$conversionHash;storageReferenceCount=$conversionReferenceCount;storageReferenceZeroVerified=($conversionReferenceCount-eq0);legacyBaselineSha256=if($BackupMode-eq'LEGACY_BASELINE'){Deadline-BoundFileHash $LegacyBaselineEvidencePath}else{$null};legacyStorageStageEvidenceSha256=if($BackupMode-eq'LEGACY_BASELINE'){Deadline-BoundFileHash $LegacyStorageStageEvidencePath}else{$null}; migrationDigest=$migrationDigest; appliedMigrationDigest=$appliedMigrationDigest; businessKpiDigest=$kpiDigest
    targetEvidenceFingerprint=$targetFingerprint; configFingerprint=$configFingerprint; fileCount=$fileCount; totalBytes=$totalBytes; integrityAlgorithm='HMAC-SHA256'; integrityKeyId=$integrityKeyId
    nodeSha256=$ExpectedNodeSha256.ToLowerInvariant();psqlSha256=$ExpectedPsqlSha256.ToLowerInvariant();pgDumpSha256=$ExpectedPgDumpSha256.ToLowerInvariant();executorSetDigest=$executorSetDigest;filesystemEvidenceSha256=$ExpectedFileSystemEvidenceSha256.ToLowerInvariant()
  }
  $signature = HmacFile -KeyFile $BackupIntegrityKeyFile -Value (SignatureInput $manifest);$manifest.integritySignature=$signature
  Write-Utf8NoBom -Path (Join-Path $staging 'backup-manifest.json') -Value ($manifest | ConvertTo-Json -Depth 4)
  $manifestHash = Deadline-BoundFileHash (Join-Path $staging 'backup-manifest.json') 65536
  $latestUnsigned = Join-Path $receiptRoot ".latest-$backupId.unsigned"
  $latestPending = Join-Path $receiptRoot ".latest-$backupId.pending"
  Write-Utf8NoBom -Path $latestUnsigned -Value ([ordered]@{
    attestationType='backup-latest'; version=5; result='COMPLETE'; backupId=$backupId; backupMode=$BackupMode;releaseId=$manifestReleaseId; sourceDataRoot=$manifestSourceRoot; backupRoot=$backupRoot; databaseProvider='supabase_postgres';databaseProjectRef=$config.database.projectRef;databaseHost=$databaseHost;databasePort=$databasePort;databaseName=$DatabaseName; databaseSchema=$DatabaseSchema;
    migrationDigest=$migrationDigest; appliedMigrationDigest=$appliedMigrationDigest;databaseDumpBytes=[long]$dumpItem.Length;maximumDatabaseDumpBytes=$MaximumDatabaseDumpBytes;maximumBackupDurationSeconds=$MaximumBackupDurationSeconds;backupSafetyMarginBytes=$script:BackupSafetyMarginBytes;elapsedSeconds=$elapsedSeconds;databaseSizePreflightVerified=$true;databaseDumpRealtimeCapEnforced=$true;databaseDumpFinalCapVerified=$true;hardDeadlineEnforced=$true;processTreeKillOnDeadline=$true;incompleteStagingCleanupContract=$true; storageReferenceDigest=$storageReferenceDigest;storageReferenceConversionSha256=$conversionHash;storageReferenceCount=$conversionReferenceCount;storageReferenceZeroVerified=($conversionReferenceCount-eq0);legacyBaselineSha256=$manifest.legacyBaselineSha256;legacyStorageStageEvidenceSha256=$manifest.legacyStorageStageEvidenceSha256;targetEvidenceFingerprint=$targetFingerprint; configFingerprint=$configFingerprint;
    manifestSha256=$manifestHash; integrityKeyId=$integrityKeyId; integritySignature=$signature; nodeSha256=$ExpectedNodeSha256.ToLowerInvariant();psqlSha256=$ExpectedPsqlSha256.ToLowerInvariant();pgDumpSha256=$ExpectedPgDumpSha256.ToLowerInvariant();executorSetDigest=$executorSetDigest;filesystemEvidenceSha256=$ExpectedFileSystemEvidenceSha256.ToLowerInvariant(); completedAt=$createdAt
  } | ConvertTo-Json)
  Assert-PinnedFile $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH'
  Assert-PinnedFile $AttestationSignerPath $ExpectedAttestationSignerSha256 'ATTESTATION_SIGNER_HASH_MISMATCH'
  Invoke-BoundedProcess $NodePath @($AttestationSignerPath,$BackupReceiptPrivateKeyPath,$latestUnsigned,$latestPending) 300000 1048576 'BACKUP_RECEIPT_SIGNING_FAILED'|Out-Null
  if (-not (Test-Path -LiteralPath $latestPending -PathType Leaf)) { throw 'BACKUP_RECEIPT_SIGNING_FAILED' }
  Remove-DeadlineBoundBackupPath -Path $latestUnsigned
  Assert-BackupDeadline
  Assert-TreeHasNoReparsePoint -Path $staging
  [IO.Directory]::Move([IO.Path]::GetFullPath($staging),[IO.Path]::GetFullPath($final))
  Assert-BackupDeadline
  [IO.File]::Move([IO.Path]::GetFullPath($latestPending),[IO.Path]::GetFullPath($latestEvidencePath),$true)
  Assert-BackupDeadline
  [pscustomobject]@{ Result='COMPLETE'; BackupId=$backupId; FileCount=$fileCount; TotalBytes=$totalBytes } | ConvertTo-Json
} catch {
  $cleanupFailed=$false
  if (Test-Path -LiteralPath $staging) { Remove-DeadlineBoundBackupPath -Path $staging -CleanupWindow }
  if (Test-Path -LiteralPath $final) { Remove-DeadlineBoundBackupPath -Path $final -CleanupWindow }
  foreach ($pendingReceipt in @($latestUnsigned,$latestPending)) { if ($pendingReceipt -and (Test-Path -LiteralPath $pendingReceipt)) { Remove-DeadlineBoundBackupPath -Path $pendingReceipt -CleanupWindow } }
  foreach($incompleteArtifact in @($staging,$final,$latestUnsigned,$latestPending)){if($incompleteArtifact-and(Test-Path -LiteralPath $incompleteArtifact)){$cleanupFailed=$true}}
  if($cleanupFailed){throw'BACKUP_INCOMPLETE_CLEANUP_FAILED'}
  throw
}
