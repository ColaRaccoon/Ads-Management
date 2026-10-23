param([Parameter(Mandatory)][ValidateSet('test','normal')][string]$Phase,[switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
$stage='APPROVAL';$submitted=$false;$context=$null;$operator=$null;$prepared=$null;$current=$null
try{
 if(-not $ExecuteApproved){throw 'approval'}
 Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-profile-'+$Phase+'-actual-20261016.json')
 $marker=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-profile-'+$Phase+'-attempt-20261016.json')
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$operator=Read-Phase08Operator
 if($pins.sourceSha -cne '898bb25b5cc3fca6437d8a284b11e71045cb6e74e073acb848affa0498ae58d9'){throw 'source'}
 $stage='LIVE_APP';$graph=Get-Phase08SchedulerGraphState $context $pins;$null=Get-Phase08SchedulerReady $context $pins
 $wanted=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-profile-bridge.mjs" @{action='definitions';phase=$Phase}
 if($wanted.state -cne 'PHASE08_OCTOBER16_DEFINITIONS' -or @($graph.appSchedules).Count -ne 3){throw 'profile'}
 foreach($d in $wanted.definitions){$row=@($graph.appSchedules|Where-Object {$_.key -ceq $d.key});if($row.Count -ne 1 -or $row[0].connectionId -cne $d.connectionId -or $row[0].anchorAt -cne $d.anchorAt -or $row[0].windowMinutes -ne $d.windowMinutes){throw 'app-profile'}}
 $stage='FRESH_DATABASE_SNAPSHOT';$snapshot=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-profile-bridge.mjs" @{action='state-sql'}
 if($snapshot.state -cne 'PHASE08_OCTOBER16_STATE_SQL' -or $snapshot.sql -isnot [string] -or -not $snapshot.sql.StartsWith('BEGIN READ ONLY;')){throw 'snapshot-sql'}
 $rows=@(Invoke-Phase08Management -Action Query -Query $snapshot.sql)
 if($rows.Count -ne 1){throw 'snapshot-count'}
 $snapshotNames=if($rows[0] -is [Collections.IDictionary]){@($rows[0].Keys)}else{@($rows[0].PSObject.Properties.Name)}
 if($snapshotNames.Count -ne 3 -or @($snapshotNames|Where-Object {$_ -cnotin @('settingsMd5','schedulesMd5','jobsMd5')}).Count -ne 0){throw 'snapshot-shape'}
 $expected=@{};foreach($name in @('settingsMd5','schedulesMd5','jobsMd5')){if($rows[0].$name -isnot [string] -or $rows[0].$name -cnotmatch '^[a-f0-9]{32}$'){throw 'snapshot-digest'};$expected[$name]=$rows[0].$name}
 $current=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT pg_get_functiondef('daily_data_sync_ops.call(text,boolean)'::regprocedure) AS definition,md5(prosrc) AS md5 FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure;COMMIT;")
 $allowedCalls=if($Phase -ceq 'test'){@('045fe672fe54192342df81d1c280eff4')}else{@('05b1727f6a87277934521115edca5e4f')}
 if($current.Count -ne 1 -or $current[0].definition -isnot [string] -or $current[0].definition.Length -gt 30000 -or $current[0].md5 -isnot [string] -or $current[0].md5 -cnotin $allowedCalls){throw 'current-call'}
 $stage='BUILD';$prepared=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-profile-bridge.mjs" @{action='batch';value=@{phase=$Phase;currentCallDefinition=$current[0].definition;expectedCallMd5=$current[0].md5;expectedState=$expected;actorId=$operator.appId;authId=$operator.authId}}
 if($prepared.state -cne 'OCTOBER16_PROFILE_SQL_PREPARED' -or $prepared.sql -isnot [string] -or $prepared.sql.Length -gt 1048576 -or $prepared.resultCallMd5 -cne $(if($Phase -ceq 'normal'){'0f11e36961a628ab665302b950d0b9aa'}else{'05b1727f6a87277934521115edca5e4f'})){throw 'prepared'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='EXPLICIT_TEST_PROFILE_TRANSACTION_PLANNED';phase=$Phase;observedAt=[DateTimeOffset]::UtcNow.ToString('o');providerRequests=0;originalHistoryInherited=$false} $marker
 $stage='SINGLE_BATCH';$submitted=$true;$result=@(Invoke-Phase08Management -Action Query -Query $prepared.sql)
 if($result.Count -ne 1 -or $result[0].state -cne 'OCTOBER16_PROFILE_APPLIED' -or $result[0].call_md5 -cne $prepared.resultCallMd5 -or $result[0].history_preserved -isnot [bool] -or -not $result[0].history_preserved){throw 'result'}
 foreach($n in @('total_jobs','active_jobs')){if($result[0].$n -isnot [int] -and $result[0].$n -isnot [long]){throw 'result-type'}}
 if($result[0].total_jobs -ne 149 -or $result[0].active_jobs -ne 149){throw 'jobs'}
 $stage='READBACK';$after=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT (SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) AS stopped,(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%') AS jobs,(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS active,(SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) AS call_md5,(SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM daily_data_sync_ops.attempts a WHERE id<=152) AS original_history;COMMIT;")
 if($after.Count -ne 1 -or $after[0].stopped -isnot [bool] -or -not $after[0].stopped -or $after[0].jobs -ne 149 -or $after[0].active -ne $result[0].active_jobs -or $after[0].call_md5 -cne $prepared.resultCallMd5 -or $after[0].original_history -cne 'c044e6c4249188e410d31aacf57422dc'){throw 'readback'}
 foreach($n in @('jobs','active')){if($after[0].$n -isnot [int] -and $after[0].$n -isnot [long]){throw 'readback-type'}}
 $out=@{state='PHASE08_OCTOBER16_PROFILE_VERIFIED';phase=$Phase;observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;totalJobs=149;activeJobs=$result[0].active_jobs;callMd5=$prepared.resultCallMd5;globalStopped=$true;allBusinessAndHistoryPreserved=$true;original152Preserved=$true;userAudit=1;providerRequests=0;operatingChanges=0;previousUnitsInherited=$false}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_OCTOBER16_PROFILE_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$operator=$null;$prepared=$null;$current=$null;$rows=$null;$result=$null;$after=$null;$graph=$null}
