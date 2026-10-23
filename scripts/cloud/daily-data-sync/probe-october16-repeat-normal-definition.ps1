param([Alias('ProbeApproved')][switch]$NormalProbeApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
# Definitions-only import; use a distinct approval variable from the imported script.
. "$PSScriptRoot/probe-afternoon-loaded-definition.ps1"
function Get-Phase08NormalDefinitionBaselineSql {
 $sql=Get-Phase08LoadedDefinitionBaselineSql
 foreach($pair in @(@("anchor_at=timestamptz '2026-10-15T06:40:00Z'","anchor_at=timestamptz '2026-10-14T17:00:00Z'"),@("anchor_at=timestamptz '2026-10-15T07:00:00Z'","anchor_at=timestamptz '2026-10-15T17:02:00Z'"),@('collectionProfileVerified','normalProfileVerified'))){if($sql.Split($pair[0],[StringSplitOptions]::None).Count -ne 2){throw 'normal-baseline-source'};$sql=$sql.Replace($pair[0],$pair[1])}
 return $sql
}
function ConvertTo-Phase08NormalDefinitionBaseline($Rows){
 if(@($Rows).Count -ne 1){throw 'normal-baseline-rows'};$r=@($Rows)[0];$names=@('identityVerified','stopped','normalProfileVerified','liveLeases','digest');$keys=if($r -is [Collections.IDictionary]){@($r.Keys)}else{@($r.PSObject.Properties.Name)}
 if($keys.Count -ne 5 -or @($names|Where-Object {$_ -cnotin $keys}).Count -ne 0){throw 'normal-baseline-shape'}
 foreach($name in @('identityVerified','stopped','normalProfileVerified')){if($r.$name -isnot [bool] -or -not $r.$name){throw 'normal-baseline-bool'}}
 if(($r.liveLeases -isnot [int] -and $r.liveLeases -isnot [long]) -or $r.liveLeases -ne 0 -or $r.digest -isnot [string] -or $r.digest -cnotmatch '^[a-f0-9]{32}$'){throw 'normal-baseline-state'};return $r.digest
}
function Assert-Phase08CompleteCollectionWriteScope($Receipt){
 if($Receipt -isnot [Collections.IDictionary] -or $Receipt.Contains('databaseWrites') -or -not $Receipt.Contains('collectionDataWrites') -or -not $Receipt.Contains('databaseWritesScope') -or -not $Receipt.Contains('transportSecurityWritesExpected') -or ($Receipt.collectionDataWrites -isnot [int] -and $Receipt.collectionDataWrites -isnot [long]) -or $Receipt.collectionDataWrites -ne 0 -or $Receipt.databaseWritesScope -isnot [string] -or $Receipt.databaseWritesScope -cne 'COLLECTION_DATA_ONLY' -or $Receipt.transportSecurityWritesExpected -isnot [bool] -or -not $Receipt.transportSecurityWritesExpected){throw 'complete-write-scope'}
}
function Assert-Phase08KnownCompleteCollection($Pins){
 $file=Get-Item -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-repeat-complete-native-status-actual-20261016.json'
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 16384){throw 'complete-proof-file'}
 $p=[IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 10
 if($p.state -cne 'PHASE08_OCTOBER16_NATIVE_COMPLETE_STATUS_VERIFIED' -or $p.classification -cne 'ACTUAL_DB_EDGE_NEXT_NEST_READONLY_SUCCESS_STATUS' -or $p.sourceSha -cne $Pins.sourceSha -or $p.deploymentId -isnot [string] -or $p.deploymentId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or $p.deploymentId -ceq $Pins.deploymentId -or $p.runUnitCoverageAttemptsUnchanged -isnot [bool] -or -not $p.runUnitCoverageAttemptsUnchanged -or $p.results -isnot [array] -or $p.results.Count -ne 2 -or $p.observedAt -isnot [string]){throw 'complete-proof'}
 Assert-Phase08CompleteCollectionWriteScope $p
 foreach($name in @('providerRequests','httpRequests','operatingChanges')){if(($p[$name] -isnot [int] -and $p[$name] -isnot [long]) -or $p[$name] -ne $(if($name -ceq 'httpRequests'){2}else{0})){throw 'complete-count'}}
 foreach($pair in @(@('CAFE24',1),@('META',7))){$rows=@($p.results|Where-Object {$_.provider -ceq $pair[0]});if($rows.Count -ne 1){throw 'complete-sources'};$r=$rows[0];if($r.Count -ne 6 -or $r.status -cne 'SUCCEEDED' -or $r.noStore -isnot [bool] -or -not $r.noStore){throw 'complete-summary'};foreach($name in @('httpStatus','completedUnits','totalUnits')){if(($r[$name] -isnot [int] -and $r[$name] -isnot [long]) -or $r[$name] -ne $(if($name -ceq 'httpStatus'){200}else{$pair[1]})){throw 'complete-summary-count'}}}
 $observed=[DateTimeOffset]::MinValue;if(-not [DateTimeOffset]::TryParse($p.observedAt,[ref]$observed) -or $observed -lt [DateTimeOffset]'2026-10-16T01:15:00Z' -or $observed -gt [DateTimeOffset]::UtcNow -or ([DateTimeOffset]::UtcNow-$observed).TotalMinutes -gt 30){throw 'complete-proof-age'}
}
function Assert-Phase08NormalLoadedResponse($Response,[string]$MachineToken){
 if([int]$Response.StatusCode -ne 400 -or $Response.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($Response.Content) -gt 8192 -or [string]$Response.Headers['Cache-Control'] -notmatch '(?i)(^|[,\s])no-store([,\s]|$)'){throw 'normal-status-response'}
 foreach($candidate in @($MachineToken,([Uri]::EscapeDataString($MachineToken)),([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($MachineToken))))){if($candidate -and $Response.Content.Contains($candidate,[StringComparison]::Ordinal)){throw 'normal-response-secret'}}
 $value=$Response.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 5
 if($value -isnot [Collections.IDictionary] -or $value.Count -ne 4 -or @(@('code','message','details','requestId')|Where-Object {-not $value.Contains($_)}).Count -ne 0 -or $value.code -isnot [string] -or $value.code -cne 'RUN_LIMIT_EXCEEDED' -or $value.message -isnot [string] -or $value.message -cne 'The sync request cannot be completed.' -or $null -ne $value.details -or $value.requestId -isnot [string] -or $value.requestId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'normal-status-shape'}
 return @{httpStatus=400;code='RUN_LIMIT_EXCEEDED';noStore=$true;normalDefinitionLoaded=$true}
}
if($MyInvocation.InvocationName -cne '.'){
 $stage='APPROVAL';$context=$null;$graph=$null;$headers=$null;$machineToken=$null;$reply=$null;$out=$null;$submitted=$false;$observedHttpStatus=$null
 try{
  if(-not $NormalProbeApproved){throw 'explicit-probe-required'};Import-Phase08SchedulerChildDefinitions
  $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-repeat-normal-runtime-loaded-probe-actual-20261016.json'
  $stage='REVIEWED_NORMAL_IDENTITY';$pins=Get-Phase08SchedulerPins;if($pins.sourceSha -cne 'f7592804a9763eb228d7c97be00479431700e78b7c57e4544b4c6a863556e4df'){throw 'source'}
  $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$graph=Get-Phase08SchedulerGraphState $context $pins
  $defs=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-repeat-profile-bridge.mjs" @{action='definitions';phase='normal'};if($defs.state -cne 'PHASE08_OCTOBER16_DEFINITIONS'){throw 'normal-definitions'}
  $null=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($defs.definitions);appSchedules=@($graph.appSchedules);managementSchedules=@()}
  $stage='KNOWN_COMPLETE_COLLECTION';Assert-Phase08KnownCompleteCollection $pins
  $stage='STOPPED_NORMAL_BASELINE';$baselineSql=Get-Phase08NormalDefinitionBaselineSql;$before=ConvertTo-Phase08NormalDefinitionBaseline @(Invoke-Phase08Management -Action Query -Query $baselineSql)
  $machineToken=$context.env.DAILY_SYNC_MACHINE_TOKEN;if($machineToken -isnot [string] -or $machineToken -cnotmatch '^[A-Za-z0-9+/]{43}=$'){throw 'machine-configuration'}
  $bytes=[Convert]::FromBase64String($machineToken);try{if($bytes.Length -ne 32 -or [Convert]::ToBase64String($bytes) -cne $machineToken){throw 'machine-configuration'}}finally{[Array]::Clear($bytes)}
  $headers=@{'x-daily-sync-token'=$machineToken;'x-daily-sync-target'='phase08-full-app'};$body='{"scheduleKey":"phase08-meta","scheduledFor":"2026-10-16T03:30:00.000Z"}'
  $stage='SINGLE_DIRECT_NEXT_CLOSED_STATUS';$submitted=$true
  $reply=Invoke-WebRequest -Uri 'https://phase08-daily-data-sync-production.up.railway.app/backend-api/internal/daily-sync/status' -Method Post -Headers $headers -Body $body -ContentType 'application/json' -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$reply.StatusCode -ge 100 -and [int]$reply.StatusCode -le 599){$observedHttpStatus=[int]$reply.StatusCode}
  $summary=Assert-Phase08NormalLoadedResponse $reply $machineToken;$reply=$null
  $stage='UNCHANGED_NORMAL_COLLECTION';$after=ConvertTo-Phase08NormalDefinitionBaseline @(Invoke-Phase08Management -Action Query -Query $baselineSql);if($before -cne $after){throw 'normal-collection-changed'}
  $out=@{state='PHASE08_NORMAL_RUNTIME_DEFINITION_PROBE';classification='ACTUAL_READONLY_DIRECT_NEXT_NEST_CLOSED_STATUS';verified=$true;httpStatus=400;code='RUN_LIMIT_EXCEEDED';normalDefinitionLoaded=$true;knownPreviousCompleteCollectionVerified=$true;loadedDefinitionInference='KNOWN_COMPLETE_COLLECTION_TO_NORMAL_ONLY';edgeResponseUsed=$false;noStore=$true;collectionDigestUnchanged=$true;sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;observedAt=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');appHttpRequests=1;providerRequests=0;collectionDataWrites=0;databaseWritesScope='COLLECTION_DATA_ONLY';transportSecurityWritesExpected=$true;transportSecurityTables=@('security_rate_limit_buckets','local_edge_request_nonces');automaticBackfill=$false;regularScheduleSuccess=$false}
  $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
 }catch{@{state='PHASE08_NORMAL_RUNTIME_PROBE_FAILED';stage=$stage;statusQuerySubmitted=$submitted;httpStatus=$observedHttpStatus;providerRequests=0;collectionDataWrites=0;databaseWritesScope='COLLECTION_DATA_ONLY';transportSecurityWritesExpected=$true;transportSecurityTables=@('security_rate_limit_buckets','local_edge_request_nonces');retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
 finally{if($headers){$headers.Clear()};$headers=$null;$machineToken=$null;$context=$null;$graph=$null;$reply=$null;$out=$null;$body=$null}
}
