Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/source-connection-helpers.ps1"
function Assert-Test($condition){if(-not $condition){throw 'PHASE08_DIAGNOSTIC_SYNTHETIC_ASSERT'}}
$secret='SYNTHETIC_RAW_SECRET_NEVER_OUTPUT'
$cases=0
foreach($code in @('RECONCILIATION_FAILED','PROVIDER_AUTH_REQUIRED','FIELD_UNSUPPORTED','ATTRIBUTION_MISMATCH','PERMISSION_DENIED','INTERNAL_SERVER_ERROR')) {
  $exception=New-Phase08SourceHttpException ([pscustomobject]@{StatusCode=409;Content=(@{code=$code;message=$secret;details=@{token=$secret};requestId=$secret}|ConvertTo-Json -Depth 4 -Compress)})
  try{throw $exception}catch{$diagnostic=Get-Phase08SourceFailureDiagnostic $_.Exception}
  Assert-Test ($diagnostic.code -ceq $code -and $diagnostic.httpStatus -eq 409 -and -not ($diagnostic|ConvertTo-Json).Contains($secret))
  Assert-Test ($exception.Data.Keys.Count -eq 2);$cases++
}
foreach($content in @(('not-json '+$secret),('{"code":"'+$secret+'","message":"'+$secret+'"}'),'{"code":{"token":"SYNTHETIC_RAW_SECRET_NEVER_OUTPUT"}}')) {
  $diagnostic=Get-Phase08SourceFailureDiagnostic (New-Phase08SourceHttpException ([pscustomobject]@{StatusCode=503;Content=$content}))
  Assert-Test ($diagnostic.code -ceq 'SOURCE_HTTP_FAILED' -and $diagnostic.httpStatus -eq 503 -and -not ($diagnostic|ConvertTo-Json).Contains($secret));$cases++
}
$diagnostic=Get-Phase08SourceFailureDiagnostic (New-Phase08SourceHttpException ([pscustomobject]@{StatusCode=502;Content=('x'*1048577)}))
Assert-Test ($diagnostic.code -ceq 'SOURCE_RESPONSE_REJECTED' -and $diagnostic.httpStatus -eq 502);$cases++
$diagnostic=Get-Phase08SourceFailureDiagnostic (New-Phase08SourceHttpException $null)
Assert-Test ($diagnostic.code -ceq 'SOURCE_NETWORK_FAILED' -and $null -eq $diagnostic.httpStatus);$cases++
$forged=[Exception]::new($secret);$forged.Data['Phase08SafeCode']=$secret;$forged.Data['Phase08HttpStatus']=$secret
$diagnostic=Get-Phase08SourceFailureDiagnostic $forged
Assert-Test ($diagnostic.code -ceq 'SOURCE_CONTROL_REJECTED' -and $null -eq $diagnostic.httpStatus);$cases++
function Invoke-WebRequest {param($Uri,$Method,$Headers,$WebSession,$MaximumRedirection,$TimeoutSec,$SkipHttpErrorCheck,$ContentType,$Body)
  if($script:syntheticNetworkFailure){throw $secret};return $script:syntheticResponse
}
$script:syntheticNetworkFailure=$false
$script:syntheticResponse=[pscustomobject]@{StatusCode=409;Content='{"code":"RECONCILIATION_FAILED","message":"SYNTHETIC_RAW_SECRET_NEVER_OUTPUT"}'}
try{$discard=Invoke-Phase08SourceRequest 'POST' '/backend-api/source-connections/11111111-1111-1111-1111-111111111111/verify-meta' @{} ([pscustomobject]@{origin='https://phase08-daily-data-sync-production.up.railway.app'}) $null @{}}catch{$diagnostic=Get-Phase08SourceFailureDiagnostic $_.Exception}
Assert-Test ($diagnostic.code -ceq 'RECONCILIATION_FAILED' -and $diagnostic.httpStatus -eq 409);$cases++
$script:syntheticNetworkFailure=$true
try{$discard=Invoke-Phase08SourceRequest 'GET' '/backend-api/source-connections?limit=200&page=1' $null ([pscustomobject]@{origin='https://phase08-daily-data-sync-production.up.railway.app'}) $null @{}}catch{$diagnostic=Get-Phase08SourceFailureDiagnostic $_.Exception}
Assert-Test ($diagnostic.code -ceq 'SOURCE_NETWORK_FAILED' -and $null -eq $diagnostic.httpStatus);$cases++
$script:syntheticNetworkFailure=$false;$script:syntheticResponse=[pscustomobject]@{StatusCode=200;Content='{"synthetic":"unchanged"}'}
$result=Invoke-Phase08SourceRequest 'GET' '/backend-api/source-connections?limit=200&page=1' $null ([pscustomobject]@{origin='https://phase08-daily-data-sync-production.up.railway.app'}) $null @{}
Assert-Test ([object]::ReferenceEquals($result,$script:syntheticResponse));$cases++
@{state='PHASE08_SOURCE_HTTP_DIAGNOSTIC_SYNTHETIC_PASS';cases=$cases;networkRequests=0;credentialReads=0}|ConvertTo-Json
