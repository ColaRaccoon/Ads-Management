#Requires -Version 5.1
$ErrorActionPreference='Stop';. (Join-Path $PSScriptRoot 'approval-plan.ps1')
function Assert-ApprovalAdminOnlyParent([string]$Path) { if(-not(Test-Path -LiteralPath (Split-Path -Parent $Path) -PathType Container)){throw 'TEST_LEDGER_PARENT_MISSING'} }
function ReturnScalar { $value='ok';return $value }
function ReturnArray { return @(1,2) }
function ReturnObject { return [pscustomobject]@{result='ok'} }
if((ReturnScalar)-cne'ok'-or@(ReturnArray).Count-ne2-or(ReturnObject).result-cne'ok'){throw 'RETURN_RUNTIME_CONTRACT_FAILED'}
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('metaads-approval-'+[guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($testRoot)|Out-Null
try{
  $helperPath=Join-Path $testRoot 'helper.ps1';[IO.File]::WriteAllText($helperPath,"function Invoke-PinnedHelperRuntime { return 'pinned-ok' }",(New-Object Text.UTF8Encoding($false)));$helperHash=Get-ApprovalFileSha256 $helperPath;. (Import-PinnedHelperScriptBlock $helperPath $helperHash 'PINNED_HELPER_REJECTED');if((Invoke-PinnedHelperRuntime)-cne'pinned-ok'){throw 'PINNED_HELPER_RUNTIME_FAILED'}
  [IO.File]::AppendAllText($helperPath,"`n# mutation",(New-Object Text.UTF8Encoding($false)));try{. (Import-PinnedHelperScriptBlock $helperPath $helperHash 'PINNED_HELPER_REJECTED');throw 'PINNED_HELPER_MUTATION_ACCEPTED'}catch{if($_.Exception.Message-cne'PINNED_HELPER_REJECTED'){throw}}
  $Action='Apply';$ApprovalNonce='a'*64;$ApprovalIssuedAt=[datetimeoffset]::UtcNow.AddSeconds(-1).ToString('o');$ApprovalExpiresAt=[datetimeoffset]::UtcNow.AddMinutes(5).ToString('o');$ApprovalInstanceId=[guid]::NewGuid().ToString('D').ToLowerInvariant();$ApprovalLedgerPath=Join-Path $testRoot 'consumed.jsonl';$script:ApprovalContext=$null
  $plan=New-ApprovalPlan $PSCommandPath 'Test' ([ordered]@{value='exact'}) 'test target' 'test impact' 'test rollback';Assert-ApprovedPlan $plan $true $plan.planSha256
  try{Assert-ApprovedPlan $plan $true $plan.planSha256;throw 'REPLAY_WAS_ACCEPTED'}catch{if($_.Exception.Message-cne'APPROVAL_PLAN_REPLAY_REJECTED'){throw}}
  $expiredIssued=[datetimeoffset]::UtcNow.AddMinutes(-20);$ApprovalNonce='b'*64;$ApprovalIssuedAt=$expiredIssued.ToString('o');$ApprovalExpiresAt=$expiredIssued.AddMinutes(5).ToString('o');$ApprovalInstanceId=[guid]::NewGuid().ToString('D').ToLowerInvariant();$script:ApprovalContext=$null
  $expired=New-ApprovalPlan $PSCommandPath 'Test' ([ordered]@{value='expired'}) 'test target' 'test impact' 'test rollback'
  try{Assert-ApprovedPlan $expired $true $expired.planSha256;throw 'EXPIRED_WAS_ACCEPTED'}catch{if($_.Exception.Message-cne'APPROVAL_EXPIRED_OR_NOT_YET_VALID'){throw}}
  $oversizedIssued=[datetimeoffset]::UtcNow;$ApprovalNonce='c'*64;$ApprovalIssuedAt=$oversizedIssued.ToString('o');$ApprovalExpiresAt=$oversizedIssued.AddMinutes(11).ToString('o');$ApprovalInstanceId=[guid]::NewGuid().ToString('D').ToLowerInvariant();$script:ApprovalContext=$null
  try{[void](New-ApprovalPlan $PSCommandPath 'Test' ([ordered]@{value='oversized'}) 'test target' 'test impact' 'test rollback');throw 'OVERSIZED_WINDOW_ACCEPTED'}catch{if($_.Exception.Message-cne'APPROVAL_WINDOW_INVALID'){throw}}
  [pscustomobject]@{result='PASS';returnRuntime=$true;pinnedHelperRuntime=$true;pinnedHelperMutationRejected=$true;replayRejected=$true;expiryRejected=$true;oversizedWindowRejected=$true}|ConvertTo-Json -Compress
}finally{if(Test-Path -LiteralPath $testRoot){[IO.Directory]::Delete($testRoot,$true)}}
