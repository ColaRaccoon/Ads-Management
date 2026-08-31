#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Apply','Verify')][string]$Action = 'Plan',
  [ValidateSet('RETURN_FORWARD','ACCEPT_ROLLBACK_DROP_PRESERVED')][string]$Mode,
  [string]$RuntimeConfigPath,[string]$ExpectedRuntimeConfigSha256,
  [string]$RollbackJournalPath,[string]$ExpectedRollbackJournalSha256,
  [string]$RollbackEvidencePath,[string]$ExpectedRollbackEvidenceSha256,
  [string]$RestoreReceiptPublicKeyPath,[string]$ExpectedRestoreReceiptPublicKeySha256,
  [string]$NodePath,[string]$ExpectedNodeSha256,
  [string]$AttestationVerifierPath,[string]$ExpectedAttestationVerifierSha256,
  [string]$RecoveryProcessTreeHelperPath,[string]$ExpectedRecoveryProcessTreeHelperSha256,
  [string]$LocalRecoverySecurityHelperPath,[string]$ExpectedLocalRecoverySecurityHelperSha256,[string]$RecoveryWorkspaceRoot,[ValidatePattern('^[A-Za-z0-9._-]{1,128}$')][string]$CoreServiceName='MetaAdsPerformanceCore',
  [string]$PsqlPath,[string]$ExpectedPsqlSha256,
  [string]$PgPassFile,[string]$ExpectedPgPassSha256,
  [string]$CaCertificatePath,[string]$ExpectedCaCertificateSha256,
  [string]$FileSystemEvidencePath,[string]$ExpectedFileSystemEvidenceSha256,
  [string]$MaintenanceFlagPath,[string]$ExpectedMaintenanceFlagSha256,
  [string]$ExpectedMaintenanceApprovalIdDigest,
  [ValidateSet('ACTIVE_LOCAL_EDGE','LEGACY_QUIESCED_NO_EDGE','STOPPED_LOCAL_EDGE')][string]$EdgeStateMode = 'ACTIVE_LOCAL_EDGE',
  [string]$DrainStatePath,[string]$ExpectedDrainStateSha256,
  [string]$EdgeReleaseRoot,[string]$ExpectedEdgeReleaseManifestSha256,
  [string]$EdgeDrainHelperPath,[string]$ExpectedEdgeDrainHelperSha256,
  [string]$EdgeSigningPublicKeyPath,[string]$ExpectedEdgeSigningPublicKeySha256,
  [ValidatePattern('^[A-Za-z0-9._-]{1,128}$')][string]$EdgeServiceName = 'MetaAdsPerformanceEdge',
  [string]$LegacyQuiesceEvidencePath,[string]$ExpectedLegacyQuiesceEvidenceSha256,
  [string]$QuiesceReceiptPublicKeyPath,[string]$ExpectedQuiesceReceiptPublicKeySha256,
  [string]$FinalizationJournalPath,[string]$ExpectedFinalizationJournalSha256,
  [string]$ExpectedApplyPlanSha256,
  [string]$ConfirmProjectRef,[string]$ConfirmDatabaseHost,[string]$ConfirmDatabaseName,
  [string]$ConfirmDatabaseSchema,[string]$ConfirmDatabaseUser,
  [ValidateSet('Apply','VerifyEvidence')][string]$PlannedAction,
  [string]$ApprovedPlanSha256,[string]$ApprovalNonce,[string]$ApprovalIssuedAt,
  [string]$ApprovalExpiresAt,[string]$ApprovalInstanceId,[string]$ApprovalLedgerPath,
  [switch]$Approved
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
$script:recoveryProcessTreeHelper = if ($RecoveryProcessTreeHelperPath) { [IO.Path]::GetFullPath($RecoveryProcessTreeHelperPath) } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'recovery-process-tree.ps1')) }
. (Import-PinnedHelperScriptBlock $script:recoveryProcessTreeHelper $ExpectedRecoveryProcessTreeHelperSha256 'ROLLBACK_FINALIZE_PROCESS_TREE_HELPER_HASH_MISMATCH')
$script:localRecoverySecurityHelper = if ($LocalRecoverySecurityHelperPath) { [IO.Path]::GetFullPath($LocalRecoverySecurityHelperPath) } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'local-recovery-security.ps1')) }
. (Import-PinnedHelperScriptBlock $script:localRecoverySecurityHelper $ExpectedLocalRecoverySecurityHelperSha256 'ROLLBACK_FINALIZE_LOCAL_RECOVERY_SECURITY_HELPER_HASH_MISMATCH')

$script:MaximumLegacyQuiesceAgeSeconds = 14400
$script:MaximumEdgeDrainAgeSeconds = 30
$script:MaximumJsonBytes = 16777216
$script:edgeDrainHelper = $null
if ($EdgeStateMode -eq 'ACTIVE_LOCAL_EDGE') {
  $script:edgeDrainHelper = if ($EdgeDrainHelperPath) {
    [IO.Path]::GetFullPath($EdgeDrainHelperPath)
  } else {
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'edge-drain-identity.ps1'))
  }
  . (Import-PinnedHelperScriptBlock $script:edgeDrainHelper $ExpectedEdgeDrainHelperSha256 'ROLLBACK_FINALIZE_EDGE_DRAIN_HELPER_HASH_MISMATCH')
}

function Get-FileSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-StorageInventoryDigest([string]$Root) {
  $full = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  Assert-NoReparse $full
  if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw 'ROLLBACK_FINALIZE_STORAGE_ROOT_REQUIRED' }
  $prefix = $full + '\'
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($full)
  $files = [Collections.Generic.List[IO.FileInfo]]::new()
  [long]$total = 0
  [int]$directories = 0
  while ($pending.Count) {
    $directory = $pending.Pop()
    $directories += 1
    if ($directories -gt 1000000) { throw 'ROLLBACK_FINALIZE_STORAGE_INVENTORY_LIMIT' }
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes = [IO.File]::GetAttributes($entry)
      if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ROLLBACK_FINALIZE_STORAGE_REPARSE_REJECTED' }
      if ($attributes -band [IO.FileAttributes]::Directory) {
        $pending.Push($entry)
        continue
      }
      $file = [IO.FileInfo]::new($entry)
      $total += $file.Length
      if ($files.Count -ge 1000000 -or $total -gt 1099511627776 -or $file.Length -gt 536870912) { throw 'ROLLBACK_FINALIZE_STORAGE_INVENTORY_LIMIT' }
      $files.Add($file)
    }
  }
  $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
  $first = $true
  try {
    foreach ($file in @($files | Sort-Object FullName)) {
      $relative = $file.FullName.Substring($prefix.Length).Replace('\','/')
      $stream = [IO.FileStream]::new($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read,1048576,[IO.FileOptions]::SequentialScan)
      $fileHash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
      try {
        $buffer = New-Object byte[] 1048576
        [long]$bytes = 0
        while (($read = $stream.Read($buffer,0,$buffer.Length)) -gt 0) {
          $bytes += $read
          if ($bytes -gt 536870912) { throw 'ROLLBACK_FINALIZE_STORAGE_FILE_LIMIT' }
          $fileHash.AppendData($buffer,0,$read)
        }
        if ($bytes -ne $file.Length) { throw 'ROLLBACK_FINALIZE_STORAGE_FILE_CHANGED' }
        $digest = [BitConverter]::ToString($fileHash.GetHashAndReset()).Replace('-','').ToLowerInvariant()
      } finally {
        if ($buffer) { [Array]::Clear($buffer,0,$buffer.Length) }
        $fileHash.Dispose()
        $stream.Dispose()
      }
      $line = $(if ($first) { '' } else { "`n" }) + "$relative|$($file.Length)|$digest"
      $lineBytes = [Text.Encoding]::UTF8.GetBytes($line)
      try {
        $hash.AppendData($lineBytes)
        $first = $false
      } finally {
        [Array]::Clear($lineBytes,0,$lineBytes.Length)
      }
    }
    return [BitConverter]::ToString($hash.GetHashAndReset()).Replace('-','').ToLowerInvariant()
  } finally {
    $hash.Dispose()
  }
}

function Get-TextSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Assert-NoReparse([string]$Path) {
  $cursor = Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force
  while ($cursor) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ROLLBACK_FINALIZE_REPARSE_REJECTED' }
    $cursor = $cursor.Parent
  }
}

function Get-PinnedFile([string]$Path,[string]$Expected,[string]$Code,[long]$MaximumBytes = 1073741824) {
  if (-not $Path -or -not(Test-Path -LiteralPath $Path -PathType Leaf)) { throw $Code }
  $full = [IO.Path]::GetFullPath($Path)
  Assert-NoReparse $full
  $item = Get-Item -LiteralPath $full -Force
  if ($item.Length -lt 1 -or $item.Length -gt $MaximumBytes -or $Expected -notmatch '^[A-Fa-f0-9]{64}$' -or (Get-FileSha256 $full) -cne $Expected.ToLowerInvariant()) { throw $Code }
  return $full
}

function Read-BoundedJson([string]$Path,[string]$Code,[long]$MaximumBytes = $script:MaximumJsonBytes) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt $MaximumBytes -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw $Code }
  try { return Get-Content -Raw -LiteralPath $item.FullName | ConvertFrom-Json -Depth 64 } catch { throw $Code }
}

function Test-UnderClass([string]$Path,$Roots) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  return @($Roots | Where-Object {
    $root = [IO.Path]::GetFullPath([string]$_).TrimEnd('\')
    $full -ieq $root -or $full.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)
  }).Count -gt 0
}

function Quote-Identifier([string]$Value) {
  if ($Value -notmatch '^[a-z_][a-z0-9_]{0,62}$') { throw 'ROLLBACK_FINALIZE_IDENTIFIER_REJECTED' }
  return '"' + $Value + '"'
}

function Stop-ProcessTree($Process) {
  if (-not $Process) { return }
  try { Stop-VerifiedRecoveryProcessTree $Process 5000 } catch { throw 'ROLLBACK_FINALIZE_PROCESS_TREE_EXIT_UNCONFIRMED' }
}

function Invoke-Bounded([string]$Executable,[string[]]$Arguments,[hashtable]$Environment,[string]$Code) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Executable
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  foreach ($name in @('DATABASE_URL','PGPASSWORD','PGPASSFILE','PGSSLMODE','PGSSLROOTCERT','PGOPTIONS','PGCONNECT_TIMEOUT','PGAPPNAME')) { [void]$info.Environment.Remove($name) }
  foreach ($entry in $Environment.GetEnumerator()) { $info.Environment[$entry.Key] = [string]$entry.Value }
  foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
  $process = $null
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $stdout = [IO.MemoryStream]::new();$stderr = [IO.MemoryStream]::new();$outBuffer = New-Object byte[] 8192;$errBuffer = New-Object byte[] 8192
  $started=$false
  try {
    $process=Start-VerifiedRecoveryProcess $info;if (-not $process) { throw "$Code`_START_FAILED" };$started=$true
    $outTask=$process.StandardOutput.BaseStream.ReadAsync($outBuffer,0,$outBuffer.Length);$errTask=$process.StandardError.BaseStream.ReadAsync($errBuffer,0,$errBuffer.Length);$outDone=$false;$errDone=$false
    while (-not($process.HasExited -and $outDone -and $errDone)) {
      if ($watch.Elapsed.TotalMinutes -ge 5) { Stop-ProcessTree $process;throw "$Code`_TIMEOUT" }
      if(-not$outDone-and$outTask.IsCompleted){$count=$outTask.GetAwaiter().GetResult();if($count-eq0){$outDone=$true}else{if($stdout.Length+$stderr.Length+$count-gt1048576){Stop-ProcessTree $process;throw "$Code`_OUTPUT_LIMIT"};$stdout.Write($outBuffer,0,$count);$outTask=$process.StandardOutput.BaseStream.ReadAsync($outBuffer,0,$outBuffer.Length)}}
      if(-not$errDone-and$errTask.IsCompleted){$count=$errTask.GetAwaiter().GetResult();if($count-eq0){$errDone=$true}else{if($stdout.Length+$stderr.Length+$count-gt1048576){Stop-ProcessTree $process;throw "$Code`_OUTPUT_LIMIT"};$stderr.Write($errBuffer,0,$count);$errTask=$process.StandardError.BaseStream.ReadAsync($errBuffer,0,$errBuffer.Length)}}
      if(-not($process.HasExited-and$outDone-and$errDone)){[Threading.Thread]::Sleep(10)}
    }
    if ($process.ExitCode -ne 0) { throw $Code }
    return [Text.Encoding]::UTF8.GetString($stdout.ToArray()).Trim()
  } finally {
    if($started){Stop-ProcessTree $process}
    if($process){$process.Dispose()};$stdout.Dispose();$stderr.Dispose();[Array]::Clear($outBuffer,0,$outBuffer.Length);[Array]::Clear($errBuffer,0,$errBuffer.Length)
    $watch.Stop()
  }
}

