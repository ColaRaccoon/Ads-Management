param([Parameter(Mandatory)][ValidateSet('2026-10-11','2026-10-12','2026-10-13','2026-10-14')][string]$LastDay,[switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
$stage='APPROVAL';$submitted=$false;$ctx=$null;$operator=$null
try{
 if(-not $ExecuteApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '81b8ba86b22f2019227433f9e0f87ced95d97a44b44ba69d494eec0d664ce537' -or $pins.deploymentId -cne 'defd778f-8b6c-4e76-9555-5693a856099b'){throw 'pin'}
 $outPath=Assert-Phase08SchedulerOutputPath ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-meta-cooldown-$LastDay-actual-20261016.json")
 $marker=Assert-Phase08SchedulerOutputPath ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-meta-cooldown-$LastDay-attempt-20261016.json")
 $ctx=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $ctx $pins;$operator=Read-Phase08Operator
 $stage='GRAPH';$graph=Get-Phase08SchedulerGraphState $ctx $pins;$defs=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-profile-bridge.mjs" @{action='definitions';phase='test'}
 if($graph.featureEnabled -isnot [bool] -or -not $graph.featureEnabled -or $graph.scheduleEnabled -isnot [bool] -or -not $graph.scheduleEnabled -or $defs.state -cne 'PHASE08_OCTOBER16_DEFINITIONS' -or @($defs.definitions).Count -ne 3 -or @($graph.appSchedules).Count -ne 3){throw 'definitions'}
 $loaded=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($defs.definitions);appSchedules=@($graph.appSchedules);managementSchedules=@()};if($loaded.state -cne 'PHASE08_LOADED_DEFINITIONS_VERIFIED'){throw 'loaded'}
 $stage='BATCH';$p=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-meta-success-cooldown.mjs" @{lastDay=$LastDay;sourceSha=$pins.sourceSha;actorId=$operator.appId;authId=$operator.authId}
 if($p.state -cne 'PHASE08_META_COOLDOWN_PREPARED' -or $p.lastDay -cne $LastDay -or $p.sql -isnot [string] -or $p.sql.Length -gt 32768 -or -not $p.sql.StartsWith('BEGIN ISOLATION LEVEL REPEATABLE READ;') -or -not $p.sql.EndsWith('COMMIT;')){throw 'batch'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='MANUAL_SUCCESS_COOLDOWN_RELEASE_PLANNED';day=$LastDay;providerRequests=0} $marker
 $stage='SINGLE_BATCH';$submitted=$true;$r=@(Invoke-Phase08Management -Action Query -Query $p.sql)
 if($r.Count -ne 1 -or @($r[0].PSObject.Properties.Name).Count -ne 5 -or $r[0].state -cne 'PHASE08_META_COOLDOWN_RELEASED' -or $r[0].last_day -cne $LastDay -or $r[0].next_attempt_cleared -isnot [bool] -or -not $r[0].next_attempt_cleared -or $r[0].history_preserved -isnot [bool] -or -not $r[0].history_preserved -or ($r[0].provider_requests -isnot [int] -and $r[0].provider_requests -isnot [long]) -or $r[0].provider_requests -ne 0){throw 'result'}
 $out=@{state='PHASE08_META_SUCCESS_COOLDOWN_VERIFIED';classification='MANUAL_WAIT_ONLY_ASSISTANCE_AFTER_ACTUAL_CRON_PUBLICATION';lastDay=$LastDay;observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;nextAttemptCleared=$true;attemptsDeadlineStatusSafeCodePreserved=$true;allOtherBusinessOpsVaultPreserved=$true;providerRequests=0;operatingChanges=0;collectionTriggered=$false}
 $null=Write-Phase08SchedulerPublicEvidence $out $outPath;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_META_SUCCESS_COOLDOWN_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$ctx=$null;$operator=$null;$graph=$null;$p=$null;$r=$null}
