param([Parameter(Mandatory)][ValidatePattern('^relay-log-scan-actual-[0-9]{8}(?:-[a-z0-9-]{1,48})?\.json$')][string]$OutputName,[ValidateRange(1,12)][int]$Hours=1,[switch]$IncludeOctober15Deployments,[switch]$HistoricalOctober15Afternoon)
# Root-only read-only log scan. Raw logs and credential candidates stay in protected memory/stdin.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/relay-protected-context.ps1"
Import-Phase08SchedulerChildDefinitions
$context=$null;$password=$null;$scanEnv=$null;$headers=$null;$token=$null;$logs=$null;$reply=$null;$data=$null;$stage='PREFLIGHT'
$logSource='NONE';$pageOffset=0;$logStatus=0;$logBytes=0
function Get-Phase08LogWindow([bool]$Historical,[int]$RequestedHours,[DateTimeOffset]$Now){
 if($RequestedHours -lt 1 -or $RequestedHours -gt 12){throw 'log-window'}
 if($Historical){
  if($Now -lt [DateTimeOffset]'2026-10-15T08:20:00Z'){throw 'historical-future'}
  return @{mode='FIXED_OCTOBER15_AFTERNOON_CATCHUP';start='2026-10-15T04:55:39Z';end='2026-10-15T08:20:00Z'}
 }
 return @{mode='RECENT_BOUNDED_WINDOW';start=$Now.AddHours(-$RequestedHours).ToString('yyyy-MM-ddTHH:mm:ssZ');end=$Now.ToString('yyyy-MM-ddTHH:mm:ssZ')}
}
function Get-Phase08SafeLogScan($Value,[int]$ExpectedRows,[int]$Limit){
 $names=@('state','matchDetected','complete','logEntries','secretCandidates','rawValuesReturned','providerRequests','databaseWrites','cafeCredentialsDecrypted','metaCredentialsDecrypted')
 if($Value -isnot [Collections.IDictionary] -or $Value.Count -ne $names.Count -or @($names|Where-Object{-not $Value.Contains($_)}).Count -ne 0 -or $Value.state -isnot [string] -or $Value.state -cnotin @('PHASE08_SECRET_MATCH_DETECTED','PHASE08_SECRET_SCAN_COMPLETE','PHASE08_SECRET_SCAN_INCOMPLETE') -or $Value.matchDetected -isnot [bool] -or $Value.complete -isnot [bool]){throw 'scan-summary'}
 foreach($name in @('logEntries','secretCandidates','rawValuesReturned','providerRequests','databaseWrites','cafeCredentialsDecrypted','metaCredentialsDecrypted')){
  if(($Value[$name] -isnot [int] -and $Value[$name] -isnot [long]) -or $Value[$name] -lt 0 -or $Value[$name] -gt 5000){throw 'scan-count'}
 }
 if($Value.logEntries -ne $ExpectedRows -or $Value.rawValuesReturned -ne 0 -or $Value.providerRequests -ne 0 -or $Value.databaseWrites -ne 0 -or $Value.cafeCredentialsDecrypted -ne 2 -or $Value.metaCredentialsDecrypted -ne 2 -or ($Value.complete -and $ExpectedRows -ge $Limit)){throw 'scan-boundary'}
 $expectedState=if($Value.matchDetected){'PHASE08_SECRET_MATCH_DETECTED'}elseif($Value.complete){'PHASE08_SECRET_SCAN_COMPLETE'}else{'PHASE08_SECRET_SCAN_INCOMPLETE'}
 if($Value.state -cne $expectedState){throw 'scan-state'}
 return @{state=$Value.state;matchDetected=$Value.matchDetected;complete=$Value.complete;logEntries=$Value.logEntries;secretCandidates=$Value.secretCandidates;rawValuesReturned=0;providerRequests=0;databaseWrites=0;cafeCredentialsDecrypted=2;metaCredentialsDecrypted=2}
}
function Get-Phase08ReviewedLogDeployments($Value,$Pins){
 $names=@('state','sourceSha','currentDeploymentId','deployments','totalDeployments','remoteCalls')
 if($Value -isnot [Collections.IDictionary] -or $Value.Count -ne 6 -or @($names|Where-Object{-not $Value.Contains($_)}).Count -ne 0 -or $Value.state -isnot [string] -or $Value.sourceSha -isnot [string] -or $Value.currentDeploymentId -isnot [string] -or $Value.state -cne 'PHASE08_REVIEWED_LOG_PROFILE_PREPARED' -or $Value.sourceSha -cne $Pins.sourceSha -or $Value.currentDeploymentId -cne $Pins.deploymentId -or $Value.deployments -isnot [array] -or ($Value.totalDeployments -isnot [int] -and $Value.totalDeployments -isnot [long]) -or ($Value.remoteCalls -isnot [int] -and $Value.remoteCalls -isnot [long]) -or $Value.remoteCalls -ne 0){throw 'history-profile-shape'}
 if($Pins.sourceSha -ceq '6bf11939a6f7b4c676377c1c679a3a6473d158374072896b4ee15711f36a1fde'){
  if($Pins.deploymentId -cnotin @('4a6e678e-437e-41d8-830d-f1f642b07bb5','ea783d17-095b-4dee-86cc-5d6dc7820ce9','5886c332-9751-4ba5-a650-b9ebd19e0be4')){throw 'history-current'};$count=10;$sha='d0239d59e686d4b2f0a7208454337776cb19cc40dad8be38a0c2a8a8c2822552'
 }elseif($Pins.sourceSha -ceq 'e83351e69260d94a6aaebb5ff6d109bd38aa0570b3bdbc1f55069d8a3b39d44f'){
  if($Pins.deploymentId -cnotin @('653a3679-11f5-42d1-9eab-aa5c1db71654','44783a13-1150-4f13-9d7a-88217bd9784a')){throw 'history-current'};$count=12;$sha='0ae3ec55bff7d8b13c5066c3c78025f1852a26a4f0accc6977495a956ae6c010'
 }elseif($Pins.sourceSha -ceq '436055128dad4b150f6ff4c3a754d1cadc3b9cb784f3d659423df35f33f773ff'){
  if($Pins.deploymentId -cne '75138a65-d274-4858-a49b-64ac811adff3'){throw 'history-current'};$count=13;$sha='f889938b5a8768fd6243d1f3f3255a2545558ce1676ca31b76f0daf699a645cb'
 }elseif($Pins.sourceSha -ceq 'f1b78cdbdb2a7bd7c6c86da5891c8725181297c4f1b431893bb44042d4ff9b09'){
  if($Pins.deploymentId -ceq 'af7a6921-3307-4cf0-9f17-053c21ce3ff4'){$count=14;$sha='58320dc719a1ee8901e13aeec0f0bc9f1af353d71f8c5ef95481075d5e906363'}elseif($Pins.deploymentId -ceq '905cce5f-4fdc-4f19-99b1-ec5aaa2b6f62'){$count=15;$sha='914335e7731ef4758ec3786ae373c4d2a8083561b3d9b0d02160f206305581e2'}else{throw 'history-current'}
 }elseif($Pins.sourceSha -ceq '898bb25b5cc3fca6437d8a284b11e71045cb6e74e073acb848affa0498ae58d9'){
  if($Pins.deploymentId -cnotin @('aac4ad45-b0ab-4106-a88a-c50ae7151423','5f6c56de-47a1-4f34-9194-c7ea1f42a8c6')){throw 'history-current'};$count=17;$sha='578fe10df4674043063c714b085426322475cb76377e4662e366e8105afd204b'
 }elseif($Pins.sourceSha -ceq '81b8ba86b22f2019227433f9e0f87ced95d97a44b44ba69d494eec0d664ce537'){
  if($Pins.deploymentId -cnotin @('764d2415-e761-4388-b6fe-4e590c630293','defd778f-8b6c-4e76-9555-5693a856099b')){throw 'history-current'};$count=19;$sha='1a4edbeea252a281d70c120cd500dba763858ebc20619fb7d84dc9af8da8e940'
 }elseif($Pins.sourceSha -ceq 'f7592804a9763eb228d7c97be00479431700e78b7c57e4544b4c6a863556e4df'){
  if($Pins.deploymentId -cne '5b6caf98-f569-4c6e-9086-2401cae2dd7b'){throw 'history-current'};$count=20;$sha='2c416d29c7fb6299ded749a43a8243cdd6fdf332ae90623a0142630a590be757'
 }elseif($Pins.sourceSha -ceq '0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1'){
  if($Pins.deploymentId -cnotin @('25e68a9b-04f6-4329-b6bd-b5a3391fb01c','3ccd3843-a15f-4655-a937-c190779ce769')){throw 'history-current'};$count=22;$sha='428e0643da56fcbaaa7728a0d2d80e958083575c6de8539f462f146ddca1a4bd'
 }else{throw 'history-source'}
 if($Value.totalDeployments -ne $count -or $Value.deployments.Count -ne $count -or $count -gt 22 -or @($Value.deployments|Sort-Object -Unique).Count -ne $count -or @($Value.deployments|Where-Object{$_ -isnot [string] -or $_ -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'}).Count -ne 0 -or $Pins.deploymentId -cnotin $Value.deployments){throw 'history-list'}
 $bytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Value.deployments -Compress));if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $sha){throw 'history-literal-set'}
 return @($Value.deployments)
}
try {
 if($HistoricalOctober15Afternoon -and $PSBoundParameters.ContainsKey('Hours')){throw 'ambiguous-window'}
 $outputRoot='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation'
 $rootItem=Get-Item -LiteralPath $outputRoot
 if(-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'output-root'}
 $output=Join-Path $rootItem.FullName $OutputName
 if(Test-Path -LiteralPath $output){throw 'existing-output'}
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $graph=Get-Phase08SchedulerGraphState $context $pins
 if(-not $graph.scheduleEnabled -or $graph.appSchedules.Count -ne 3){throw 'graph'}
 $password=Read-Phase08RelayProtectedPassword
 $scanEnv=$context.env|ConvertTo-Json -Depth 25 -Compress|ConvertFrom-Json -AsHashtable -Depth 25
 $scanEnv.PHASE08_RELAY_BASIC_PASSWORD=$password
 $scanEnv.PHASE08_RELAY_USERPWD_PASSWORD='phase08-scheduler:'+$password
 $scanEnv.PHASE08_RELAY_AUTH_TOKEN='Basic '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('phase08-scheduler:'+$password))
 $password=$null;$results=@();$now=[DateTimeOffset]::UtcNow
 $window=Get-Phase08LogWindow ([bool]$HistoricalOctober15Afternoon) $Hours $now;$start=$window.start;$end=$window.end
 $stage='RAILWAY_LOGS'
 $query='query($d:String!){deploymentLogs(deploymentId:$d,limit:5000){message severity timestamp attributes{key value} tags{deploymentId environmentId projectId serviceId}}}'
 $deployments=@($pins.deploymentId)
 if($IncludeOctober15Deployments){
  if($pins.sourceSha -cin @('6bf11939a6f7b4c676377c1c679a3a6473d158374072896b4ee15711f36a1fde','e83351e69260d94a6aaebb5ff6d109bd38aa0570b3bdbc1f55069d8a3b39d44f','436055128dad4b150f6ff4c3a754d1cadc3b9cb784f3d659423df35f33f773ff','f1b78cdbdb2a7bd7c6c86da5891c8725181297c4f1b431893bb44042d4ff9b09','898bb25b5cc3fca6437d8a284b11e71045cb6e74e073acb848affa0498ae58d9','81b8ba86b22f2019227433f9e0f87ced95d97a44b44ba69d494eec0d664ce537','f7592804a9763eb228d7c97be00479431700e78b7c57e4544b4c6a863556e4df','0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1')){
   $profile=Invoke-Phase08ConfigurationChild "$PSScriptRoot/relay-log-v22-profile.mjs" @{sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;identity=$pins.identity}
   $deployments=@(Get-Phase08ReviewedLogDeployments $profile $pins);$profile=$null
  }else{
  if($pins.sourceSha -cne 'd1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21' -or $pins.deploymentId -cne '5dac048f-5015-46fa-8ca4-5227352c834c'){throw 'history-scope'}
  $deployments=@('e71e73ea-838f-45d3-a19d-32033d3d7391','a0045206-20f8-4982-be2c-35505cbd3870','56ed1723-ba91-4cdd-a335-f0e241cc180c','86d5ad6d-eec8-414a-a922-9c6b8c62a245','ee97acf7-bce3-4134-a639-2f80cc4f310a','a35d7507-2044-41f5-9f91-fd4838ad0d28','5dac048f-5015-46fa-8ca4-5227352c834c')
  }
 }
 foreach($deploymentId in $deployments){
  $rail=Invoke-Phase08SchedulerGraph $query @{d=$deploymentId};$logs=@($rail.deploymentLogs)
  foreach($log in $logs){if($log.tags.deploymentId -cne $deploymentId -or $log.tags.projectId -cne $pins.identity.projectId -or $log.tags.environmentId -cne $pins.identity.environmentId -or $log.tags.serviceId -cne $pins.identity.serviceId){throw 'log-scope'}}
  $scan=Invoke-Phase08ConfigurationChild "$PSScriptRoot/scan-deployment-secrets.mjs" @{projectRef='ehnfrrmbkvlsbpvqcvkr';connectionId='0c35defe-45fc-4a54-bc79-704df7bca5b1';env=$scanEnv;logs=$logs;logsComplete=($logs.Count -lt 5000)}
  $scan=Get-Phase08SafeLogScan $scan $logs.Count 5000
  $results+=@{source='ISOLATED_REVIEWED_RAILWAY';deploymentId=$deploymentId;scan=$scan};$logs=$null;$rail=$null
 }
 $stage='SUPABASE_LOGS';$token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
 foreach($source in @(@{name='NEW_PROJECT_EDGE_AND_FUNCTION';filter="source in ('function_edge_logs','function_logs','edge_logs')"},@{name='NEW_PROJECT_POSTGRES';filter="source='postgres_logs'"})){
 $pages=@();$totalRows=0;$reachedEnd=$false;$matchDetected=$false;$pageSummary=$null
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 for($offset=0;$offset -lt 1000;$offset+=25){
  $logSource=$source.name;$pageOffset=$offset;$logStatus=0;$logBytes=0
  # Fixed interval and deterministic ordering, with duplicate rejection. The
  # analytics API is not a snapshot: late ingestion is outside completeness.
  # No raw page is accumulated or written; HTTP and child bounds stay enforced.
  $sql="select timestamp,id,event_message,severity_text,source,log_attributes from logs where "+$source.filter+" order by timestamp desc,id desc limit 25 offset "+$offset
  $uri='https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/analytics/endpoints/logs?sql='+[Uri]::EscapeDataString($sql)+'&iso_timestamp_start='+[Uri]::EscapeDataString($start)+'&iso_timestamp_end='+[Uri]::EscapeDataString($end)
  $reply=Invoke-WebRequest -Uri $uri -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$reply.StatusCode -eq 429){
   # One bounded, server-directed retry of this read-only page. No provider work.
   $retryText=($reply.Headers['Retry-After'] -join '')
   $seconds=60
   if($retryText -cmatch '^[0-9]{1,3}$'){$seconds=[int]$retryText;if($seconds -lt 1){$seconds=1};if($seconds -gt 60){throw 'log-rate-limit'}}
   elseif($retryText){$retryAt=[DateTimeOffset]::MinValue;if(-not [DateTimeOffset]::TryParse($retryText,[ref]$retryAt)){throw 'log-rate-limit'};$seconds=[int][Math]::Ceiling(($retryAt-[DateTimeOffset]::UtcNow).TotalSeconds);if($seconds -gt 60){throw 'log-rate-limit'};if($seconds -lt 1){$seconds=1}}
   $reply=$null;Start-Sleep -Seconds $seconds
   $reply=Invoke-WebRequest -Uri $uri -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  }
  $logStatus=[int]$reply.StatusCode;$logBytes=[Text.Encoding]::UTF8.GetByteCount($reply.Content)
  if($logStatus -ne 200 -or $logBytes -gt 1048576){throw 'log-response'}
  $data=$reply.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 40
  if(($data.ContainsKey('error') -and $data.error) -or -not $data.ContainsKey('result') -or $data.result -isnot [Array]){throw 'log-query'}
  $logs=@($data.result)
  if($logs.Count -gt 25){throw 'log-page-bound'}
  foreach($entry in $logs){
   if($entry.id -isnot [string] -or $entry.id.Length -lt 1 -or $entry.id.Length -gt 256 -or $entry.source -isnot [string] -or $entry.source -cnotin @('function_edge_logs','function_logs','edge_logs','postgres_logs') -or -not $seen.Add($entry.source+'|'+$entry.id)){throw 'log-page-identity'}
  }
  $rowCount=$logs.Count
  $scan=Invoke-Phase08ConfigurationChild "$PSScriptRoot/scan-deployment-secrets.mjs" @{projectRef='ehnfrrmbkvlsbpvqcvkr';connectionId='0c35defe-45fc-4a54-bc79-704df7bca5b1';env=$scanEnv;logs=$logs;logsComplete=$true}
  $scan=Get-Phase08SafeLogScan $scan $rowCount 26
  if(-not $scan.complete){throw 'log-page-incomplete'}
  if($pageSummary -and $scan.secretCandidates -ne $pageSummary.secretCandidates){throw 'log-page-candidates'}
  $pageSummary=$scan;$totalRows+=$rowCount;$matchDetected=$matchDetected -or $scan.matchDetected
  $pages+=@{offset=$offset;rows=$rowCount;matchDetected=$scan.matchDetected;complete=$scan.complete}
  $logs=$null;$reply=$null;$data=$null
  if($rowCount -lt 25){$reachedEnd=$true;break}
  Start-Sleep -Seconds 10
 }
 $complete=$reachedEnd -and $totalRows -lt 1000
 $aggregateState=if($matchDetected){'PHASE08_SECRET_MATCH_DETECTED'}elseif($complete){'PHASE08_SECRET_SCAN_COMPLETE'}else{'PHASE08_SECRET_SCAN_INCOMPLETE'}
 $aggregate=@{state=$aggregateState;matchDetected=$matchDetected;complete=$complete;logEntries=$totalRows;secretCandidates=$pageSummary.secretCandidates;rawValuesReturned=0;providerRequests=0;databaseWrites=0;cafeCredentialsDecrypted=2;metaCredentialsDecrypted=2}
 $results+=@{source=$source.name;start=$start;end=$end;scan=$aggregate;pages=$pages;pageSize=25;maximumRows=1000;credentialCountsArePerPage=$true}
 }
 $verified=@($results|Where-Object{$_.scan.matchDetected -or -not $_.scan.complete -or $_.scan.state -cne 'PHASE08_SECRET_SCAN_COMPLETE'}).Count -eq 0
 $evidence=@{classification='ACTUAL_PROTECTED_KNOWN_SECRET_LOG_SCAN';verified=$verified;observedAt=[DateTimeOffset]::UtcNow.ToString('o');results=$results;providerCalls=0;rawValuesReturned=0;futureLogsCovered=$false;lateArrivingLogsCovered=$false;logWindowMode=$window.mode;supabaseLogWindowStart=$start;supabaseLogWindowEnd=$end;railwayDeploymentLogsTimeFiltered=$false;completeSemantics='Returned pages exhausted before the fixed cap; analytics ingestion is not a snapshot'}
 $stream=[IO.File]::Open($output,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($evidence|ConvertTo-Json -Depth 12));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 $evidence|ConvertTo-Json -Depth 12
 if(-not $verified){exit 1}
}catch{
 $known=@('log-response','log-rate-limit','log-query','log-page-bound','log-page-identity','log-page-incomplete','log-page-candidates','scan-summary','scan-count','scan-boundary','scan-state','PHASE08_CONFIGURATION_CHILD_FAILED')
 $code=if($_.Exception.Message -cin $known){$_.Exception.Message}else{'UNCLASSIFIED'}
 @{state='PHASE08_RELAY_LOG_SCAN_FAILED';stage=$stage;code=$code;complete=$false;logSource=$logSource;pageOffset=$pageOffset;httpStatus=$logStatus;responseBytes=$logBytes;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1
}
finally{if($headers){$headers.Clear()};if($scanEnv){$scanEnv.Clear()};$context=$null;$password=$null;$scanEnv=$null;$headers=$null;$token=$null;$logs=$null;$reply=$null;$data=$null;$rail=$null;$scan=$null}
