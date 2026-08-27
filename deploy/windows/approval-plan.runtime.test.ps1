#Requires -Version 5.1
$ErrorActionPreference='Stop';. (Join-Path $PSScriptRoot 'approval-plan.ps1')
function Assert-ApprovalAdminOnlyParent([string]$Path) { if(-not(Test-Path -LiteralPath (Split-Path -Parent $Path) -PathType Container)){throw 'TEST_LEDGER_PARENT_MISSING'} }
function ReturnScalar { $value='ok';return $value }
function ReturnArray { return @(1,2) }
function ReturnObject { return [pscustomobject]@{result='ok'} }
if((ReturnScalar)-cne'ok'-or@(ReturnArray).Count-ne2-or(ReturnObject).result-cne'ok'){throw 'RETURN_RUNTIME_CONTRACT_FAILED'}
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('metaads-approval-'+[guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($testRoot)|Out-Null
try{
  $Action='Apply';$ApprovalNonce='a'*64;$ApprovalIssuedAt=[datetimeoffset]::UtcNow.AddSeconds(-1).ToString('o');$ApprovalExpiresAt=[datetimeoffset]::UtcNow.AddMinutes(5).ToString('o');$ApprovalInstanceId=[guid]::NewGuid().ToString('D').ToLowerInvariant();$ApprovalLedgerPath=Join-Path $testRoot 'consumed.jsonl';$script:ApprovalContext=$null
  $plan=New-ApprovalPlan $PSCommandPath 'Test' ([ordered]@{value='exact'}) 'test target' 'test impact' 'test rollback';Assert-ApprovedPlan $plan $true $plan.planSha256
  try{Assert-ApprovedPlan $plan $true $plan.planSha256;throw 'REPLAY_WAS_ACCEPTED'}catch{if($_.Exception.Message-cne'APPROVAL_PLAN_REPLAY_REJECTED'){throw}}
  $ApprovalNonce='b'*64;$ApprovalIssuedAt=[datetimeoffset]::UtcNow.AddMinutes(-20).ToString('o');$ApprovalExpiresAt=[datetimeoffset]::UtcNow.AddMinutes(-10).ToString('o');$ApprovalInstanceId=[guid]::NewGuid().ToString('D').ToLowerInvariant();$script:ApprovalContext=$null
  $expired=New-ApprovalPlan $PSCommandPath 'Test' ([ordered]@{value='expired'}) 'test target' 'test impact' 'test rollback'
  try{Assert-ApprovedPlan $expired $true $expired.planSha256;throw 'EXPIRED_WAS_ACCEPTED'}catch{if($_.Exception.Message-cne'APPROVAL_EXPIRED_OR_NOT_YET_VALID'){throw}}
  [pscustomobject]@{result='PASS';returnRuntime=$true;replayRejected=$true;expiryRejected=$true}|ConvertTo-Json -Compress
}finally{if(Test-Path -LiteralPath $testRoot){[IO.Directory]::Delete($testRoot,$true)}}
