Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v4'
$ready=Get-Content (Join-Path $root 'ready.json') -Raw|ConvertFrom-Json -AsHashtable
$output=Join-Path $root 'light-load.json';$telemetry=Join-Path $root 'db-load-telemetry.json'
if(Test-Path $output){throw 'LOAD_ALREADY_ATTEMPTED'};if(Test-Path $telemetry){throw 'TELEMETRY_ALREADY_EXISTS'}
$samples=@();$failures=0;$started=[DateTimeOffset]::UtcNow.ToString('o');$child=$null;$stdout=$null;$stderr=$null
try{
 $arguments=@('-NoProfile','-File',(Join-Path $PSScriptRoot 'phase10-resume-recheck4-light-load-20261020.ps1'),'-EvidencePath',$output,'-ExpectedDeploymentId',$ready.deploymentId,'-ExpectedSourceSha',$ready.source,'-ExpectedReleaseSha',$ready.releaseId)
 $psi=[Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path);$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 foreach($argument in $arguments){$psi.ArgumentList.Add($argument)}
 $child=[Diagnostics.Process]::new();$child.StartInfo=$psi;[void]$child.Start();$stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
 do{
  try{
   $rows=@(Invoke-Phase08Management -Action Query -Query @'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT current_database() AS db,current_user AS principal,clock_timestamp() AS observed_at,
(SELECT count(*)::int FROM pg_stat_activity WHERE usename='phase08_runtime') AS runtime_backends,
(SELECT count(*)::int FROM pg_stat_activity WHERE usename='phase08_runtime' AND state='active') AS active,
(SELECT count(*)::int FROM pg_stat_activity WHERE usename='phase08_runtime' AND wait_event_type='Lock') AS lock_wait,
(SELECT count(*)::int FROM pg_stat_activity WHERE usename='phase08_runtime' AND wait_event_type IS NOT NULL AND state='active') AS active_wait,
(SELECT count(*)::int FROM pg_stat_activity WHERE usename='phase08_runtime' AND state='idle in transaction') AS idle_in_transaction;
COMMIT;
'@)
   if($rows.Count -ne 1 -or $rows[0].db -cne 'postgres' -or $rows[0].principal -cne 'postgres'){throw 'TELEMETRY_IDENTITY'}
   $r=$rows[0];$samples+=@{at=$r.observed_at;runtimeBackends=$r.runtime_backends;active=$r.active;lockWait=$r.lock_wait;activeWait=$r.active_wait;idleInTransaction=$r.idle_in_transaction}
  }catch{$failures++}
  if(-not $child.HasExited){Start-Sleep -Seconds 2};$child.Refresh()
 }while(-not $child.HasExited)
 $child.WaitForExit();$exit=$child.ExitCode;$discard=$stdout.GetAwaiter().GetResult();$discard=$stderr.GetAwaiter().GetResult();$discard=$null
}finally{
 $proof=@{kind='BOUNDED_LOAD_DB_AGGREGATE_TELEMETRY';deployment=$ready.deploymentId;startedAt=$started;finishedAt=[DateTimeOffset]::UtcNow.ToString('o');sampleCount=$samples.Count;failedSamples=$failures;samples=$samples;sampledOnly=$true;queryTextAndSecretsCaptured=$false;separateClientHttpRequests=0;managementReadOnly=$true;loadExitCode=$(if($null -ne $child -and $child.HasExited){$child.ExitCode}else{$null});configuredPoolLimit=3;observedMaxRuntimeBackends=($samples|Measure-Object -Property runtimeBackends -Maximum).Maximum;instantaneousWaitNotProvenAbsentBetweenSamples=$true;rawChildOutputSaved=$false;rawChildOutputForwarded=$false}
 $f=[IO.File]::Open($telemetry,[IO.FileMode]::CreateNew);try{$f.Write([Text.Encoding]::UTF8.GetBytes(($proof|ConvertTo-Json -Depth 9)))}finally{$f.Dispose()}
}
$result=Get-Content $output -Raw|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String
@{status=$result.status;summary=$result.summary;logoutVerified=$result.logoutVerified;sessionMayRemain=$result.sessionMayRemain}|ConvertTo-Json -Depth 5 -Compress
@{kind=$proof.kind;samples=$samples.Count;failedSamples=$failures;loadExitCode=$exit}|ConvertTo-Json -Compress
if($exit -ne 0){exit 1}
