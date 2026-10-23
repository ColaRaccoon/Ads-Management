param([Parameter(Mandatory)][string]$ExpectedDeploymentId,[Parameter(Mandatory)][string]$ExpectedSourceSha,[Parameter(Mandatory)][string]$EvidencePath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/phase10-ui-role-matrix.ps1" -ExpectedDeploymentId $ExpectedDeploymentId -ExpectedSourceSha $ExpectedSourceSha -EvidencePath $EvidencePath
function Get-Phase10PositiveHash([string]$Value){return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()}
function Get-Phase10PositiveDecimal($Value){if($null -eq $Value){return $null};return [decimal]::Parse([Convert]::ToString($Value,[Globalization.CultureInfo]::InvariantCulture),[Globalization.NumberStyles]::Float,[Globalization.CultureInfo]::InvariantCulture)}
$context=$null;$operator=$null;$headers=$null;$session=$null;$response=$null;$dashboard=$null;$adsets=$null;$loggedIn=$false;$loginVerified=$false;$passed=$false;$stage='IDENTITY';$safe=$null;$lastHttp=$null
try {
 if(Test-Path -LiteralPath $EvidencePath){throw 'evidence-exists'}
 $context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator;Assert-Phase08SourceContext $context $operator;Assert-Phase10RoleDeployment $ExpectedDeploymentId $ExpectedSourceSha
 $headers=@{Origin=$context.origin};$session=[Microsoft.PowerShell.Commands.WebRequestSession]::new();$stage='LOGIN'
 $response=Invoke-Phase08SourceRequest 'POST' '/backend-api/auth/login' @{email=$operator.email;password=$operator.password} $context $session $headers;Assert-Phase08LoginResponse $response $session $operator $context.origin;$loggedIn=$true;$loginVerified=$true;$response=$null
 $stage='POSITIVE_DASHBOARD';$response=Invoke-WebRequest -Uri ($context.origin+'/backend-api/dashboard/summary?from=2026-10-14&to=2026-10-14&deliveryStatus=all') -Headers $headers -WebSession $session -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck;$lastHttp=[DateTimeOffset]::UtcNow.ToString('o');if([int]$response.StatusCode -ne 200){throw 'positive-dashboard-http'};$dashboardHash=Get-Phase10PositiveHash $response.Content;$dashboard=$response.Content|ConvertFrom-Json;$response=$null
 $stage='POSITIVE_ADSETS';$response=Invoke-WebRequest -Uri ($context.origin+'/backend-api/metrics/adsets?from=2026-10-14&to=2026-10-14&deliveryStatus=all') -Headers $headers -WebSession $session -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck;$lastHttp=[DateTimeOffset]::UtcNow.ToString('o');if([int]$response.StatusCode -ne 200 -or $response.Content.Length -gt 2097152){throw 'positive-adsets-http'};$adsetsHash=Get-Phase10PositiveHash $response.Content;$adsets=@($response.Content|ConvertFrom-Json);$response=$null
 $spend=[decimal]0;$purchase=[decimal]0;$purchaseValue=[decimal]0;$missingPurchase=0;$missingPurchaseValue=0;$contexts=@();$apiRows=0;$safeRows=@()
 foreach($row in $adsets){
  $spend+=Get-Phase10PositiveDecimal $row.totals.spendUsd
  $count=$row.totals.providerPurchaseCount;$value=$row.totals.providerPurchaseValueUsd
  if($null -eq $count){$missingPurchase++}else{$purchase+=Get-Phase10PositiveDecimal $count};if($null -eq $value){$missingPurchaseValue++}else{$purchaseValue+=Get-Phase10PositiveDecimal $value}
  $contexts+=@($row.totals.providerPurchaseContext);if($row.totals.hasApiMetrics -eq $true){$apiRows++}
  $safeRows+=@{adsetId=$row.metaAdsetId;spendUsd=$row.totals.spendUsd;providerPurchaseCount=$count;providerPurchaseValueUsd=$value;providerPurchaseContext=$row.totals.providerPurchaseContext;hasApiMetrics=$row.totals.hasApiMetrics}
 }
 $safe=@{date='2026-10-14';deliveryStatus='all';preexistingAllRowsCriterion=@{rowCount=200;spendUsd='4968.99'};dashboard=@{responseSha256=$dashboardHash;totals=($dashboard.totals|Select-Object spendUsd,spendKrw,purchaseCount,providerPurchaseCount,providerPurchaseValueUsd,providerPurchaseContext,hasApiMetrics)};adsets=@{responseSha256=$adsetsHash;rowCount=$adsets.Count;apiRows=$apiRows;spendUsd=$spend.ToString([Globalization.CultureInfo]::InvariantCulture);providerPurchaseCount=$purchase.ToString([Globalization.CultureInfo]::InvariantCulture);providerPurchaseValueUsd=$purchaseValue.ToString([Globalization.CultureInfo]::InvariantCulture);missingPurchaseCountRows=$missingPurchase;missingPurchaseValueRows=$missingPurchaseValue;providerContexts=@($contexts|Select-Object -Unique);safeProjectionSha256=(Get-Phase10PositiveHash ($safeRows|ConvertTo-Json -Depth 5 -Compress))};legacyNumberApiPrecisionBoundary=$true}
 $passed=$adsets.Count -eq 200 -and $spend -eq [decimal]'4968.99' -and (Get-Phase10PositiveDecimal $dashboard.totals.spendUsd) -eq [decimal]'4968.99' -and $missingPurchase -eq 0 -and $missingPurchaseValue -eq 0 -and $apiRows -eq 200 -and @($contexts|Where-Object {$_ -cne 'MCP_PROVIDER_DEFAULT_UNVERIFIED'}).Count -eq 0
 $stage='FINAL_IDENTITY';Assert-Phase10RoleDeployment $ExpectedDeploymentId $ExpectedSourceSha
}catch{$passed=$false}
finally {
 if($loggedIn){try{$csrf=@($session.Cookies.GetCookies([Uri]$context.origin)|Where-Object {$_.Name -ceq '__Host-phase08-meta_csrf'});if($csrf.Count -ne 1){throw 'csrf'};$headers['X-CSRF-Token']=$csrf[0].Value;$response=Invoke-WebRequest -Uri ($context.origin+'/backend-api/auth/logout') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body '{}' -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck;$lastHttp=[DateTimeOffset]::UtcNow.ToString('o');if([int]$response.StatusCode -ne 204){throw 'logout'};$loggedIn=$false}catch{$passed=$false}}
 $receipt=@{kind='PHASE10_ACTUAL_POSITIVE_META_READ_REGRESSION';status=$(if($passed){'PASS'}else{'FAIL'});stage=$stage;observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$ExpectedDeploymentId;sourceSha=$ExpectedSourceSha;safe=$safe;lastAppHttpAt=$lastHttp;sessionMayRemain=$loggedIn;rawResponsesSaved=0;actualHttp=($null -ne $lastHttp);actualBrowser=$false;providerRequests=0;businessWrites=0;authSessionWritesExpected=$loginVerified}
 Write-Phase10RoleEvidence $receipt $EvidencePath
 if($headers){$headers.Clear()};$context=$null;$operator=$null;$session=$null;$response=$null;$dashboard=$null;$adsets=$null;$safeRows=$null;$csrf=$null
}
@{kind=$receipt.kind;status=$receipt.status;stage=$stage;lastAppHttpAt=$lastHttp;evidence=$EvidencePath}|ConvertTo-Json -Compress
if(-not $passed){exit 1}
