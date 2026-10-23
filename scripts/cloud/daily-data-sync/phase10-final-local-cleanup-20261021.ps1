Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021'
$docker='C:/Program Files/Docker/Docker/resources/bin/docker.exe'
$stage='LOCAL_SCOPE';$p=$null
try{
 if(Test-Path -LiteralPath ($root+'/final-local-cleanup.json')){throw 'CONSUMED'}
 $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object LocalPort -In @(55436,55437,55438,55439));if($listeners.Count -ne 0){throw 'NATIVE_LISTENER'}
 $processes=@(Get-Process -Name 'Docker Desktop','com.docker.backend' -ErrorAction SilentlyContinue)
 $expected=@(11300,13244,19344,22912,28736,33896,37116)
 if((($processes.Id|Sort-Object) -join ',') -cne (($expected|Sort-Object) -join ',')){throw 'PROCESS_SET_CHANGED'}
 foreach($item in $processes){$time=$item.StartTime.ToUniversalTime();if($time -lt [datetime]'2026-10-20T07:52:49Z' -or $time -gt [datetime]'2026-10-20T07:52:55Z'){throw 'PROCESS_START_CHANGED'}}
 $running=@(& $docker ps -q 2>$null);if($LASTEXITCODE -ne 0 -or $running.Count -ne 0){throw 'ACTIVE_OR_UNKNOWN_CONTAINERS'}
 $before=@{kind='PHASE10_FINAL_LOCAL_FIRST_READ_FAILURE_PRESERVED';at=[DateTimeOffset]::UtcNow.ToString('o');status='FAIL_DOCKER_BACKGROUND_REMAINS';nativeListeners=0;dockerDesktopProcesses=5;dockerBackendProcesses=2;allDockerProcessesStartedInObserved20261020Window=$true;runningContainers=0;rawValuesReturned=0;processesStopped=0;dataDeleted=0}
 $f=[IO.File]::Open(($root+'/final-local-state-first-failure.json'),[IO.FileMode]::CreateNew);try{$b=[Text.UTF8Encoding]::new($false).GetBytes(($before|ConvertTo-Json));$f.Write($b,0,$b.Length)}finally{$f.Dispose()}
 $stage='DESKTOP_GRACEFUL_STOP';$psi=[Diagnostics.ProcessStartInfo]::new($docker);$psi.ArgumentList.Add('desktop');$psi.ArgumentList.Add('stop');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $p=[Diagnostics.Process]::Start($psi);$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();if(-not $p.WaitForExit(45000)){throw 'STOP_TIMEOUT'};$null=$o.GetAwaiter().GetResult();$null=$e.GetAwaiter().GetResult();if($p.ExitCode -ne 0){throw 'STOP_REJECTED'}
 $stage='FINAL_PROCESS_READ';for($i=0;$i -lt 10;$i++){$left=@(Get-Process -Name 'Docker Desktop','com.docker.backend' -ErrorAction SilentlyContinue);if($left.Count -eq 0){break};Start-Sleep -Seconds 1};if($left.Count -ne 0){throw 'STOP_NOT_COMPLETE'}
 $proof=@{kind='PHASE10_FINAL_LOCAL_GRACEFUL_CLEANUP';status='PASS';at=[DateTimeOffset]::UtcNow.ToString('o');observedDockerProcessCountBefore=7;dockerProcessesAfter=0;runningContainersBefore=0;normalDesktopStopExit=0;forceKilledProcesses=0;containersImagesVolumesOrFilesDeleted=0;nativeListeners=0;remoteRequests=0;operatingChanges=0;rawValuesReturned=0}
 $f=[IO.File]::Open(($root+'/final-local-cleanup.json'),[IO.FileMode]::CreateNew);try{$b=[Text.UTF8Encoding]::new($false).GetBytes(($proof|ConvertTo-Json));$f.Write($b,0,$b.Length)}finally{$f.Dispose()};$proof|ConvertTo-Json -Compress
}catch{@{status='FAIL';stage=$stage;rawErrorSuppressed=$true;remoteRequests=0;dataDeleted=0}|ConvertTo-Json -Compress;exit 1}
finally{if($p){$p.Dispose()}}