function Get-SchemaFingerprintFunctionSql {
  return @'
CREATE OR REPLACE FUNCTION pg_temp.metaads_schema_fingerprint(p_schema text)
RETURNS text
LANGUAGE plpgsql
AS $metaads$
DECLARE
  v_catalog text;
  v_rows text;
  v_row_parts text := '';
  v_part text;
  v_relation record;
  v_relation_count integer := 0;
BEGIN
  IF to_regnamespace(p_schema) IS NULL THEN RAISE EXCEPTION 'SCHEMA_FINGERPRINT_SCHEMA_MISSING'; END IF;
  WITH items(v) AS (
    SELECT concat_ws('|','N',r.rolname,coalesce(n.nspacl::text,'')) FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname=p_schema
    UNION ALL SELECT concat_ws('|','C',c.oid::text,c.relname,c.relkind,r.rolname,coalesce(c.relacl::text,''),coalesce(c.reloptions::text,''),c.relrowsecurity::text,c.relforcerowsecurity::text) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname=p_schema
    UNION ALL SELECT concat_ws('|','A',c.oid::text,a.attnum::text,a.attname,a.atttypid::text,a.atttypmod::text,a.attnotnull::text,a.attidentity,a.attgenerated,replace(coalesce(pg_get_expr(d.adbin,d.adrelid),''),quote_ident(p_schema)||'.','<schema>.')) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname=p_schema AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT concat_ws('|','K',c.oid::text,k.conname,k.contype,replace(pg_get_constraintdef(k.oid,true),quote_ident(p_schema)||'.','<schema>.')) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=p_schema
    UNION ALL SELECT concat_ws('|','I',i.indexrelid::text,i.indrelid::text,replace(pg_get_indexdef(i.indexrelid),quote_ident(p_schema)||'.','<schema>.')) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=p_schema
    UNION ALL SELECT concat_ws('|','P',p.oid::text,p.proname,p.proargtypes::text,p.prorettype::text,r.rolname,p.prosecdef::text,p.proleakproof::text,coalesce(p.proacl::text,''),coalesce(p.proconfig::text,''),encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname=p_schema
    UNION ALL SELECT concat_ws('|','G',t.oid::text,t.tgname,t.tgenabled,replace(pg_get_triggerdef(t.oid,true),quote_ident(p_schema)||'.','<schema>.')) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=p_schema AND NOT t.tgisinternal
    UNION ALL SELECT concat_ws('|','T',t.oid::text,t.typname,t.typtype,r.rolname,coalesce(t.typacl::text,'')) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_roles r ON r.oid=t.typowner WHERE n.nspname=p_schema
    UNION ALL SELECT concat_ws('|','D',r.rolname,d.defaclobjtype,coalesce(d.defaclacl::text,'')) FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace JOIN pg_roles r ON r.oid=d.defaclrole WHERE n.nspname=p_schema
    UNION ALL SELECT concat_ws('|','Y',c.oid::text,p.polname,p.polcmd,p.polpermissive::text,coalesce(array_to_string(p.polroles::oid[],','),''),replace(coalesce(pg_get_expr(p.polqual,p.polrelid),''),quote_ident(p_schema)||'.','<schema>.'),replace(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''),quote_ident(p_schema)||'.','<schema>.')) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=p_schema
  )
  SELECT count(*)::text||'|'||encode(sha256(convert_to(coalesce(string_agg(v,E'\n' ORDER BY v COLLATE "C"),''),'UTF8')),'hex') INTO v_catalog FROM items;
  FOR v_relation IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=p_schema AND c.relkind IN ('r','p') ORDER BY c.relname COLLATE "C"
  LOOP
    EXECUTE format($rows$
      SELECT count(*)::text||'|'||encode(sha256(convert_to(coalesce(string_agg(row_digest,E'\n' ORDER BY row_digest COLLATE "C"),''),'UTF8')),'hex')
      FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS row_digest FROM ONLY %I.%I t) row_hashes
    $rows$,p_schema,v_relation.relname) INTO v_part;
    v_row_parts := v_row_parts || CASE WHEN v_relation_count=0 THEN '' ELSE E'\n' END || v_relation.relname || '|' || v_part;
    v_relation_count := v_relation_count + 1;
  END LOOP;
  v_rows := v_relation_count::text||'|'||encode(sha256(convert_to(v_row_parts,'UTF8')),'hex');
  RETURN encode(sha256(convert_to('live-schema-fingerprint-v3'||E'\n'||v_catalog||E'\n'||v_rows,'UTF8')),'hex');
END
$metaads$;
'@
}

function Get-LiveSchemaFingerprint([string]$Psql,[string[]]$Base,[hashtable]$Environment,[string]$SchemaName) {
  [void](Quote-Identifier $SchemaName)
  $sql = "BEGIN; $(Get-SchemaFingerprintFunctionSql) SELECT pg_temp.metaads_schema_fingerprint('$SchemaName'); ROLLBACK;"
  $fingerprint = Invoke-Bounded $Psql ($Base + @('--quiet',"--command=$sql")) $Environment 'ROLLBACK_FINALIZE_FULL_ROW_FINGERPRINT'
  if ($fingerprint -notmatch '^[0-9a-f]{64}$') { throw 'ROLLBACK_FINALIZE_SCHEMA_FINGERPRINT_INVALID' }
  return [pscustomobject]@{Fingerprint=$fingerprint;FullApplicationRowsCovered=$true;CatalogCovered=$true}
}

function Invoke-AtomicFinalization([string]$Psql,[string[]]$Base,[hashtable]$Environment,[string]$CurrentSchema,[string]$PreservedSchema,[string]$ExpectedCurrent,[string]$ExpectedPreserved,[string]$ExpectedSurvivor) {
  [void](Quote-Identifier $CurrentSchema);[void](Quote-Identifier $PreservedSchema)
  foreach($hash in @($ExpectedCurrent,$ExpectedPreserved,$ExpectedSurvivor)){if($hash-notmatch'^[0-9a-f]{64}$'){throw 'ROLLBACK_FINALIZE_TRANSACTION_FINGERPRINT_INVALID'}}
  $fingerprintFunction=Get-SchemaFingerprintFunctionSql
  $sql=@"
BEGIN;
$fingerprintFunction
DO `$metaads_finalize`$
DECLARE
  v_relation record;
  v_state text;
  v_current text;
  v_preserved text;
  v_survivor text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('meta-ads-production-schema-boundary-v1',0));
  FOR v_relation IN
    SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('$CurrentSchema','$PreservedSchema') AND c.relkind IN ('r','p')
    ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"
  LOOP
    EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',v_relation.nspname,v_relation.relname);
  END LOOP;
  SELECT (to_regnamespace('$CurrentSchema') IS NOT NULL)::int || '|' || (to_regnamespace('$PreservedSchema') IS NOT NULL)::int INTO v_state;
  IF v_state <> '1|1' THEN RAISE EXCEPTION 'FINALIZE_PRE_STATE_CHANGED'; END IF;
  v_current := pg_temp.metaads_schema_fingerprint('$CurrentSchema');
  v_preserved := pg_temp.metaads_schema_fingerprint('$PreservedSchema');
  IF v_current <> '$ExpectedCurrent' OR v_preserved <> '$ExpectedPreserved' THEN RAISE EXCEPTION 'FINALIZE_PRE_FINGERPRINT_CHANGED'; END IF;
  IF '$Mode' = 'RETURN_FORWARD' THEN
    EXECUTE format('DROP SCHEMA %I CASCADE','$CurrentSchema');
    EXECUTE format('ALTER SCHEMA %I RENAME TO %I','$PreservedSchema','$CurrentSchema');
  ELSE
    EXECUTE format('DROP SCHEMA %I CASCADE','$PreservedSchema');
  END IF;
  SELECT (to_regnamespace('$CurrentSchema') IS NOT NULL)::int || '|' || (to_regnamespace('$PreservedSchema') IS NOT NULL)::int INTO v_state;
  IF v_state <> '1|0' THEN RAISE EXCEPTION 'FINALIZE_POST_STATE_CHANGED'; END IF;
  v_survivor := pg_temp.metaads_schema_fingerprint('$CurrentSchema');
  IF v_survivor <> '$ExpectedSurvivor' THEN RAISE EXCEPTION 'FINALIZE_POST_FINGERPRINT_CHANGED'; END IF;
END
`$metaads_finalize`$;
SELECT (to_regnamespace('$CurrentSchema') IS NOT NULL)::int || '|' || (to_regnamespace('$PreservedSchema') IS NOT NULL)::int || '|' || pg_temp.metaads_schema_fingerprint('$CurrentSchema');
COMMIT;
"@
  $result=Invoke-Bounded $Psql ($Base+@('--quiet',"--command=$sql")) $Environment 'ROLLBACK_FINALIZE_ATOMIC_TRANSACTION_FAILED'
  if($result-cne"1|0|$ExpectedSurvivor"){throw 'ROLLBACK_FINALIZE_ATOMIC_TRANSACTION_RESULT_REJECTED'}
  return $result
}

function Write-DurableJson([string]$Path,$Value,[switch]$CreateOnly) {
  $full = [IO.Path]::GetFullPath($Path)
  $parent = Split-Path -Parent $full
  if (-not(Test-Path -LiteralPath $parent -PathType Container)) { throw 'ROLLBACK_FINALIZE_OUTPUT_PARENT_REQUIRED' }
  Assert-NoReparse $parent
  if ($CreateOnly -and (Test-Path -LiteralPath $full)) { throw 'ROLLBACK_FINALIZE_OUTPUT_ALREADY_EXISTS' }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 32 -Compress))
  if ($bytes.Length -gt 1048576) { throw 'ROLLBACK_FINALIZE_OUTPUT_LIMIT' }
  $pending = Join-Path $parent ('.rollback-finalize-' + [guid]::NewGuid().ToString('N') + '.pending')
  try {
    $stream = [IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($pending,$full,-not $CreateOnly)
    $committed = [IO.FileStream]::new($full,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough)
    try { $committed.Flush($true) } finally { $committed.Dispose() }
  } finally {
    [Array]::Clear($bytes,0,$bytes.Length)
    if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
  }
}

function Assert-MaintenanceState($Config,[string]$FlagPath) {
  $flag = Read-BoundedJson $FlagPath 'ROLLBACK_FINALIZE_MAINTENANCE_INVALID' 1048576
  try { $enabledAt = [datetimeoffset]::ParseExact([string]$flag.enabledAt,'o',[Globalization.CultureInfo]::InvariantCulture) } catch { throw 'ROLLBACK_FINALIZE_MAINTENANCE_INVALID' }
  $dataRoot = if ($Config.data.root) {
    [IO.Path]::GetFullPath([string]$Config.data.root)
  } else {
    $base = if ($env:ProgramData) { $env:ProgramData } else { $env:LOCALAPPDATA }
    if (-not $base) { throw 'ROLLBACK_FINALIZE_APPLICATION_DATA_ROOT_REQUIRED' }
    [IO.Path]::GetFullPath((Join-Path $base 'MetaAdsPerformance'))
  }
  $expectedFlag = [IO.Path]::GetFullPath((Join-Path $dataRoot 'runtime-control\maintenance.enabled'))
  if ([IO.Path]::GetFullPath($FlagPath) -ine $expectedFlag -or
      $flag.version -ne 1 -or $flag.enabled -ne $true -or
      $flag.releaseId -cne $Config.release.id -or
      $ExpectedMaintenanceApprovalIdDigest -notmatch '^[0-9a-fA-F]{64}$' -or
      $flag.approvalIdDigest -cne $ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant() -or
      $enabledAt -gt [datetimeoffset]::UtcNow.AddMinutes(5)) {
    throw 'ROLLBACK_FINALIZE_MAINTENANCE_SEMANTICS_REJECTED'
  }
  return [pscustomobject]@{ReleaseId=[string]$flag.releaseId;ApprovalIdDigest=[string]$flag.approvalIdDigest;EnabledAt=$enabledAt.ToUniversalTime().ToString('o')}
}

