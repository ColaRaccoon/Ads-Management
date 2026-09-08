[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('Execute','VerifyOnly')]
  [string]$Mode,
  [Parameter(Mandatory)]
  [ValidateSet('G_DB_00_PHASE2_EXECUTE_APPROVED_EXACT_V1','G_DB_00_PHASE2_VERIFY_ONLY_APPROVED_EXACT_V1')]
  [string]$ApprovalToken
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
  throw 'R2A_PHASE2_POWERSHELL_7_REQUIRED'
}

$target = [ordered]@{
  ProjectRef = 'ehnfrrmbkvlsbpvqcvkr'
  Host = 'aws-0-ap-northeast-2.pooler.supabase.com'
  Port = '5432'
  AdminDatabase = 'postgres'
  ApplicationDatabase = 'meta_ads_staging'
  AdminExternalUser = 'postgres.ehnfrrmbkvlsbpvqcvkr'
  DatabaseOid = '25404'
  RuntimeOid = '25397'
  MigrationOid = '25399'
  BackupOid = '25401'
  BaseAclMd5 = '94af03f1e723fcb05d1fd0a1590bbf99'
  ProductionExcludedRef = 'iygjmosbelbosfxidqxv'
}
$clientImage = 'postgres:17@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3'
$caPath = 'C:\Users\seong\AppData\Local\Temp\supabase-prod-ca-2021.crt'
$caSha256 = '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7'
$phase1ReceiptPath = Join-Path $PSScriptRoot 'provider-phase1-receipt.json'
$phase1ReceiptSha256 = 'd596ccd6bc43d479705d43cdd720221cdc71dec3c242f52ace1d70cdaba04059'
$activationPath = Join-Path $PSScriptRoot 'phase2-provider-activation.sql'
$roleVerifyPath = Join-Path $PSScriptRoot 'phase2-role-verify.sql'
$finalVerifyPath = Join-Path $PSScriptRoot 'phase2-final-admin-verify.sql'
$entrypointPath = Join-Path $PSScriptRoot 'phase2-container-entrypoint.sh'
$secretLibPath = Join-Path $PSScriptRoot 'phase2-secret-lib.ps1'
$dockerExe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$dockerContext = 'desktop-linux'
$dockerEndpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine'

if (($Mode -eq 'Execute' -and $ApprovalToken -ne 'G_DB_00_PHASE2_EXECUTE_APPROVED_EXACT_V1') -or
    ($Mode -eq 'VerifyOnly' -and $ApprovalToken -ne 'G_DB_00_PHASE2_VERIFY_ONLY_APPROVED_EXACT_V1')) {
  throw 'R2A_PHASE2_MODE_APPROVAL_TOKEN_MISMATCH'
}

