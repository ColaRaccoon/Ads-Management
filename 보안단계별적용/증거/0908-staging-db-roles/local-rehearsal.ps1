[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Invoke-DockerChecked {
  & docker @args
  if ($LASTEXITCODE -ne 0) {
    throw "R2A_LOCAL_DOCKER_COMMAND_FAILED exit=$LASTEXITCODE"
  }
}

$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$networkName = "r2a-pg17-f8a94fc-$suffix"
$databaseContainer = "r2a-pg17-f8a94fc-db-$suffix"
$postgresImage = 'postgres@sha256:45cd22f8d32e189d245403954882f88e7a8714301fda80dab6da90f1265b25a3'
$migrationImage = 'meta-ads-maintenance-migration@sha256:f8d53394a68c7257eb4fc5c6f4d226d6fb96cbd410664992f454cadc649c34fd'
$backupImage = 'meta-ads-maintenance-backup@sha256:b6054c05dc2b314dc4047e1ec1b0cbc05baece1475e51e3575f75b7a84c4dd8f'
$fakeHost = 'db.aaaaaaaaaaaaaaaaaaaa.supabase.co'
$evidenceRoot = $PSScriptRoot
$releasePath = Join-Path $evidenceRoot 'migration-release.json'
$imageHashCheckPath = Join-Path $evidenceRoot 'image-hash-check.cjs'

if (-not $networkName.StartsWith('r2a-pg17-f8a94fc-', [StringComparison]::Ordinal) -or
    -not $databaseContainer.StartsWith('r2a-pg17-f8a94fc-db-', [StringComparison]::Ordinal)) {
  throw 'R2A_LOCAL_CLEANUP_SCOPE_INVALID'
}

try {
  Invoke-DockerChecked network create --driver bridge --internal $networkName | Out-Null
  Invoke-DockerChecked run -d --rm --pull never --name $databaseContainer `
    --network $networkName --network-alias $fakeHost `
    --tmpfs '/var/lib/postgresql/data:rw,noexec,nosuid,size=512m' `
    -e POSTGRES_USER=supabase_admin -e POSTGRES_HOST_AUTH_METHOD=trust $postgresImage | Out-Null

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    & docker exec $databaseContainer pg_isready -U supabase_admin -d postgres | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'R2A_LOCAL_POSTGRES_NOT_READY' }

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U supabase_admin -d postgres -c `
    'CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS;'
  Invoke-DockerChecked cp "$evidenceRoot/." "${databaseContainer}:/r2a/"

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -f /r2a/00-admin-preflight.sql
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -f /r2a/10-admin-bootstrap.sql
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -f /r2a/20-app-bootstrap.sql

  # Synthetic LOGIN has no password because this isolated server uses trust and publishes no host port.
  # It tests role capability only; provider SCRAM credential activation remains NOT RUN.
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c `
    'ALTER ROLE meta_ads_stg_runtime LOGIN; ALTER ROLE meta_ads_stg_migration LOGIN; ALTER ROLE meta_ads_stg_backup LOGIN;'

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_migration -d meta_ads_staging -c `
    'CREATE TYPE public.r2a_default_acl_probe AS ENUM (''x''); CREATE FUNCTION public.r2a_default_acl_probe_fn() RETURNS integer LANGUAGE sql AS ''SELECT 1''; DO $probe$ BEGIN IF has_type_privilege(''meta_ads_stg_runtime'', ''public.r2a_default_acl_probe'', ''USAGE'') OR has_function_privilege(''meta_ads_stg_runtime'', ''public.r2a_default_acl_probe_fn()'', ''EXECUTE'') THEN RAISE EXCEPTION ''R2A_DEFAULT_ACL_PUBLIC_LEAK''; END IF; END $probe$; DROP FUNCTION public.r2a_default_acl_probe_fn(); DROP TYPE public.r2a_default_acl_probe;'
  Write-Output 'R2A_DEFAULT_ACL_PROBE_PASS'

  Invoke-DockerChecked run --rm --pull never --network none --read-only --cap-drop ALL `
    --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --memory-swap 512m `
    --mount "type=bind,src=$releasePath,dst=/run/release.json,readonly" `
    --mount "type=bind,src=$imageHashCheckPath,dst=/run/image-hash-check.cjs,readonly" `
    --entrypoint /usr/local/bin/node $migrationImage /run/image-hash-check.cjs

  Invoke-DockerChecked run --rm --pull never --network $networkName --read-only `
    --tmpfs '/tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000,mode=1777' `
    --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 256 `
    --memory 1g --memory-swap 1g `
    -e "DATABASE_URL=postgresql://meta_ads_stg_migration@${fakeHost}:5432/meta_ads_staging?schema=public&sslmode=disable" `
    --entrypoint /usr/local/bin/node $migrationImage `
    /srv/maintenance/node_modules/prisma/build/index.js migrate deploy `
    --schema /srv/maintenance/prisma/schema.prisma

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_migration -d meta_ads_staging -c `
    'CREATE VIEW public.r2a_unexpected_view AS SELECT 1 AS id; CREATE MATERIALIZED VIEW public.r2a_unexpected_materialized_view AS SELECT 1 AS id; CREATE SEQUENCE public.r2a_unexpected_sequence;'
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $contaminationOutput = & docker exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -v VERBOSITY=verbose -U meta_ads_stg_migration -d meta_ads_staging `
    -f /r2a/30-post-migration-exact-grants.sql 2>&1 | Out-String
  $contaminationExitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedErrorActionPreference
  if ($contaminationExitCode -eq 0 -or $contaminationOutput -notmatch 'P0001' -or
      $contaminationOutput -notmatch 'R2A_POST_GRANT_NON_TABLE_RELATION_PRESENT') {
    throw 'R2A_NON_TABLE_CONTAMINATION_GUARD_FAILED'
  }
  Write-Output 'EXPECTED_DENY non_table_catalog_contamination'
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_migration -d meta_ads_staging -c `
    'DROP VIEW public.r2a_unexpected_view; DROP MATERIALIZED VIEW public.r2a_unexpected_materialized_view; DROP SEQUENCE public.r2a_unexpected_sequence;'

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_migration -d meta_ads_staging -f /r2a/30-post-migration-exact-grants.sql

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_migration -d meta_ads_staging -c `
    'GRANT CONNECT ON DATABASE meta_ads_staging TO PUBLIC; GRANT USAGE ON SCHEMA public TO PUBLIC; GRANT SELECT ON TABLE public.products TO PUBLIC; GRANT EXECUTE ON FUNCTION public.security_audit_events_append_only() TO PUBLIC; GRANT USAGE ON TYPE public.app_role TO PUBLIC;'
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $publicAclOutput = & docker exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -v VERBOSITY=verbose -U meta_ads_stg_migration -d meta_ads_staging `
    -f /r2a/40-verify.sql 2>&1 | Out-String
  $publicAclExitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedErrorActionPreference
  if ($publicAclExitCode -eq 0 -or $publicAclOutput -notmatch 'P0001' -or
      $publicAclOutput -notmatch 'R2A_VERIFY_PUBLIC_ACL_PRESENT') {
    throw 'R2A_PUBLIC_ACL_DRIFT_GUARD_FAILED'
  }
  Write-Output 'EXPECTED_DENY public_acl_drift'
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_migration -d meta_ads_staging -c `
    'REVOKE CONNECT ON DATABASE meta_ads_staging FROM PUBLIC; REVOKE USAGE ON SCHEMA public FROM PUBLIC; REVOKE SELECT ON TABLE public.products FROM PUBLIC; REVOKE EXECUTE ON FUNCTION public.security_audit_events_append_only() FROM PUBLIC; REVOKE USAGE ON TYPE public.app_role FROM PUBLIC;'

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_migration -d meta_ads_staging -c `
    'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO meta_ads_stg_runtime;'
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $defaultAclOutput = & docker exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -v VERBOSITY=verbose -U meta_ads_stg_migration -d meta_ads_staging `
    -f /r2a/40-verify.sql 2>&1 | Out-String
  $defaultAclExitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedErrorActionPreference
  if ($defaultAclExitCode -eq 0 -or $defaultAclOutput -notmatch 'P0001' -or
      $defaultAclOutput -notmatch 'R2A_VERIFY_DEFAULT_ACL_PRINCIPAL_PRESENT') {
    throw 'R2A_DEFAULT_ACL_DRIFT_GUARD_FAILED'
  }
  Write-Output 'EXPECTED_DENY default_acl_drift'
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_migration -d meta_ads_staging -c `
    'ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM meta_ads_stg_runtime;'

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_migration -d meta_ads_staging -c `
    'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;'
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $missingDefaultRevokeOutput = & docker exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -v VERBOSITY=verbose -U meta_ads_stg_migration -d meta_ads_staging `
    -f /r2a/40-verify.sql 2>&1 | Out-String
  $missingDefaultRevokeExitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedErrorActionPreference
  if ($missingDefaultRevokeExitCode -eq 0 -or $missingDefaultRevokeOutput -notmatch 'P0001' -or
      $missingDefaultRevokeOutput -notmatch 'R2A_VERIFY_DEFAULT_ACL_REQUIRED_REVOKE_MISSING') {
    throw 'R2A_MISSING_DEFAULT_REVOKE_GUARD_FAILED'
  }
  Write-Output 'EXPECTED_DENY missing_default_function_revoke'
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_migration -d meta_ads_staging -c `
    'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;'

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_migration -d meta_ads_staging -f /r2a/40-verify.sql

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_runtime -d meta_ads_staging -c 'SELECT 1 FROM public.products LIMIT 0;'
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U meta_ads_stg_backup -d meta_ads_staging `
    -c 'SELECT 1 FROM public.products LIMIT 0; SELECT count(*) FROM public._prisma_migrations;'

  $expectedDenials = @(
    @('runtime_temp', 'meta_ads_stg_runtime', 'CREATE TEMP TABLE denied_temp(id integer);'),
    @('runtime_ddl', 'meta_ads_stg_runtime', 'CREATE TABLE public.denied_ddl(id integer);'),
    @('runtime_truncate', 'meta_ads_stg_runtime', 'TRUNCATE public.products;'),
    @('runtime_history', 'meta_ads_stg_runtime', 'SELECT * FROM public._prisma_migrations LIMIT 0;'),
    @('runtime_historical', 'meta_ads_stg_runtime', 'SELECT * FROM public.coupang_cost_rules_backup_20260723 LIMIT 0;'),
    @('runtime_function', 'meta_ads_stg_runtime', 'SELECT public.security_audit_events_append_only();'),
    @('backup_insert', 'meta_ads_stg_backup', 'INSERT INTO public.app_settings DEFAULT VALUES;'),
    @('backup_temp', 'meta_ads_stg_backup', 'CREATE TEMP TABLE denied_temp(id integer);'),
    @('backup_ddl', 'meta_ads_stg_backup', 'CREATE TABLE public.denied_ddl(id integer);')
  )
  foreach ($denial in $expectedDenials) {
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $denialOutput = & docker exec $databaseContainer psql -v ON_ERROR_STOP=1 `
      -v VERBOSITY=verbose -U $denial[1] -d meta_ads_staging -c $denial[2] 2>&1 | Out-String
    $denialExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedErrorActionPreference
    if ($denialExitCode -eq 0 -or $denialOutput -notmatch '42501') {
      throw "R2A_EXPECTED_PERMISSION_DENIAL_MISMATCH_$($denial[0])"
    }
    Write-Output "EXPECTED_DENY $($denial[0])"
  }

  Invoke-DockerChecked run --rm --pull never --network $networkName --read-only `
    --tmpfs '/tmp:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=1777' `
    --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 256 `
    --memory 1g --memory-swap 1g -e PGHOST=$fakeHost -e PGPORT=5432 `
    -e PGDATABASE=meta_ads_staging -e PGUSER=meta_ads_stg_backup -e PGSSLMODE=disable `
    --entrypoint /bin/sh $backupImage -c `
    'pg_dump --schema=public --format=custom --no-owner --no-acl --file=/tmp/r2a.dump && test -s /tmp/r2a.dump && pg_restore --list /tmp/r2a.dump >/tmp/r2a.list && test -s /tmp/r2a.list && pg_dump --version'

  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $containmentGuardOutput = & docker exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -v VERBOSITY=verbose -U postgres -d postgres -f /r2a/90-rollback-containment.sql 2>&1 | Out-String
  $containmentGuardExitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedErrorActionPreference
  if ($containmentGuardExitCode -eq 0 -or $containmentGuardOutput -notmatch '22012: division by zero') {
    throw 'R2A_CONTAINMENT_MISSING_OID_GUARD_MISMATCH'
  }
  Write-Output 'EXPECTED_DENY containment_missing_receipt_oids'

  $oidText = & docker exec $databaseContainer psql -At -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -c `
    "SELECT d.oid,(SELECT oid FROM pg_roles WHERE rolname='meta_ads_stg_runtime'),(SELECT oid FROM pg_roles WHERE rolname='meta_ads_stg_migration'),(SELECT oid FROM pg_roles WHERE rolname='meta_ads_stg_backup') FROM pg_database d WHERE d.datname='meta_ads_staging';"
  if ($LASTEXITCODE -ne 0) { throw 'R2A_LOCAL_OID_QUERY_FAILED' }
  $oids = $oidText.Trim().Split('|')

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -v expected_database_oid=$($oids[0]) `
    -v expected_runtime_oid=$($oids[1]) -v expected_migration_oid=$($oids[2]) `
    -v expected_backup_oid=$($oids[3]) -f /r2a/90-rollback-containment.sql
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $containmentOutput = & docker exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -v VERBOSITY=verbose -U meta_ads_stg_runtime -d meta_ads_staging -c 'SELECT 1;' 2>&1 | Out-String
  $containmentExitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedErrorActionPreference
  # Connection authentication fails before psql can apply VERBOSITY. Prove the intended phase by
  # combining the failed runtime connection with a healthy server and an admin-observed NOLOGIN flag.
  & docker exec $databaseContainer pg_isready -U supabase_admin -d postgres | Out-Null
  $serverReadyExitCode = $LASTEXITCODE
  $runtimeNoLogin = (& docker exec $databaseContainer psql -At -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -c `
    "SELECT NOT rolcanlogin FROM pg_roles WHERE rolname='meta_ads_stg_runtime';").Trim()
  $runtimeNoLoginQueryExitCode = $LASTEXITCODE
  if ($containmentExitCode -eq 0 -or $serverReadyExitCode -ne 0 -or
      $runtimeNoLoginQueryExitCode -ne 0 -or $runtimeNoLogin -ne 't') {
    throw 'R2A_CONTAINMENT_LOGIN_DENIAL_MISMATCH'
  }

  # This deletion affects only the disposable local target created above.
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -v destructive_confirm=DROP_META_ADS_STAGING_EXACT_V1 `
    -v backup_receipt_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa `
    -v expected_database_oid=$($oids[0]) -v expected_runtime_oid=$($oids[1]) `
    -v expected_migration_oid=$($oids[2]) -v expected_backup_oid=$($oids[3]) `
    -f /r2a/99-rollback-destructive.sql

  Write-Output 'R2A_LOCAL_REHEARSAL_COMPLETE'
} finally {
  & docker rm -f $databaseContainer 2>$null | Out-Null
  & docker network rm $networkName 2>$null | Out-Null
}
