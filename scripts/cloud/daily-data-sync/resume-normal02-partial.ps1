param([Parameter(Mandatory)][string]$EvidencePath,[switch]$ResumeApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
function Assert-Phase08PartialResumeResult($Rows){
 if(@($Rows).Count -ne 1){throw 'resume-result'};$r=@($Rows)[0]
 if($r.state -cne 'PHASE08_NORMAL02_PARTIALLY_RESUMED' -or $r.global_stopped -isnot [bool] -or $r.global_stopped -or $r.meta_paused -isnot [bool] -or -not $r.meta_paused -or $r.business_history_preserved -isnot [bool] -or -not $r.business_history_preserved -or $r.original_weekly_succeeded -isnot [bool] -or $r.original_weekly_succeeded -or ($r.active_jobs -isnot [int] -and $r.active_jobs -isnot [long]) -or $r.active_jobs -ne 149 -or ($r.uncollected_old_dates -isnot [int] -and $r.uncollected_old_dates -isnot [long]) -or $r.uncollected_old_dates -ne 7){throw 'resume-result'}
 return @{globalStopped=$false;metaPaused=$true;activeJobs=149;businessHistoryPreserved=$true;originalWeeklySucceeded=$false;uncollectedOldDates=7}
}
if($MyInvocation.InvocationName -cne '.'){
 $stage='APPROVAL';$context=$null;$operator=$null;$headers=$null;$token=$null;$submitted=$false
 try{
  if(-not $ResumeApproved){throw 'explicit-resume-required'}
  Import-Phase08SchedulerChildDefinitions
  $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/scheduler-normal02-partial-resume-actual-20261015.json';$marker=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/scheduler-normal02-partial-resume-attempt-20261015.json'
  $pins=Get-Phase08SchedulerPins;if($pins.sourceSha -cne '0368163a964e94086ef77ca644a6bf3d0be2ec6cfe12523cb136ec5ac02cd9fa'){throw 'source'}
  $stage='SIGNED_PROOF';$item=Get-Item -LiteralPath $EvidencePath;$full=[IO.Path]::GetFullPath($item.FullName)
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 65536 -or -not $full.StartsWith('C:\Users\seong\AppData\Local\MetaAdsPhase08Evaluation\',[StringComparison]::OrdinalIgnoreCase)){throw 'proof-path'}
  $envelope=[IO.File]::ReadAllText($full)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 25;$proof=Invoke-Phase08SchedulerNode @{action='validate';envelope=$envelope};if($proof.state -cne 'PHASE08_SIGNED_EVIDENCE_VERIFIED'){throw 'signed-proof'}
  $stage='LIVE_APP';$context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator;Assert-Phase08SchedulerContext $context $pins
  $graph=Get-Phase08SchedulerGraphState $context $pins;$ready=Get-Phase08SchedulerReady $context $pins;Get-Phase08SchedulerRuntimeProof $context
  if(($graph.appSchedules|ConvertTo-Json -Depth 15 -Compress) -cne ($proof.payload.appSchedules|ConvertTo-Json -Depth 15 -Compress) -or $graph.scheduleEnabled -isnot [bool] -or -not $graph.scheduleEnabled){throw 'runtime-proof-change'}
  $stage='LIVE_EDGE';$token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
  $edge=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/functions' -Method Get -Headers $headers -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$edge.StatusCode -ne 200 -or $edge.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($edge.Content) -gt 1048576){throw 'edge-response'};$functions=@($edge.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 10)
  if($functions.Count -ne 1 -or $functions[0].id -cne '42f4d9e1-eddb-4b00-b574-399a489f78b4' -or $functions[0].slug -cne 'phase08-scheduled-relay' -or ($functions[0].version -isnot [int] -and $functions[0].version -isnot [long]) -or $functions[0].version -ne 3 -or $functions[0].status -cne 'ACTIVE' -or $functions[0].verify_jwt -isnot [bool] -or $functions[0].verify_jwt -or $functions[0].ezbr_sha256 -cne '4d1f31ac23eb3e6479eb747546ccee41e263c688ed9d3c0a2526e1fdf6af05ad'){throw 'edge-identity'}
  $headers.Clear();$headers=$null;$token=$null;$edge=$null;$functions=$null
  $stage='BUILD';$prepared=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'normal02-partial-resume.mjs') @{envelope=$envelope;actorId=$operator.appId;authId=$operator.authId;edgeBundleSha='4d1f31ac23eb3e6479eb747546ccee41e263c688ed9d3c0a2526e1fdf6af05ad'}
  if($prepared.state -cne 'PHASE08_NORMAL02_PARTIAL_RESUME_SQL_PREPARED' -or $prepared.sql -isnot [string] -or $prepared.sql.Length -gt 1048576){throw 'sql'}
  $null=Write-Phase08SchedulerPublicEvidence @{classification='PARTIAL_NORMAL_CLOCK_RESUME_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;scheduledDataCollectionRequested=$false} $marker
  $stage='SINGLE_BATCH';$submitted=$true;$rows=@(Invoke-Phase08Management -Action Query -Query $prepared.sql);$prepared=$null;$result=Assert-Phase08PartialResumeResult $rows
  $stage='READBACK';$query="BEGIN READ ONLY;SELECT current_database() AS database,current_user AS principal,(SELECT count(*)=1 FROM daily_data_sync_ops.settings WHERE singleton AND NOT stopped) AS enabled,(SELECT count(*)=1 FROM daily_data_sync_ops.schedules WHERE key='phase08-meta' AND paused) AS meta_paused,(SELECT count(*)::int FROM daily_data_sync_ops.schedules WHERE NOT paused) AS unpaused,(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS jobs,(SELECT count(*)::int FROM phase08_meta_ads.security_audit_events WHERE action='SYNC_SCHEDULE_PARTIAL_NORMAL_CLOCK_RESUME') AS audits,(SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY id)::text) FROM daily_data_sync_ops.attempts x WHERE id<=152) AS original_digest;COMMIT;"
  $after=@(Invoke-Phase08Management -Action Query -Query $query)
  if($after.Count -ne 1 -or $after[0].database -cne 'postgres' -or $after[0].principal -cne 'postgres' -or $after[0].enabled -isnot [bool] -or -not $after[0].enabled -or $after[0].meta_paused -isnot [bool] -or -not $after[0].meta_paused -or $after[0].original_digest -cne 'c044e6c4249188e410d31aacf57422dc'){throw 'readback'}
  foreach($pair in @(@('unpaused',2),@('jobs',149),@('audits',1))){$name=$pair[0];if(($after[0].$name -isnot [int] -and $after[0].$name -isnot [long]) -or $after[0].$name -ne $pair[1]){throw 'readback'}}
  $out=@{state='PHASE08_NORMAL02_PARTIAL_RESUME_VERIFIED';classification='ACTUAL_HEALTHY_PROVIDERS_RESUME_META_PAUSED';sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;globalStopped=$false;metaPaused=$true;activeJobs=149;userResumeAudits=1;original152Preserved=$true;businessHistoryPreserved=$true;oldWeeklySucceeded=$false;manualRecoveredDay=$null;metaRecoveryComplete=$false;healthyProvidersResumed=@('CAFE24','GOOGLE');oldDatesNotCollected=7;providerRequests=0;operatingChanges=0;retryPerformed=$false}
  $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
 }catch{@{state='PHASE08_NORMAL02_PARTIAL_RESUME_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
 finally{if($headers){$headers.Clear()};$token=$null;$headers=$null;$context=$null;$operator=$null;$envelope=$null;$proof=$null;$prepared=$null;$rows=$null;$after=$null;$out=$null;$query=$null}
}