function Get-R2AFileSha256 {
  param([Parameter(Mandatory)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Split-R2APgPassLine {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Line)

  if ($Line.Length -eq 0 -or $Line.StartsWith('#', [StringComparison]::Ordinal)) {
    return $null
  }
  $fields = [Collections.Generic.List[string]]::new()
  $builder = [Text.StringBuilder]::new()
  $escaped = $false
  foreach ($character in $Line.ToCharArray()) {
    if ($escaped) {
      [void]$builder.Append($character)
      $escaped = $false
    } elseif ($character -eq '\') {
      $escaped = $true
    } elseif ($character -eq ':' -and $fields.Count -lt 4) {
      $fields.Add($builder.ToString())
      [void]$builder.Clear()
    } else {
      [void]$builder.Append($character)
    }
  }
  if ($escaped) {
    [void]$builder.Append('\')
  }
  $fields.Add($builder.ToString())
  if ($fields.Count -ne 5) {
    throw 'R2A_PGPASS_PARSE_FIELD_COUNT_MISMATCH'
  }
  return [pscustomobject]@{ Fields = $fields.ToArray(); Raw = $Line }
}

function ConvertTo-R2APgPassField {
  param([Parameter(Mandatory)][string]$Value)
  return $Value.Replace('\', '\\').Replace(':', '\:')
}

function New-R2AScramVerifier {
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
      $passwordBytes,
      $salt,
      4096,
      [Security.Cryptography.HashAlgorithmName]::SHA256,
      32
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

function Write-R2APrivateTextFile {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Text
  )
  if (Test-Path -LiteralPath $Path) {
    throw 'R2A_PRIVATE_FILE_COLLISION'
  }
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
  Set-R2AUserSystemOnlyAcl -Path $Path -Directory $false
  Assert-R2AUserSystemOnlyAcl -Path $Path
}

function Write-R2AExecutionState {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][Collections.IDictionary]$Record,
    [switch]$CreateNew
  )
  $json = ($Record | ConvertTo-Json -Depth 8) + "`n"
  if ($CreateNew -and (Test-Path -LiteralPath $Path)) {
    throw 'R2A_PHASE2_EXECUTION_STATE_ALREADY_EXISTS'
  }
  $candidate = "$Path.candidate.$([Guid]::NewGuid().ToString('N'))"
  $stream = [IO.FileStream]::new(
    $candidate,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None,
    4096,
    [IO.FileOptions]::WriteThrough
  )
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
  } finally {
    $stream.Dispose()
  }
  try {
    Set-R2AUserSystemOnlyAcl -Path $candidate -Directory $false
    Assert-R2AUserSystemOnlyAcl -Path $candidate
    if ($CreateNew) {
      [IO.File]::Move($candidate, $Path)
    } else {
      [IO.File]::Move($candidate, $Path, $true)
    }
    Assert-R2AUserSystemOnlyAcl -Path $Path
  } finally {
    if (Test-Path -LiteralPath $candidate) {
      [IO.File]::Delete($candidate)
    }
  }
}

function Assert-R2AExecutionStateShape {
  param([Parameter(Mandatory)][Collections.IDictionary]$Record)

  $expectedTopKeys = @(
    'version', 'status', 'startedAtUtc', 'updatedAtUtc', 'projectRef', 'host', 'port',
    'database', 'databaseOid', 'roleOids', 'phase1ReceiptSha256', 'artifactHashes',
    'commitAckObserved', 'verifiedRoleCount', 'finalAdminVerify', 'automaticRetryCount',
    'negativeAuthTestCount', 'verifyOnlyAttemptCount', 'secretValuesOrHashesStored',
    'operationalReady'
  )
  $actualTopKeys = @($Record.Keys | ForEach-Object { [string]$_ })
  if ((@($actualTopKeys | Sort-Object) -join "`n") -ne
      (@($expectedTopKeys | Sort-Object) -join "`n")) {
    throw 'R2A_PHASE2_EXECUTION_STATE_TOP_LEVEL_KEYS_MISMATCH'
  }
  foreach ($name in @(
      'version', 'status', 'startedAtUtc', 'updatedAtUtc', 'projectRef', 'host',
      'database', 'phase1ReceiptSha256'
    )) {
    if (-not ($Record[$name] -is [string]) -or [string]::IsNullOrWhiteSpace($Record[$name])) {
      throw 'R2A_PHASE2_EXECUTION_STATE_STRING_TYPE_MISMATCH'
    }
  }
  foreach ($name in @(
      'port', 'databaseOid', 'verifiedRoleCount', 'automaticRetryCount',
      'negativeAuthTestCount', 'verifyOnlyAttemptCount'
    )) {
    if (-not ($Record[$name] -is [long])) {
      throw 'R2A_PHASE2_EXECUTION_STATE_INTEGER_TYPE_MISMATCH'
    }
  }
  foreach ($name in @(
      'commitAckObserved', 'finalAdminVerify', 'secretValuesOrHashesStored', 'operationalReady'
    )) {
    if (-not ($Record[$name] -is [bool])) {
      throw 'R2A_PHASE2_EXECUTION_STATE_BOOLEAN_TYPE_MISMATCH'
    }
  }
  foreach ($name in @('startedAtUtc', 'updatedAtUtc')) {
    $parsedTimestamp = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact(
        $Record[$name],
        'o',
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$parsedTimestamp
      )) {
      throw 'R2A_PHASE2_EXECUTION_STATE_TIMESTAMP_MISMATCH'
    }
  }

  if (-not ($Record.roleOids -is [Collections.IDictionary]) -or
      (@($Record.roleOids.Keys | Sort-Object) -join "`n") -ne
        (@('backup', 'migration', 'runtime') -join "`n")) {
    throw 'R2A_PHASE2_EXECUTION_STATE_ROLE_OID_KEYS_MISMATCH'
  }
  foreach ($name in @('runtime', 'migration', 'backup')) {
    if (-not ($Record.roleOids[$name] -is [long])) {
      throw 'R2A_PHASE2_EXECUTION_STATE_ROLE_OID_TYPE_MISMATCH'
    }
  }

  if (-not ($Record.artifactHashes -is [Collections.IDictionary]) -or
      (@($Record.artifactHashes.Keys | Sort-Object) -join "`n") -ne
        (@('activationSql', 'containerEntrypoint', 'finalVerifySql', 'roleVerifySql', 'secretLib') -join "`n")) {
    throw 'R2A_PHASE2_EXECUTION_STATE_ARTIFACT_KEYS_MISMATCH'
  }
  foreach ($name in @(
      'secretLib', 'activationSql', 'roleVerifySql', 'finalVerifySql', 'containerEntrypoint'
    )) {
    if (-not ($Record.artifactHashes[$name] -is [string]) -or
        $Record.artifactHashes[$name] -notmatch '^[a-f0-9]{64}$') {
      throw 'R2A_PHASE2_EXECUTION_STATE_ARTIFACT_HASH_TYPE_MISMATCH'
    }
  }
}

function New-R2ADockerProcessStartInfo {
  param([Parameter(Mandatory)][string[]]$Arguments)

  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $dockerExe
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  foreach ($argument in $Arguments) {
    [void]$psi.ArgumentList.Add($argument)
  }
  $psi.Environment.Clear()
  foreach ($name in @('SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      $psi.Environment[$name] = $value
    }
  }
  return $psi
}

