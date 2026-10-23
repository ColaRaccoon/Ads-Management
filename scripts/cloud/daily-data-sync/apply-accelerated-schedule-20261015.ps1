# User-approved one-occurrence reanchor; never use the fresh-install/configure path.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$context=$null;$stage='PINS'
try {
 Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne 'ee9b9bdf8b6a5c67b2e7f12f678dba63004a82126c1d4086da2bf6fcccd4c25d' -or $pins.deploymentId -cne 'e71e73ea-838f-45d3-a19d-32033d3d7391'){throw 'reviewed-pins'}
 $next=Read-Phase08SchedulerDefinitions 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/schedules-20261015-10am-v8.json'
 $old=Read-Phase08SchedulerDefinitions 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/schedules-20261015-v7.json'
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $stage='LIVE_GRAPH';$graph=Get-Phase08SchedulerGraphState $context $pins
 $stage='LIVE_READY';$ready=Get-Phase08SchedulerReady $context $pins
 $stage='LIVE_DATABASE';$database=Get-Phase08SchedulerDatabase $pins $next.ranges
 Get-Phase08SchedulerRuntimeProof $context
 $before=Get-Phase08SchedulerSnapshot
 $null=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($next.definitions);appSchedules=@($graph.appSchedules);managementSchedules=@()}
 $null=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($old.definitions);appSchedules=@();managementSchedules=@($before.snapshot.schedules|ForEach-Object{@{key=$_.key;connectionId=$_.connectionId;provider=$_.provider;anchorAt=$_.anchorAt;windowMinutes=$_.windowMinutes;cadenceDays=$_.cadenceDays}})}
 if(-not $graph.scheduleEnabled -or $before.snapshot.settings.Count -ne 1 -or $before.snapshot.settings[0].stopped -or $before.snapshot.schedules.Count -ne 3 -or $before.snapshot.jobs.Count -ne 149){throw 'on-baseline'}
 $stage='RELAY_METADATA';$token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
 try{$r=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/functions' -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$r.StatusCode -ne 200 -or [Text.Encoding]::UTF8.GetByteCount($r.Content) -gt 1048576){throw 'relay-read'};$relay=@($r.Content|ConvertFrom-Json -AsHashtable)
  if($relay.Count -ne 1 -or $relay[0].id -cne '42f4d9e1-eddb-4b00-b574-399a489f78b4' -or $relay[0].slug -cne 'phase08-scheduled-relay' -or ($relay[0].version -isnot [int] -and $relay[0].version -isnot [long]) -or $relay[0].version -ne 2 -or $relay[0].status -cne 'ACTIVE' -or $relay[0].verify_jwt -isnot [bool] -or $relay[0].verify_jwt -ne $false -or $relay[0].ezbr_sha256 -cne 'f998dd2160b7d65dc8954f984c21b5432a9860250a0ffc5f2bf4da88b7503492'){throw 'relay-identity'}
 }finally{$headers.Clear();$headers=$null;$token=$null;$r=$null}
 $stage='REVIEWED_SQL';$path='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/reanchor-10am-20261015-v3.sql'
 if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'c63165c71894b2c8c4f815dcd88d83a541de6ad8226610a9d5a206920c28d939'){throw 'sql-pin'}
 $sql=[IO.File]::ReadAllText($path)
 $stage='ONE_TRANSACTION';$null=Invoke-Phase08Management -Action Query -Query $sql
 $stage='READBACK';$after=Get-Phase08SchedulerSnapshot
 $result=Invoke-Phase08SchedulerNode @{action='snapshot';mode='enable';definitions=@($next.definitions);before=$before;after=$after}
 if($result.state -cne 'PHASE08_BATCH_READBACK_VERIFIED'){throw 'snapshot'}
 $counts=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY; SELECT (SELECT count(*) FROM daily_data_sync_ops.attempts) AS attempts,(SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM daily_data_sync_ops.attempts a) AS attempts_digest,(SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) AS call_digest,(SELECT count(*) FROM phase08_meta_ads.sync_runs) AS runs; COMMIT;")
 if($counts.Count -ne 1 -or ($counts[0].attempts -isnot [int] -and $counts[0].attempts -isnot [long]) -or ($counts[0].runs -isnot [int] -and $counts[0].runs -isnot [long]) -or $counts[0].call_digest -cnotmatch '^[a-f0-9]{32}$' -or $counts[0].attempts -ne 152 -or $counts[0].attempts_digest -cne 'c044e6c4249188e410d31aacf57422dc' -or $counts[0].runs -ne 0){throw 'history'}
 $evidence=@{classification='ACTUAL_USER_APPROVED_ISOLATED_10AM_SCHEDULE';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;appReady=$true;databaseForceRls=68;schedules=$after.snapshot.schedules;activeJobs=149;stopped=$false;oldAttemptsPreserved=152;attemptsDigest=$counts[0].attempts_digest;callDigest=$counts[0].call_digest;runsBeforeAnchor=0;schemaPreserved=$true;otherCronPreserved=$true;operatingChanges=0}
 $out=Write-Phase08SchedulerPublicEvidence $evidence 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/reanchor-10am-actual-20261015.json'
 $evidence|ConvertTo-Json -Compress -Depth 8
}catch{@{state='PHASE08_ACCELERATED_SCHEDULE_FAILED';stage=$stage;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$sql=$null;$graph=$null;$database=$null}
