param([Parameter(Mandatory)][string]$EvidencePath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$stage='REVIEWED_SOURCE';$context=$null;$prepared=$null
try {
 $outPath=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/normal-02-db-restore-actual-20261015.json'
 $configPath=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/schedules-20261015-normal-02-v11.json'
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$null=Get-Phase08SchedulerGraphState $context $pins
 $file=Get-Item -LiteralPath $EvidencePath;if($file.PSIsContainer -or $file.Length -gt 65536 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'proof-file'}
 $proof=[IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json -AsHashtable -DateKind String
 $stage='READONLY_FUNCTION';$rows=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT pg_get_functiondef('daily_data_sync_ops.call(text,boolean)'::regprocedure) AS definition,(SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) AS hash;COMMIT;")
 if($rows.Count -ne 1 -or $rows[0].definition -isnot [string] -or $rows[0].hash -cne '3c965ba93beb63a64819ba1bce36ba8f'){throw 'function'}
 $stage='SIGNED_SQL';$prepared=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'restore-02-bridge.mjs') @{envelope=$proof;definition=$rows[0].definition;prosrcMd5=$rows[0].hash}
 if($prepared.state -cne 'PHASE08_NORMAL_02_SQL_PREPARED' -or $prepared.sql -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($prepared.sql) -gt 131072 -or $prepared.sqlSha256 -cnotmatch '^[a-f0-9]{64}$' -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($prepared.sql))).ToLowerInvariant() -cne $prepared.sqlSha256){throw 'sql'}
 $checked=Invoke-Phase08SchedulerNode @{action='definitions';definitions=@($prepared.normalDefinitions);observedAt=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
 if(@($checked.definitions).Count -ne 3){throw 'normal-definitions'}
 $stage='GUARDED_TRANSACTION';$result=@(Invoke-Phase08Management -Action Query -Query $prepared.sql)
 if($result.Count -ne 1 -or $result[0].state -cne 'RESTORE_02_DATABASE_ONLY_VERIFIED' -or $result[0].history_preserved -isnot [bool] -or -not $result[0].history_preserved){throw 'result'}
 foreach($n in @('jobs','schedules','retained_checkpoint_count','retained_unexpired_checkpoint_count')){if(($result[0].$n -isnot [int] -and $result[0].$n -isnot [long]) -or $result[0].$n -lt 0){throw 'result-number'}}
 if($result[0].jobs -ne 149 -or $result[0].schedules -ne 3 -or $result[0].retained_unexpired_checkpoint_count -gt $result[0].retained_checkpoint_count -or $result[0].app_definitions_changed -isnot [bool] -or $result[0].app_definitions_changed -or $result[0].edge_deployed -isnot [bool] -or $result[0].edge_deployed){throw 'result-boundary'}
 $stage='READBACK';$back=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) AS hash,(SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) AS stopped,(SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active)::int AS active_jobs,(SELECT count(*) FROM daily_data_sync_ops.schedules WHERE paused)::int AS paused,(SELECT json_agg(json_build_object('key',key,'anchorAt',anchor_at::text) ORDER BY key) FROM daily_data_sync_ops.schedules) AS schedules;COMMIT;")
 if($back.Count -ne 1 -or $back[0].hash -cne '0f11e36961a628ab665302b950d0b9aa' -or $back[0].stopped -isnot [bool] -or -not $back[0].stopped -or ($back[0].active_jobs -isnot [int] -and $back[0].active_jobs -isnot [long]) -or ($back[0].paused -isnot [int] -and $back[0].paused -isnot [long]) -or $back[0].active_jobs -ne 149 -or $back[0].paused -ne 1){throw 'readback'}
 if(@($back[0].schedules).Count -ne 3){throw 'readback-clock'}
 foreach($expected in $prepared.normalDefinitions){$found=@($back[0].schedules|Where-Object {$_.key -ceq $expected.key});if($found.Count -ne 1 -or $found[0].anchorAt -isnot [string] -or [DateTimeOffset]::Parse($found[0].anchorAt).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') -cne $expected.anchorAt){throw 'readback-clock'}}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence @($prepared.normalDefinitions) $configPath
 $out=@{state='PHASE08_NORMAL_02_DATABASE_RESTORED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sqlSha256=$prepared.sqlSha256;historyPreserved=$true;businessTablesPreserved=68;activeJobs=149;globalStopped=$true;metaPaused=$true;appDefinitionsChanged=$false;edgeDeployed=$false;providerRequests=0;operatingChanges=0;configurationPath=$configPath}
 $null=Write-Phase08SchedulerPublicEvidence $out $outPath;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_NORMAL_02_DATABASE_RESTORE_FAILED';stage=$stage;outcomeUncertain=($stage -cin @('GUARDED_TRANSACTION','READBACK','PUBLIC_EVIDENCE'));inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$prepared=$null;$rows=$null;$proof=$null;$result=$null;$back=$null}
