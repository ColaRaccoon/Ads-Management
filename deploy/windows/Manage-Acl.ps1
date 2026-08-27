#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Apply','Rollback','Verify')][string]$Action='Plan',
  [string]$CoreServiceAccount,[string]$EdgeServiceAccount,[string]$BackupAccount,[string]$SignerAccount,
  [string]$ApprovedDataRoot,
  [string[]]$CoreModifyRoots,[string[]]$CoreReadOnlyRoots,
  [string[]]$EdgeModifyRoots,[string[]]$EdgeReadOnlyRoots,
  [string[]]$SharedRuntimeRoots,[string[]]$AdminEvidenceRoots,[string[]]$BackupReceiptRoots,
  [string[]]$BackupOnlyRoots,[string[]]$SignerOnlyRoots,[string[]]$AdminOnlyRoots,
  [string]$AclBackupPath,[string]$ExpectedAclBackupSha256,[string]$ExpectedAclBackupManifestSha256,[string]$ExpectedOwnerBackupSha256,[string]$EvidenceOutputPath,
  [ValidateSet('Apply','Rollback','VerifyEvidence')][string]$PlannedAction,[string]$ApprovedPlanSha256,[string]$ApprovalNonce,[string]$ApprovalIssuedAt,[string]$ApprovalExpiresAt,[string]$ApprovalInstanceId,[string]$ApprovalLedgerPath,[switch]$Approved
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
$systemSid='S-1-5-18';$administratorsSid='S-1-5-32-544'
$broadSids=@('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-15-2-1')

