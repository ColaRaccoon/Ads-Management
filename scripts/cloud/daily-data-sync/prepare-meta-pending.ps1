param([Parameter(Mandatory)][string]$OutputPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/source-connection-helpers.ps1"
$phase08Context=$null;$phase08Operator=$null;$phase08Sql=$null;$phase08Bytes=$null;$phase08File=$null
try {
  $root=[IO.Path]::GetFullPath('C:\Users\seong\AppData\Local\MetaAdsPhase08Evaluation')
  $output=[IO.Path]::GetFullPath($OutputPath)
  if(-not $output.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetExtension($output) -cne '.sql' -or -not (Test-Path -LiteralPath (Split-Path $output) -PathType Container)){throw 'artifact-path'}
  $ancestor=Split-Path $output
  while($ancestor.Length -ge $root.Length) {
    if((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'artifact-reparse'}
    if($ancestor -ceq $root){break};$ancestor=Split-Path $ancestor
  }
  $phase08Context=Read-Phase08ProtectedJson;$phase08Operator=Read-Phase08Operator
  $phase08Sql=New-Phase08MetaPendingSql $phase08Context $phase08Operator
  $phase08Bytes=[Text.UTF8Encoding]::new($false).GetBytes($phase08Sql)
  $phase08File=[IO.File]::Open($output,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $phase08File.Write($phase08Bytes,0,$phase08Bytes.Length);$phase08File.Dispose();$phase08File=$null
  @{state='PHASE08_META_PENDING_SQL_PREPARED';sqlPath=$output;remoteChanges=0;credentialRows=0;readyPolicies=0;requiresFixedProjectFingerprint=$true}|ConvertTo-Json
} catch {@{state='PHASE08_META_PENDING_PREPARATION_FAILED';rawErrorSuppressed=$true;inspectBeforeRetry=$true}|ConvertTo-Json;exit 1}
finally {if($phase08File){$phase08File.Dispose()};if($phase08Bytes){[Array]::Clear($phase08Bytes,0,$phase08Bytes.Length)};$phase08Context=$null;$phase08Operator=$null;$phase08Sql=$null}
