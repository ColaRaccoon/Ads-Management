param([switch]$ObserveApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/run-meta-manual-oct8-v12-r3.ps1"
function ConvertTo-Phase08ManualMetaV12R3Warnings($Value){
 if($Value -isnot [Collections.IDictionary] -or $Value.Count -ne 4 -or @(@('items','history','historyLimits','automaticBackfill')|Where-Object {-not $Value.Contains($_)}).Count -ne 0 -or $Value.automaticBackfill -isnot [bool] -or $Value.automaticBackfill -or $Value.items -isnot [array] -or $Value.items.Count -ne 1 -or $Value.history -isnot [array] -or $Value.history.Count -ne 3){throw 'warning-shape'}
 $item=$Value.items[0];$missing=@('2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14')
 if($item -isnot [Collections.IDictionary] -or $item.Count -ne 8 -or @(@('scheduleKey','scheduledFor','fromDate','toDate','id','status','warningCode','missingDates')|Where-Object {-not $item.Contains($_)}).Count -ne 0 -or ($null -ne $item.id -and ($item.id -isnot [string] -or $item.id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')) -or $item.scheduleKey -cne 'phase08-meta' -or $item.scheduledFor -cne '2026-10-14T17:02:00.000Z' -or $item.fromDate -cne '2026-10-08' -or $item.toDate -cne '2026-10-14' -or $item.status -cne 'EXPIRED' -or $item.warningCode -cne 'MISSING_SCHEDULE' -or $item.missingDates -isnot [array] -or ($item.missingDates -join '|') -cne ($missing -join '|')){throw 'warning-dates'}
 $keys=@('phase08-cafe24','phase08-google','phase08-meta')
 foreach($key in $keys){$rows=@($Value.history|Where-Object {$_.scheduleKey -ceq $key});if($rows.Count -ne 1 -or $rows[0] -isnot [Collections.IDictionary] -or $rows[0].Count -ne 4 -or $rows[0].trackingFromDate -cne $(if($key -ceq 'phase08-cafe24'){'2026-10-14'}else{'2026-10-08'}) -or $rows[0].truncatedEarlierWindows -isnot [bool] -or $rows[0].truncatedEarlierWindows -or $null -ne $rows[0].warningCode){throw 'warning-history'}}
 if($Value.historyLimits -isnot [Collections.IDictionary] -or $Value.historyLimits.Count -ne 2){throw 'warning-limits'};foreach($pair in @(@('cafe24Occurrences',31),@('adsOccurrences',5))){$name=$pair[0];if(($Value.historyLimits[$name] -isnot [int] -and $Value.historyLimits[$name] -isnot [long]) -or $Value.historyLimits[$name] -ne $pair[1]){throw 'warning-limits'}}
 return @{state='PHASE08_MANUAL_META_WARNING_VERIFIED';recoveredDay='2026-10-08';remainingDates=$missing;remainingDateCount=6;warningCode='MISSING_SCHEDULE';warningStatus='EXPIRED';automaticBackfill=$false;cafe24AndGoogleWarnings=0;oldWeeklySucceeded=$false;providerRequests=0;rawValuesReturned=0}
}
if($MyInvocation.InvocationName -cne '.'){
 $stage='APPROVAL';$context=$null;$operator=$null;$session=$null;$headers=$null
 try{
  if(-not $ObserveApproved){throw 'explicit-observe-required'};Import-Phase08SchedulerChildDefinitions
  $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-manual-v12-r3-warnings-actual-20261015.json';$pins=Get-Phase08SchedulerPins;if($pins.sourceSha -cne 'd1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21'){throw 'source'}
  $stage='IDENTITY';$context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator;Assert-Phase08SchedulerContext $context $pins;Assert-Phase08SourceContext $context $operator;$graph=Get-Phase08SchedulerGraphState $context $pins;Assert-Phase08ManualMetaV12R3Graph $graph
  $stage='LOGIN';$session=[Microsoft.PowerShell.Commands.WebRequestSession]::new();$headers=@{Origin=$context.origin};$login=Invoke-Phase08SourceRequest 'POST' '/backend-api/auth/login' @{email=$operator.email;password=$operator.password} $context $session $headers;Assert-Phase08LoginResponse $login $session $operator $context.origin;$login=$null
  $stage='SINGLE_WARNING_GET';$response=Invoke-WebRequest -Uri 'https://phase08-daily-data-sync-production.up.railway.app/backend-api/source-coverage/schedule-warnings' -Method Get -Headers $headers -WebSession $session -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$response.StatusCode -ne 200 -or $response.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($response.Content) -gt 1048576 -or [string]$response.Headers['Cache-Control'] -notmatch '(?i)(^|[,\s])no-store([,\s]|$)'){throw (New-Phase08SourceHttpException $response)}
  $out=ConvertTo-Phase08ManualMetaV12R3Warnings ($response.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 10)
  $out['sourceSha']=$pins.sourceSha;$out['deploymentId']=$pins.deploymentId;$out['observedAt']=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');$out['loginRequests']=1;$out['warningRequests']=1;$out['loginSessionWritesExpected']=$true
  $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 4 -Compress
 }catch{$d=Get-Phase08SourceFailureDiagnostic $_.Exception;@{state='PHASE08_MANUAL_META_WARNING_FAILED';stage=$stage;code=$d.code;httpStatus=$d.httpStatus;providerRequests=0;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
 finally{if($headers){$headers.Clear()};$context=$null;$operator=$null;$session=$null;$headers=$null;$response=$null;$login=$null;$out=$null}
}
