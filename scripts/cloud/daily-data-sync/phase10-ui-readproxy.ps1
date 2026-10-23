param(
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9-]{36}$')][string]$ExpectedDeploymentId,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSourceSha,
 [Parameter(Mandatory)][string]$EvidencePath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/source-connection-helpers.ps1"
$destination=[IO.Path]::GetFullPath($EvidencePath)
if((Test-Path -LiteralPath $destination) -or -not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($destination)) -PathType Container)){throw 'PHASE10_PROXY_EVIDENCE_PATH'}
$context=$null;$operator=$null;$headers=$null;$session=$null;$response=$null;$payload=$null;$loggedIn=$false;$loginVerified=$false;$proxyClosed=$false;$lastHttpAt=$null;$proxyEvidence=$null;$status='FAIL';$stage='IDENTITY'
try {
 $context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator;Assert-Phase08SourceContext $context $operator
 $state=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status}}}' @{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
 if($state.serviceInstance.serviceId -cne $context.serviceId -or $state.serviceInstance.environmentId -cne 'd261a432-a6a4-4031-b8ea-c619ac263cc3' -or $state.serviceInstance.latestDeployment.id -cne $ExpectedDeploymentId -or $state.serviceInstance.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or $state.variables.PHASE08_SOURCE_CONTENT_SHA256 -cne $ExpectedSourceSha -or $state.variables.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $state.variables.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr'){throw 'PHASE10_PROXY_DEPLOYMENT_IDENTITY'};$state=$null
 $headers=@{Origin=$context.origin};$session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
 $stage='LOGIN';$response=Invoke-Phase08SourceRequest 'POST' '/backend-api/auth/login' @{email=$operator.email;password=$operator.password} $context $session $headers
 Assert-Phase08LoginResponse $response $session $operator $context.origin;$loggedIn=$true;$loginVerified=$true;$response=$null
 $cookie=(@($session.Cookies.GetCookies([Uri]$context.origin)|ForEach-Object {$_.Name+'='+$_.Value}) -join '; ')
 $payload=@{origin=$context.origin;projectRef=$context.projectRef;schema='phase08_meta_ads';cookie=$cookie}|ConvertTo-Json -Compress;$cookie=$null
 $stage='READ_PROXY'
 $payload|& node "$PSScriptRoot/phase10-ui-readproxy.mjs" 2>$null|ForEach-Object {
  $event=$_|ConvertFrom-Json -AsHashtable
  if($event.kind -ceq 'PHASE10_UI_READ_PROXY_READY'){$event|ConvertTo-Json -Compress|Write-Output}
  elseif($event.kind -ceq 'PHASE10_UI_READ_PROXY_CLOSED'){$script:proxyEvidence=$event;$script:proxyClosed=$true}
  else {throw 'PHASE10_PROXY_CHILD_EVENT'}
 }
 if($LASTEXITCODE -ne 0 -or -not $proxyClosed){throw 'PHASE10_PROXY_CHILD_FAILED'};$payload=$null;$status='PASS'
} catch {Write-Output (@{kind='PHASE10_UI_READ_PROXY_FAILED';stage=$stage;rawErrorSuppressed=$true}|ConvertTo-Json -Compress)}
finally {
 if($loggedIn){
  try {
   $csrf=@($session.Cookies.GetCookies([Uri]$context.origin)|Where-Object {$_.Name -ceq '__Host-phase08-meta_csrf'});if($csrf.Count -ne 1){throw 'csrf'};$headers['X-CSRF-Token']=$csrf[0].Value
   $response=Invoke-WebRequest -Uri ($context.origin+'/backend-api/auth/logout') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body '{}' -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
   $lastHttpAt=[DateTimeOffset]::UtcNow.ToString('o');if([int]$response.StatusCode -ne 204){throw 'logout'};$loggedIn=$false
  }catch{$status='FAIL'}
 }
 $result=@{kind='PHASE10_UI_READ_PROXY';status=$status;classification='LOCAL_UI_ACTUAL_REMOTE_GET_SERVER_SIDE_TEST_SESSION';deploymentId=$ExpectedDeploymentId;sourceSha=$ExpectedSourceSha;observedAt=[DateTimeOffset]::UtcNow.ToString('o');lastAppHttpAt=$lastHttpAt;proxyClosed=$proxyClosed;proxy=$proxyEvidence;sessionMayRemain=$loggedIn;actualOriginBrowserLogin=$false;authSessionWritesExpected=$loginVerified;businessWrites=0}
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($result|ConvertTo-Json -Depth 8));$stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 if($headers){$headers.Clear()};$headers=$null;$payload=$null;$context=$null;$operator=$null;$session=$null;$response=$null;$csrf=$null
}
Write-Output (@{kind=$result.kind;status=$status;sessionMayRemain=$loggedIn;lastAppHttpAt=$lastHttpAt;evidence=$destination}|ConvertTo-Json -Compress)
if($status -cne 'PASS'){exit 1}
