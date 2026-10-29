param([switch]$Execute)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'cloud/daily-data-sync/protected-context.ps1')
$rolePath=Join-Path $PSScriptRoot 'unified-stage11-reconcile-roles.sql'
$proof=Get-Content docs/product-performance/research/11-data-role-fixture.json -Raw|ConvertFrom-Json
$hash=(Get-FileHash -LiteralPath $rolePath -Algorithm SHA256).Hash.ToLowerInvariant()
if($proof.status -cne 'PASS' -or -not $proof.membershipRestoredExactly -or $hash -cne $proof.roleSqlSha256){throw 'EXACT_ROLE_SQL_REHEARSAL_REQUIRED'}
$reviewed=[IO.File]::ReadAllText((Join-Path $env:LOCALAPPDATA 'UnifiedPerformanceStage11-migration-reviewed.sql'))
$prefix=$reviewed.Substring(0,$reviewed.IndexOf('SET LOCAL ROLE meta_ads_app;'))
$suffix=$reviewed.Substring($reviewed.LastIndexOf('RESET ROLE;'))
$suffix=$suffix.Substring(0,$suffix.IndexOf('COMMIT;'))
$roleSql=[IO.File]::ReadAllText($rolePath)
$first=$roleSql.IndexOf('BEGIN;');$last=$roleSql.LastIndexOf('COMMIT;')
if($first -lt 0 -or $last -le $first){throw 'ROLE_SQL_BOUNDARY_REJECTED'}
$sql=$roleSql.Substring(0,$first)+$prefix+$roleSql.Substring($first+6,$last-$first-6)+$suffix+"COMMIT; SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname IN ('meta_ads_unified_report','meta_ads_unified_worker') ORDER BY rolname;"
if(-not $Execute){@{status='READY';roleSqlSha256=$hash;sourceDml=0;newRoles=2}|ConvertTo-Json -Compress;return}
$token=$null;$headers=$null;$reply=$null
try {
 $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
 $reply=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/iygjmosbelbosfxidqxv/database/query' -Method Post -Headers $headers -Body (@{query=$sql}|ConvertTo-Json -Compress) -ContentType application/json -MaximumRedirection 0 -TimeoutSec 60 -SkipHttpErrorCheck
 $receipt=@{stage=11;observedAt=[DateTime]::UtcNow.ToString('o');operation='EXACT_RESTRICTED_ROLE_GRANTS';httpStatus=[int]$reply.StatusCode;roleSqlSha256=$hash;sourceWrites=0;loginEnabled=$false}
 if([int]$reply.StatusCode -notin @(200,201)){$receipt.status='FAIL';$receipt.safeError=$reply.Content;$receipt|ConvertTo-Json -Depth 12|Set-Content docs/product-performance/research/11-role-grants-result.json;throw 'ROLE_GRANT_APPLY_FAILED'}
 $receipt.status='APPLIED';$receipt.result=$reply.Content|ConvertFrom-Json -Depth 10
 $receipt|ConvertTo-Json -Depth 12|Set-Content docs/product-performance/research/11-role-grants-result.json
 @{status='APPLIED';roles=2;sourceWrites=0;loginEnabled=$false}|ConvertTo-Json -Compress
}finally{if($headers){$headers.Clear()};$token=$null;$headers=$null;$reply=$null;$sql=$null}
