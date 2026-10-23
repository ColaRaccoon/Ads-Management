param(
 [Parameter(Mandatory)][ValidateSet('BASELINE08','CANDIDATE10')][string]$Classification,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9-]{36}$')][string]$ExpectedDeploymentId,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSourceSha,
 [Parameter(Mandatory)][string]$EvidencePath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/source-connection-helpers.ps1"
$origin='https://phase08-daily-data-sync-production.up.railway.app'
$destination=[IO.Path]::GetFullPath($EvidencePath)
if((Test-Path -LiteralPath $destination) -or -not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($destination)) -PathType Container)){throw 'PHASE10_HTTP_EVIDENCE_PATH'}
$checks=[Collections.Generic.List[object]]::new();$operator=$null;$context=$null;$headers=$null;$session=$null;$loggedIn=$false;$loginVerified=$false;$logoutAttempted=$false;$lastHttpAt=$null;$stage='IDENTITY';$passed=$false
function Assert-UiDeployment {
 $state=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status}}}' @{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
 if($state.serviceInstance.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or $state.serviceInstance.environmentId -cne 'd261a432-a6a4-4031-b8ea-c619ac263cc3' -or $state.serviceInstance.latestDeployment.id -cne $ExpectedDeploymentId -or $state.serviceInstance.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or $state.variables.PHASE08_SOURCE_CONTENT_SHA256 -cne $ExpectedSourceSha -or $state.variables.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $state.variables.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr' -or $state.variables.AUTH_PROVIDER -cne 'supabase'){throw 'PHASE10_HTTP_DEPLOYMENT_IDENTITY'}
 $state=$null
}
function Invoke-UiHttp([string]$Method,[string]$Path,$Body,[int[]]$Expected) {
 $allowGet=@('/auth/me','/dashboard/summary?from=2026-10-07&to=2026-10-07','/dashboard/trends?from=2026-10-07&to=2026-10-07','/metrics/adsets?from=2026-10-07&to=2026-10-07','/uploads','/sales/cafe24/uploads','/sales/product-performance?from=2026-10-15&to=2026-10-15','/sales/cafe24/unmatched?from=2026-10-15&to=2026-10-15','/sales/cafe24/coupon-matches?from=2026-10-15&to=2026-10-15','/coupang/dashboard?from=2026-10-07&to=2026-10-07&groupBy=product','/reports','/source-coverage/schedule-warnings','/storefront/summary?from=2026-10-09&to=2026-10-15')
 if(($Method -ceq 'GET' -and $Path -cnotin $allowGet) -or ($Method -ceq 'POST' -and $Path -cnotin @('/auth/login','/auth/refresh','/auth/logout')) -or $Method -cnotin @('GET','POST')){throw 'PHASE10_HTTP_ROUTE'}
 $request=@{Uri=$origin+'/backend-api'+$Path;Method=$Method;Headers=$headers;WebSession=$session;MaximumRedirection=0;TimeoutSec=45;SkipHttpErrorCheck=$true}
 if($Method -ceq 'POST'){$request.ContentType='application/json';$request.Body=($Body|ConvertTo-Json -Compress)}
 $watch=[Diagnostics.Stopwatch]::StartNew()
 try {$response=Invoke-WebRequest @request}finally{$script:lastHttpAt=[DateTimeOffset]::UtcNow.ToString('o');$watch.Stop()}
 if($response.Content.Length -gt 2097152){throw 'PHASE10_HTTP_RESPONSE_LIMIT'}
 foreach($secret in @($operator.password)+@($session.Cookies.GetCookies([Uri]$origin)|ForEach-Object {$_.Value})){if($secret -and $response.Content.Contains($secret)){throw 'PHASE10_HTTP_SECRET_IN_BODY'}}
 $status=[int]$response.StatusCode;$safeCode=$null
 if($status -ge 400){try{$payload=$response.Content|ConvertFrom-Json;if($payload.code -cin (Get-Phase08SourceSafeCodes)){$safeCode=$payload.code}}catch{}}
 $checks.Add(@{method=$Method;path=$Path;httpStatus=$status;safeCode=$safeCode;elapsedMs=[Math]::Round($watch.Elapsed.TotalMilliseconds,2);bytes=[Text.Encoding]::UTF8.GetByteCount($response.Content);status=$(if($status -in $Expected){'PASS'}else{'FAIL'})})
 return $response
}
function Set-UiCsrf {
 $csrf=@($session.Cookies.GetCookies([Uri]$origin)|Where-Object {$_.Name -ceq '__Host-phase08-meta_csrf'})
 if($csrf.Count -ne 1 -or [string]::IsNullOrEmpty($csrf[0].Value)){throw 'PHASE10_HTTP_CSRF'}
 $headers['X-CSRF-Token']=$csrf[0].Value;$csrf=$null
}
try {
 $context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator;Assert-Phase08SourceContext $context $operator;Assert-UiDeployment
 $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new();$headers=@{Origin=$origin}
 $stage='ANONYMOUS';$null=Invoke-UiHttp 'GET' '/auth/me' $null @(401)
 $stage='LOGIN';$response=Invoke-UiHttp 'POST' '/auth/login' @{email=$operator.email;password=$operator.password} @(200)
 Assert-Phase08LoginResponse $response $session $operator $origin;$loggedIn=$true;$loginVerified=$true;$response=$null;Set-UiCsrf
 $stage='SESSION';$response=Invoke-UiHttp 'GET' '/auth/me' $null @(200);$me=$response.Content|ConvertFrom-Json
 if($me.user.id -cne $operator.appId -or $me.user.role -cne 'SUPER_ADMIN' -or $me.permissions -cnotcontains 'settings.manage'){throw 'PHASE10_HTTP_PRINCIPAL'};$me=$null;$response=$null
 $null=Invoke-UiHttp 'POST' '/auth/refresh' @{} @(200);Set-UiCsrf
 $null=Invoke-UiHttp 'GET' '/auth/me' $null @(200)
 $stage='READS'
 foreach($path in @('/dashboard/summary?from=2026-10-07&to=2026-10-07','/dashboard/trends?from=2026-10-07&to=2026-10-07','/metrics/adsets?from=2026-10-07&to=2026-10-07','/uploads','/sales/cafe24/uploads','/sales/product-performance?from=2026-10-15&to=2026-10-15','/sales/cafe24/unmatched?from=2026-10-15&to=2026-10-15','/sales/cafe24/coupon-matches?from=2026-10-15&to=2026-10-15','/coupang/dashboard?from=2026-10-07&to=2026-10-07&groupBy=product','/reports','/source-coverage/schedule-warnings')){$null=Invoke-UiHttp 'GET' $path $null @(200)}
 if($Classification -ceq 'CANDIDATE10'){$null=Invoke-UiHttp 'GET' '/storefront/summary?from=2026-10-09&to=2026-10-15' $null @(200)}
 $stage='LOGOUT';$logoutAttempted=$true;$response=Invoke-UiHttp 'POST' '/auth/logout' @{} @(204);if([int]$response.StatusCode -ne 204){throw 'PHASE10_HTTP_LOGOUT'};$loggedIn=$false;$response=$null
 $null=Invoke-UiHttp 'GET' '/auth/me' $null @(401)
 $stage='FINAL_IDENTITY';Assert-UiDeployment
 $passed=@($checks|Where-Object {$_.status -cne 'PASS'}).Count -eq 0
}catch{$checks.Add(@{name='control';stage=$stage;status='FAIL';rawErrorSuppressed=$true})}
finally {
 if($loggedIn -and -not $logoutAttempted){try{Set-UiCsrf;$logoutAttempted=$true;$response=Invoke-UiHttp 'POST' '/auth/logout' @{} @(204);$loggedIn=([int]$response.StatusCode -ne 204)}catch{$checks.Add(@{name='logout-cleanup';status='FAIL';rawErrorSuppressed=$true})}}
 $result=@{kind='PHASE10_UI_ACTUAL_HTTP_REGRESSION';classification=$Classification;deploymentId=$ExpectedDeploymentId;sourceSha=$ExpectedSourceSha;observedAt=[DateTimeOffset]::UtcNow.ToString('o');lastAppHttpAt=$lastHttpAt;status=$(if($passed){'PASS'}else{'FAIL'});checks=@($checks.ToArray());actualHttp=($null -ne $lastHttpAt);actualBrowser=$false;syntheticAccountIdentity=$true;actualSupabaseAuth=$loginVerified;providerCollectionRequests=0;businessWrites=0;authSessionWritesExpected=$loginVerified;logoutAttempted=$logoutAttempted;sessionMayRemain=$loggedIn;notVerified=@('browser-normal-login','other-role-matrix','invitation','upload-persistence','source-restore-delete','report-generation','mixed-load')}
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($result|ConvertTo-Json -Depth 8));$stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 if($headers){$headers.Clear()};$context=$null;$operator=$null;$headers=$null;$session=$null;$response=$null
}
Write-Output (@{kind=$result.kind;classification=$Classification;status=$result.status;checks=$checks.Count;lastAppHttpAt=$lastHttpAt;sessionMayRemain=$loggedIn;evidence=$destination}|ConvertTo-Json -Compress)
if(-not $passed){exit 1}
