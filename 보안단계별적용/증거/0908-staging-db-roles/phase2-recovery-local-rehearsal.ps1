[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$networkName = "r2a-recovery-local-$suffix"
$databaseContainer = "r2a-recovery-db-$suffix"
$fakeHost = $databaseContainer
$serverImage = 'postgres:17@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3'
$clientImage = 'postgres:17@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3'
$evidenceRoot = $PSScriptRoot
$activationPath = Join-Path $evidenceRoot 'phase2-provider-activation.sql'
$recoveryPath = Join-Path $evidenceRoot 'phase2-provider-credential-recovery.sql'
$roleVerifyPath = Join-Path $evidenceRoot 'phase2-role-verify.sql'
$finalVerifyPath = Join-Path $evidenceRoot 'phase2-final-admin-verify.sql'
$entrypointPath = Join-Path $evidenceRoot 'phase2-container-entrypoint.sh'
$runnerPath = Join-Path $evidenceRoot 'phase2-provider-credential-recovery.ps1'
$preparePath = Join-Path $evidenceRoot 'phase2-recovery-prepare-credentials.ps1'
$secretLibPath = Join-Path $evidenceRoot 'phase2-secret-lib.ps1'
$summaryPath = Join-Path $evidenceRoot 'phase2-recovery-local-rehearsal-summary.json'
$requiredRecoverySha256 = '2edb6432079fab1b89f3bd7fe492a161bc37c506d98a4862299616f827ed78c3'
$adminSecret = 'R2ARecoveryLocalAdminSyntheticOnly_7yM8Qp4Vx2'
$priorRoleSecrets = [ordered]@{
  meta_ads_stg_runtime = 'R2ARecoveryPriorRuntimeSynthetic_4Wq8Zn5Lp3'
  meta_ads_stg_migration = 'R2ARecoveryPriorMigrationSynthetic_9Fc2Jm7Kr6'
  meta_ads_stg_backup = 'R2ARecoveryPriorBackupSynthetic_6Hs3Px8Nt5'
}
$failedRoleSecrets = [ordered]@{
  meta_ads_stg_runtime = 'R2ARecoveryFailedRuntimeSynthetic_3Rw6Vm8Ka2'
  meta_ads_stg_migration = 'R2ARecoveryFailedMigrationSynthetic_8Jq4Tc7Ns5'
  meta_ads_stg_backup = 'R2ARecoveryFailedBackupSynthetic_5Ld9Xh2Bp7'
}
$recoveryRoleSecrets = [ordered]@{
  meta_ads_stg_runtime = 'R2ARecoveryNewRuntimeSynthetic_2Kp7Yv4Mc8'
  meta_ads_stg_migration = 'R2ARecoveryNewMigrationSynthetic_6Nt3Wq9Hs5'
  meta_ads_stg_backup = 'R2ARecoveryNewBackupSynthetic_9Bx5Jr2Lf7'
}
$script:sensitiveValues = [Collections.Generic.List[string]]::new()
foreach ($value in @($adminSecret) + @($priorRoleSecrets.Values) +
    @($failedRoleSecrets.Values) + @($recoveryRoleSecrets.Values)) {
  [void]$script:sensitiveValues.Add($value)
}
$startedAt = [DateTimeOffset]::UtcNow
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "r2a-recovery-local-$suffix"
$localCaPath = Join-Path $tempRoot 'local-test-ca.crt'
$forcedRecoveryPath = Join-Path $tempRoot 'phase2-recovery-forced-precommit.sql'
$script:dockerStep = 0

$tokens = $null
$parseErrors = $null
$runnerAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $runnerPath, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) { throw 'R2A_RECOVERY_RUNNER_PARSER_ERROR' }
$stateValidatorAst = @($runnerAst.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Assert-R2AExecutionStateShape'
}, $true))
if ($stateValidatorAst.Count -ne 1) { throw 'R2A_RECOVERY_STATE_VALIDATOR_AST_MISMATCH' }
Invoke-Expression $stateValidatorAst[0].Extent.Text

