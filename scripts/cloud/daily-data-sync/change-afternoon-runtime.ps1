param([Parameter(Mandatory)][ValidateSet('remove-outage','restore-outage','collection','restart','normal')][string]$Action,[switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/afternoon-runtime-helpers.ps1"
$stage='APPROVAL';$submitted=$false;$context=$null;$vars=$null
try{
 if(-not $ExecuteApproved){throw 'approval'}
 Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-runtime-'+$Action+'-actual-20261015.json')
 $marker=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-runtime-'+$Action+'-attempt-20261015.json')
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 if($pins.sourceSha -cne '42c15d089e41db8fb4286209bcf8975eb4c9ec3aa61b23f459aa49bd3024764f'){throw 'source'}
 $stage='REAL_CLOCK';$now=[DateTimeOffset]::UtcNow
 $start=if($Action -ceq 'remove-outage'){'2026-10-15T05:58:30Z'}elseif($Action -cin @('restore-outage','collection')){'2026-10-15T06:38:00Z'}else{'2026-10-15T07:00:30Z'}
 $end=if($Action -ceq 'remove-outage'){'2026-10-15T05:59:45Z'}elseif($Action -cin @('restore-outage','collection')){'2026-10-15T06:59:00Z'}elseif($Action -ceq 'restart'){'2026-10-15T08:15:00Z'}else{'2026-10-15T13:00:00Z'}
 if($now -lt [DateTimeOffset]$start -or $now -ge [DateTimeOffset]$end){throw 'clock'}
 $phase=if($Action -cin @('remove-outage','restore-outage')){'outage'}elseif($Action -ceq 'normal'){'normal'}else{'collection'}
 $stage='FRESH_DATABASE';$db=Get-Phase08AfternoonRuntimeSnapshot
 $expectedStopped=$Action -cne 'remove-outage';$expectedActive=if($phase -ceq 'outage'){138}else{149}
 if($db.stopped -ne $expectedStopped -or $db.active_jobs -ne $expectedActive -or $db.live_leases -ne 0 -or $db.outage_runs -ne 0){throw 'database'}
 if($Action -ceq 'remove-outage' -and ($db.outage_work_attempts -ne 0 -or $db.outage_inspections -ne 0 -or $db.outage_audits -ne 0)){throw 'outage-started'}
 if($Action -ceq 'restore-outage' -and ($db.outage_work_attempts -lt 1 -or $db.outage_audits -ne 1)){throw 'outage-not-observed'}
 if($Action -ceq 'restart' -and ($db.collection_succeeded_units -lt 1 -or $db.collection_succeeded_units -gt 6)){throw 'restart-not-between-units'}
 $stage='LIVE_FIXED_CONFIGURATION';$profile=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-profile-bridge.mjs" @{action='definitions';phase=$phase}
 $vars=(Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' @{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}).variables
 if($vars.PHASE08_SOURCE_CONTENT_SHA256 -cne $pins.sourceSha -or $vars.Count -ne 101 -or $vars.DAILY_SYNC_FEATURE_ENABLED -cne 'true' -or $vars.DAILY_SYNC_SCHEDULE_ENABLED -cne 'true'){throw 'variables'}
 $loaded=@($vars.DAILY_SYNC_SCHEDULES|ConvertFrom-Json -AsHashtable -DateKind String);if($loaded.Count -ne 3 -or $profile.state -cne 'PHASE08_AFTERNOON_DEFINITIONS'){throw 'definitions'}
 foreach($d in $profile.definitions){$row=@($loaded|Where-Object {$_.key -ceq $d.key});if($row.Count -ne 1 -or $row[0].Count -ne 4 -or $row[0].connectionId -cne $d.connectionId -or $row[0].anchorAt -cne $d.anchorAt -or ($row[0].windowMinutes -isnot [int] -and $row[0].windowMinutes -isnot [long]) -or $row[0].windowMinutes -ne $d.windowMinutes){throw 'profile'}}
 $stage='ACTUAL_SERVICE';$service=Get-Phase08AfternoonRuntimeService $pins
 if($Action -ceq 'restore-outage'){if($service.latestDeployment.status -cne 'REMOVED' -or @($service.activeDeployments).Count -ne 0 -or -not $service.latestDeployment.canRedeploy){throw 'restore-capability'}}else{if($service.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or @($service.activeDeployments).Count -ne 1 -or $service.activeDeployments[0].id -cne $pins.deploymentId -or -not $service.latestDeployment.canRedeploy){throw 'active-service'}}
 $kind=if($Action -ceq 'remove-outage'){'ACTUAL_ISOLATED_RUNTIME_REMOVAL_PLANNED'}else{'ACTUAL_ISOLATED_SAME_IMAGE_REDEPLOY_PLANNED'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification=$kind;action=$Action;observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;oldDeploymentId=$pins.deploymentId;before=$db;providerRequestsByController=0;restoreFallback='FROZEN_APPROVED_V13_SOURCE_UPLOAD'} $marker
 $stage='SINGLE_MUTATION';$submitted=$true
 $freshNow=[DateTimeOffset]::UtcNow;if($freshNow -lt [DateTimeOffset]$start -or $freshNow -ge [DateTimeOffset]$end){$submitted=$false;throw 'immediate-clock'}
 if($Action -ceq 'remove-outage'){$reply=Invoke-Phase08SchedulerGraph 'mutation($id:String!){deploymentRemove(id:$id)}' @{id=$pins.deploymentId};if($reply.deploymentRemove -isnot [bool] -or -not $reply.deploymentRemove){throw 'remove-outcome'};$newId=$null}
 else{$reply=Invoke-Phase08SchedulerGraph 'mutation($id:String!){deploymentRedeploy(id:$id,usePreviousImageTag:true){id}}' @{id=$pins.deploymentId};$newId=$reply.deploymentRedeploy.id;if($newId -isnot [string] -or $newId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $newId -ceq $pins.deploymentId){throw 'redeploy-outcome'}}
 $out=@{state='PHASE08_AFTERNOON_RUNTIME_OPERATION_SUBMITTED';action=$Action;observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;previousDeploymentId=$pins.deploymentId;deploymentId=$newId;mutationCalls=1;actualCompletionVerified=$false;providerRequestsByController=0;databaseWrites=0;operatingChanges=0;retryPerformed=$false}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_AFTERNOON_RUNTIME_OPERATION_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$vars=$null;$db=$null;$reply=$null;$service=$null}
