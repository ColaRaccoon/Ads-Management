# Definitions only. Callers explicitly invoke every protected read and HTTP request.
. "$PSScriptRoot/scheduler-live-helpers.ps1"
function Assert-Phase08FutureProbe($Definitions) {
 if(@($Definitions).Count -ne 3){throw 'future-definitions'}
 $now=[DateTimeOffset]::UtcNow
 foreach($row in $Definitions){if([DateTimeOffset]::Parse($row.anchorAt) -le $now.AddMinutes(30)){throw 'future-only-boundary'}}
}
function Get-Phase08ProbeCounts {
 $sql="BEGIN READ ONLY; SET LOCAL statement_timeout=15000; SELECT (SELECT count(*) FROM phase08_meta_ads.sync_runs)::int AS runs,(SELECT count(*) FROM phase08_meta_ads.run_units)::int AS units,(SELECT count(*) FROM phase08_meta_ads.source_coverage)::int AS coverage,(SELECT count(*) FROM phase08_meta_ads.sync_leases)::int AS leases,(SELECT count(*) FROM phase08_meta_ads.sync_unit_checkpoints)::int AS checkpoints,(SELECT count(*) FROM daily_data_sync_ops.attempts)::int AS attempts; COMMIT;"
 $rows=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($rows.Count -ne 1){throw 'counts'}
 foreach($key in @('runs','units','coverage','leases','checkpoints','attempts')){if(($rows[0].$key -isnot [int] -and $rows[0].$key -isnot [long]) -or $rows[0].$key -ne 0){throw 'future-baseline-not-empty'}}
 return @{runs=0;units=0;coverage=0;leases=0;checkpoints=0;attempts=0}
}
function Invoke-Phase08FutureHttp($Context,$Pins,$Definitions,[string]$Path,$Headers,$Body,[int]$ExpectedStatus,[string]$ExpectedCode) {
 Assert-Phase08SchedulerContext $Context $Pins
 if($Pins.identity.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app'){throw 'fixed-origin'}
 Assert-Phase08FutureProbe $Definitions
 if($Body -isnot [Collections.IDictionary] -or $Body.scheduledFor -isnot [string] -or
  @($Definitions|Where-Object {$_.anchorAt -ceq $Body.scheduledFor -and ($_.key -ceq $Body.scheduleKey -or $Body.scheduleKey -ceq 'phase08-unknown-key')}).Count -lt 1){throw 'exact-future-body'}
 if($Path -cnotin @('/backend-api/internal/daily-sync','/backend-api/internal/daily-sync/status')){throw 'exact-machine-path'}
 $response=$null;$json=$null;$watch=[Diagnostics.Stopwatch]::StartNew()
 try {
  $json=$Body|ConvertTo-Json -Compress -Depth 8
  $response=Invoke-WebRequest -Uri ($Pins.identity.origin+$Path) -Method Post -Headers $Headers -ContentType 'application/json' -Body $json -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
  $watch.Stop()
  if([int]$response.StatusCode -ne $ExpectedStatus -or [Text.Encoding]::UTF8.GetByteCount($response.Content) -gt 8192 -or ($response.Headers['Cache-Control'] -join ',') -notmatch '(?i)(^|,)\s*no-store\s*(,|$)'){throw 'http-boundary'}
  foreach($secret in @($Context.env.DAILY_SYNC_MACHINE_TOKEN,$Context.env.INTERNAL_PROBE_TOKEN)){if($secret -is [string] -and $secret.Length -ge 12){foreach($variant in @($secret,($secret|ConvertTo-Json -Compress).Trim('"'),[Uri]::EscapeDataString($secret),[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret)))){if($response.Content.Contains($variant)){throw 'raw-secret-response'}}}}
  $payload=$response.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 10
  $code=if($payload.ContainsKey('code') -and $payload.code -is [string] -and $payload.code -cin @('MACHINE_SYNC_FORBIDDEN','ACCOUNT_SCOPE_MISMATCH','RUN_LIMIT_EXCEEDED')){$payload.code}else{'VALIDATION_REJECTED'}
  if($ExpectedCode -and $code -cne $ExpectedCode){throw 'code-boundary'}
  return @{httpStatus=$ExpectedStatus;code=$code;elapsedMs=$watch.ElapsedMilliseconds;scheduledCollectionStarted=$false}
 }finally{$watch.Stop();$json=$null;$response=$null;$payload=$null;if($Headers){$Headers.Clear()};$Headers=$null;$Body=$null}
}
function Get-Phase08ObservedDeployment($Pins) {
 $data=Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId sleepApplication latestDeployment{id status}}}' @{e=$Pins.identity.environmentId;s=$Pins.identity.serviceId}
 $svc=$data.serviceInstance
 if($svc.serviceId -cne $Pins.identity.serviceId -or $svc.environmentId -cne $Pins.identity.environmentId -or $svc.latestDeployment.id -cne $Pins.deploymentId -or $svc.sleepApplication -isnot [bool] -or $svc.sleepApplication -ne $true -or $svc.latestDeployment.status -cnotin @('SUCCESS','SLEEPING')){throw 'observer-deployment'}
 return @{status=$svc.latestDeployment.status;sleepApplication=$true;observedAt=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');applicationHttpRequests=0}
}
