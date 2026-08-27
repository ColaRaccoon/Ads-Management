#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Apply','Remove','Verify')][string]$Action = 'Plan',
  [string]$TaskName = 'Meta Ads Performance Daily Backup',
  [string]$PowerShellPath,
  [string]$ExpectedPowerShellSha256,
  [string]$BackupScriptPath,
  [string]$ExpectedBackupScriptSha256,
  [string]$RuntimeConfigPath,[string]$ExpectedRuntimeConfigSha256,
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
  [string]$CoreServiceAccount,
  [string]$EdgeServiceAccount,
  [string]$BackupAccount,
  [PSCredential]$BackupCredential,
  [string]$EvidenceOutputPath,
  [string]$FileSystemEvidencePath,
  [string]$ExpectedFileSystemEvidenceSha256,
  [ValidateRange(1048576,274877906944)][long]$MaximumDatabaseDumpBytes=68719476736,
  [ValidateSet(14400)][int]$MaximumBackupDurationSeconds=14400,
  [string]$PrincipalRightsEvidencePath,
  [string]$PrincipalRightsScriptPath,
  [string]$ExpectedPrincipalRightsScriptSha256,
  [ValidateSet('Apply','Remove','VerifyEvidence')][string]$PlannedAction,[string]$ApprovedPlanSha256,[switch]$Approved
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
function Digest([string]$Value){$sha=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant())}finally{$sha.Dispose()}}
function NoReparse([string]$Path){$cursor=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force;while($cursor){if($cursor.Attributes-band[IO.FileAttributes]::ReparsePoint){throw'SCHEDULE_REPARSE_REJECTED'};$cursor=$cursor.Parent}}
function Assert-Pinned([string]$Path,[string]$Expected,[string]$Code){if(-not$Path-or-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw$Code};NoReparse $Path;if($Expected-notmatch'^[A-Fa-f0-9]{64}$'-or(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash-ine$Expected){throw$Code}}
function Under([string]$Path,[string[]]$Roots){$full=[IO.Path]::GetFullPath($Path);return@($Roots|Where-Object{$root=[IO.Path]::GetFullPath([string]$_).TrimEnd('\');$full-ieq$root-or$full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)}).Count-gt0}
function Assert-PowerShell7([string]$Path,[string]$ExpectedHash){
  if(-not$Path-or-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw'POWERSHELL7_NOT_FOUND'}
  NoReparse $Path
  if($ExpectedHash-notmatch'^[A-Fa-f0-9]{64}$'-or(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash-ine$ExpectedHash){throw'POWERSHELL7_HASH_MISMATCH'}
  $major=&$Path -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.Major' 2>$null
  if($LASTEXITCODE-ne0-or[int]$major-lt7){throw'POWERSHELL7_REQUIRED'}
}

function Q([string]$Value) {
  if (-not $Value -or $Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) { throw 'SCHEDULE_ARGUMENT_REJECTED' }
  return '"' + $Value + '"'
}
function ExpectedArguments {
  return @(
    '-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',(Q $BackupScriptPath),
    '-Action','Run','-RuntimeConfigPath',(Q $RuntimeConfigPath),'-PgDumpPath',(Q $PgDumpPath),'-ExpectedPgDumpSha256',$ExpectedPgDumpSha256,'-PsqlPath',(Q $PsqlPath),'-ExpectedPsqlSha256',$ExpectedPsqlSha256,
    '-MaximumDatabaseDumpBytes',([string]$MaximumDatabaseDumpBytes),'-MaximumBackupDurationSeconds',([string]$MaximumBackupDurationSeconds),
    '-DatabaseName',(Q $DatabaseName),'-DatabaseSchema',(Q $DatabaseSchema),'-DatabaseUser',(Q $DatabaseUser),'-PgPassFile',(Q $PgPassFile),
    '-BackupIntegrityKeyFile',(Q $BackupIntegrityKeyFile),'-NodePath',(Q $NodePath),'-ExpectedNodeSha256',$ExpectedNodeSha256,'-ReleaseRoot',(Q $ReleaseRoot),
    '-ExpectedReleaseManifestSha256',$ExpectedReleaseManifestSha256,'-ReleaseVerifierPath',(Q $ReleaseVerifierPath),'-ExpectedReleaseVerifierSha256',$ExpectedReleaseVerifierSha256,
    '-AttestationSignerPath',(Q $AttestationSignerPath),'-ExpectedAttestationSignerSha256',$ExpectedAttestationSignerSha256,
    '-BackupReceiptPrivateKeyPath',(Q $BackupReceiptPrivateKeyPath),'-FileSystemEvidencePath',(Q $FileSystemEvidencePath),'-ExpectedFileSystemEvidenceSha256',$ExpectedFileSystemEvidenceSha256,'-Approved'
  ) -join ' '
}

function New-BackupScheduleApprovalPlan([string]$IntendedAction){
  if($IntendedAction-notin@('Apply','Remove','VerifyEvidence')){throw'PLANNED_ACTION_REQUIRED'}
  if($TaskName-notmatch'^[A-Za-z0-9][A-Za-z0-9 ._-]{2,127}$'){throw'SCHEDULE_PLAN_TASK_NAME_INVALID'}
  $parameters=[ordered]@{taskName=$TaskName}
  if($IntendedAction-ne'Remove'){
    $parameters.powerShellPath=Get-ApprovalPath $PowerShellPath 'SCHEDULE_PLAN_POWERSHELL_PATH_REQUIRED';$parameters.powerShellSha256=Get-ApprovalHash $ExpectedPowerShellSha256 'SCHEDULE_PLAN_POWERSHELL_HASH_REQUIRED';$parameters.backupScriptPath=Get-ApprovalPath $BackupScriptPath 'SCHEDULE_PLAN_BACKUP_SCRIPT_PATH_REQUIRED';$parameters.backupScriptSha256=Get-ApprovalHash $ExpectedBackupScriptSha256 'SCHEDULE_PLAN_BACKUP_SCRIPT_HASH_REQUIRED'
    $parameters.runtimeConfigPath=Get-ApprovalPath $RuntimeConfigPath 'SCHEDULE_PLAN_RUNTIME_PATH_REQUIRED';$parameters.runtimeConfigSha256=Get-ApprovalHash $ExpectedRuntimeConfigSha256 'SCHEDULE_PLAN_RUNTIME_HASH_REQUIRED';$parameters.pgDumpPath=Get-ApprovalPath $PgDumpPath 'SCHEDULE_PLAN_PGDUMP_PATH_REQUIRED';$parameters.pgDumpSha256=Get-ApprovalHash $ExpectedPgDumpSha256 'SCHEDULE_PLAN_PGDUMP_HASH_REQUIRED';$parameters.psqlPath=Get-ApprovalPath $PsqlPath 'SCHEDULE_PLAN_PSQL_PATH_REQUIRED';$parameters.psqlSha256=Get-ApprovalHash $ExpectedPsqlSha256 'SCHEDULE_PLAN_PSQL_HASH_REQUIRED'
    $parameters.databaseName=Get-ApprovalText $DatabaseName '^[a-z][a-z0-9_]{0,62}$' 'SCHEDULE_PLAN_DATABASE_NAME_INVALID';$parameters.databaseSchema=Get-ApprovalText $DatabaseSchema '^[a-z][a-z0-9_]{0,62}$' 'SCHEDULE_PLAN_DATABASE_SCHEMA_INVALID';$parameters.databaseUser=Get-ApprovalText $DatabaseUser '^[a-z][a-z0-9_]{0,62}$' 'SCHEDULE_PLAN_DATABASE_USER_INVALID';$parameters.pgPassPath=Get-ApprovalPath $PgPassFile 'SCHEDULE_PLAN_PGPASS_PATH_REQUIRED';$parameters.backupIntegrityKeyPath=Get-ApprovalPath $BackupIntegrityKeyFile 'SCHEDULE_PLAN_INTEGRITY_KEY_PATH_REQUIRED';$parameters.backupReceiptPrivateKeyPath=Get-ApprovalPath $BackupReceiptPrivateKeyPath 'SCHEDULE_PLAN_RECEIPT_KEY_PATH_REQUIRED'
    $parameters.nodePath=Get-ApprovalPath $NodePath 'SCHEDULE_PLAN_NODE_PATH_REQUIRED';$parameters.nodeSha256=Get-ApprovalHash $ExpectedNodeSha256 'SCHEDULE_PLAN_NODE_HASH_REQUIRED';$parameters.releaseRoot=Get-ApprovalPath $ReleaseRoot 'SCHEDULE_PLAN_RELEASE_ROOT_REQUIRED';$parameters.releaseManifestSha256=Get-ApprovalHash $ExpectedReleaseManifestSha256 'SCHEDULE_PLAN_RELEASE_HASH_REQUIRED';$parameters.releaseVerifierPath=Get-ApprovalPath $ReleaseVerifierPath 'SCHEDULE_PLAN_RELEASE_VERIFIER_PATH_REQUIRED';$parameters.releaseVerifierSha256=Get-ApprovalHash $ExpectedReleaseVerifierSha256 'SCHEDULE_PLAN_RELEASE_VERIFIER_HASH_REQUIRED';$parameters.attestationSignerPath=Get-ApprovalPath $AttestationSignerPath 'SCHEDULE_PLAN_SIGNER_PATH_REQUIRED';$parameters.attestationSignerSha256=Get-ApprovalHash $ExpectedAttestationSignerSha256 'SCHEDULE_PLAN_SIGNER_HASH_REQUIRED'
    $parameters.coreServiceAccount=$CoreServiceAccount;$parameters.edgeServiceAccount=$EdgeServiceAccount;$parameters.backupAccount=$BackupAccount;$parameters.filesystemEvidencePath=Get-ApprovalPath $FileSystemEvidencePath 'SCHEDULE_PLAN_FILESYSTEM_PATH_REQUIRED';$parameters.filesystemEvidenceSha256=Get-ApprovalHash $ExpectedFileSystemEvidenceSha256 'SCHEDULE_PLAN_FILESYSTEM_HASH_REQUIRED';$parameters.principalRightsEvidencePath=Get-ApprovalPath $PrincipalRightsEvidencePath 'SCHEDULE_PLAN_RIGHTS_PATH_REQUIRED';$parameters.principalRightsScriptPath=Get-ApprovalPath $PrincipalRightsScriptPath 'SCHEDULE_PLAN_RIGHTS_SCRIPT_PATH_REQUIRED';$parameters.principalRightsScriptSha256=Get-ApprovalHash $ExpectedPrincipalRightsScriptSha256 'SCHEDULE_PLAN_RIGHTS_SCRIPT_HASH_REQUIRED';$parameters.maximumDatabaseDumpBytes=$MaximumDatabaseDumpBytes;$parameters.maximumBackupDurationSeconds=$MaximumBackupDurationSeconds;$parameters.recurringInvocationSha256=Digest (ExpectedArguments)
    if($IntendedAction-eq'VerifyEvidence'){$parameters.evidenceOutputPath=Get-ApprovalPath $EvidenceOutputPath 'SCHEDULE_PLAN_EVIDENCE_PATH_REQUIRED'}
  }
  $target=if($IntendedAction-eq'Remove'){"Exact Windows scheduled task $TaskName"}else{"Exact daily backup task $TaskName using recurring invocation $($parameters.recurringInvocationSha256)"}
  $impact=if($IntendedAction-eq'Apply'){'Registers one enabled daily task under the exact backup account and delegates only the canonical recurring backup invocation'}elseif($IntendedAction-eq'Remove'){'Unregisters only the exact task; backup payload is retained'}else{'Verifies the exact enabled daily trigger and writes only the exact evidence output'}
  $rollback=if($IntendedAction-eq'Apply'){'Use a separately approved Remove plan for the exact task'}elseif($IntendedAction-eq'Remove'){'Recreate only through a new exact Apply plan'}else{'Delete only the exact evidence output'}
  return New-ApprovalPlan $PSCommandPath $IntendedAction $parameters $target $impact $rollback
}

if($Action -eq 'Plan') {
  New-BackupScheduleApprovalPlan $PlannedAction|ConvertTo-Json -Depth 12;exit 0
}
$scheduleMutation=if($Action-in@('Apply','Remove')){$Action}elseif($Action-eq'Verify'-and$EvidenceOutputPath){'VerifyEvidence'}else{$null};if($scheduleMutation){Assert-ApprovedPlan (New-BackupScheduleApprovalPlan $scheduleMutation) ([bool]$Approved) $ApprovedPlanSha256}
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if($Action -eq 'Verify') {
  foreach($file in @($NodePath,$PsqlPath,$PgDumpPath,$ReleaseVerifierPath,$AttestationSignerPath,$FileSystemEvidencePath,$RuntimeConfigPath)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw'SCHEDULE_REQUIRED_FILE_NOT_FOUND'};NoReparse $file}
  Assert-Pinned $RuntimeConfigPath $ExpectedRuntimeConfigSha256 'RUNTIME_CONFIG_HASH_MISMATCH'
  Assert-Pinned $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH';Assert-Pinned $PsqlPath $ExpectedPsqlSha256 'PSQL_HASH_MISMATCH';Assert-Pinned $PgDumpPath $ExpectedPgDumpSha256 'PG_DUMP_HASH_MISMATCH'
  Assert-Pinned $FileSystemEvidencePath $ExpectedFileSystemEvidenceSha256 'FILESYSTEM_EVIDENCE_HASH_MISMATCH'
  $fs=Get-Content -Raw -LiteralPath $FileSystemEvidencePath|ConvertFrom-Json;$scheduleExecutors=@($NodePath,$PsqlPath,$PgDumpPath,$ReleaseVerifierPath,$AttestationSignerPath);if($fs.result-ne'PASS'-or-not$fs.exactAcl-or@($scheduleExecutors|Where-Object{-not(Under $_ $fs.classRoots.SHARED_RUNTIME)}).Count){throw'SCHEDULE_EXECUTOR_OUTSIDE_SHARED_RUNTIME'}
  Assert-PowerShell7 $PowerShellPath $ExpectedPowerShellSha256
  if($ExpectedReleaseManifestSha256-notmatch'^[A-Fa-f0-9]{64}$'-or$ExpectedReleaseVerifierSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(Get-FileHash -LiteralPath $ReleaseVerifierPath -Algorithm SHA256).Hash-ine$ExpectedReleaseVerifierSha256){throw'RELEASE_PINNING_INVALID'}
  Assert-Pinned $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH';Assert-Pinned $ReleaseVerifierPath $ExpectedReleaseVerifierSha256 'RELEASE_PINNING_INVALID';&$NodePath $ReleaseVerifierPath "--root=$([IO.Path]::GetFullPath($ReleaseRoot))" "--manifest-sha256=$ExpectedReleaseManifestSha256" 2>$null|Out-Null;if($LASTEXITCODE-ne0){throw'RELEASE_VERIFICATION_FAILED'}
  if(-not $task){ [pscustomobject]@{Result='FAIL';Reason='MISSING'}|ConvertTo-Json; exit 1 }
  $config=Get-Content -Raw -LiteralPath $RuntimeConfigPath|ConvertFrom-Json
  $expectedTime=[datetime]::ParseExact($config.backup.dailyTime,'HH:mm',$null).TimeOfDay
  $taskInfo=Get-ScheduledTaskInfo -TaskName $TaskName
  $backupSid=([Security.Principal.NTAccount]$BackupAccount).Translate([Security.Principal.SecurityIdentifier]).Value
  $rights=Get-Content -Raw -LiteralPath $PrincipalRightsEvidencePath|ConvertFrom-Json
  if($rights.version-ne3-or$rights.result-ne'PASS'-or-not$rights.exactRights-or$rights.backupPrincipalDigest-cne(Digest $backupSid)){throw'PRINCIPAL_RIGHTS_EVIDENCE_REJECTED'}
  if($ExpectedPrincipalRightsScriptSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(Get-FileHash -LiteralPath $PrincipalRightsScriptPath -Algorithm SHA256).Hash-ine$ExpectedPrincipalRightsScriptSha256){throw'PRINCIPAL_RIGHTS_SCRIPT_HASH_MISMATCH'}
  &$PrincipalRightsScriptPath -Action Verify -CoreServiceAccount $CoreServiceAccount -EdgeServiceAccount $EdgeServiceAccount -BackupAccount $BackupAccount 2>$null|Out-Null
  $taskSid=([Security.Principal.NTAccount]$task.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value
  $triggerClass=[string]$task.Triggers[0].CimClass.CimClassName
  $pass=@($task.Actions).Count -eq 1 -and $task.Actions[0].Execute -ieq [IO.Path]::GetFullPath($PowerShellPath) -and
    $task.Actions[0].Arguments -ceq (ExpectedArguments) -and $taskSid -eq $backupSid -and $task.State -ne 'Disabled' -and
    $task.Principal.RunLevel -eq 'Limited' -and @($task.Triggers).Count -eq 1 -and $task.Triggers[0].StartBoundary -and
    $triggerClass -ceq 'MSFT_TaskDailyTrigger' -and $task.Triggers[0].Enabled -eq $true -and [int]$task.Triggers[0].DaysInterval -eq 1 -and
    ([datetime]$task.Triggers[0].StartBoundary).TimeOfDay -eq $expectedTime -and
    $task.Settings.StartWhenAvailable -and $task.Settings.MultipleInstances -eq 'IgnoreNew' -and
    $task.Settings.ExecutionTimeLimit -eq 'PT4H' -and
    (Get-FileHash -LiteralPath $BackupScriptPath -Algorithm SHA256).Hash -ieq $ExpectedBackupScriptSha256 -and
    (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash -ieq $ExpectedNodeSha256 -and
    (Get-FileHash -LiteralPath $PsqlPath -Algorithm SHA256).Hash -ieq $ExpectedPsqlSha256 -and
    (Get-FileHash -LiteralPath $PgDumpPath -Algorithm SHA256).Hash -ieq $ExpectedPgDumpSha256 -and
    (Get-FileHash -LiteralPath $AttestationSignerPath -Algorithm SHA256).Hash -ieq $ExpectedAttestationSignerSha256 -and
    (Get-FileHash -LiteralPath $ReleaseVerifierPath -Algorithm SHA256).Hash -ieq $ExpectedReleaseVerifierSha256
  if($pass -and $EvidenceOutputPath){
    $executorSetDigest=Digest (@($ExpectedNodeSha256.ToLowerInvariant(),$ExpectedPsqlSha256.ToLowerInvariant(),$ExpectedPgDumpSha256.ToLowerInvariant())-join"`n")
    [IO.File]::WriteAllText($EvidenceOutputPath,([ordered]@{version=5;result='PASS';taskName=$TaskName;dailyTime=$config.backup.dailyTime;dailyTriggerVerified=$true;dailyTriggerEnabled=$true;daysInterval=1;runtimeConfigSha256=$ExpectedRuntimeConfigSha256.ToLowerInvariant();runtimeReadinessBound=$true;recurringInvocationPlanBound=$true;maximumDatabaseDumpBytes=$MaximumDatabaseDumpBytes;maximumBackupDurationSeconds=$MaximumBackupDurationSeconds;backupSafetyMarginBytes=[long]1073741824;databaseSizePreflightRequired=$true;databaseDumpRealtimeCapRequired=$true;databaseDumpFinalCapRequired=$true;hardDeadlineRequired=$true;processTreeKillOnDeadlineRequired=$true;incompleteStagingCleanupRequired=$true;backupSid=$backupSid;separatePrincipal=$true;powerShell7Verified=$true;powerShellPath=[IO.Path]::GetFullPath($PowerShellPath);powerShellSha256=$ExpectedPowerShellSha256.ToLowerInvariant();actionArgumentsSha256=(Digest (ExpectedArguments));backupScriptSha256=$ExpectedBackupScriptSha256.ToLowerInvariant();releaseVerifierSha256=$ExpectedReleaseVerifierSha256.ToLowerInvariant();releaseManifestSha256=$ExpectedReleaseManifestSha256.ToLowerInvariant();attestationSignerSha256=$ExpectedAttestationSignerSha256.ToLowerInvariant();nodeSha256=$ExpectedNodeSha256.ToLowerInvariant();psqlSha256=$ExpectedPsqlSha256.ToLowerInvariant();pgDumpSha256=$ExpectedPgDumpSha256.ToLowerInvariant();executorSetDigest=$executorSetDigest;filesystemEvidenceSha256=$ExpectedFileSystemEvidenceSha256.ToLowerInvariant();scriptHashVerified=$true;signerHashVerified=$true;executorHashesVerified=$true;enabled=$true;startWhenAvailable=$true;lastObservedResult=$taskInfo.LastTaskResult;lastObservedRunAt=if($taskInfo.LastRunTime.Year-gt2000){$taskInfo.LastRunTime.ToUniversalTime().ToString('o')}else{$null};completedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
  }
  [pscustomobject]@{Result=if($pass){'PASS'}else{'FAIL'};LastTaskResult=$taskInfo.LastTaskResult;NextRunTime=$taskInfo.NextRunTime}|ConvertTo-Json
  if(-not $pass){exit 1}; exit 0
}
if($Action -eq 'Remove'){
  if($task){Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false}
  [pscustomobject]@{Result='REMOVED';BackupsRemoved=$false}|ConvertTo-Json; exit 0
}
if($task){throw 'BACKUP_TASK_ALREADY_EXISTS'}
Assert-PowerShell7 $PowerShellPath $ExpectedPowerShellSha256
Assert-Pinned $RuntimeConfigPath $ExpectedRuntimeConfigSha256 'RUNTIME_CONFIG_HASH_MISMATCH'
foreach($file in @($PowerShellPath,$BackupScriptPath,$RuntimeConfigPath,$PgDumpPath,$PsqlPath,$PgPassFile,$BackupIntegrityKeyFile,$NodePath,$ReleaseVerifierPath,$AttestationSignerPath,$BackupReceiptPrivateKeyPath,$FileSystemEvidencePath,$PrincipalRightsEvidencePath,$PrincipalRightsScriptPath)) {
  if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'SCHEDULE_REQUIRED_FILE_NOT_FOUND'}
  NoReparse $file
}
Assert-Pinned $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH';Assert-Pinned $PsqlPath $ExpectedPsqlSha256 'PSQL_HASH_MISMATCH';Assert-Pinned $PgDumpPath $ExpectedPgDumpSha256 'PG_DUMP_HASH_MISMATCH'
Assert-Pinned $FileSystemEvidencePath $ExpectedFileSystemEvidenceSha256 'FILESYSTEM_EVIDENCE_HASH_MISMATCH'
if($ExpectedBackupScriptSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or (Get-FileHash -LiteralPath $BackupScriptPath -Algorithm SHA256).Hash -ine $ExpectedBackupScriptSha256){throw 'BACKUP_SCRIPT_HASH_MISMATCH'}
if($ExpectedAttestationSignerSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or (Get-FileHash -LiteralPath $AttestationSignerPath -Algorithm SHA256).Hash -ine $ExpectedAttestationSignerSha256){throw 'ATTESTATION_SIGNER_HASH_MISMATCH'}
if(-not(Test-Path -LiteralPath $ReleaseRoot -PathType Container)-or$ExpectedReleaseManifestSha256-notmatch'^[A-Fa-f0-9]{64}$'-or$ExpectedReleaseVerifierSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(Get-FileHash -LiteralPath $ReleaseVerifierPath -Algorithm SHA256).Hash-ine$ExpectedReleaseVerifierSha256){throw 'RELEASE_PINNING_INVALID'}
Assert-Pinned $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH';Assert-Pinned $ReleaseVerifierPath $ExpectedReleaseVerifierSha256 'RELEASE_PINNING_INVALID';&$NodePath $ReleaseVerifierPath "--root=$([IO.Path]::GetFullPath($ReleaseRoot))" "--manifest-sha256=$ExpectedReleaseManifestSha256" 2>$null|Out-Null;if($LASTEXITCODE-ne0){throw'RELEASE_VERIFICATION_FAILED'}
if(-not $BackupCredential -or -not$BackupAccount -or $BackupCredential.UserName -ine $BackupAccount){throw 'SEPARATE_BACKUP_CREDENTIAL_REQUIRED'}
if($BackupAccount-notmatch'^([^\\]+)\\([^\\]+)$'-or$Matches[1]-ine$env:COMPUTERNAME){throw 'LOCAL_BACKUP_ACCOUNT_REQUIRED'}
$localBackup=Get-LocalUser -Name $Matches[2] -ErrorAction Stop;if(-not$localBackup.Enabled){throw 'LOCAL_BACKUP_ACCOUNT_DISABLED'}
$coreSid=([Security.Principal.NTAccount]$CoreServiceAccount).Translate([Security.Principal.SecurityIdentifier]).Value
$edgeSid=([Security.Principal.NTAccount]$EdgeServiceAccount).Translate([Security.Principal.SecurityIdentifier]).Value
$backupSid=([Security.Principal.NTAccount]$BackupAccount).Translate([Security.Principal.SecurityIdentifier]).Value
if(@(@($coreSid,$edgeSid,$backupSid)|Sort-Object -Unique).Count-ne3){throw 'SEPARATE_SERVICE_CREDENTIALS_REQUIRED'}
foreach($groupSid in @('S-1-5-32-544','S-1-5-32-547','S-1-5-32-548','S-1-5-32-549','S-1-5-32-550','S-1-5-32-551','S-1-5-32-555','S-1-5-32-556','S-1-5-32-562','S-1-5-32-569','S-1-5-32-573','S-1-5-32-580')){foreach($member in @(Get-LocalGroupMember -SID $groupSid -ErrorAction Stop)){if($member.SID.Value-eq$backupSid){throw 'BACKUP_ACCOUNT_PRIVILEGED'};if([string]$member.ObjectClass-eq'Group'){throw 'PRIVILEGED_GROUP_NESTING_UNVERIFIABLE'}}}
if($DatabaseName -notmatch '^[a-z][a-z0-9_]{0,62}$' -or $DatabaseSchema -notmatch '^[a-z][a-z0-9_]{0,62}$' -or $DatabaseUser -notmatch '^[a-z][a-z0-9_]{0,62}$'){throw 'DATABASE_IDENTITY_REJECTED'}
$config=Get-Content -Raw -LiteralPath $RuntimeConfigPath|ConvertFrom-Json
if(-not $config.backup.root -or -not $config.backup.dailyTime -or -not(Test-Path -LiteralPath $config.backup.physicalTargetEvidencePath)){throw 'VERIFIED_BACKUP_CONFIGURATION_REQUIRED'}
$backupEvidence=Get-Content -Raw -LiteralPath $config.backup.physicalTargetEvidencePath|ConvertFrom-Json
if($backupEvidence.version-ne5-or$backupEvidence.result -ne 'PASS' -or$backupEvidence.backupWriterSid-ne$backupSid-or-not $backupEvidence.appServiceDenied -or -not $backupEvidence.edgeServiceDenied -or -not $backupEvidence.separateBackupWriter -or -not $backupEvidence.aclProtected -or -not $backupEvidence.exactAcl-or-not$backupEvidence.encryptedAtRestOrTransport){throw 'BACKUP_TARGET_SEPARATION_REQUIRED'}
$fs=Get-Content -Raw -LiteralPath $FileSystemEvidencePath|ConvertFrom-Json
if($fs.result-ne'PASS'-or$fs.coreServiceSid-ne$coreSid-or$fs.edgeServiceSid-ne$edgeSid-or$fs.backupSid-ne$backupSid){throw 'FILESYSTEM_EVIDENCE_PRINCIPAL_MISMATCH'}
$rights=Get-Content -Raw -LiteralPath $PrincipalRightsEvidencePath|ConvertFrom-Json
if($rights.version-ne3-or$rights.result-ne'PASS'-or-not$rights.exactRights-or$rights.corePrincipalDigest-cne(Digest $coreSid)-or$rights.edgePrincipalDigest-cne(Digest $edgeSid)-or$rights.backupPrincipalDigest-cne(Digest $backupSid)){throw'PRINCIPAL_RIGHTS_EVIDENCE_REJECTED'}
if($ExpectedPrincipalRightsScriptSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(Get-FileHash -LiteralPath $PrincipalRightsScriptPath -Algorithm SHA256).Hash-ine$ExpectedPrincipalRightsScriptSha256){throw'PRINCIPAL_RIGHTS_SCRIPT_HASH_MISMATCH'}
&$PrincipalRightsScriptPath -Action Verify -CoreServiceAccount $CoreServiceAccount -EdgeServiceAccount $EdgeServiceAccount -BackupAccount $BackupAccount 2>$null|Out-Null
$shared=@($fs.classRoots.SHARED_RUNTIME|ForEach-Object{[IO.Path]::GetFullPath([string]$_).TrimEnd('\')})
$backupOnly=@($fs.classRoots.BACKUP_ONLY|ForEach-Object{[IO.Path]::GetFullPath([string]$_).TrimEnd('\')})
foreach($executable in @($BackupScriptPath,$RuntimeConfigPath,$PgDumpPath,$PsqlPath,$NodePath,$ReleaseVerifierPath,$AttestationSignerPath,$PrincipalRightsScriptPath)){if(-not(Under $executable $shared)){throw 'BACKUP_EXECUTOR_NOT_HASH_PINNED_SHARED_RUNTIME'}}
if(-not(Under $ReleaseRoot $shared)){throw 'BACKUP_RELEASE_NOT_IN_SHARED_RUNTIME'}
if(-not(Under $PrincipalRightsEvidencePath @($fs.classRoots.ADMIN_EVIDENCE))){throw'PRINCIPAL_RIGHTS_EVIDENCE_OUTSIDE_ADMIN_EVIDENCE'}
foreach($secret in @($PgPassFile,$BackupIntegrityKeyFile,$BackupReceiptPrivateKeyPath)){if(-not(Under $secret $backupOnly)){throw 'BACKUP_SECRET_NOT_IN_BACKUP_ONLY_ROOT'}}
$actionObject=New-ScheduledTaskAction -Execute ([IO.Path]::GetFullPath($PowerShellPath)) -Argument (ExpectedArguments)
$trigger=New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($config.backup.dailyTime,'HH:mm',$null))
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 4) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$password=$BackupCredential.GetNetworkCredential().Password
try {
  Register-ScheduledTask -TaskName $TaskName -Action $actionObject -Trigger $trigger -Settings $settings -User $BackupCredential.UserName -Password $password -RunLevel Limited | Out-Null
} finally { $password=$null }
[pscustomobject]@{Result='APPLIED';RPOHours=24;PrincipalSeparated=$true;FirstSuccessfulBackupRequired=$true}|ConvertTo-Json
