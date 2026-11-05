param([ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$Day)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspace=Split-Path $PSScriptRoot -Parent
if(-not $Day){$Day=[TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow,'Korea Standard Time').AddDays(-1).ToString('yyyy-MM-dd')}
$parsed=[DateTime]::ParseExact($Day,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)
if($parsed.ToString('yyyy-MM-dd') -cne $Day){throw 'INVALID_DAY'}
$directory=Join-Path $workspace ('reports/daily-collection-health/'+$Day+'-'+[DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
$null=New-Item -ItemType Directory -Path $directory
$sqlPath=Join-Path $directory 'check.sql'
$receiptPath=Join-Path $directory 'database.json'
$sql=@"
BEGIN READ ONLY;
SET LOCAL statement_timeout='20s';
SELECT 'runs' section,coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) data FROM (SELECT c.provider,r.id,r.status,r.rows_published,r.safe_error_code FROM meta_ads.sync_runs r JOIN meta_ads.source_connections c ON c.id=r.connection_id WHERE r.trigger='SCHEDULED' AND r.from_date=DATE '$Day' AND r.to_date=DATE '$Day' AND c.provider IN ('CAFE24','META') AND (r.request_key LIKE 'schedule:prod-cafe24:%' OR r.request_key LIKE 'schedule:prod-meta-daily:%')) r
UNION ALL SELECT 'coverage',coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) FROM (SELECT data_kind,state,row_count,total_amount,last_success_run_id,warning_codes FROM meta_ads.source_coverage WHERE metric_date=DATE '$Day' AND data_kind IN ('CAFE24_ORDER','META_AD','META_ADSET') AND connection_id IN ('be140e7e-3994-406e-94ff-b50dfc7ac7b2','2155a401-bd86-4111-9280-3c95ed207546')) c
UNION ALL SELECT 'policies',coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM (SELECT data_kind,primary_source FROM meta_ads.source_policies WHERE data_kind IN ('CAFE24_ORDER','META_AD','META_ADSET') AND connection_id IN ('be140e7e-3994-406e-94ff-b50dfc7ac7b2','2155a401-bd86-4111-9280-3c95ed207546') AND from_date<=DATE '$Day' AND (to_date IS NULL OR to_date>DATE '$Day')) p
UNION ALL SELECT 'connections',jsonb_agg(jsonb_build_object('provider',provider,'enabled',enabled,'accessState',access_state,'expiresAt',credential_expires_at)) FROM meta_ads.source_connections WHERE id IN ('be140e7e-3994-406e-94ff-b50dfc7ac7b2','2155a401-bd86-4111-9280-3c95ed207546')
UNION ALL SELECT 'canonical',jsonb_agg(to_jsonb(c)) FROM (
 SELECT 'CAFE24_ORDER' kind,count(*) rows,NULL::numeric spend FROM meta_ads.cafe24_order_lines WHERE connection_id='be140e7e-3994-406e-94ff-b50dfc7ac7b2' AND order_date=DATE '$Day' AND is_current
 UNION ALL SELECT 'META_AD',count(*),coalesce(sum(spend_usd),0) FROM meta_ads.meta_ad_daily_metrics WHERE connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND metric_date=DATE '$Day' AND is_current
 UNION ALL SELECT 'META_ADSET',count(*),coalesce(sum(spend_usd),0) FROM meta_ads.meta_adset_daily_metrics WHERE connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND metric_date=DATE '$Day' AND is_current) c
UNION ALL SELECT 'scheduler',jsonb_build_object('stopped',(SELECT stopped FROM daily_data_sync_prod_ops.settings WHERE singleton),'jobActive',(SELECT active FROM cron.job WHERE jobname='daily-data-sync-prod-tick'),'pausedCount',(SELECT count(*) FROM daily_data_sync_prod_ops.schedules WHERE key IN ('prod-cafe24','prod-meta-daily') AND paused),'fixedRequestIndex',EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='daily_data_sync_prod_ops' AND indexname='production_sync_inflight_request_id'))
UNION ALL SELECT 'meta_spend',jsonb_build_object(
 'adsetL1', (SELECT coalesce(sum(abs(s.spend_usd-coalesce(a.spend,0))),0) FROM meta_ads.meta_adset_daily_metrics s LEFT JOIN (SELECT meta_adset_ref_id,sum(spend_usd) spend FROM meta_ads.meta_ad_daily_metrics WHERE connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND metric_date=DATE '$Day' AND is_current GROUP BY meta_adset_ref_id) a ON a.meta_adset_ref_id=s.meta_adset_id WHERE s.connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND s.metric_date=DATE '$Day' AND s.is_current),
 'evidence',(SELECT e.after_json->'metaSpendReconciliation' FROM meta_ads.security_audit_events e JOIN meta_ads.source_coverage c ON e.target_id=c.last_success_run_id::text||':'||to_char(c.metric_date,'YYYY-MM-DD') WHERE e.action='SYNC_UNIT_PUBLISHED' AND c.connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND c.metric_date=DATE '$Day' AND c.data_kind='META_AD' ORDER BY e.created_at DESC LIMIT 1),
 'evidenceVariants',(SELECT count(DISTINCT evidence) FROM (SELECT current_metadata->'sourceContext'->'spendReconciliation' evidence FROM meta_ads.meta_ad_daily_metrics WHERE connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND metric_date=DATE '$Day' AND is_current UNION ALL SELECT current_metadata->'sourceContext'->'spendReconciliation' FROM meta_ads.meta_adset_daily_metrics WHERE connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND metric_date=DATE '$Day' AND is_current) m),
 'missingEvidence',(SELECT count(*) FILTER (WHERE evidence IS NULL) FROM (SELECT current_metadata->'sourceContext'->'spendReconciliation' evidence FROM meta_ads.meta_ad_daily_metrics WHERE connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND metric_date=DATE '$Day' AND is_current UNION ALL SELECT current_metadata->'sourceContext'->'spendReconciliation' FROM meta_ads.meta_adset_daily_metrics WHERE connection_id='2155a401-bd86-4111-9280-3c95ed207546' AND metric_date=DATE '$Day' AND is_current) m));
