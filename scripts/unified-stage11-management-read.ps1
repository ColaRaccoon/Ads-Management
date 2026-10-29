param([Parameter(Mandatory)][string]$QueryPath,[Parameter(Mandatory)][string]$OutputPath)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'cloud/daily-data-sync/protected-context.ps1')
$token=$null;$headers=$null;$reply=$null
try {
  $sql=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $QueryPath))
  if ($sql -notmatch '^\s*(SELECT|WITH)\b') { throw 'READ_ONLY_QUERY_REQUIRED' }
  $token=Get-Phase08SupabaseCredential
  $headers=@{Authorization=('Bearer '+$token)}
  $reply=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/iygjmosbelbosfxidqxv/database/query/read-only' -Method Post -Headers $headers -Body (@{query=$sql}|ConvertTo-Json -Compress) -ContentType 'application/json' -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
  if ([int]$reply.StatusCode -ne 201 -and [int]$reply.StatusCode -ne 200) { throw ('MANAGEMENT_READ_HTTP_'+[int]$reply.StatusCode) }
  $rows=$reply.Content|ConvertFrom-Json -Depth 60
  @{stage=11;projectRef='iygjmosbelbosfxidqxv';observedAt=[DateTime]::UtcNow.ToString('o');operation='MANAGEMENT_READ_ONLY';remoteWrites=0;rows=$rows}|ConvertTo-Json -Depth 70 | Set-Content -LiteralPath $OutputPath
  @{status='PASS';httpStatus=[int]$reply.StatusCode;remoteWrites=0}|ConvertTo-Json -Compress
} finally { if($headers){$headers.Clear()};$token=$null;$headers=$null;$reply=$null;$rows=$null;$sql=$null }
