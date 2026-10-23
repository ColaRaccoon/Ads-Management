param([Parameter(Mandatory)][ValidateSet('Roles','Storage','Variables')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/protected-context.ps1"
$phase08Context=$null;$phase08Headers=$null;$phase08Sql=$null;$phase08Body=$null;$phase08Response=$null
try {
  $phase08Context=Read-Phase08ProtectedJson
  $phase08Env=$phase08Context.env
  if($phase08Context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $phase08Context.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or
    $phase08Context.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app' -or
    $phase08Env.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $phase08Env.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or
    $phase08Env.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or $phase08Env.SUPABASE_STORAGE_BUCKET -cne 'meta-ads-phase08-isolated' -or
    $phase08Env.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $phase08Env.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false' -or
    $phase08Context.runtimePassword -cnotmatch '^[a-f0-9]{64}$' -or $phase08Context.ids.storageSubject -cnotmatch '^[a-f0-9-]{36}$'){throw 'identity'}
  $phase08Subject=$phase08Context.ids.storageSubject
  if($Mode -eq 'Roles'){
    # Only the newly created runtime role and a fresh Storage role are provisioned.
    # Existing application roles, schema objects and Storage policies are untouched.
    $phase08Sql=@"
BEGIN;
DO `$`$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR
   (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads')<>68 OR
   (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)<>68 OR
   NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='phase08_runtime' AND NOT rolcanlogin AND NOT rolbypassrls
     AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication) OR
   EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='phase08_storage_app') OR
   EXISTS(SELECT 1 FROM storage.buckets WHERE id='meta-ads-phase08-isolated')
 THEN RAISE EXCEPTION 'PHASE08_FRESH_RUNTIME_REQUIRED'; END IF;
END `$`$;
ALTER ROLE phase08_runtime LOGIN PASSWORD '$($phase08Context.runtimePassword)';
ALTER ROLE phase08_runtime SET search_path=phase08_meta_ads,pg_catalog;
CREATE ROLE phase08_storage_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT phase08_storage_app TO authenticator;
GRANT USAGE ON SCHEMA storage,auth TO phase08_storage_app;
GRANT EXECUTE ON FUNCTION auth.jwt() TO phase08_storage_app;
GRANT SELECT,INSERT,DELETE ON storage.objects TO phase08_storage_app;
GRANT SELECT ON storage.buckets TO phase08_storage_app;
CREATE POLICY phase08_storage_bucket_boundary ON storage.buckets AS RESTRICTIVE FOR ALL TO phase08_storage_app
 USING(id='meta-ads-phase08-isolated' AND auth.jwt()->>'sub'='$phase08Subject');
CREATE POLICY phase08_storage_bucket_read ON storage.buckets FOR SELECT TO phase08_storage_app
 USING(id='meta-ads-phase08-isolated' AND auth.jwt()->>'sub'='$phase08Subject');
CREATE POLICY phase08_storage_bucket_no_insert ON storage.buckets AS RESTRICTIVE FOR INSERT TO phase08_storage_app WITH CHECK(false);
CREATE POLICY phase08_storage_bucket_no_update ON storage.buckets AS RESTRICTIVE FOR UPDATE TO phase08_storage_app USING(false) WITH CHECK(false);
CREATE POLICY phase08_storage_bucket_no_delete ON storage.buckets AS RESTRICTIVE FOR DELETE TO phase08_storage_app USING(false);
CREATE POLICY phase08_storage_object_boundary ON storage.objects AS RESTRICTIVE FOR ALL TO phase08_storage_app
 USING(bucket_id='meta-ads-phase08-isolated' AND auth.jwt()->>'sub'='$phase08Subject')
 WITH CHECK(bucket_id='meta-ads-phase08-isolated' AND auth.jwt()->>'sub'='$phase08Subject');
CREATE POLICY phase08_storage_object_read ON storage.objects FOR SELECT TO phase08_storage_app
 USING(bucket_id='meta-ads-phase08-isolated' AND auth.jwt()->>'sub'='$phase08Subject' AND
 (name LIKE 'uploads/%' OR name LIKE 'reports/%' OR name LIKE 'trash/uploads/%' OR name LIKE 'trash/reports/%' OR name='health/readiness-sentinel'));
CREATE POLICY phase08_storage_object_insert ON storage.objects FOR INSERT TO phase08_storage_app
 WITH CHECK(bucket_id='meta-ads-phase08-isolated' AND auth.jwt()->>'sub'='$phase08Subject' AND
 (name LIKE 'uploads/%' OR name LIKE 'reports/%' OR name LIKE 'trash/uploads/%' OR name LIKE 'trash/reports/%'));
CREATE POLICY phase08_storage_object_delete ON storage.objects FOR DELETE TO phase08_storage_app
 USING(bucket_id='meta-ads-phase08-isolated' AND auth.jwt()->>'sub'='$phase08Subject' AND
 (name LIKE 'uploads/%' OR name LIKE 'reports/%' OR name LIKE 'trash/uploads/%' OR name LIKE 'trash/reports/%'));
-- Restrictive command policies retain path limits even alongside broad PUBLIC policies.
CREATE POLICY phase08_storage_object_read_boundary ON storage.objects AS RESTRICTIVE FOR SELECT TO phase08_storage_app
 USING(name LIKE 'uploads/%' OR name LIKE 'reports/%' OR name LIKE 'trash/uploads/%' OR name LIKE 'trash/reports/%' OR name='health/readiness-sentinel');
CREATE POLICY phase08_storage_object_insert_boundary ON storage.objects AS RESTRICTIVE FOR INSERT TO phase08_storage_app
 WITH CHECK(name LIKE 'uploads/%' OR name LIKE 'reports/%' OR name LIKE 'trash/uploads/%' OR name LIKE 'trash/reports/%');
CREATE POLICY phase08_storage_object_delete_boundary ON storage.objects AS RESTRICTIVE FOR DELETE TO phase08_storage_app
 USING(name LIKE 'uploads/%' OR name LIKE 'reports/%' OR name LIKE 'trash/uploads/%' OR name LIKE 'trash/reports/%');
CREATE POLICY phase08_storage_object_no_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO phase08_storage_app USING(false) WITH CHECK(false);
NOTIFY pgrst,'reload schema';
COMMIT;
"@
    $phase08Discard=Invoke-Phase08Management -Action Query -Query $phase08Sql;$phase08Discard=$null;$phase08Sql=$null
    $phase08Rows=Invoke-Phase08Management -Action ReadOnlyQuery -Query "SELECT rolname,rolcanlogin,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname IN ('phase08_runtime','phase08_storage_app');"
    [ordered]@{state='PHASE08_NEW_ROLES_PROVISIONED';rows=$phase08Rows;operatingChanges=0;providerRequests=0}|ConvertTo-Json -Depth 5
  } elseif($Mode -eq 'Storage'){
    $phase08Base='https://ehnfrrmbkvlsbpvqcvkr.supabase.co/storage/v1'
    # Modern sb_secret keys identify the component through apikey, not a JWT Bearer.
    $phase08Headers=@{apikey=$phase08Env.SUPABASE_SECRET_KEY}
    $phase08Body=@{id='meta-ads-phase08-isolated';name='meta-ads-phase08-isolated';public=$false;file_size_limit=52428800}|ConvertTo-Json -Compress
    $phase08Response=Invoke-WebRequest -Uri "$phase08Base/bucket" -Method Post -Headers $phase08Headers -ContentType 'application/json' -Body $phase08Body -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
    if([int]$phase08Response.StatusCode -notin @(200,201)){throw 'bucket-create-outcome-inspect-no-retry'}
    $phase08Response=Invoke-WebRequest -Uri "$phase08Base/object/meta-ads-phase08-isolated/health/readiness-sentinel" -Method Post -Headers $phase08Headers -ContentType 'application/octet-stream' -Body ([Text.Encoding]::ASCII.GetBytes('phase08-readiness-v1')) -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
    if([int]$phase08Response.StatusCode -notin @(200,201)){throw 'sentinel-outcome-inspect-no-retry'}
    $phase08Response=Invoke-WebRequest -Uri "$phase08Base/object/meta-ads-security-step7-dev/health/readiness-sentinel" -Method Head -Headers $phase08Headers -MaximumRedirection 0 -TimeoutSec 15 -SkipHttpErrorCheck
    $phase08OldAdminStatus=[int]$phase08Response.StatusCode
    if($phase08OldAdminStatus -ne 200){throw 'old-sentinel-existence-unverified'}
    $phase08Headers.apikey=$phase08Env.SUPABASE_PUBLISHABLE_KEY
    $phase08Headers.Authorization='Bearer '+$phase08Env.SUPABASE_STORAGE_ACCESS_TOKEN
    $phase08Response=Invoke-WebRequest -Uri "$phase08Base/object/meta-ads-phase08-isolated/health/readiness-sentinel" -Method Head -Headers $phase08Headers -MaximumRedirection 0 -TimeoutSec 15 -SkipHttpErrorCheck
    $phase08OwnStatus=[int]$phase08Response.StatusCode
    $phase08Response=Invoke-WebRequest -Uri "$phase08Base/object/meta-ads-security-step7-dev/health/readiness-sentinel" -Method Head -Headers $phase08Headers -MaximumRedirection 0 -TimeoutSec 15 -SkipHttpErrorCheck
    $phase08OldStatus=[int]$phase08Response.StatusCode
    if($phase08OwnStatus -ne 200 -or $phase08OldStatus -notin @(400,403,404)){throw 'storage-boundary'}
    [ordered]@{state='PHASE08_PRIVATE_STORAGE_VERIFIED';bucket='meta-ads-phase08-isolated';ownSentinelStatus=$phase08OwnStatus;oldSentinelAdminStatus=$phase08OldAdminStatus;oldBucketDeniedStatus=$phase08OldStatus;storageExpiresAt=$phase08Context.storageExpiresAt;operatingChanges=0;providerRequests=0}|ConvertTo-Json
  } else {
    $phase08Cfg=Get-Content -Raw -LiteralPath (Join-Path $env:USERPROFILE '.railway/config.json')|ConvertFrom-Json
    $phase08Headers=@{Authorization=('Bearer '+$phase08Cfg.user.accessToken)}
    $phase08Vars=@{};foreach($property in $phase08Env.PSObject.Properties){$phase08Vars[$property.Name]=[string]$property.Value}
    # Upload the reviewed v3 image identity; the original DPAPI material remains intact.
    $phase08ManifestPath=Join-Path $env:LOCALAPPDATA 'MetaAdsPhase08Evaluation/full-app-build-20261013-v3/source-content-manifest.json'
    $phase08Manifest=Get-Content -Raw -LiteralPath $phase08ManifestPath|ConvertFrom-Json
    if($phase08Manifest.sourceContentSha256 -cne '4e58b5f0358dff3f4a82187ba8d9a99dbff69ca1ac66a0c8583e44cb93d779f3' -or
      $phase08Manifest.files.Count -ne 470 -or $phase08Manifest.secretsIncluded -ne $false){throw 'reviewed-image-required'}
    $phase08Vars['PHASE08_SOURCE_CONTENT_SHA256']=$phase08Manifest.sourceContentSha256
    foreach($phase08Prefix in @('PHASE08_META_CATALOG','PHASE08_META_REPORT_SCHEMA')){
      $phase08Compressed=$null
      $phase08Bytes=[Convert]::FromBase64String($phase08Vars[$phase08Prefix+'_JSON_B64'])
      $phase08CompressedStream=[IO.MemoryStream]::new()
      $phase08Gzip=[IO.Compression.GZipStream]::new($phase08CompressedStream,[IO.Compression.CompressionLevel]::Optimal,$true)
      try {
        $phase08Gzip.Write($phase08Bytes,0,$phase08Bytes.Length);$phase08Gzip.Dispose()
        $phase08Compressed=$phase08CompressedStream.ToArray()
        $phase08Vars[$phase08Prefix+'_GZIP_B64']=[Convert]::ToBase64String($phase08Compressed)
        $phase08Vars.Remove($phase08Prefix+'_JSON_B64')
      } finally {
        $phase08Gzip.Dispose();$phase08CompressedStream.Dispose()
        [Array]::Clear($phase08Bytes,0,$phase08Bytes.Length)
        if($phase08Compressed){[Array]::Clear($phase08Compressed,0,$phase08Compressed.Length)}
        $phase08Bytes=$null;$phase08Compressed=$null
      }
    }
    if(@($phase08Vars.Values|Where-Object {$_.Length -gt 45000}).Count -gt 0){throw 'variable-size-limit'}
    $phase08Vars['NODE_IMAGE']='node:22.18.0-bookworm-slim@sha256:0d130e2ee18e88e1561375276daced6bff032539200173f2daf48c2e33f38ff5'
    $phase08Body=@{query='mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}';variables=@{input=@{projectId='d72f4256-8632-437a-9dae-9b5d96736fc7';environmentId='d261a432-a6a4-4031-b8ea-c619ac263cc3';serviceId='4b30daa8-9333-46b7-ad89-cfd64ff5266c';variables=$phase08Vars;skipDeploys=$true}}}|ConvertTo-Json -Depth 12 -Compress
    $phase08Response=Invoke-RestMethod -Uri 'https://backboard.railway.com/graphql/v2' -Method Post -Headers $phase08Headers -ContentType 'application/json' -Body $phase08Body -MaximumRedirection 0 -TimeoutSec 30
    if($phase08Response.data.variableCollectionUpsert -ne $true){throw 'variables-outcome-inspect-no-retry'}
    [ordered]@{state='PHASE08_NEW_SERVICE_VARIABLES_PREPARED';serviceId=$phase08Context.serviceId;variableCount=$phase08Vars.Count;skipDeploys=$true;featureEnabled=$false;scheduleEnabled=$false;operatingChanges=0;providerRequests=0}|ConvertTo-Json
  }
} catch {[ordered]@{state='PHASE08_PROVISION_FAILED';mode=$Mode;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally {$phase08Context=$null;$phase08Env=$null;$phase08Sql=$null;$phase08Body=$null;$phase08Response=$null;$phase08Vars=$null;$phase08Cfg=$null;$phase08Manifest=$null;if($phase08Headers){$phase08Headers.Clear()};$phase08Headers=$null}
