param([ValidateSet('Plan','Execute')][string]$Mode='Plan',[switch]$ExecuteApproved)
# A separate explicit MANUAL one-day recovery. Never resumes or changes the old weekly run.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/source-connection-helpers.ps1"
$script:Phase08V12R3SourceSha='d1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21'
$script:Phase08V12R3DeploymentId='5dac048f-5015-46fa-8ca4-5227352c834c' # Root sets only after actual reviewed v12 Singapore deployment.
function Get-Phase08ManualMetaV12R3Dto {
 return @{connectionId='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6';fromDate='2026-10-08';toDate='2026-10-08';mode='MANUAL';requestKey='phase08-manual-meta-20261008-v12-r3-20261015';reason='PHASE08_ORIGINAL_SLOT_RECOVERY'}
}
function Assert-Phase08ManualMetaV12R3Graph($Graph) {
 if($Graph.featureEnabled -isnot [bool] -or -not $Graph.featureEnabled -or @($Graph.appSchedules).Count -ne 3){throw 'manual-app-definitions'}
 $ids=@('0c35defe-45fc-4a54-bc79-704df7bca5b1','b9ebee4b-5d4e-4eae-92b9-9facfbf3c900','1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6');$providers=@('CAFE24','GOOGLE','META');$keys=@('phase08-cafe24','phase08-google','phase08-meta')
 for($i=0;$i -lt 3;$i++){$row=@($Graph.appSchedules|Where-Object {$_.key -ceq $keys[$i]});if($row.Count -ne 1 -or $row[0] -isnot [Collections.IDictionary] -or $row[0].Count -ne 4 -or @(@('key','connectionId','anchorAt','windowMinutes')|Where-Object {-not $row[0].Contains($_)}).Count -ne 0 -or $row[0].connectionId -cne $ids[$i] -or $row[0].anchorAt -cne ('2026-10-14T17:0'+$i+':00.000Z') -or ($row[0].windowMinutes -isnot [int] -and $row[0].windowMinutes -isnot [long]) -or $row[0].windowMinutes -ne $(if($i -eq 0){110}else{90})){throw 'manual-app-definitions'}}
}
function Assert-Phase08ManualMetaV12R3Permissions($Payload) {
 if($Payload -isnot [Collections.IDictionary] -or -not $Payload.Contains('permissions') -or $Payload.permissions -isnot [array] -or 'imports.manage' -cnotin $Payload.permissions -or 'data.read' -cnotin $Payload.permissions){throw 'run-permission'}
}
function Assert-Phase08ManualMetaV12R3Region($Pins) {
 if($script:Phase08V12R3DeploymentId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $Pins.deploymentId -cne $script:Phase08V12R3DeploymentId){throw 'reviewed-sin-deployment-required'}
 $data=Invoke-Phase08SchedulerGraph 'query($id:String!){deployment(id:$id){id status meta}}' @{id=$script:Phase08V12R3DeploymentId}
 Assert-Phase08ManualMetaV12R3RegionValue $data $Pins.deploymentId
}
function Assert-Phase08ManualMetaV12R3RegionValue($Data,[string]$DeploymentId){
 $d=$Data.deployment;if($d.id -cne $DeploymentId -or $d.status -cnotin @('SUCCESS','SLEEPING')){throw 'sin-deployment'}
 $regions=$d.meta.serviceManifest.deploy.multiRegionConfig
 if($regions -isnot [Collections.IDictionary] -or $regions.Count -ne 1 -or -not $regions.Contains('sin') -or $regions.sin -isnot [Collections.IDictionary] -or $regions.sin.Count -ne 1 -or ($regions.sin.numReplicas -isnot [int] -and $regions.sin.numReplicas -isnot [long]) -or $regions.sin.numReplicas -ne 1){throw 'sin-region'}
}
function Get-Phase08ManualMetaV12R3SnapshotSql([string]$ActorId) {
 if($ActorId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'actor'}
 return @"
BEGIN READ ONLY;SET LOCAL statement_timeout=10000;
WITH original AS (SELECT r.* FROM phase08_meta_ads.sync_runs r WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND trigger='SCHEDULED' AND request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-15T01:02:00.000Z','sha256'),'hex')),
prior_sin AS(SELECT r.* FROM phase08_meta_ads.sync_runs r WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND request_key='phase08-manual-meta-20261008-v11-sin-20261015'),
prior_manual AS(SELECT r.* FROM phase08_meta_ads.sync_runs r WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND request_key='phase08-manual-meta-20261008-v11-20261015'),
manual AS(SELECT r.* FROM phase08_meta_ads.sync_runs r WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND request_key='phase08-manual-meta-20261008-v12-r3-20261015')
SELECT current_database() AS database,current_user AS principal,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables,
 (SELECT count(*)=1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app') AS stopped,
 (SELECT count(*)=1 FROM daily_data_sync_ops.schedules WHERE key='phase08-meta' AND provider='META' AND connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND paused AND anchor_at='2026-10-14T17:02:00Z') AS paused,
 (SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS active_jobs,
 EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND provider='META' AND external_account_id='2138525300002203' AND shop_key='default' AND currency_code='USD' AND time_zone='Asia/Seoul' AND enabled AND access_state='READY' AND credential_expires_at>clock_timestamp()+interval '7 days') AS source_ready,
 (SELECT count(*)=2 FROM phase08_meta_ads.source_policies WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND data_kind IN('META_AD','META_ADSET') AND primary_source='API' AND from_date<='2026-10-08' AND (to_date IS NULL OR to_date>'2026-10-08')) AS policies_ready,
 (SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND expires_at>clock_timestamp()) AS active_leases,
 (SELECT count(*)=1 FROM original r WHERE status='FAILED' AND safe_error_code='PROVIDER_UNAVAILABLE' AND from_date='2026-10-08' AND to_date='2026-10-14' AND rows_published=0 AND (SELECT count(*) FROM phase08_meta_ads.run_units WHERE run_id=r.id)=7 AND EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key='2026-10-08' AND status='FAILED' AND attempts=2 AND fetched_count=0 AND published_count=0) AND NOT EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key<>'2026-10-08' AND (status<>'QUEUED' OR attempts<>0))) AS original_expected,
 (SELECT count(*)=1 FROM prior_manual r WHERE trigger='MANUAL' AND status='FAILED' AND safe_error_code='PROVIDER_UNAVAILABLE' AND actor_user_id='$ActorId' AND from_date='2026-10-08' AND to_date='2026-10-08' AND rows_published=0 AND (SELECT count(*) FROM phase08_meta_ads.run_units WHERE run_id=r.id)=1 AND EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key='2026-10-08' AND status='FAILED' AND attempts=1 AND published_count=0)) AS prior_manual_expected,
 (SELECT count(*)=1 FROM prior_sin r WHERE trigger='MANUAL' AND status='FAILED' AND safe_error_code='PROVIDER_UNAVAILABLE' AND actor_user_id='$ActorId' AND from_date='2026-10-08' AND to_date='2026-10-08' AND rows_published=0 AND (SELECT count(*) FROM phase08_meta_ads.run_units WHERE run_id=r.id)=1 AND EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key='2026-10-08' AND status='FAILED' AND attempts=1 AND published_count=0)) AS prior_sin_expected,
 md5(jsonb_build_object('runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM original r),'units',(SELECT jsonb_agg(to_jsonb(u) ORDER BY run_id,unit_key) FROM phase08_meta_ads.run_units u WHERE run_id IN(SELECT id FROM original)),
 'priorSin',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM prior_sin r),'priorSinUnits',(SELECT jsonb_agg(to_jsonb(u) ORDER BY run_id,unit_key) FROM phase08_meta_ads.run_units u WHERE run_id IN(SELECT id FROM prior_sin)),'priorSinAudits',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM phase08_meta_ads.security_audit_events a WHERE target_id IN(SELECT id::text FROM prior_sin) OR target_id IN(SELECT id::text||':2026-10-08' FROM prior_sin)),'priorManual',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM prior_manual r),'priorManualUnits',(SELECT jsonb_agg(to_jsonb(u) ORDER BY run_id,unit_key) FROM phase08_meta_ads.run_units u WHERE run_id IN(SELECT id FROM prior_manual)),'priorManualAudits',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM phase08_meta_ads.security_audit_events a WHERE target_id IN(SELECT id::text FROM prior_manual) OR target_id IN(SELECT id::text||':2026-10-08' FROM prior_manual)),'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM daily_data_sync_ops.attempts a WHERE schedule_key='phase08-meta'),'settings',(SELECT jsonb_agg(to_jsonb(x)) FROM daily_data_sync_ops.settings x),'schedules',(SELECT jsonb_agg(to_jsonb(x) ORDER BY key) FROM daily_data_sync_ops.schedules x),'jobs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY jobid) FROM cron.job x),'policies',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM phase08_meta_ads.source_policies x WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'))::text) AS frozen_digest,
 (SELECT count(*)::int FROM manual) AS manual_count,(SELECT id::text FROM manual) AS manual_id,(SELECT status::text FROM manual) AS manual_status,
 (SELECT count(*)=1 FROM manual WHERE trigger='MANUAL' AND from_date='2026-10-08' AND to_date='2026-10-08' AND actor_user_id='$ActorId') AS manual_scope,
 (SELECT count(*)::int FROM phase08_meta_ads.run_units WHERE run_id IN(SELECT id FROM manual)) AS manual_units,
 (SELECT status::text FROM phase08_meta_ads.run_units WHERE run_id IN(SELECT id FROM manual) AND unit_key='2026-10-08') AS manual_unit_status,
 (SELECT count(*)::int FROM phase08_meta_ads.security_audit_events WHERE target_id IN(SELECT id::text FROM manual) AND action='SYNC_RUN_QUEUED' AND actor_type='USER' AND actor_user_id='$ActorId' AND result='REQUESTED' AND after_json->>'trigger'='MANUAL') AS user_queue_audits,
 (SELECT count(*)::int FROM phase08_meta_ads.meta_ad_daily_metrics WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND metric_date='2026-10-08' AND source='API' AND is_current) AS ad_rows,
 (SELECT count(*)::int FROM phase08_meta_ads.meta_adset_daily_metrics WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND metric_date='2026-10-08' AND source='API' AND is_current) AS adset_rows,
 (SELECT count(DISTINCT m.id)::int FROM phase08_meta_ads.meta_ad_daily_metrics m JOIN phase08_meta_ads.source_record_links l ON l.record_id=m.id AND l.connection_id=m.connection_id AND l.data_kind='META_AD' AND l.source='API' AND l.record_table='meta_ad_daily_metrics' AND l.is_current AND l.version=m.import_version WHERE m.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND m.metric_date='2026-10-08' AND m.source='API' AND m.is_current) AS valid_ad_links,
 (SELECT count(DISTINCT m.id)::int FROM phase08_meta_ads.meta_adset_daily_metrics m JOIN phase08_meta_ads.source_record_links l ON l.record_id=m.id AND l.connection_id=m.connection_id AND l.data_kind='META_ADSET' AND l.source='API' AND l.record_table='meta_adset_daily_metrics' AND l.is_current AND l.version=m.import_version WHERE m.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND m.metric_date='2026-10-08' AND m.source='API' AND m.is_current) AS valid_adset_links,
 (SELECT count(*)::int FROM phase08_meta_ads.source_coverage c WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND metric_date='2026-10-08' AND data_kind IN('META_AD','META_ADSET') AND source='API' AND state IN('COMPLETE_ZERO','COMPLETE_NONZERO') AND last_success_run_id IN(SELECT id FROM manual) AND row_count=CASE c.data_kind WHEN 'META_AD' THEN(SELECT count(*) FROM phase08_meta_ads.meta_ad_daily_metrics WHERE connection_id=c.connection_id AND metric_date=c.metric_date AND source='API' AND is_current) ELSE(SELECT count(*) FROM phase08_meta_ads.meta_adset_daily_metrics WHERE connection_id=c.connection_id AND metric_date=c.metric_date AND source='API' AND is_current) END) AS complete_kinds;
