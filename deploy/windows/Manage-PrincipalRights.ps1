#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Apply','Verify','Rollback')][string]$Action='Plan',
  [string]$CoreServiceAccount,[string]$EdgeServiceAccount,[string]$BackupAccount,[string]$SignerAccount,
  [string]$RollbackPath,[string]$EvidenceOutputPath,[string]$FileSystemEvidencePath,
  [ValidateSet('Apply','Rollback','VerifyEvidence')][string]$PlannedAction,[string]$ApprovedPlanSha256,[string]$ApprovalNonce,[string]$ApprovalIssuedAt,[string]$ApprovalExpiresAt,[string]$ApprovalInstanceId,[string]$ApprovalLedgerPath,[switch]$Approved
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
$serviceRights=@('SeServiceLogonRight','SeDenyInteractiveLogonRight','SeDenyRemoteInteractiveLogonRight','SeDenyNetworkLogonRight','SeDenyBatchLogonRight')
$backupRights=@('SeBatchLogonRight','SeDenyInteractiveLogonRight','SeDenyRemoteInteractiveLogonRight','SeDenyNetworkLogonRight','SeDenyServiceLogonRight')

function Full([string]$Path,[string]$Code){if(-not$Path){throw $Code};return [IO.Path]::GetFullPath($Path)}
function NoReparseAncestors([string]$Path){$cursor=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force;while($cursor){if($cursor.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'PRINCIPAL_RIGHTS_REPARSE_POINT_REJECTED'};$cursor=$cursor.Parent}}
function LocalSid([string]$Account){
  if(-not$Account-or$Account-notmatch'^([^\\]+)\\([^\\]+)$'-or$Matches[1]-ine$env:COMPUTERNAME){throw 'LOCAL_PRINCIPAL_REQUIRED'}
  $user=Get-LocalUser -Name $Matches[2] -ErrorAction Stop;if(-not$user.Enabled){throw 'LOCAL_PRINCIPAL_DISABLED'}
  $sid=$user.SID.Value;foreach($groupSid in @('S-1-5-32-544','S-1-5-32-547','S-1-5-32-548','S-1-5-32-549','S-1-5-32-550','S-1-5-32-551','S-1-5-32-555','S-1-5-32-556','S-1-5-32-562','S-1-5-32-569','S-1-5-32-573','S-1-5-32-580')){foreach($member in @(Get-LocalGroupMember -SID $groupSid -ErrorAction Stop)){if($member.SID.Value-eq$sid){throw 'PRINCIPAL_PRIVILEGED_GROUP_MEMBER'};if([string]$member.ObjectClass-eq'Group'){throw 'PRIVILEGED_GROUP_NESTING_UNVERIFIABLE'}}};return $sid
}
function Digest([string]$Value){$sha=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant())}finally{$sha.Dispose()}}
function Protect-AdminOnlyFile([string]$Path){$security=New-Object Security.AccessControl.FileSecurity;$admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544');$security.SetOwner($admin);$security.SetAccessRuleProtection($true,$false);foreach($sid in @('S-1-5-18','S-1-5-32-544')){$rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow);$security.AddAccessRule($rule)|Out-Null};Set-Acl -LiteralPath $Path -AclObject $security}
function Assert-AdminOnlyFile([string]$Path){$acl=Get-Acl -LiteralPath $Path;if(-not$acl.AreAccessRulesProtected-or@($acl.Access).Count-ne2-or$acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value-notin@('S-1-5-18','S-1-5-32-544')){throw 'PRINCIPAL_RIGHTS_ROLLBACK_ACL_INVALID'};foreach($rule in $acl.Access){$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid-notin@('S-1-5-18','S-1-5-32-544')-or$rule.AccessControlType-ne'Allow'-or$rule.FileSystemRights-ne[Security.AccessControl.FileSystemRights]::FullControl-or$rule.IsInherited){throw 'PRINCIPAL_RIGHTS_ROLLBACK_ACL_INVALID'}}}
function Export-Rights([string]$Destination){&secedit.exe /export /cfg $Destination /areas USER_RIGHTS /quiet|Out-Null;if($LASTEXITCODE-ne0-or-not(Test-Path -LiteralPath $Destination -PathType Leaf)){throw 'USER_RIGHTS_EXPORT_FAILED'}}
function Parse-Rights([string]$Source){
  $result=[ordered]@{};$section=''
  foreach($line in [IO.File]::ReadAllLines($Source,[Text.Encoding]::Unicode)){
    $trim=$line.Trim();if($trim-match'^\[(.+)\]$'){$section=$Matches[1];continue}
    if($section-ne'Privilege Rights'-or$trim-notmatch'^([^=]+)=(.*)$'){continue}
    $name=$Matches[1].Trim();$values=@($Matches[2].Split(',')|ForEach-Object{$_.Trim().TrimStart('*')}|Where-Object{$_})
    $result[$name]=$values
  }
  return $result
}
function Write-Rights([string]$Destination,$Rights){
  $lines=[Collections.Generic.List[string]]::new();$lines.Add('[Unicode]');$lines.Add('Unicode=yes');$lines.Add('[Version]');$lines.Add('signature="$CHICAGO$"');$lines.Add('Revision=1');$lines.Add('[Privilege Rights]')
  foreach($name in @($Rights.Keys|Sort-Object)){if($name-notmatch'^Se[A-Za-z]+Right$'){throw 'USER_RIGHT_NAME_REJECTED'};$members=@($Rights[$name]|Sort-Object -Unique|ForEach-Object{'*'+$_});$lines.Add($name+' = '+($members-join','))}
  [IO.File]::WriteAllLines($Destination,$lines,[Text.Encoding]::Unicode)
}
function Current-Rights(){
  $temporary=Join-Path ([IO.Path]::GetTempPath()) ('meta-rights-'+[guid]::NewGuid().ToString('N')+'.inf')
  try{Export-Rights $temporary;return Parse-Rights $temporary}finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
}
function UnderClass([string]$Path,[string]$ClassName){
  if(-not$FileSystemEvidencePath-or-not(Test-Path -LiteralPath $FileSystemEvidencePath -PathType Leaf)){throw 'FILESYSTEM_EVIDENCE_REQUIRED'}
  $fs=Get-Content -Raw -LiteralPath $FileSystemEvidencePath|ConvertFrom-Json;if($fs.result-ne'PASS'-or-not$fs.exactAcl){throw 'FILESYSTEM_EVIDENCE_REJECTED'}
  $full=[IO.Path]::GetFullPath($Path);$roots=@($fs.classRoots.$ClassName|ForEach-Object{[IO.Path]::GetFullPath([string]$_).TrimEnd('\')})
  if(@($roots|Where-Object{$full-ieq$_-or$full.StartsWith($_+'\',[StringComparison]::OrdinalIgnoreCase)}).Count-eq0){throw 'PRINCIPAL_RIGHTS_ARTIFACT_CLASS_REJECTED'}
}
function Assert-Exact($Rights,$ExpectedBySid){
  foreach($sid in $ExpectedBySid.Keys){$actual=@($Rights.Keys|Where-Object{$Rights[$_]-contains$sid}|Sort-Object);$expected=@($ExpectedBySid[$sid]|Sort-Object);if(($actual-join'|')-cne($expected-join'|')){throw 'PRINCIPAL_RIGHTS_MISMATCH'}}
}
function Assert-RightsEqual($Actual,$Expected){$actualKeys=@($Actual.Keys|Sort-Object);$expectedKeys=@($Expected.Keys|Sort-Object);if(($actualKeys-join'|')-cne($expectedKeys-join'|')){throw 'USER_RIGHTS_ROLLBACK_KEYSET_MISMATCH'};foreach($name in $expectedKeys){$actualValues=@($Actual[$name]|Sort-Object -Unique);$expectedValues=@($Expected[$name]|Sort-Object -Unique);if(($actualValues-join'|')-cne($expectedValues-join'|')){throw 'USER_RIGHTS_ROLLBACK_VALUE_MISMATCH'}}}

function New-PrincipalRightsApprovalPlan([string]$IntendedAction){
  if($IntendedAction-notin@('Apply','Rollback','VerifyEvidence')){throw 'PLANNED_ACTION_REQUIRED'}
  foreach($account in @($CoreServiceAccount,$EdgeServiceAccount,$BackupAccount,$SignerAccount)){if($account-notmatch'^[^\\]+\\[^\\]+$'){throw 'PRINCIPAL_RIGHTS_PLAN_ACCOUNT_INVALID'}}
  $parameters=[ordered]@{coreServiceAccount=$CoreServiceAccount;edgeServiceAccount=$EdgeServiceAccount;backupAccount=$BackupAccount;signerAccount=$SignerAccount;rollbackPath=(Get-ApprovalPath $RollbackPath 'PRINCIPAL_RIGHTS_PLAN_ROLLBACK_PATH_REQUIRED');filesystemEvidencePath=(Get-ApprovalPath $FileSystemEvidencePath 'PRINCIPAL_RIGHTS_PLAN_FILESYSTEM_PATH_REQUIRED')}
  if($IntendedAction-eq'VerifyEvidence'){$parameters.evidenceOutputPath=Get-ApprovalPath $EvidenceOutputPath 'PRINCIPAL_RIGHTS_PLAN_EVIDENCE_PATH_REQUIRED'}
  $target="Exact Windows user-right assignments for $CoreServiceAccount, $EdgeServiceAccount, $BackupAccount and $SignerAccount"
  $impact=if($IntendedAction-eq'Apply'){'Exports the full current rights map, then assigns only the exact service/batch and deny-logon rights'}elseif($IntendedAction-eq'Rollback'){'Restores the exact ADMIN_ONLY full rights snapshot'}else{'Verifies the exact four principals and writes only the exact evidence output'}
  $rollback=if($IntendedAction-eq'Apply'){'Use a separately approved Rollback plan bound to the exact snapshot path'}elseif($IntendedAction-eq'Rollback'){'Re-apply only through a new approved Apply plan'}else{'Delete only the exact evidence output'}
  return New-ApprovalPlan $PSCommandPath $IntendedAction $parameters $target $impact $rollback
}
if($Action-eq'Plan'){New-PrincipalRightsApprovalPlan $PlannedAction|ConvertTo-Json -Depth 12;exit 0}
$rightsMutation=if($Action-in@('Apply','Rollback')){$Action}elseif($Action-eq'Verify'-and$EvidenceOutputPath){'VerifyEvidence'}else{$null};if($rightsMutation){Assert-ApprovedPlan (New-PrincipalRightsApprovalPlan $rightsMutation) ([bool]$Approved) $ApprovedPlanSha256}
$coreSid=LocalSid $CoreServiceAccount;$edgeSid=LocalSid $EdgeServiceAccount;$backupSid=LocalSid $BackupAccount;$signerSid=LocalSid $SignerAccount
if(@(@($coreSid,$edgeSid,$backupSid,$signerSid)|Sort-Object -Unique).Count-ne4){throw 'PRINCIPALS_MUST_BE_DISTINCT'}
$expected=[ordered]@{};$expected[$coreSid]=$serviceRights;$expected[$edgeSid]=$serviceRights;$expected[$backupSid]=$backupRights;$expected[$signerSid]=$backupRights
if($Action-eq'Verify'){
  Assert-Exact (Current-Rights) $expected
  if($EvidenceOutputPath){UnderClass $EvidenceOutputPath 'ADMIN_EVIDENCE';$parent=Split-Path -Parent (Full $EvidenceOutputPath 'EVIDENCE_PATH_REQUIRED');NoReparseAncestors $parent
    $body=[ordered]@{version=4;result='PASS';corePrincipalDigest=(Digest $coreSid);edgePrincipalDigest=(Digest $edgeSid);backupPrincipalDigest=(Digest $backupSid);signerPrincipalDigest=(Digest $signerSid);exactRights=$true;interactiveLogonDenied=$true;remoteInteractiveLogonDenied=$true;networkLogonDenied=$true;completedAt=(Get-Date).ToUniversalTime().ToString('o')}
    [IO.File]::WriteAllText($EvidenceOutputPath,($body|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
  }
  [pscustomobject]@{Result='PASS';ExactRights=$true;PrincipalCount=4}|ConvertTo-Json;exit 0
}
if($Action-eq'Rollback'){
  $snapshot=Full $RollbackPath 'ROLLBACK_PATH_REQUIRED';UnderClass $snapshot 'ADMIN_ONLY';NoReparseAncestors $snapshot
  if(-not(Test-Path -LiteralPath $snapshot -PathType Leaf)){throw 'ROLLBACK_SNAPSHOT_NOT_FOUND'};Assert-AdminOnlyFile $snapshot
  $expectedSnapshot=Parse-Rights $snapshot
  $database=Join-Path ([IO.Path]::GetTempPath()) ('meta-rights-'+[guid]::NewGuid().ToString('N')+'.sdb')
  try{&secedit.exe /configure /db $database /cfg $snapshot /areas USER_RIGHTS /quiet|Out-Null;if($LASTEXITCODE-ne0){throw 'USER_RIGHTS_ROLLBACK_FAILED'};Assert-RightsEqual (Current-Rights) $expectedSnapshot}finally{if(Test-Path -LiteralPath $database){Remove-Item -LiteralPath $database -Force}}
  [pscustomobject]@{Result='ROLLED_BACK';Scope='FULL_USER_RIGHTS_MAP';ExactSnapshotRestored=$true}|ConvertTo-Json;exit 0
}
$snapshot=Full $RollbackPath 'ROLLBACK_PATH_REQUIRED';UnderClass $snapshot 'ADMIN_ONLY';$snapshotParent=Split-Path -Parent $snapshot;NoReparseAncestors $snapshotParent
if(Test-Path -LiteralPath $snapshot){throw 'ROLLBACK_SNAPSHOT_ALREADY_EXISTS'}
Export-Rights $snapshot
Protect-AdminOnlyFile $snapshot;Assert-AdminOnlyFile $snapshot
$rights=Parse-Rights $snapshot
foreach($right in @($rights.Keys)){$rights[$right]=@($rights[$right]|Where-Object{$_-notin@($coreSid,$edgeSid,$backupSid,$signerSid)})}
foreach($pair in @(@{Sid=$coreSid;Rights=$serviceRights},@{Sid=$edgeSid;Rights=$serviceRights},@{Sid=$backupSid;Rights=$backupRights},@{Sid=$signerSid;Rights=$backupRights})){
  foreach($right in $pair.Rights){if(-not$rights.Contains($right)){$rights[$right]=@()};$rights[$right]=@($rights[$right])+$pair.Sid}
}
$apply=Join-Path ([IO.Path]::GetTempPath()) ('meta-rights-'+[guid]::NewGuid().ToString('N')+'.inf');$database=[IO.Path]::ChangeExtension($apply,'.sdb')
try{Write-Rights $apply $rights;&secedit.exe /configure /db $database /cfg $apply /areas USER_RIGHTS /quiet|Out-Null;if($LASTEXITCODE-ne0){throw 'USER_RIGHTS_APPLY_FAILED'};Assert-Exact (Current-Rights) $expected}catch{$applyError=$_.Exception.Message;try{&secedit.exe /configure /db $database /cfg $snapshot /areas USER_RIGHTS /quiet|Out-Null;if($LASTEXITCODE-ne0){throw 'USER_RIGHTS_AUTOMATIC_ROLLBACK_FAILED'};Assert-RightsEqual (Current-Rights) (Parse-Rights $snapshot)}catch{throw "USER_RIGHTS_APPLY_AND_ROLLBACK_FAILED:$applyError"};throw "USER_RIGHTS_APPLY_FAILED_ROLLED_BACK:$applyError"}finally{foreach($temporary in @($apply,$database)){if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}}
[pscustomobject]@{Result='APPLIED';ExactRights=$true;RollbackSnapshotCreated=$true}|ConvertTo-Json
