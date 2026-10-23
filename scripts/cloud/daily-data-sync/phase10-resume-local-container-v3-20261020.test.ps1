$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-resume-local-container-v3-20261020.ps1"
$script:FakeId='a'*64;$script:FakeImage=$script:LocalImage;$script:Fingerprint='c'*64
$script:FakeVars=@{RELEASE_GIT_SHA=$script:LocalRelease;PHASE08_SOURCE_CONTENT_SHA256=$script:LocalSource;DAILY_SYNC_FEATURE_ENABLED='true';DAILY_SYNC_SCHEDULE_ENABLED='false';PRISMA_CONNECTION_LIMIT='3';HEAVY_OPERATION_CONCURRENCY='1';INTERNAL_PROBE_TOKEN='SYNTHETIC_PRIVATE_PROBE_TOKEN_123456789'}
$script:HeldBody=@{db='postgres';principal='postgres';readonly='on';login=$true;stopped=$true;paused=3;schedules=3;jobs=149;active_jobs=0;connections=3;enabled=0;live_leases=0;running_runs=0;held_grants=0}
function Assert-Test($v,[string]$Name){if(-not $v){throw "SYNTHETIC_TEST_FAILED_$Name"}}
function Read-IncidentPrivate([string]$Name){Assert-Test ($Name -ceq 'resume-20261020-v3') 'V3_ONLY';$vars=$script:FakeVars.Clone();if($script:Case -ceq 'bad-plan'){$vars.RELEASE_GIT_SHA='d'*40};$deadline=$script:Clock.AddMinutes(10).ToString('o');if($script:Case -ceq 'expired'){$deadline=$script:Clock.AddMinutes(-1).ToString('o')};$script:Deadline=$deadline;return @{after=$vars;eligibleSecretRollback=$false;testDeadline=$deadline}}
function Get-LocalCustom { $v=$script:FakeVars.Clone();if($script:Case -ceq 'drift'){$v.RELEASE_GIT_SHA='e'*40};return $v }
function Get-IncidentState { return @{variables=$script:FakeVars.Clone()} }
function Invoke-Phase08Management([string]$Action,[string]$Query){Assert-Test ($Action -ceq 'Query') 'QUERY_ACTION';Assert-Test ($Query.Contains('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;')) 'READ_ONLY_SQL';$r=$script:HeldBody.Clone();if($script:Case -ceq 'no-login'){$r.login=$false};if($script:Case -ceq 'wrong-principal'){$r.principal='phase08_runtime'};return $r}
function Get-Content { return (@{kind='BOUNDED_ACTIVATED';fingerprint=$script:Fingerprint;testDeadline=$script:Deadline;featureOnForPublishedReadsOnly=$true;scheduleEnabled=$false}|ConvertTo-Json -Compress) }
function Test-Path { return $false }
function Start-Sleep { }
function Save-LocalReceipt($v){$script:Saved=$v}
function Get-LocalTestNow { return $script:Clock }
function Start-LocalProtected([string]$Id,$Variables,[string]$Deadline){Assert-Test ($Id -ceq $script:FakeId -and $Variables.INTERNAL_PROBE_TOKEN -ceq $script:FakeVars.INTERNAL_PROBE_TOKEN -and $Deadline -ceq $script:Deadline) 'STDIN_ONLY';if($script:Case -ceq 'expired-before-http'){$script:Clock=$script:Clock.AddMinutes(11)};return $null}
function Invoke-WebRequest([string]$Uri,$Headers){
 $script:HttpCalls++
 if($Uri.EndsWith('/live')){return @{StatusCode=200;Content='{"status":"live"}'}}
 Assert-Test ($Headers['x-internal-probe-token'] -ceq $script:FakeVars.INTERNAL_PROBE_TOKEN) 'PROTECTED_PROBE'
 return @{StatusCode=$(if($script:Case -ceq 'ready-fail'){503}else{200});Content=(@{status='ready';releaseId=$script:LocalRelease;runtimeConfigFingerprint=$script:Fingerprint}|ConvertTo-Json -Compress)}
}
function Invoke-LocalDocker([string[]]$Arguments,$Variables=$null){
 $script:Calls+=,@($Arguments)
 $reply=@{exit=0;text='';errorText=''}
 if($Arguments[0] -ceq 'image'){$reply.text=$script:FakeImage+'|'+$script:LocalRelease}
 elseif($Arguments[0] -ceq 'create'){
  Assert-Test (-not ($Arguments -ccontains $script:FakeVars.INTERNAL_PROBE_TOKEN)) 'NO_SECRET_ARGV';Assert-Test (-not ($Arguments -ccontains '--env')) 'NO_DOCKER_ENV';Assert-Test ($Arguments -ccontains 'compress=false') 'LOG_COMPRESS_FALSE';Assert-Test ($Arguments -ccontains '1000000000') 'MEMORY_BOUND';Assert-Test ($Arguments -ccontains '127.0.0.1:3200:8000') 'LOOPBACK_BIND';Assert-Test ($Arguments[-4] -ceq $script:FakeImage) 'IMMUTABLE_IMAGE_ID'
  $label=@($Arguments|Where-Object{$_ -clike 'phase10.local-owner=*'})[0];$script:Nonce=$label.Split('=')[1];$reply.text=$script:FakeId
 }
 elseif($Arguments[0] -ceq 'container'){if($script:Case -ceq 'occupied' -and ($Arguments -join ' ').Contains('name=')){$reply.text='older-container'}}
 elseif($Arguments[0] -ceq 'exec'){$reply.text=@{sourceFileMatches=$true;dockerEnvironmentHasProtectedSecretNames=$false;memoryCurrentBytes=123456;memoryPeakBytes=234567}|ConvertTo-Json -Compress}
 elseif($Arguments[0] -ceq 'inspect'){
  if($Arguments[2] -ceq '{{.State.Error}}'){$reply.text='OCI runtime create failed: logging driver failed'}
  elseif($Arguments[2].Contains('HostConfig')){$reply.text=@{memory=1000000000;memorySwap=1000000000;nanoCpus=1000000000;readOnly=$true;pids=256;capDrop=@('ALL');securityOpt=@('no-new-privileges');ports=@{'8000/tcp'=@(@{HostIp='127.0.0.1';HostPort='3200'})};running=$true;oomKilled=$false}|ConvertTo-Json -Depth 10 -Compress}
  elseif($Arguments[2].Contains('openStdin')){$reply.text=@{openStdin=($script:Case -cne 'closed-stdin');stdinOnce=$false;attachStdin=$true;running=$true;exitCode=0;oomKilled=$false}|ConvertTo-Json -Compress}
  else{$owner=if($script:Case -ceq 'wrong-owner'){'someone-else'}else{$script:Nonce};$reply.text=$script:FakeId+'|'+$owner+'|'+$script:FakeImage}
 }
 elseif($Arguments[0] -ceq 'logs'){$reply.text='PHASE10_LOCAL_RUNTIME_PROOF '+(@{imageReleaseMatches=$true;sourceMatches=$true;sourceFileMatches=$true;pool3=$true;heavy1=$true;featureOn=$true;scheduleOff=$true;runtimeConfigFingerprint=$script:Fingerprint}|ConvertTo-Json -Compress)+"`n";if($script:Case -ceq 'secret-stderr'){$reply.errorText=$script:FakeVars.INTERNAL_PROBE_TOKEN}}
 elseif($Arguments[0] -ceq 'stop'){Assert-Test ($Arguments[-1] -ceq $script:FakeId) 'STOP_OWN_ONLY';if($script:Case -ceq 'stop-throws'){throw 'SYNTHETIC_STOP_FAILURE'}}
 elseif($Arguments[0] -ceq 'rm'){Assert-Test ($Arguments[-1] -ceq $script:FakeId) 'REMOVE_OWN_ONLY'}
 return $reply
}
$count=0
foreach($case in @('no-load-confirmation','bad-plan','drift','no-login','wrong-principal','occupied','expired','expired-before-http','closed-stdin','ready-fail','secret-stderr','wrong-owner','stop-throws','success')){
 $script:Case=$case;$script:Clock=[DateTimeOffset]::UtcNow;$script:HttpCalls=0;$script:Calls=@();$script:Saved=$null;$script:Nonce='';$result=Invoke-Phase10ResumeLocalContainer ($case -cne 'no-load-confirmation')
 $stops=@($script:Calls|Where-Object{$_[0] -ceq 'stop'}).Count;$removes=@($script:Calls|Where-Object{$_[0] -ceq 'rm'}).Count
 if($case -ceq 'success'){Assert-Test $result.passed 'SUCCESS';Assert-Test ($stops -eq 1 -and $removes -eq 1 -and $result.safeResult.cleanup.removed) 'SUCCESS_CLEANUP'}
 else{Assert-Test (-not $result.passed) 'FAIL_CLOSED';if($case -cin @('ready-fail','secret-stderr','stop-throws','expired-before-http','closed-stdin')){Assert-Test ($stops -eq 1 -and $removes -eq 1) 'FAILURE_CLEANUP'}elseif($case -ceq 'wrong-owner'){Assert-Test ($stops -eq 0 -and $removes -eq 0 -and $result.safeResult.status -ceq 'FAIL_CLEANUP') 'UNRELATED_OWNER_UNTOUCHED'}else{Assert-Test ($stops -eq 0 -and $removes -eq 0) 'NO_UNOWNED_DELETE'}}
 if($case -cin @('expired','expired-before-http')){Assert-Test ($script:HttpCalls -eq 0) 'EXPIRED_NO_APP_HTTP'}
 Assert-Test (-not (($result|ConvertTo-Json -Depth 20 -Compress).Contains($script:FakeVars.INTERNAL_PROBE_TOKEN))) 'NO_SECRET_OUTPUT';$count++
}
$diagnostic=Get-LocalSafeDiagnostic ("PHASE10_LOCAL_WRAPPER_STAGE DATA_RECEIVED`nPHASE10_LOCAL_WRAPPER_STAGE FRAME_COMPLETE`nPHASE10_LOCAL_WRAPPER_FAILURE PREPARE`n"+$script:FakeVars.INTERNAL_PROBE_TOKEN) $script:FakeVars
Assert-Test ($diagnostic.stages.Count -eq 2 -and $diagnostic.failureStages[0] -ceq 'PREPARE' -and $diagnostic.literalSecretMatches -eq 1) 'FIXED_DIAGNOSTIC_PROJECTION'
Assert-Test (-not (($diagnostic|ConvertTo-Json -Compress).Contains($script:FakeVars.INTERNAL_PROBE_TOKEN))) 'DIAGNOSTIC_RAW_ZERO';$count++
foreach($pair in @(@('OCI runtime create failed','OCI_RUNTIME'),@('permission denied','PERMISSION_DENIED'),@('argument list too long','ARGUMENT_SIZE'),@('failed to initialize logging driver','LOG_DRIVER'),@('read-only file system','READ_ONLY_MOUNT'))){$c=Get-LocalStartErrorClassification ($pair[0]+' '+$script:FakeVars.INTERNAL_PROBE_TOKEN);Assert-Test ($c.categories -ccontains $pair[1]) 'SAFE_CLASS';Assert-Test (-not (($c|ConvertTo-Json -Compress).Contains($script:FakeVars.INTERNAL_PROBE_TOKEN))) 'CLASS_RAW_ZERO';$count++}
@{kind='PHASE10_RESUME_LOCAL_CONTAINER_SYNTHETIC_TESTS';pass=$count;fail=0;dockerCommandsExecuted=0;remoteRequests=0;protectedMaterialRead=0;actualContainerRun=$false}|ConvertTo-Json -Compress