function Assert-LegacyQuiescence($Config,$RollbackEvidence,[string]$Node,[string]$Verifier) {
  $quiesce = Get-PinnedFile $LegacyQuiesceEvidencePath $ExpectedLegacyQuiesceEvidenceSha256 'ROLLBACK_FINALIZE_LEGACY_QUIESCE_HASH_MISMATCH' $script:MaximumJsonBytes
  $public = Get-PinnedFile $QuiesceReceiptPublicKeyPath $ExpectedQuiesceReceiptPublicKeySha256 'ROLLBACK_FINALIZE_QUIESCE_PUBLIC_KEY_HASH_MISMATCH' 1048576
  [void](Invoke-Bounded $Node @($Verifier,$public,$quiesce,'legacy-quiesce') @{} 'ROLLBACK_FINALIZE_QUIESCE_SIGNATURE_REJECTED')
  $value = Read-BoundedJson $quiesce 'ROLLBACK_FINALIZE_LEGACY_QUIESCE_INVALID'
  try { $completed = [datetimeoffset]::ParseExact([string]$value.completedAt,'o',[Globalization.CultureInfo]::InvariantCulture) } catch { throw 'ROLLBACK_FINALIZE_LEGACY_QUIESCE_INVALID' }
  $age = ([datetimeoffset]::UtcNow - $completed).TotalSeconds
  if ($value.attestationType -cne 'legacy-quiesce' -or $value.version -ne 2 -or $value.result -cne 'PASS' -or
      @($value.ports).Count -ne 2 -or (@($value.ports) -join '|') -cne '3100|4100' -or
      -not $value.legacyIdentityHealthSmokeVerifiedBeforeStop -or -not $value.processesStopped -or -not $value.listenersAbsent -or $value.databaseMutated -or
      $value.baselineSha256 -cne $RollbackEvidence.baselineSha256 -or
      $value.processIdentityDigest -cne $RollbackEvidence.legacyProcessIdentityDigest -or
      $value.restartCanonicalDigest -cne $RollbackEvidence.legacyRestartCanonicalDigest -or
      [int]$value.webProcessId -ne [int]$RollbackEvidence.legacyWebProcessId -or
      [int]$value.apiProcessId -ne [int]$RollbackEvidence.legacyApiProcessId -or
      $ExpectedLegacyQuiesceEvidenceSha256.ToLowerInvariant() -cne $RollbackEvidence.legacyQuiesceEvidenceSha256 -or
      $age -lt -300 -or $age -gt $script:MaximumLegacyQuiesceAgeSeconds) {
    throw 'ROLLBACK_FINALIZE_LEGACY_QUIESCE_SEMANTICS_REJECTED'
  }
  if (Get-Process -Id ([int]$value.webProcessId),([int]$value.apiProcessId) -ErrorAction SilentlyContinue) { throw 'ROLLBACK_FINALIZE_LEGACY_WRITER_PRESENT' }
  if (@(Get-NetTCPConnection -State Listen -LocalPort 3100,4100 -ErrorAction SilentlyContinue).Count) { throw 'ROLLBACK_FINALIZE_LEGACY_LISTENER_PRESENT' }
  if (@(Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue).Count) { throw 'ROLLBACK_FINALIZE_LEGACY_MODE_EDGE_LISTENER_PRESENT' }
  $service = Get-CimInstance Win32_Service -Filter "Name='$EdgeServiceName'" -ErrorAction SilentlyContinue
  if ($service -and ($service.State -cne 'Stopped' -or $service.StartMode -notin @('Manual','Disabled'))) { throw 'ROLLBACK_FINALIZE_LEGACY_MODE_EDGE_SERVICE_UNSAFE' }
  $serviceState = if ($service) { "$($service.State)|$($service.StartMode)" } else { 'ABSENT' }
  $identity = Get-TextSha256 (@('rollback-finalize-legacy-quiescence-v2',$ExpectedRuntimeConfigSha256.ToLowerInvariant(),$ExpectedLegacyQuiesceEvidenceSha256.ToLowerInvariant(),[string]$value.processIdentityDigest,[string]$value.restartCanonicalDigest,[string]$value.webProcessId,[string]$value.apiProcessId,$serviceState,'3100|4100|443-absent') -join "`n")
  return [pscustomobject]@{ProofType='SIGNED_LEGACY_QUIESCE_V2';IdentityDigest=$identity;EvidencePath=$quiesce;EvidenceSha256=$ExpectedLegacyQuiesceEvidenceSha256.ToLowerInvariant();PublicKeyPath=$public;PublicKeySha256=$ExpectedQuiesceReceiptPublicKeySha256.ToLowerInvariant();CompletedAt=$completed.ToUniversalTime().ToString('o');ActiveRequests=0;EdgeProcessId=0;EdgeProcessStartedAt=$null;ListenerAddress=$null;ListenerPort=0;ServiceState=$serviceState}
}

