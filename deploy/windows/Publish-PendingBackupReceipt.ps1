#Requires -Version 7.2
[CmdletBinding()]
param(
  [string]$ExpectedPublisherBrokerSha256,
  [string]$PowerShellPath,[string]$ExpectedPowerShellSha256,
  [string]$RuntimeConfigPath,[string]$ExpectedRuntimeConfigSha256,[string]$FileSystemEvidencePath,[string]$ExpectedFileSystemEvidenceSha256,
  [string]$NodePath,[string]$ExpectedNodeSha256,[string]$ReceiptPublisherPath,[string]$ExpectedReceiptPublisherSha256,
  [string]$SemanticSignerPath,[string]$ExpectedSemanticSignerSha256,[string]$BackupIntegrityKeyFile,[string]$ExpectedBackupIntegrityKeySha256,
  [string]$BackupReceiptPrivateKeyPath,[string]$ExpectedBackupReceiptPrivateKeySha256,[string]$ExpectedBackupTargetFingerprint,[string]$ExpectedBackupContractSha256,
  [string]$ExpectedPgPassSha256,[string]$ExpectedNasIdentityHelperSha256,[string]$SignerAccount,
  [string]$ScheduledAuthorizationPath,[string]$ExpectedScheduledAuthorizationSha256,[string]$ScheduleAuthorizationPublicKeyPath,[string]$ExpectedScheduleAuthorizationPublicKeySha256,
  [string]$AttestationVerifierPath,[string]$ExpectedAttestationVerifierSha256,[string]$SignerScratchRoot,[string]$SignerReplayLedgerRoot
)
$ErrorActionPreference='Stop'
function Hash([string]$Path){return(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function HashText([string]$Value){$sha=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant())}finally{$sha.Dispose()}}
function NoReparse([string]$Path){$cursor=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force;while($cursor){if($cursor.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'BACKUP_BROKER_REPARSE_REJECTED'};$cursor=$cursor.Parent}}
function Pinned([string]$Path,[string]$Expected,[string]$Code){if(-not$Path-or-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw $Code};$full=[IO.Path]::GetFullPath($Path);NoReparse $full;if($Expected-notmatch'^[a-fA-F0-9]{64}$'-or(Hash $full)-cne$Expected.ToLowerInvariant()){throw $Code};return $full}
function ReadJson([string]$Path,[string]$Code){$item=Get-Item -LiteralPath $Path -Force;if($item.PSIsContainer-or$item.Length-lt1-or$item.Length-gt1048576-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)){throw $Code};try{return Get-Content -Raw -LiteralPath $item.FullName|ConvertFrom-Json}catch{throw $Code}}
function Stop-Tree($Process){if($Process-and-not$Process.HasExited){$Process.Kill($true);if(-not$Process.WaitForExit(5000)){throw 'BACKUP_BROKER_PROCESS_TREE_KILL_TIMEOUT'}}}
function Invoke-Publisher([string[]]$Arguments){
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$script:PowerShell;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  foreach($name in @('DATABASE_URL','PGPASSWORD','PGPASSFILE','PGSSLMODE','PGSSLROOTCERT','PGOPTIONS')){$info.Environment.Remove($name)|Out-Null};foreach($argument in $Arguments){$info.ArgumentList.Add($argument)}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$watch=[Diagnostics.Stopwatch]::StartNew();try{if(-not$process.Start()){throw 'BACKUP_BROKER_PUBLISH_START_FAILED'};$stdoutTask=$process.StandardOutput.ReadToEndAsync();$stderrTask=$process.StandardError.ReadToEndAsync();while(-not$process.WaitForExit(250)){if($watch.Elapsed.TotalHours-ge4){Stop-Tree $process;throw 'BACKUP_BROKER_PUBLISH_TIMEOUT'}};$stdout=$stdoutTask.GetAwaiter().GetResult();$stderr=$stderrTask.GetAwaiter().GetResult();if(($stdout.Length+$stderr.Length)-gt1048576){throw 'BACKUP_BROKER_OUTPUT_LIMIT'};if($process.ExitCode-ne0){throw 'BACKUP_BROKER_PUBLISH_FAILED'};return $stdout.Trim()}finally{Stop-Tree $process;$process.Dispose();$watch.Stop()}
}