COMMIT;
"@
[IO.File]::WriteAllText($sqlPath,$sql,[Text.UTF8Encoding]::new($false))
$result=& (Join-Path $PSScriptRoot 'google-performance-production-query.ps1') -SqlPath $sqlPath -ExpectedSha256 ((Get-FileHash -LiteralPath $sqlPath -Algorithm SHA256).Hash.ToLowerInvariant()) -ReceiptPath $receiptPath
$queryStatus=$result|ConvertFrom-Json
if($queryStatus.status -ne 'SUCCESS'){throw 'COLLECTION_HEALTH_QUERY_FAILED'}
$rows=Get-Content -LiteralPath $receiptPath -Raw|ConvertFrom-Json -Depth 20
$runs=@(($rows|Where-Object section -eq 'runs').data)
$coverage=@(($rows|Where-Object section -eq 'coverage').data)
$policies=@(($rows|Where-Object section -eq 'policies').data)
$canonical=@(($rows|Where-Object section -eq 'canonical').data)
$scheduler=($rows|Where-Object section -eq 'scheduler').data
$connections=@(($rows|Where-Object section -eq 'connections').data)
$metaSpend=($rows|Where-Object section -eq 'meta_spend').data
$approvedWarning='META_SPEND_DIFFERENCE_WITHIN_10_USD'
$issues=[Collections.Generic.List[string]]::new()
foreach($provider in @('CAFE24','META')){
 $run=@($runs|Where-Object provider -eq $provider)
 if($run.Count -ne 1 -or $run[0].status -ne 'SUCCEEDED'){$issues.Add($provider+'_SCHEDULE_NOT_SUCCEEDED')}
 $connection=@($connections|Where-Object provider -eq $provider)
 if($connection.Count -ne 1 -or -not $connection[0].enabled -or $connection[0].accessState -ne 'READY'){$issues.Add($provider+'_CONNECTION_NOT_READY')}
 elseif(-not $connection[0].expiresAt -or [DateTimeOffset]::Parse($connection[0].expiresAt) -le [DateTimeOffset]::UtcNow.AddDays($(if($provider -eq 'META'){8}else{3}))){$issues.Add($provider+'_AUTH_EXPIRY_APPROACHING')}
}
foreach($kind in @('CAFE24_ORDER','META_AD','META_ADSET')){
 $slice=@($coverage|Where-Object data_kind -eq $kind)
 $policy=@($policies|Where-Object data_kind -eq $kind)
 $stored=@($canonical|Where-Object kind -eq $kind)
 if($slice.Count -ne 1 -or $slice[0].state -notin @('COMPLETE_NONZERO','COMPLETE_ZERO')){$issues.Add($kind+'_NOT_COMPLETE')}
 elseif($slice[0].row_count -ne $stored[0].rows){$issues.Add($kind+'_ROW_COUNT_MISMATCH')}
 if($kind -like 'META*' -and $slice.Count -eq 1 -and $slice[0].state -in @('COMPLETE_NONZERO','COMPLETE_ZERO') -and [decimal]$slice[0].total_amount -ne [decimal]$stored[0].spend){$issues.Add($kind+'_COVERAGE_SPEND_MISMATCH')}
 if($policy.Count -ne 1 -or $policy[0].primary_source -ne 'API'){$issues.Add($kind+'_API_NOT_SELECTED')}
 if($kind -like 'META*' -and $slice.Count -eq 1 -and @($slice[0].warning_codes|Where-Object {$_ -ne $approvedWarning}).Count -gt 0){$issues.Add($kind+'_WARNINGS')}
 if($slice.Count -eq 1){
  $provider=if($kind -eq 'CAFE24_ORDER'){'CAFE24'}else{'META'}
  $run=@($runs|Where-Object provider -eq $provider)
  if($run.Count -eq 1 -and $run[0].status -eq 'SUCCEEDED' -and $slice[0].last_success_run_id -ne $run[0].id){$issues.Add($kind+'_SUCCESS_POINTER_MISMATCH')}
 }
}
$ad=($canonical|Where-Object kind -eq 'META_AD');$adset=($canonical|Where-Object kind -eq 'META_ADSET')
$hasSpendWarning=@($coverage|Where-Object {$_.data_kind -like 'META*' -and $approvedWarning -in $_.warning_codes}).Count
$e=$metaSpend.evidence
if($hasSpendWarning -or $e){
 $valid=$hasSpendWarning -eq 2 -and $null -ne $e -and $e.policy -eq 'DAILY_HIERARCHY_L1_USD_10' -and $e.version -eq 1 -and $e.day -eq $Day -and [decimal]$e.limitUsd -eq 10 -and $e.monetaryDifferencesAllocated -eq $false -and $metaSpend.evidenceVariants -eq 1 -and $metaSpend.missingEvidence -eq 0
 if($valid){
  $differences=@('adToAdset','adsetToCampaign','adToCampaign','campaignToAccount','adsetToAccount','adToAccount')
  $maximum=[decimal]0
  foreach($key in $differences){$amount=[decimal]$e.absoluteDifferencesUsd.$key;if($amount -lt 0 -or $amount -gt 10){$valid=$false};if($amount -gt $maximum){$maximum=$amount}}
  $valid=$valid -and $maximum -gt 0 -and $maximum -eq [decimal]$e.maxAbsoluteDifferenceUsd -and [decimal]$e.adSpendUsd -eq [decimal]$ad.spend -and [decimal]$e.adsetSpendUsd -eq [decimal]$adset.spend -and [decimal]$e.absoluteDifferencesUsd.adToAdset -eq [decimal]$metaSpend.adsetL1
  foreach($pair in @(@('adSpendUsd','adToAccount'),@('adsetSpendUsd','adsetToAccount'),@('campaignSpendUsd','campaignToAccount'))){if([Math]::Abs([decimal]$e.($pair[0])-[decimal]$e.accountSpendUsd) -ne [decimal]$e.absoluteDifferencesUsd.($pair[1])){$valid=$false}}
 }
 if(-not $valid){$issues.Add('META_SPEND_TOLERANCE_EVIDENCE_INVALID')}
}elseif([decimal]$ad.spend -ne [decimal]$adset.spend -or [decimal]$metaSpend.adsetL1 -ne 0){$issues.Add('META_SPEND_MISMATCH')}

if($scheduler.stopped -or -not $scheduler.jobActive -or $scheduler.pausedCount -ne 0 -or -not $scheduler.fixedRequestIndex){$issues.Add('SCHEDULER_NOT_READY')}
$summary=@{checkedAt=[DateTimeOffset]::UtcNow.ToString('o');day=$Day;status=$(if($issues.Count){'ATTENTION'}else{'PASS'});issues=@($issues);acceptedSpendWarning=$(if($hasSpendWarning){$e}else{$null});runs=$runs;canonical=$canonical;receipt=$receiptPath}
$summary|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $directory 'summary.json') -Encoding utf8
$summary|ConvertTo-Json -Depth 10
if($issues.Count){exit 1}
