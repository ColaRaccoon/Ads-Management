param([Parameter(Mandatory)][ValidateSet('removed','audit')][string]$Phase)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/afternoon-runtime-helpers.ps1"
$stage='IDENTITY'
try{
 Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '6bf11939a6f7b4c676377c1c679a3a6473d158374072896b4ee15711f36a1fde'){throw 'source'}
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-outage-'+$Phase+'-actual-20261015.json')
 $marker=Get-Item -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-runtime-remove-outage-attempt-20261015.json'
 if($marker.PSIsContainer -or ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $marker.Length -gt 16384){throw 'marker'}
 $before=[IO.File]::ReadAllText($marker.FullName)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 10
 if($before.classification -cne 'ACTUAL_ISOLATED_RUNTIME_REMOVAL_PLANNED' -or $before.action -cne 'remove-outage' -or $before.sourceSha -cne $pins.sourceSha -or $before.oldDeploymentId -cne $pins.deploymentId -or $before.before.business_md5 -cnotmatch '^[a-f0-9]{32}$'){throw 'baseline'}
 $stage='ACTUAL_ABSENCE';$service=Get-Phase08AfternoonRuntimeService $pins
 if($service.latestDeployment.status -cne 'REMOVED' -or @($service.activeDeployments).Count -ne 0){throw 'runtime-not-removed'}
 $stage='UNCHANGED_BUSINESS';$db=Get-Phase08AfternoonRuntimeSnapshot
 if($db.stopped -or $db.active_jobs -ne 138 -or $db.live_leases -ne 0 -or $db.outage_runs -ne 0 -or $db.business_md5 -cne $before.before.business_md5){throw 'outage-invariant'}
 if($Phase -ceq 'audit' -and ([DateTimeOffset]::UtcNow -lt [DateTimeOffset]'2026-10-15T06:38:00Z' -or $db.outage_work_attempts -lt 1 -or $db.outage_work_attempts -gt 24 -or $db.outage_inspections -lt 1 -or $db.outage_inspections -gt 3 -or $db.outage_audits -ne 1)){throw 'audit-not-finished'}
 $classification=if($Phase -ceq 'audit'){'ACTUAL_WALL_CLOCK_WINDOW_EXCEEDING_APP_OUTAGE'}else{'ACTUAL_ISOLATED_APP_REMOVAL_CONFIRMED'}
 $out=@{state='PHASE08_AFTERNOON_REAL_OUTAGE_OBSERVED';phase=$Phase;classification=$classification;collectionWindowExceeded=($Phase -ceq 'audit');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;observedAt=[DateTimeOffset]::UtcNow.ToString('o');removalRequestedAt=$before.observedAt;windowMinutes=35;scheduledFor='2026-10-15T06:00:00.000Z';deadlineAt='2026-10-15T06:35:00.000Z';runtimeStatus='REMOVED';activeInstances=0;globalStopped=$false;liveLeases=0;newOutageRuns=0;newOutageUnits=0;workAttempts=$db.outage_work_attempts;inspectionAttempts=$db.outage_inspections;incompleteOrMissingAudits=$db.outage_audits;businessDigestUnchanged=$true;original152Preserved=$true;providerCallsMeasured=$false;providerInvocationEvidence='NO_APP_INSTANCE_NO_QUEUED_RUN_NO_BUSINESS_WRITE';appHttpRequestsByObserver=0;databaseWrites=0;operatingChanges=0;multiDayWallClockOutageProven=$false}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 5 -Compress
}catch{@{state='PHASE08_AFTERNOON_OUTAGE_OBSERVATION_FAILED';stage=$stage;providerRequestsByObserver=0;databaseWrites=0;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
