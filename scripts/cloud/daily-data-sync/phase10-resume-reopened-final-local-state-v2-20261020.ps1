Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$path='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261020/reopened-final-local-state-v2.json'
try{
 if(Test-Path -LiteralPath $path){throw 'EVIDENCE_CONSUMED'}
 $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object LocalPort -In @(55436,55437))
 $desktop=@(Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)
 $backend=@(Get-Process -Name 'com.docker.backend' -ErrorAction SilentlyContinue)
 if($listeners.Count -ne 0 -or $desktop.Count -ne 0 -or $backend.Count -ne 0){throw 'LOCAL_STATE_CHANGED'}
 $proof=@{kind='PHASE10_REOPENED_FINAL_LOCAL_STATE';status='PASS';at=[DateTimeOffset]::UtcNow.ToString('o');native55436And55437Listeners=0;dockerDesktopProcesses=0;dockerBackendProcesses=0;originalDockerStoppedStatePreserved=$true;dataOrImagesDeleted=0;processesStoppedByThisReadcheck=0;remoteRequests=0;operatingChanges=0;rawValuesReturned=0}
 $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew)
 try{$stream.Write([Text.UTF8Encoding]::new($false).GetBytes(($proof|ConvertTo-Json -Depth 5)));$stream.Flush($true)}finally{$stream.Dispose()}
 @{status='PASS';nativeListeners=0;dockerDesktopAndBackend=0;evidence=$path}|ConvertTo-Json -Compress
}catch{@{status='FAIL';rawErrorSuppressed=$true;remoteRequests=0;processesStopped=0}|ConvertTo-Json -Compress;exit 1}
