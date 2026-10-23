param([switch]$ObserveApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/source-connection-helpers.ps1"
. "$PSScriptRoot/accelerated-october15-warning.ps1"
$stage='APPROVAL';$context=$null;$operator=$null;$session=$null;$headers=$null
try{
 if(-not $ObserveApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-outage-warning-actual-20261015.json'
 $pins=Get-Phase08SchedulerPins;if($pins.sourceSha -cne '6bf11939a6f7b4c676377c1c679a3a6473d158374072896b4ee15711f36a1fde' -or [DateTimeOffset]::UtcNow -lt [DateTimeOffset]'2026-10-15T06:38:00Z' -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-15T07:00:00Z'){throw 'scope-clock'}
 $stage='LIVE_OUTAGE_CONFIGURATION';$context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator;Assert-Phase08SchedulerContext $context $pins;Assert-Phase08SourceContext $context $operator
 $graph=Get-Phase08SchedulerGraphState $context $pins;$meta=@($graph.appSchedules|Where-Object {$_.key -ceq 'phase08-meta'})
 if($meta.Count -ne 1 -or $meta[0].connectionId -cne '1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' -or $meta[0].anchorAt -cne '2026-10-15T06:00:00.000Z' -or $meta[0].windowMinutes -ne 35){throw 'old-outage-config-required'}
 $sql="BEGIN READ ONLY;SELECT (SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) AS stopped,(SELECT count(*)::int FROM phase08_meta_ads.sync_runs WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-15T06:00:00.000Z','sha256'),'hex')) AS outage_runs,md5(jsonb_build_object('runs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM phase08_meta_ads.sync_runs x),'units',(SELECT jsonb_agg(to_jsonb(x) ORDER BY run_id,unit_key) FROM phase08_meta_ads.run_units x),'coverage',(SELECT jsonb_agg(to_jsonb(x) ORDER BY connection_id,data_kind,metric_date) FROM phase08_meta_ads.source_coverage x),'links',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM phase08_meta_ads.source_record_links x))::text) AS collection_digest;COMMIT;"
 $before=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($before.Count -ne 1 -or $before[0].stopped -isnot [bool] -or -not $before[0].stopped -or ($before[0].outage_runs -isnot [int] -and $before[0].outage_runs -isnot [long]) -or $before[0].outage_runs -ne 0 -or $before[0].collection_digest -isnot [string] -or $before[0].collection_digest -cnotmatch '^[a-f0-9]{32}$'){throw 'baseline'}
 $stage='LOGIN';$session=[Microsoft.PowerShell.Commands.WebRequestSession]::new();$headers=@{Origin=$context.origin};$login=Invoke-Phase08SourceRequest 'POST' '/backend-api/auth/login' @{email=$operator.email;password=$operator.password} $context $session $headers;Assert-Phase08LoginResponse $login $session $operator $context.origin
 $payload=$login.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 8;if($payload.permissions -isnot [array] -or 'data.read' -cnotin $payload.permissions){throw 'read-permission'};$payload=$null;$login=$null
 $stage='SINGLE_WARNING_GET';$response=Invoke-WebRequest -Uri ($context.origin+'/backend-api/source-coverage/schedule-warnings') -Method Get -Headers $headers -WebSession $session -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
 if([int]$response.StatusCode -ne 200 -or $response.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($response.Content) -gt 1048576 -or [string]$response.Headers['Cache-Control'] -notmatch '(?i)(^|[,\s])no-store([,\s]|$)'){throw (New-Phase08SourceHttpException $response)}
 $out=ConvertTo-Phase08OutageWarning ($response.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 12)
 $stage='NO_COLLECTION_SIDE_EFFECT';$after=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($after.Count -ne 1 -or $after[0].stopped -isnot [bool] -or -not $after[0].stopped -or ($after[0].outage_runs -isnot [int] -and $after[0].outage_runs -isnot [long]) -or $after[0].outage_runs -ne 0 -or $after[0].collection_digest -cne $before[0].collection_digest){throw 'collection-changed'}
 $out['classification']='ACTUAL_POST_OUTAGE_NORMAL_WARNING_GET';$out['observedAt']=[DateTimeOffset]::UtcNow.ToString('o');$out['sourceSha']=$pins.sourceSha;$out['deploymentId']=$pins.deploymentId;$out['loginRequests']=1;$out['warningRequests']=1;$out['loginSessionWritesExpected']=$true;$out['databaseWritesScope']='COLLECTION_DATA_ONLY';$out['collectionDigestUnchanged']=$true
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 5 -Compress
}catch{$d=Get-Phase08SourceFailureDiagnostic $_.Exception;@{state='PHASE08_AFTERNOON_OUTAGE_WARNING_FAILED';stage=$stage;code=$d.code;httpStatus=$d.httpStatus;providerRequests=0;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($headers){$headers.Clear()};$context=$null;$operator=$null;$headers=$null;$session=$null;$response=$null;$login=$null;$payload=$null}
