# Prepared for one reviewed invocation by the coordinator. Never dot-source/run
# old receipts. The only remote mutation is one temporary proxy on pinned 06 PG.
param([ValidateSet('initial','v2','v3')][string]$ReceiptVersion='initial')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$project='d72f4256-8632-437a-9dae-9b5d96736fc7'
$environment='d261a432-a6a4-4031-b8ea-c619ac263cc3'
$service='ef46528f-4b59-4ee6-9d9c-b0852b5a9274'
$railway='C:/Users/seong/AppData/Local/npm-cache/_npx/79fa66f96c8fdacf/node_modules/@railway/cli/bin/railway.exe'
$receipt=switch($ReceiptVersion){'v3'{'C:/Users/seong/AppData/Local/MetaAdsPhase09Evaluation/proxy06-receipt-20261019-v3.json'} 'v2'{'C:/Users/seong/AppData/Local/MetaAdsPhase09Evaluation/proxy06-receipt-20261019-v2.json'} default{'C:/Users/seong/AppData/Local/MetaAdsPhase09Evaluation/proxy06-receipt-20261019.json'}}
$createdId=$null;$createdAt=$null;$restored=$false;$baseline=$null;$stage='PREFLIGHT';$childVerified=$false
$failure=$null;$cleanupFailure=$false;$payload=$null;$state=$null
$createExitCode=$null;$createTimedOut=$false;$uncertainProxyIds=@()
$childFailureStage=$null;$childFailureCode=$null;$childExitCode=$null;$childTimedOut=$false