function Invoke-R2ADockerControl {
  param(
    [Parameter(Mandatory)][string[]]$Arguments,
    [int]$TimeoutMilliseconds = 15000
  )

  $psi = New-R2ADockerProcessStartInfo -Arguments $Arguments
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $psi
  if (-not $process.Start()) { throw 'R2A_DOCKER_CONTROL_START_FAILED' }
  $process.StandardInput.Close()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  try {
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      $process.Kill($true)
      $process.WaitForExit()
      throw 'R2A_DOCKER_CONTROL_TIMEOUT'
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($stdout.Length -gt 65536 -or $stderr.Length -gt 65536) {
      throw 'R2A_DOCKER_CONTROL_OUTPUT_LIMIT_EXCEEDED'
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
  } finally {
    if (-not $process.HasExited) {
      $process.Kill($true)
      $process.WaitForExit()
    }
    $process.Dispose()
  }
}

function Remove-R2AOwnedTempContainer {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$CidFilePath,
    [Parameter(Mandatory)][string]$OwnerLabel
  )
  if (-not $Name.StartsWith('r2a-phase2-', [StringComparison]::Ordinal) -or
      $Name -notmatch '^r2a-phase2-[a-z0-9-]{1,50}$') {
    throw 'R2A_PHASE2_CONTAINER_CLEANUP_SCOPE_INVALID'
  }
  if ($OwnerLabel -notmatch '^r2a-phase2-[a-f0-9]{32}$') {
    throw 'R2A_PHASE2_CONTAINER_OWNER_LABEL_INVALID'
  }
  if (-not (Test-Path -LiteralPath $CidFilePath -PathType Leaf)) {
    $ownedByName = Invoke-R2ADockerControl -Arguments @(
      '--host', $dockerEndpoint, 'ps', '-aq', '--no-trunc',
      '--filter', "name=^/$Name`$",
      '--filter', "label=com.colaraccoon.r2a.phase2.owner=$OwnerLabel"
    )
    if ($ownedByName.ExitCode -ne 0) {
      throw 'R2A_PHASE2_CONTAINER_CID_ABSENT_INSPECT_FAILED'
    }
    $ownedIds = @($ownedByName.Stdout -split "`r?`n" | Where-Object { $_.Length -ne 0 })
    if ($ownedIds.Count -eq 0) { return }
    if ($ownedIds.Count -ne 1 -or $ownedIds[0] -notmatch '^[a-f0-9]{64}$') {
      throw 'R2A_PHASE2_CONTAINER_CID_ABSENT_OWNED_SET_INVALID'
    }
    $containerId = $ownedIds[0]
  } else {
    Assert-R2ANotReparsePoint -Path $CidFilePath
    $containerId = (Get-Content -Raw -LiteralPath $CidFilePath).Trim()
    if ($containerId -notmatch '^[a-f0-9]{64}$') {
      throw 'R2A_PHASE2_CONTAINER_CID_INVALID'
    }
  }

  $inspect = Invoke-R2ADockerControl -Arguments @(
    '--host', $dockerEndpoint, 'inspect', '--type', 'container',
    '--format', '{{.Id}}|{{index .Config.Labels "com.colaraccoon.r2a.phase2.owner"}}',
    $containerId
  )
  if ($inspect.ExitCode -eq 0) {
    if ($inspect.Stdout.Trim() -ne "$containerId|$OwnerLabel") {
      throw 'R2A_PHASE2_CONTAINER_OWNERSHIP_MISMATCH'
    }
    $remove = Invoke-R2ADockerControl -Arguments @('--host', $dockerEndpoint, 'rm', '-f', $containerId)
    if ($remove.ExitCode -ne 0) { throw 'R2A_PHASE2_CONTAINER_REMOVE_FAILED' }
  }

  $remaining = Invoke-R2ADockerControl -Arguments @(
    '--host', $dockerEndpoint, 'ps', '-aq', '--no-trunc', '--filter', "id=$containerId"
  )
  if ($remaining.ExitCode -ne 0 -or $remaining.Stdout.Trim().Length -ne 0) {
    throw 'R2A_PHASE2_CONTAINER_CLEANUP_UNCONFIRMED'
  }
}

function Invoke-R2ADockerPsql {
  param(
    [Parameter(Mandatory)][string]$ContainerName,
    [Parameter(Mandatory)][string]$CidFilePath,
    [Parameter(Mandatory)][string]$OwnerLabel,
    [Parameter(Mandatory)][string[]]$DockerArguments,
    [string[]]$InputLines = @(),
    [Parameter(Mandatory)][string[]]$Secrets,
    [Parameter(Mandatory)][string]$ExpectedMarker
  )

  $psi = New-R2ADockerProcessStartInfo -Arguments $DockerArguments
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $psi
  if (-not $process.Start()) {
    throw 'R2A_DOCKER_PROCESS_START_FAILED'
  }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  try {
    foreach ($line in $InputLines) {
      $process.StandardInput.WriteLine($line)
    }
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(60000)) {
      $process.Kill($true)
      $process.WaitForExit()
      Remove-R2AOwnedTempContainer -Name $ContainerName -CidFilePath $CidFilePath -OwnerLabel $OwnerLabel
      throw 'R2A_DOCKER_PSQL_TIMEOUT_OUTCOME_INDETERMINATE'
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($stdout.Length -gt 65536 -or $stderr.Length -gt 65536) {
      throw 'R2A_DOCKER_PSQL_OUTPUT_LIMIT_EXCEEDED'
    }
    foreach ($secret in $Secrets) {
      if ($stdout.Contains($secret, [StringComparison]::Ordinal) -or
          $stderr.Contains($secret, [StringComparison]::Ordinal)) {
        throw 'R2A_SECRET_DISCLOSURE_DETECTED_OUTPUT_SUPPRESSED'
      }
    }
    if ($stdout -match 'SCRAM-SHA-256\$' -or $stderr -match 'SCRAM-SHA-256\$') {
      throw 'R2A_VERIFIER_DISCLOSURE_DETECTED_OUTPUT_SUPPRESSED'
    }
    if ($process.ExitCode -ne 0) {
      throw "R2A_DOCKER_PSQL_FAILED_EXIT_$($process.ExitCode)_RAW_OUTPUT_SUPPRESSED"
    }
    if (-not $stdout.Contains($ExpectedMarker, [StringComparison]::Ordinal)) {
      throw 'R2A_DOCKER_PSQL_EXPECTED_MARKER_MISSING'
    }
    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      ExpectedMarker = $ExpectedMarker
      SecretOrVerifierInOutput = $false
    }
  } finally {
    if (-not $process.HasExited) {
      $process.Kill($true)
      $process.WaitForExit()
    }
    $process.Dispose()
    Remove-R2AOwnedTempContainer -Name $ContainerName -CidFilePath $CidFilePath -OwnerLabel $OwnerLabel
  }
}

