param([ValidateSet('Inspect','FinalFacts','Checks','Grants')][string]$Mode='Inspect',[switch]$Execute,[string]$ExpectedSqlSha256)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'cloud/daily-data-sync/protected-context.ps1')
$migration=if($Mode -eq 'FinalFacts'){'20261103085000_native_final_results'}elseif($Mode -eq 'Checks'){'20261103090000_unified_reconciliation_checks'}else{$null}
$path=if($migration){Join-Path $PSScriptRoot "../apps/api/prisma/migrations/$migration/migration.sql"}elseif($Mode -eq 'Grants'){Join-Path $PSScriptRoot 'unified-native-finals-source-grants.sql'}else{$null}
$hash=if($path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}else{$null}
if($path -and -not $Execute){@{status='READY';mode=$Mode;sqlSha256=$hash;sourceWrites=0}|ConvertTo-Json -Compress;return}
if($path -and $ExpectedSqlSha256 -cne $hash){throw 'NATIVE_FINAL_EXACT_SQL_HASH_REQUIRED'}
$sql=@'
BEGIN READ ONLY;
SELECT jsonb_build_object('constraint',(SELECT jsonb_build_object('hash',md5(pg_get_constraintdef(oid)),'definition',pg_get_constraintdef(oid))
 FROM pg_constraint WHERE conrelid='meta_ads.unified_daily_facts'::regclass AND conname='unified_fact_valid'),
 'migrations',(SELECT jsonb_agg(jsonb_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL)) FROM meta_ads._prisma_migrations
 WHERE migration_name IN ('20261102071000_native_storefront_results','20261103085000_native_final_results','20261103090000_unified_reconciliation_checks')),
 'tables',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'owner',r.rolname)) FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
 WHERE c.oid IN ('meta_ads.unified_daily_facts'::regclass,'meta_ads.coupang_promotion_prices'::regclass))) AS inspection;
COMMIT;
'@
if($path){
 $body=[IO.File]::ReadAllText($path)
 $sql=@'
BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
CREATE TEMP TABLE native_final_memberships_before ON COMMIT DROP AS SELECT * FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='meta_ads_app') AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres');
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR (SELECT count(*) FROM native_final_memberships_before)<>1 OR NOT EXISTS(SELECT 1 FROM native_final_memberships_before b JOIN pg_roles g ON g.oid=b.grantor WHERE g.rolname='supabase_admin' AND b.admin_option AND NOT b.inherit_option AND NOT b.set_option) THEN RAISE EXCEPTION 'NATIVE_FINAL_OWNER_AUTHORITY_CHANGED'; END IF; END $$;
GRANT meta_ads_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
SET LOCAL ROLE meta_ads_app; SELECT pg_advisory_xact_lock(21409,11);
'@
 if($migration){
  $sql+="DO `$`$ BEGIN IF EXISTS(SELECT 1 FROM meta_ads._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL) OR EXISTS(SELECT 1 FROM meta_ads._prisma_migrations WHERE migration_name='$migration') THEN RAISE EXCEPTION 'NATIVE_FINAL_MIGRATION_PRECONDITION'; END IF; END `$`$;"
  if($Mode -eq 'FinalFacts'){$sql+=@'
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='meta_ads.unified_daily_facts'::regclass AND conname='unified_fact_valid'
 AND md5(pg_get_constraintdef(oid))='4d0c45fa30873a6e916075595572117b') THEN RAISE EXCEPTION 'NATIVE_FINAL_CONSTRAINT_PRECONDITION'; END IF; END $$;
'@}
  $sql+=$body
  $sql+="INSERT INTO meta_ads._prisma_migrations(id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES(gen_random_uuid()::text,'$hash',clock_timestamp(),'$migration',clock_timestamp(),1);"
 }else{$first=$body.IndexOf('BEGIN;');$last=$body.LastIndexOf('COMMIT;');if($first -lt 0 -or $last -le $first){throw 'NATIVE_FINAL_GRANTS_BOUNDARY'};$sql+=$body.Substring($first+6,$last-$first-6)}
 $sql+=@'
RESET ROLE; REVOKE meta_ads_app FROM postgres GRANTED BY postgres;
DO $$ BEGIN IF (SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) FROM pg_auth_members a WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='meta_ads_app') AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres')) IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(b) ORDER BY oid) FROM native_final_memberships_before b) THEN RAISE EXCEPTION 'NATIVE_FINAL_OWNER_AUTHORITY_NOT_RESTORED'; END IF; END $$;
COMMIT;
'@
}
$token=$null;$headers=$null;$reply=$null
try{
 $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
 $reply=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/iygjmosbelbosfxidqxv/database/query' -Method Post -Headers $headers -Body (@{query=$sql}|ConvertTo-Json -Compress) -ContentType application/json -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
 $receipt=@{operation="NATIVE_FINAL_$Mode";observedAt=[DateTime]::UtcNow.ToString('o');httpStatus=[int]$reply.StatusCode;sqlSha256=$hash;sourceWrites=0;status=$(if([int]$reply.StatusCode -in @(200,201)){'PASS'}else{'FAIL'});membershipRestoredByTransactionGuard=($null -ne $path)}
 if($Mode -eq 'Inspect' -and $receipt.status -eq 'PASS'){$receipt.result=$reply.Content|ConvertFrom-Json -Depth 10}
 $receipt|ConvertTo-Json -Depth 12|Set-Content "reports/daily-products-export/native-final-$Mode.json"
 $receipt|ConvertTo-Json -Depth 12
 if($receipt.status -eq 'FAIL'){throw 'NATIVE_FINAL_APPLY_FAILED_INSPECT_BEFORE_RETRY'}
}finally{if($headers){$headers.Clear()};$token=$null;$headers=$null;$reply=$null;$sql=$null}
