param([switch]$NoConcurrentCloudLoad)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$script:LocalTag='meta-ads-phase10:20261020-v3';$script:LocalName='meta-ads-phase10-20261020-recheck2-1gb'
$script:LocalRelease='68e64b3d7156e3af81db421e5eb61b85b0fcf21b'
$script:LocalSource='7dd0bd3275619a427db78a56580e56836fd8cd919e475057eda77bf21e485d84'
$script:LocalImage='sha256:d26c57619dfbc9709c62d2f1d066343a8a8a02f7410fa33c5ff28ac2899d1fb3'
$script:LocalReceipt='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v2/local-container.json'
function Invoke-LocalDocker([string[]]$Arguments){
 $s=[Diagnostics.ProcessStartInfo]::new('docker');$s.UseShellExecute=$false;$s.CreateNoWindow=$true;$s.RedirectStandardOutput=$true;$s.RedirectStandardError=$true
 foreach($a in $Arguments){$s.ArgumentList.Add($a)}
 $p=[Diagnostics.Process]::new();$p.StartInfo=$s
 try{[void]$p.Start();$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();if(-not $p.WaitForExit(30000)){$p.Kill($true);throw 'LOCAL_DOCKER_TIMEOUT'};$out=$o.GetAwaiter().GetResult();$err=$e.GetAwaiter().GetResult();if($out.Length+$err.Length -gt 4194304){throw 'LOCAL_OUTPUT_BOUND'};return @{exit=$p.ExitCode;text=$out;errorText=$err}}
 finally{$err=$null;if($null -ne $p){$p.Dispose()}}
}
function Start-LocalProtected([string]$Id,$Variables,[string]$Deadline){
 $s=[Diagnostics.ProcessStartInfo]::new('docker');$s.UseShellExecute=$false;$s.CreateNoWindow=$true;$s.RedirectStandardInput=$true;$s.RedirectStandardOutput=$true;$s.RedirectStandardError=$true
 foreach($a in @('start','--attach','--interactive',$Id)){$s.ArgumentList.Add($a)}
 $p=[Diagnostics.Process]::new();$p.StartInfo=$s;$wire=$null
 try{[void]$p.Start();$capture=@{process=$p;stdout=$p.StandardOutput.ReadToEndAsync();stderr=$p.StandardError.ReadToEndAsync()};$wire=@{env=$Variables;testDeadline=$Deadline}|ConvertTo-Json -Depth 35 -Compress;if([Text.Encoding]::UTF8.GetByteCount($wire)+1 -gt 2097152){throw 'LOCAL_STDIN_BOUND'};$p.StandardInput.Write($wire+"`n");$p.StandardInput.Close();return $capture}
 catch{if(-not $p.HasExited){$p.Kill($true)};$p.Dispose();throw 'LOCAL_PROTECTED_START_FAILED'}
 finally{$wire=$null}
}
function Get-LocalTestNow { return [DateTimeOffset]::UtcNow }
function Assert-LocalTestDeadline([string]$Deadline){$until=[DateTimeOffset]::Parse($Deadline);$remaining=$until-(Get-LocalTestNow);if($remaining.TotalSeconds -lt 1 -or $remaining.TotalMinutes -gt 20){throw 'LOCAL_TEST_WINDOW_EXPIRED_OR_INVALID'}}
function Get-LocalHttpTimeout([string]$Deadline,[int]$Maximum){Assert-LocalTestDeadline $Deadline;$seconds=[int][Math]::Floor(([DateTimeOffset]::Parse($Deadline)-(Get-LocalTestNow)).TotalSeconds);if($seconds -lt 1){throw 'LOCAL_TEST_WINDOW_EXPIRED'};return [Math]::Min($Maximum,$seconds)}
function Get-LocalStartErrorClassification([string]$Text){
 $categories=@()
 foreach($entry in @(
  @('EXECUTABLE_NOT_FOUND','executable file not found|no such file or directory|exec:.*not found'),
  @('PERMISSION_DENIED','permission denied|operation not permitted|access is denied'),
  @('READ_ONLY_MOUNT','read.only file system|read.only mount|EROFS'),
  @('NETWORK_PORT','port is already allocated|address already in use|failed programming external connectivity'),
  @('EXEC_FORMAT','exec format error|executable format'),
  @('ARGUMENT_SIZE','argument list too long|E2BIG|command line is too long'),
  @('CLI_IO_ATTACH','stdin|attach|input device|broken pipe'),
  @('LOG_DRIVER','logging driver|log.driver|log option'),
  @('LOG_DRIVER_COMPRESSION_SINGLE_FILE','compression.*max file count.*1'),
  @('OCI_RUNTIME','OCI runtime|failed to create task|container init|runc create')
 )){if([regex]::IsMatch($Text,$entry[1],[Text.RegularExpressions.RegexOptions]::IgnoreCase)){$categories+=$entry[0]}}
 if($categories.Count -eq 0){$categories=@($(if($Text.Length -eq 0){'EMPTY'}else{'UNCLASSIFIED_HIDDEN_TEXT'}))}
 return @{categories=$categories;utf8Bytes=[Text.Encoding]::UTF8.GetByteCount($Text);rawValuesReturned=0}
}
function Get-LocalSafeDiagnostic([string]$Text,$Variables){
 $allowed=@('FRAME','DATA_RECEIVED','FRAME_COMPLETE','PARSE','TTL','PREPARE','CONFIG','LAUNCH','RUNNING','CLEANUP');$stages=@();$failures=@();$literal=0
 foreach($m in [regex]::Matches($Text,'(?m)^PHASE10_LOCAL_WRAPPER_(STAGE|FAILURE) ([A-Z_]{1,32})\r?$')){if($m.Groups[2].Value -cin $allowed){if($m.Groups[1].Value -ceq 'STAGE'){$stages+=$m.Groups[2].Value}else{$failures+=$m.Groups[2].Value}}}
 if($null -ne $Variables){foreach($key in $Variables.Keys){$value=[string]$Variables[$key];if($key -cmatch '(?:SECRET|PASSWORD|TOKEN|_KEY(?:_|$)|CREDENTIAL|ADC_JSON|META_RECORD|DATABASE_URL)' -and $value.Length -ge 16 -and $Text.Contains($value)){$literal++}}}
 return @{stages=@($stages|Select-Object -Unique);failureStages=@($failures|Select-Object -Unique);runtimeMarkerPresent=$Text.Contains('PHASE10_LOCAL_RUNTIME_PROOF ');literalSecretMatches=$literal;rawValuesReturned=0;rawLogsSaved=$false}
}
function Get-LocalCustom { (Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope).variables }
function Get-LocalHeld {
 $q=@'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT current_database() AS db,current_user AS principal,current_setting('transaction_read_only') AS readonly,
(SELECT rolcanlogin FROM pg_roles WHERE rolname='phase08_runtime') AS login,
(SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton AND target_id='phase08-full-app') AS stopped,
(SELECT count(*)::int FROM daily_data_sync_ops.schedules WHERE paused) AS paused,
(SELECT count(*)::int FROM daily_data_sync_ops.schedules) AS schedules,
(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%') AS jobs,
(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS active_jobs,
(SELECT count(*)::int FROM phase08_meta_ads.source_connections) AS connections,
(SELECT count(*)::int FROM phase08_meta_ads.source_connections WHERE enabled) AS enabled,
(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS live_leases,
(SELECT count(*)::int FROM phase08_meta_ads.sync_runs WHERE status='RUNNING') AS running_runs,
(SELECT count(*)::int FROM unnest(ARRAY['source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints']) AS t(name) WHERE has_table_privilege('phase08_runtime',format('phase08_meta_ads.%I',name),'SELECT,INSERT,UPDATE,DELETE')) AS held_grants;
COMMIT;
'@
 $r=@(Invoke-Phase08Management -Action Query -Query $q);if($r.Count -ne 1){throw 'LOCAL_HELD_SHAPE'};return $r[0]
}
function Assert-LocalHeld($r){if($r.db -cne 'postgres' -or $r.principal -cne 'postgres' -or $r.readonly -cne 'on' -or $r.login -cne $true -or $r.stopped -cne $true -or $r.paused -ne 3 -or $r.schedules -ne 3 -or $r.jobs -ne 149 -or $r.active_jobs -ne 0 -or $r.connections -ne 3 -or $r.enabled -ne 0 -or $r.live_leases -ne 0 -or $r.running_runs -ne 0 -or $r.held_grants -ne 0){throw 'LOCAL_HELD_GUARD'}}
function Save-LocalReceipt($v){$f=[IO.File]::Open($script:LocalReceipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$b=[Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Depth 20));$f.Write($b,0,$b.Length);$f.Flush($true)}finally{$f.Dispose()}}
function Invoke-Phase10ResumeLocalContainer([bool]$CloudLoadStopped){
 $stage='START';$plan=$null;$live=$null;$v=$null;$h=$null;$logs=$null;$capture=$null;$attempted=$false;$created=$false;$id=$null;$image=$null;$nonce=[Guid]::NewGuid().ToString('N');$pass=$false
 $cleanup=@{ownerVerified=$false;removed=$false;stopExit=$null;removeExit=$null}
 $result=@{kind='PHASE10_RESUME_LOCAL_CANDIDATE_1GB';status='FAIL';startedAt=[DateTimeOffset]::UtcNow.ToString('o');tag=$script:LocalTag;release=$script:LocalRelease;source=$script:LocalSource;rawValuesReturned=0;rawLogsSaved=$false;fullInspectCalls=0;providerRequests=0;credentialRefreshes=0;remoteMutations=0;businessWrites=0;actualImageSwitch=$false}
 try{
  if(-not $CloudLoadStopped){throw 'CLOUD_LOAD_MUST_BE_STOPPED'};if(Test-Path -LiteralPath $script:LocalReceipt){throw 'LOCAL_RECEIPT_CONSUMED'}
  $stage='PROTECTED_PLAN';$plan=Read-IncidentPrivate 'performance-recheck-20261020-v2'
  if($plan.after.RELEASE_GIT_SHA -cne $script:LocalRelease -or $plan.after.PHASE08_SOURCE_CONTENT_SHA256 -cne $script:LocalSource -or $plan.eligibleSecretRollback -cne $false){throw 'LOCAL_PLAN_PINS'}
  $stage='TEST_DEADLINE';$deadline=[string]$plan.testDeadline;Assert-LocalTestDeadline $deadline
  $stage='FRESH_CUSTOM_ENV';Assert-IncidentVarsEqual (Get-LocalCustom) $plan.after
  $stage='FRESH_RENDERED_ENV';$live=Get-IncidentState;$v=$live.variables
  if($v.RELEASE_GIT_SHA -cne $script:LocalRelease -or $v.PHASE08_SOURCE_CONTENT_SHA256 -cne $script:LocalSource -or $v.DAILY_SYNC_FEATURE_ENABLED -cne 'true' -or $v.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false' -or $v.PRISMA_CONNECTION_LIMIT -cne '3' -or $v.HEAVY_OPERATION_CONCURRENCY -cne '1'){throw 'LOCAL_RUNTIME_PINS'}
  foreach($k in @('DAILY_SYNC_CREDENTIAL_KEY_V1','PHASE08_GOOGLE_ADC_JSON_B64','PHASE08_META_RECORD_B64','DAILY_SYNC_META_VAULT_KEY','DAILY_SYNC_CAFE24_CLIENT_SECRET','PHASE08_META_CATALOG_GZIP_B64','PHASE08_META_REPORT_SCHEMA_GZIP_B64','PHASE08_META_CATALOG_JSON_B64','PHASE08_META_REPORT_SCHEMA_JSON_B64')){if($v.ContainsKey($k)){throw 'LOCAL_RETIRED_ENV_PRESENT'}}
  $a=Get-Content 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v2/activated-read.json' -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  if($a.kind -cne 'BOUNDED_ACTIVATED' -or $a.fingerprint -cnotmatch '^[a-f0-9]{64}$' -or $a.testDeadline -cne $deadline -or $a.featureOnForPublishedReadsOnly -cne $true -or $a.scheduleEnabled -cne $false){throw 'LOCAL_ACTIVATION_PROOF'}
  $stage='HELD_GUARD';$heldBefore=Get-LocalHeld;Assert-LocalHeld $heldBefore
  $stage='IMAGE_PIN';$r=Invoke-LocalDocker @('image','inspect','--format','{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}',$script:LocalTag);$pins=$r.text.Trim().Split('|')
  if($r.exit -ne 0 -or $pins.Count -ne 2 -or $pins[0] -cne $script:LocalImage -or $pins[1] -cne $script:LocalRelease){throw 'LOCAL_IMAGE_PIN'};$image=$pins[0]
  $stage='NAME_UNUSED';$r=Invoke-LocalDocker @('container','ls','--all','--filter',"name=^/$($script:LocalName)$",'--format','{{.ID}}');if($r.exit -ne 0 -or $r.text.Trim().Length){throw 'LOCAL_NAME_OCCUPIED'}
  $bootstrap=[IO.File]::ReadAllText("$PSScriptRoot/phase10-local-recheck2-bootstrap-20261020.cjs");$bootstrapHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($bootstrap))).ToLowerInvariant();if($bootstrapHash -cne '5f42645c15b3fd2da92b23b5295d6fba13e1a2d88c6a6cf0f53daffcf3a4becf'){throw 'LOCAL_BOOTSTRAP_SOURCE_PIN'};$program=$bootstrap+"`nrunProtectedBootstrap();";$bootstrap=$null;$result.bootstrapSha256=$bootstrapHash
  $createArguments=[Collections.Generic.List[string]]::new();foreach($arg in @('create','--name',$script:LocalName,'--label',"phase10.local-owner=$nonce",'--interactive','--attach','stdin','--attach','stdout','--attach','stderr','--memory','1000000000','--memory-swap','1000000000','--cpus','1','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--init','--tmpfs','/tmp:rw,noexec,nosuid,size=201326592','--publish','127.0.0.1:3200:8000','--log-driver','local','--log-opt','max-size=1m','--log-opt','max-file=1','--log-opt','compress=false',$image,'node','-e',$program)){$createArguments.Add($arg)}
  $stage='CREATE';$attempted=$true;$r=Invoke-LocalDocker $createArguments.ToArray();$id=$r.text.Trim();if($r.exit -ne 0 -or $id -cnotmatch '^[a-f0-9]{64}$'){throw 'LOCAL_CREATE_FAILED'};$created=$true
  $stage='OPEN_STDIN_GUARD';$r=Invoke-LocalDocker @('inspect','--format','{"openStdin":{{.Config.OpenStdin}},"stdinOnce":{{.Config.StdinOnce}},"attachStdin":{{.Config.AttachStdin}},"running":{{.State.Running}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}}}',$id);if($r.exit -ne 0){throw 'LOCAL_OPEN_STDIN_INSPECT'};$createdState=$r.text|ConvertFrom-Json -AsHashtable;if($createdState.openStdin -cne $true){throw 'LOCAL_OPEN_STDIN_REQUIRED'};$result.createdState=$createdState
  $stage='PROTECTED_STDIN_START';Assert-LocalTestDeadline $deadline;$capture=Start-LocalProtected $id $v $deadline
  $stage='PUBLIC_LIVE';$status=0;$attempts=0;$timer=[Diagnostics.Stopwatch]::StartNew()
  do{if($null -ne $capture -and $capture.process.HasExited){$stage='CLIENT_EXIT_BEFORE_LIVE';throw 'LOCAL_START_CLIENT_EXITED'};Start-Sleep -Milliseconds 750;Assert-LocalTestDeadline $deadline;$attempts++;try{$response=Invoke-WebRequest 'http://127.0.0.1:3200/backend-api/health/live' -TimeoutSec (Get-LocalHttpTimeout $deadline 2) -MaximumRedirection 0 -SkipHttpErrorCheck;$status=[int]$response.StatusCode;if($status -eq 200 -and ($response.Content|ConvertFrom-Json -AsHashtable).status -cne 'live'){$status=0}}catch{$status=0}}while($status -ne 200 -and $timer.ElapsedMilliseconds -lt 55000)
  $timer.Stop();if($status -ne 200 -or $timer.ElapsedMilliseconds -gt 60000){throw 'LOCAL_LIVE_TIMEOUT'}
  $stage='PROTECTED_READY';Assert-LocalTestDeadline $deadline;$h=@{'x-internal-probe-token'=$v.INTERNAL_PROBE_TOKEN};$ready=Invoke-WebRequest 'http://127.0.0.1:3200/backend-api/health/ready' -Headers $h -TimeoutSec (Get-LocalHttpTimeout $deadline 30) -MaximumRedirection 0 -SkipHttpErrorCheck
  if([int]$ready.StatusCode -ne 200){throw 'LOCAL_READY_HTTP'};$body=$ready.Content|ConvertFrom-Json -AsHashtable
  if($body.status -cne 'ready' -or $body.releaseId -cne $script:LocalRelease -or $body.runtimeConfigFingerprint -cne $a.fingerprint){throw 'LOCAL_READY_TUPLE'}
  $stage='RUNTIME_IMAGE_PROOF';$code="const f=require('fs');const n=p=>{try{return Number(f.readFileSync(p,'utf8').trim())}catch{return null}};process.stdout.write(JSON.stringify({sourceFileMatches:f.readFileSync('/srv/app/phase08-source-content-sha256','utf8').trim()==='7dd0bd3275619a427db78a56580e56836fd8cd919e475057eda77bf21e485d84',dockerEnvironmentHasProtectedSecretNames:Object.keys(process.env).some(k=>/(?:SECRET|PASSWORD|TOKEN|CREDENTIAL_KEY|CHECKPOINT_KEY|OBSERVATION_KEY|DATABASE_URL)/.test(k)),memoryCurrentBytes:n('/sys/fs/cgroup/memory.current'),memoryPeakBytes:n('/sys/fs/cgroup/memory.peak')}));"
  $r=Invoke-LocalDocker @('exec',$id,'node','-e',$code);if($r.exit -ne 0){throw 'LOCAL_RUNTIME_PROOF'};$proof=$r.text|ConvertFrom-Json -AsHashtable
  if($proof.sourceFileMatches -cne $true -or $proof.dockerEnvironmentHasProtectedSecretNames -cne $false){throw 'LOCAL_DOCKER_ENVIRONMENT'}
  $stage='BOUNDED_INSPECT';$fmt='{"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"readOnly":{{.HostConfig.ReadonlyRootfs}},"pids":{{.HostConfig.PidsLimit}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"ports":{{json .HostConfig.PortBindings}},"running":{{.State.Running}},"oomKilled":{{.State.OOMKilled}}}'
  $r=Invoke-LocalDocker @('inspect','--format',$fmt,$id);if($r.exit -ne 0){throw 'LOCAL_INSPECT_FAILED'};$resource=$r.text|ConvertFrom-Json -AsHashtable
  if($resource.memory -ne 1000000000 -or $resource.memorySwap -ne 1000000000 -or $resource.nanoCpus -ne 1000000000 -or $resource.readOnly -cne $true -or $resource.running -cne $true -or $resource.oomKilled -cne $false -or $resource.pids -ne 256 -or 'ALL' -cnotin $resource.capDrop -or 'no-new-privileges' -cnotin $resource.securityOpt){throw 'LOCAL_RESOURCE_GUARD'}
  $bindings=@($resource.ports['8000/tcp']);if($bindings.Count -ne 1 -or $bindings[0].HostIp -cne '127.0.0.1' -or $bindings[0].HostPort -cne '3200' -or @($resource.ports.Keys).Count -ne 1){throw 'LOCAL_PORT_GUARD'}
  $stage='LOG_SCAN_MEMORY_ONLY';$r=Invoke-LocalDocker @('logs','--tail','2000',$id);if($r.exit -ne 0){throw 'LOCAL_LOG_SCAN_FAILED'};$logs=$r.text+$r.errorText;$secretMatches=@();$tested=0
  foreach($k in $v.Keys){$value=[string]$v[$k];if($k -cmatch '(?:SECRET|PASSWORD|TOKEN|_KEY(?:_|$)|CREDENTIAL|ADC_JSON|META_RECORD|DATABASE_URL)' -and $value.Length -ge 16){$tested++;if($logs.Contains($value)){$secretMatches+=$k}}};if($secretMatches.Count){throw 'LOCAL_SECRET_LOG_MATCH'}
  $marker=[regex]::Matches($logs,'(?m)^PHASE10_LOCAL_RUNTIME_PROOF (\{[^\r\n]{1,2000}\})\r?$');if($marker.Count -ne 1){throw 'LOCAL_RUNTIME_MARKER'};$runtime=$marker[0].Groups[1].Value|ConvertFrom-Json -AsHashtable
  foreach($k in @('imageReleaseMatches','sourceMatches','sourceFileMatches','pool3','heavy1','featureOn','scheduleOff')){if($runtime[$k] -cne $true){throw 'LOCAL_RUNTIME_MARKER'}};if($runtime.runtimeConfigFingerprint -cne $body.runtimeConfigFingerprint){throw 'LOCAL_RUNTIME_FINGERPRINT'}
  $stage='POST_HELD_ENV';$heldAfter=Get-LocalHeld;Assert-LocalHeld $heldAfter;Assert-IncidentVarsEqual (Get-LocalCustom) $plan.after
  $result.containment=@{before=$heldBefore;after=$heldAfter}
  $result.testDeadline=$deadline;$result.featureOnForPublishedReadsOnly=$true;$result.normalResume=$false
  $result.status='PASS';$result.imageId=$image;$result.publicLive=$status;$result.protectedReady=[int]$ready.StatusCode;$result.runtimeConfigFingerprint=$body.runtimeConfigFingerprint;$result.startupMs=$timer.ElapsedMilliseconds;$result.startupAttempts=$attempts;$result.resources=$resource;$result.runtimeProof=$proof;$result.wrapperProof=$runtime;$result.secretsInDockerConfigEnvironment=0;$result.secretDelivery='PROTECTED_STDIN_MEMORY_ONLY';$result.literalSecretScan=@{tested=$tested;matches=0;rawLogsSaved=$false};$result.environmentDiff=@{PORT='8000'};$result.cloudLoadStoppedIsOperatorClaim=$true;$result.rssMeasured=$false;$result.mixedCollectionLoadVerified=$false;$pass=$true
 }catch{$result.status='FAIL';$result.failedStage=$stage;$result.rawErrorSuppressed=$true}
 finally{
  if($attempted){try{
   $r=Invoke-LocalDocker @('inspect','--format','{{.Id}}|{{index .Config.Labels "phase10.local-owner"}}|{{.Image}}',$script:LocalName)
   if($r.exit -eq 0){
    $claim=$r.text.Trim().Split('|');if($claim.Count -ne 3 -or $claim[0] -cnotmatch '^[a-f0-9]{64}$' -or $claim[1] -cne $nonce -or $claim[2] -cne $image){throw 'LOCAL_CLEANUP_OWNER'};$cleanup.ownerVerified=$true;$id=$claim[0]
    try{$errorReply=Invoke-LocalDocker @('inspect','--format','{{.State.Error}}',$id);if($errorReply.exit -eq 0){$result.safeStateError=Get-LocalStartErrorClassification $errorReply.text};$errorReply=$null}catch{$result.stateErrorDiagnosticUnavailable=$true}
    try{$stateReply=Invoke-LocalDocker @('inspect','--format','{"openStdin":{{.Config.OpenStdin}},"stdinOnce":{{.Config.StdinOnce}},"attachStdin":{{.Config.AttachStdin}},"running":{{.State.Running}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}}}',$id);if($stateReply.exit -eq 0){$result.beforeStopState=$stateReply.text|ConvertFrom-Json -AsHashtable};$logReply=Invoke-LocalDocker @('logs','--tail','2000',$id);if($logReply.exit -eq 0){$result.safeContainerDiagnostic=Get-LocalSafeDiagnostic ($logReply.text+$logReply.errorText) $v};$stateReply=$null;$logReply=$null}catch{$result.safeDiagnosticUnavailable=$true}
    try{$stop=Invoke-LocalDocker @('stop','--time','15',$id);$cleanup.stopExit=$stop.exit}
    catch{$cleanup.stopExit='SAFE_FAILURE'}
    finally{$rm=Invoke-LocalDocker @('rm','--force',$id);$cleanup.removeExit=$rm.exit}
    if($rm.exit -ne 0){throw 'LOCAL_REMOVE_FAILED'};$check=Invoke-LocalDocker @('container','ls','--all','--filter',"id=$id",'--format','{{.ID}}');$cleanup.removed=$check.exit -eq 0 -and $check.text.Trim().Length -eq 0
   }
   elseif($created){throw 'LOCAL_CREATED_CONTAINER_NOT_INSPECTABLE'}
  }catch{$cleanup.safeFailure=$true;$pass=$false;$result.status='FAIL_CLEANUP'}}
  if($created -and (-not $cleanup.removed -or $cleanup.stopExit -ne 0)){$pass=$false;$result.status='FAIL_CLEANUP'}
  if($null -ne $capture){try{if(-not $capture.process.WaitForExit(15000)){$capture.process.Kill($true)};$discardOut=$capture.stdout.GetAwaiter().GetResult();$discardErr=$capture.stderr.GetAwaiter().GetResult();$result.attachedClientExitCode=$capture.process.ExitCode;$result.safeAttachedDiagnostic=Get-LocalSafeDiagnostic ($discardOut+$discardErr) $v;$result.safeAttachedError=Get-LocalStartErrorClassification $discardErr}catch{$result.captureCleanupFailed=$true;$pass=$false;$result.status='FAIL_CLEANUP'}finally{$capture.process.Dispose();$discardOut=$null;$discardErr=$null;$capture=$null}}
  foreach($diagnosticName in @('safeContainerDiagnostic','safeAttachedDiagnostic')){if($result.ContainsKey($diagnosticName) -and $result[$diagnosticName].literalSecretMatches -gt 0){$pass=$false;$result.status='FAIL_SECRET_LOG'}}
  if($result.ContainsKey('beforeStopState') -and $result.beforeStopState.oomKilled -ceq $true){$pass=$false;$result.status='FAIL_OOM'}
  $result.cleanup=$cleanup;$result.endedAt=[DateTimeOffset]::UtcNow.ToString('o');$result.dataDeleted=0;$result.oldContainersTouched=0
  try{Save-LocalReceipt $result}catch{$pass=$false;$result.status='FAIL_RECEIPT';$result.receiptWriteFailed=$true}
  if($null -ne $h){$h.Clear()};$h=$null;$plan=$null;$live=$null;$v=$null;$logs=$null;$value=$null;$response=$null;$ready=$null;$body=$null;$r=$null
 }
 return @{passed=$pass;receipt=$script:LocalReceipt;safeResult=$result}
}
if($MyInvocation.InvocationName -ne '.'){$out=Invoke-Phase10ResumeLocalContainer ([bool]$NoConcurrentCloudLoad);$out|ConvertTo-Json -Depth 20 -Compress;if(-not $out.passed){exit 1}}
