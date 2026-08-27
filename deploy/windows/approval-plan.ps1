#Requires -Version 5.1
$script:ApprovalPlanContractPath=[IO.Path]::GetFullPath($PSCommandPath)
$script:ApprovalPlanContractSha256=(Get-FileHash -LiteralPath $script:ApprovalPlanContractPath -Algorithm SHA256).Hash.ToLowerInvariant()

function Get-ApprovalSha256([string]$Value){
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant())}finally{$sha.Dispose()}
}
function Get-ApprovalPath([string]$Value,[string]$Code){
  if(-not$Value-or-not[IO.Path]::IsPathFullyQualified($Value)){throw$Code}
  $full=[IO.Path]::GetFullPath($Value);$root=[IO.Path]::GetPathRoot($full)
  return $(if($full-cne$root){$full.TrimEnd('\')}else{$full})
}
function Get-ApprovalOptionalPath([string]$Value){if(-not$Value){return$null};return Get-ApprovalPath $Value 'APPROVAL_PLAN_PATH_INVALID'}
function Get-ApprovalHash([string]$Value,[string]$Code){if($Value-notmatch'^[A-Fa-f0-9]{64}$'){throw$Code};return ($Value.ToLowerInvariant())}
function Get-ApprovalOptionalHash([string]$Value){if(-not$Value){return$null};return Get-ApprovalHash $Value 'APPROVAL_PLAN_HASH_INVALID'}
function Assert-ApprovalOptionalArtifact([string]$Path,[string]$Hash,[string]$Code){if([bool]$Path-xor[bool]$Hash){throw$Code}}
function Get-ApprovalText([string]$Value,[string]$Pattern,[string]$Code){if(-not$Value-or$Value-notmatch$Pattern){throw$Code};return$Value}
function Get-ApprovalSorted([string[]]$Values,[string]$Code){if(-not$Values-or@($Values).Count-eq0-or@($Values|Where-Object{-not$_}).Count){throw$Code};return @($Values|Sort-Object -Unique)}
function New-ApprovalPlan([string]$ScriptPath,[string]$MutationAction,$ExactParameters,[string]$Target,[string]$Impact,[string]$Rollback){
  if(-not$MutationAction-or-not$Target-or-not$Impact-or-not$Rollback){throw'APPROVAL_PLAN_INCOMPLETE'}
  $scriptPath=[IO.Path]::GetFullPath($ScriptPath)
  $body=[ordered]@{
    version=1
    scriptName=Split-Path -Leaf $scriptPath
    scriptSha256=(Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    approvalContractSha256=$script:ApprovalPlanContractSha256
    intendedAction=$MutationAction
    exactParameters=$ExactParameters
    target=$Target
    impact=$Impact
    rollback=$Rollback
  }
  $canonical=$body|ConvertTo-Json -Depth 12 -Compress
  $result=[ordered]@{};foreach($key in $body.Keys){$result[$key]=$body[$key]}
  $result.canonicalParametersSha256=Get-ApprovalSha256 (($ExactParameters|ConvertTo-Json -Depth 12 -Compress))
  $result.planSha256=Get-ApprovalSha256 $canonical
  $result.requiresApproval=$true
  return ([pscustomobject]$result)
}
function Assert-ApprovedPlan($Plan,[bool]$Approved,[string]$ApprovedPlanSha256){
  if(-not$Approved){throw'EXPLICIT_APPROVAL_REQUIRED'}
  if($ApprovedPlanSha256-notmatch'^[A-Fa-f0-9]{64}$'){throw'APPROVED_PLAN_SHA256_REQUIRED'}
  if($Plan.planSha256-cne$ApprovedPlanSha256.ToLowerInvariant()){throw'APPROVED_PLAN_MISMATCH'}
}
