param(
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$PlanSha,
 [ValidateRange(0,1499)][int]$Offset=0,
 [ValidateRange(1,1500)][int]$EndOffset=1500,
 [ValidateSet('native','names','final')][string]$Phase='native'
)
$ErrorActionPreference='Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
 $productsPrefix=if($Phase -eq 'final'){'products-final'}elseif($Phase -eq 'names'){'products-names'}else{'products'}
 $productsQueuePath="docs/product-performance/research/11-$productsPrefix-queue.json"
 $productsQueue=Get-Content -LiteralPath $productsQueuePath -Raw|ConvertFrom-Json
 if($productsQueue.status -ne 'PASS' -or $productsQueue.planSha256 -ne $PlanSha -or $productsQueue.jobs.Count -ge 1500){throw 'PRODUCTS_REVIEWED_QUEUE_REQUIRED'}
 while($Offset -lt [Math]::Min($productsQueue.jobs.Count,$EndOffset)){
  try {
   $productsLimit=[Math]::Min(25,[Math]::Min($productsQueue.jobs.Count,$EndOffset)-$Offset)
   & "$PSScriptRoot/unified-stage11-credentials.ps1" -Action Run -ScriptPath scripts/unified-stage11-operator.ts -ScriptArguments @('--action=products-work',"--phase=$Phase","--plan-sha=$PlanSha","--offset=$Offset","--limit=$productsLimit")
   Write-Output "PRODUCTS_BATCH_COMPLETED=$Offset"
   $Offset+=25
  }catch{
   $productsEvidencePath="docs/product-performance/research/11-$productsPrefix-work-$Offset.json"
   $productsEvidence=Get-Content -LiteralPath $productsEvidencePath -Raw|ConvertFrom-Json
   if($productsEvidence.status -ne 'FAIL' -or $productsEvidence.planSha256 -ne $PlanSha -or $productsEvidence.failedJobId -notmatch '^[a-f0-9-]{36}$'){throw 'PRODUCTS_UNEXPECTED_FAILURE_REQUIRES_REVIEW'}
   $productsTimeout=($productsEvidence.sourceFailure.prismaCode -eq 'P2028' -or $productsEvidence.publicationFailure.prismaCode -eq 'P2028')
   if(-not $productsTimeout){throw 'PRODUCTS_NON_TIMEOUT_FAILURE_REQUIRES_REVIEW'}
   $productsQueue=Get-Content -LiteralPath $productsQueuePath -Raw|ConvertFrom-Json
   $productsFailedJob=@($productsQueue.jobs|Where-Object jobId -eq $productsEvidence.failedJobId)[0]
   if(-not $productsFailedJob){throw 'PRODUCTS_FAILED_JOB_NOT_IN_QUEUE'}
   $productsPriorRetries=@($productsQueue.retries|Where-Object {$_.platform -eq $productsFailedJob.platform -and $_.scopeKey -eq $productsFailedJob.scopeKey -and $_.date -eq $productsFailedJob.date}).Count
   if($productsPriorRetries -ge 2){throw 'PRODUCTS_RETRY_BUDGET_EXHAUSTED'}
   Copy-Item -LiteralPath $productsEvidencePath -Destination "docs/product-performance/research/11-$productsPrefix-failure-$($productsEvidence.failedJobId).json"
   $productsFailedId=$productsEvidence.failedJobId
   $Offset=[Array]::FindIndex([object[]]$productsQueue.jobs,[Predicate[object]]{param($candidate)$candidate.jobId -eq $productsFailedId})
   if($Offset -lt 0){throw 'PRODUCTS_FAILED_JOB_NOT_IN_QUEUE'}
   & "$PSScriptRoot/unified-stage11-credentials.ps1" -Action Run -ScriptPath scripts/unified-stage11-operator.ts -ScriptArguments @('--action=products-retry',"--phase=$Phase","--plan-sha=$PlanSha","--job=$productsFailedId")
   Write-Output "PRODUCTS_TIMEOUT_RETRY_OFFSET=$Offset"
   Start-Sleep -Milliseconds 500
  }
 }
}finally{Pop-Location}
