#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Verify')][string]$Action='Plan',
  [string]$DataRoot,[string]$BackupRoot,[string]$EvidencePath,
  [string]$NasIdentityHelperPath,[string]$ExpectedNasIdentityHelperSha256,
  [string]$CoreServiceAccount,[string]$EdgeServiceAccount,[string]$BackupWriterAccount,[string]$SignerAccount,
  [switch]$NasAdministrativelyConfirmed,[switch]$NasShareAclAdministrativelyConfirmed,
  [switch]$NasSnapshotOrVersioningConfirmed,[switch]$OfflineRotationConfirmed,
  [ValidateSet('VerifyEvidence')][string]$PlannedAction,[string]$ApprovedPlanSha256,[string]$ApprovalNonce,[string]$ApprovalIssuedAt,[string]$ApprovalExpiresAt,[string]$ApprovalInstanceId,[string]$ApprovalLedgerPath,[switch]$Approved
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
$nasIdentityHelper=if($NasIdentityHelperPath){[IO.Path]::GetFullPath($NasIdentityHelperPath)}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'nas-identity.ps1'))}
$helperCursor=if(Test-Path -LiteralPath $nasIdentityHelper -PathType Leaf){Get-Item -LiteralPath $nasIdentityHelper -Force}else{$null};while($helperCursor){if($helperCursor.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'NAS_IDENTITY_HELPER_REPARSE_REJECTED'};$helperCursor=$helperCursor.Parent}
if(-not(Test-Path -LiteralPath $nasIdentityHelper -PathType Leaf)-or$ExpectedNasIdentityHelperSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(Get-FileHash -LiteralPath $nasIdentityHelper -Algorithm SHA256).Hash-ine$ExpectedNasIdentityHelperSha256){throw 'NAS_IDENTITY_HELPER_HASH_MISMATCH'}
. $nasIdentityHelper
$systemSid='S-1-5-18';$administratorsSid='S-1-5-32-544';$backupOperatorsSid='S-1-5-32-551'
function Resolve-Sid([string]$Account){if(-not$Account){throw 'BACKUP_ACCOUNT_REQUIRED'};return([Security.Principal.NTAccount]$Account).Translate([Security.Principal.SecurityIdentifier]).Value}
function Assert-NotReparse([string]$Path){$cursor=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force;while($cursor){if($cursor.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'BACKUP_TARGET_REPARSE_REJECTED'};$cursor=$cursor.Parent}}
function Assert-UnprivilegedWriter([string]$WriterSid){
  if($WriterSid-in@($systemSid,$administratorsSid,$backupOperatorsSid)){throw 'BACKUP_WRITER_PRIVILEGED'}
  foreach($groupSid in @('S-1-5-32-544','S-1-5-32-547','S-1-5-32-548','S-1-5-32-549','S-1-5-32-550','S-1-5-32-551','S-1-5-32-555','S-1-5-32-556','S-1-5-32-562','S-1-5-32-569','S-1-5-32-573','S-1-5-32-580')){
    $members=@(Get-LocalGroupMember -SID $groupSid -ErrorAction Stop)
    foreach($member in $members){
      if($member.SID.Value-eq$WriterSid){throw 'BACKUP_WRITER_PRIVILEGED_GROUP_MEMBER'}
      if([string]$member.ObjectClass-eq'Group'){throw 'BACKUP_PRIVILEGED_GROUP_NESTING_UNVERIFIABLE'}
    }
  }
}
function Assert-ExactBackupAcl([string]$Path,[string]$CoreSid,[string]$EdgeSid,[string]$WriterSid,[string]$SignerSid){
  $acl=Get-Acl -LiteralPath $Path;$owner=$acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value
  if(-not$acl.AreAccessRulesProtected-or$owner-notin@($systemSid,$administratorsSid)){throw 'BACKUP_TARGET_ACL_PROTECTION_OR_OWNER_INVALID'}
  $expected=@($systemSid,$administratorsSid,$WriterSid,$SignerSid)|Sort-Object -Unique
  if(@($acl.Access).Count-ne4){throw 'BACKUP_TARGET_ACL_RULE_COUNT_INVALID'}
  $full=[Security.AccessControl.FileSystemRights]::FullControl;$modify=[Security.AccessControl.FileSystemRights]'Modify,Synchronize';$read=[Security.AccessControl.FileSystemRights]'ReadAndExecute,Synchronize'
  foreach($rule in $acl.Access){
    $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    $rights=if($sid-in@($systemSid,$administratorsSid)){$full}elseif($sid-eq$WriterSid){$modify}elseif($sid-eq$SignerSid){$read}else{$null}
    if($null-eq$rights-or$sid-notin$expected-or$sid-in@($CoreSid,$EdgeSid)-or$rule.AccessControlType-ne'Allow'-or$rule.FileSystemRights-ne$rights-or$rule.InheritanceFlags-ne[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'-or$rule.PropagationFlags-ne[Security.AccessControl.PropagationFlags]::None){throw 'BACKUP_TARGET_ACL_INVALID'}
  }
}
function New-BackupTargetApprovalPlan([string]$IntendedAction){if($IntendedAction-cne'VerifyEvidence'){throw 'BACKUP_TARGET_PLAN_ACTION_REQUIRED'};$canonicalRoot=Get-ApprovalPath $BackupRoot 'BACKUP_TARGET_PLAN_BACKUP_ROOT_REQUIRED';$p=[ordered]@{dataRoot=Get-ApprovalPath $DataRoot 'BACKUP_TARGET_PLAN_DATA_ROOT_REQUIRED';backupRoot=$canonicalRoot;evidencePath=Get-ApprovalPath $EvidencePath 'BACKUP_TARGET_PLAN_EVIDENCE_PATH_REQUIRED';nasIdentityHelperPath=Get-ApprovalPath $nasIdentityHelper 'BACKUP_TARGET_PLAN_NAS_HELPER_PATH_REQUIRED';nasIdentityHelperSha256=Get-ApprovalHash $ExpectedNasIdentityHelperSha256 'BACKUP_TARGET_PLAN_NAS_HELPER_HASH_REQUIRED';coreServiceAccount=Get-ApprovalText $CoreServiceAccount '^.{1,256}$' 'BACKUP_TARGET_PLAN_CORE_ACCOUNT_REQUIRED';edgeServiceAccount=Get-ApprovalText $EdgeServiceAccount '^.{1,256}$' 'BACKUP_TARGET_PLAN_EDGE_ACCOUNT_REQUIRED';backupWriterAccount=Get-ApprovalText $BackupWriterAccount '^.{1,256}$' 'BACKUP_TARGET_PLAN_WRITER_ACCOUNT_REQUIRED';signerAccount=Get-ApprovalText $SignerAccount '^.{1,256}$' 'BACKUP_TARGET_PLAN_SIGNER_ACCOUNT_REQUIRED';nasAdministrativelyConfirmed=[bool]$NasAdministrativelyConfirmed;nasShareAclAdministrativelyConfirmed=[bool]$NasShareAclAdministrativelyConfirmed;nasSnapshotOrVersioningConfirmed=[bool]$NasSnapshotOrVersioningConfirmed;offlineRotationConfirmed=[bool]$OfflineRotationConfirmed};if($canonicalRoot.StartsWith('\\')){$parts=$canonicalRoot.TrimStart('\').Split('\');$identity=Get-StableRemoteNasIdentity $parts[0] $parts[1];$p.nasServer=$identity.Server;$p.nasShare=$identity.Share;$p.nasServerIdentitySha256=$identity.IdentitySha256;$p.nasAddressCount=$identity.AddressCount};New-ApprovalPlan $PSCommandPath 'VerifyEvidence' $p 'Exact configured data root, separate disk/NAS backup root, accounts, stable remote NAS identity/helper, and evidence output' 'Performs read-only disk/NAS, local-alias rejection, encrypted transport, and ACL checks, then writes one non-secret backup-target receipt' 'Delete only the exact evidence JSON'}
if($Action-eq'Plan'){New-BackupTargetApprovalPlan $PlannedAction|ConvertTo-Json -Depth 12;exit 0};$approvalPlan=New-BackupTargetApprovalPlan 'VerifyEvidence';Assert-ApprovedPlan $approvalPlan ([bool]$Approved) $ApprovedPlanSha256
foreach($value in @($DataRoot,$BackupRoot,$EvidencePath)){if(-not$value){throw 'BACKUP_TARGET_ARGUMENT_REQUIRED'}}
$coreSid=Resolve-Sid $CoreServiceAccount;$edgeSid=Resolve-Sid $EdgeServiceAccount;$writerSid=Resolve-Sid $BackupWriterAccount;$signerSid=Resolve-Sid $SignerAccount
if(@(@($coreSid,$edgeSid,$writerSid,$signerSid)|Sort-Object -Unique).Count-ne4){throw 'SEPARATE_BACKUP_PRINCIPALS_REQUIRED'}
Assert-UnprivilegedWriter $writerSid
$data=[IO.Path]::GetFullPath($DataRoot);if(-not(Test-Path -LiteralPath $data -PathType Container)){throw 'DATA_ROOT_NOT_FOUND'};Assert-NotReparse $data
$dataVolume=Get-Volume -FilePath $data;if(-not$dataVolume.DriveLetter){throw 'DATA_VOLUME_IDENTITY_UNAVAILABLE'}
$dataPartition=Get-Partition -DriveLetter $dataVolume.DriveLetter;$dataDisk=Get-Disk -Number $dataPartition.DiskNumber
$targetType='LOCAL_DISK';$backupDisk=$null;$canonicalBackupRoot=$BackupRoot;$encryptionProof=$null;$nasServer=$null;$nasShare=$null;$nasServerIdentitySha256=$null;$nasAddressCount=$null
if($BackupRoot.StartsWith('\\')){
  if(-not$NasAdministrativelyConfirmed-or-not$NasShareAclAdministrativelyConfirmed-or-not$NasSnapshotOrVersioningConfirmed){throw 'NAS_BOUNDARY_CONFIRMATIONS_REQUIRED'}
  if($BackupRoot-notmatch'^\\\\[^\\]+\\[^\\]+(?:\\.*)?$'-or-not(Test-Path -LiteralPath $BackupRoot -PathType Container)){throw 'NAS_UNC_PATH_INVALID'}
  $targetType='NAS';$canonicalBackupRoot=$BackupRoot.TrimEnd('\');$parts=$canonicalBackupRoot.TrimStart('\').Split('\');$identity=Get-StableRemoteNasIdentity $parts[0] $parts[1];$nasServer=$identity.Server;$nasShare=$identity.Share;$nasServerIdentitySha256=$identity.IdentitySha256;$nasAddressCount=$identity.AddressCount;if($approvalPlan.exactParameters.nasServerIdentitySha256-cne$nasServerIdentitySha256-or[int]$approvalPlan.exactParameters.nasAddressCount-ne[int]$nasAddressCount-or-not$identity.LocalAliasRejected){throw 'NAS_REMOTE_IDENTITY_DRIFT'};$connections=@(Get-SmbConnection -ServerName $nasServer -ErrorAction Stop|Where-Object{$_.ShareName-ceq$nasShare});if($connections.Count-ne1-or-not$connections[0].Encrypted-or[version]$connections[0].Dialect-lt[version]'3.1.1'){throw 'NAS_ENCRYPTED_TRANSPORT_REQUIRED'};$encryptionProof='SMB_3_1_1_ENCRYPTED'
}else{
  $canonicalBackupRoot=[IO.Path]::GetFullPath($BackupRoot);if(-not(Test-Path -LiteralPath $canonicalBackupRoot -PathType Container)){throw 'BACKUP_ROOT_NOT_FOUND'};Assert-NotReparse $canonicalBackupRoot
  $backupVolume=Get-Volume -FilePath $canonicalBackupRoot;if(-not$backupVolume.DriveLetter){throw 'BACKUP_VOLUME_IDENTITY_UNAVAILABLE'}
  $backupPartition=Get-Partition -DriveLetter $backupVolume.DriveLetter;$backupDisk=Get-Disk -Number $backupPartition.DiskNumber
  if($backupDisk.Number-eq$dataDisk.Number-or($backupDisk.UniqueId-and$backupDisk.UniqueId-eq$dataDisk.UniqueId)){throw 'BACKUP_MUST_USE_DIFFERENT_PHYSICAL_DISK'}
  if($backupDisk.BusType-in@('File Backed Virtual','Virtual','RAM','Unknown')){throw 'BACKUP_DISK_TYPE_REJECTED'}
  $bitlocker=Get-BitLockerVolume -MountPoint ($backupVolume.DriveLetter+':') -ErrorAction Stop;if([string]$bitlocker.ProtectionStatus-ne'On'-or[string]$bitlocker.VolumeStatus-ne'FullyEncrypted'){throw 'BACKUP_VOLUME_ENCRYPTION_REQUIRED'};$encryptionProof='BITLOCKER_FULLY_ENCRYPTED'
  if(-not$OfflineRotationConfirmed){throw 'LOCAL_BACKUP_OFFLINE_ROTATION_CONFIRMATION_REQUIRED'}
}
Assert-ExactBackupAcl $canonicalBackupRoot $coreSid $edgeSid $writerSid $signerSid
$output=[IO.Path]::GetFullPath($EvidencePath);$parent=Split-Path -Parent $output;if(-not(Test-Path -LiteralPath $parent -PathType Container)){throw 'BACKUP_EVIDENCE_PARENT_NOT_FOUND'}
$evidence=[ordered]@{version=7;result='PASS';targetType=$targetType;dataRoot=$data;backupRoot=$canonicalBackupRoot;dataDiskNumber=$dataDisk.Number;dataDiskUniqueId=$dataDisk.UniqueId;backupDiskNumber=if($backupDisk){$backupDisk.Number}else{$null};backupDiskUniqueId=if($backupDisk){$backupDisk.UniqueId}else{$null};nasIdentityHelperPath=$nasIdentityHelper;nasIdentityHelperSha256=$ExpectedNasIdentityHelperSha256.ToLowerInvariant();nasServer=$nasServer;nasShare=$nasShare;nasServerIdentitySha256=$nasServerIdentitySha256;nasResolvedAddressCount=$nasAddressCount;nasLocalAliasRejected=($targetType-eq'NAS');backupWriterSid=$writerSid;signerReaderSid=$signerSid;appServiceDenied=$true;edgeServiceDenied=$true;separateBackupWriter=$true;separateReceiptSigner=$true;aclProtected=$true;exactAcl=$true;encryptedAtRestOrTransport=$true;encryptionProof=$encryptionProof;retentionControl=if($targetType-eq'NAS'){'SNAPSHOT_OR_VERSIONING'}else{'OFFLINE_ROTATION'};nasShareAclAdministrativelyConfirmed=($targetType-eq'NAS');completedAt=(Get-Date).ToUniversalTime().ToString('o')}
$temp=Join-Path $parent ('.backup-target-'+[Guid]::NewGuid().ToString('N')+'.tmp')
try{[IO.File]::WriteAllText($temp,($evidence|ConvertTo-Json -Depth 4),(New-Object Text.UTF8Encoding($false)));Move-Item -LiteralPath $temp -Destination $output -Force}finally{Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue}
[pscustomobject]@{Result='PASS';TargetType=$targetType;SamePhysicalDisk=$false;CoreDenied=$true;EdgeDenied=$true;ExactAcl=$true}|ConvertTo-Json
