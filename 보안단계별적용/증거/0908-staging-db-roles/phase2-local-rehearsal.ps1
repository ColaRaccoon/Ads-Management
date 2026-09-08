[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$networkName = "r2a-phase2-local-$suffix"
$databaseContainer = "r2a-phase2-db-$suffix"
$fakeHost = $databaseContainer
$serverImage = 'postgres@sha256:45cd22f8d32e189d245403954882f88e7a8714301fda80dab6da90f1265b25a3'
$clientImage = 'postgres:17@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3'
$evidenceRoot = $PSScriptRoot
$activationPath = Join-Path $evidenceRoot 'phase2-provider-activation.sql'
$roleVerifyPath = Join-Path $evidenceRoot 'phase2-role-verify.sql'
$finalVerifyPath = Join-Path $evidenceRoot 'phase2-final-admin-verify.sql'
$forcedFailurePath = Join-Path $evidenceRoot 'phase2-local-forced-failure.sql'
$entrypointPath = Join-Path $evidenceRoot 'phase2-container-entrypoint.sh'
$summaryPath = Join-Path $evidenceRoot 'phase2-local-rehearsal-summary.json'
$adminSecret = 'R2ALocalAdminSyntheticOnly_7yM8Qp4Vx2'
$roleSecrets = @{
  meta_ads_stg_runtime = 'R2ALocalRuntimeSyntheticOnly_4Wq8Zn5Lp3'
  meta_ads_stg_migration = 'R2ALocalMigrationSyntheticOnly_9Fc2Jm7Kr6'
  meta_ads_stg_backup = 'R2ALocalBackupSyntheticOnly_6Hs3Px8Nt5'
}
$startedAt = [DateTimeOffset]::UtcNow
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "r2a-phase2-local-$suffix"
$localCaPath = Join-Path $tempRoot 'local-test-ca.crt'
$script:dockerStep = 0

function Invoke-DockerChecked {
  $script:dockerStep += 1
  $output = & docker @args 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "R2A_PHASE2_LOCAL_DOCKER_FAILED step=$script:dockerStep exit=$LASTEXITCODE output=$output"
  }
  return $output
}

