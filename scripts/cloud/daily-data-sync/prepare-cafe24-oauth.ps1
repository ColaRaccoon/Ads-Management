param([Parameter(Mandatory)][ValidateSet('Prepare','Status')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/protected-context.ps1"
. "$PSScriptRoot/cafe24-oauth-configuration.ps1"
$phase08Context=$null;$phase08Config=$null;$phase08Headers=$null
function Invoke-Phase08CafeRailway($query,$variables) {
  $body=$null;$reply=$null
  try {
    $body=@{query=$query;variables=$variables}|ConvertTo-Json -Depth 12 -Compress
    $reply=Invoke-RestMethod -Uri 'https://backboard.railway.com/graphql/v2' -Method Post -Headers $phase08Headers -ContentType 'application/json' -Body $body -MaximumRedirection 0 -TimeoutSec 30
    $errors=$reply.PSObject.Properties['errors']
    if($errors -and @($errors.Value|Where-Object {$null -ne $_}).Count -gt 0){throw 'graph-query-failed-inspect-no-retry'}
    return $reply.data
  } catch {throw 'PHASE08_CAFE24_GRAPH_REQUEST_FAILED'}
  finally {$body=$null;$reply=$null}
}
try {
  $phase08Context=Read-Phase08ProtectedJson
  $phase08Config=Get-Content -Raw -LiteralPath (Join-Path $env:USERPROFILE '.railway/config.json')|ConvertFrom-Json
  $phase08Headers=@{Authorization=('Bearer '+$phase08Config.user.accessToken)}
  Invoke-Phase08CafeOAuthConfiguration $Mode $phase08Context {param($query,$variables) Invoke-Phase08CafeRailway $query $variables}|ConvertTo-Json -Depth 5
} catch {@{state='PHASE08_CAFE24_OAUTH_CONFIG_FAILED';mode=$Mode;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally {if($phase08Headers){$phase08Headers.Clear()};$phase08Headers=$null;$phase08Context=$null;$phase08Config=$null}
