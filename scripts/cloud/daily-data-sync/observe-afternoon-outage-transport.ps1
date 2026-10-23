param([Parameter(Mandatory)][ValidateSet('early','final')][string]$Phase)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/afternoon-runtime-helpers.ps1"
$stage='IDENTITY'
try{
 Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '6bf11939a6f7b4c676377c1c679a3a6473d158374072896b4ee15711f36a1fde'){throw 'source'}
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-outage-transport-'+$Phase+'-actual-20261015.json')
 $service=Get-Phase08AfternoonRuntimeService $pins
 if($service.latestDeployment.status -cne 'REMOVED' -or @($service.activeDeployments).Count -ne 0){throw 'not-removed'}
 $sql=@'
BEGIN READ ONLY;
SET LOCAL statement_timeout=15000;
SELECT current_database() AS database,current_user AS principal,
 count(*)::int AS work_attempts,
 count(*) FILTER(WHERE http_status BETWEEN 500 AND 599)::int AS http_5xx,
 count(*) FILTER(WHERE safe_code IN('TRANSPORT_FAILED','HTTP_EXCEPTION'))::int AS transport_failures,
 count(*) FILTER(WHERE http_status IN(401,403) OR safe_code='MACHINE_AUTH_REQUIRED')::int AS auth_failures,
 count(*) FILTER(WHERE http_status BETWEEN 200 AND 299)::int AS http_2xx,
 count(*) FILTER(WHERE safe_code='COMPLETE')::int AS complete_responses
FROM daily_data_sync_ops.attempts
WHERE schedule_key='phase08-meta' AND scheduled_for='2026-10-15T06:00:00Z'
 AND NOT inspection_only AND status NOT IN('INCOMPLETE_SCHEDULE','MISSING_SCHEDULE');
COMMIT;
'@
 $stage='FIXED_READONLY_SQL';$rows=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($rows.Count -ne 1){throw 'rows'};$r=$rows[0]
 $fields=@('work_attempts','http_5xx','transport_failures','auth_failures','http_2xx','complete_responses')
 if(@($r.PSObject.Properties.Name).Count -ne 8 -or $r.database -cne 'postgres' -or $r.principal -cne 'postgres'){throw 'shape'}
 foreach($f in $fields){if(($r.$f -isnot [int] -and $r.$f -isnot [long]) -or $r.$f -lt 0 -or $r.$f -gt 24){throw 'type'}}
 if($r.work_attempts -lt 1 -or ($r.http_5xx+$r.transport_failures) -lt 1 -or $r.auth_failures -ne 0 -or $r.http_2xx -ne 0 -or $r.complete_responses -ne 0){throw 'transport-not-confirmed'}
 $out=@{state='PHASE08_ACTUAL_REMOVED_APP_TRANSPORT_FAILURE';phase=$Phase;observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;runtimeStatus='REMOVED';activeInstances=0;appHttpRequestsByObserver=0;providerRequestsByObserver=0;databaseWrites=0}
 foreach($f in $fields){$out[$f]=$r.$f}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_OUTAGE_TRANSPORT_OBSERVATION_FAILED';stage=$stage;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
