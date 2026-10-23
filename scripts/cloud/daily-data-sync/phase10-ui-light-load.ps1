param([Parameter(Mandatory)][string]$EvidencePath,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9-]{36}$')][string]$ExpectedDeploymentId,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSourceSha)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/source-connection-helpers.ps1"
$acceptancePath='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/evidence/light-read-acceptance.json'
$acceptance=Get-Content -LiteralPath $acceptancePath -Raw|ConvertFrom-Json
if($acceptance.requests -ne 40 -or $acceptance.concurrency -ne 4 -or $acceptance.maximumP95Ms -ne 3000 -or $acceptance.maximumErrors -ne 0){throw 'pretest-budget'}
$destination=[IO.Path]::GetFullPath($EvidencePath);if(Test-Path -LiteralPath $destination){throw 'evidence-exists'}
$origin='https://phase08-daily-data-sync-production.up.railway.app';$deployment=$ExpectedDeploymentId;$source=$ExpectedSourceSha
$operator=$null;$context=$null;$headers=$null;$loadHeaders=$null;$session=$null;$loggedIn=$false;$rows=@();$lastHttp=$null;$passed=$false;$stage='IDENTITY';$elapsed=0
function Assert-UiLoadDeployment {
 $state=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status}}}' @{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
 if($state.serviceInstance.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or $state.serviceInstance.environmentId -cne 'd261a432-a6a4-4031-b8ea-c619ac263cc3' -or $state.serviceInstance.latestDeployment.id -cne $deployment -or $state.serviceInstance.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or $state.variables.PHASE08_SOURCE_CONTENT_SHA256 -cne $source -or $state.variables.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $state.variables.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr'){throw 'load-deployment-identity'}
}
function Get-UiLoadSummary($Records){
 $values=@($Records|ForEach-Object {[double]$_.elapsedMs}|Sort-Object);$count=$values.Count
 return @{requests=$count;errors=@($Records|Where-Object {$_.httpStatus -ne 200}).Count;p95Ms=$(if($count){$values[[Math]::Ceiling($count*0.95)-1]}else{$null});totalBytes=($Records|Measure-Object -Property bytes -Sum).Sum}
}
try {
 $context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator;Assert-Phase08SourceContext $context $operator;Assert-UiLoadDeployment
 $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new();$headers=@{Origin=$origin};$stage='LOGIN'
 $response=Invoke-Phase08SourceRequest 'POST' '/backend-api/auth/login' @{email=$operator.email;password=$operator.password} $context $session $headers;Assert-Phase08LoginResponse $response $session $operator $origin;$loggedIn=$true;$response=$null
 $cookie=@($session.Cookies.GetCookies([Uri]$origin)|ForEach-Object {$_.Name+'='+$_.Value}) -join '; ';$loadHeaders=@{Cookie=$cookie;Origin=$origin;'x-user-activity-age'='0'};$cookie=$null
 $paths=@('/backend-api/dashboard/summary?from=2026-10-07&to=2026-10-07','/backend-api/storefront/summary?from=2026-10-09&to=2026-10-15')
 $stage='WARMUP';foreach($path in $paths){$response=Invoke-WebRequest -Uri ($origin+$path) -Headers $loadHeaders -TimeoutSec 45 -MaximumRedirection 0 -SkipHttpErrorCheck;if([int]$response.StatusCode -ne 200){throw 'warmup-response'};$response=$null}
 $stage='LOAD';$watch=[Diagnostics.Stopwatch]::StartNew()
 $rows=@(0..39|ForEach-Object -ThrottleLimit 4 -Parallel {
  $ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$requestIndex=$_;$availablePaths=$using:paths;$route=$availablePaths[$requestIndex%2];$requestHeaders=$using:loadHeaders;$requestOrigin=$using:origin;$status=0;$bytes=0;$requestWatch=[Diagnostics.Stopwatch]::StartNew()
  try{$reply=Invoke-WebRequest -Uri ($requestOrigin+$route) -Headers $requestHeaders -TimeoutSec 45 -MaximumRedirection 0 -SkipHttpErrorCheck;$status=[int]$reply.StatusCode;$bytes=[Text.Encoding]::UTF8.GetByteCount($reply.Content)}catch{}finally{$requestWatch.Stop();$reply=$null}
  @{index=$requestIndex;path=$route;httpStatus=$status;bytes=$bytes;elapsedMs=[Math]::Round($requestWatch.Elapsed.TotalMilliseconds,2);finishedAt=[DateTimeOffset]::UtcNow.ToString('o')}
 });$watch.Stop();$elapsed=[Math]::Round($watch.Elapsed.TotalMilliseconds,2);$stage='FINAL_IDENTITY';Assert-UiLoadDeployment
 $summary=Get-UiLoadSummary $rows;$passed=$summary.requests -eq 40 -and $summary.errors -eq 0 -and $summary.p95Ms -le 3000
}catch{$passed=$false}
finally {
 if($loggedIn){try{$csrf=@($session.Cookies.GetCookies([Uri]$origin)|Where-Object {$_.Name -ceq '__Host-phase08-meta_csrf'});if($csrf.Count -ne 1){throw 'csrf'};$headers['X-CSRF-Token']=$csrf[0].Value;$response=Invoke-WebRequest -Uri ($origin+'/backend-api/auth/logout') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body '{}' -TimeoutSec 45 -MaximumRedirection 0 -SkipHttpErrorCheck;$lastHttp=[DateTimeOffset]::UtcNow.ToString('o');if([int]$response.StatusCode -ne 204){throw 'logout'};$loggedIn=$false}catch{$passed=$false}}
 $summary=Get-UiLoadSummary $rows;$endpointSummaries=@($rows|Group-Object path|ForEach-Object {@{path=$_.Name;summary=(Get-UiLoadSummary @($_.Group))}})
 $result=@{kind='PHASE10_ACTUAL_CANDIDATE_LIGHT_READ_LOAD';deploymentId=$deployment;sourceSha=$source;classification='WARM_AUTHENTICATED_GETS_ONLY';acceptanceFile=$acceptancePath;acceptanceSha256=(Get-FileHash -LiteralPath $acceptancePath -Algorithm SHA256).Hash.ToLowerInvariant();status=$(if($passed){'PASS'}else{'FAIL'});stage=$stage;requests=$rows;summary=$summary;endpoints=$endpointSummaries;wallMs=$elapsed;concurrency=4;warmupRequests=2;lastAppHttpAt=$lastHttp;sessionMayRemain=$loggedIn;providerCollectionRequests=0;businessWrites=0;rawResponsesSaved=0;notVerified=$acceptance.unverified}
 $data=[Text.UTF8Encoding]::new($false).GetBytes(($result|ConvertTo-Json -Depth 10));$stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($data,0,$data.Length)}finally{$stream.Dispose()}
 if($headers){$headers.Clear()};if($loadHeaders){$loadHeaders.Clear()};$context=$null;$operator=$null;$session=$null;$response=$null;$csrf=$null
}
@{kind=$result.kind;status=$result.status;summary=$summary;lastAppHttpAt=$lastHttp;evidence=$destination}|ConvertTo-Json -Compress
if(-not $passed){exit 1}
