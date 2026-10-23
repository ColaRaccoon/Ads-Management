param([ValidateSet('OperatingMetadata','IsolatedProbe')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/evidence'
$stage='START';$headers=$null;$v=$null
try {
 [void][IO.Directory]::CreateDirectory($root)
 $file=Join-Path $root ($Mode+'.json')
 if(Test-Path -LiteralPath $file){throw 'RECEIPT_EXISTS'}
 if($Mode -ceq 'OperatingMetadata') {
  $stage='OPERATING_METADATA_READ_ONLY'
  $scope=@{p='6fe72710-1fc8-445a-a77f-da2da8fee200';e='01ab3d5a-1036-45b0-aa9c-47179339c9be';s='b0835b08-7799-4c1c-8bcd-90746b9d4248'}
  $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){project(id:$p){id} serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status meta}} variables(projectId:$p,environmentId:$e,serviceId:$s)}' $scope
  $v=$r.variables;$svc=$r.serviceInstance
  if($r.project.id -cne $scope.p -or $svc.serviceId -cne $scope.s -or $svc.environmentId -cne $scope.e -or $v.SUPABASE_DATABASE_PROJECT_REF -cne 'iygjmosbelbosfxidqxv' -or $v.SUPABASE_DATABASE_SCHEMA -cne 'meta_ads' -or $v.SUPABASE_STORAGE_BUCKET -cne 'meta-ads-production'){throw 'OPERATING_IDENTITY'}
  $release=$v.RELEASE_GIT_SHA
  if($release -cnotmatch '^[a-f0-9]{40}$'){throw 'RELEASE_ID'}
  $out=@{kind='PHASE10_OPERATING_METADATA_READ_ONLY';observedAt=[DateTimeOffset]::UtcNow.ToString('o');scope=$scope;releaseSha=$release;deploymentId=$svc.latestDeployment.id;status=$svc.latestDeployment.status;imageDigest=$svc.latestDeployment.meta.imageDigest;startCommand=$svc.startCommand;sleepApplication=$svc.sleepApplication;deploy=$svc.latestDeployment.meta.serviceManifest.deploy;databaseProjectRef='iygjmosbelbosfxidqxv';schema='meta_ads';runtimeRole=$v.SUPABASE_DATABASE_RUNTIME_USER;variableNames=@($v.Keys|Sort-Object);productionWrites=0;productionDatabaseRequests=0;providerRequests=0;appHttpRequests=0}
 } else {
  $stage='ISOLATED_IDENTITY'
  $scope=@{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
  $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status}}}' $scope
  $v=$r.variables
  if($r.serviceInstance.serviceId -cne $scope.s -or $r.serviceInstance.environmentId -cne $scope.e -or $r.serviceInstance.latestDeployment.id -cne '004241ae-ff50-4d0c-b179-3663448bb378' -or $v.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $v.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $v.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or $v.SUPABASE_STORAGE_BUCKET -cne 'meta-ads-phase08-isolated' -or $v.PHASE08_VERIFIED_ORIGIN -cne 'https://phase08-daily-data-sync-production.up.railway.app'){throw 'ISOLATED_TARGET'}
  $stage='STORAGE_GET';$headers=@{apikey=$v.SUPABASE_PUBLISHABLE_KEY;Authorization=('Bearer '+$v.SUPABASE_STORAGE_ACCESS_TOKEN)}
  $response=Invoke-WebRequest -Uri ($v.SUPABASE_URL+'/storage/v1/object/authenticated/meta-ads-phase08-isolated/health/readiness-sentinel') -Headers $headers -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  $storageStatus=[int]$response.StatusCode;$response=$null;$headers.Clear()
  $stage='PROTECTED_READY';$headers=@{'x-internal-probe-token'=$v.INTERNAL_PROBE_TOKEN}
  $sw=[Diagnostics.Stopwatch]::StartNew()
  $response=Invoke-WebRequest -Uri ($v.PHASE08_VERIFIED_ORIGIN+'/backend-api/health/ready') -Headers $headers -MaximumRedirection 0 -TimeoutSec 60 -SkipHttpErrorCheck
  $sw.Stop();$readyStatus=[int]$response.StatusCode
  if($readyStatus -ne 200 -or $storageStatus -ne 200){throw 'PROBE_STATUS'}
  $body=$response.Content|ConvertFrom-Json -AsHashtable
  if($body.status -cne 'ready' -or $body.releaseId -cne $v.RELEASE_GIT_SHA -or $body.runtimeConfigFingerprint -cnotmatch '^[a-f0-9]{64}$'){throw 'READY_IDENTITY'}
  $out=@{kind='PHASE10_EXISTING08_PROBE';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$r.serviceInstance.latestDeployment.id;releaseSha=$body.releaseId;runtimeConfigFingerprint=$body.runtimeConfigFingerprint;storageStatus=$storageStatus;readyStatus=$readyStatus;readyElapsedMs=$sw.ElapsedMilliseconds;appHttpRequests=1;storageGetRequests=1;newCandidate=$false;providerRequests=0;configurationWrites=0;businessWrites=0;productionWrites=0}
 }
 $bytes=[Text.Encoding]::UTF8.GetBytes(($out|ConvertTo-Json -Depth 20));$stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 $out|ConvertTo-Json -Depth 20
} catch {@{kind='PHASE10_ENVIRONMENT_READ_REJECTED';stage=$stage;rawSuppressed=$true;writes=0}|ConvertTo-Json;exit 1}
finally{if($headers){$headers.Clear()};$headers=$null;$v=$null;$r=$null;$response=$null;$body=$null}
