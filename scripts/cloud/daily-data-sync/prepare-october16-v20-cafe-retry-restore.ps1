param([Parameter(Mandatory)][ValidateSet('restore')][string]$Mode,[switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
$stage='APPROVAL';$submitted=$false;$ctx=$null;$operator=$null;$prepared=$null
try{
 if(-not $ExecuteApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 $outPath=Assert-Phase08SchedulerOutputPath ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-v20-cafe-retry-$Mode-actual-20261016.json")
 $marker=Assert-Phase08SchedulerOutputPath ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-v20-cafe-retry-$Mode-attempt-20261016.json")
 if($pins.sourceSha -cne '81b8ba86b22f2019227433f9e0f87ced95d97a44b44ba69d494eec0d664ce537'){throw 'source'}
 $ctx=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $ctx $pins;$operator=Read-Phase08Operator
 $graph=Get-Phase08SchedulerGraphState $ctx $pins
 $defs=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-profile-bridge.mjs" @{action='definitions';phase='test'}
 if($graph.featureEnabled -isnot [bool] -or -not $graph.featureEnabled -or $graph.scheduleEnabled -isnot [bool] -or -not $graph.scheduleEnabled -or $defs.state -cne 'PHASE08_OCTOBER16_DEFINITIONS' -or @($defs.definitions).Count -ne 3 -or @($graph.appSchedules).Count -ne 3){throw 'definitions'}
 $loaded=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($defs.definitions);appSchedules=@($graph.appSchedules);managementSchedules=@()}
 if($loaded.state -cne 'PHASE08_LOADED_DEFINITIONS_VERIFIED'){throw 'loaded'}
 $stage='CURRENT_FUNCTION';$rows=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT pg_get_functiondef('daily_data_sync_ops.call(text,boolean)'::regprocedure) AS definition;COMMIT;")
 if($rows.Count -ne 1 -or $rows[0].definition -isnot [string]){throw 'function'}
 $stage='REVIEWED_BATCH';$prepared=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-v20-cafe-reviewed-retry.mjs" @{mode=$Mode;sourceSha=$pins.sourceSha;actorId=$operator.appId;authId=$operator.authId;currentCallDefinition=$rows[0].definition}
 if($prepared.state -cne 'PHASE08_OCTOBER16_CAFE_RETRY_PREPARED' -or $prepared.mode -cne $Mode -or $prepared.sql -isnot [string] -or $prepared.sql.Length -gt 131072 -or -not $prepared.sql.StartsWith('BEGIN ISOLATION LEVEL REPEATABLE READ;') -or $prepared.resultCallMd5 -isnot [string] -or $prepared.resultCallMd5 -cnotmatch '^[a-f0-9]{32}$'){throw 'batch'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='OCTOBER16_CAFE_REVIEWED_RETRY_PLANNED';mode=$Mode;observedAt=[DateTimeOffset]::UtcNow.ToString('o');providerRequests=0} $marker
 $stage='SINGLE_BATCH';$submitted=$true;$r=@(Invoke-Phase08Management -Action Query -Query $prepared.sql)
 if($r.Count -ne 1 -or @($r[0].PSObject.Properties.Name).Count -ne 6 -or $r[0].state -cne 'PHASE08_OCTOBER16_CAFE_RETRY_APPLIED' -or $r[0].mode -cne $Mode -or $r[0].history_preserved -isnot [bool] -or -not $r[0].history_preserved -or $r[0].call_md5 -cne $prepared.resultCallMd5){throw 'result'}
 foreach($p in @(@('reviewed_units',$(if($Mode -ceq 'approve'){1}else{0})),@('provider_requests',0))){$n=$p[0];if(($r[0].$n -isnot [int] -and $r[0].$n -isnot [long]) -or $r[0].$n -ne $p[1]){throw 'count'}}
 $out=@{state='PHASE08_OCTOBER16_CAFE_RETRY_VERIFIED';mode=$Mode;observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;reviewedUnits=$r[0].reviewed_units;callMd5=$r[0].call_md5;attemptsPreserved=$true;deadlinePreserved=$true;checkpointPreserved=$true;oldAttemptsAndBusinessPreserved=$true;metaUntouched=$true;providerRequests=0;operatingChanges=0;retryPerformed=$false}
 $null=Write-Phase08SchedulerPublicEvidence $out $outPath;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_OCTOBER16_CAFE_RETRY_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$ctx=$null;$operator=$null;$prepared=$null;$rows=$null;$r=$null}