function Assert-CurrentQuiescence($Config,$RollbackEvidence,[string]$Runtime,[string]$Node,[string]$Verifier) {
  $releaseRoot = if ($EdgeReleaseRoot -and (Test-Path -LiteralPath $EdgeReleaseRoot -PathType Container)) { [IO.Path]::GetFullPath($EdgeReleaseRoot).TrimEnd('\') } else { throw 'ROLLBACK_FINALIZE_EDGE_RELEASE_ROOT_REQUIRED' }
  Assert-NoReparse $releaseRoot
  $manifestPath = Get-PinnedFile (Join-Path $releaseRoot 'release-manifest.json') $ExpectedEdgeReleaseManifestSha256 'ROLLBACK_FINALIZE_EDGE_RELEASE_MANIFEST_HASH_MISMATCH' $script:MaximumJsonBytes
  $manifest = Read-BoundedJson $manifestPath 'ROLLBACK_FINALIZE_EDGE_RELEASE_MANIFEST_INVALID'
  if ($manifest.version -ne 4 -or -not $manifest.runtimeSmokeVerified -or $manifest.releaseId -cne $Config.release.id -or$manifest.migrationDigest-cne$Config.release.migrationDigest-or$manifest.appliedMigrationDigest-cne$Config.release.appliedMigrationDigest-or
      $RollbackEvidence.edgeStateMode -cne $EdgeStateMode -or $RollbackEvidence.edgeReleaseId -cne $Config.release.id -or
      $RollbackEvidence.edgeReleaseManifestSha256 -cne $ExpectedEdgeReleaseManifestSha256.ToLowerInvariant()) {
    throw 'ROLLBACK_FINALIZE_EDGE_RELEASE_IDENTITY_REJECTED'
  }
  if ($EdgeStateMode -eq 'ACTIVE_LOCAL_EDGE') {
    $drain = Get-PinnedFile $DrainStatePath $ExpectedDrainStateSha256 'ROLLBACK_FINALIZE_DRAIN_HASH_MISMATCH' 1048576
    $public = Get-PinnedFile $EdgeSigningPublicKeyPath $ExpectedEdgeSigningPublicKeySha256 'ROLLBACK_FINALIZE_EDGE_PUBLIC_KEY_HASH_MISMATCH' 1048576
    $identity = Assert-ExactEdgeDrainIdentity -EdgeServiceName $EdgeServiceName -RuntimeConfigPath $Runtime -ExpectedRuntimeConfigSha256 $ExpectedRuntimeConfigSha256 -ReleaseRoot $releaseRoot -ExpectedReleaseManifestSha256 $ExpectedEdgeReleaseManifestSha256 -NodePath $Node -ExpectedNodeSha256 $ExpectedNodeSha256 -DrainStatePath $drain -ExpectedDrainStateSha256 $ExpectedDrainStateSha256 -AttestationVerifierPath $Verifier -ExpectedAttestationVerifierSha256 $ExpectedAttestationVerifierSha256 -EdgeSigningPublicKeyPath $public -ExpectedEdgeSigningPublicKeySha256 $ExpectedEdgeSigningPublicKeySha256 -MaximumAgeSeconds $script:MaximumEdgeDrainAgeSeconds
    if ($RollbackEvidence.quiescenceProofType -cne 'SIGNED_EDGE_DRAIN_V2' -or -not $RollbackEvidence.quiescenceVerified -or -not $RollbackEvidence.drainVerified -or $RollbackEvidence.legacyNoEdgeVerified -or [int]$identity.ActiveRequests -ne 0) { throw 'ROLLBACK_FINALIZE_ACTIVE_EDGE_BOUNDARY_REJECTED' }
    return [pscustomobject]@{ProofType='SIGNED_EDGE_DRAIN_V2';IdentityDigest=$identity.IdentityDigest;EvidencePath=$drain;EvidenceSha256=$ExpectedDrainStateSha256.ToLowerInvariant();PublicKeyPath=$public;PublicKeySha256=$ExpectedEdgeSigningPublicKeySha256.ToLowerInvariant();CompletedAt=$identity.DrainCompletedAt;ActiveRequests=0;EdgeProcessId=$identity.EdgeProcessId;EdgeProcessStartedAt=$identity.EdgeProcessStartedAt;ListenerAddress=$identity.ListenerAddress;ListenerPort=$identity.ListenerPort;ServiceState='RUNNING_DRAINED'}
  }
  if($EdgeStateMode-eq'STOPPED_LOCAL_EDGE'){
    if($RollbackEvidence.recoveryPurpose-cne'DAILY_BACKUP_RECOVERY'-or$RollbackEvidence.quiescenceProofType-cne'STOPPED_LOCAL_SERVICES_ABSENCE_V2'-or-not$RollbackEvidence.quiescenceVerified-or-not$RollbackEvidence.stoppedLocalEdgeVerified-or-not$RollbackEvidence.serviceRightsExact-or-not$RollbackEvidence.serviceAccountProcessesAbsent-or-not$RollbackEvidence.protectedListenersAbsent-or$RollbackEvidence.drainVerified-or$RollbackEvidence.legacyNoEdgeVerified){throw 'ROLLBACK_FINALIZE_STOPPED_EDGE_BOUNDARY_REJECTED'}
    $stoppedFsPath=Get-PinnedFile $FileSystemEvidencePath $ExpectedFileSystemEvidenceSha256 'ROLLBACK_FINALIZE_FILESYSTEM_HASH_MISMATCH' $script:MaximumJsonBytes;$stoppedFs=Read-BoundedJson $stoppedFsPath 'ROLLBACK_FINALIZE_FILESYSTEM_INVALID'
    $stopped=Assert-StoppedLocalRecoveryBoundary -CoreServiceName $CoreServiceName -EdgeServiceName $EdgeServiceName -ExpectedCoreSid ([string]$stoppedFs.coreServiceSid) -ExpectedEdgeSid ([string]$stoppedFs.edgeServiceSid) -WebPort ([int]$Config.internalPorts.web) -ApiPort ([int]$Config.internalPorts.api)
    $identity=Get-TextSha256 (@('stopped-local-recovery-boundary-v2',$ExpectedRuntimeConfigSha256.ToLowerInvariant(),$releaseRoot,$ExpectedEdgeReleaseManifestSha256.ToLowerInvariant(),[string]$Config.release.id,$Node,$ExpectedNodeSha256.ToLowerInvariant(),$stopped.IdentityDigest)-join"`n")
    if($identity-cne$RollbackEvidence.edgeIdentityDigest){throw 'ROLLBACK_FINALIZE_STOPPED_EDGE_IDENTITY_DRIFT'}
    return [pscustomobject]@{ProofType='STOPPED_LOCAL_SERVICES_ABSENCE_V2';IdentityDigest=$identity;EvidencePath=$null;EvidenceSha256=$null;PublicKeyPath=$null;PublicKeySha256=$null;CompletedAt=$null;ActiveRequests=0;EdgeProcessId=0;EdgeProcessStartedAt=$null;ListenerAddress=$null;ListenerPort=0;ServiceState=$stopped.EdgeServiceState;CoreServiceState=$stopped.CoreServiceState;CoreServiceSid=$stopped.CoreServiceSid;EdgeServiceSid=$stopped.EdgeServiceSid;ServiceRightsExact=$true;ServiceAccountProcessesAbsent=$true;ProtectedListenersAbsent=$true}
  }
  if ($RollbackEvidence.quiescenceProofType -cne 'SIGNED_LEGACY_QUIESCE_V2' -or -not $RollbackEvidence.quiescenceVerified -or -not $RollbackEvidence.legacyNoEdgeVerified -or $RollbackEvidence.drainVerified) { throw 'ROLLBACK_FINALIZE_LEGACY_EDGE_BOUNDARY_REJECTED' }
  return Assert-LegacyQuiescence $Config $RollbackEvidence $Node $Verifier
}

function Get-BoundaryContext([string]$ExistingFinalizationHash) {
  $runtime = Get-PinnedFile $RuntimeConfigPath $ExpectedRuntimeConfigSha256 'ROLLBACK_FINALIZE_RUNTIME_HASH_MISMATCH' $script:MaximumJsonBytes
  $rollbackJournal = Get-PinnedFile $RollbackJournalPath $ExpectedRollbackJournalSha256 'ROLLBACK_FINALIZE_JOURNAL_HASH_MISMATCH' $script:MaximumJsonBytes
  $rollbackEvidencePath = Get-PinnedFile $RollbackEvidencePath $ExpectedRollbackEvidenceSha256 'ROLLBACK_FINALIZE_EVIDENCE_HASH_MISMATCH' $script:MaximumJsonBytes
  $restorePublic = Get-PinnedFile $RestoreReceiptPublicKeyPath $ExpectedRestoreReceiptPublicKeySha256 'ROLLBACK_FINALIZE_PUBLIC_KEY_HASH_MISMATCH' 1048576
  $node = Get-PinnedFile $NodePath $ExpectedNodeSha256 'ROLLBACK_FINALIZE_NODE_HASH_MISMATCH'
  $verifier = Get-PinnedFile $AttestationVerifierPath $ExpectedAttestationVerifierSha256 'ROLLBACK_FINALIZE_VERIFIER_HASH_MISMATCH' $script:MaximumJsonBytes
  $processTreeHelper = Get-PinnedFile $script:recoveryProcessTreeHelper $ExpectedRecoveryProcessTreeHelperSha256 'ROLLBACK_FINALIZE_PROCESS_TREE_HELPER_HASH_MISMATCH' $script:MaximumJsonBytes
  $recoverySecurityHelper = Get-PinnedFile $script:localRecoverySecurityHelper $ExpectedLocalRecoverySecurityHelperSha256 'ROLLBACK_FINALIZE_LOCAL_RECOVERY_SECURITY_HELPER_HASH_MISMATCH' $script:MaximumJsonBytes
  $psql = Get-PinnedFile $PsqlPath $ExpectedPsqlSha256 'ROLLBACK_FINALIZE_PSQL_HASH_MISMATCH'
  $pgpass = Get-PinnedFile $PgPassFile $ExpectedPgPassSha256 'ROLLBACK_FINALIZE_PGPASS_HASH_MISMATCH' 1048576
  $ca = Get-PinnedFile $CaCertificatePath $ExpectedCaCertificateSha256 'ROLLBACK_FINALIZE_CA_HASH_MISMATCH' 1048576
  $filesystemPath = Get-PinnedFile $FileSystemEvidencePath $ExpectedFileSystemEvidenceSha256 'ROLLBACK_FINALIZE_FILESYSTEM_HASH_MISMATCH' $script:MaximumJsonBytes
  $maintenancePath = Get-PinnedFile $MaintenanceFlagPath $ExpectedMaintenanceFlagSha256 'ROLLBACK_FINALIZE_MAINTENANCE_HASH_MISMATCH' 1048576
  $config = Read-BoundedJson $runtime 'ROLLBACK_FINALIZE_RUNTIME_INVALID'
  $journal = Read-BoundedJson $rollbackJournal 'ROLLBACK_FINALIZE_JOURNAL_INVALID'
  $rollbackEvidence = Read-BoundedJson $rollbackEvidencePath 'ROLLBACK_FINALIZE_EVIDENCE_INVALID'
  $filesystem = Read-BoundedJson $filesystemPath 'ROLLBACK_FINALIZE_FILESYSTEM_INVALID'
  [void](Invoke-Bounded $node @($verifier,$restorePublic,$rollbackEvidencePath,'database-rollback') @{} 'ROLLBACK_FINALIZE_SIGNATURE_REJECTED')
  $preserved = [string]$journal.preservedSchema
  $recoveryPurpose=if([string]$rollbackEvidence.recoveryPurpose){[string]$rollbackEvidence.recoveryPurpose}else{'MIGRATION_ROLLBACK'};$journalPurpose=if([string]$journal.recoveryPurpose){[string]$journal.recoveryPurpose}else{'MIGRATION_ROLLBACK'}
  if($recoveryPurpose-cne'MIGRATION_ROLLBACK'-and$recoveryPurpose-cne'DAILY_BACKUP_RECOVERY'){throw 'ROLLBACK_FINALIZE_RECOVERY_PURPOSE_REJECTED'}
  if($recoveryPurpose-eq'DAILY_BACKUP_RECOVERY'-and$Mode-cne'ACCEPT_ROLLBACK_DROP_PRESERVED'){throw 'ROLLBACK_FINALIZE_DAILY_RETURN_REQUIRES_RECOVER_ACTION'}
  $expectedLocalEdgeMode=if($recoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){'STOPPED_LOCAL_EDGE'}else{'ACTIVE_LOCAL_EDGE'}
  $localReleaseEvidenceInvalid=$rollbackEvidence.previousReleaseKind-ceq'LOCAL_RELEASE'-and($rollbackEvidence.edgeStateMode-cne$expectedLocalEdgeMode-or$rollbackEvidence.releaseId-cne$config.release.id-or$rollbackEvidence.releaseManifestSha256-cne$ExpectedEdgeReleaseManifestSha256.ToLowerInvariant()-or$rollbackEvidence.migrationDigest-cne$config.release.migrationDigest-or$rollbackEvidence.appliedMigrationDigest-cne$config.release.appliedMigrationDigest-or$rollbackEvidence.baselineSha256-or$rollbackEvidence.legacyQuiesceEvidenceSha256)
  $legacyEvidenceInvalid=$rollbackEvidence.previousReleaseKind-ceq'LEGACY_BASELINE'-and($rollbackEvidence.baselineSha256-notmatch'^[0-9a-f]{64}$'-or$rollbackEvidence.migrationDigest-notmatch'^[0-9a-f]{64}$')
  if ($journal.version -ne 4 -or$journalPurpose-cne$recoveryPurpose-or $journal.previousReleaseKind-cne$rollbackEvidence.previousReleaseKind-or$journal.state -cne 'COMPLETE_MAINTENANCE_REQUIRED' -or -not $journal.originalSchemaPreserved -or $journal.partialTargetPossible -or
      $journal.edgeStateMode -cne $EdgeStateMode -or $journal.quiescenceProofType -cne $rollbackEvidence.quiescenceProofType -or
      $journal.legacyQuiesceEvidenceSha256 -cne $rollbackEvidence.legacyQuiesceEvidenceSha256 -or
      $rollbackEvidence.attestationType -cne 'database-rollback' -or $rollbackEvidence.version -ne 4 -or $rollbackEvidence.previousReleaseKind-notin@('LEGACY_BASELINE','LOCAL_RELEASE')-or$localReleaseEvidenceInvalid-or$legacyEvidenceInvalid-or$rollbackEvidence.result -cne 'PASS' -or
      -not $rollbackEvidence.productionDatabaseRestored -or -not $rollbackEvidence.preRollbackSchemaPreserved -or
      -not $rollbackEvidence.maintenanceVerified -or -not $rollbackEvidence.maintenanceMustRemainEnabled -or -not $rollbackEvidence.legacyWritersQuiesced -or
      $rollbackEvidence.preservedSchema -cne $preserved -or
      $rollbackEvidence.databaseProjectRef -cne $ConfirmProjectRef -or $rollbackEvidence.databaseHost -cne $ConfirmDatabaseHost -or
      $rollbackEvidence.databaseName -cne $ConfirmDatabaseName -or $rollbackEvidence.databaseSchema -cne $ConfirmDatabaseSchema -or
      $preserved -notmatch '^__metaads_pre_[0-9a-f]{16}$') {
    throw 'ROLLBACK_FINALIZE_BOUNDARY_EVIDENCE_REJECTED'
  }
  if ($config.database.provider -cne 'supabase_postgres' -or $config.database.projectRef -cne $ConfirmProjectRef -or
      $config.database.host -cne $ConfirmDatabaseHost -or $config.database.name -cne $ConfirmDatabaseName -or
      $config.database.schema -cne $ConfirmDatabaseSchema -or $config.database.migrationUser -cne $ConfirmDatabaseUser -or
      $config.database.port -ne 5432 -or $config.database.caCertificateSha256 -cne $ExpectedCaCertificateSha256.ToLowerInvariant() -or
      [IO.Path]::GetFullPath([string]$config.database.caCertificatePath) -ine $ca) {
    throw 'ROLLBACK_FINALIZE_CONFIG_CONFIRMATION_MISMATCH'
  }
  $maintenance = Assert-MaintenanceState $config $maintenancePath
  $quiescence = Assert-CurrentQuiescence $config $rollbackEvidence $runtime $node $verifier
  $shared = @($runtime,$node,$verifier,$processTreeHelper,$recoverySecurityHelper,$restorePublic,$psql,$ca,$EdgeReleaseRoot)
  if ($EdgeStateMode -eq 'ACTIVE_LOCAL_EDGE') { $shared += @($script:edgeDrainHelper,$EdgeSigningPublicKeyPath) } elseif($EdgeStateMode-eq'LEGACY_QUIESCED_NO_EDGE') { $shared += @($QuiesceReceiptPublicKeyPath) }
  if ($filesystem.result -cne 'PASS' -or -not $filesystem.exactAcl -or $filesystem.filesystem -cne 'NTFS' -or -not $filesystem.nonReparse -or
      @($shared | Where-Object { -not(Test-UnderClass $_ $filesystem.classRoots.SHARED_RUNTIME) }).Count -or
      -not(Test-UnderClass $pgpass $filesystem.classRoots.ADMIN_ONLY) -or
      -not(Test-UnderClass $maintenancePath $filesystem.classRoots.EDGE_READ) -or
      -not(Test-UnderClass $filesystemPath $filesystem.classRoots.ADMIN_EVIDENCE) -or
      -not(Test-UnderClass $rollbackJournal $filesystem.classRoots.ADMIN_EVIDENCE) -or
      -not(Test-UnderClass $rollbackEvidencePath $filesystem.classRoots.ADMIN_EVIDENCE) -or
      -not(Test-UnderClass $FinalizationJournalPath $filesystem.classRoots.ADMIN_EVIDENCE) -or
      ($EdgeStateMode -eq 'ACTIVE_LOCAL_EDGE' -and -not(Test-UnderClass $DrainStatePath $filesystem.classRoots.EDGE_READ)) -or
      ($EdgeStateMode -eq 'LEGACY_QUIESCED_NO_EDGE' -and -not(Test-UnderClass $LegacyQuiesceEvidencePath $filesystem.classRoots.ADMIN_EVIDENCE))) {
    throw 'ROLLBACK_FINALIZE_FILESYSTEM_BOUNDARY_REJECTED'
  }
  $recoveryWorkspaceRoot=$null;$liveStorageRoot=$null;$preservedStorageRoot=$null;$liveStorageDigest=$null;$preservedStorageDigest=$null
  if($recoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){
    $dataRoot=[IO.Path]::GetFullPath([string]$config.data.root).TrimEnd('\');$recoveryWorkspaceRoot=[IO.Path]::GetFullPath($RecoveryWorkspaceRoot).TrimEnd('\');$liveStorageRoot=[IO.Path]::GetFullPath([string]$rollbackEvidence.liveStorageRoot);$preservedStorageRoot=[IO.Path]::GetFullPath([string]$rollbackEvidence.preservedStorageRoot)
    if($rollbackEvidence.recoveryWorkspaceRoot-ine$recoveryWorkspaceRoot-or$journal.recoveryWorkspaceRoot-ine$recoveryWorkspaceRoot-or$rollbackEvidence.localRecoverySecurityHelperPath-ine$recoverySecurityHelper-or$journal.localRecoverySecurityHelperPath-ine$recoverySecurityHelper-or$rollbackEvidence.localRecoverySecurityHelperSha256-cne$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()-or$journal.localRecoverySecurityHelperSha256-cne$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()-or$liveStorageRoot-ine(Join-Path $dataRoot 'storage')-or(Split-Path -Parent $preservedStorageRoot)-ine$recoveryWorkspaceRoot-or(Split-Path -Leaf $preservedStorageRoot)-notmatch'^storage-preserved-[0-9a-f]{16}$'-or$journal.liveStorageRoot-ine$liveStorageRoot-or$journal.preservedStorageRoot-ine$preservedStorageRoot-or-not$rollbackEvidence.productionStorageRestored-or-not$rollbackEvidence.preservedOriginalStorage-or-not$journal.productionStorageRestored-or-not$journal.preservedOriginalStorage-or-not(Test-UnderClass $liveStorageRoot $filesystem.classRoots.CORE_MODIFY)-or-not(Test-UnderClass $recoveryWorkspaceRoot $filesystem.classRoots.ADMIN_ONLY)-or-not(Test-UnderClass $preservedStorageRoot $filesystem.classRoots.ADMIN_ONLY)){throw 'ROLLBACK_FINALIZE_DAILY_STORAGE_BOUNDARY_REJECTED'}
    Assert-LocalRecoveryExactAcl $liveStorageRoot 'CORE_MODIFY' $filesystem|Out-Null;Assert-LocalRecoveryExactAcl $recoveryWorkspaceRoot 'ADMIN_ONLY' $filesystem|Out-Null;Assert-LocalRecoveryExactAcl $preservedStorageRoot 'ADMIN_ONLY' $filesystem|Out-Null
    $liveStorageDigest=Get-StorageInventoryDigest $liveStorageRoot;$preservedStorageDigest=Get-StorageInventoryDigest $preservedStorageRoot
    if($liveStorageDigest-cne$rollbackEvidence.storageInventoryDigest-or$preservedStorageDigest-cne$rollbackEvidence.originalStorageInventoryDigest-or$journal.storageInventoryDigest-cne$liveStorageDigest-or$journal.originalStorageInventoryDigest-cne$preservedStorageDigest){throw 'ROLLBACK_FINALIZE_DAILY_STORAGE_DRIFT'}
  }
  $connectionUser = if ($config.database.connectionMode -eq 'session_pooler') { "$ConfirmDatabaseUser.$ConfirmProjectRef" } else { $ConfirmDatabaseUser }
  $dbEnvironment = @{PGPASSFILE=$pgpass;PGSSLMODE='verify-full';PGSSLROOTCERT=$ca;PGCONNECT_TIMEOUT='15';PGOPTIONS='-c statement_timeout=240000 -c lock_timeout=30000 -c idle_in_transaction_session_timeout=60000';PGAPPNAME='meta-ads-rollback-finalize-fingerprint'}
  $dbBase = @("--host=$ConfirmDatabaseHost",'--port=5432',"--username=$connectionUser","--dbname=$ConfirmDatabaseName",'--no-password','--tuples-only','--no-align','--set=ON_ERROR_STOP=1')
  $schemaStateSql = "SELECT (to_regnamespace('$ConfirmDatabaseSchema') IS NOT NULL)::int || '|' || (to_regnamespace('$preserved') IS NOT NULL)::int"
  $schemaState = Invoke-Bounded $psql ($dbBase + @("--command=$schemaStateSql")) $dbEnvironment 'ROLLBACK_FINALIZE_CONTEXT_SCHEMA_STATE'
  $existingRecord = $null
  if ($ExistingFinalizationHash) {
    $existingPath = Get-PinnedFile $FinalizationJournalPath $ExistingFinalizationHash 'ROLLBACK_FINALIZE_EXISTING_OUTPUT_HASH_REQUIRED' 1048576
    $existingRecord = Read-BoundedJson $existingPath 'ROLLBACK_FINALIZE_EXISTING_OUTPUT_INVALID' 1048576
  }
  if ($schemaState -ceq '1|1') {
    $currentFingerprint = Get-LiveSchemaFingerprint $psql $dbBase $dbEnvironment $ConfirmDatabaseSchema
    $preservedFingerprint = Get-LiveSchemaFingerprint $psql $dbBase $dbEnvironment $preserved
    if ($existingRecord -and ([string]$existingRecord.initialCurrentSchemaFingerprint -cne $currentFingerprint.Fingerprint -or [string]$existingRecord.initialPreservedSchemaFingerprint -cne $preservedFingerprint.Fingerprint)) { throw 'ROLLBACK_FINALIZE_EXISTING_FINGERPRINT_DRIFT' }
  } elseif ($schemaState -ceq '1|0') {
    if (-not $existingRecord -or $existingRecord.state -notin @('INTENT','FAILED_MAINTENANCE_REQUIRED','COMPLETE_MAINTENANCE_REQUIRED')) { throw 'ROLLBACK_FINALIZE_COMPLETED_STATE_WITHOUT_INTENT' }
    $liveSurvivor = Get-LiveSchemaFingerprint $psql $dbBase $dbEnvironment $ConfirmDatabaseSchema
    $expectedSurvivor = [string]$existingRecord.expectedSurvivorSchemaFingerprint
    if ($expectedSurvivor -notmatch '^[0-9a-f]{64}$' -or $liveSurvivor.Fingerprint -cne $expectedSurvivor) { throw 'ROLLBACK_FINALIZE_SURVIVOR_FINGERPRINT_DRIFT' }
    $currentFingerprint = if ($Mode -eq 'RETURN_FORWARD') { $null } else { $liveSurvivor }
    $preservedFingerprint = if ($Mode -eq 'RETURN_FORWARD') { $liveSurvivor } else { $null }
  } else {
    throw 'ROLLBACK_FINALIZE_CONTEXT_SCHEMA_STATE_REJECTED'
  }
  $initialCurrentSchemaFingerprint = if ($schemaState -ceq '1|1') { $currentFingerprint.Fingerprint } else { [string]$existingRecord.initialCurrentSchemaFingerprint }
  $initialPreservedSchemaFingerprint = if ($schemaState -ceq '1|1') { $preservedFingerprint.Fingerprint } else { [string]$existingRecord.initialPreservedSchemaFingerprint }
  $expectedSurvivorSchemaFingerprint = if ($Mode -eq 'RETURN_FORWARD') { $initialPreservedSchemaFingerprint } else { $initialCurrentSchemaFingerprint }
  if ($initialCurrentSchemaFingerprint -notmatch '^[0-9a-f]{64}$' -or $initialPreservedSchemaFingerprint -notmatch '^[0-9a-f]{64}$' -or ($existingRecord -and [string]$existingRecord.expectedSurvivorSchemaFingerprint -cne $expectedSurvivorSchemaFingerprint)) { throw 'ROLLBACK_FINALIZE_SCHEMA_FINGERPRINT_BINDING_REJECTED' }
  $operationFingerprint = Get-TextSha256 (@(
    'rollback-finalization-operation-v4',$Mode,$recoveryPurpose,$rollbackEvidence.previousReleaseKind,$ExpectedRuntimeConfigSha256.ToLowerInvariant(),
    $ExpectedRollbackJournalSha256.ToLowerInvariant(),$ExpectedRollbackEvidenceSha256.ToLowerInvariant(),
    $ExpectedRestoreReceiptPublicKeySha256.ToLowerInvariant(),$ExpectedNodeSha256.ToLowerInvariant(),
    $ExpectedAttestationVerifierSha256.ToLowerInvariant(),$ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant(),$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant(),$ExpectedPsqlSha256.ToLowerInvariant(),
    $ExpectedPgPassSha256.ToLowerInvariant(),$ExpectedCaCertificateSha256.ToLowerInvariant(),
    $ExpectedFileSystemEvidenceSha256.ToLowerInvariant(),$ExpectedMaintenanceFlagSha256.ToLowerInvariant(),
    $ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant(),$EdgeStateMode,[IO.Path]::GetFullPath($EdgeReleaseRoot),
    $ExpectedEdgeReleaseManifestSha256.ToLowerInvariant(),$ConfirmProjectRef,$ConfirmDatabaseHost,$ConfirmDatabaseName,
    $ConfirmDatabaseSchema,$ConfirmDatabaseUser,$preserved,$initialCurrentSchemaFingerprint,$initialPreservedSchemaFingerprint,$expectedSurvivorSchemaFingerprint,$recoveryWorkspaceRoot,$liveStorageRoot,$liveStorageDigest,$preservedStorageRoot,$preservedStorageDigest,[IO.Path]::GetFullPath($FinalizationJournalPath)
  ) -join "`n")
  return [pscustomobject]@{Runtime=$runtime;Config=$config;RecoveryPurpose=$recoveryPurpose;PreviousReleaseKind=[string]$rollbackEvidence.previousReleaseKind;RollbackJournal=$rollbackJournal;RollbackEvidencePath=$rollbackEvidencePath;RollbackEvidence=$rollbackEvidence;RestorePublic=$restorePublic;Node=$node;Verifier=$verifier;ProcessTreeHelper=$processTreeHelper;RecoverySecurityHelper=$recoverySecurityHelper;Psql=$psql;PgPass=$pgpass;Ca=$ca;FileSystemPath=$filesystemPath;FileSystem=$filesystem;MaintenancePath=$maintenancePath;Maintenance=$maintenance;Quiescence=$quiescence;PreservedSchema=$preserved;RecoveryWorkspaceRoot=$recoveryWorkspaceRoot;LiveStorageRoot=$liveStorageRoot;LiveStorageDigest=$liveStorageDigest;PreservedStorageRoot=$preservedStorageRoot;PreservedStorageDigest=$preservedStorageDigest;OperationFingerprint=$operationFingerprint;SchemaState=$schemaState;InitialCurrentSchemaFingerprint=$initialCurrentSchemaFingerprint;InitialPreservedSchemaFingerprint=$initialPreservedSchemaFingerprint;ExpectedSurvivorSchemaFingerprint=$expectedSurvivorSchemaFingerprint;CurrentSchemaFingerprint=$currentFingerprint;PreservedSchemaFingerprint=$preservedFingerprint}
}

function Get-ExistingFinalizationHash([string]$IntendedAction) {
  if ($IntendedAction -eq 'VerifyEvidence') {
    [void](Get-PinnedFile $FinalizationJournalPath $ExpectedFinalizationJournalSha256 'ROLLBACK_FINALIZE_OUTPUT_HASH_MISMATCH' 1048576)
    return $ExpectedFinalizationJournalSha256.ToLowerInvariant()
  }
  if (Test-Path -LiteralPath $FinalizationJournalPath -PathType Leaf) {
    [void](Get-PinnedFile $FinalizationJournalPath $ExpectedFinalizationJournalSha256 'ROLLBACK_FINALIZE_EXISTING_OUTPUT_HASH_REQUIRED' 1048576)
    return $ExpectedFinalizationJournalSha256.ToLowerInvariant()
  }
  if ($ExpectedFinalizationJournalSha256) { throw 'ROLLBACK_FINALIZE_UNEXPECTED_OUTPUT_HASH' }
  return $null
}

function New-FinalizePlan([string]$IntendedAction) {
  if ($IntendedAction -notin @('Apply','VerifyEvidence')) { throw 'ROLLBACK_FINALIZE_PLANNED_ACTION_REQUIRED' }
  if (-not $Mode) { throw 'ROLLBACK_FINALIZE_MODE_REQUIRED' }
  $existingFinalizationHash = Get-ExistingFinalizationHash $IntendedAction
  $context = Get-BoundaryContext $existingFinalizationHash
  $parameters = [ordered]@{
    mode=$Mode;recoveryPurpose=$context.RecoveryPurpose;previousReleaseKind=$context.PreviousReleaseKind;provider='supabase_postgres';projectRef=Get-ApprovalText $ConfirmProjectRef '^[a-z]{20}$' 'ROLLBACK_FINALIZE_PROJECT_REQUIRED';databaseHost=Get-ApprovalText $ConfirmDatabaseHost '^(?:db\.[a-z]{20}\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$' 'ROLLBACK_FINALIZE_HOST_REQUIRED';databasePort=5432;databaseName=Get-ApprovalText $ConfirmDatabaseName '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_FINALIZE_DATABASE_REQUIRED';databaseSchema=Get-ApprovalText $ConfirmDatabaseSchema '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_FINALIZE_SCHEMA_REQUIRED';databaseUser=Get-ApprovalText $ConfirmDatabaseUser '^[a-z][a-z0-9_]{0,62}$' 'ROLLBACK_FINALIZE_USER_REQUIRED';preservedSchema=$context.PreservedSchema
    runtimeConfigPath=Get-ApprovalPath $RuntimeConfigPath 'ROLLBACK_FINALIZE_RUNTIME_REQUIRED';runtimeConfigSha256=Get-ApprovalHash $ExpectedRuntimeConfigSha256 'ROLLBACK_FINALIZE_RUNTIME_HASH_REQUIRED';rollbackJournalPath=Get-ApprovalPath $RollbackJournalPath 'ROLLBACK_FINALIZE_JOURNAL_REQUIRED';rollbackJournalSha256=Get-ApprovalHash $ExpectedRollbackJournalSha256 'ROLLBACK_FINALIZE_JOURNAL_HASH_REQUIRED';rollbackEvidencePath=Get-ApprovalPath $RollbackEvidencePath 'ROLLBACK_FINALIZE_EVIDENCE_REQUIRED';rollbackEvidenceSha256=Get-ApprovalHash $ExpectedRollbackEvidenceSha256 'ROLLBACK_FINALIZE_EVIDENCE_HASH_REQUIRED';restoreReceiptPublicKeyPath=Get-ApprovalPath $RestoreReceiptPublicKeyPath 'ROLLBACK_FINALIZE_PUBLIC_KEY_REQUIRED';restoreReceiptPublicKeySha256=Get-ApprovalHash $ExpectedRestoreReceiptPublicKeySha256 'ROLLBACK_FINALIZE_PUBLIC_KEY_HASH_REQUIRED'
    nodePath=Get-ApprovalPath $NodePath 'ROLLBACK_FINALIZE_NODE_REQUIRED';nodeSha256=Get-ApprovalHash $ExpectedNodeSha256 'ROLLBACK_FINALIZE_NODE_HASH_REQUIRED';attestationVerifierPath=Get-ApprovalPath $AttestationVerifierPath 'ROLLBACK_FINALIZE_VERIFIER_REQUIRED';attestationVerifierSha256=Get-ApprovalHash $ExpectedAttestationVerifierSha256 'ROLLBACK_FINALIZE_VERIFIER_HASH_REQUIRED';recoveryProcessTreeHelperPath=Get-ApprovalPath $script:recoveryProcessTreeHelper 'ROLLBACK_FINALIZE_PROCESS_TREE_HELPER_REQUIRED';recoveryProcessTreeHelperSha256=Get-ApprovalHash $ExpectedRecoveryProcessTreeHelperSha256 'ROLLBACK_FINALIZE_PROCESS_TREE_HELPER_HASH_REQUIRED';localRecoverySecurityHelperPath=Get-ApprovalPath $script:localRecoverySecurityHelper 'ROLLBACK_FINALIZE_LOCAL_RECOVERY_SECURITY_HELPER_REQUIRED';localRecoverySecurityHelperSha256=Get-ApprovalHash $ExpectedLocalRecoverySecurityHelperSha256 'ROLLBACK_FINALIZE_LOCAL_RECOVERY_SECURITY_HELPER_HASH_REQUIRED';psqlPath=Get-ApprovalPath $PsqlPath 'ROLLBACK_FINALIZE_PSQL_REQUIRED';psqlSha256=Get-ApprovalHash $ExpectedPsqlSha256 'ROLLBACK_FINALIZE_PSQL_HASH_REQUIRED';pgPassPath=Get-ApprovalPath $PgPassFile 'ROLLBACK_FINALIZE_PGPASS_REQUIRED';pgPassSha256=Get-ApprovalHash $ExpectedPgPassSha256 'ROLLBACK_FINALIZE_PGPASS_HASH_REQUIRED';caCertificatePath=Get-ApprovalPath $CaCertificatePath 'ROLLBACK_FINALIZE_CA_REQUIRED';caCertificateSha256=Get-ApprovalHash $ExpectedCaCertificateSha256 'ROLLBACK_FINALIZE_CA_HASH_REQUIRED'
    filesystemEvidencePath=Get-ApprovalPath $FileSystemEvidencePath 'ROLLBACK_FINALIZE_FILESYSTEM_REQUIRED';filesystemEvidenceSha256=Get-ApprovalHash $ExpectedFileSystemEvidenceSha256 'ROLLBACK_FINALIZE_FILESYSTEM_HASH_REQUIRED';filesystemRequired='NTFS_EXACT_ACL';maintenanceFlagPath=Get-ApprovalPath $MaintenanceFlagPath 'ROLLBACK_FINALIZE_MAINTENANCE_REQUIRED';maintenanceFlagSha256=Get-ApprovalHash $ExpectedMaintenanceFlagSha256 'ROLLBACK_FINALIZE_MAINTENANCE_HASH_REQUIRED';maintenanceApprovalIdDigest=Get-ApprovalHash $ExpectedMaintenanceApprovalIdDigest 'ROLLBACK_FINALIZE_MAINTENANCE_APPROVAL_REQUIRED';maintenanceReleaseId=$context.Maintenance.ReleaseId
    edgeStateMode=$EdgeStateMode;coreServiceName=$CoreServiceName;edgeServiceName=$EdgeServiceName;edgeReleaseRoot=Get-ApprovalPath $EdgeReleaseRoot 'ROLLBACK_FINALIZE_EDGE_RELEASE_ROOT_REQUIRED';edgeReleaseManifestSha256=Get-ApprovalHash $ExpectedEdgeReleaseManifestSha256 'ROLLBACK_FINALIZE_EDGE_RELEASE_HASH_REQUIRED';quiescenceProofType=$context.Quiescence.ProofType;quiescenceIdentityDigest=$context.Quiescence.IdentityDigest;quiescenceCompletedAt=$context.Quiescence.CompletedAt;activeRequests=0;edgeProcessId=$context.Quiescence.EdgeProcessId;edgeProcessStartedAt=$context.Quiescence.EdgeProcessStartedAt;edgeListenerAddress=$context.Quiescence.ListenerAddress;edgeListenerPort=$context.Quiescence.ListenerPort;edgeServiceState=$context.Quiescence.ServiceState;coreServiceState=$context.Quiescence.CoreServiceState;coreServiceSid=$context.Quiescence.CoreServiceSid;edgeServiceSid=$context.Quiescence.EdgeServiceSid;serviceRightsExact=$context.Quiescence.ServiceRightsExact;serviceAccountProcessesAbsent=$context.Quiescence.ServiceAccountProcessesAbsent;protectedListenersAbsent=$context.Quiescence.ProtectedListenersAbsent
    finalizationJournalPath=Get-ApprovalPath $FinalizationJournalPath 'ROLLBACK_FINALIZE_OUTPUT_REQUIRED';existingFinalizationJournalSha256=$existingFinalizationHash;operationFingerprint=$context.OperationFingerprint;initialSchemaState=$context.SchemaState;initialCurrentSchemaFingerprint=$context.InitialCurrentSchemaFingerprint;initialPreservedSchemaFingerprint=$context.InitialPreservedSchemaFingerprint;expectedSurvivorSchemaFingerprint=$context.ExpectedSurvivorSchemaFingerprint
  }
  if($context.RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){$parameters.recoveryWorkspaceRoot=Get-ApprovalPath $context.RecoveryWorkspaceRoot 'ROLLBACK_FINALIZE_RECOVERY_WORKSPACE_REQUIRED';$parameters.liveStorageRoot=Get-ApprovalPath $context.LiveStorageRoot 'ROLLBACK_FINALIZE_LIVE_STORAGE_REQUIRED';$parameters.liveStorageDigest=Get-ApprovalHash $context.LiveStorageDigest 'ROLLBACK_FINALIZE_LIVE_STORAGE_DIGEST_REQUIRED';$parameters.preservedStorageRoot=Get-ApprovalPath $context.PreservedStorageRoot 'ROLLBACK_FINALIZE_PRESERVED_STORAGE_REQUIRED';$parameters.preservedStorageDigest=Get-ApprovalHash $context.PreservedStorageDigest 'ROLLBACK_FINALIZE_PRESERVED_STORAGE_DIGEST_REQUIRED';$parameters.preservedOriginalStorageRetained=$true}
  if($EdgeStateMode-ne'STOPPED_LOCAL_EDGE'){$parameters.quiescenceEvidencePath=Get-ApprovalPath $context.Quiescence.EvidencePath 'ROLLBACK_FINALIZE_QUIESCENCE_PATH_REQUIRED';$parameters.quiescenceEvidenceSha256=Get-ApprovalHash $context.Quiescence.EvidenceSha256 'ROLLBACK_FINALIZE_QUIESCENCE_HASH_REQUIRED';$parameters.quiescencePublicKeyPath=Get-ApprovalPath $context.Quiescence.PublicKeyPath 'ROLLBACK_FINALIZE_QUIESCENCE_PUBLIC_KEY_REQUIRED';$parameters.quiescencePublicKeySha256=Get-ApprovalHash $context.Quiescence.PublicKeySha256 'ROLLBACK_FINALIZE_QUIESCENCE_PUBLIC_KEY_HASH_REQUIRED'}
  if ($EdgeStateMode -eq 'ACTIVE_LOCAL_EDGE') {
    $parameters.edgeDrainHelperPath=Get-ApprovalPath $script:edgeDrainHelper 'ROLLBACK_FINALIZE_EDGE_DRAIN_HELPER_REQUIRED';$parameters.edgeDrainHelperSha256=Get-ApprovalHash $ExpectedEdgeDrainHelperSha256 'ROLLBACK_FINALIZE_EDGE_DRAIN_HELPER_HASH_REQUIRED';$parameters.maximumDrainAgeSeconds=$script:MaximumEdgeDrainAgeSeconds
  } elseif($EdgeStateMode-eq'LEGACY_QUIESCED_NO_EDGE') {
    $parameters.maximumLegacyQuiesceAgeSeconds=$script:MaximumLegacyQuiesceAgeSeconds;$parameters.legacyPortsAbsent=@(3100,4100);$parameters.edge443Absent=$true
  } else {
    $parameters.protectedPortsAbsent=@(443,3200,4200);$parameters.stoppedLocalServicesAbsenceVerified=$true;$parameters.serviceRightsExact=$true;$parameters.serviceAccountProcessesAbsent=$true
  }
  if ($IntendedAction -eq 'VerifyEvidence') { $parameters.expectedApplyPlanSha256=Get-ApprovalHash $ExpectedApplyPlanSha256 'ROLLBACK_FINALIZE_APPLY_PLAN_HASH_REQUIRED' }
  return New-ApprovalPlan $PSCommandPath $IntendedAction $parameters "Exact Supabase rollback boundary finalization: $Mode" $(if($Mode -eq 'RETURN_FORWARD'){'Under maintenance and current signed writer drain, drops the restored legacy schema and atomically renames the preserved forward schema back to production'}else{'Under maintenance and current signed writer drain, accepts the restored legacy schema and irreversibly drops only the exact preserved forward schema'}) 'A durable pre-mutation INTENT reconciles 1|1 and 1|0 live schema states after interruption; otherwise keep maintenance and writers quiesced and use a new exact approved retry or restore'
}

function New-CompleteRecord($Intent,$Plan,$Boundary,[string]$ObservedState) {
  return [ordered]@{
    version=4;recoveryPurpose=$Boundary.RecoveryPurpose;previousReleaseKind=$Boundary.PreviousReleaseKind;state='COMPLETE_MAINTENANCE_REQUIRED';mode=$Mode;operationFingerprint=$Boundary.OperationFingerprint
    initialApprovalPlanSha256=[string]$Intent.initialApprovalPlanSha256;approvalPlanSha256=$Plan.planSha256
    recoveryApprovalPlanSha256=$(if ($Plan.planSha256 -cne [string]$Intent.initialApprovalPlanSha256) { $Plan.planSha256 } else { $null })
    rollbackJournalSha256=$ExpectedRollbackJournalSha256.ToLowerInvariant();rollbackEvidenceSha256=$ExpectedRollbackEvidenceSha256.ToLowerInvariant()
    filesystemEvidenceSha256=$ExpectedFileSystemEvidenceSha256.ToLowerInvariant();maintenanceFlagSha256=$ExpectedMaintenanceFlagSha256.ToLowerInvariant();maintenanceApprovalIdDigest=$ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant();recoveryProcessTreeHelperPath=$Boundary.ProcessTreeHelper;recoveryProcessTreeHelperSha256=$ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant();localRecoverySecurityHelperPath=$Boundary.RecoverySecurityHelper;localRecoverySecurityHelperSha256=$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()
    edgeStateMode=$EdgeStateMode;quiescenceProofType=$Boundary.Quiescence.ProofType;quiescenceIdentityDigest=$Boundary.Quiescence.IdentityDigest;quiescenceEvidenceSha256=$Boundary.Quiescence.EvidenceSha256;activeRequestsAtMutation=0
    databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$Boundary.PreservedSchema
    recoveryWorkspaceRoot=$Boundary.RecoveryWorkspaceRoot;liveStorageRoot=$Boundary.LiveStorageRoot;liveStorageDigest=$Boundary.LiveStorageDigest;preservedStorageRoot=$Boundary.PreservedStorageRoot;preservedStorageDigest=$Boundary.PreservedStorageDigest;preservedOriginalStorageRetained=($Boundary.RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY')
    initialCurrentSchemaFingerprint=[string]$Intent.initialCurrentSchemaFingerprint;initialPreservedSchemaFingerprint=[string]$Intent.initialPreservedSchemaFingerprint;expectedSurvivorSchemaFingerprint=[string]$Intent.expectedSurvivorSchemaFingerprint;survivorSchemaFingerprint=[string]$Intent.expectedSurvivorSchemaFingerprint
    catalogFingerprintVerified=$true;rowLevelSecurityFingerprintVerified=$true;policyFingerprintVerified=$true;migrationChainFingerprintVerified=$true;businessKpiFingerprintVerified=$true;storageReferenceFingerprintVerified=$true;fullApplicationRowFingerprintVerified=$true;singleLockedDatabaseTransactionVerified=$true;advisoryDatabaseLeaseVerified=$true;allApplicationTablesAccessExclusiveLocked=$true;processTreeExitVerified=$true
    observedSchemaState=$ObservedState;currentSchemaPresent=$true;preservedSchemaAbsent=$true;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true
    completedAt=[datetimeoffset]::UtcNow.ToString('o')
  }
}

function Assert-ExistingIntent($Record,$Boundary) {
  $recordPurpose=if([string]$Record.recoveryPurpose){[string]$Record.recoveryPurpose}else{'MIGRATION_ROLLBACK'}
  if ($Record.version -ne 4 -or$recordPurpose-cne$Boundary.RecoveryPurpose-or $Record.previousReleaseKind-cne$Boundary.PreviousReleaseKind-or$Record.state -notin @('INTENT','FAILED_MAINTENANCE_REQUIRED','COMPLETE_MAINTENANCE_REQUIRED') -or
      $Record.mode -cne $Mode -or $Record.operationFingerprint -cne $Boundary.OperationFingerprint -or
      $Record.databaseProjectRef -cne $ConfirmProjectRef -or $Record.databaseHost -cne $ConfirmDatabaseHost -or
      $Record.databaseName -cne $ConfirmDatabaseName -or $Record.databaseSchema -cne $ConfirmDatabaseSchema -or
      $Record.preservedSchema -cne $Boundary.PreservedSchema -or $Record.initialApprovalPlanSha256 -notmatch '^[0-9a-f]{64}$' -or
      $Record.recoveryProcessTreeHelperPath-ine$Boundary.ProcessTreeHelper-or$Record.recoveryProcessTreeHelperSha256-cne$ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant()-or$Record.localRecoverySecurityHelperPath-ine$Boundary.RecoverySecurityHelper-or$Record.localRecoverySecurityHelperSha256-cne$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()-or
      $Record.initialCurrentSchemaFingerprint -cne $Boundary.InitialCurrentSchemaFingerprint -or $Record.initialPreservedSchemaFingerprint -cne $Boundary.InitialPreservedSchemaFingerprint -or $Record.expectedSurvivorSchemaFingerprint -cne $Boundary.ExpectedSurvivorSchemaFingerprint -or
      ($Boundary.RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'-and($Record.recoveryWorkspaceRoot-ine$Boundary.RecoveryWorkspaceRoot-or$Record.liveStorageRoot-ine$Boundary.LiveStorageRoot-or$Record.liveStorageDigest-cne$Boundary.LiveStorageDigest-or$Record.preservedStorageRoot-ine$Boundary.PreservedStorageRoot-or$Record.preservedStorageDigest-cne$Boundary.PreservedStorageDigest)) -or
      -not $Record.maintenanceMustRemainEnabled -or -not $Record.legacyWritersMustRemainQuiesced) {
    throw 'ROLLBACK_FINALIZE_EXISTING_INTENT_REJECTED'
  }
}

$intended = if ($Action -eq 'Apply') { 'Apply' } else { 'VerifyEvidence' }
$plan = New-FinalizePlan $(if ($Action -eq 'Plan') { $PlannedAction } else { $intended })
if ($Action -eq 'Plan') { $plan | ConvertTo-Json -Depth 16;exit 0 }
Assert-ApprovedPlan $plan ([bool]$Approved) $ApprovedPlanSha256
$boundary = Get-BoundaryContext ([string]$plan.exactParameters.existingFinalizationJournalSha256)
if ($boundary.Quiescence.IdentityDigest -cne $plan.exactParameters.quiescenceIdentityDigest -or $boundary.OperationFingerprint -cne $plan.exactParameters.operationFingerprint -or $boundary.InitialCurrentSchemaFingerprint -cne $plan.exactParameters.initialCurrentSchemaFingerprint -or $boundary.InitialPreservedSchemaFingerprint -cne $plan.exactParameters.initialPreservedSchemaFingerprint -or $boundary.ExpectedSurvivorSchemaFingerprint -cne $plan.exactParameters.expectedSurvivorSchemaFingerprint) { throw 'ROLLBACK_FINALIZE_ACTION_BOUNDARY_DRIFT' }

$connectionUser = if ($boundary.Config.database.connectionMode -eq 'session_pooler') { "$ConfirmDatabaseUser.$ConfirmProjectRef" } else { $ConfirmDatabaseUser }
$environment = @{PGPASSFILE=$boundary.PgPass;PGSSLMODE='verify-full';PGSSLROOTCERT=$boundary.Ca;PGCONNECT_TIMEOUT='15';PGOPTIONS='-c statement_timeout=240000 -c lock_timeout=30000 -c idle_in_transaction_session_timeout=60000';PGAPPNAME='meta-ads-rollback-finalize'}
$base = @("--host=$ConfirmDatabaseHost",'--port=5432',"--username=$connectionUser","--dbname=$ConfirmDatabaseName",'--no-password','--tuples-only','--no-align','--set=ON_ERROR_STOP=1')
$stateSql = "SELECT (to_regnamespace('$ConfirmDatabaseSchema') IS NOT NULL)::int || '|' || (to_regnamespace('$($boundary.PreservedSchema)') IS NOT NULL)::int"

if ($Action -eq 'Apply') {
  $intent = $null
  $journalOwned = $false
  $completed = $false
  $reconciledAfterFailure = $false
  $observed = 'UNKNOWN'
  try {
    if (Test-Path -LiteralPath $FinalizationJournalPath -PathType Leaf) {
      $intent = Read-BoundedJson $FinalizationJournalPath 'ROLLBACK_FINALIZE_EXISTING_INTENT_INVALID' 1048576
      Assert-ExistingIntent $intent $boundary
      $journalOwned = $true
    }
    $observed = Invoke-Bounded $boundary.Psql ($base + @("--command=$stateSql")) $environment 'ROLLBACK_FINALIZE_STATE_CHECK'
    if ($intent -and $intent.state -ceq 'COMPLETE_MAINTENANCE_REQUIRED') {
      if ($observed -cne '1|0') { throw 'ROLLBACK_FINALIZE_COMPLETE_STATE_DRIFT' }
      $liveSurvivor = Get-LiveSchemaFingerprint $boundary.Psql $base $environment $ConfirmDatabaseSchema
      if ($liveSurvivor.Fingerprint -cne $boundary.ExpectedSurvivorSchemaFingerprint) { throw 'ROLLBACK_FINALIZE_COMPLETE_FINGERPRINT_DRIFT' }
      $completed = $true
    } elseif ($observed -eq '1|0' -and $intent) {
      $liveSurvivor = Get-LiveSchemaFingerprint $boundary.Psql $base $environment $ConfirmDatabaseSchema
      if ($liveSurvivor.Fingerprint -cne $boundary.ExpectedSurvivorSchemaFingerprint) { throw 'ROLLBACK_FINALIZE_RECONCILE_FINGERPRINT_DRIFT' }
      Write-DurableJson $FinalizationJournalPath (New-CompleteRecord $intent $plan $boundary $observed)
      $completed = $true
      $reconciledAfterFailure = $true
    } else {
      if ($observed -cne '1|1') { throw 'ROLLBACK_FINALIZE_SCHEMA_STATE_REJECTED' }
      if (-not $intent) {
        $intent = [ordered]@{
          version=4;recoveryPurpose=$boundary.RecoveryPurpose;previousReleaseKind=$boundary.PreviousReleaseKind;state='INTENT';mode=$Mode;operationFingerprint=$boundary.OperationFingerprint
          initialApprovalPlanSha256=$plan.planSha256;approvalInstanceId=$plan.approvalInstanceId
          rollbackJournalSha256=$ExpectedRollbackJournalSha256.ToLowerInvariant();rollbackEvidenceSha256=$ExpectedRollbackEvidenceSha256.ToLowerInvariant()
          filesystemEvidenceSha256=$ExpectedFileSystemEvidenceSha256.ToLowerInvariant();maintenanceFlagSha256=$ExpectedMaintenanceFlagSha256.ToLowerInvariant();maintenanceApprovalIdDigest=$ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant();recoveryProcessTreeHelperPath=$boundary.ProcessTreeHelper;recoveryProcessTreeHelperSha256=$ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant();localRecoverySecurityHelperPath=$boundary.RecoverySecurityHelper;localRecoverySecurityHelperSha256=$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()
          edgeStateMode=$EdgeStateMode;quiescenceProofType=$boundary.Quiescence.ProofType;quiescenceIdentityDigest=$boundary.Quiescence.IdentityDigest;quiescenceEvidenceSha256=$boundary.Quiescence.EvidenceSha256;activeRequestsAtIntent=0
          databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$boundary.PreservedSchema
          recoveryWorkspaceRoot=$boundary.RecoveryWorkspaceRoot;liveStorageRoot=$boundary.LiveStorageRoot;liveStorageDigest=$boundary.LiveStorageDigest;preservedStorageRoot=$boundary.PreservedStorageRoot;preservedStorageDigest=$boundary.PreservedStorageDigest;preservedOriginalStorageRetained=($boundary.RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY')
          initialCurrentSchemaFingerprint=$boundary.InitialCurrentSchemaFingerprint;initialPreservedSchemaFingerprint=$boundary.InitialPreservedSchemaFingerprint;expectedSurvivorSchemaFingerprint=$boundary.ExpectedSurvivorSchemaFingerprint
          expectedPreState='1|1';expectedPostState='1|0';maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;createdAt=[datetimeoffset]::UtcNow.ToString('o')
        }
        Write-DurableJson $FinalizationJournalPath $intent -CreateOnly
        $journalOwned = $true
      }
      [void](Get-PinnedFile $boundary.MaintenancePath $ExpectedMaintenanceFlagSha256 'ROLLBACK_FINALIZE_PRE_MUTATION_MAINTENANCE_HASH_DRIFT' 1048576)
      [void](Assert-MaintenanceState $boundary.Config $boundary.MaintenancePath)
      $actionQuiescence = Assert-CurrentQuiescence $boundary.Config $boundary.RollbackEvidence $boundary.Runtime $boundary.Node $boundary.Verifier
      if ($actionQuiescence.IdentityDigest -cne $plan.exactParameters.quiescenceIdentityDigest -or [int]$actionQuiescence.ActiveRequests -ne 0) { throw 'ROLLBACK_FINALIZE_ACTION_TIME_QUIESCENCE_CHANGED' }
      if($boundary.RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'){Assert-LocalRecoveryExactAcl $boundary.LiveStorageRoot 'CORE_MODIFY' $boundary.FileSystem|Out-Null;Assert-LocalRecoveryExactAcl $boundary.RecoveryWorkspaceRoot 'ADMIN_ONLY' $boundary.FileSystem|Out-Null;Assert-LocalRecoveryExactAcl $boundary.PreservedStorageRoot 'ADMIN_ONLY' $boundary.FileSystem|Out-Null}
      [void](Invoke-AtomicFinalization $boundary.Psql $base $environment $ConfirmDatabaseSchema $boundary.PreservedSchema $boundary.InitialCurrentSchemaFingerprint $boundary.InitialPreservedSchemaFingerprint $boundary.ExpectedSurvivorSchemaFingerprint)
      $observed='1|0'
      Write-DurableJson $FinalizationJournalPath (New-CompleteRecord $intent $plan $boundary $observed)
      $completed = $true
    }
  } catch {
    $failureCode = if ([string]$_.Exception.Message -match '^[A-Z0-9_]{3,160}$') { [string]$_.Exception.Message } else { 'ROLLBACK_FINALIZE_UNCLASSIFIED_FAILURE' }
    try { $observed = Invoke-Bounded $boundary.Psql ($base + @("--command=$stateSql")) $environment 'ROLLBACK_FINALIZE_FAILURE_STATE_CHECK' } catch { $observed = 'UNKNOWN' }
    if ($journalOwned -and $intent) {
      try {
        $reconcileFingerprintMatches = $false
        if ($observed -ceq '1|0') {
          try { $reconcileFingerprintMatches = (Get-LiveSchemaFingerprint $boundary.Psql $base $environment $ConfirmDatabaseSchema).Fingerprint -ceq $boundary.ExpectedSurvivorSchemaFingerprint } catch { $reconcileFingerprintMatches = $false }
        }
        if ($observed -ceq '1|0' -and $reconcileFingerprintMatches) {
          Write-DurableJson $FinalizationJournalPath (New-CompleteRecord $intent $plan $boundary $observed)
          $completed = $true
          $reconciledAfterFailure = $true
        } else {
          Write-DurableJson $FinalizationJournalPath ([ordered]@{
            version=4;recoveryPurpose=$boundary.RecoveryPurpose;previousReleaseKind=$boundary.PreviousReleaseKind;state='FAILED_MAINTENANCE_REQUIRED';mode=$Mode;operationFingerprint=$boundary.OperationFingerprint
            initialApprovalPlanSha256=[string]$intent.initialApprovalPlanSha256;lastApprovalPlanSha256=$plan.planSha256;failureCode=$failureCode
            rollbackJournalSha256=$ExpectedRollbackJournalSha256.ToLowerInvariant();rollbackEvidenceSha256=$ExpectedRollbackEvidenceSha256.ToLowerInvariant()
            filesystemEvidenceSha256=$ExpectedFileSystemEvidenceSha256.ToLowerInvariant();maintenanceFlagSha256=$ExpectedMaintenanceFlagSha256.ToLowerInvariant();maintenanceApprovalIdDigest=$ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant();recoveryProcessTreeHelperPath=$boundary.ProcessTreeHelper;recoveryProcessTreeHelperSha256=$ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant();localRecoverySecurityHelperPath=$boundary.RecoverySecurityHelper;localRecoverySecurityHelperSha256=$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()
            edgeStateMode=$EdgeStateMode;quiescenceProofType=$boundary.Quiescence.ProofType;quiescenceIdentityDigest=$boundary.Quiescence.IdentityDigest;quiescenceEvidenceSha256=$boundary.Quiescence.EvidenceSha256
            databaseProjectRef=$ConfirmProjectRef;databaseHost=$ConfirmDatabaseHost;databaseName=$ConfirmDatabaseName;databaseSchema=$ConfirmDatabaseSchema;preservedSchema=$boundary.PreservedSchema
            recoveryWorkspaceRoot=$boundary.RecoveryWorkspaceRoot;liveStorageRoot=$boundary.LiveStorageRoot;liveStorageDigest=$boundary.LiveStorageDigest;preservedStorageRoot=$boundary.PreservedStorageRoot;preservedStorageDigest=$boundary.PreservedStorageDigest;preservedOriginalStorageRetained=($boundary.RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY')
            initialCurrentSchemaFingerprint=[string]$intent.initialCurrentSchemaFingerprint;initialPreservedSchemaFingerprint=[string]$intent.initialPreservedSchemaFingerprint;expectedSurvivorSchemaFingerprint=[string]$intent.expectedSurvivorSchemaFingerprint
            observedSchemaState=$observed;maintenanceMustRemainEnabled=$true;legacyWritersMustRemainQuiesced=$true;recoveryProcedure='KEEP MAINTENANCE AND WRITER QUIESCENCE. HASH-PIN THIS JOURNAL AND CREATE A NEW EXACT APPLY PLAN TO RECONCILE 1|1 OR 1|0.';failedAt=[datetimeoffset]::UtcNow.ToString('o')
          })
        }
      } catch { throw 'ROLLBACK_FINALIZE_FAILED_AND_DURABLE_JOURNAL_WRITE_FAILED' }
    }
    if (-not $completed) { throw 'ROLLBACK_FINALIZE_FAILED_MAINTENANCE_REQUIRED' }
  }
  if (-not $completed) { throw 'ROLLBACK_FINALIZE_INCOMPLETE' }
  [pscustomobject]@{Result='COMPLETE_MAINTENANCE_REQUIRED';RecoveryPurpose=$boundary.RecoveryPurpose;Mode=$Mode;CurrentSchemaPresent=$true;PreservedSchemaAbsent=$true;PreservedOriginalStorageRetained=($boundary.RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY');MaintenanceRetained=$true;WritersRemainQuiesced=$true;CrashStateReconciled=$reconciledAfterFailure;DatabaseSecretEmitted=$false} | ConvertTo-Json
  exit 0
}

$finalPath = Get-PinnedFile $FinalizationJournalPath $ExpectedFinalizationJournalSha256 'ROLLBACK_FINALIZE_OUTPUT_HASH_MISMATCH' 1048576
$record = Read-BoundedJson $finalPath 'ROLLBACK_FINALIZE_OUTPUT_INVALID' 1048576
$state = Invoke-Bounded $boundary.Psql ($base + @("--command=$stateSql")) $environment 'ROLLBACK_FINALIZE_VERIFY_STATE'
$recordPurpose=if([string]$record.recoveryPurpose){[string]$record.recoveryPurpose}else{'MIGRATION_ROLLBACK'}
if ($record.version -ne 4 -or$recordPurpose-cne$boundary.RecoveryPurpose-or $record.previousReleaseKind-cne$boundary.PreviousReleaseKind-or$record.state -cne 'COMPLETE_MAINTENANCE_REQUIRED' -or $record.mode -cne $Mode -or
    $record.operationFingerprint -cne $boundary.OperationFingerprint -or $record.approvalPlanSha256 -cne $ExpectedApplyPlanSha256.ToLowerInvariant() -or
    $record.rollbackJournalSha256 -cne $ExpectedRollbackJournalSha256.ToLowerInvariant() -or $record.rollbackEvidenceSha256 -cne $ExpectedRollbackEvidenceSha256.ToLowerInvariant() -or
    $record.filesystemEvidenceSha256 -cne $ExpectedFileSystemEvidenceSha256.ToLowerInvariant() -or $record.maintenanceFlagSha256 -cne $ExpectedMaintenanceFlagSha256.ToLowerInvariant() -or$record.recoveryProcessTreeHelperPath-ine$boundary.ProcessTreeHelper-or$record.recoveryProcessTreeHelperSha256-cne$ExpectedRecoveryProcessTreeHelperSha256.ToLowerInvariant()-or$record.localRecoverySecurityHelperPath-ine$boundary.RecoverySecurityHelper-or$record.localRecoverySecurityHelperSha256-cne$ExpectedLocalRecoverySecurityHelperSha256.ToLowerInvariant()-or
    $record.maintenanceApprovalIdDigest -cne $ExpectedMaintenanceApprovalIdDigest.ToLowerInvariant() -or
    $record.edgeStateMode -cne $EdgeStateMode -or $record.quiescenceProofType -cne $boundary.Quiescence.ProofType -or
    $record.databaseProjectRef -cne $ConfirmProjectRef -or $record.databaseHost -cne $ConfirmDatabaseHost -or
    $record.databaseName -cne $ConfirmDatabaseName -or $record.databaseSchema -cne $ConfirmDatabaseSchema -or
    $record.preservedSchema -cne $boundary.PreservedSchema -or $record.initialCurrentSchemaFingerprint -cne $boundary.InitialCurrentSchemaFingerprint -or $record.initialPreservedSchemaFingerprint -cne $boundary.InitialPreservedSchemaFingerprint -or $record.expectedSurvivorSchemaFingerprint -cne $boundary.ExpectedSurvivorSchemaFingerprint -or $record.survivorSchemaFingerprint -cne $boundary.ExpectedSurvivorSchemaFingerprint -or
    ($boundary.RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY'-and($record.recoveryWorkspaceRoot-ine$boundary.RecoveryWorkspaceRoot-or$record.liveStorageRoot-ine$boundary.LiveStorageRoot-or$record.liveStorageDigest-cne$boundary.LiveStorageDigest-or$record.preservedStorageRoot-ine$boundary.PreservedStorageRoot-or$record.preservedStorageDigest-cne$boundary.PreservedStorageDigest-or-not$record.preservedOriginalStorageRetained)) -or $state -cne '1|0' -or
    -not $record.catalogFingerprintVerified -or -not $record.rowLevelSecurityFingerprintVerified -or -not $record.policyFingerprintVerified -or -not $record.migrationChainFingerprintVerified -or -not $record.businessKpiFingerprintVerified -or -not $record.storageReferenceFingerprintVerified -or-not$record.fullApplicationRowFingerprintVerified-or-not$record.singleLockedDatabaseTransactionVerified-or-not$record.advisoryDatabaseLeaseVerified-or-not$record.allApplicationTablesAccessExclusiveLocked-or-not$record.processTreeExitVerified-or
    -not $record.currentSchemaPresent -or -not $record.preservedSchemaAbsent -or -not $record.maintenanceMustRemainEnabled -or -not $record.legacyWritersMustRemainQuiesced) {
  throw 'ROLLBACK_FINALIZE_VERIFY_REJECTED'
}
[pscustomobject]@{Result='PASS';RecoveryPurpose=$boundary.RecoveryPurpose;Mode=$Mode;CurrentSchemaPresent=$true;PreservedSchemaAbsent=$true;PreservedOriginalStorageRetained=($boundary.RecoveryPurpose-eq'DAILY_BACKUP_RECOVERY');MaintenanceRetained=$true;WritersRemainQuiesced=$true;DurableIntentReconciled=$true} | ConvertTo-Json
