Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-storage-rotation.ps1"
. "$PSScriptRoot/incident-common.ps1"
$stage='PROTECTED_BINDING';$material=$null;$baseline=$null
try{
 $material=Read-IncidentStorageMaterial;$baseline=Read-IncidentPrivate 'compromised-baseline'
 function Decode-IncidentStorageClaims([string]$Token){$part=$Token.Split('.')[1];$part=$part.Replace('-','+').Replace('_','/');$part+='='*((4-$part.Length%4)%4);return ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part))|ConvertFrom-Json -AsHashtable -DateKind String)}
 $old=Decode-IncidentStorageClaims $material.oldToken;$new=Decode-IncidentStorageClaims $material.newToken
 if($old.sub -cne $material.oldSubject -or $new.sub -cne $material.newSubject -or $old.sub -ceq $new.sub -or $old.role -cne 'phase08_storage_app' -or $new.role -cne 'phase08_storage_app' -or $material.oldToken -cne $baseline.variables.SUPABASE_STORAGE_ACCESS_TOKEN){throw 'CLAIM_BINDING'}
 $oldJson=($old|ConvertTo-Json -Compress).Replace("'","''");$newJson=($new|ConvertTo-Json -Compress).Replace("'","''")
 $stage='MANAGEMENT_READ_ONLY_RLS_SIMULATION'
 $sql=@"
BEGIN READ ONLY;
SET LOCAL statement_timeout='20s';SET LOCAL row_security=on;
SELECT set_config('request.jwt.claims','$oldJson',true);
SET LOCAL ROLE phase08_storage_app;
SELECT set_config('incident.old_visibility',(SELECT count(*)::text FROM storage.objects WHERE bucket_id='meta-ads-phase08-isolated' AND name='health/readiness-sentinel'),true);
RESET ROLE;
SELECT set_config('request.jwt.claims','$newJson',true);
SET LOCAL ROLE phase08_storage_app;
SELECT set_config('incident.new_visibility',(SELECT count(*)::text FROM storage.objects WHERE bucket_id='meta-ads-phase08-isolated' AND name='health/readiness-sentinel'),true);
RESET ROLE;
SELECT current_setting('transaction_read_only')='on' AS read_only,current_user='postgres' AS management_principal_bound,
current_setting('incident.old_visibility')::int AS old_claim_sentinel_rows,current_setting('incident.new_visibility')::int AS new_claim_sentinel_rows,
(SELECT public FROM storage.buckets WHERE id='meta-ads-phase08-isolated') AS bucket_public,
(SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname='phase08_storage_app') AS role_bypasses_rls,
(SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND 'phase08_storage_app'=ANY(roles)) AS role_policy_count;
COMMIT;
"@
 $rows=@(Invoke-Phase08Management -Action Query -Query $sql);if($rows.Count -ne 1){throw 'ROW_COUNT'}
 $r=$rows[0];$result=@{kind='INCIDENT_STORAGE_RLS_DIAGNOSTIC';observedAt=[DateTimeOffset]::UtcNow.ToString('o');readOnly=$r.read_only;managementPrincipalBound=$r.management_principal_bound;oldClaimSentinelRows=$r.old_claim_sentinel_rows;newClaimSentinelRows=$r.new_claim_sentinel_rows;bucketPublic=$r.bucket_public;roleBypassesRls=$r.role_bypasses_rls;rolePolicyCount=$r.role_policy_count;oldTokenMatchesCompromisedBaseline=$true;tokenSubjectsDistinctAndBound=$true;tokensHaveExactIsolatedRole=$true;storageHttpRequests=0;objectBodyReads=0;remoteMutations=0;rawValuesReturned=0;rawErrorSuppressed=$true}
 Write-IncidentStorageReceipt $result ('rls-diagnostic-'+[Guid]::NewGuid().ToString('N'));$result|ConvertTo-Json
}catch{@{kind='INCIDENT_STORAGE_RLS_DIAGNOSTIC';stage=$stage;status='FAIL';remoteMutations=0;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}finally{$material=$null;$baseline=$null;$old=$null;$new=$null;$oldJson=$null;$newJson=$null;$sql=$null;$rows=$null}