COMMIT;
"@
}
function Assert-Phase08ManualMetaV12R3Snapshot($Rows,[string]$Phase) {
 if(@($Rows).Count -ne 1 -or $Phase -cnotin @('BEFORE','QUEUED','AFTER')){throw 'snapshot'};$r=@($Rows)[0]
 if($r.database -cne 'postgres' -or $r.principal -cne 'postgres' -or $r.frozen_digest -isnot [string] -or $r.frozen_digest -cnotmatch '^[a-f0-9]{32}$'){throw 'snapshot-identity'}
 foreach($n in @('tables','active_jobs','active_leases','manual_count','manual_units','user_queue_audits','ad_rows','adset_rows','valid_ad_links','valid_adset_links','complete_kinds')){if(($r.$n -isnot [int] -and $r.$n -isnot [long]) -or $r.$n -lt 0 -or $r.$n -gt 50000){throw 'snapshot-count'}}
 foreach($n in @('stopped','paused','source_ready','policies_ready','original_expected','prior_manual_expected','prior_sin_expected','manual_scope')){if($r.$n -isnot [bool]){throw 'snapshot-flag'}}
 if($r.tables -ne 68 -or $r.active_jobs -ne 149 -or -not $r.stopped -or -not $r.paused -or -not $r.source_ready -or -not $r.policies_ready -or -not $r.original_expected -or -not $r.prior_manual_expected -or -not $r.prior_sin_expected){throw 'snapshot-gate'}
 if($Phase -ceq 'BEFORE'){if($r.active_leases -ne 0 -or $r.manual_count -ne 0 -or $r.manual_units -ne 0 -or $r.ad_rows -ne 0 -or $r.adset_rows -ne 0 -or $r.user_queue_audits -ne 0 -or $r.complete_kinds -ne 0){throw 'manual-existing-inspect'}}else{
  if($r.manual_id -isnot [string] -or $r.manual_id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $r.manual_count -ne 1 -or -not $r.manual_scope -or $r.manual_units -ne 1 -or $r.user_queue_audits -ne 1){throw 'manual-scope'}
  if($Phase -ceq 'QUEUED' -and ($r.manual_status -cne 'QUEUED' -or $r.manual_unit_status -cne 'QUEUED' -or $r.active_leases -ne 0 -or $r.ad_rows -ne 0 -or $r.adset_rows -ne 0)){throw 'manual-not-queued'}
  if($Phase -ceq 'AFTER' -and ($r.manual_status -cne 'SUCCEEDED' -or $r.manual_unit_status -cne 'SUCCEEDED' -or $r.complete_kinds -ne 2 -or $r.active_leases -ne 0 -or $r.valid_ad_links -ne $r.ad_rows -or $r.valid_adset_links -ne $r.adset_rows)){throw 'manual-not-complete'}
 }
 return @{frozen_digest=$r.frozen_digest;manual_id=$r.manual_id;ad_rows=$r.ad_rows;adset_rows=$r.adset_rows}
}
function Invoke-Phase08ManualMetaV12R3Http([string]$Phase,[string]$RunId,$Context,$Session,$Headers){
 if($Context.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app' -or $Phase -cnotin @('QUEUE','EXECUTE')){throw 'http-scope'}
 if($Phase -ceq 'QUEUE'){$path='/backend-api/sync-runs';$body=Get-Phase08ManualMetaV12R3Dto;$expected=202}else{if($RunId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'http-run'};$path='/backend-api/sync-runs/'+$RunId+'/execute-meta';$body=@{};$expected=200}
 try{$r=Invoke-WebRequest -Uri ($Context.origin+$path) -Method Post -Headers $Headers -WebSession $Session -ContentType 'application/json' -Body ($body|ConvertTo-Json -Compress) -MaximumRedirection 0 -TimeoutSec 90 -SkipHttpErrorCheck}catch{throw (New-Phase08SourceHttpException $null)}
 if([int]$r.StatusCode -ne $expected -or $r.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($r.Content) -gt 16384 -or [string]$r.Headers['Cache-Control'] -notmatch '(?i)(^|[,\s])no-store([,\s]|$)'){throw (New-Phase08SourceHttpException $r)}
 $value=$r.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 8
 if($value -isnot [Collections.IDictionary] -or $value.id -isnot [string] -or $value.id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'http-result'}
 if($Phase -ceq 'QUEUE'){if($value.connectionId -cne '1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' -or $value.trigger -cne 'MANUAL' -or $value.fromDate -cne '2026-10-08T00:00:00.000Z' -or $value.toDate -cne '2026-10-08T00:00:00.000Z' -or $value.status -cne 'QUEUED' -or $value.requestKey -cne (Get-Phase08ManualMetaV12R3Dto).requestKey){throw 'queue-result'}}else{if($value.id -cne $RunId -or $value.status -cne 'SUCCEEDED' -or $null -ne $value.safeErrorCode){throw 'execute-result'};foreach($n in @('rowsFetched','rowsPublished')){if(($value[$n] -isnot [int] -and $value[$n] -isnot [long]) -or $value[$n] -lt 0 -or $value[$n] -gt 100000){throw 'execute-count'}}}
 return @{id=$value.id;status=$value.status}
}
if($MyInvocation.InvocationName -cne '.'){
 $stage='PLAN';$context=$null;$operator=$null;$headers=$null;$session=$null;$queuePosts=0;$executePosts=0
 try{
  if($Mode -ceq 'Plan'){@{state='PHASE08_MANUAL_META_PLAN';sourceSha=$script:Phase08V12R3SourceSha;day='2026-10-08';mode='MANUAL';days=1;expectedQueuePosts=1;expectedExecutePosts=1;oldWeeklyRunChanged=$false;providerRequests=0;remoteChanges=0;requiresExplicitExecutionApproval=$true;serverUsesExistingManualDeadline=$true}|ConvertTo-Json -Compress;exit 0}
  if(-not $ExecuteApproved){throw 'explicit-execute-required'}
  $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-manual-oct8-v12-r3-actual-20261015.json';$marker=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-manual-oct8-v12-r3-attempt-20261015.json'
  $stage='IDENTITY';Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins;if($script:Phase08V12R3SourceSha -cnotmatch '^[a-f0-9]{64}$' -or $pins.sourceSha -cne $script:Phase08V12R3SourceSha){throw 'source'}
  $context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator;Assert-Phase08SchedulerContext $context $pins;Assert-Phase08SourceContext $context $operator;$graph=Get-Phase08SchedulerGraphState $context $pins;Assert-Phase08ManualMetaV12R3Graph $graph;Assert-Phase08ManualMetaV12R3Region $pins;$null=Get-Phase08SchedulerReady $context $pins
  $sql=Get-Phase08ManualMetaV12R3SnapshotSql $operator.appId;$stage='BASELINE';$before=Assert-Phase08ManualMetaV12R3Snapshot @(Invoke-Phase08Management -Action Query -Query $sql) 'BEFORE'
  $stage='LOGIN';$session=[Microsoft.PowerShell.Commands.WebRequestSession]::new();$headers=@{Origin=$context.origin};$login=Invoke-Phase08SourceRequest 'POST' '/backend-api/auth/login' @{email=$operator.email;password=$operator.password} $context $session $headers;Assert-Phase08LoginResponse $login $session $operator $context.origin
  $loginPayload=$login.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 8;Assert-Phase08ManualMetaV12R3Permissions $loginPayload;$login=$null;$loginPayload=$null
  $csrf=@($session.Cookies.GetCookies([Uri]$context.origin)|Where-Object {$_.Name -ceq '__Host-phase08-meta_csrf'});if($csrf.Count -ne 1){throw 'csrf'};$headers['X-CSRF-Token']=$csrf[0].Value
  $stage='IMMEDIATE_BASELINE';$fresh=Assert-Phase08ManualMetaV12R3Snapshot @(Invoke-Phase08Management -Action Query -Query $sql) 'BEFORE';if($fresh.frozen_digest -cne $before.frozen_digest){throw 'baseline-changed'}
  $null=Write-Phase08SchedulerPublicEvidence @{classification='MANUAL_SINGLE_DAY_RECOVERY_PLANNED';day='2026-10-08';sourceSha=$pins.sourceSha;startedAt=[DateTimeOffset]::UtcNow.ToString('o');oldScheduledAttemptsPreserved=$true} $marker
  $stage='SINGLE_QUEUE';$queuePosts=1;$queued=Invoke-Phase08ManualMetaV12R3Http 'QUEUE' '' $context $session $headers
  $stage='QUEUE_READBACK';$queuedDb=Assert-Phase08ManualMetaV12R3Snapshot @(Invoke-Phase08Management -Action Query -Query $sql) 'QUEUED';if($queuedDb.manual_id -cne $queued.id -or $queuedDb.frozen_digest -cne $before.frozen_digest){throw 'queue-readback'}
  $stage='SINGLE_EXECUTE';$executePosts=1;$executed=Invoke-Phase08ManualMetaV12R3Http 'EXECUTE' $queued.id $context $session $headers
  $stage='COMPLETE_READBACK';$after=Assert-Phase08ManualMetaV12R3Snapshot @(Invoke-Phase08Management -Action Query -Query $sql) 'AFTER';if($after.manual_id -cne $executed.id -or $after.frozen_digest -cne $before.frozen_digest){throw 'after-readback'}
  $out=@{state='PHASE08_MANUAL_META_DAY_COMPLETE';classification='ACTUAL_NORMAL_HTTP_MANUAL_ONE_DAY_RECOVERY';day='2026-10-08';mode='MANUAL';days=1;manualRunId=$executed.id;status='SUCCEEDED';completedUnits=1;adRows=$after.ad_rows;adsetRows=$after.adset_rows;coverageKinds=2;queuePosts=1;executePosts=1;userQueueAudits=1;originalScheduledRunPreserved=$true;originalWeeklySucceeded=$false;schedulerRemainsStopped=$true;metaScheduleRemainsPaused=$true;region='sin';previousFailedManualsPreserved=2;providerRequestCountObserved=$false;videoFieldsRequested=0;purchaseCountAndValueRequired=$true;serverUsesExistingManualDeadline=$true;csvUploads=0;operatingChanges=0;rawValuesReturned=0}
  $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 4 -Compress
 }catch{$d=Get-Phase08SourceFailureDiagnostic $_.Exception;@{state='PHASE08_MANUAL_META_FAILED';stage=$stage;queuePosts=$queuePosts;executePosts=$executePosts;code=$d.code;httpStatus=$d.httpStatus;outcomeUncertain=($queuePosts -gt 0);inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
 finally{if($headers){$headers.Clear()};$context=$null;$operator=$null;$headers=$null;$session=$null;$login=$null;$csrf=$null;$loginPayload=$null;$sql=$null;$queued=$null;$executed=$null;$out=$null;$before=$null;$fresh=$null;$after=$null;$queuedDb=$null}
}