$stateBase = [ordered]@{
  version='r2a-phase2-recovery-execution-state/v1'; status='RECOVERY_INTENT_RECORDED'
  startedAtUtc=[DateTimeOffset]::UtcNow.ToString('o'); updatedAtUtc=[DateTimeOffset]::UtcNow.ToString('o')
  projectRef='ehnfrrmbkvlsbpvqcvkr'; host='aws-0-ap-northeast-2.pooler.supabase.com'; port=5432
  database='meta_ads_staging'; databaseOid=25404
  roleOids=[ordered]@{runtime=25397;migration=25399;backup=25401}
  phase1ReceiptSha256=('a'*64); classificationReceiptSha256=('b'*64); sourceExecutionStateSha256=('c'*64)
  candidateSetId='synthetic-local-fixture'; sourceStatus='COMMITTED_VERIFY_FAILED'
  sourceCommitAckObserved=$true; sourceVerifiedRoleCount=0; sourceFinalAdminVerify=$false
  recoveryAttemptCount=0; originalCredentialRecordsPreserved=$true; candidateCredentialRecordsPreserved=$true
  artifactHashes=[ordered]@{secretLib=('d'*64);activationSql=('e'*64);roleVerifySql=('f'*64);finalVerifySql=('1'*64);containerEntrypoint=('2'*64)}
  commitAckObserved=$false; verifiedRoleCount=0; finalAdminVerify=$false
  automaticRetryCount=0; negativeAuthTestCount=0; verifyOnlyAttemptCount=0
  secretValuesOrHashesStored=$false; operationalReady=$false
}
$stateFixtures = @(
  @('RECOVERY_INTENT_RECORDED',0,$false,0,$false),
  @('RECOVERY_LOCAL_FAILURE_NO_PROVIDER_ATTEMPT',0,$false,0,$false),
  @('RECOVERY_ATTEMPT_STARTED',1,$false,0,$false),
  @('RECOVERY_PRECOMMIT_SCRIPT_FAILED_ROLLBACK_EXPECTED',1,$false,0,$false),
  @('RECOVERY_COMMIT_OUTCOME_UNKNOWN',1,$false,0,$false),
  @('RECOVERY_COMMIT_ACK_OBSERVED',1,$true,0,$false),
  @('RECOVERY_COMMITTED_VERIFY_IN_PROGRESS',1,$true,1,$false),
  @('RECOVERY_COMMITTED_VERIFY_FAILED',1,$true,2,$false),
  @('RECOVERY_PROVIDER_VERIFIED_PENDING_LOCAL_CLEANUP',1,$true,3,$true),
  @('RECOVERY_PROVIDER_VERIFIED_LOCAL_CLEANUP_FAILED',1,$true,3,$true),
  @('RECOVERY_VERIFIED',1,$true,3,$true),
  @('RECOVERY_VERIFIED_LOCAL_FINALIZE_FAILED',1,$true,3,$true)
)
foreach ($fixture in $stateFixtures) {
  $record = [ordered]@{}
  foreach ($key in $stateBase.Keys) { $record[$key] = $stateBase[$key] }
  $record.status=$fixture[0]; $record.recoveryAttemptCount=$fixture[1]
  $record.commitAckObserved=$fixture[2]; $record.verifiedRoleCount=$fixture[3]; $record.finalAdminVerify=$fixture[4]
  Assert-R2AExecutionStateShape -Record $record
}
$secondAttemptRejected = $false
$invalidRecord = [ordered]@{}
foreach ($key in $stateBase.Keys) { $invalidRecord[$key] = $stateBase[$key] }
$invalidRecord.status='RECOVERY_ATTEMPT_STARTED'; $invalidRecord.recoveryAttemptCount=2
try { Assert-R2AExecutionStateShape -Record $invalidRecord } catch { $secondAttemptRejected = $true }
if (-not $secondAttemptRejected) { throw 'R2A_RECOVERY_SECOND_ATTEMPT_NOT_REJECTED' }
$runnerText = Get-Content -Raw -LiteralPath $runnerPath
$markerCallIndex = $runnerText.LastIndexOf('Write-R2ARecoveryActivationMarkerCreateNew',[StringComparison]::Ordinal)
$successInvariantIndex = $runnerText.LastIndexOf(
  'R2A_RECOVERY_SOURCE_STORE_CHANGED', $markerCallIndex, [StringComparison]::Ordinal
)
if ($markerCallIndex -lt 0 -or $successInvariantIndex -lt 0 -or
    $successInvariantIndex -gt $markerCallIndex) {
  throw 'R2A_RECOVERY_MARKER_ORDER_STATIC_MISMATCH'
}