function Sid([string]$Account){if(-not$Account){throw 'ACL_ACCOUNT_REQUIRED'};return([Security.Principal.NTAccount]$Account).Translate([Security.Principal.SecurityIdentifier]).Value}
function NoReparseAncestors([string]$Path){$cursor=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force;while($cursor){if($cursor.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'ACL_ANCESTOR_REPARSE_REJECTED'};$cursor=$cursor.Parent}}
function SafeRoot([string]$Value){
  if(-not[IO.Path]::IsPathFullyQualified($Value)){throw 'APPROVED_DATA_ROOT_MUST_BE_ABSOLUTE'}
  $root=[IO.Path]::GetFullPath($Value).TrimEnd('\');$repositoryRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\');$forbidden=@([IO.Path]::GetPathRoot($root).TrimEnd('\'),[Environment]::GetFolderPath('Windows').TrimEnd('\'),[Environment]::GetFolderPath('UserProfile').TrimEnd('\'))
  if($forbidden-contains$root-or$root-ieq$repositoryRoot-or$root.StartsWith($repositoryRoot+'\',[StringComparison]::OrdinalIgnoreCase)-or-not(Test-Path -LiteralPath $root -PathType Container)){throw 'APPROVED_DATA_ROOT_FORBIDDEN'}
  NoReparseAncestors $root
  if((Get-Volume -FilePath $root).FileSystem-ne'NTFS'){throw 'APPROVED_DATA_ROOT_MUST_BE_NTFS'};return $root
}
function Roots([string]$Root,[string[]]$Values){return @($Values|Where-Object{$_}|ForEach-Object{$full=[IO.Path]::GetFullPath($_).TrimEnd('\');if($full-ne$Root-and-not$full.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'ACL_ROOT_OUTSIDE_APPROVED_DATA_ROOT'};if(-not(Test-Path -LiteralPath $full)){throw 'ACL_ROOT_NOT_FOUND'};NoReparseAncestors $full;$full}|Sort-Object -Unique)}
function AssertDisjoint($Classes){$all=@();foreach($class in $Classes){foreach($root in $class.Roots){$all+=,[pscustomobject]@{Name=$class.Name;Root=$root}}};for($i=0;$i-lt$all.Count;$i++){for($j=$i+1;$j-lt$all.Count;$j++){if($all[$i].Root-ieq$all[$j].Root-or$all[$i].Root.StartsWith($all[$j].Root+'\',[StringComparison]::OrdinalIgnoreCase)-or$all[$j].Root.StartsWith($all[$i].Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'ACL_CLASS_ROOTS_MUST_BE_DISJOINT'}}}}
function Rights([string]$Name,[string]$Identity,[string]$Core,[string]$Edge,[string]$Backup){
  if($Identity-eq$systemSid-or$Identity-eq$administratorsSid){return [Security.AccessControl.FileSystemRights]::FullControl}
  $rx=[Security.AccessControl.FileSystemRights]'ReadAndExecute,Synchronize';$modify=[Security.AccessControl.FileSystemRights]'Modify,Synchronize'
  if($Identity-eq$Core){if($Name-eq'CORE_MODIFY'){return $modify};if($Name-in@('CORE_READ','SHARED_RUNTIME','ADMIN_EVIDENCE','BACKUP_RECEIPT')){return $rx}}
  if($Identity-eq$Edge){if($Name-eq'EDGE_MODIFY'){return $modify};if($Name-in@('EDGE_READ','SHARED_RUNTIME','ADMIN_EVIDENCE','BACKUP_RECEIPT')){return $rx}}
  if($Identity-eq$Backup){if($Name-in@('CORE_MODIFY')){return $rx};if($Name-in@('BACKUP_ONLY','SHARED_RUNTIME','ADMIN_EVIDENCE','BACKUP_RECEIPT')){return $rx}}
  if($Identity-eq$script:SignerSid){if($Name-eq'BACKUP_RECEIPT'){return $modify};if($Name-in@('BACKUP_ONLY','SIGNER_ONLY','SHARED_RUNTIME','ADMIN_EVIDENCE')){return $rx}}
  return $null
}
function ExpectedSids($Class,[string]$Core,[string]$Edge,[string]$Backup){$ids=@($systemSid,$administratorsSid);foreach($id in @($Core,$Edge,$Backup,$script:SignerSid)){if($id-and$null-ne(Rights $Class $id $Core $Edge $Backup)){$ids+=$id}};return @($ids|Sort-Object -Unique)}
function SetExact([string]$Path,[string]$Class,[string]$Core,[string]$Edge,[string]$Backup){
  $item=Get-Item -LiteralPath $Path -Force;if($item.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'ACL_REPARSE_REJECTED'}
  $acl=Get-Acl -LiteralPath $Path;$acl.SetAccessRuleProtection($true,$false);foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleAll($rule)|Out-Null}
  $inherit=if($item.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None};$prop=[Security.AccessControl.PropagationFlags]::None;$allow=[Security.AccessControl.AccessControlType]::Allow
  foreach($id in ExpectedSids $Class $Core $Edge $Backup){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id,(Rights $Class $id $Core $Edge $Backup),$inherit,$prop,$allow)))}
  $acl.SetOwner([Security.Principal.SecurityIdentifier]$administratorsSid);Set-Acl -LiteralPath $Path -AclObject $acl
}
function AssertExact([string]$Path,[string]$Class,[string]$Core,[string]$Edge,[string]$Backup){
  $item=Get-Item -LiteralPath $Path -Force;if($item.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'ACL_REPARSE_REJECTED'};$acl=Get-Acl -LiteralPath $Path
  if(-not$acl.AreAccessRulesProtected-or$acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value-ne$administratorsSid){throw 'ACL_PROTECTION_OR_OWNER_INVALID'}
  $expected=ExpectedSids $Class $Core $Edge $Backup;if(@($acl.Access).Count-ne$expected.Count){throw 'ACL_RULE_COUNT_INVALID'}
  foreach($rule in $acl.Access){$id=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;$rights=Rights $Class $id $Core $Edge $Backup;$inherit=if($item.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None};if($broadSids-contains$id-or$id-notin$expected-or$rule.AccessControlType-ne'Allow'-or$rule.FileSystemRights-ne$rights-or$rule.InheritanceFlags-ne$inherit-or$rule.PropagationFlags-ne[Security.AccessControl.PropagationFlags]::None){throw 'ACL_UNEXPECTED_RULE'}}
}
function Visit($Class,[scriptblock]$Work){foreach($root in $Class.Roots){&$Work $root $Class.Name;foreach($item in (Get-ChildItem -LiteralPath $root -Force -Recurse)){&$Work $item.FullName $Class.Name}}}
function Digest($Classes){$lines=New-Object 'System.Collections.Generic.List[string]';foreach($class in $Classes){Visit $class {param($p,$n)$lines.Add("$n|$p|$((Get-Acl -LiteralPath $p).Sddl)")|Out-Null}};$sha=[Security.Cryptography.SHA256]::Create();try{return-join@($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((@($lines|Sort-Object)-join"`n")))|ForEach-Object{$_.ToString('x2')})}finally{$sha.Dispose()}}
function Protect-AdminOnlyFile([string]$Path){$security=New-Object Security.AccessControl.FileSecurity;$admin=New-Object Security.Principal.SecurityIdentifier($administratorsSid);$security.SetOwner($admin);$security.SetAccessRuleProtection($true,$false);foreach($sid in @($systemSid,$administratorsSid)){$rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow);$security.AddAccessRule($rule)|Out-Null};Set-Acl -LiteralPath $Path -AclObject $security}
function Assert-AdminOnlyFile([string]$Path){$acl=Get-Acl -LiteralPath $Path;if(-not$acl.AreAccessRulesProtected-or@($acl.Access).Count-ne2-or$acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value-notin@($systemSid,$administratorsSid)){throw 'ACL_BACKUP_FILE_NOT_ADMIN_ONLY'};foreach($rule in $acl.Access){$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid-notin@($systemSid,$administratorsSid)-or$rule.AccessControlType-ne'Allow'-or$rule.FileSystemRights-ne[Security.AccessControl.FileSystemRights]::FullControl-or$rule.IsInherited){throw 'ACL_BACKUP_FILE_NOT_ADMIN_ONLY'}}}
function Assert-AdminBackupParent([string]$Path){$parent=Split-Path -Parent ([IO.Path]::GetFullPath($Path));NoReparseAncestors $parent;$acl=Get-Acl -LiteralPath $parent;if(-not$acl.AreAccessRulesProtected-or$acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value-notin@($systemSid,$administratorsSid)){throw 'ACL_BACKUP_PARENT_NOT_ADMIN_ONLY'};foreach($rule in $acl.Access){$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid-notin@($systemSid,$administratorsSid)-or$rule.AccessControlType-ne'Allow'-or$rule.FileSystemRights-ne[Security.AccessControl.FileSystemRights]::FullControl){throw 'ACL_BACKUP_PARENT_NOT_ADMIN_ONLY'}}}
function Restore-ExactAcl([string]$Backup,[string]$OwnerBackup,$Manifest,$Classes,[string]$Parent){
  Push-Location $Parent;try{&icacls.exe . /restore $Backup /c|Out-Null;if($LASTEXITCODE-ne0){throw 'ACL_ROLLBACK_FAILED'}}finally{Pop-Location}
  $owners=Get-Content -Raw -LiteralPath $OwnerBackup|ConvertFrom-Json
  foreach($entry in @($owners.entries)){$path=[IO.Path]::GetFullPath([string]$entry.path);if($path-ne$root-and-not$path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'ACL_OWNER_BACKUP_PATH_INVALID'};NoReparseAncestors $path;$acl=Get-Acl -LiteralPath $path;$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier([string]$entry.ownerSid)));Set-Acl -LiteralPath $path -AclObject $acl}
  if((Digest $Classes)-cne[string]$Manifest.preDescriptorDigest){throw 'ACL_ROLLBACK_DESCRIPTOR_MISMATCH'}
}
function ApprovalRoots([string[]]$Values,[string]$Code){$items=Get-ApprovalSorted $Values $Code;return @($items|ForEach-Object{Get-ApprovalPath $_ $Code}|Sort-Object -Unique)}
function New-AclApprovalPlan([string]$IntendedAction){
  if($IntendedAction-notin@('Apply','Rollback','VerifyEvidence')){throw 'PLANNED_ACTION_REQUIRED'}
  foreach($account in @($CoreServiceAccount,$EdgeServiceAccount,$BackupAccount,$SignerAccount)){if($account-notmatch'^[^\\]+\\[^\\]+$'){throw 'ACL_PLAN_ACCOUNT_REQUIRED'}}
  if(@(@($CoreServiceAccount,$EdgeServiceAccount,$BackupAccount,$SignerAccount)|Sort-Object -Unique).Count-ne4){throw 'ACL_PLAN_ACCOUNTS_MUST_BE_DISTINCT'}
  $parameters=[ordered]@{approvedDataRoot=(Get-ApprovalPath $ApprovedDataRoot 'ACL_PLAN_DATA_ROOT_REQUIRED');coreServiceAccount=$CoreServiceAccount;edgeServiceAccount=$EdgeServiceAccount;backupAccount=$BackupAccount;signerAccount=$SignerAccount;coreModifyRoots=(ApprovalRoots $CoreModifyRoots 'ACL_PLAN_CORE_MODIFY_ROOTS_REQUIRED');coreReadOnlyRoots=(ApprovalRoots $CoreReadOnlyRoots 'ACL_PLAN_CORE_READ_ROOTS_REQUIRED');edgeModifyRoots=(ApprovalRoots $EdgeModifyRoots 'ACL_PLAN_EDGE_MODIFY_ROOTS_REQUIRED');edgeReadOnlyRoots=(ApprovalRoots $EdgeReadOnlyRoots 'ACL_PLAN_EDGE_READ_ROOTS_REQUIRED');sharedRuntimeRoots=(ApprovalRoots $SharedRuntimeRoots 'ACL_PLAN_SHARED_RUNTIME_ROOTS_REQUIRED');adminEvidenceRoots=(ApprovalRoots $AdminEvidenceRoots 'ACL_PLAN_ADMIN_EVIDENCE_ROOTS_REQUIRED');backupReceiptRoots=(ApprovalRoots $BackupReceiptRoots 'ACL_PLAN_BACKUP_RECEIPT_ROOTS_REQUIRED');backupOnlyRoots=(ApprovalRoots $BackupOnlyRoots 'ACL_PLAN_BACKUP_ONLY_ROOTS_REQUIRED');signerOnlyRoots=(ApprovalRoots $SignerOnlyRoots 'ACL_PLAN_SIGNER_ONLY_ROOTS_REQUIRED');adminOnlyRoots=(ApprovalRoots $AdminOnlyRoots 'ACL_PLAN_ADMIN_ONLY_ROOTS_REQUIRED');aclBackupPath=(Get-ApprovalPath $AclBackupPath 'ACL_PLAN_BACKUP_PATH_REQUIRED')}
  if($IntendedAction-eq'Rollback'){$parameters.aclBackupSha256=Get-ApprovalHash $ExpectedAclBackupSha256 'ACL_PLAN_BACKUP_HASH_REQUIRED';$parameters.aclBackupManifestSha256=Get-ApprovalHash $ExpectedAclBackupManifestSha256 'ACL_PLAN_BACKUP_MANIFEST_HASH_REQUIRED';$parameters.ownerBackupSha256=Get-ApprovalHash $ExpectedOwnerBackupSha256 'ACL_PLAN_OWNER_BACKUP_HASH_REQUIRED'}
  if($IntendedAction-eq'VerifyEvidence'){$parameters.evidenceOutputPath=Get-ApprovalPath $EvidenceOutputPath 'ACL_PLAN_EVIDENCE_PATH_REQUIRED'}
  $target="Exact disjoint NTFS ACL classes below $($parameters.approvedDataRoot) for $CoreServiceAccount, $EdgeServiceAccount, and $BackupAccount"
  $impact=if($IntendedAction-eq'Apply'){'Captures an exact DACL/owner backup, then replaces inheritance, owner, and access rules only for the declared roots'}elseif($IntendedAction-eq'Rollback'){'Restores only the hash-pinned pre-change DACL and owner backup for every declared path'}else{'Verifies all declared ACLs and writes one non-secret filesystem evidence file'}
  $rollback=if($IntendedAction-eq'Apply'){'Use a separately approved Rollback plan bound to the generated backup, manifest, and owner hashes'}elseif($IntendedAction-eq'Rollback'){'Re-apply only through a new approved Apply plan after reviewing the restored descriptors'}else{'Delete only the exact evidence output file'}
  return New-ApprovalPlan $PSCommandPath $IntendedAction $parameters $target $impact $rollback
}

if($Action-eq'Plan'){New-AclApprovalPlan $PlannedAction|ConvertTo-Json -Depth 12;exit 0}
$aclMutation=if($Action-in@('Apply','Rollback')){$Action}elseif($Action-eq'Verify'-and$EvidenceOutputPath){'VerifyEvidence'}else{$null};if($aclMutation){Assert-ApprovedPlan (New-AclApprovalPlan $aclMutation) ([bool]$Approved) $ApprovedPlanSha256}
$root=SafeRoot $ApprovedDataRoot;$core=Sid $CoreServiceAccount;$edge=Sid $EdgeServiceAccount;$backupSid=Sid $BackupAccount;$script:SignerSid=Sid $SignerAccount
if(@(@($core,$edge,$backupSid,$script:SignerSid) | Sort-Object -Unique).Count -ne 4){throw 'ACL_PRINCIPALS_MUST_BE_DISTINCT'}
$classes=@(
  [pscustomobject]@{Name='CORE_MODIFY';Roots=Roots $root $CoreModifyRoots},[pscustomobject]@{Name='CORE_READ';Roots=Roots $root $CoreReadOnlyRoots},
  [pscustomobject]@{Name='EDGE_MODIFY';Roots=Roots $root $EdgeModifyRoots},[pscustomobject]@{Name='EDGE_READ';Roots=Roots $root $EdgeReadOnlyRoots},
  [pscustomobject]@{Name='SHARED_RUNTIME';Roots=Roots $root $SharedRuntimeRoots},[pscustomobject]@{Name='ADMIN_EVIDENCE';Roots=Roots $root $AdminEvidenceRoots},[pscustomobject]@{Name='BACKUP_RECEIPT';Roots=Roots $root $BackupReceiptRoots},
  [pscustomobject]@{Name='BACKUP_ONLY';Roots=Roots $root $BackupOnlyRoots},[pscustomobject]@{Name='SIGNER_ONLY';Roots=Roots $root $SignerOnlyRoots},[pscustomobject]@{Name='ADMIN_ONLY';Roots=Roots $root $AdminOnlyRoots})
if($classes|Where-Object{@($_.Roots).Count-eq0}){throw 'EVERY_ACL_CLASS_ROOT_REQUIRED'};AssertDisjoint $classes
$aclBackup=[IO.Path]::GetFullPath($AclBackupPath);if($aclBackup.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'ACL_BACKUP_MUST_BE_OUTSIDE_MUTATED_ROOT'}
$aclBackupManifest="$aclBackup.manifest.json";$ownerBackup="$aclBackup.owners.json"
if($Action-eq'Verify'){foreach($class in $classes){Visit $class {param($p,$n)AssertExact $p $n $core $edge $backupSid}};$digest=Digest $classes;if($EvidenceOutputPath){$classRoots=[ordered]@{};foreach($class in $classes){$classRoots[$class.Name]=@($class.Roots)};[IO.File]::WriteAllText($EvidenceOutputPath,([ordered]@{result='PASS';dataRoot=$root;filesystem='NTFS';nonReparse=$true;leastPrivilege=$true;exactAcl=$true;coreServiceSid=$core;edgeServiceSid=$edge;backupSid=$backupSid;signerSid=$script:SignerSid;classRoots=$classRoots;descriptorDigest=$digest;completedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))};[pscustomobject]@{Result='PASS';DescriptorDigest=$digest;BroadAccess=$false;ExactAcl=$true}|ConvertTo-Json;exit 0}
$parent=Split-Path -Parent $root;$leaf=Split-Path -Leaf $root
if($Action-eq'Rollback'){
  foreach($file in @($aclBackup,$aclBackupManifest,$ownerBackup)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'ACL_BACKUP_NOT_FOUND'};NoReparseAncestors $file;Assert-AdminOnlyFile $file}
  if((Get-FileHash -LiteralPath $aclBackup -Algorithm SHA256).Hash-ine$ExpectedAclBackupSha256-or(Get-FileHash -LiteralPath $aclBackupManifest -Algorithm SHA256).Hash-ine$ExpectedAclBackupManifestSha256-or(Get-FileHash -LiteralPath $ownerBackup -Algorithm SHA256).Hash-ine$ExpectedOwnerBackupSha256){throw 'ACL_ROLLBACK_ARTIFACT_HASH_MISMATCH'}
  Assert-AdminBackupParent $aclBackup;$manifest=Get-Content -Raw -LiteralPath $aclBackupManifest|ConvertFrom-Json
  if($manifest.version-ne2-or[IO.Path]::GetFullPath([string]$manifest.approvedDataRoot)-ine$root-or$manifest.backupSha256-cne(Get-FileHash -LiteralPath $aclBackup -Algorithm SHA256).Hash.ToLowerInvariant()-or$manifest.ownerBackupSha256-cne(Get-FileHash -LiteralPath $ownerBackup -Algorithm SHA256).Hash.ToLowerInvariant()-or[string]$manifest.preDescriptorDigest-notmatch'^[a-f0-9]{64}$'){throw 'ACL_BACKUP_MANIFEST_INVALID'}
  Restore-ExactAcl $aclBackup $ownerBackup $manifest $classes $parent
  [pscustomobject]@{Result='ROLLED_BACK';BackupHashVerified=$true;OwnerRestored=$true;DescriptorRestored=$true}|ConvertTo-Json;exit 0
}
if((Test-Path -LiteralPath $aclBackup)-or(Test-Path -LiteralPath $aclBackupManifest)-or(Test-Path -LiteralPath $ownerBackup)){throw 'ACL_BACKUP_ALREADY_EXISTS'}
Assert-AdminBackupParent $aclBackup;$preDescriptorDigest=Digest $classes;$ownerEntries=[Collections.Generic.List[object]]::new();foreach($class in $classes){Visit $class {param($p,$n)$owner=(Get-Acl -LiteralPath $p).Owner.Translate([Security.Principal.SecurityIdentifier]).Value;$ownerEntries.Add([ordered]@{path=[IO.Path]::GetFullPath($p);ownerSid=$owner})}}
Push-Location $parent;try{&icacls.exe $leaf /save $aclBackup /t /c|Out-Null;if($LASTEXITCODE-ne0){throw 'ACL_BACKUP_FAILED'}}finally{Pop-Location}
[IO.File]::WriteAllText($ownerBackup,([ordered]@{version=1;entries=$ownerEntries}|ConvertTo-Json -Depth 4),(New-Object Text.UTF8Encoding($false)));Protect-AdminOnlyFile $aclBackup;Protect-AdminOnlyFile $ownerBackup
[IO.File]::WriteAllText($aclBackupManifest,([ordered]@{version=2;approvedDataRoot=$root;backupSha256=(Get-FileHash -LiteralPath $aclBackup -Algorithm SHA256).Hash.ToLowerInvariant();ownerBackupSha256=(Get-FileHash -LiteralPath $ownerBackup -Algorithm SHA256).Hash.ToLowerInvariant();preDescriptorDigest=$preDescriptorDigest;createdAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)));Protect-AdminOnlyFile $aclBackupManifest
try{foreach($class in $classes){Visit $class {param($p,$n)SetExact $p $n $core $edge $backupSid;AssertExact $p $n $core $edge $backupSid}}}catch{$applyError=$_.Exception.Message;try{Restore-ExactAcl $aclBackup $ownerBackup (Get-Content -Raw -LiteralPath $aclBackupManifest|ConvertFrom-Json) $classes $parent}catch{throw "ACL_APPLY_FAILED_AND_ROLLBACK_FAILED:$applyError"};throw "ACL_APPLY_FAILED_ROLLED_BACK:$applyError"}
[pscustomobject]@{Result='APPLIED';RollbackAvailable=$true;AccessClasses=$classes.Count}|ConvertTo-Json
