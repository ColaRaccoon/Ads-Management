param([ValidateSet('Run','ReviewLogs','Stop')][string]$Mode='Run')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$name='meta-ads-phase10-v5-1gb';$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/evidence'
$stage='START';$live=$null;$headers=$null;$created=$false
function Save-Container($value,[string]$label){$path=Join-Path $root ('container-v5-'+$label+'.json');$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Depth 15));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}
try {
 if($Mode -ceq 'Stop'){
  $id=(& docker inspect --format '{{.Id}}' $name).Trim();if($LASTEXITCODE -ne 0 -or $id -cnotmatch '^[a-f0-9]{64}$'){throw 'CONTAINER_IDENTITY'}
  & docker stop --time 15 $id | Out-Null;if($LASTEXITCODE -ne 0){throw 'STOP_FAILED'}
  $state=(& docker inspect --format '{{json .State}}' $id)|ConvertFrom-Json -AsHashtable
  $out=@{kind='PHASE10_LOCAL_CONTAINER_STOPPED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');name=$name;id=$id;running=$state.Running;exitCode=$state.ExitCode;oomKilled=$state.OOMKilled;containerPreserved=$true;dataDeleted=0};Save-Container $out 'stopped';$out|ConvertTo-Json;exit 0
 }
 $stage='ISOLATED_TARGET';$live=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' @{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
 $v=$live.variables
 if($v.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $v.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $v.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or $v.PHASE08_SOURCE_CONTENT_SHA256 -cne '68d245c1980c33b5e71dd3c52cd0f7000c30faee8ed90f6bb369fc430bb7ff6c' -or $v.RELEASE_GIT_SHA -cne 'f7c7a0232b6c94c1fcce2cc4f6b78b2792712950'){throw 'TARGET'}
 if($Mode -ceq 'ReviewLogs'){
  $logs=(& docker logs $name 2>&1|Out-String);$secretNames=@();$publicNames=@();$tested=0
  foreach($key in $v.Keys){if($v[$key].Length -ge 24){$sensitive=$key -cmatch '(?:SECRET|PASSWORD|TOKEN|_KEY(?:_|$)|CREDENTIAL|ADC_JSON|META_RECORD)';if($sensitive){$tested++};if($logs.Contains($v[$key])){if($sensitive){$secretNames+=$key}else{$publicNames+=$key}}}}
  $out=@{kind='PHASE10_LOCAL_LOG_REVIEW';observedAt=[DateTimeOffset]::UtcNow.ToString('o');name=$name;sensitiveVariablesTested=$tested;sensitiveMatches=$secretNames;nonSecretConfigurationMatches=$publicNames;rawLogsSaved=$false;scope='current literal protected runtime variable values; current returned local container logs';initialAllVariableScanWasOverbroad=$true;passed=($secretNames.Count -eq 0)}
  Save-Container $out 'log-review';$out|ConvertTo-Json -Depth 10;if($secretNames.Count){exit 1};exit 0
 }
 $stage='DOCKER_CREATE';$psi=[Diagnostics.ProcessStartInfo]::new('docker');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 foreach($a in @('create','--name',$name,'--memory','1000000000','--memory-swap','1000000000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--init','--tmpfs','/tmp:rw,noexec,nosuid,size=201326592','--publish','127.0.0.1:3200:8000')){$psi.ArgumentList.Add($a)}
 foreach($key in $v.Keys){if($key -cnotmatch '^[A-Z0-9_]+$'){throw 'ENV_NAME'};$psi.ArgumentList.Add('--env');$psi.ArgumentList.Add($key);$psi.Environment[$key]=[string]$v[$key]}
 $psi.Environment['PORT']='8000';$psi.ArgumentList.Add('meta-ads-phase10:f7c7a023')
 $child=[Diagnostics.Process]::Start($psi);$output=$child.StandardOutput.ReadToEndAsync();$errorOutput=$child.StandardError.ReadToEndAsync()
 if(-not $child.WaitForExit(30000)){$child.Kill($true);throw 'CREATE_TIMEOUT'}
 $id=$output.GetAwaiter().GetResult().Trim();$null=$errorOutput.GetAwaiter().GetResult();$exit=$child.ExitCode;$child.Dispose()
 if($exit -ne 0 -or $id -cnotmatch '^[a-f0-9]{64}$'){throw 'CREATE_FAILED'};$created=$true
 & docker start $id | Out-Null;if($LASTEXITCODE -ne 0){throw 'START_FAILED'}
 $stage='STARTUP_PUBLIC_PROXY';$status=0;$attempts=0;$sw=[Diagnostics.Stopwatch]::StartNew()
 do {Start-Sleep -Milliseconds 750;$attempts++;try{$response=Invoke-WebRequest 'http://127.0.0.1:3200/backend-api/health/live' -TimeoutSec 2 -SkipHttpErrorCheck;$status=[int]$response.StatusCode}catch{$status=0}}while($status -ne 200 -and $sw.ElapsedMilliseconds -lt 55000)
 $sw.Stop();if($status -ne 200){throw 'STARTUP_HTTP_FAILED'}
 $headers=@{'x-internal-probe-token'=$v.INTERNAL_PROBE_TOKEN};$ready=Invoke-WebRequest 'http://127.0.0.1:3200/backend-api/health/ready' -Headers $headers -TimeoutSec 30 -SkipHttpErrorCheck
 if([int]$ready.StatusCode -ne 200){throw 'READY_FAILED'};$body=$ready.Content|ConvertFrom-Json -AsHashtable
 if($body.releaseId -cne 'f7c7a0232b6c94c1fcce2cc4f6b78b2792712950'){throw 'IMAGE_RELEASE'}
 $inspect=(& docker inspect --format '{{json .HostConfig}}' $id)|ConvertFrom-Json -AsHashtable
 $state=(& docker inspect --format '{{json .State}}' $id)|ConvertFrom-Json -AsHashtable
 $stats=(& docker stats --no-stream --format '{{json .}}' $id)|ConvertFrom-Json -AsHashtable
 $logs=(& docker logs $id 2>&1|Out-String);$matched=$false
 foreach($key in $v.Keys){if($key -cmatch '(?:SECRET|PASSWORD|TOKEN|_KEY(?:_|$)|CREDENTIAL|ADC_JSON|META_RECORD)' -and $v[$key].Length -ge 24 -and $logs.Contains($v[$key])){$matched=$true}}
 $out=@{kind='PHASE10_ACTUAL_LOCAL_CLOUD_BUNDLE_1GB';observedAt=[DateTimeOffset]::UtcNow.ToString('o');name=$name;id=$id;commit=$body.releaseId;runtimeConfigFingerprint=$body.runtimeConfigFingerprint;publicProxyLive=$status;protectedReady=[int]$ready.StatusCode;startupMs=$sw.ElapsedMilliseconds;startupProbeAttempts=$attempts;memoryLimit=$inspect.Memory;memorySwap=$inspect.MemorySwap;readOnlyRoot=$inspect.ReadonlyRootfs;capDrop=$inspect.CapDrop;securityOpt=$inspect.SecurityOpt;pidsLimit=$inspect.PidsLimit;ports=$inspect.PortBindings;oomKilled=$state.OOMKilled;memoryUsage=$stats.MemUsage;memoryPercent=$stats.MemPerc;cpuPercent=$stats.CPUPerc;logSecretMatch=$matched;secretValuesReturned=0;providerRequests=0;businessWrites=0;environmentDiff=@{PORT='8000'};acceptance='startup<=60000ms;ready200;memoryLimit1000000000;OOMfalse;secretMatchfalse';mixedCollectionLoadVerified=$false}
 Save-Container $out 'running';$out|ConvertTo-Json -Depth 15
 if($matched){throw 'SECRET_MATCH'}
}catch{@{kind='PHASE10_LOCAL_CONTAINER_FAILED';stage=$stage;containerCreated=$created;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally{if($headers){$headers.Clear()};$headers=$null;$live=$null;$v=$null;$logs=$null;$response=$null;$ready=$null;$body=$null}
