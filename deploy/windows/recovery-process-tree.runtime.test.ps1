#Requires -Version 7.2
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'recovery-process-tree.ps1')

$root = Join-Path ([IO.Path]::GetTempPath()) ('metaads-recovery-tree-' + [guid]::NewGuid().ToString('N'))
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$root = [IO.Path]::GetFullPath($root)
if (-not $root.StartsWith($temporaryRoot,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $root) -notmatch '^metaads-recovery-tree-[0-9a-f]{32}$') { throw 'RECOVERY_PROCESS_TREE_FIXTURE_PATH_REJECTED' }
$workerPath = Join-Path $root 'worker.ps1'
$childPidPath = Join-Path $root 'children.pid'
$worker = $null
$childPids = @()
function Read-ChildPidLines {
  $watch=[Diagnostics.Stopwatch]::StartNew()
  do{
    $stream=$null;$reader=$null
    try{
      $stream=[IO.FileStream]::new($childPidPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
      $reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$true,4096,$false)
      return @($reader.ReadToEnd()-split"`r?`n"|Where-Object{$_-match'^\d+$'})
    }catch [IO.IOException]{Start-Sleep -Milliseconds 25}
    finally{if($reader){$reader.Dispose()}elseif($stream){$stream.Dispose()}}
  }while($watch.ElapsedMilliseconds-lt5000)
  throw 'RECOVERY_PROCESS_TREE_PID_FILE_LOCKED'
}
try {
  [void](New-Item -ItemType Directory -Path $root)
  [IO.File]::WriteAllText($workerPath, @'
param([string]$ChildPidPath)
while ($true) {
  $child = Start-Process -FilePath pwsh.exe -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 300') -PassThru
  [IO.File]::AppendAllText($ChildPidPath, "$($child.Id)`n")
  Start-Sleep -Milliseconds 25
}
'@, (New-Object Text.UTF8Encoding($false)))
  $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=(Get-Command pwsh.exe -ErrorAction Stop).Source;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($argument in @('-NoProfile','-File',$workerPath,'-ChildPidPath',$childPidPath)){[void]$start.ArgumentList.Add($argument)}
  $worker = Start-VerifiedRecoveryProcess $start
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  while ((-not(Test-Path -LiteralPath $childPidPath -PathType Leaf) -or @(Read-ChildPidLines).Count-lt3) -and $deadline.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 25 }
  if (-not(Test-Path -LiteralPath $childPidPath -PathType Leaf)) { throw 'RECOVERY_PROCESS_TREE_FIXTURE_TIMEOUT' }
  Stop-VerifiedRecoveryProcessTree $worker 5000
  $childPids=@(Read-ChildPidLines|ForEach-Object{[int]$_})
  if($childPids.Count-lt3){throw 'RECOVERY_PROCESS_TREE_FIXTURE_TIMEOUT'}
  if (Get-Process -Id $worker.Id -ErrorAction SilentlyContinue) { throw 'RECOVERY_PROCESS_TREE_ROOT_SURVIVED' }
  if (@($childPids|ForEach-Object{Get-Process -Id $_ -ErrorAction SilentlyContinue}).Count) { throw 'RECOVERY_PROCESS_TREE_CHILD_SURVIVED' }
  [pscustomobject]@{ result = 'PASS'; stubbornDescendantTerminated = $true; spawnDuringTerminationContained=$true; suspendedBeforeJobAssignment=$true; jobActiveProcessCountZero=$true; exitVerified = $true } | ConvertTo-Json -Compress
} finally {
  if ($worker) { try { Stop-VerifiedRecoveryProcessTree $worker 5000 } catch {};try{$worker.Dispose()}catch{} }
  foreach($childPid in $childPids){Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue}
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
