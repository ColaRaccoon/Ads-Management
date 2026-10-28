param([Parameter(Mandatory)][string]$ManifestPath,[Parameter(Mandatory)][string]$OutputPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/../../../scripts/cloud/daily-data-sync/protected-context.ps1"
$queries=Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if(Test-Path -LiteralPath $OutputPath){throw 'OUTPUT_EXISTS'}
$results=[Collections.Generic.List[object]]::new()
$headers=$null
try {
  $headers=@{Authorization=('Bearer '+(Get-Phase08SupabaseCredential))}
  foreach($q in $queries){
    # Only reviewed SELECT statements; PostgreSQL independently enforces read-only.
    if($q.sql -notmatch '^SELECT\s' -or $q.sql -match ';|--|/\*|\b(pg_sleep|dblink|set_config|nextval)\b'){throw 'SELECT_REQUIRED'}
    $sql="BEGIN READ ONLY; SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='1s'; $($q.sql); ROLLBACK;"
    $watch=[Diagnostics.Stopwatch]::StartNew()
    try {
      $response=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/iygjmosbelbosfxidqxv/database/query' -Method Post -Headers $headers -ContentType 'application/json' -Body (@{query=$sql}|ConvertTo-Json -Compress) -MaximumRedirection 0 -TimeoutSec 15 -SkipHttpErrorCheck
      $ok=[int]$response.StatusCode -in @(200,201)
      $record=[ordered]@{name=$q.name;observedAt=[DateTimeOffset]::UtcNow.ToString('o');sqlSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($sql))).ToLowerInvariant();elapsedMs=$watch.ElapsedMilliseconds;httpStatus=[int]$response.StatusCode;status=if($ok){'SUCCESS'}else{'NOT_MEASURED'};rows=if($ok){$response.Content|ConvertFrom-Json -DateKind String -Depth 30}else{$null};reason=if($ok){$null}elseif($response.Content -match '57014|statement timeout'){'STATEMENT_TIMEOUT_8S'}else{'QUERY_REJECTED'}}
    } catch {
      $record=[ordered]@{name=$q.name;observedAt=[DateTimeOffset]::UtcNow.ToString('o');elapsedMs=$watch.ElapsedMilliseconds;status='NOT_MEASURED';reason='REQUEST_FAILED_RAW_ERROR_SUPPRESSED'}
    }
    $results.Add($record)
    [IO.File]::WriteAllText($OutputPath,([ordered]@{projectRef='iygjmosbelbosfxidqxv';connectionMode='MANAGEMENT_READ_ONLY_NOT_RUNTIME_PROOF';rowsChanged=0;queries=$results}|ConvertTo-Json -Depth 40),[Text.UTF8Encoding]::new($false))
    [ordered]@{name=$record.name;status=$record.status;elapsedMs=$record.elapsedMs}|ConvertTo-Json -Compress
  }
} finally {if($headers){$headers.Clear()};$response=$null;$sql=$null}