if($ExpectedPublisherBrokerSha256-notmatch'^[a-fA-F0-9]{64}$'-or(Hash $PSCommandPath)-cne$ExpectedPublisherBrokerSha256.ToLowerInvariant()){throw 'BACKUP_BROKER_SELF_HASH_MISMATCH'}
$script:PowerShell=Pinned $PowerShellPath $ExpectedPowerShellSha256 'BACKUP_BROKER_POWERSHELL_HASH_MISMATCH'
$publisher=Pinned $ReceiptPublisherPath $ExpectedReceiptPublisherSha256 'BACKUP_BROKER_PUBLISHER_HASH_MISMATCH'
$runtime=Pinned $RuntimeConfigPath $ExpectedRuntimeConfigSha256 'BACKUP_BROKER_RUNTIME_HASH_MISMATCH'
$scheduled=Pinned $ScheduledAuthorizationPath $ExpectedScheduledAuthorizationSha256 'BACKUP_BROKER_AUTHORIZATION_HASH_MISMATCH'
$config=ReadJson $runtime 'BACKUP_BROKER_RUNTIME_INVALID';$authorization=ReadJson $scheduled 'BACKUP_BROKER_AUTHORIZATION_INVALID'
if($authorization.attestationType-cne'backup-schedule-authorization'-or$authorization.version-ne3-or$authorization.authorizationInstanceId-notmatch'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'){throw 'BACKUP_BROKER_AUTHORIZATION_INVALID'}
if(-not$config.backup.root){throw 'BACKUP_BROKER_ROOT_REQUIRED'};$backupRoot=[IO.Path]::GetFullPath([string]$config.backup.root);NoReparse $backupRoot;$replayRoot=[IO.Path]::GetFullPath($SignerReplayLedgerRoot);NoReparse $replayRoot
$candidates=New-Object 'System.Collections.Generic.List[object]';$count=0
foreach($directory in [IO.Directory]::EnumerateDirectories($backupRoot)){
  $count++;if($count-gt10000){throw 'BACKUP_BROKER_DIRECTORY_LIMIT'};$item=Get-Item -LiteralPath $directory -Force;if($item.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'BACKUP_BROKER_REPARSE_REJECTED'}
  $backupId=$item.Name;if($backupId-notmatch'^[0-9A-Za-z-]{20,80}$'){continue};$requestPath=Join-Path $item.FullName 'receipt-request.json';if(-not(Test-Path -LiteralPath $requestPath -PathType Leaf)){continue};NoReparse $requestPath
  $requestSha=Hash $requestPath;$recordId=HashText "$($authorization.authorizationInstanceId)`n$requestSha";$record=Join-Path $replayRoot ($recordId+'.consumed');if(Test-Path -LiteralPath $record){continue}
  $candidates.Add([pscustomobject]@{BackupId=$backupId;RequestSha256=$requestSha;LastWriteTimeUtc=$item.LastWriteTimeUtc})
}
if($candidates.Count-eq0){[pscustomobject]@{Result='NO_PENDING';SecretMaterialEmitted=$false}|ConvertTo-Json;exit 0}
$candidate=@($candidates|Sort-Object LastWriteTimeUtc,BackupId)[0]
$arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',$publisher,'-Action','Publish','-AuthorizationMode','Scheduled','-RuntimeConfigPath',$RuntimeConfigPath,'-ExpectedRuntimeConfigSha256',$ExpectedRuntimeConfigSha256,'-FileSystemEvidencePath',$FileSystemEvidencePath,'-ExpectedFileSystemEvidenceSha256',$ExpectedFileSystemEvidenceSha256,'-NodePath',$NodePath,'-ExpectedNodeSha256',$ExpectedNodeSha256,'-SemanticSignerPath',$SemanticSignerPath,'-ExpectedSemanticSignerSha256',$ExpectedSemanticSignerSha256,'-BackupIntegrityKeyFile',$BackupIntegrityKeyFile,'-ExpectedBackupIntegrityKeySha256',$ExpectedBackupIntegrityKeySha256,'-BackupReceiptPrivateKeyPath',$BackupReceiptPrivateKeyPath,'-ExpectedBackupReceiptPrivateKeySha256',$ExpectedBackupReceiptPrivateKeySha256,'-BackupId',$candidate.BackupId,'-ExpectedReceiptRequestSha256',$candidate.RequestSha256,'-ExpectedBackupTargetFingerprint',$ExpectedBackupTargetFingerprint,'-ExpectedBackupContractSha256',$ExpectedBackupContractSha256,'-ExpectedPgPassSha256',$ExpectedPgPassSha256,'-ExpectedNasIdentityHelperSha256',$ExpectedNasIdentityHelperSha256,'-SignerAccount',$SignerAccount,'-ScheduledAuthorizationPath',$ScheduledAuthorizationPath,'-ExpectedScheduledAuthorizationSha256',$ExpectedScheduledAuthorizationSha256,'-ScheduleAuthorizationPublicKeyPath',$ScheduleAuthorizationPublicKeyPath,'-ExpectedScheduleAuthorizationPublicKeySha256',$ExpectedScheduleAuthorizationPublicKeySha256,'-AttestationVerifierPath',$AttestationVerifierPath,'-ExpectedAttestationVerifierSha256',$ExpectedAttestationVerifierSha256,'-SignerScratchRoot',$SignerScratchRoot,'-SignerReplayLedgerRoot',$SignerReplayLedgerRoot)
[void](Invoke-Publisher $arguments)
[pscustomobject]@{Result='PUBLISHED';BackupId=$candidate.BackupId;IndependentSigner=$true;SecretMaterialEmitted=$false}|ConvertTo-Json
