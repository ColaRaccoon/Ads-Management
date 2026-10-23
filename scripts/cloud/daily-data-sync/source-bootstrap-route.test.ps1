Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/source-connection-helpers.ps1"
$script:requests=0
function Invoke-WebRequest {
 param($Uri,$Method,$Headers,$WebSession,$MaximumRedirection,$TimeoutSec,[switch]$SkipHttpErrorCheck,$ContentType,$Body)
 if($Uri -cne 'https://phase08-daily-data-sync-production.up.railway.app/backend-api/source-connections/0c35defe-45fc-4a54-bc79-704df7bca5b1/cafe24-scheduled-bootstrap' -or
    $MaximumRedirection -ne 0 -or $TimeoutSec -ne 90){throw 'SYNTHETIC_ASSERT'}
 $script:requests++;return [pscustomobject]@{StatusCode=200;Content='{}'}
}
$context=[pscustomobject]@{origin='https://phase08-daily-data-sync-production.up.railway.app'}
$path='/backend-api/source-connections/0c35defe-45fc-4a54-bc79-704df7bca5b1/cafe24-scheduled-bootstrap'
foreach($method in @('GET','POST')){$discard=Invoke-Phase08SourceRequest $method $path @{} $context $null @{}}
if($script:requests -ne 2){throw 'SYNTHETIC_ASSERT'}
$badPaths=@(($path+'?extra=1'),($path+'/'),($path.Replace('0c35defe-45fc-4a54-bc79-704df7bca5b1','b9ebee4b-5d4e-4eae-92b9-9facfbf3c900')))
if($badPaths.Count -ne 3){throw 'SYNTHETIC_ASSERT'}
foreach($bad in $badPaths) {
 $rejected=$false;try{$discard=Invoke-Phase08SourceRequest 'POST' $bad @{} $context $null @{}}catch{$rejected=$true}
 if(-not $rejected -or $script:requests -ne 2){throw 'SYNTHETIC_ASSERT'}
}
$rejected=$false;try{$discard=Invoke-Phase08SourceRequest 'PUT' $path @{} $context $null @{}}catch{$rejected=$true}
if(-not $rejected -or $script:requests -ne 2){throw 'SYNTHETIC_ASSERT'}
$rejected=$false;try{$discard=Invoke-Phase08SourceRequest 'POST' $path @{} ([pscustomobject]@{origin='https://patimagroup-work.com'}) $null @{}}catch{$rejected=$true}
if(-not $rejected -or $script:requests -ne 2){throw 'SYNTHETIC_ASSERT'}
@{state='PHASE08_BOOTSTRAP_ORIGINAL_ROUTE_SYNTHETIC_PASS';cases=7;networkRequests=0;credentialReads=0;providerRequests=0}|ConvertTo-Json
