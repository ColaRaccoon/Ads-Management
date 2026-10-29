param([switch]$Execute,[string]$SqlOutputPath)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'cloud/daily-data-sync/protected-context.ps1')
$root=Split-Path $PSScriptRoot -Parent
$metadata=Get-Content (Join-Path $root 'docs/product-performance/research/11-management-metadata.json') -Raw | ConvertFrom-Json -AsHashtable
$applied=@($metadata.rows.metadata.migrations | Where-Object { $_.finished_at -and -not $_.rolled_back_at })
$approved=@('20261027071504_unified_performance_foundation','20261028080000_unified_report_publication')
$plans=@();$parts=[Collections.Generic.List[string]]::new()
$parts.Add("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='45s';
CREATE TEMP TABLE stage11_memberships_before ON COMMIT DROP AS SELECT * FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='meta_ads_app') AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres');
DO `$`$ BEGIN IF current_user<>'postgres' OR (SELECT count(*) FROM stage11_memberships_before)<>1 OR NOT EXISTS(SELECT 1 FROM stage11_memberships_before b JOIN pg_roles g ON g.oid=b.grantor WHERE g.rolname='supabase_admin' AND b.admin_option AND NOT b.inherit_option AND NOT b.set_option) THEN RAISE EXCEPTION 'STAGE11_OWNER_AUTHORITY_CHANGED'; END IF; END `$`$;
GRANT meta_ads_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
SET LOCAL ROLE meta_ads_app; SET LOCAL search_path TO meta_ads,extensions; SELECT pg_advisory_xact_lock(21409,11);")
$parts.Add("DO `$`$ BEGIN IF current_database()<>'postgres' OR EXISTS(SELECT 1 FROM meta_ads._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL) OR to_regclass('meta_ads.unified_products') IS NOT NULL THEN RAISE EXCEPTION 'STAGE11_MIGRATION_PRECONDITION'; END IF; END `$`$;")
$reviewedHistory=@($applied|Sort-Object migration_name|ForEach-Object {@{name=$_.migration_name;checksum=$_.checksum}})|ConvertTo-Json -Depth 4 -Compress
$reviewedHistory=$reviewedHistory.Replace("'","''")
$parts.Add("DO `$`$ BEGIN IF (SELECT coalesce(jsonb_agg(jsonb_build_object('name',migration_name,'checksum',checksum) ORDER BY migration_name),'[]'::jsonb) FROM meta_ads._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) IS DISTINCT FROM '$reviewedHistory'::jsonb THEN RAISE EXCEPTION 'STAGE11_MIGRATION_HISTORY_CHANGED'; END IF; END `$`$;")
foreach($dir in (Get-ChildItem (Join-Path $root 'apps/api/prisma/migrations') -Directory | Sort-Object Name)) {
  $file=Join-Path $dir.FullName 'migration.sql';if(-not (Test-Path $file)){continue}
  $text=[IO.File]::ReadAllText($file)
  $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($file))).ToLowerInvariant()
  $existing=@($applied|Where-Object {$_.migration_name -ceq $dir.Name})
  if($existing.Count -eq 1) {
    $lf=$text.Replace("`r`n","`n");$crlf=$lf.Replace("`n","`r`n")
    $variants=@($hash,([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($lf)))).ToLowerInvariant(),([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($crlf)))).ToLowerInvariant())
    if($existing[0].checksum -notin $variants){throw ('UNEXPECTED_MIGRATION_CHECKSUM_'+$dir.Name)}
    continue
  }
  if($existing.Count -gt 1 -or $dir.Name -notin $approved){throw ('UNREVIEWED_MIGRATION_'+$dir.Name)}
  $plans+=@{name=$dir.Name;sha256=$hash;bytes=([IO.FileInfo]$file).Length}
  $parts.Add($text)
  # Foundation deliberately revokes even its owner's ordinary privileges. The
  # owner needs TRIGGER only while installing publication's four immutable guards.
  if($dir.Name -ceq '20261027071504_unified_performance_foundation'){$parts.Add('GRANT TRIGGER ON meta_ads.unified_aggregation_runs,meta_ads.unified_daily_facts,meta_ads.unified_source_coverage,meta_ads.unified_product_match_results TO meta_ads_app;')}
  if($dir.Name -ceq '20261028080000_unified_report_publication'){$parts.Add('REVOKE TRIGGER ON meta_ads.unified_aggregation_runs,meta_ads.unified_daily_facts,meta_ads.unified_source_coverage,meta_ads.unified_product_match_results FROM meta_ads_app;')}
  $parts.Add("INSERT INTO meta_ads._prisma_migrations(id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES (gen_random_uuid()::text,'$hash',clock_timestamp(),'$($dir.Name)',clock_timestamp(),1);")
}
if($plans.Count -ne 2){throw 'EXPECTED_TWO_NEW_MIGRATIONS'}
$parts.Add("RESET ROLE; REVOKE meta_ads_app FROM postgres GRANTED BY postgres;
DO `$`$ BEGIN IF (SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) FROM pg_auth_members a WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='meta_ads_app') AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres')) IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(b) ORDER BY oid) FROM stage11_memberships_before b) THEN RAISE EXCEPTION 'STAGE11_OWNER_AUTHORITY_NOT_RESTORED'; END IF; END `$`$;
COMMIT; SELECT migration_name,checksum,finished_at FROM meta_ads._prisma_migrations WHERE migration_name IN ('20261027071504_unified_performance_foundation','20261028080000_unified_report_publication') ORDER BY migration_name;")
if($SqlOutputPath){[IO.File]::WriteAllText($SqlOutputPath,($parts -join "`n"),[Text.UTF8Encoding]::new($false))}
$plan=@{stage=11;projectRef='iygjmosbelbosfxidqxv';migrations=$plans;sourceDml=0;appFlag='OFF';existingChecksumNormalization='LF/CRLF accepted; no history edits';backupEvidence='11-backup-readonly-result.json';execute=[bool]$Execute}
$plan|ConvertTo-Json -Depth 10|Set-Content (Join-Path $root 'docs/product-performance/research/11-migration-plan.json')
if(-not $Execute){$plan|ConvertTo-Json -Depth 10;return}
$token=$null;$headers=$null;$reply=$null
try {
  $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
  $start=[DateTime]::UtcNow
  $reply=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/iygjmosbelbosfxidqxv/database/query' -Method Post -Headers $headers -Body (@{query=($parts -join "`n")}|ConvertTo-Json -Compress) -ContentType 'application/json' -MaximumRedirection 0 -TimeoutSec 60 -SkipHttpErrorCheck
  $receipt=@{stage=11;projectRef='iygjmosbelbosfxidqxv';observedAt=[DateTime]::UtcNow.ToString('o');durationMs=([DateTime]::UtcNow-$start).TotalMilliseconds;httpStatus=[int]$reply.StatusCode;sourceWrites=0;migrations=$plans}
  if([int]$reply.StatusCode -notin @(200,201)){$receipt.status='FAILED';$receipt.safeError=$reply.Content;$receipt|ConvertTo-Json -Depth 10|Set-Content (Join-Path $root 'docs/product-performance/research/11-migration-apply-result.json');throw 'STAGE11_MIGRATION_APPLY_FAILED_RESPONSE_SUPPRESSED'}
  $rows=@($reply.Content|ConvertFrom-Json -Depth 10)
  if($rows.Count -ne 2){throw 'STAGE11_MIGRATION_RESPONSE_REQUIRES_READBACK'}
  foreach($row in $rows){$expected=@($plans|Where-Object {$_.name -ceq $row.migration_name});if(-not $row.finished_at -or $expected.Count -ne 1 -or $row.checksum -cne $expected[0].sha256){throw 'STAGE11_MIGRATION_RESPONSE_REQUIRES_READBACK'}}
  $receipt.status='APPLIED';$receipt.result=$rows
  $receipt|ConvertTo-Json -Depth 15|Set-Content (Join-Path $root 'docs/product-performance/research/11-migration-apply-result.json')
  @{status='APPLIED';count=$plans.Count;sourceWrites=0}|ConvertTo-Json -Compress
} finally {if($headers){$headers.Clear()};$headers=$null;$token=$null;$reply=$null;$parts.Clear()}
