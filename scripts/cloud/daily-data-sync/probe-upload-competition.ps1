param([Parameter(Mandatory)][ValidateSet('CAFE24','META')][string]$ActiveProvider,
 [Parameter(Mandatory)][ValidatePattern('^upload-competition-20261015-[a-z0-9-]{1,40}\.json$')][string]$OutputName)
# Root only. One empty JSON upload probe after normal login; no CSV or multipart body.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/source-connection-helpers.ps1"
function Get-Phase08UploadCompetitionSql([string]$Provider) {
 if($Provider -cnotin @('CAFE24','META')){throw 'provider'}
 $cafe=$Provider -ceq 'CAFE24';$connection=if($cafe){'0c35defe-45fc-4a54-bc79-704df7bca5b1'}else{'1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'}
 $key=if($cafe){'phase08-cafe24'}else{'phase08-meta'};$due=if($cafe){'2026-10-15T01:00:00.000Z'}else{'2026-10-15T01:02:00.000Z'};$from=if($cafe){'2026-10-14'}else{'2026-10-08'}
 return @"
BEGIN READ ONLY;SET LOCAL statement_timeout=10000;
SELECT current_database() AS database,current_user AS principal,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables,
 (SELECT count(*)::int FROM phase08_meta_ads.upload_batches) AS upload_batches,
 (SELECT count(*)::int FROM phase08_meta_ads.upload_rows) AS upload_rows,
 (SELECT count(*)::int FROM phase08_meta_ads.upload_row_errors) AS upload_errors,
 (SELECT count(*)::int FROM phase08_meta_ads.cafe24_upload_batches) AS cafe_batches,
 (SELECT count(*)::int FROM phase08_meta_ads.cafe24_upload_row_errors) AS cafe_errors,
 (SELECT count(*)::int FROM phase08_meta_ads.cafe24_order_lines WHERE source='CSV') AS cafe_csv_lines,
 EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases l JOIN phase08_meta_ads.sync_runs r ON r.id=l.owner_run_id JOIN phase08_meta_ads.run_units u ON u.run_id=r.id
 WHERE l.connection_id='$connection' AND l.expires_at>clock_timestamp() AND r.connection_id='$connection' AND r.trigger='SCHEDULED' AND r.status='RUNNING' AND r.deadline_at>clock_timestamp()
 AND r.request_key='schedule:${key}:'||encode(extensions.digest('$due','sha256'),'hex') AND r.from_date='$from' AND r.to_date='2026-10-14' AND u.status='RUNNING'
 AND u.unit_key BETWEEN '$from' AND '2026-10-14' AND u.attempts BETWEEN 1 AND 3) AS active_match,
 (SELECT coalesce(max(c.revision),0)::int FROM phase08_meta_ads.sync_unit_checkpoints c JOIN phase08_meta_ads.sync_runs r ON r.id=c.run_id WHERE r.connection_id='$connection' AND r.request_key='schedule:${key}:'||encode(extensions.digest('$due','sha256'),'hex') AND c.unit_key='2026-10-14' AND c.expires_at>clock_timestamp()) AS checkpoint_revision;