function New-R2ABaseDockerArguments {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$CidFilePath,
    [Parameter(Mandatory)][string]$OwnerLabel,
    [Parameter(Mandatory)][string]$PgPassPath,
    [Parameter(Mandatory)][string]$SqlHostPath
  )

  return @(
    '--host', $dockerEndpoint,
    'run', '--rm', '--interactive', '--pull', 'never', '--name', $Name,
    '--cidfile', $CidFilePath,
    '--label', "com.colaraccoon.r2a.phase2.owner=$OwnerLabel",
    '--log-driver', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '64',
    '--memory', '256m', '--memory-swap', '256m',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,mode=1777',
    '--mount', "type=bind,source=$PgPassPath,target=/run/secrets/input.pgpass,readonly",
    '--mount', "type=bind,source=$caPath,target=/run/ca.crt,readonly",
    '--mount', "type=bind,source=$entrypointPath,target=/run/entrypoint.sh,readonly",
    '--mount', "type=bind,source=$SqlHostPath,target=/run/task.sql,readonly",
    '--env', 'PGSSLMODE=verify-full', '--env', 'PGSSLROOTCERT=/run/ca.crt',
    '--env', 'PGGSSENCMODE=disable', '--env', 'PGCONNECT_TIMEOUT=8',
    '--env', 'PGREQUIREAUTH=scram-sha-256',
    '--entrypoint', '/bin/sh', $clientImage, '/run/entrypoint.sh'
  )
}

$requiredExecutionHashes = [ordered]@{
  $secretLibPath = '48ddce9d009f8c2e4aa46f18060608ed818807ceba546ea401666a20950fec2c'
  $activationPath = '8b8527e25caff9fa9edab37420bd4808fbdf953fd75182a17e8e8c0c080671a7'
  $roleVerifyPath = '846762928ddc6012202fe989336536fd07c34dd37cd126591e81fe3da8043efe'
  $finalVerifyPath = '3c13be90502d9947cc13f7bf42eea1e796001a12cdb7ef1755b6b600ef26f184'
  $entrypointPath = '3116be65ed91b60e9e3db6f191440eedab020a671d1c438c965b32fe4d9e2c41'
}
foreach ($artifact in $requiredExecutionHashes.GetEnumerator()) {
  if (-not (Test-Path -LiteralPath $artifact.Key -PathType Leaf) -or
      (Get-R2AFileSha256 -Path $artifact.Key) -ne $artifact.Value) {
    throw 'R2A_PHASE2_EXECUTION_ARTIFACT_HASH_MISMATCH'
  }
}
. $secretLibPath

