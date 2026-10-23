param([Parameter(Mandatory)][ValidateSet('Preview','Bootstrap')][string]$Mode,
 [Parameter(Mandatory)][Alias('ReviewedV6ReadyVerified')][switch]$ReviewedApplicationReadyVerified)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/source-connection-helpers.ps1"
$context=$null;$operator=$null;$headers=$null;$session=$null;$body=$null;$response=$null;$preview=$null
$phase08BootstrapStage='CONTEXT'
try {
 if(-not $ReviewedApplicationReadyVerified){throw 'reviewed-application-proof-required'}
 $context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator
 Assert-Phase08SourceContext $context $operator
 $headers=@{Origin=$context.origin};$session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
 $body=@{email=$operator.email;password=$operator.password}
 $phase08BootstrapStage='LOGIN'
 $response=Invoke-Phase08SourceRequest 'POST' '/backend-api/auth/login' $body $context $session $headers
 Assert-Phase08LoginResponse $response $session $operator $context.origin;$body=$null;$response=$null
 $csrf=@($session.Cookies.GetCookies([Uri]$context.origin)|Where-Object {$_.Name -ceq '__Host-phase08-meta_csrf'})
 if($csrf.Count -ne 1){throw 'csrf'};$headers['X-CSRF-Token']=$csrf[0].Value
 $path='/backend-api/source-connections/0c35defe-45fc-4a54-bc79-704df7bca5b1/cafe24-scheduled-bootstrap'
 $phase08BootstrapStage='PREVIEW'
 $response=Invoke-Phase08SourceRequest 'GET' $path $null $context $session $headers
 $preview=$response.Content|ConvertFrom-Json -DateKind String
 if($preview.connectionId -cne '0c35defe-45fc-4a54-bc79-704df7bca5b1' -or $preview.accessState -cne 'READY' -or
    $preview.enabled -isnot [bool] -or $preview.enabled -ne $false -or
    $preview.configurationDigest -isnot [string] -or $preview.configurationDigest -cnotmatch '^[a-f0-9]{64}$' -or
    $preview.updatedAt -isnot [string] -or [DateTimeOffset]::Parse($preview.updatedAt).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') -cne $preview.updatedAt){throw 'preview-binding'}
 if($Mode -ceq 'Preview') {
  @{state='PHASE08_CAFE24_SCHEDULED_BOOTSTRAP_PREVIEW_VERIFIED';connectionId=$preview.connectionId;enabled=$false;accessState='READY';providerRequests=0;csvUploads=0}|ConvertTo-Json
 } else {
  $today=[TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow,'Korea Standard Time').ToString('yyyy-MM-dd')
  $body=@{fromDate=$today;expectedUpdatedAt=$preview.updatedAt;expectedConfigurationDigest=$preview.configurationDigest;
   acknowledgement='ENABLE_CAFE24_SCHEDULED_API_ONLY_WITHOUT_CSV';couponInputSource='API_ACTUAL_PRODUCT_PLUS_SHIPPING'}
  $phase08BootstrapStage='BOOTSTRAP'
  $response=Invoke-Phase08SourceRequest 'POST' $path $body $context $session $headers
  $result=$response.Content|ConvertFrom-Json -DateKind String
  $phase08BootstrapStage='OUTCOME'
  if($result.connectionId -cne $preview.connectionId -or $result.enabled -isnot [bool] -or $result.enabled -ne $true -or
     $result.accessState -cne 'READY' -or $result.fromDate -cne $today -or $result.primarySource -cne 'CSV' -or $result.policyVersion -ne 1 -or
     $result.apiActivated -isnot [bool] -or $result.apiActivated -ne $false -or $result.providerRequests -ne 0 -or $result.csvUploads -ne 0){throw 'outcome-inspect'}
  @{state='PHASE08_CAFE24_NORMAL_SCHEDULED_BOOTSTRAP_SUCCEEDED';connectionId=$result.connectionId;enabled=$true;accessState='READY';fromDate=$today;
   initialPrimarySource='CSV';policyVersion=1;apiActivated=$false;providerRequests=0;csvUploads=0;requiresCompletedDayScheduledPromotion=$true}|ConvertTo-Json
 }
} catch {
 $diagnostic=Get-Phase08SourceFailureDiagnostic $_.Exception
 @{state='PHASE08_CAFE24_SCHEDULED_BOOTSTRAP_FAILED';mode=$Mode;stage=$phase08BootstrapStage;httpStatus=$diagnostic.httpStatus;code=$diagnostic.code;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1
} finally {if($headers){$headers.Clear()};$context=$null;$operator=$null;$headers=$null;$session=$null;$body=$null;$response=$null;$preview=$null;$csrf=$null;$result=$null}