ROLLBACK;
"@
}
function Assert-Phase08UploadCompetitionSnapshot($Rows,[string]$Provider,[switch]$RequireActive) {
 if(@($Rows).Count -ne 1){throw 'snapshot'};$row=@($Rows)[0]
 if($row.database -cne 'postgres' -or $row.principal -cne 'postgres' -or ($row.tables -isnot [int] -and $row.tables -isnot [long]) -or $row.tables -ne 68 -or $row.active_match -isnot [bool] -or ($row.checkpoint_revision -isnot [int] -and $row.checkpoint_revision -isnot [long]) -or $row.checkpoint_revision -lt 0){throw 'snapshot-identity'}
 foreach($name in @('upload_batches','upload_rows','upload_errors','cafe_batches','cafe_errors','cafe_csv_lines')){if(($row.$name -isnot [int] -and $row.$name -isnot [long]) -or $row.$name -ne 0){throw 'upload-state'}}
 if($RequireActive -and (-not $row.active_match -or ($Provider -ceq 'CAFE24' -and $row.checkpoint_revision -lt 1))){throw 'no-active-scheduled-unit'}
 return @{active=$row.active_match;checkpointRevision=$row.checkpoint_revision;uploadRows=0;csvLines=0}
}
if($MyInvocation.InvocationName -cne '.') {
 $stage='IDENTITY';$context=$null;$operator=$null;$headers=$null;$session=$null;$response=$null;$body=$null;$uploadRequests=0
 try {
  $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/'+$OutputName)
  Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
  if($pins.sourceSha -cne 'a986132a8f70757ca67ae93b54ce378926166da30ec9817378f206062e214097'){throw 'source'}
  $context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator;Assert-Phase08SchedulerContext $context $pins;Assert-Phase08SourceContext $context $operator
  $null=Get-Phase08SchedulerGraphState $context $pins
  $sql=Get-Phase08UploadCompetitionSql $ActiveProvider
  $stage='PRE_LOGIN_ACTIVE';$null=Assert-Phase08UploadCompetitionSnapshot @(Invoke-Phase08Management -Action Query -Query $sql) $ActiveProvider -RequireActive
  $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new();$headers=@{Origin=$context.origin};$body=@{email=$operator.email;password=$operator.password}
  $stage='LOGIN';$response=Invoke-Phase08SourceRequest 'POST' '/backend-api/auth/login' $body $context $session $headers
  Assert-Phase08LoginResponse $response $session $operator $context.origin;$response=$null;$body=$null
  $csrf=@($session.Cookies.GetCookies([Uri]$context.origin)|Where-Object {$_.Name -ceq '__Host-phase08-meta_csrf'})
  if($csrf.Count -ne 1 -or [string]::IsNullOrEmpty($csrf[0].Value)){throw 'csrf'};$headers['X-CSRF-Token']=$csrf[0].Value
  $stage='IMMEDIATE_ACTIVE';$before=Assert-Phase08UploadCompetitionSnapshot @(Invoke-Phase08Management -Action Query -Query $sql) $ActiveProvider -RequireActive
  $stage='SINGLE_EMPTY_UPLOAD';$uploadRequests=1
  $response=Invoke-WebRequest -Uri 'https://phase08-daily-data-sync-production.up.railway.app/backend-api/sales/cafe24/uploads' -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body '{}' -MaximumRedirection 0 -TimeoutSec 20 -SkipHttpErrorCheck
  if($response.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($response.Content) -gt 8192 -or [string]$response.Headers['Cache-Control'] -notmatch '(?i)(^|[,\s])no-store([,\s]|$)'){throw 'response-boundary'}
  foreach($secret in @($operator.password)+@($session.Cookies.GetCookies([Uri]$context.origin)|ForEach-Object {$_.Value})){
   if([string]::IsNullOrEmpty($secret)){throw 'secret'}
   foreach($variant in @($secret,($secret|ConvertTo-Json -Compress),[Uri]::EscapeDataString($secret),[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret)))){if($response.Content.Contains($variant)){throw 'response-secret'}}
  }
  $payload=$response.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 8
  if($payload -isnot [Collections.IDictionary] -or $payload.code -isnot [string]){throw 'response-shape'}
  $http=[int]$response.StatusCode;$retryAfter=$null
  if($http -eq 503 -and $payload.code -ceq 'HEAVY_OPERATION_BUSY'){
   $retryText=($response.Headers['Retry-After'] -join '');if($retryText -cnotmatch '^[1-9][0-9]{0,3}$' -or [int]$retryText -gt 3600){throw 'retry-after'};$retryAfter=[int]$retryText;$result='HEAVY_GATE_REJECTED'
  }elseif($http -eq 400 -and $payload.code -ceq 'FILE_REQUIRED'){$result='INCONCLUSIVE_REQUEST_RACE'}else{throw 'unexpected-status'}
  $response=$null;$stage='POST_UPLOAD_STATE'
  $after=Assert-Phase08UploadCompetitionSnapshot @(Invoke-Phase08Management -Action Query -Query $sql) $ActiveProvider
  $out=@{state='PHASE08_UPLOAD_COMPETITION_OBSERVED';classification='ACTUAL_HTTP_WITH_EMPTY_SYNTHETIC_UPLOAD_INPUT';observedAt=[DateTimeOffset]::UtcNow.ToString('o');result=$result;competitionVerified=($result -ceq 'HEAVY_GATE_REJECTED');activeProvider=$ActiveProvider;uploadRequests=1;loginRequests=1;httpStatus=$http;safeCode=$payload.code;retryAfterSeconds=$retryAfter;activeLeaseBefore=$true;activeLeaseAfter=$after.active;checkpointRevisionBefore=$before.checkpointRevision;checkpointRevisionAfter=$after.checkpointRevision;uploadRowsBefore=0;uploadRowsAfter=0;csvLinesBefore=0;csvLinesAfter=0;filesSent=0;csvBytesSent=0;providerRequestsByProbe=0;loginSessionWritesExpected=$true;concurrentScheduledDataMayProgress=$true;operatingWrites=0;rawValuesReturned=0}
  $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 4 -Compress
 }catch{@{state='PHASE08_UPLOAD_COMPETITION_FAILED';stage=$stage;uploadRequests=$uploadRequests;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
 finally{if($headers){$headers.Clear()};$context=$null;$operator=$null;$headers=$null;$session=$null;$response=$null;$body=$null;$csrf=$null;$payload=$null;$secret=$null;$variant=$null;$sql=$null}
}