if ($target.ProjectRef -eq $target.ProductionExcludedRef -or $target.Port -ne '5432' -or
    $target.ApplicationDatabase -ne 'meta_ads_staging') {
  throw 'R2A_PHASE2_TARGET_BINDING_INVALID'
}
if (-not (Test-Path -LiteralPath $dockerExe -PathType Leaf) -or
    (Get-Item -LiteralPath $dockerExe).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
  throw 'R2A_PHASE2_DOCKER_EXECUTABLE_MISMATCH'
}
$contextInspect = Invoke-R2ADockerControl -Arguments @(
  '--context', $dockerContext, 'context', 'inspect', $dockerContext,
  '--format', '{{json .Endpoints.docker.Host}}'
)
$contextEndpoint = $contextInspect.Stdout.Trim().Trim('"')
if ($contextInspect.ExitCode -ne 0 -or $contextEndpoint -ne $dockerEndpoint) {
  throw 'R2A_PHASE2_DOCKER_CONTEXT_ENDPOINT_MISMATCH'
}
$daemonProbe = Invoke-R2ADockerControl -Arguments @(
  '--host', $dockerEndpoint, 'version', '--format', '{{.Server.Os}}'
)
if ($daemonProbe.ExitCode -ne 0 -or $daemonProbe.Stdout.Trim() -ne 'linux') {
  throw 'R2A_PHASE2_DOCKER_DAEMON_ENDPOINT_MISMATCH'
}
if ((Get-R2AFileSha256 -Path $caPath) -ne $caSha256 -or
    (Get-R2AFileSha256 -Path $phase1ReceiptPath) -ne $phase1ReceiptSha256) {
  throw 'R2A_PHASE2_CA_OR_PHASE1_RECEIPT_HASH_MISMATCH'
}
$secretRoot = Get-R2ASecretRoot
Assert-R2ANotReparsePoint -Path $secretRoot
Assert-R2AUserSystemOnlyAcl -Path $secretRoot
$activationMarkerPath = Join-Path $secretRoot 'phase2-activation.json'
$executionStatePath = Join-Path $secretRoot 'phase2-execution-state.json'
$executionLockPath = Join-Path $secretRoot 'phase2-execution.lock'
if (Test-Path -LiteralPath $activationMarkerPath) {
  [void](Read-R2AActivationMarker -Root $secretRoot)
  throw 'R2A_PHASE2_ALREADY_ACTIVATED_NO_RETRY'
}
if ($Mode -eq 'Execute' -and (Test-Path -LiteralPath $executionStatePath)) {
  throw 'R2A_PHASE2_PRIOR_EXECUTION_STATE_REQUIRES_CLASSIFICATION_NO_RETRY'
}
if ($Mode -eq 'VerifyOnly' -and -not (Test-Path -LiteralPath $executionStatePath)) {
  throw 'R2A_PHASE2_VERIFY_ONLY_EXECUTION_STATE_MISSING'
}
$executionLock = [IO.FileStream]::new(
  $executionLockPath,
  [IO.FileMode]::CreateNew,
  [IO.FileAccess]::ReadWrite,
  [IO.FileShare]::None,
  1,
  [IO.FileOptions]::DeleteOnClose
)
Set-R2AUserSystemOnlyAcl -Path $executionLockPath -Directory $false
$secrets = @{}
$executionState = $null
$executionStage = if ($Mode -eq 'Execute') { 'LOCAL_PRECONDITION' } else { 'VERIFY_ONLY_LOCAL_PRECONDITION' }
try {
  if ($Mode -eq 'VerifyOnly') {
    Assert-R2ANotReparsePoint -Path $executionStatePath
    Assert-R2AUserSystemOnlyAcl -Path $executionStatePath
    $loadedExecutionState = Get-Content -Raw -LiteralPath $executionStatePath |
      ConvertFrom-Json -AsHashtable -DateKind String
    Assert-R2AExecutionStateShape -Record $loadedExecutionState
    $verifyEligibleStatuses = @(
      'ACTIVATION_ATTEMPT_STARTED',
      'COMMIT_OUTCOME_UNKNOWN',
      'COMMIT_ACK_OBSERVED',
      'COMMITTED_VERIFY_IN_PROGRESS',
      'COMMITTED_VERIFY_FAILED',
      'PROVIDER_VERIFIED_PENDING_LOCAL_CLEANUP',
      'PROVIDER_VERIFIED_LOCAL_CLEANUP_FAILED',
      'VERIFIED',
      'VERIFIED_LOCAL_FINALIZE_FAILED'
    )
    if ($loadedExecutionState.version -ne 'r2a-phase2-execution-state/v1' -or
        $loadedExecutionState.projectRef -ne $target.ProjectRef -or
        $loadedExecutionState.host -ne $target.Host -or
        $loadedExecutionState.port -ne 5432 -or
        $loadedExecutionState.database -ne $target.ApplicationDatabase -or
        $loadedExecutionState.databaseOid -ne 25404 -or
        $loadedExecutionState.status -notin $verifyEligibleStatuses -or
        $loadedExecutionState.roleOids.runtime -ne 25397 -or
        $loadedExecutionState.roleOids.migration -ne 25399 -or
        $loadedExecutionState.roleOids.backup -ne 25401 -or
        $loadedExecutionState.phase1ReceiptSha256 -ne $phase1ReceiptSha256 -or
        $loadedExecutionState.artifactHashes.secretLib -ne $requiredExecutionHashes[$secretLibPath] -or
        $loadedExecutionState.artifactHashes.activationSql -ne $requiredExecutionHashes[$activationPath] -or
        $loadedExecutionState.artifactHashes.roleVerifySql -ne $requiredExecutionHashes[$roleVerifyPath] -or
        $loadedExecutionState.artifactHashes.finalVerifySql -ne $requiredExecutionHashes[$finalVerifyPath] -or
        $loadedExecutionState.artifactHashes.containerEntrypoint -ne $requiredExecutionHashes[$entrypointPath] -or
        $loadedExecutionState.automaticRetryCount -ne 0 -or
        $loadedExecutionState.negativeAuthTestCount -ne 0 -or
        $loadedExecutionState.verifyOnlyAttemptCount -ne 0 -or
        $loadedExecutionState.verifiedRoleCount -lt 0 -or
        $loadedExecutionState.verifiedRoleCount -gt 3 -or
        $loadedExecutionState.secretValuesOrHashesStored -ne $false -or
        $loadedExecutionState.operationalReady -ne $false) {
      throw 'R2A_PHASE2_VERIFY_ONLY_EXECUTION_STATE_CONTRACT_MISMATCH'
    }
    $status = [string]$loadedExecutionState.status
    $commitAck = [bool]$loadedExecutionState.commitAckObserved
    $roleCount = $loadedExecutionState.verifiedRoleCount
    $finalVerified = $loadedExecutionState.finalAdminVerify
    if (($status -in @('ACTIVATION_ATTEMPT_STARTED', 'COMMIT_OUTCOME_UNKNOWN') -and
          ($commitAck -or $roleCount -ne 0 -or $finalVerified)) -or
        ($status -eq 'COMMIT_ACK_OBSERVED' -and
          (-not $commitAck -or $roleCount -ne 0 -or $finalVerified)) -or
        ($status -eq 'COMMITTED_VERIFY_IN_PROGRESS' -and
          (-not $commitAck -or $roleCount -notin @(1, 2, 3) -or $finalVerified)) -or
        ($status -eq 'COMMITTED_VERIFY_FAILED' -and
          (-not $commitAck -or $finalVerified)) -or
        ($status -in @(
            'PROVIDER_VERIFIED_PENDING_LOCAL_CLEANUP',
            'PROVIDER_VERIFIED_LOCAL_CLEANUP_FAILED'
          ) -and (-not $commitAck -or $roleCount -ne 3 -or -not $finalVerified)) -or
        ($status -in @('VERIFIED', 'VERIFIED_LOCAL_FINALIZE_FAILED') -and
          (-not $commitAck -or $roleCount -ne 3 -or -not $finalVerified))) {
      throw 'R2A_PHASE2_VERIFY_ONLY_EXECUTION_STATE_SEMANTIC_MISMATCH'
    }
    $executionState = $loadedExecutionState
  }

  $tempParent = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'MetaAdsSecurity\phase2-temp'))
  Assert-R2ANotReparsePoint -Path $env:LOCALAPPDATA
  Assert-R2ANotReparsePoint -Path (Split-Path -Parent $tempParent)
  Assert-R2ANotReparsePoint -Path $tempParent
  if (-not (Test-Path -LiteralPath $tempParent)) {
    [void][IO.Directory]::CreateDirectory($tempParent)
    Set-R2AUserSystemOnlyAcl -Path $tempParent -Directory $true
  }
  Assert-R2AUserSystemOnlyAcl -Path $tempParent
  if (@(Get-ChildItem -LiteralPath $tempParent -Force).Count -ne 0) {
    throw 'R2A_PHASE2_STALE_TEMP_REQUIRES_MANUAL_CLASSIFICATION'
  }

  foreach ($role in $script:R2AAllowedRoles) {
    $record = Read-R2ACredentialRecord -Root $secretRoot -Role $role
    if ($record.state -ne 'stored') {
      throw 'R2A_PHASE2_CREDENTIAL_NOT_STORED'
    }
    $plain = Unprotect-R2APlaintextSecret -Ciphertext $record.ciphertext
    if ($plain -notmatch '^[A-Za-z0-9_-]{43}$') {
      throw 'R2A_PHASE2_CREDENTIAL_SHAPE_MISMATCH'
    }
    $secrets[$role] = $plain
  }
  if (@($secrets.Values | Sort-Object -Unique).Count -ne 3) {
    throw 'R2A_PHASE2_CREDENTIALS_NOT_DISTINCT'
  }

  $globalPgPass = Join-Path $env:APPDATA 'postgresql\pgpass.conf'
  Assert-R2ANotReparsePoint -Path $globalPgPass
  Assert-R2AUserSystemOnlyAcl -Path $globalPgPass
  $parsedLines = @(Get-Content -LiteralPath $globalPgPass | ForEach-Object {
    Split-R2APgPassLine -Line $_
  } | Where-Object { $null -ne $_ })
  $adminMatches = @($parsedLines | Where-Object {
    $_.Fields[0] -eq $target.Host -and $_.Fields[1] -eq $target.Port -and
    $_.Fields[2] -eq $target.AdminDatabase -and $_.Fields[3] -eq $target.AdminExternalUser
  })
  if ($adminMatches.Count -ne 1 -or [string]::IsNullOrWhiteSpace($adminMatches[0].Fields[4])) {
    throw 'R2A_PHASE2_EXACT_ADMIN_PGPASS_ENTRY_MISMATCH'
  }

  if ($Mode -eq 'Execute') {
    $executionState = [ordered]@{
      version = 'r2a-phase2-execution-state/v1'
      status = 'INTENT_RECORDED'
      startedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
      updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
      projectRef = $target.ProjectRef
      host = $target.Host
      port = [int]$target.Port
      database = $target.ApplicationDatabase
      databaseOid = [int]$target.DatabaseOid
      roleOids = [ordered]@{
        runtime = [int]$target.RuntimeOid
        migration = [int]$target.MigrationOid
        backup = [int]$target.BackupOid
      }
      phase1ReceiptSha256 = $phase1ReceiptSha256
      artifactHashes = [ordered]@{
        secretLib = $requiredExecutionHashes[$secretLibPath]
        activationSql = $requiredExecutionHashes[$activationPath]
        roleVerifySql = $requiredExecutionHashes[$roleVerifyPath]
        finalVerifySql = $requiredExecutionHashes[$finalVerifyPath]
        containerEntrypoint = $requiredExecutionHashes[$entrypointPath]
      }
      commitAckObserved = $false
      verifiedRoleCount = 0
      finalAdminVerify = $false
      automaticRetryCount = 0
      negativeAuthTestCount = 0
      verifyOnlyAttemptCount = 0
      secretValuesOrHashesStored = $false
      operationalReady = $false
    }
    Write-R2AExecutionState -Path $executionStatePath -Record $executionState -CreateNew
    $executionStage = 'INTENT_RECORDED'
  } else {
    $executionStage = 'VERIFY_ONLY_IN_PROGRESS'
    $executionState.lastVerifyOnlyFromStatus = $executionState.status
    $executionState.status = 'VERIFY_ONLY_IN_PROGRESS'
    $executionState.verifyOnlyAttemptCount = [int]$executionState.verifyOnlyAttemptCount + 1
    $executionState.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    Write-R2AExecutionState -Path $executionStatePath -Record $executionState
  }

  $tempRoot = Join-Path $tempParent ([Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($tempRoot)
  Set-R2AUserSystemOnlyAcl -Path $tempRoot -Directory $true
  $containerRecords = [Collections.Generic.List[object]]::new()
  $ownerLabel = "r2a-phase2-$([Guid]::NewGuid().ToString('N'))"
  try {
    $adminPassPath = Join-Path $tempRoot 'admin.pgpass'
    Write-R2APrivateTextFile -Path $adminPassPath -Text ($adminMatches[0].Raw + "`n")
    $rolePassPaths = @{}
    foreach ($role in $script:R2AAllowedRoles) {
      $externalUser = "$role.$($target.ProjectRef)"
      $line = @(
        $target.Host, $target.Port, $target.ApplicationDatabase, $externalUser, $secrets[$role]
      ) | ForEach-Object { ConvertTo-R2APgPassField -Value $_ }
      $path = Join-Path $tempRoot "$role.pgpass"
      Write-R2APrivateTextFile -Path $path -Text (($line -join ':') + "`n")
      $rolePassPaths[$role] = $path
    }

    $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
    if ($Mode -eq 'Execute') {
      $activationContainerName = "r2a-phase2-activate-$suffix"
      $activationCidFile = Join-Path $tempRoot 'activation.cid'
      [void]$containerRecords.Add([pscustomobject]@{
        Name = $activationContainerName; CidFilePath = $activationCidFile; OwnerLabel = $ownerLabel
      })
      $activationArgs = New-R2ABaseDockerArguments -Name $activationContainerName `
        -CidFilePath $activationCidFile -OwnerLabel $ownerLabel `
        -PgPassPath $adminPassPath -SqlHostPath $activationPath
      $activationArgs += @(
        '-X', '-n', '-q', '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate',
        '-v', "expected_database_oid=$($target.DatabaseOid)",
        '-v', "expected_runtime_oid=$($target.RuntimeOid)",
        '-v', "expected_migration_oid=$($target.MigrationOid)",
        '-v', "expected_backup_oid=$($target.BackupOid)",
        '-v', "expected_base_acl_md5=$($target.BaseAclMd5)",
        '-h', $target.Host, '-p', $target.Port, '-U', $target.AdminExternalUser,
        '-d', $target.AdminDatabase, '-f', '/run/task.sql'
      )
      $verifiers = @{
        meta_ads_stg_runtime = New-R2AScramVerifier -Plaintext $secrets['meta_ads_stg_runtime']
        meta_ads_stg_migration = New-R2AScramVerifier -Plaintext $secrets['meta_ads_stg_migration']
        meta_ads_stg_backup = New-R2AScramVerifier -Plaintext $secrets['meta_ads_stg_backup']
      }
      if (@($verifiers.Values | Sort-Object -Unique).Count -ne 3 -or
          @($verifiers.Values | Where-Object { $_ -notmatch '^SCRAM-SHA-256\$4096:' }).Count -ne 0) {
        throw 'R2A_PHASE2_SCRAM_VERIFIER_BUILD_MISMATCH'
      }
      $inputLines = @(
        $verifiers['meta_ads_stg_runtime'],
        $verifiers['meta_ads_stg_migration'],
        $verifiers['meta_ads_stg_backup']
      )
      $executionStage = 'ACTIVATION_ATTEMPT_STARTED'
      $executionState.status = 'ACTIVATION_ATTEMPT_STARTED'
      $executionState.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
      Write-R2AExecutionState -Path $executionStatePath -Record $executionState
      [void](Invoke-R2ADockerPsql -DockerArguments $activationArgs `
        -ContainerName $activationContainerName -CidFilePath $activationCidFile -OwnerLabel $ownerLabel `
        -InputLines $inputLines -Secrets (@($secrets.Values) + @($verifiers.Values)) `
        -ExpectedMarker 'G_DB_00_PHASE2_ACTIVATION_COMMITTED')
      $verifiers.Clear()
      $executionStage = 'COMMIT_ACK_OBSERVED'
      $executionState.status = 'COMMIT_ACK_OBSERVED'
      $executionState.commitAckObserved = $true
      $executionState.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
      Write-R2AExecutionState -Path $executionStatePath -Record $executionState
    }

    $roleResults = @()
    $roleOids = @{
      meta_ads_stg_runtime = $target.RuntimeOid
      meta_ads_stg_migration = $target.MigrationOid
      meta_ads_stg_backup = $target.BackupOid
    }
    foreach ($role in $script:R2AAllowedRoles) {
      $externalUser = "$role.$($target.ProjectRef)"
      $roleContainerName = "r2a-phase2-$($role.Replace('meta_ads_stg_', ''))-$suffix"
      $roleCidFile = Join-Path $tempRoot "$role.cid"
      [void]$containerRecords.Add([pscustomobject]@{
        Name = $roleContainerName; CidFilePath = $roleCidFile; OwnerLabel = $ownerLabel
      })
      $roleArgs = New-R2ABaseDockerArguments -Name $roleContainerName `
        -CidFilePath $roleCidFile -OwnerLabel $ownerLabel `
        -PgPassPath $rolePassPaths[$role] -SqlHostPath $roleVerifyPath
      $roleArgs += @(
        '-X', '-n', '-q', '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate',
        '-v', "expected_role=$role", '-v', "expected_role_oid=$($roleOids[$role])",
        '-h', $target.Host, '-p', $target.Port, '-U', $externalUser,
        '-d', $target.ApplicationDatabase, '-f', '/run/task.sql'
      )
      $roleResults += Invoke-R2ADockerPsql -DockerArguments $roleArgs -Secrets @($secrets.Values) `
        -ContainerName $roleContainerName -CidFilePath $roleCidFile -OwnerLabel $ownerLabel `
        -ExpectedMarker 'PHASE2_ROLE_VERIFY_PASS'
      $executionState.verifiedRoleCount = $roleResults.Count
      $executionState.status = if ($Mode -eq 'Execute') {
        'COMMITTED_VERIFY_IN_PROGRESS'
      } else {
        'VERIFY_ONLY_IN_PROGRESS'
      }
      $executionState.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
      Write-R2AExecutionState -Path $executionStatePath -Record $executionState
    }

    $finalContainerName = "r2a-phase2-final-$suffix"
    $finalCidFile = Join-Path $tempRoot 'final.cid'
    [void]$containerRecords.Add([pscustomobject]@{
      Name = $finalContainerName; CidFilePath = $finalCidFile; OwnerLabel = $ownerLabel
    })
    $finalArgs = New-R2ABaseDockerArguments -Name $finalContainerName `
      -CidFilePath $finalCidFile -OwnerLabel $ownerLabel `
      -PgPassPath $adminPassPath -SqlHostPath $finalVerifyPath
    $finalArgs += @(
      '-X', '-n', '-q', '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate',
      '-v', "expected_database_oid=$($target.DatabaseOid)",
      '-v', "expected_runtime_oid=$($target.RuntimeOid)",
      '-v', "expected_migration_oid=$($target.MigrationOid)",
      '-v', "expected_backup_oid=$($target.BackupOid)",
      '-v', "expected_base_acl_md5=$($target.BaseAclMd5)",
      '-h', $target.Host, '-p', $target.Port, '-U', $target.AdminExternalUser,
      '-d', $target.AdminDatabase, '-f', '/run/task.sql'
    )
    [void](Invoke-R2ADockerPsql -DockerArguments $finalArgs -Secrets @($secrets.Values) `
      -ContainerName $finalContainerName -CidFilePath $finalCidFile -OwnerLabel $ownerLabel `
      -ExpectedMarker 'PHASE2_FINAL_ADMIN_VERIFY_PASS')

    $executionStage = 'PROVIDER_VERIFIED_PENDING_LOCAL_CLEANUP'
    $executionState.status = 'PROVIDER_VERIFIED_PENDING_LOCAL_CLEANUP'
    $executionState.finalAdminVerify = $true
    $executionState.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    Write-R2AExecutionState -Path $executionStatePath -Record $executionState
    $successSummary = [ordered]@{
      status = if ($Mode -eq 'Execute') {
        'PHASE2_PROVIDER_ACTIVATION_AND_THREE_ROLE_VERIFY_PASS'
      } else {
        'PHASE2_PROVIDER_VERIFY_ONLY_THREE_ROLE_VERIFY_PASS'
      }
      mode = $Mode
      target = [ordered]@{
        projectRef = $target.ProjectRef
        host = $target.Host
        port = [int]$target.Port
        database = $target.ApplicationDatabase
      }
      activationCommittedOrProvenActive = $true
      activationAttemptedThisRun = ($Mode -eq 'Execute')
      positiveRoleVerificationCount = $roleResults.Count
      requireAuth = 'scram-sha-256'
      sslMode = 'verify-full'
      credentialState = 'active_verified_marker_written'
      secretValuesOrHashesEmitted = $false
      negativeAuthTests = 0
      retries = 0
      operationalReady = $false
    }
  } finally {
    $allContainersRemoved = $true
    foreach ($containerRecord in $containerRecords) {
      try {
        Remove-R2AOwnedTempContainer -Name $containerRecord.Name `
          -CidFilePath $containerRecord.CidFilePath -OwnerLabel $containerRecord.OwnerLabel
      } catch { $allContainersRemoved = $false }
    }
    if ($allContainersRemoved -and (Test-Path -LiteralPath $tempRoot)) {
      [IO.Directory]::Delete($tempRoot, $true)
    }
    if (-not $allContainersRemoved) {
      throw 'R2A_PHASE2_CONTAINER_CLEANUP_UNCONFIRMED_TEMP_SECRETS_RETAINED'
    }
  }
  $executionStage = 'VERIFIED'
  $executionState.status = if ($Mode -eq 'Execute') {
    'VERIFIED'
  } else {
    'VERIFIED_BY_SEPARATELY_APPROVED_VERIFY_ONLY'
  }
  $executionState.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  Write-R2AExecutionState -Path $executionStatePath -Record $executionState
  Write-R2AActivationMarkerCreateNew -Root $secretRoot
  $successSummary | ConvertTo-Json -Depth 5
} catch {
  if ($null -ne $executionState -and (Test-Path -LiteralPath $executionStatePath)) {
    if ($executionStage -eq 'LOCAL_PRECONDITION' -or $executionStage -eq 'INTENT_RECORDED') {
      $executionState.status = 'LOCAL_FAILURE_NO_PROVIDER_ATTEMPT'
    } elseif ($executionStage -eq 'VERIFY_ONLY_IN_PROGRESS') {
      $executionState.status = 'VERIFY_ONLY_FAILED_STATE_AMBIGUOUS'
    } elseif ($executionStage -eq 'ACTIVATION_ATTEMPT_STARTED') {
      if ($_.Exception.Message -match 'FAILED_EXIT_3_') {
        $executionState.status = 'PRECOMMIT_SCRIPT_FAILED_ROLLBACK_EXPECTED'
      } else {
        $executionState.status = 'COMMIT_OUTCOME_UNKNOWN'
      }
    } elseif ($executionStage -eq 'COMMIT_ACK_OBSERVED') {
      $executionState.status = 'COMMITTED_VERIFY_FAILED'
    } elseif ($executionStage -eq 'PROVIDER_VERIFIED_PENDING_LOCAL_CLEANUP') {
      $executionState.status = 'PROVIDER_VERIFIED_LOCAL_CLEANUP_FAILED'
    } elseif ($executionStage -eq 'VERIFIED') {
      $executionState.status = 'VERIFIED_LOCAL_FINALIZE_FAILED'
    }
    $executionState.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    try { Write-R2AExecutionState -Path $executionStatePath -Record $executionState } catch {}
  }
  throw
} finally {
  $secrets.Clear()
  $executionLock.Dispose()
}