function Get-Phase09CafeProxyState {
 $query='query($p:String!,$e:String!,$s:String!){project(id:$p){id services{edges{node{id}}} environments{edges{node{id unmergedChangesCount}}}} variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status} activeDeployments{id status}} tcpProxies(environmentId:$e,serviceId:$s){id serviceId environmentId applicationPort proxyPort domain deletedAt syncStatus}}'
 $result=Invoke-Phase08SchedulerGraph $query @{p=$project;e=$environment;s=$service}
 if($result.project.id -cne $project -or @($result.project.services.edges|Where-Object {$_.node.id -ceq $service}).Count -ne 1 -or
   $result.serviceInstance.serviceId -cne $service -or $result.serviceInstance.environmentId -cne $environment){throw 'proxy-target'}
 $envState=@($result.project.environments.edges|Where-Object {$_.node.id -ceq $environment})
 if($envState.Count -ne 1 -or $envState[0].node -isnot [System.Collections.IDictionary] -or -not $envState[0].node.Contains('unmergedChangesCount')){throw 'environment-metadata-shape'}
 # Official CLI v5.63.4 controllers/tcp_proxy.rs::patch_mode explicitly uses
 # Option::unwrap_or_default() before choosing Stage for a positive count.
 # Preserve the observed nullable value; only an explicit null or integer zero
 # is therefore a known Commit-mode value. Missing fields are never defaulted.
 $count=$envState[0].node.unmergedChangesCount
 if($null -ne $count -and ($count -isnot [int] -and $count -isnot [long] -or $count -ne 0)){throw 'unmerged-environment-changes'}
 foreach($proxy in @($result.tcpProxies)){
  if($proxy.serviceId -cne $service -or $proxy.environmentId -cne $environment -or $proxy.applicationPort -ne 5432 -or
   $proxy.id -isnot [string] -or $proxy.id -cnotmatch '^[A-Za-z0-9-]{8,128}$'){throw 'proxy-identity'}
 }
 # Deleted historical records are not exposed proxies. DELETING remains live
 # here until a completed deletion is observed, so restoration cannot be early.
 $result.tcpProxies=@($result.tcpProxies|Where-Object {$_.syncStatus -ceq 'DELETING' -or ($null -eq $_.deletedAt -and $_.syncStatus -cne 'DELETED')})
 return $result
}
function Invoke-Phase09ProxyCli([string[]]$Arguments) {
 $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$railway;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 foreach($argument in $Arguments){$start.ArgumentList.Add($argument)}
 $process=[Diagnostics.Process]::new();$process.StartInfo=$start
 try {
  if(-not $process.Start()){throw 'cli-start'}
  $outTask=$process.StandardOutput.ReadToEndAsync();$errTask=$process.StandardError.ReadToEndAsync()
  $timedOut=-not $process.WaitForExit(60000)
  if($timedOut){$process.Kill($true);if(-not $process.WaitForExit(5000)){throw 'cli-kill-timeout'}}
  $out=$outTask.GetAwaiter().GetResult();$null=$errTask.GetAwaiter().GetResult()
  if([Text.Encoding]::UTF8.GetByteCount($out) -gt 65536){throw 'cli-output-bound'}
  # Preserve bounded stdout even on nonzero/timeout: a strict returned ID can
  # still authorize exact cleanup. No CLI output is forwarded to the console.
  return @{exitCode=$process.ExitCode;timedOut=$timedOut;stdout=$out}
 } finally {$process.Dispose();$out=$null;$outTask=$null;$errTask=$null}
}
function Invoke-Phase09CloneChild([string]$Payload) {
 $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName='C:/Program Files/nodejs/node.exe';$start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 foreach($argument in @('node_modules/tsx/dist/cli.mjs','--tsconfig','apps/api/tsconfig.json',"$PSScriptRoot/phase09-cafe-snapshot-clone.mts")){$start.ArgumentList.Add($argument)}
 $process=[Diagnostics.Process]::new();$process.StartInfo=$start
 try {
  if(-not $process.Start()){throw 'child-start'}
  $outTask=$process.StandardOutput.ReadToEndAsync();$errTask=$process.StandardError.ReadToEndAsync()
  $process.StandardInput.WriteLine($Payload);$process.StandardInput.Close();$Payload=$null
  $timedOut=-not $process.WaitForExit(120000)
  if($timedOut){$process.Kill($true);if(-not $process.WaitForExit(5000)){throw 'child-kill-timeout'}}
  $out=$outTask.GetAwaiter().GetResult();$null=$errTask.GetAwaiter().GetResult()
  if([Text.Encoding]::UTF8.GetByteCount($out) -gt 8192){throw 'child-output-bound'}
  return @{exitCode=$process.ExitCode;timedOut=$timedOut;stdout=$out}
 }finally{$process.Dispose();$Payload=$null;$out=$null;$outTask=$null;$errTask=$null}
}
function Get-Phase09CreatedProxyIdentity([string]$Json) {
 if([Text.Encoding]::UTF8.GetByteCount($Json) -gt 65536){throw 'create-json-bound'}
 $created=$Json|ConvertFrom-Json -AsHashtable -Depth 12
 if($created -isnot [System.Collections.IDictionary] -or -not $created.Contains('proxy') -or
   $created.proxy -isnot [System.Collections.IDictionary] -or -not $created.proxy.Contains('id') -or
   $created.proxy.id -isnot [string] -or $created.proxy.id -cnotmatch '^[A-Za-z0-9-]{8,128}$'){throw 'create-json-identity'}
 return @{id=$created.proxy.id;applicationPort=$created.applicationPort;staged=$created.staged;committed=$created.committed}
}
function Get-Phase09VariablesDigest($Value) {
 $ordered=[ordered]@{};foreach($key in @($Value.Keys|Sort-Object)){$ordered[$key]=$Value[$key]}
 $bytes=[Text.Encoding]::UTF8.GetBytes(($ordered|ConvertTo-Json -Compress -Depth 20))
 try{return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()}
 finally{[Array]::Clear($bytes,0,$bytes.Length)}
}
function Assert-Phase09EvidencePath([string]$Path) {
 if(Test-Path -LiteralPath $Path){throw 'receipt-exists'}
 $parent=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
 while($parent){$item=Get-Item -LiteralPath $parent;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'receipt-reparse'};$parent=[IO.Path]::GetDirectoryName($parent)}
}

