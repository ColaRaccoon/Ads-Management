#Requires -Version 5.1
$script:ApprovalPlanContractPath=[IO.Path]::GetFullPath($PSCommandPath)
function Get-ApprovalFileSha256([string]$Path){$stream=[IO.File]::OpenRead([IO.Path]::GetFullPath($Path));$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose();$stream.Dispose()}}
$script:ApprovalPlanContractSha256=Get-ApprovalFileSha256 $script:ApprovalPlanContractPath

function Get-ApprovalSha256([string]$Value){
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant())}finally{$sha.Dispose()}
}
function Get-ApprovalPath([string]$Value,[string]$Code){
  if(-not$Value-or$Value-notmatch'^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))'){throw $Code}
  $full=[IO.Path]::GetFullPath($Value);$root=[IO.Path]::GetPathRoot($full)
  return $(if($full-cne$root){$full.TrimEnd('\')}else{$full})
}
function Get-ApprovalOptionalPath([string]$Value){if(-not$Value){return $null};return Get-ApprovalPath $Value 'APPROVAL_PLAN_PATH_INVALID'}
function Get-ApprovalHash([string]$Value,[string]$Code){if($Value-notmatch'^[A-Fa-f0-9]{64}$'){throw $Code};return ($Value.ToLowerInvariant())}
function Get-ApprovalOptionalHash([string]$Value){if(-not$Value){return $null};return Get-ApprovalHash $Value 'APPROVAL_PLAN_HASH_INVALID'}
function Assert-ApprovalOptionalArtifact([string]$Path,[string]$Hash,[string]$Code){if([bool]$Path-xor[bool]$Hash){throw $Code}}
function Get-ApprovalText([string]$Value,[string]$Pattern,[string]$Code){if(-not$Value-or$Value-notmatch$Pattern){throw $Code};return $Value}
function Get-ApprovalSorted([string[]]$Values,[string]$Code){if(-not$Values-or@($Values).Count-eq0-or@($Values|Where-Object{-not$_}).Count){throw $Code};return @($Values|Sort-Object -Unique)}
function Get-ApprovalDefaultLedgerPath {
  $base=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
  if(-not$base){throw 'APPROVAL_LEDGER_PATH_REQUIRED'}
  return [IO.Path]::GetFullPath((Join-Path $base 'MetaAdsPerformance\admin-only\approval-consumed.jsonl'))
}
function New-ApprovalNonce {
  $bytes=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  try{$rng.GetBytes($bytes);return -join @($bytes|ForEach-Object{$_.ToString('x2')})}finally{$rng.Dispose();[Array]::Clear($bytes,0,$bytes.Length)}
}
function Get-ApprovalContext {
  if($script:ApprovalContext){return $script:ApprovalContext}
  $provided=@($ApprovalNonce,$ApprovalIssuedAt,$ApprovalExpiresAt,$ApprovalInstanceId)|Where-Object{$_}
  if($provided.Count-eq0-and$Action-eq'Plan'){
    $issued=(Get-Date).ToUniversalTime();$expires=$issued.AddMinutes(10)
    $script:ApprovalContext=[ordered]@{nonce=(New-ApprovalNonce);issuedAt=$issued.ToString('o');expiresAt=$expires.ToString('o');instanceId=[guid]::NewGuid().ToString('D').ToLowerInvariant();ledgerPath=(Get-ApprovalPath $(if($ApprovalLedgerPath){$ApprovalLedgerPath}else{Get-ApprovalDefaultLedgerPath}) 'APPROVAL_LEDGER_PATH_REQUIRED')}
    return $script:ApprovalContext
  }
  if($provided.Count-ne4-or$ApprovalNonce-notmatch'^[a-f0-9]{64}$'-or$ApprovalInstanceId-notmatch'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'APPROVAL_INSTANCE_FIELDS_REQUIRED'}
  try{$issued=[datetimeoffset]::ParseExact($ApprovalIssuedAt,'o',[Globalization.CultureInfo]::InvariantCulture);$expires=[datetimeoffset]::ParseExact($ApprovalExpiresAt,'o',[Globalization.CultureInfo]::InvariantCulture)}catch{throw 'APPROVAL_TIME_INVALID'}
  if($expires-le$issued-or($expires-$issued).TotalMinutes-gt15){throw 'APPROVAL_WINDOW_INVALID'}
  $script:ApprovalContext=[ordered]@{nonce=$ApprovalNonce;issuedAt=$issued.ToUniversalTime().ToString('o');expiresAt=$expires.ToUniversalTime().ToString('o');instanceId=$ApprovalInstanceId;ledgerPath=(Get-ApprovalPath $(if($ApprovalLedgerPath){$ApprovalLedgerPath}else{Get-ApprovalDefaultLedgerPath}) 'APPROVAL_LEDGER_PATH_REQUIRED')}
  return $script:ApprovalContext
}
function Assert-ApprovalAdminOnlyParent([string]$Path){
  $full=[IO.Path]::GetFullPath($Path);$parent=Split-Path -Parent $full
  if(-not(Test-Path -LiteralPath $parent -PathType Container)){throw 'APPROVAL_LEDGER_PARENT_REQUIRED'}
  $cursor=Get-Item -LiteralPath $parent -Force;while($cursor){if($cursor.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'APPROVAL_LEDGER_REPARSE_REJECTED'};$cursor=$cursor.Parent}
  $acl=Get-Acl -LiteralPath $parent;$allowed=@('S-1-5-18','S-1-5-32-544')
  if(-not$acl.AreAccessRulesProtected-or$acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value-notin$allowed-or@($acl.Access).Count-lt2){throw 'APPROVAL_LEDGER_PARENT_NOT_ADMIN_ONLY'}
  foreach($rule in @($acl.Access)){$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid-notin$allowed-or$rule.AccessControlType-ne'Allow'-or($rule.FileSystemRights-band[Security.AccessControl.FileSystemRights]::FullControl)-ne[Security.AccessControl.FileSystemRights]::FullControl){throw 'APPROVAL_LEDGER_PARENT_NOT_ADMIN_ONLY'}}
}
function Use-ApprovalInstance($Plan){
  $context=Get-ApprovalContext;$now=[datetimeoffset]::UtcNow;$issued=[datetimeoffset]::ParseExact($context.issuedAt,'o',[Globalization.CultureInfo]::InvariantCulture);$expires=[datetimeoffset]::ParseExact($context.expiresAt,'o',[Globalization.CultureInfo]::InvariantCulture)
  if($now-lt$issued.AddMinutes(-1)-or$now-gt$expires){throw 'APPROVAL_EXPIRED_OR_NOT_YET_VALID'}
  Assert-ApprovalAdminOnlyParent $context.ledgerPath
  $stream=[IO.File]::Open($context.ledgerPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    if($stream.Length-gt1048576){throw 'APPROVAL_LEDGER_SIZE_LIMIT'}
    $reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$true,4096,$true);$seen=$false
    try{while(-not$reader.EndOfStream){$line=$reader.ReadLine();if(-not$line){continue};if($line.Length-gt4096){throw 'APPROVAL_LEDGER_RECORD_INVALID'};try{$record=$line|ConvertFrom-Json}catch{throw 'APPROVAL_LEDGER_RECORD_INVALID'};if($record.instanceId-ceq$context.instanceId-or$record.planSha256-ceq$Plan.planSha256){$seen=$true}}}finally{$reader.Dispose()}
    if($seen){throw 'APPROVAL_PLAN_REPLAY_REJECTED'}
    $stream.Seek(0,[IO.SeekOrigin]::End)|Out-Null;$writer=[IO.StreamWriter]::new($stream,(New-Object Text.UTF8Encoding($false)),4096,$true)
    try{$record=[ordered]@{version=1;instanceId=$context.instanceId;nonceSha256=(Get-ApprovalSha256 $context.nonce);planSha256=$Plan.planSha256;consumedAt=$now.ToString('o')};$writer.WriteLine(($record|ConvertTo-Json -Compress));$writer.Flush();$stream.Flush($true)}finally{$writer.Dispose()}
  }finally{$stream.Dispose()}
}
function New-ApprovalPlan([string]$ScriptPath,[string]$MutationAction,$ExactParameters,[string]$Target,[string]$Impact,[string]$Rollback){
  if(-not$MutationAction-or-not$Target-or-not$Impact-or-not$Rollback){throw 'APPROVAL_PLAN_INCOMPLETE'}
  $scriptPath=[IO.Path]::GetFullPath($ScriptPath)
  $context=Get-ApprovalContext
  $body=[ordered]@{
    version=2
    scriptName=Split-Path -Leaf $scriptPath
    scriptSha256=Get-ApprovalFileSha256 $scriptPath
    approvalContractSha256=$script:ApprovalPlanContractSha256
    intendedAction=$MutationAction
    exactParameters=$ExactParameters
    target=$Target
    impact=$Impact
    rollback=$Rollback
    approvalNonce=$context.nonce
    approvalIssuedAt=$context.issuedAt
    approvalExpiresAt=$context.expiresAt
    approvalInstanceId=$context.instanceId
    approvalLedgerPath=$context.ledgerPath
  }
  $canonical=$body|ConvertTo-Json -Depth 12 -Compress
  $result=[ordered]@{};foreach($key in $body.Keys){$result[$key]=$body[$key]}
  $result.canonicalParametersSha256=Get-ApprovalSha256 (($ExactParameters|ConvertTo-Json -Depth 12 -Compress))
  $result.planSha256=Get-ApprovalSha256 $canonical
  $result.requiresApproval=$true
  return ([pscustomobject]$result)
}
function Assert-ApprovedPlan($Plan,[bool]$Approved,[string]$ApprovedPlanSha256){
  if(-not$Approved){throw 'EXPLICIT_APPROVAL_REQUIRED'}
  if($ApprovedPlanSha256-notmatch'^[A-Fa-f0-9]{64}$'){throw 'APPROVED_PLAN_SHA256_REQUIRED'}
  if($Plan.planSha256-cne$ApprovedPlanSha256.ToLowerInvariant()){throw 'APPROVED_PLAN_MISMATCH'}
  Use-ApprovalInstance $Plan
}