function Assert-NoSensitiveOutput {
  param([AllowEmptyString()][string]$Text)
  foreach ($sensitive in $script:sensitiveValues) {
    if (-not [string]::IsNullOrEmpty($sensitive) -and
        $Text.Contains($sensitive, [StringComparison]::Ordinal)) {
      throw 'R2A_RECOVERY_LOCAL_SECRET_PRESENT_IN_OUTPUT'
    }
  }
  if ($Text -match 'SCRAM-SHA-256\$') {
    throw 'R2A_RECOVERY_LOCAL_VERIFIER_PRESENT_IN_OUTPUT'
  }
}

function Invoke-DockerChecked {
  $script:dockerStep += 1
  $output = & docker @args 2>&1 | Out-String
  Assert-NoSensitiveOutput -Text $output
  if ($LASTEXITCODE -ne 0) {
    throw "R2A_RECOVERY_LOCAL_DOCKER_FAILED step=$script:dockerStep exit=$LASTEXITCODE"
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

function New-VerifierSet {
  param([Parameter(Mandatory)][Collections.IDictionary]$Secrets)
  $set = [ordered]@{}
  foreach ($role in $Secrets.Keys) {
    $set[$role] = New-LocalScramVerifier -Plaintext $Secrets[$role]
    [void]$script:sensitiveValues.Add($set[$role])
  }
  return $set
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
    [string]$ExpectedMarker = ''
  )
  $arguments = @(
    'run', '--rm', '--interactive', '--pull', 'never', '--name', $Name,
    '--network', $networkName, '--log-driver', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '64',
    '--memory', '256m', '--memory-swap', '256m',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,mode=1777',
    '--mount', "type=bind,source=$PgPassPath,target=/run/secrets/input.pgpass,readonly",
    '--mount', "type=bind,source=$entrypointPath,target=/run/entrypoint.sh,readonly",
    '--mount', "type=bind,source=$SqlPath,target=/run/task.sql,readonly",
    '--mount', "type=bind,source=$localCaPath,target=/run/ca.crt,readonly",
    '--env', 'PGCONNECT_TIMEOUT=8', '--env', 'PGREQUIREAUTH=scram-sha-256',
    '--env', 'PGSSLMODE=verify-full', '--env', 'PGSSLROOTCERT=/run/ca.crt',
    '--env', 'PGGSSENCMODE=disable', '--entrypoint', '/bin/sh', $clientImage,
    '/run/entrypoint.sh', '-X', '-n', '-q', '-w', '-v', 'ON_ERROR_STOP=1',
    '-v', 'VERBOSITY=sqlstate', '-h', $fakeHost, '-p', '5432', '-U', $User,
    '-d', $Database, '-f', '/run/task.sql'
  ) + $ExtraArgs
  $argumentText = $arguments -join "`n"
  foreach ($sensitive in $script:sensitiveValues) {
    if ($argumentText.Contains($sensitive, [StringComparison]::Ordinal)) {
      throw 'R2A_RECOVERY_LOCAL_SECRET_PRESENT_IN_ARGV'
    }
  }
  $inputText = if ($InputLines.Count -eq 0) { '' } else { ($InputLines -join "`n") + "`n" }
  $savedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = $inputText | & docker @arguments 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedPreference
  Assert-NoSensitiveOutput -Text $output
  if ($ExpectFailure) {
    if ($exitCode -eq 0 -or $output -notmatch 'P0001') {
      throw "R2A_RECOVERY_LOCAL_EXPECTED_FAILURE_MISMATCH exit=$exitCode"
    }
  } elseif ($exitCode -ne 0) {
    throw "R2A_RECOVERY_LOCAL_CLIENT_FAILED exit=$exitCode"
  }
  if (-not $ExpectFailure -and -not [string]::IsNullOrWhiteSpace($ExpectedMarker) -and
      $output -notmatch [Regex]::Escape($ExpectedMarker)) {
    throw 'R2A_RECOVERY_LOCAL_EXPECTED_MARKER_MISSING'
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function Invoke-RolePositiveLogins {
  param(
    [Parameter(Mandatory)][Collections.IDictionary]$Secrets,
    [Parameter(Mandatory)][Collections.IDictionary]$RoleOids,
    [Parameter(Mandatory)][string]$NameStage
  )
  $count = 0
  foreach ($role in @('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')) {
    $passPath = Join-Path $tempRoot "$NameStage-$role.pgpass"
    Write-Utf8NoBom -Path $passPath -Text "$fakeHost`:5432:meta_ads_staging:$role`:$($Secrets[$role])`n"
    [void](Invoke-ClientPsql -Name "r2a-recovery-$NameStage-$($role.Replace('meta_ads_stg_', ''))-$suffix" `
      -PgPassPath $passPath -SqlPath $roleVerifyPath -User $role -Database 'meta_ads_staging' `
      -ExtraArgs @('-v', "expected_role=$role", '-v', "expected_role_oid=$($RoleOids[$role])") `
      -ExpectedMarker 'PHASE2_ROLE_VERIFY_PASS')
    $count += 1
  }
  return $count
}

function Get-InvariantSnapshot {
  $sql = @'
SELECT jsonb_build_object(
  'database', (SELECT jsonb_build_object('oid',oid,'owner',pg_get_userbyid(datdba),'allowconn',datallowconn,'acl',COALESCE(datacl::text,'<NULL>')) FROM pg_database WHERE datname='meta_ads_staging'),
  'base_acl', (SELECT COALESCE(datacl::text,'<NULL>') FROM pg_database WHERE datname='postgres'),
  'roles', (SELECT jsonb_agg(jsonb_build_object('name',rolname,'oid',oid,'login',rolcanlogin,'inherit',rolinherit,'super',rolsuper,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication,'bypassrls',rolbypassrls,'connlimit',rolconnlimit) ORDER BY rolname) FROM pg_roles WHERE rolname IN ('meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_stg_backup')),
  'memberships', (SELECT jsonb_agg(jsonb_build_object('granted',g.rolname,'member',u.rolname,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option,'grantor',x.rolname) ORDER BY g.rolname,u.rolname,x.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member JOIN pg_roles x ON x.oid=m.grantor WHERE g.rolname IN ('meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_stg_backup') OR u.rolname IN ('meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_stg_backup'))
)::text;
'@
  return (Invoke-DockerChecked exec $databaseContainer psql -At -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -c $sql).Trim()
}

function Test-SyntheticDpapiCandidateSet {
  param([Parameter(Mandatory)][Collections.IDictionary]$Secrets)
  $candidateRoot = Join-Path $tempRoot 'synthetic-dpapi-candidate'
  [void][IO.Directory]::CreateDirectory($candidateRoot)
  $entropy = [Text.Encoding]::UTF8.GetBytes('r2a-recovery-local-synthetic-v1')
  try {
    foreach ($role in $Secrets.Keys) {
      $plainBytes = [Text.Encoding]::UTF8.GetBytes($Secrets[$role])
      $protectedBytes = $null
      $roundTripBytes = $null
      try {
        $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
          $plainBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $record = [ordered]@{
          version = 'r2a-recovery-local-synthetic-dpapi/v1'
          role = $role
          state = 'candidate_stored'
          ciphertext = [Convert]::ToBase64String($protectedBytes)
        }
        $recordPath = Join-Path $candidateRoot "$role.dpapi.json"
        Write-Utf8NoBom -Path $recordPath -Text (($record | ConvertTo-Json -Compress) + "`n")
        $loaded = Get-Content -Raw -LiteralPath $recordPath | ConvertFrom-Json
        $roundTripBytes = [Security.Cryptography.ProtectedData]::Unprotect(
          [Convert]::FromBase64String($loaded.ciphertext), $entropy,
          [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $roundTrip = [Text.Encoding]::UTF8.GetString($roundTripBytes)
        if ($loaded.role -ne $role -or $loaded.state -ne 'candidate_stored' -or
            $roundTrip -cne $Secrets[$role]) {
          throw 'R2A_RECOVERY_LOCAL_SYNTHETIC_DPAPI_ROUNDTRIP_FAILED'
        }
        $roundTrip = $null
      } finally {
        foreach ($bytes in @($plainBytes, $protectedBytes, $roundTripBytes)) {
          if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        }
      }
    }
    if (@(Get-ChildItem -LiteralPath $candidateRoot -File).Count -ne 3) {
      throw 'R2A_RECOVERY_LOCAL_SYNTHETIC_DPAPI_RECORD_COUNT_MISMATCH'
    }
  } finally {
    [Array]::Clear($entropy, 0, $entropy.Length)
  }
}

function Invoke-RedirectedPrepareTest {
  $testScriptPath = Join-Path $tempRoot 'redirected-prepare-test.ps1'
  $redirectedAppData = Join-Path $tempRoot 'redirected-appdata'
  $testScript = @'
param([string]$RedirectedAppData,[string]$SecretLibPath,[string]$PreparePath)
$ErrorActionPreference='Stop'
$env:APPDATA=$RedirectedAppData
[void][IO.Directory]::CreateDirectory($env:APPDATA)
. $SecretLibPath
Set-R2AUserSystemOnlyAcl -Path $env:APPDATA -Directory $true
$root=Get-R2ASecretRoot
[void][IO.Directory]::CreateDirectory($root)
Set-R2AUserSystemOnlyAcl -Path $root -Directory $true
foreach($role in @('meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_stg_backup')){
  $plain=New-R2APlaintextSecret
  try { Write-R2ACredentialRecordCreateNew -Root $root -Role $role -Ciphertext (Protect-R2APlaintextSecret -Plaintext $plain) }
  finally { $plain=$null }
}
$state=[ordered]@{
  version='r2a-phase2-execution-state/v1';status='COMMITTED_VERIFY_FAILED'
  startedAtUtc=[DateTimeOffset]::UtcNow.ToString('o');updatedAtUtc=[DateTimeOffset]::UtcNow.ToString('o')
  projectRef='ehnfrrmbkvlsbpvqcvkr';host='aws-0-ap-northeast-2.pooler.supabase.com';port=5432
  database='meta_ads_staging';databaseOid=25404;roleOids=[ordered]@{runtime=25397;migration=25399;backup=25401}
  phase1ReceiptSha256='d596ccd6bc43d479705d43cdd720221cdc71dec3c242f52ace1d70cdaba04059'
  artifactHashes=[ordered]@{
    secretLib='48ddce9d009f8c2e4aa46f18060608ed818807ceba546ea401666a20950fec2c'
    activationSql='8b8527e25caff9fa9edab37420bd4808fbdf953fd75182a17e8e8c0c080671a7'
    roleVerifySql='846762928ddc6012202fe989336536fd07c34dd37cd126591e81fe3da8043efe'
    finalVerifySql='3c13be90502d9947cc13f7bf42eea1e796001a12cdb7ef1755b6b600ef26f184'
    containerEntrypoint='3116be65ed91b60e9e3db6f191440eedab020a671d1c438c965b32fe4d9e2c41'
  }
  commitAckObserved=$true;verifiedRoleCount=0;finalAdminVerify=$false;automaticRetryCount=0
  negativeAuthTestCount=0;verifyOnlyAttemptCount=0;secretValuesOrHashesStored=$false;operationalReady=$false
}
$statePath=Join-Path $root 'phase2-execution-state.json'
[IO.File]::WriteAllText($statePath,(($state|ConvertTo-Json -Depth 8)+"`n"),[Text.UTF8Encoding]::new($false))
Set-R2AUserSystemOnlyAcl -Path $statePath -Directory $false
function Snapshot([string]$Path){
  $rootAcl=Get-Acl -LiteralPath $Path
  $rows=@("ROOT|$($rootAcl.Owner)|$($rootAcl.AreAccessRulesProtected)|$($rootAcl.Sddl)")
  $rows+=@(Get-ChildItem -LiteralPath $Path -Force|Sort-Object Name|ForEach-Object{
    $acl=Get-Acl -LiteralPath $_.FullName
    "$($_.Name)|$($_.Length)|$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash)|$($acl.Owner)|$($acl.AreAccessRulesProtected)|$($acl.Sddl)"
  })
  $rows -join "`n"
}
$before=Snapshot $root
$first=(& $PreparePath -ApprovalToken G_DB_00_PHASE2_RECOVERY_PREPARE_APPROVED_EXACT_V1|Out-String|ConvertFrom-Json)
$afterFirst=Snapshot $root
$second=(& $PreparePath -ApprovalToken G_DB_00_PHASE2_RECOVERY_PREPARE_APPROVED_EXACT_V1|Out-String|ConvertFrom-Json)
$afterSecond=Snapshot $root
if($first.status -ne 'PHASE2_RECOVERY_CANDIDATES_PREPARED_NOT_ACTIVATED' -or
   $second.status -ne 'PHASE2_RECOVERY_CANDIDATES_ALREADY_PREPARED_NO_ROTATION' -or
   $before -cne $afterFirst -or $before -cne $afterSecond){throw 'REDIRECTED_PREPARE_CONTRACT_MISMATCH'}
'REDIRECTED_PREPARE_PASS'
'@
  Write-Utf8NoBom -Path $testScriptPath -Text $testScript
  $output = & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File $testScriptPath `
    -RedirectedAppData $redirectedAppData -SecretLibPath $secretLibPath -PreparePath $preparePath 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $output -notmatch 'REDIRECTED_PREPARE_PASS') {
    throw 'R2A_RECOVERY_REDIRECTED_PREPARE_TEST_FAILED'
  }
}

if ((Get-FileHash -LiteralPath $recoveryPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
    $requiredRecoverySha256) {
  throw 'R2A_RECOVERY_LOCAL_EXACT_SQL_HASH_MISMATCH'
}
if (-not $networkName.StartsWith('r2a-recovery-local-', [StringComparison]::Ordinal) -or
    -not $databaseContainer.StartsWith('r2a-recovery-db-', [StringComparison]::Ordinal) -or
    -not $tempRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'R2A_RECOVERY_LOCAL_CLEANUP_SCOPE_INVALID'
}

  [void][IO.Directory]::CreateDirectory($tempRoot)
  Invoke-RedirectedPrepareTest
$summary = $null
$runError = $null
$priorVerifiers = $null
$failedVerifiers = $null
$recoveryVerifiers = $null
try {
  Test-SyntheticDpapiCandidateSet -Secrets $recoveryRoleSecrets

  $recoverySql = Get-Content -Raw -LiteralPath $recoveryPath
  $forcedBlock = @'
DO $phase2_recovery_forced_failure$
BEGIN
  RAISE EXCEPTION 'R2A_RECOVERY_LOCAL_FORCED_PRECOMMIT';
END
$phase2_recovery_forced_failure$;

DO $phase2_recovery_postcondition$
'@
  $forcedSql = $recoverySql.Replace('DO $phase2_recovery_postcondition$', $forcedBlock)
  if ($forcedSql -ceq $recoverySql -or
      ([regex]::Matches($forcedSql, 'R2A_RECOVERY_LOCAL_FORCED_PRECOMMIT')).Count -ne 1) {
    throw 'R2A_RECOVERY_LOCAL_FORCED_SQL_BUILD_FAILED'
  }
  Write-Utf8NoBom -Path $forcedRecoveryPath -Text $forcedSql

  Invoke-DockerChecked network create --driver bridge --internal $networkName | Out-Null
  Invoke-DockerChecked run -d --rm --pull never --name $databaseContainer `
    --network $networkName --tmpfs '/var/lib/postgresql/data:rw,noexec,nosuid,size=512m' `
    -e POSTGRES_USER=supabase_admin -e "POSTGRES_PASSWORD=$adminSecret" `
    -e 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256' $serverImage | Out-Null

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    & docker exec $databaseContainer pg_isready -U supabase_admin -d postgres | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'R2A_RECOVERY_LOCAL_POSTGRES_NOT_READY' }

  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 -U supabase_admin `
    -d postgres -c "CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS PASSWORD '$adminSecret';" | Out-Null
  Invoke-DockerChecked cp "$evidenceRoot/." "${databaseContainer}:/r2a/" | Out-Null
  foreach ($bootstrap in @('00-admin-preflight.sql', '10-admin-bootstrap.sql', '20-app-bootstrap.sql')) {
    Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 `
      -U postgres -d postgres -f "/r2a/$bootstrap" | Out-Null
  }

  Invoke-DockerChecked exec $databaseContainer openssl req -x509 -newkey rsa:2048 -sha256 -nodes `
    -days 1 -subj "/CN=$fakeHost" -addext "subjectAltName=DNS:$fakeHost" `
    -keyout /tmp/r2a-server.key -out /tmp/r2a-server.crt | Out-Null
  Invoke-DockerChecked exec $databaseContainer chown postgres:postgres `
    /tmp/r2a-server.key /tmp/r2a-server.crt | Out-Null
  Invoke-DockerChecked exec $databaseContainer chmod 0600 /tmp/r2a-server.key | Out-Null
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 -U supabase_admin `
    -d postgres -c "ALTER SYSTEM SET ssl_cert_file = '/tmp/r2a-server.crt';" | Out-Null
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 -U supabase_admin `
    -d postgres -c "ALTER SYSTEM SET ssl_key_file = '/tmp/r2a-server.key';" | Out-Null
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 -U supabase_admin `
    -d postgres -c "ALTER SYSTEM SET ssl = 'on';" | Out-Null
  Invoke-DockerChecked exec $databaseContainer psql -v ON_ERROR_STOP=1 -U supabase_admin `
    -d postgres -c 'SELECT pg_reload_conf();' | Out-Null
  Invoke-DockerChecked cp "${databaseContainer}:/tmp/r2a-server.crt" $localCaPath | Out-Null

  $binding = (Invoke-DockerChecked exec $databaseContainer psql -At -v ON_ERROR_STOP=1 `
    -U postgres -d postgres -c `
    "SELECT d.oid,(SELECT oid FROM pg_roles WHERE rolname='meta_ads_stg_runtime'),(SELECT oid FROM pg_roles WHERE rolname='meta_ads_stg_migration'),(SELECT oid FROM pg_roles WHERE rolname='meta_ads_stg_backup'),md5(COALESCE((SELECT datacl::text FROM pg_database WHERE datname='postgres'),'<NULL>')) FROM pg_database d WHERE d.datname='meta_ads_staging';").Trim().Split('|')
  if ($binding.Count -ne 5) { throw 'R2A_RECOVERY_LOCAL_BINDING_QUERY_MISMATCH' }
  $roleOids = [ordered]@{
    meta_ads_stg_runtime = $binding[1]
    meta_ads_stg_migration = $binding[2]
    meta_ads_stg_backup = $binding[3]
  }
  $exactArgs = @(
    '-v', "expected_database_oid=$($binding[0])",
    '-v', "expected_runtime_oid=$($binding[1])",
    '-v', "expected_migration_oid=$($binding[2])",
    '-v', "expected_backup_oid=$($binding[3])",
    '-v', "expected_base_acl_md5=$($binding[4])"
  )
  $adminPassPath = Join-Path $tempRoot 'admin.pgpass'
  Write-Utf8NoBom -Path $adminPassPath -Text "$fakeHost`:5432:postgres:postgres:$adminSecret`n"

  $priorVerifiers = New-VerifierSet -Secrets $priorRoleSecrets
  [void](Invoke-ClientPsql -Name "r2a-recovery-setup-$suffix" -PgPassPath $adminPassPath `
    -SqlPath $activationPath -User postgres -InputLines @(
      $priorVerifiers.meta_ads_stg_runtime,
      $priorVerifiers.meta_ads_stg_migration,
      $priorVerifiers.meta_ads_stg_backup
    ) -ExtraArgs $exactArgs -ExpectedMarker 'G_DB_00_PHASE2_ACTIVATION_COMMITTED')

  $invariantsBefore = Get-InvariantSnapshot
  $failedVerifiers = New-VerifierSet -Secrets $failedRoleSecrets
  [void](Invoke-ClientPsql -Name "r2a-recovery-forced-$suffix" -PgPassPath $adminPassPath `
    -SqlPath $forcedRecoveryPath -User postgres -InputLines @(
      $failedVerifiers.meta_ads_stg_runtime,
      $failedVerifiers.meta_ads_stg_migration,
      $failedVerifiers.meta_ads_stg_backup
    ) -ExtraArgs $exactArgs -ExpectFailure)

  $rollbackPositiveLogins = Invoke-RolePositiveLogins -Secrets $priorRoleSecrets `
    -RoleOids $roleOids -NameStage 'rollback'
  $afterRollback = Get-InvariantSnapshot
  if ($afterRollback -cne $invariantsBefore) {
    throw 'R2A_RECOVERY_LOCAL_FORCED_FAILURE_CHANGED_INVARIANTS'
  }

  $recoveryVerifiers = New-VerifierSet -Secrets $recoveryRoleSecrets
  [void](Invoke-ClientPsql -Name "r2a-recovery-exact-$suffix" -PgPassPath $adminPassPath `
    -SqlPath $recoveryPath -User postgres -InputLines @(
      $recoveryVerifiers.meta_ads_stg_runtime,
      $recoveryVerifiers.meta_ads_stg_migration,
      $recoveryVerifiers.meta_ads_stg_backup
    ) -ExtraArgs $exactArgs -ExpectedMarker 'G_DB_00_PHASE2_CREDENTIAL_RECOVERY_COMMITTED')

  $recoveryPositiveLogins = Invoke-RolePositiveLogins -Secrets $recoveryRoleSecrets `
    -RoleOids $roleOids -NameStage 'new'
  [void](Invoke-ClientPsql -Name "r2a-recovery-final-$suffix" -PgPassPath $adminPassPath `
    -SqlPath $finalVerifyPath -User postgres -ExtraArgs $exactArgs `
    -ExpectedMarker 'PHASE2_FINAL_ADMIN_VERIFY_PASS')
  $invariantsAfter = Get-InvariantSnapshot
  if ($invariantsAfter -cne $invariantsBefore) {
    throw 'R2A_RECOVERY_LOCAL_SUCCESS_CHANGED_INVARIANTS'
  }

  $summary = [ordered]@{
    version = 'r2a-phase2-recovery-local-rehearsal/v1'
    status = 'PASS'
    startedAtUtc = $startedAt.ToString('o')
    endedAtUtc = $null
    postgresMajor = 17
    exactSavedRecoverySql = 'PASS'
    runnerParserErrors = 0
    runnerStateValidatorCases = $stateFixtures.Count
    runnerSecondAttemptRejected = $secondAttemptRejected
    markerPublishedAfterOriginalInvariant = $true
    recoverySqlSha256 = $requiredRecoverySha256
    pinnedImagesPullPolicy = 'never'
    syntheticDpapiCandidateRecords = 3
    syntheticDpapiRoundTrip = 'PASS_TEMP_ONLY'
    redirectedActualPrepareFirstRun = 'PASS'
    redirectedActualPrepareSecondRunNoRotation = 'PASS'
    redirectedOriginalBytesAndExactAclInvariant = 'PASS'
    actualAppDataOrCredentialStoreAccess = 0
    passwordOnlyRecoveryTransaction = 'PASS'
    forcedPrecommitTransactionRollback = 'PASS'
    rollbackPreservedPriorPositiveLogins = $rollbackPositiveLogins
    recoveryPositiveScramRequiredRoleLogins = $recoveryPositiveLogins
    finalAdminVerify = 'PASS'
    roleAttributesAclOwnershipMembershipInvariant = 'PASS'
    wrongOrCrossCredentialNegativeTests = 0
    plaintextSecretsInCapturedOutput = 0
    scramVerifiersInCapturedOutput = 0
    secretDerivedHashesEmitted = 0
    providerCalls = 0
    externalNetworkCalls = 0
    providerMutation = 0
    operationalReady = $false
    ownedContainersRemoved = $null
    internalDockerNetworkRemoved = $null
    tempRootRemoved = $null
    artifactHashes = [ordered]@{
      recoverySql = $requiredRecoverySha256
      roleVerifySql = (Get-FileHash -LiteralPath $roleVerifyPath -Algorithm SHA256).Hash.ToLowerInvariant()
      finalVerifySql = (Get-FileHash -LiteralPath $finalVerifyPath -Algorithm SHA256).Hash.ToLowerInvariant()
      containerEntrypoint = (Get-FileHash -LiteralPath $entrypointPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
} catch {
  $runError = $_
} finally {
  $savedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & docker rm -f $databaseContainer 2>$null | Out-Null
  & docker network rm $networkName 2>$null | Out-Null
  $ErrorActionPreference = $savedPreference
  if (Test-Path -LiteralPath $tempRoot) {
    [IO.Directory]::Delete($tempRoot, $true)
  }
  foreach ($table in @($priorVerifiers, $failedVerifiers, $recoveryVerifiers)) {
    if ($null -ne $table) { $table.Clear() }
  }
  $priorRoleSecrets.Clear()
  $failedRoleSecrets.Clear()
  $recoveryRoleSecrets.Clear()
  $adminSecret = $null
}

$containerRemainder = (& docker ps -aq --filter "name=$suffix" 2>$null | Out-String).Trim()
$networkRemainder = (& docker network ls -q --filter "name=$networkName" 2>$null | Out-String).Trim()
if (-not [string]::IsNullOrEmpty($containerRemainder) -or
    -not [string]::IsNullOrEmpty($networkRemainder) -or
    (Test-Path -LiteralPath $tempRoot)) {
  throw 'R2A_RECOVERY_LOCAL_CLEANUP_UNCONFIRMED'
}
if ($null -ne $runError) { throw $runError }

$summary.endedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
$summary.ownedContainersRemoved = 'PASS'
$summary.internalDockerNetworkRemoved = 'PASS'
$summary.tempRootRemoved = 'PASS'
$summaryJson = ($summary | ConvertTo-Json -Depth 5).Replace("`r`n", "`n")
Write-Utf8NoBom -Path $summaryPath -Text ($summaryJson + "`n")
'R2A_PHASE2_RECOVERY_LOCAL_REHEARSAL_PASS'
