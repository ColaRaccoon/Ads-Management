#Requires -Version 7.2
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'recovery-process-tree.ps1')

$root = Join-Path ([IO.Path]::GetTempPath()) ('metaads-recovery-tree-' + [guid]::NewGuid().ToString('N'))
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$root = [IO.Path]::GetFullPath($root)
if (-not $root.StartsWith($temporaryRoot,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $root) -notmatch '^metaads-recovery-tree-[0-9a-f]{32}$') { throw 'RECOVERY_PROCESS_TREE_FIXTURE_PATH_REJECTED' }
$workerPath = Join-Path $root 'worker.ps1'
$childPidPath = Join-Path $root 'child.pid'
$worker = $null
$childPid = 0
try {
  [void](New-Item -ItemType Directory -Path $root)
  [IO.File]::WriteAllText($workerPath, @'
param([string]$ChildPidPath)
$child = Start-Process -FilePath pwsh.exe -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 300') -PassThru
[IO.File]::WriteAllText($ChildPidPath, [string]$child.Id)
while ($true) { Start-Sleep -Seconds 1 }
'@, (New-Object Text.UTF8Encoding($false)))
  $worker = Start-Process -FilePath pwsh.exe -ArgumentList @('-NoProfile','-File',$workerPath,'-ChildPidPath',$childPidPath) -PassThru
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  while (-not(Test-Path -LiteralPath $childPidPath -PathType Leaf) -and $deadline.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 25 }
  if (-not(Test-Path -LiteralPath $childPidPath -PathType Leaf)) { throw 'RECOVERY_PROCESS_TREE_FIXTURE_TIMEOUT' }
  $childPid = [int]([IO.File]::ReadAllText($childPidPath))
  Stop-VerifiedRecoveryProcessTree $worker 5000
  if (Get-Process -Id $worker.Id -ErrorAction SilentlyContinue) { throw 'RECOVERY_PROCESS_TREE_ROOT_SURVIVED' }
  if (Get-Process -Id $childPid -ErrorAction SilentlyContinue) { throw 'RECOVERY_PROCESS_TREE_CHILD_SURVIVED' }
  [pscustomobject]@{ result = 'PASS'; stubbornDescendantTerminated = $true; exitVerified = $true } | ConvertTo-Json -Compress
} finally {
  if ($worker -and -not $worker.HasExited) { try { $worker.Kill($true); [void]$worker.WaitForExit(5000) } catch {} }
  if ($childPid -gt 0) { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
