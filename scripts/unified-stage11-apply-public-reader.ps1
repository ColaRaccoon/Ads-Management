param([switch]$Execute)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'cloud/daily-data-sync/protected-context.ps1')
$path=Join-Path $PSScriptRoot 'unified-stage11-reconcile-roles-public-fix.sql'
$sql=[IO.File]::ReadAllText($path)
$reviewed=[IO.File]::ReadAllText((Join-Path $env:LOCALAPPDATA 'UnifiedPerformanceStage11-migration-reviewed.sql'))
$prefix=$reviewed.Substring(0,$reviewed.IndexOf('SET LOCAL ROLE meta_ads_app;')).Replace('meta_ads_app','patima_app')
$suffix=$reviewed.Substring($reviewed.LastIndexOf('RESET ROLE;'));$suffix=$suffix.Substring(0,$suffix.IndexOf('COMMIT;')).Replace('meta_ads_app','patima_app')
$first=$sql.IndexOf('BEGIN;');$last=$sql.LastIndexOf('COMMIT;')
if($first -lt 0 -or $last -le $first){throw 'PUBLIC_READER_SQL_BOUNDARY_REJECTED'}
$sql=$sql.Substring(0,$first)+$prefix+$sql.Substring($first+6,$last-$first-6)+$suffix+'COMMIT;'
$hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
if(-not $Execute){@{status='READY';sqlSha256=$hash;sourceDml=0;sourceTables=17}|ConvertTo-Json -Compress;return}
$token=$null;$headers=$null;$reply=$null
try{
 $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
 $reply=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/iygjmosbelbosfxidqxv/database/query' -Method Post -Headers $headers -Body (@{query=$sql}|ConvertTo-Json -Compress) -ContentType application/json -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
 $receipt=@{stage=11;operation='PATIMA_OWNER_RESTRICTED_SOURCE_SELECT_GRANT';observedAt=[DateTime]::UtcNow.ToString('o');httpStatus=[int]$reply.StatusCode;sqlSha256=$hash;sourceWrites=0;sourceRlsChanged=$false;sourceTables=17}
 $receipt.status=if([int]$reply.StatusCode -in @(200,201)){'APPLIED'}else{'FAIL'}
 if($receipt.status -eq 'FAIL'){$receipt.safeError=$reply.Content}
 $receipt|ConvertTo-Json -Depth 8|Set-Content docs/product-performance/research/11-role-public-reader-result.json
 if($receipt.status -eq 'FAIL'){throw 'PUBLIC_READER_GRANT_FAILED'}
 Write-Output 'PUBLIC_READER_SELECT_GRANTED'
}finally{if($headers){$headers.Clear()};$token=$null;$headers=$null;$reply=$null;$sql=$null}
