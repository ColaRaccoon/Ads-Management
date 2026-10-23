param([ValidateSet('capture','offline')][string]$Mode='offline',[string]$ArtifactId,[ValidateSet(1,2)][int]$Attempt=1)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/meta-day09-diagnostic-protected.ps1"
Import-Phase08SchedulerChildDefinitions
$context=$null;$live=$null;$key=$null;$stage='IDENTITY'
try {
 $pins=Get-Phase08SchedulerPins;if($pins.sourceSha -cne 'e83351e69260d94a6aaebb5ff6d109bd38aa0570b3bdbc1f55069d8a3b39d44f'){throw 'source'};$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $null=Get-Phase08SchedulerGraphState $context $pins
 $result=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' @{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}
 $live=$result.variables;$result=$null
 $stage='CAPTURE_KEY';$key=Read-Phase08MetaDay09DiagnosticKey
 $stage='PROTECTED_DIAGNOSTIC'
 $material=@{projectRef='ehnfrrmbkvlsbpvqcvkr';day='2026-10-09';classification='MANUAL_DIAGNOSTIC';mode=$Mode;env=$live;databaseUrl=$context.env.DATABASE_URL;captureKeyB64=$key}
 if($Mode -ceq 'offline'){
  if($ArtifactId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'artifact'}
  $material.artifactId=$ArtifactId
 }
 $suffix=if($Mode -ceq 'capture'){'capture'}else{'offline-'+$ArtifactId}
 $path='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-failed-day09-actual-20261015-'+$suffix+'.json'
 if(Test-Path -LiteralPath $path){throw 'existing-summary'}
 if($Mode -ceq 'capture'){
  $marker=Join-Path (Get-Phase08MetaDay09DiagnosticDirectory) ('capture-attempt-'+$Attempt+'.json')
  if($Attempt -eq 2 -and -not (Test-Path -LiteralPath (Join-Path (Get-Phase08MetaDay09DiagnosticDirectory) 'capture-attempt-1.json'))){throw 'first-attempt-required'}
  $stream=[IO.File]::Open($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$bytes=[Text.Encoding]::UTF8.GetBytes((@{classification='MANUAL_DIAGNOSTIC';day='2026-10-09';startedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  Set-Phase08NewPrivateAcl -Path $marker
 }
 $probe=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'meta-day09-diagnostic-result.mjs') $material
 if($probe -isnot [Collections.IDictionary] -or $probe.Count -ne 3 -or $probe.state -isnot [string] -or $probe.state -cne 'PHASE08_META_DIAGNOSTIC_RESULT_RETURNED' -or $probe.success -isnot [bool]){throw 'probe-result'}
 $out=$probe.result
 if(-not $probe.success){
  $names=@('state','classification','stage','code','providerRequests','providerCountsObserved','rawErrorSuppressed','databaseWrites');if($out -isnot [Collections.IDictionary] -or $out.Count -ne 8 -or @($names|Where-Object{-not $out.Contains($_)}).Count -ne 0 -or $out.state -isnot [string] -or $out.classification -isnot [string] -or $out.code -isnot [string] -or $out.state -cne 'PHASE08_META_MANUAL_DIAGNOSTIC_FAILED' -or $out.classification -cne 'MANUAL_DIAGNOSTIC' -or $out.code -cne 'DIAGNOSTIC_REJECTED' -or $out.stage -isnot [string] -or $out.stage -cnotin @('INPUT','DIRECTORY','METADATA','DB_IDENTITY','FAILED_UNIT','CREDENTIAL_FILE','AUTH','CAPTURE','SEAL','CLASSIFY') -or $out.rawErrorSuppressed -isnot [bool] -or -not $out.rawErrorSuppressed -or $out.providerCountsObserved -isnot [bool] -or ($out.databaseWrites -isnot [int] -and $out.databaseWrites -isnot [long]) -or $out.databaseWrites -ne 0){throw 'failure-projection'}
  if($out.providerCountsObserved){if($out.providerRequests -isnot [Collections.IDictionary] -or $out.providerRequests.Count -ne 2){throw 'failure-counts'};foreach($name in @('graphGet','mcpPost')){if(($out.providerRequests[$name] -isnot [int] -and $out.providerRequests[$name] -isnot [long]) -or $out.providerRequests[$name] -lt 0 -or $out.providerRequests[$name] -gt $(if($name -ceq 'graphGet'){3}else{100})){throw 'failure-counts'}}}elseif($null -ne $out.providerRequests){throw 'failure-counts'}
  $out=@{state='PHASE08_META_MANUAL_DIAGNOSTIC_FAILED';classification='MANUAL_DIAGNOSTIC';stage=$out.stage;code='DIAGNOSTIC_REJECTED';providerRequests=$(if($out.providerCountsObserved){@{graphGet=$out.providerRequests.graphGet;mcpPost=$out.providerRequests.mcpPost}}else{$null});providerCountsObserved=$out.providerCountsObserved;rawErrorSuppressed=$true;databaseWrites=0}
  $failurePath='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-day09-diagnostic-failure-20261015-attempt-'+$Attempt+'.json'
  $null=Write-Phase08SchedulerPublicEvidence $out $failurePath
  $out|ConvertTo-Json -Compress -Depth 8
  exit 1
 }
 $out=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'meta-day09-diagnostic-result.mjs') @{action='project';result=$out}
 if($out.classification -cne 'MANUAL_DIAGNOSTIC' -or $out.day -cne '2026-10-09' -or $out.mode -cne $Mode -or $out.databaseWrites -ne 0 -or $out.rawValuesReturned -ne 0 -or $out.stage -cnotin @('CAPTURE_SELECTION','LINK_RESIDUAL','PURCHASE_RESIDUAL','NORMALIZE','ACCEPTED')){throw 'safe-result'}
 $stage='PUBLIC_SUMMARY'
 $null=Write-Phase08SchedulerPublicEvidence $out $path
 $out|ConvertTo-Json -Compress -Depth 12
}catch{@{state='PHASE08_META_DIAGNOSTIC_EXECUTION_FAILED';stage=$stage;mode=$Mode;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$live=$null;$key=$null;$material=$null;$out=$null}
