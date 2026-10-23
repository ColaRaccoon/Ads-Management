param([Parameter(Mandatory)][switch]$ReadyVerified,[Parameter(Mandatory)][switch]$ActivationVerified)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/cafe24-oauth-bridge.ps1"
$context=$null;$operator=$null;$headers=$null;$session=$null;$body=$null;$response=$null
try {
  if(-not $ReadyVerified -or -not $ActivationVerified){throw 'ready-proof'}
  $discard=Assert-Phase08CafeOAuthDestination -Fresh
  $context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator;Assert-Phase08SourceContext $context $operator
  $headers=@{Origin=$context.origin};$session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $body=@{email=$operator.email;password=$operator.password}
  $response=Invoke-Phase08SourceRequest 'POST' '/backend-api/auth/login' $body $context $session $headers
  Assert-Phase08LoginResponse $response $session $operator $context.origin;$body=$null;$response=$null
  $csrf=@($session.Cookies.GetCookies([Uri]$context.origin)|Where-Object {$_.Name -ceq '__Host-phase08-meta_csrf'})
  if($csrf.Count -ne 1){throw 'csrf'};$headers['X-CSRF-Token']=$csrf[0].Value
  $response=Invoke-Phase08SourceRequest 'GET' '/backend-api/source-connections?limit=200&page=1' $null $context $session $headers
  $list=$response.Content|ConvertFrom-Json
  if($null -ne $list.nextPage){throw 'list-truncated'}
  $rows=@($list.items|Where-Object {$_.id -ceq '0c35defe-45fc-4a54-bc79-704df7bca5b1'})
  if($rows.Count -ne 1){throw 'fresh-connection'};Assert-Phase08Connection $rows[0] 'CAFE24' -Pending
  $started=[DateTimeOffset]::UtcNow
  $response=Invoke-Phase08SourceRequest 'POST' '/backend-api/cafe24/connections/0c35defe-45fc-4a54-bc79-704df7bca5b1/authorize' @{} $context $session $headers
  $payload=$response.Content|ConvertFrom-Json
  if(($payload.expiresInSeconds -isnot [int] -and $payload.expiresInSeconds -isnot [long]) -or $payload.expiresInSeconds -ne 300){throw 'authorize-expiry'}
  Write-Phase08CafeOAuthUrl $payload.authorizeUrl $started|ConvertTo-Json
} catch {
  $diagnostic=Get-Phase08SourceFailureDiagnostic $_.Exception
  @{state='PHASE08_CAFE24_AUTHORIZE_PREPARATION_FAILED';code=$diagnostic.code;httpStatus=$diagnostic.httpStatus;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1
} finally {if($headers){$headers.Clear()};$context=$null;$operator=$null;$headers=$null;$session=$null;$body=$null;$response=$null;$list=$null;$rows=$null;$csrf=$null;$payload=$null}
