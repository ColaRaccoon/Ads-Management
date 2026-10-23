param([switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
$stage='APPROVAL';$submitted=$false;$context=$null;$operator=$null;$prepared=$null
try{
 if(-not $ExecuteApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-cafe-admin-fixture-actual-20261015.json'
 $marker=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-cafe-admin-fixture-attempt-20261015.json'
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$operator=Read-Phase08Operator
 if($pins.sourceSha -cne 'e83351e69260d94a6aaebb5ff6d109bd38aa0570b3bdbc1f55069d8a3b39d44f'){throw 'source'}
 $stage='REVIEWED_APP';$graph=Get-Phase08SchedulerGraphState $context $pins
 $defs=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-profile-bridge.mjs" @{action='definitions';phase='collection'}
 if($defs.state -cne 'PHASE08_AFTERNOON_DEFINITIONS'){throw 'defs'}
 $null=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($defs.definitions);appSchedules=@($graph.appSchedules);managementSchedules=@()}
 $stage='CURRENT_STATE';$snapshot=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-profile-bridge.mjs" @{action='state-sql'}
 if($snapshot.state -cne 'PHASE08_AFTERNOON_STATE_SQL' -or $snapshot.sql -isnot [string] -or -not $snapshot.sql.StartsWith('BEGIN READ ONLY;')){throw 'snapshot-source'}
 $rows=@(Invoke-Phase08Management -Action Query -Query $snapshot.sql)
 if($rows.Count -ne 1 -or @($rows[0].PSObject.Properties.Name).Count -ne 3){throw 'snapshot-shape'}
 $expected=@{};foreach($name in @('settingsMd5','schedulesMd5','jobsMd5')){if($rows[0].$name -isnot [string] -or $rows[0].$name -cnotmatch '^[a-f0-9]{32}$'){throw 'snapshot-digest'};$expected[$name]=$rows[0].$name}
 $current=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT pg_get_functiondef('daily_data_sync_ops.call(text,boolean)'::regprocedure) AS definition,md5(prosrc) AS md5 FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure;ROLLBACK;")
 if($current.Count -ne 1 -or $current[0].definition -isnot [string] -or $current[0].definition.Length -gt 30000 -or $current[0].md5 -cne '03d7cf6f24da00e3c577b28cd979b951'){throw 'original-call'}
 $stage='REVIEWED_FIXTURE_SQL';$prepared=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-cafe-fixture.mjs" @{actorId=$operator.appId;authId=$operator.authId;currentCallDefinition=$current[0].definition;expectedState=$expected}
 if($prepared.state -cne 'PHASE08_CAFE_FIXTURE_PREPARED' -or $prepared.sql -isnot [string] -or $prepared.sql.Length -gt 131072 -or -not $prepared.sql.StartsWith('BEGIN ISOLATION LEVEL REPEATABLE READ;') -or $prepared.resultCallMd5 -cne 'fd90904cdf9cf3f6ef962ab8c2cbfc3f'){throw 'prepared'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='ADMIN_PREPARED_FRESH_CAFE_REPLAY_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;automaticQueue=$false;providerRequests=0;successfulUnitsInherited=0} $marker
 $stage='SINGLE_TRANSACTION';$submitted=$true;$result=@(Invoke-Phase08Management -Action Query -Query $prepared.sql)
 if($result.Count -ne 1 -or @($result[0].PSObject.Properties.Name).Count -ne 7 -or $result[0].state -cne 'PHASE08_CAFE_FIXTURE_APPLIED' -or $result[0].call_md5 -cne $prepared.resultCallMd5 -or $result[0].prior_business_preserved -isnot [bool] -or -not $result[0].prior_business_preserved){throw 'result'}
 foreach($pair in @(@('new_runs',1),@('new_units',1),@('inherited_successful_units',0),@('provider_requests',0))){$name=$pair[0];if(($result[0].$name -isnot [int] -and $result[0].$name -isnot [long]) -or $result[0].$name -ne $pair[1]){throw 'result-count'}}
 $out=@{state='PHASE08_ADMIN_CAFE_REPLAY_FIXTURE_VERIFIED';classification='ADMIN_PREPARED_QUEUED_TEST_FIXTURE_ONLY';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;globalStopped=$true;newRuns=1;newUnits=1;unitStatus='QUEUED';unitAttempts=0;fetchedRows=0;publishedRows=0;successfulUnitsInherited=0;automaticQueue=$false;actualCollectionCompleted=$false;providerRequests=0;priorBusinessPreserved=$true;operatorAudit=1;retryApprovalMarkers=1;callMd5=$prepared.resultCallMd5;deadlineAt='2026-10-15T08:30:00.000Z';operatingChanges=0}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_CAFE_REPLAY_FIXTURE_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$operator=$null;$prepared=$null;$current=$null;$rows=$null;$result=$null}
