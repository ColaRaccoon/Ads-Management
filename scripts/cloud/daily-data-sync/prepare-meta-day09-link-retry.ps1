param([switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
$stage='APPROVAL';$submitted=$false;$context=$null;$operator=$null;$prepared=$null
try{
 if(-not $ExecuteApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-day09-link-retry-actual-20261015.json'
 $marker=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-day09-link-retry-attempt-20261015.json'
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$operator=Read-Phase08Operator
 if($pins.sourceSha -cne '436055128dad4b150f6ff4c3a754d1cadc3b9cb784f3d659423df35f33f773ff'){throw 'source'}
 $stage='REVIEWED_APP';$graph=Get-Phase08SchedulerGraphState $context $pins;$null=Get-Phase08SchedulerReady $context $pins
 $defs=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-profile-bridge.mjs" @{action='definitions';phase='collection'}
 if($defs.state -cne 'PHASE08_AFTERNOON_DEFINITIONS'){throw 'defs'}
 $null=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($defs.definitions);appSchedules=@($graph.appSchedules);managementSchedules=@()}
 $stage='CURRENT_CALL';$current=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT pg_get_functiondef('daily_data_sync_ops.call(text,boolean)'::regprocedure) AS definition,md5(prosrc) AS md5 FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure;ROLLBACK;")
 if($current.Count -ne 1 -or $current[0].definition -isnot [string] -or $current[0].definition.Length -gt 30000 -or $current[0].md5 -cne 'fd90904cdf9cf3f6ef962ab8c2cbfc3f'){throw 'call'}
 $stage='REVIEWED_SQL';$prepared=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-meta-link-retry.mjs" @{actorId=$operator.appId;authId=$operator.authId;currentCallDefinition=$current[0].definition}
 if($prepared.state -cne 'PHASE08_META_LINK_RETRY_PREPARED' -or $prepared.sql -isnot [string] -or $prepared.sql.Length -gt 131072 -or -not $prepared.sql.StartsWith('BEGIN ISOLATION LEVEL REPEATABLE READ;') -or $prepared.resultCallMd5 -cne '045fe672fe54192342df81d1c280eff4'){throw 'prepared'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='ADMIN_REVIEWED_SAME_DAY_CORRECTION_RETRY_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;providerRequests=0;deadlineExtended=$false} $marker
 $stage='SINGLE_TRANSACTION';$submitted=$true;$result=@(Invoke-Phase08Management -Action Query -Query $prepared.sql)
 if($result.Count -ne 1 -or @($result[0].PSObject.Properties.Name).Count -ne 5 -or $result[0].state -cne 'PHASE08_META_LINK_RETRY_APPLIED' -or $result[0].call_md5 -cne $prepared.resultCallMd5 -or $result[0].prior_business_preserved -isnot [bool] -or -not $result[0].prior_business_preserved){throw 'result'}
 foreach($pair in @(@('reviewed_units',1),@('provider_requests',0))){$name=$pair[0];if(($result[0].$name -isnot [int] -and $result[0].$name -isnot [long]) -or $result[0].$name -ne $pair[1]){throw 'count'}}
 $out=@{state='PHASE08_META_DAY09_LINK_RETRY_REVIEWED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;unitDay='2026-10-09';previousUnitStatus='ACTION_REQUIRED';unitStatus='FAILED';unitAttemptsPreserved=1;firstSuccessfulUnitPreserved=$true;priorBusinessPreserved=$true;failureAuditPreserved=$true;operatorAudit=1;approvalMarkers=1;callMd5=$prepared.resultCallMd5;originalDeadline='2026-10-15T08:30:00.000Z';deadlineExtended=$false;providerRequests=0;collectionCompleted=$false;operatingChanges=0}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_META_DAY09_LINK_RETRY_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$operator=$null;$prepared=$null;$current=$null;$result=$null;$out=$null}