try {
 Assert-Phase09EvidencePath $receipt
 if(-not (Test-Path -LiteralPath $railway -PathType Leaf)){throw 'cli-missing'}
 $baseline=Get-Phase09CafeProxyState
 if(@($baseline.tcpProxies).Count -ne 0){throw 'original-proxies-not-empty'}
 if($baseline.variables.DATABASE_URL -isnot [string]){throw 'database-variable'}
 $beforeDigest=Get-Phase09VariablesDigest $baseline.variables
 $beforeDeployment=$baseline.serviceInstance.latestDeployment.id
 $stage='CREATE_ONE_PROXY'
 $createdResult=Invoke-Phase09ProxyCli @('tcp-proxy','create','--port','5432','-p',$project,'-e',$environment,'-s',$service,'--json')
 $createExitCode=$createdResult.exitCode;$createTimedOut=$createdResult.timedOut
 # Installed 5.63.4's official commands/tcp_proxy.rs returns CreateOutput
 # {applicationPort,staged,committed,proxy:{id,...}}. An ambiguous shape never
 # authorizes a deletion; on an unknown outcome, record current IDs and stop.
 $created=Get-Phase09CreatedProxyIdentity $createdResult.stdout
 $createdId=[string]$created.id;$createdAt=[DateTimeOffset]::UtcNow
 if($created.applicationPort -ne 5432 -or $created.staged -ne $false -or $created.committed -ne $true){throw 'create-not-committed'}
 $createdResult=$null;$created=$null
 if($createExitCode -ne 0 -or $createTimedOut){throw 'create-cli-result'}
 $stage='VERIFY_NEW_PROXY'
 $state=Get-Phase09CafeProxyState
 if(@($state.tcpProxies).Count -ne 1 -or $state.tcpProxies[0].id -cne $createdId -or $state.tcpProxies[0].domain -cnotmatch '^[a-z0-9.-]+\.proxy\.rlwy\.net$' -or
   $state.tcpProxies[0].proxyPort -lt 1 -or $state.tcpProxies[0].proxyPort -gt 65535 -or $state.serviceInstance.latestDeployment.id -cne $beforeDeployment){throw 'created-proxy-not-matched'}
 $url=[UriBuilder]::new($state.variables.DATABASE_URL);$url.Host=$state.tcpProxies[0].domain;$url.Port=$state.tcpProxies[0].proxyPort
 $payload=@{projectId=$project;serviceId=$service;proxyId=$createdId;url=$url.Uri.AbsoluteUri}|ConvertTo-Json -Compress
 $stage='READ_ONLY_SOURCE_AND_LOCAL_CLONE'
 $childResult=Invoke-Phase09CloneChild $payload
 $childExitCode=$childResult.exitCode;$childTimedOut=$childResult.timedOut
 $payload=$null;$url=$null
 $child=$childResult.stdout|ConvertFrom-Json -AsHashtable -Depth 10
 if($child -is [System.Collections.IDictionary] -and $child.Contains('kind') -and $child.kind -ceq 'PHASE09_CAFE_ACTUAL_SNAPSHOT_FAILED'){
  $safeStages=@('INPUT','REMOTE_READONLY','LOCAL_DOCKER_IDENTITY','PREPARED_LOCAL_SCHEMA','WRITE_ONLY_NEW_LOCAL_CLONE','LOCAL_READONLY_RECHECK')
  if($child.Contains('stage') -and $child.stage -is [string] -and $child.stage -cin $safeStages){$childFailureStage=$child.stage}
  if($child.Contains('code') -and $child.code -is [string] -and ($child.code -cmatch '^P[0-9]{4}$' -or $child.code -ceq 'SAFE_REJECTED')){$childFailureCode=$child.code}
 }
 if($childExitCode -ne 0 -or $childTimedOut){throw 'child-result'}
 if($child.kind -cne 'PHASE09_CAFE_ACTUAL_SNAPSHOT_VERIFIED' -or $child.verified -ne $true -or $child.revenueKrw -cne '19187900' -or $child.sourceDatabaseWrites -ne 0 -or $child.providerCalls -ne 0){throw 'child-not-verified'}
 $childVerified=$true
}catch{$failure=$stage}
finally {
 $payload=$null;$url=$null;$state=$null
 if($createdId){
  try {
   $now=Get-Phase09CafeProxyState
   if(@($now.tcpProxies).Count -ne 1 -or $now.tcpProxies[0].id -cne $createdId){throw 'cleanup-proxy-identity'}
   $deleted=Invoke-Phase09ProxyCli @('tcp-proxy','delete',$createdId,'-p',$project,'-e',$environment,'-s',$service,'--yes','--json')
   $after=Get-Phase09CafeProxyState
   for($observation=1;$observation -lt 3 -and @($after.tcpProxies).Count -ne 0;$observation++){
    Start-Sleep -Seconds 2
    $after=Get-Phase09CafeProxyState
   }
   if(@($after.tcpProxies).Count -ne 0 -or $after.serviceInstance.latestDeployment.id -cne $beforeDeployment -or (Get-Phase09VariablesDigest $after.variables) -cne $beforeDigest){throw 'restore-not-equal'}
   $restored=$true
  }catch{$cleanupFailure=$true}
 }elseif($baseline -and @($baseline.tcpProxies).Count -eq 0){
  try{$after=Get-Phase09CafeProxyState;$uncertainProxyIds=@($after.tcpProxies|ForEach-Object {$_.id});$restored=@($after.tcpProxies).Count -eq 0 -and $after.serviceInstance.latestDeployment.id -ceq $beforeDeployment -and (Get-Phase09VariablesDigest $after.variables) -ceq $beforeDigest}catch{$cleanupFailure=$true}
 }
 $elapsed=if($createdAt){[Math]::Round(([DateTimeOffset]::UtcNow-$createdAt).TotalMilliseconds)}else{0}
 $evidence=@{kind='PHASE09_CAFE_TEMPORARY_PROXY_RECEIPT';observedAt=[DateTimeOffset]::UtcNow.ToString('o');projectId=$project;environmentId=$environment;serviceId=$service;
  beforeCount=if($baseline){@($baseline.tcpProxies).Count}else{$null};createdProxyId=$createdId;temporaryExposureMs=$elapsed;restoredOriginalEmpty=$restored;
  observedUnmergedChangesCount=if($baseline){@($baseline.project.environments.edges|Where-Object {$_.node.id -ceq $environment})[0].node.unmergedChangesCount}else{$null};
  normalizedUnmergedChangesCount=if($baseline){0}else{$null};normalizationBasis='RAILWAY_CLI_5_63_4_PATCH_MODE_OPTION_UNWRAP_OR_DEFAULT';
  createExitCode=$createExitCode;createTimedOut=$createTimedOut;uncertainOutcomeProxyIds=$uncertainProxyIds;
  childExitCode=$childExitCode;childTimedOut=$childTimedOut;childFailureStage=$childFailureStage;childFailureCode=$childFailureCode;
  databaseReadVerified=$childVerified;sourceDatabaseWrites=0;providerCalls=0;applicationDeploymentUnchangedVerified=$restored;failureStage=$failure;cleanupFailure=$cleanupFailure;rawErrorSuppressed=$true}
 try {
  Assert-Phase09EvidencePath $receipt
  $bytes=[Text.UTF8Encoding]::new($false,$true).GetBytes(($evidence|ConvertTo-Json -Compress -Depth 8))
  $stream=[IO.File]::Open($receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 }catch{$cleanupFailure=$true}
 $baseline=$null;$now=$null;$after=$null;$child=$null;$childResult=$null;$bytes=$null
}
@{kind='PHASE09_CAFE_PROXY_RUN_FINISHED';verified=($childVerified -and $restored -and -not $cleanupFailure);restoredOriginalEmpty=$restored;failureStage=$failure;receipt=$receipt}|ConvertTo-Json -Compress
if(-not $childVerified -or -not $restored -or $cleanupFailure){exit 1}
