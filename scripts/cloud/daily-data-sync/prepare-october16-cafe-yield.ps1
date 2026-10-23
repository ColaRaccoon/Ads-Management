param([Parameter(Mandatory)][ValidateSet('yield','restore')][string]$Mode,[Parameter(Mandatory)][ValidateSet('11:15','11:20','11:25','11:30','11:35','11:40','11:45')][string]$Slot,[switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
$stage='APPROVAL';$submitted=$false;$ctx=$null;$operator=$null
try{
 if(-not $ExecuteApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '898bb25b5cc3fca6437d8a284b11e71045cb6e74e073acb848affa0498ae58d9' -or $pins.deploymentId -cnotin @('aac4ad45-b0ab-4106-a88a-c50ae7151423','5f6c56de-47a1-4f34-9194-c7ea1f42a8c6')){throw 'pin'}
 $name=$Slot.Replace(':','');$outPath=Assert-Phase08SchedulerOutputPath ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-cafe-yield-$name-$Mode-actual-20261016.json")
 $marker=Assert-Phase08SchedulerOutputPath ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-cafe-yield-$name-$Mode-attempt-20261016.json")
 $ctx=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $ctx $pins;$operator=Read-Phase08Operator
 $stage='GRAPH';$graph=Get-Phase08SchedulerGraphState $ctx $pins;$defs=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-profile-bridge.mjs" @{action='definitions';phase='test'}
 if($graph.featureEnabled -isnot [bool] -or -not $graph.featureEnabled -or $graph.scheduleEnabled -isnot [bool] -or -not $graph.scheduleEnabled -or $defs.state -cne 'PHASE08_OCTOBER16_DEFINITIONS' -or @($defs.definitions).Count -ne 3 -or @($graph.appSchedules).Count -ne 3){throw 'loaded-flags'}
 $loaded=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($defs.definitions);appSchedules=@($graph.appSchedules);managementSchedules=@()}
 if($loaded.state -cne 'PHASE08_LOADED_DEFINITIONS_VERIFIED'){throw 'loaded'}
 $stage='BATCH';$p=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-cafe-admission-yield.mjs" @{mode=$Mode;slot=$Slot;sourceSha=$pins.sourceSha;actorId=$operator.appId;authId=$operator.authId}
 if($p.state -cne 'PHASE08_CAFE_YIELD_PREPARED' -or $p.mode -cne $Mode -or $p.slot -cne $Slot -or $p.sql -isnot [string] -or $p.sql.Length -gt 32768 -or -not $p.sql.StartsWith('BEGIN ISOLATION LEVEL REPEATABLE READ;') -or -not $p.sql.EndsWith('COMMIT;')){throw 'batch'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='OCTOBER16_CAFE_ADMISSION_CHANGE_PLANNED';mode=$Mode;slot=$Slot;providerRequests=0} $marker
 $stage='SINGLE_BATCH';$submitted=$true;$r=@(Invoke-Phase08Management -Action Query -Query $p.sql)
 if($r.Count -ne 1 -or @($r[0].PSObject.Properties.Name).Count -ne 6 -or $r[0].state -cne 'PHASE08_CAFE_YIELD_APPLIED' -or $r[0].mode -cne $Mode -or $r[0].slot -cne $Slot -or $r[0].paused -isnot [bool] -or $r[0].paused -ne ($Mode -ceq 'yield') -or $r[0].history_preserved -isnot [bool] -or -not $r[0].history_preserved -or ($r[0].provider_requests -isnot [int] -and $r[0].provider_requests -isnot [long]) -or $r[0].provider_requests -ne 0){throw 'result'}
 $out=@{state='PHASE08_CAFE_ADMISSION_CHANGE_VERIFIED';mode=$Mode;slot=$Slot;observedAt=[DateTimeOffset]::UtcNow.ToString('o');paused=$r[0].paused;restoreRequired=($Mode -ceq 'yield');automaticRestore=$false;historyPreserved=$true;otherSchedulesUntouched=$true;providerRequests=0;operatingChanges=0}
 $null=Write-Phase08SchedulerPublicEvidence $out $outPath;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_CAFE_ADMISSION_CHANGE_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$ctx=$null;$operator=$null;$graph=$null;$p=$null;$r=$null}
