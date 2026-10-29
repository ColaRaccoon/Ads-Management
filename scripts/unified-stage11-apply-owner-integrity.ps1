param([switch]$Execute,[string]$ExpectedSqlSha256,[ValidateSet('NewTableFk','FxIdentity')][string]$Fix='NewTableFk')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'cloud/daily-data-sync/protected-context.ps1')
$fixFile=if($Fix -eq 'FxIdentity'){'unified-stage11-reconcile-roles-fx-fix.sql'}else{'unified-stage11-reconcile-roles-fk-fix.sql'}
$path=Join-Path $PSScriptRoot $fixFile
$hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
if(-not $Execute){@{status='READY';fix=$Fix;sqlSha256=$hash;sourceWrites=0}|ConvertTo-Json -Compress;return}
if($ExpectedSqlSha256 -cne $hash){throw 'OWNER_INTEGRITY_REVIEW_HASH_REQUIRED'}
$body=[IO.File]::ReadAllText($path)
$first=$body.IndexOf('BEGIN;');$last=$body.LastIndexOf('COMMIT;')
if($first -lt 0 -or $last -le $first){throw 'OWNER_INTEGRITY_SQL_BOUNDARY_REJECTED'}
$sql=@'
BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
CREATE TEMP TABLE stage11_memberships_before ON COMMIT DROP AS SELECT * FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='meta_ads_app') AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres');
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR (SELECT count(*) FROM stage11_memberships_before)<>1 OR NOT EXISTS(SELECT 1 FROM stage11_memberships_before b JOIN pg_roles g ON g.oid=b.grantor WHERE g.rolname='supabase_admin' AND b.admin_option AND NOT b.inherit_option AND NOT b.set_option) THEN RAISE EXCEPTION 'STAGE11_OWNER_AUTHORITY_CHANGED'; END IF; END $$;
GRANT meta_ads_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
SET LOCAL ROLE meta_ads_app; SELECT pg_advisory_xact_lock(21409,11);
'@
$sql+=$body.Substring($first+6,$last-$first-6)
$sql+=@'
RESET ROLE; REVOKE meta_ads_app FROM postgres GRANTED BY postgres;
DO $$ BEGIN IF (SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) FROM pg_auth_members a WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='meta_ads_app') AND member=(SELECT oid FROM pg_roles WHERE rolname='postgres')) IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(b) ORDER BY oid) FROM stage11_memberships_before b) THEN RAISE EXCEPTION 'STAGE11_OWNER_AUTHORITY_NOT_RESTORED'; END IF; END $$;
COMMIT;
'@
$token=$null;$headers=$null;$reply=$null
try{
 $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
 $reply=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/iygjmosbelbosfxidqxv/database/query' -Method Post -Headers $headers -Body (@{query=$sql}|ConvertTo-Json -Compress) -ContentType application/json -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
 $operation=if($Fix -eq 'FxIdentity'){'WORKER_FX_IDENTITY_COLUMN_SELECT'}else{'NEW_TABLE_OWNER_FK_COLUMN_PRIVILEGES'}
 $receipt=@{stage=11;operation=$operation;observedAt=[DateTime]::UtcNow.ToString('o');httpStatus=[int]$reply.StatusCode;sqlSha256=$hash;sourceWrites=0;runtimePrivilegesChanged=($Fix -eq 'FxIdentity');legacyRolePrivilegesChanged=$false;credentialPrivilegesChanged=$false;ownerPoliciesAdded=0}
 $receipt.status=if([int]$reply.StatusCode -in @(200,201)){'APPLIED'}else{'FAIL'}
 $receipt.membershipRestoredByTransactionGuard=($receipt.status -eq 'APPLIED')
 $output=if($Fix -eq 'FxIdentity'){'docs/product-performance/research/11-role-fx-identity-result.json'}else{'docs/product-performance/research/11-role-owner-integrity-result.json'}
 $receipt|ConvertTo-Json -Depth 8|Set-Content $output
 if($receipt.status -eq 'FAIL'){throw 'OWNER_INTEGRITY_APPLY_FAILED_CHECK_READBACK'}
 Write-Output 'STAGE11_RESTRICTED_OWNER_FIX_APPLIED'
}finally{if($headers){$headers.Clear()};$token=$null;$headers=$null;$reply=$null;$sql=$null}
