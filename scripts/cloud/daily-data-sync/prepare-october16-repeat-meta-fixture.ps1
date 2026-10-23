param([switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
$stage='APPROVAL';$submitted=$false;$context=$null;$operator=$null;$prepared=$null
try{
 if(-not $ExecuteApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-repeat-meta-fixture-actual-20261016.json'
 $marker=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-repeat-meta-fixture-attempt-20261016.json'
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$operator=Read-Phase08Operator
 if($pins.sourceSha -cne 'f7592804a9763eb228d7c97be00479431700e78b7c57e4544b4c6a863556e4df'){throw 'source'}
 $stage='REVIEWED_APP';$graph=Get-Phase08SchedulerGraphState $context $pins;$null=Get-Phase08SchedulerReady $context $pins
 $defs=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-repeat-profile-bridge.mjs" @{action='definitions';phase='test'}
 if($defs.state -cne 'PHASE08_OCTOBER16_DEFINITIONS'){throw 'definitions'}
 $loaded=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($defs.definitions);appSchedules=@($graph.appSchedules);managementSchedules=@()};if($loaded.state -cne 'PHASE08_LOADED_DEFINITIONS_VERIFIED'){throw 'loaded'}
 $stage='REVIEWED_SQL';$prepared=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-repeat-meta-fixture.mjs" @{actorId=$operator.appId;authId=$operator.authId;sourceSha=$pins.sourceSha}
 if($prepared.state -cne 'PHASE08_OCTOBER16_META_FIXTURE_PREPARED' -or $prepared.sql -isnot [string] -or $prepared.sql.Length -gt 131072 -or -not $prepared.sql.StartsWith('BEGIN ISOLATION LEVEL REPEATABLE READ;')){throw 'prepared'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='ADMIN_PREPARED_META_WEEKLY_TEST_PLANNED';sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;observedAt=[DateTimeOffset]::UtcNow.ToString('o');automaticQueue=$false;providerRequests=0;successfulUnitsInherited=0} $marker
 $stage='SINGLE_TRANSACTION';$submitted=$true;$result=@(Invoke-Phase08Management -Action Query -Query $prepared.sql)
 if($result.Count -ne 1 -or @($result[0].PSObject.Properties.Name).Count -ne 6 -or $result[0].state -cne 'PHASE08_OCTOBER16_META_FIXTURE_APPLIED' -or $result[0].prior_business_preserved -isnot [bool] -or -not $result[0].prior_business_preserved){throw 'result'}
 foreach($pair in @(@('new_runs',1),@('new_units',7),@('inherited_successful_units',0),@('provider_requests',0))){$name=$pair[0];if(($result[0].$name -isnot [int] -and $result[0].$name -isnot [long]) -or $result[0].$name -ne $pair[1]){throw 'count'}}
 $out=@{state='PHASE08_OCTOBER16_META_FIXTURE_VERIFIED';classification='ADMIN_PREPARED_QUEUED_TEST_FIXTURE_ONLY';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;newRuns=1;newUnits=7;unitStatus='QUEUED';unitAttempts=0;fetchedRows=0;publishedRows=0;successfulUnitsInherited=0;automaticQueue=$false;actualCollectionCompleted=$false;providerRequests=0;priorBusinessPreserved=$true;operatorAudit=1;deadlineAt='2026-10-16T05:00:00.000Z';operatingChanges=0}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_OCTOBER16_META_FIXTURE_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$operator=$null;$prepared=$null;$result=$null;$out=$null}