function Write-Utf8NoBom {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Text)
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function New-LocalScramVerifier {
  param([Parameter(Mandatory)][string]$Plaintext)
  $passwordBytes = [Text.Encoding]::UTF8.GetBytes($Plaintext)
  $salt = [byte[]]::new(16)
  [Security.Cryptography.RandomNumberGenerator]::Fill($salt)
  $saltedPassword = $null
  $clientKey = $null
  $storedKey = $null
  $serverKey = $null
  try {
    $saltedPassword = [Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2(
      $passwordBytes, $salt, 4096, [Security.Cryptography.HashAlgorithmName]::SHA256, 32
    )
    $clientHmac = [Security.Cryptography.HMACSHA256]::new($saltedPassword)
    try { $clientKey = $clientHmac.ComputeHash([Text.Encoding]::ASCII.GetBytes('Client Key')) }
    finally { $clientHmac.Dispose() }
    $storedKey = [Security.Cryptography.SHA256]::HashData($clientKey)
    $serverHmac = [Security.Cryptography.HMACSHA256]::new($saltedPassword)
    try { $serverKey = $serverHmac.ComputeHash([Text.Encoding]::ASCII.GetBytes('Server Key')) }
    finally { $serverHmac.Dispose() }
    return 'SCRAM-SHA-256$4096:{0}${1}:{2}' -f @(
      [Convert]::ToBase64String($salt),
      [Convert]::ToBase64String($storedKey),
      [Convert]::ToBase64String($serverKey)
    )
  } finally {
    foreach ($bytes in @($passwordBytes, $salt, $saltedPassword, $clientKey, $storedKey, $serverKey)) {
      if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
  }
}

function Invoke-ClientPsql {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$PgPassPath,
    [Parameter(Mandatory)][string]$SqlPath,
    [Parameter(Mandatory)][string]$User,
    [string]$Database = 'postgres',
    [string[]]$ExtraArgs = @(),
    [string[]]$InputLines = @(),
    [switch]$ExpectFailure,
    [switch]$VerifyTls,
    [string]$ExpectedMarker = ''
  )

  $arguments = @(
    'run', '--rm', '--interactive', '--pull', 'never', '--name', $Name, '--network', $networkName,
    '--log-driver', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '64',
    '--memory', '256m', '--memory-swap', '256m',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,mode=1777',
    '--mount', "type=bind,source=$PgPassPath,target=/run/secrets/input.pgpass,readonly",
    '--mount', "type=bind,source=$entrypointPath,target=/run/entrypoint.sh,readonly",
    '--mount', "type=bind,source=$SqlPath,target=/run/task.sql,readonly",
    '--env', 'PGCONNECT_TIMEOUT=8', '--env', 'PGREQUIREAUTH=scram-sha-256'
  )
  if ($VerifyTls) {
    $arguments += @(
      '--mount', "type=bind,source=$localCaPath,target=/run/ca.crt,readonly",
      '--env', 'PGSSLMODE=verify-full', '--env', 'PGSSLROOTCERT=/run/ca.crt',
      '--env', 'PGGSSENCMODE=disable'
    )
  } else {
    $arguments += @('--env', 'PGSSLMODE=disable')
  }
  $arguments += @(
    '--entrypoint', '/bin/sh', $clientImage, '/run/entrypoint.sh',
    '-X', '-n', '-q', '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate',
    '-h', $fakeHost, '-p', '5432', '-U', $User, '-d', $Database, '-f', '/run/task.sql'
  ) + $ExtraArgs
  $argumentText = $arguments -join "`n"
  foreach ($secret in @($adminSecret) + @($roleSecrets.Values)) {
    if ($argumentText.Contains($secret, [StringComparison]::Ordinal)) {
      throw 'R2A_PHASE2_LOCAL_SECRET_PRESENT_IN_ARGV'
    }
  }
  $inputText = ''
  if ($InputLines.Count -ne 0) {
    $inputText = ($InputLines -join "`n") + "`n"
  }
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = $inputText | & docker @arguments 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedErrorActionPreference
  foreach ($secret in @($adminSecret) + @($roleSecrets.Values)) {
    if ($output.Contains($secret, [StringComparison]::Ordinal)) {
      throw 'R2A_PHASE2_LOCAL_SECRET_PRESENT_IN_OUTPUT'
    }
  }
  if ($output -match 'SCRAM-SHA-256\$') {
    throw 'R2A_PHASE2_LOCAL_VERIFIER_PRESENT_IN_OUTPUT'
  }
  if ($ExpectFailure) {
    if ($exitCode -eq 0 -or $output -notmatch 'P0001') {
      throw "R2A_PHASE2_LOCAL_EXPECTED_FAILURE_MISMATCH exit=$exitCode output=$output"
    }
  } elseif ($exitCode -ne 0) {
    throw "R2A_PHASE2_LOCAL_CLIENT_FAILED exit=$exitCode"
  }
  if (-not $ExpectFailure -and -not [string]::IsNullOrWhiteSpace($ExpectedMarker) -and
      $output -notmatch [Regex]::Escape($ExpectedMarker)) {
    throw 'R2A_PHASE2_LOCAL_EXPECTED_MARKER_MISSING'
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

if (-not $networkName.StartsWith('r2a-phase2-local-', [StringComparison]::Ordinal) -or
    -not $databaseContainer.StartsWith('r2a-phase2-db-', [StringComparison]::Ordinal) -or
    -not $tempRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'R2A_PHASE2_LOCAL_CLEANUP_SCOPE_INVALID'
}

[void][IO.Directory]::CreateDirectory($tempRoot)
try {
  Invoke-DockerChecked network create --driver bridge --internal $networkName | Out-Null
  Invoke-DockerChecked run -d --rm --pull never --name $databaseContainer `
    --network $networkName `
    --tmpfs '/var/lib/postgresql/data:rw,noexec,nosuid,size=512m' `
    -e POSTGRES_USER=supabase_admin -e "POSTGRES_PASSWORD=$adminSecret" `
    -e 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256' $serverImage | Out-Null

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    & docker exec $databaseContainer pg_isready -U supabase_admin -d postgres | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'R2A_PHASE2_LOCAL_POSTGRES_NOT_READY' }

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U supabase_admin -d postgres -c `
    "CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS PASSWORD '$adminSecret';" | Out-Null
  Invoke-DockerChecked cp "$evidenceRoot/." "${databaseContainer}:/r2a/" | Out-Null
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -f /r2a/00-admin-preflight.sql | Out-Null
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -f /r2a/10-admin-bootstrap.sql | Out-Null
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -f /r2a/20-app-bootstrap.sql | Out-Null

  Invoke-DockerChecked exec $databaseContainer openssl req -x509 -newkey rsa:2048 -sha256 -nodes `
    -days 1 -subj "/CN=$fakeHost" -addext "subjectAltName=DNS:$fakeHost" `
    -keyout /tmp/r2a-server.key -out /tmp/r2a-server.crt | Out-Null
  Invoke-DockerChecked exec $databaseContainer chown postgres:postgres `
    /tmp/r2a-server.key /tmp/r2a-server.crt | Out-Null
  Invoke-DockerChecked exec $databaseContainer chmod 0600 /tmp/r2a-server.key | Out-Null
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U supabase_admin -d postgres -c "ALTER SYSTEM SET ssl_cert_file = '/tmp/r2a-server.crt';" | Out-Null
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U supabase_admin -d postgres -c "ALTER SYSTEM SET ssl_key_file = '/tmp/r2a-server.key';" | Out-Null
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U supabase_admin -d postgres -c "ALTER SYSTEM SET ssl = 'on';" | Out-Null
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
    -U supabase_admin -d postgres -c "SELECT pg_reload_conf();" | Out-Null
  Invoke-DockerChecked cp "${databaseContainer}:/tmp/r2a-server.crt" $localCaPath | Out-Null

  $binding = (Invoke-DockerChecked exec $databaseContainer psql -At -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -c `
    "SELECT d.oid,(SELECT oid FROM pg_roles WHERE rolname='meta_ads_stg_runtime'),(SELECT oid FROM pg_roles WHERE rolname='meta_ads_stg_migration'),(SELECT oid FROM pg_roles WHERE rolname='meta_ads_stg_backup'),md5(COALESCE((SELECT datacl::text FROM pg_database WHERE datname='postgres'),'<NULL>')) FROM pg_database d WHERE d.datname='meta_ads_staging';").Trim().Split('|')
  if ($binding.Count -ne 5) { throw 'R2A_PHASE2_LOCAL_BINDING_QUERY_MISMATCH' }

  $adminPassPath = Join-Path $tempRoot 'admin.pgpass'
  Write-Utf8NoBom -Path $adminPassPath -Text "$fakeHost`:5432:postgres:postgres:$adminSecret`n"

  $roleVerifiers = @{
    meta_ads_stg_runtime = New-LocalScramVerifier -Plaintext $roleSecrets.meta_ads_stg_runtime
    meta_ads_stg_migration = New-LocalScramVerifier -Plaintext $roleSecrets.meta_ads_stg_migration
    meta_ads_stg_backup = New-LocalScramVerifier -Plaintext $roleSecrets.meta_ads_stg_backup
  }

  $forced = Invoke-ClientPsql -Name "r2a-phase2-fail-$suffix" -PgPassPath $adminPassPath `
    -SqlPath $forcedFailurePath -User postgres -InputLines @(
      $roleVerifiers.meta_ads_stg_runtime,
      $roleVerifiers.meta_ads_stg_migration
    ) -ExpectFailure -VerifyTls
  $rolledBack = (Invoke-DockerChecked exec $databaseContainer psql -At -v ON_ERROR_STOP=1 `
    -U supabase_admin -d postgres -c `
    "SELECT count(*)=3 AND bool_and(NOT rolcanlogin) AND bool_and(rolpassword IS NULL) FROM pg_authid WHERE rolname IN ('meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_stg_backup');").Trim()
  if ($rolledBack -ne 't') { throw 'R2A_PHASE2_LOCAL_FORCED_FAILURE_NOT_ROLLED_BACK' }

  $activation = Invoke-ClientPsql -Name "r2a-phase2-activate-$suffix" -PgPassPath $adminPassPath `
    -SqlPath $activationPath -User postgres -InputLines @(
      $roleVerifiers.meta_ads_stg_runtime,
      $roleVerifiers.meta_ads_stg_migration,
      $roleVerifiers.meta_ads_stg_backup
    ) -ExtraArgs @(
      '-v', "expected_database_oid=$($binding[0])",
      '-v', "expected_runtime_oid=$($binding[1])",
      '-v', "expected_migration_oid=$($binding[2])",
      '-v', "expected_backup_oid=$($binding[3])",
      '-v', "expected_base_acl_md5=$($binding[4])"
    ) -VerifyTls -ExpectedMarker 'G_DB_00_PHASE2_ACTIVATION_COMMITTED'
  $scramState = (Invoke-DockerChecked exec $databaseContainer psql -At -v ON_ERROR_STOP=1 `
    -U supabase_admin -d postgres -c `
    "SELECT count(*),count(*) FILTER (WHERE rolcanlogin),count(*) FILTER (WHERE rolpassword IS NOT NULL),count(*) FILTER (WHERE left(rolpassword,14)='SCRAM-SHA-256`$') FROM pg_authid WHERE rolname IN ('meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_stg_backup');").Trim()
  if ($scramState -ne '3|3|3|3') { throw "R2A_PHASE2_LOCAL_SCRAM_STATE_MISMATCH counts=$scramState" }

  $positiveLogins = 0
  $localRoleOids = @{
    meta_ads_stg_runtime = $binding[1]
    meta_ads_stg_migration = $binding[2]
    meta_ads_stg_backup = $binding[3]
  }
  foreach ($role in @('meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_stg_backup')) {
    $rolePassPath = Join-Path $tempRoot "$role.pgpass"
    Write-Utf8NoBom -Path $rolePassPath -Text "$fakeHost`:5432:meta_ads_staging:$role`:$($roleSecrets[$role])`n"
    $result = Invoke-ClientPsql -Name "r2a-phase2-role-$($role.Replace('meta_ads_stg_',''))-$suffix" `
      -PgPassPath $rolePassPath -SqlPath $roleVerifyPath -User $role -Database meta_ads_staging `
      -ExtraArgs @('-v', "expected_role=$role", '-v', "expected_role_oid=$($localRoleOids[$role])") `
      -VerifyTls -ExpectedMarker 'PHASE2_ROLE_VERIFY_PASS'
    $positiveLogins += 1
  }

  $final = Invoke-ClientPsql -Name "r2a-phase2-final-$suffix" -PgPassPath $adminPassPath `
    -SqlPath $finalVerifyPath -User postgres -ExtraArgs @(
      '-v', "expected_database_oid=$($binding[0])",
      '-v', "expected_runtime_oid=$($binding[1])",
      '-v', "expected_migration_oid=$($binding[2])",
      '-v', "expected_backup_oid=$($binding[3])",
      '-v', "expected_base_acl_md5=$($binding[4])"
    ) -VerifyTls -ExpectedMarker 'PHASE2_FINAL_ADMIN_VERIFY_PASS'

  $summary = [ordered]@{
    version = 'r2a-phase2-local-rehearsal/v1'
    status = 'PASS'
    startedAtUtc = $startedAt.ToString('o')
    endedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    postgresMajor = 17
    providerShapedNonSuperuserAdmin = 'PASS'
    exactSavedActivationScript = 'PASS'
    nonTtyVerifierPromptFeeder = 'PASS'
    newRolePlaintextInActivationSqlStdinArgvEnvironmentOrWire = 0
    roleLoginPlaintextPassfileAndClientMemory = 'EXPECTED_EPHEMERAL_PROTECTED'
    clientSideScramVerifierBooleanOnly = 'PASS_LOCAL_SYNTHETIC'
    forcedFailureTransactionRollback = 'PASS'
    positiveScramRequiredRoleLogins = $positiveLogins
    plaintextInActivationArgvOrOutput = 0
    verifierInActivationOutput = 0
    exactSavedRoleVerifyScript = 'PASS_LOCAL_TLS_VERIFY_FULL'
    exactSavedFinalAdminVerifyScript = 'PASS_LOCAL_TLS_VERIFY_FULL'
    localTlsVerifyFull = 'PASS_SELF_SIGNED_SYNTHETIC_CA'
    providerTlsVerifyFull = 'NOT_CLAIMED'
    providerPoolerRouting = 'NOT_CLAIMED'
    providerMutation = 0
    operationalReady = $false
    artifactHashes = [ordered]@{
      activationSql = (Get-FileHash -LiteralPath $activationPath -Algorithm SHA256).Hash.ToLowerInvariant()
      roleVerifySql = (Get-FileHash -LiteralPath $roleVerifyPath -Algorithm SHA256).Hash.ToLowerInvariant()
      finalVerifySql = (Get-FileHash -LiteralPath $finalVerifyPath -Algorithm SHA256).Hash.ToLowerInvariant()
      forcedFailureSql = (Get-FileHash -LiteralPath $forcedFailurePath -Algorithm SHA256).Hash.ToLowerInvariant()
      containerEntrypoint = (Get-FileHash -LiteralPath $entrypointPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  $summaryJson = ($summary | ConvertTo-Json -Depth 5).Replace("`r`n", "`n")
  Write-Utf8NoBom -Path $summaryPath -Text ($summaryJson + "`n")
  'R2A_PHASE2_LOCAL_REHEARSAL_PASS'
} finally {
  & docker rm -f $databaseContainer 2>$null | Out-Null
  & docker network rm $networkName 2>$null | Out-Null
  if (Test-Path -LiteralPath $tempRoot) {
    [IO.Directory]::Delete($tempRoot, $true)
  }
}
