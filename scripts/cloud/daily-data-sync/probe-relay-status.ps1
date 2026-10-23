# Root-only actual native HTTP diagnostic. Closed slots/status route only; never runs a unit.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/protected-context.ps1"
$cases=@(
 @{provider='CAFE24';key='phase08-cafe24';due='2026-10-14T17:00:00.000Z';days=1;first='2026-10-14'},
 @{provider='GOOGLE';key='phase08-google';due='2026-10-14T17:01:00.000Z';days=7;first='2026-10-08'},
 @{provider='META';key='phase08-meta';due='2026-10-14T17:02:00.000Z';days=7;first='2026-10-08'})
$template=@'
BEGIN READ ONLY;
SET LOCAL statement_timeout=50000;
DO $guard$ DECLARE userpwd text; res extensions.http_response; body jsonb; summary jsonb; BEGIN
 PERFORM set_config('daily_data_sync.closed_status_summary','{"httpStatus":null,"validExpiredSummary":false,"noStore":false,"code":"PROBE_FAILED"}',true);
 IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL OR (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads')<>68 OR current_setting('log_min_messages') NOT IN ('info','notice','warning','error','log','fatal','panic') OR current_setting('client_min_messages') NOT IN ('info','notice','warning','error') THEN RAISE EXCEPTION 'PHASE08_STATUS_PROBE_REJECTED'; END IF;
 PERFORM extensions.http_reset_curlopt();
 SELECT decrypted_secret INTO STRICT userpwd FROM vault.decrypted_secrets WHERE name='daily_data_sync_08_relay_userpwd';
 IF userpwd !~ '^phase08-scheduler:[A-Za-z0-9+/]{43}=$' THEN RAISE EXCEPTION 'PHASE08_STATUS_PROBE_REJECTED'; END IF;
 PERFORM extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','45000');
 PERFORM extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS','15000');
 PERFORM extensions.http_set_curlopt('CURLOPT_USERPWD',userpwd);userpwd:=NULL;
 SELECT * INTO STRICT res FROM extensions.http(('POST','https://ehnfrrmbkvlsbpvqcvkr.supabase.co/functions/v1/phase08-scheduled-relay',ARRAY[extensions.http_header('x-daily-sync-target','phase08-full-app')],'application/json',jsonb_build_object('scheduleKey','__KEY__','scheduledFor','__DUE__','mode','status')::text)::extensions.http_request);
 PERFORM extensions.http_reset_curlopt();
 IF res.status<>200 OR res.content IS NULL OR octet_length(res.content)>8192 THEN RAISE EXCEPTION 'PHASE08_STATUS_PROBE_REJECTED'; END IF;
 body:=res.content::jsonb;
 IF jsonb_typeof(body)<>'object' OR body->>'scheduleKey' IS DISTINCT FROM '__KEY__' OR body->>'scheduledFor' IS DISTINCT FROM '__DUE__' OR body->>'fromDate' IS DISTINCT FROM '__FIRST__' OR body->>'toDate' IS DISTINCT FROM '2026-10-14' OR body->>'status' IS DISTINCT FROM 'EXPIRED'
 OR jsonb_typeof(body->'completedUnits') IS DISTINCT FROM 'number' OR (body->>'completedUnits') !~ '^[0-9]+$' OR body->>'completedUnits' IS DISTINCT FROM '0'
 OR jsonb_typeof(body->'totalUnits') IS DISTINCT FROM 'number' OR (body->>'totalUnits') !~ '^[0-9]+$' OR body->>'totalUnits' IS DISTINCT FROM '__DAYS__'
 OR NOT EXISTS(SELECT 1 FROM unnest(res.headers) h WHERE lower(h.field)='cache-control' AND h.value LIKE '%no-store%') THEN RAISE EXCEPTION 'PHASE08_STATUS_PROBE_REJECTED'; END IF;
 summary:=jsonb_build_object('httpStatus',200,'validExpiredSummary',true,'noStore',true,'code','VERIFIED');
 PERFORM set_config('daily_data_sync.closed_status_summary',summary::text,true);
EXCEPTION WHEN query_canceled THEN
 userpwd:=NULL; PERFORM extensions.http_reset_curlopt();
 PERFORM set_config('daily_data_sync.closed_status_summary','{"httpStatus":null,"validExpiredSummary":false,"noStore":false,"code":"QUERY_CANCELED"}',true);
WHEN OTHERS THEN
 userpwd:=NULL; PERFORM extensions.http_reset_curlopt();
 PERFORM set_config('daily_data_sync.closed_status_summary','{"httpStatus":null,"validExpiredSummary":false,"noStore":false,"code":"PROBE_FAILED"}',true);
END $guard$;
SELECT (s->>'httpStatus')::integer AS "httpStatus",(s->>'validExpiredSummary')::boolean AS "validExpiredSummary",(s->>'noStore')::boolean AS "noStore",s->>'code' AS code FROM (SELECT current_setting('daily_data_sync.closed_status_summary')::jsonb AS s) q;
ROLLBACK;
'@
$results=@();$stage='NATIVE_CLOSED_STATUS'
try{
 foreach($case in $cases){
  # One HTTP request per batch: a reset CTE must never clear another row's curl auth.
  $sql=$template.Replace('__KEY__',$case.key).Replace('__DUE__',$case.due).Replace('__FIRST__',$case.first).Replace('__DAYS__',[string]$case.days)
  $watch=[Diagnostics.Stopwatch]::StartNew()
  $row=Invoke-Phase08Management -Action Query -Query $sql
  $watch.Stop()
  if(@($row).Count -ne 1 -or $row.code -isnot [string] -or $row.code -cnotin @('VERIFIED','QUERY_CANCELED','PROBE_FAILED') -or $row.validExpiredSummary -isnot [bool] -or $row.noStore -isnot [bool]){throw 'PHASE08_STATUS_PROBE_REJECTED'}
  if($row.code -ceq 'VERIFIED'){
   if(($row.httpStatus -isnot [int] -and $row.httpStatus -isnot [long]) -or $row.httpStatus -ne 200 -or -not $row.validExpiredSummary -or -not $row.noStore){throw 'PHASE08_STATUS_PROBE_REJECTED'}
  }elseif($null -ne $row.httpStatus -or $row.validExpiredSummary -or $row.noStore){throw 'PHASE08_STATUS_PROBE_REJECTED'}
  $results+=@{provider=$case.provider;httpStatus=$row.httpStatus;code=$row.code;validExpiredSummary=$row.validExpiredSummary;noStore=$row.noStore;elapsedMs=$watch.ElapsedMilliseconds}
 }
 $stage='COUNTS'
 $counts=Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY; SELECT (SELECT count(*) FROM phase08_meta_ads.sync_runs) AS runs,(SELECT count(*) FROM phase08_meta_ads.run_units) AS units,(SELECT count(*) FROM phase08_meta_ads.source_coverage) AS coverage,(SELECT count(*) FROM daily_data_sync_ops.attempts) AS attempts; ROLLBACK;"
 if(@($counts).Count -ne 1 -or @('runs','units','coverage','attempts'|Where-Object { $counts.$_ -isnot [int] -and $counts.$_ -isnot [long] }).Count -ne 0){throw 'PHASE08_STATUS_PROBE_REJECTED'}
 $counts=@{runs=$counts.runs;units=$counts.units;coverage=$counts.coverage;attempts=$counts.attempts}
 $verified=@($results|Where-Object{$_.code -cne 'VERIFIED' -or ($_.httpStatus -isnot [int] -and $_.httpStatus -isnot [long]) -or $_.httpStatus -ne 200 -or $_.validExpiredSummary -isnot [bool] -or -not $_.validExpiredSummary -or $_.noStore -isnot [bool] -or -not $_.noStore}).Count -eq 0 -and @($counts).Count -eq 1 -and @('runs','units','coverage','attempts'|Where-Object { $counts.$_ -isnot [int] -and $counts.$_ -isnot [long] }).Count -eq 0 -and $counts.runs -eq 0 -and $counts.units -eq 0 -and $counts.coverage -eq 0 -and $counts.attempts -eq 152
 @{classification='ACTUAL_NATIVE_DB_EDGE_APP_READ_ONLY_CLOSED_SLOT';verified=$verified;observedAt=[DateTimeOffset]::UtcNow.ToString('o');results=$results;counts=$counts;providerCollectionStarted=$false;regularScheduleSuccess=$false}|ConvertTo-Json -Depth 10
 if(-not $verified){exit 1}
}catch{@{state='PHASE08_NATIVE_RELAY_STATUS_FAILED';stage=$stage;rawErrorSuppressed=$true;regularScheduleSuccess=$false}|ConvertTo-Json -Compress;exit 1}
