Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-final-secret-scan-20261021.ps1"
$passed=0;$canary='SYNTHETIC_NOT_A_REAL_SECRET_1234567890'
try{
 $r=Test-IndependentIncidentSecretText ('x'+$canary+'y') @($canary);if($r.literalMatchCount -ne 1){throw 'LITERAL'};$passed++
 $r=Test-IndependentIncidentSecretText 'metadata-only' @($canary);if($r.literalMatchCount -ne 0 -or $r.patternMatchCount -ne 0){throw 'CLEAN'};$passed++
 $r=Test-IndependentIncidentSecretText ('sb_secret_'+('A'*32)) @();if($r.patternMatchCount -ne 1){throw 'KEY_PATTERN'};$passed++
 $r=Test-IndependentIncidentSecretText ('postgresql://test:'+('A'*40)+'@example.invalid/db') @();if($r.patternMatchCount -ne 1){throw 'PASSWORD_PATTERN'};$passed++
 $r=Test-IndependentIncidentSecretText ('x'+$canary+'y') @($canary);$json=$r|ConvertTo-Json -Compress;if($json.Contains($canary)){throw 'COUNT_ONLY'};$passed++
 @{kind='INCIDENT_SECRET_SCAN_LOCAL_TEST';passed=$passed;credentialReads=0;remoteRequests=0;rawSecretsReturned=0}|ConvertTo-Json -Compress
}catch{@{kind='INCIDENT_SECRET_SCAN_LOCAL_TEST';passed=$passed;status='FAIL';rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
