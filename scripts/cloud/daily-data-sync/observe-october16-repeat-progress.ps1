param()
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
function ConvertTo-Phase08October16Progress($Rows,$DeploymentStatus){
 if($DeploymentStatus -isnot [string] -or $DeploymentStatus -cnotin @('SUCCESS','SLEEPING')){throw 'deployment'}
 if(@($Rows).Count -ne 1){throw 'row'};$r=@($Rows)[0];$names=@('identity','tables','cafe','meta','cafe_checkpoints','cafe_expired_checkpoints','meta_checkpoints','meta_expired_checkpoints','active_leases','runtime_active','runtime_idle','runtime_total')
 $keys=if($r -is [Collections.IDictionary]){@($r.Keys)}else{@($r.PSObject.Properties.Name)}
 if($keys.Count -ne $names.Count -or @($names|Where-Object {$_ -cnotin $keys}).Count){throw 'shape'}
 $encoded=ConvertTo-Json -InputObject $r -Compress -Depth 12;if([Text.Encoding]::UTF8.GetByteCount($encoded) -gt 65536){throw 'result-bound'};$r=$encoded|ConvertFrom-Json -AsHashtable -DateKind String -Depth 12;$encoded=$null
 if($r.identity -isnot [bool] -or -not $r.identity){throw 'identity'}
 $out=[ordered]@{state='PHASE08_OCTOBER16_PROGRESS_READONLY';identityVerified=$true;deploymentStatus=$DeploymentStatus}
 foreach($n in @('tables','cafe_checkpoints','cafe_expired_checkpoints','meta_checkpoints','meta_expired_checkpoints','active_leases','runtime_active','runtime_idle','runtime_total')){if(($r.$n -isnot [int] -and $r.$n -isnot [long]) -or $r.$n -lt 0 -or $r.$n -gt 10000){throw 'count'};$out[$n]=$r.$n}
 if($out.tables -ne 68 -or $out.cafe_expired_checkpoints -gt $out.cafe_checkpoints -or $out.meta_expired_checkpoints -gt $out.meta_checkpoints -or $out.runtime_active+$out.runtime_idle -gt $out.runtime_total){throw 'counts'}
 $statuses=@('QUEUED','RUNNING','PARTIAL','SUCCEEDED','FAILED','ACTION_REQUIRED','CANCELLED')
 $codes=@('SOURCE_SELECTION_REQUIRED','ACCOUNT_SCOPE_MISMATCH','CURRENCY_MISMATCH','TIMEZONE_MISMATCH','FIELD_UNSUPPORTED','ATTRIBUTION_MISMATCH','PARTIAL_PAGE','RECONCILIATION_FAILED','LEASE_LOST','RUN_LIMIT_EXCEEDED','PROVIDER_AUTH_REQUIRED','PROVIDER_RATE_LIMITED','PROVIDER_UNAVAILABLE','PROVIDER_VERSION_UNVERIFIED')
 foreach($provider in @('cafe','meta')){
  $run=$r.$provider;if($null -eq $run){$out[$provider]=$null;continue}
  if($run -isnot [Collections.IDictionary] -or $run.Count -ne 5 -or @('status','attempts','published','code','units'|Where-Object {-not $run.Contains($_)}).Count){throw 'run-shape'}
  if($run.status -isnot [string] -or $run.status -cnotin $statuses -or $run.units -isnot [array]){throw 'run'}
  foreach($n in @('attempts','published')){if(($run[$n] -isnot [int] -and $run[$n] -isnot [long]) -or $run[$n] -lt 0 -or $run[$n] -gt 1000000){throw 'run-count'}}
  $safeCode=if($null -eq $run.code){$null}elseif($run.code -is [string] -and $run.code -cin $codes){$run.code}else{'UNCLASSIFIED'}
  $dates=@(if($provider -ceq 'cafe'){'2026-10-15'}else{'2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14','2026-10-15'})
  if($run.units.Count -ne $dates.Count){throw 'unit-count'};$units=@();$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach($u in $run.units){if($u -isnot [Collections.IDictionary] -or $u.Count -ne 4 -or @('day','status','attempts','published'|Where-Object {-not $u.Contains($_)}).Count -or $u.day -isnot [string] -or $u.day -cnotin $dates -or -not $seen.Add($u.day) -or $u.status -isnot [string] -or $u.status -cnotin $statuses){throw 'unit'}
   foreach($n in @('attempts','published')){if(($u[$n] -isnot [int] -and $u[$n] -isnot [long]) -or $u[$n] -lt 0 -or $u[$n] -gt $(if($n -ceq 'attempts'){3}else{1000000})){throw 'unit-value'}}
   $units+=@{day=$u.day;status=$u.status;attempts=$u.attempts;published=$u.published}
  }
  $out[$provider]=@{status=$run.status;attempts=$run.attempts;published=$run.published;code=$safeCode;units=$units}
 }
 $out['observedAt']=[DateTimeOffset]::UtcNow.ToString('o');$out['appHttpRequests']=0;$out['providerRequests']=0;$out['databaseWrites']=0;$out['rawValuesReturned']=0;return $out
}
function Get-Phase08October16ProgressSql {
 $c='schedule:phase08-cafe24:'+([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes('2026-10-16T01:15:00.000Z'))).ToLowerInvariant())
 $m='schedule:phase08-meta:'+([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes('2026-10-16T03:30:00.000Z'))).ToLowerInvariant())
 return @"
BEGIN READ ONLY;SET LOCAL statement_timeout=15000;SET LOCAL TIME ZONE 'UTC';
WITH target AS(SELECT r.*,CASE WHEN connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1'::uuid THEN 'cafe' ELSE 'meta' END provider FROM phase08_meta_ads.sync_runs r WHERE trigger='SCHEDULED' AND actor_user_id IS NULL AND ((connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1' AND request_key='$c' AND from_date='2026-10-15' AND to_date='2026-10-15') OR (connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND request_key='$m' AND from_date='2026-10-09' AND to_date='2026-10-15'))),
shaped AS(SELECT r.provider,jsonb_build_object('status',r.status,'attempts',r.attempt_count,'published',r.rows_published,'code',r.safe_error_code,'units',(SELECT coalesce(jsonb_agg(jsonb_build_object('day',u.unit_key,'status',u.status,'attempts',u.attempts,'published',u.published_count) ORDER BY u.unit_key),'[]') FROM phase08_meta_ads.run_units u WHERE u.run_id=r.id)) AS body FROM target r)
SELECT current_database()='postgres' AND current_user='postgres' AND current_setting('transaction_read_only')='on' AND to_regnamespace('storage_renewal_ops') IS NULL AS identity,
(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables,
(SELECT body FROM shaped WHERE provider='cafe') AS cafe,(SELECT body FROM shaped WHERE provider='meta') AS meta,
(SELECT count(*)::int FROM phase08_meta_ads.sync_unit_checkpoints p JOIN target r ON r.id=p.run_id WHERE r.provider='cafe') AS cafe_checkpoints,
(SELECT count(*)::int FROM phase08_meta_ads.sync_unit_checkpoints p JOIN target r ON r.id=p.run_id WHERE r.provider='cafe' AND p.expires_at<=clock_timestamp()) AS cafe_expired_checkpoints,
(SELECT count(*)::int FROM phase08_meta_ads.sync_unit_checkpoints p JOIN target r ON r.id=p.run_id WHERE r.provider='meta') AS meta_checkpoints,
(SELECT count(*)::int FROM phase08_meta_ads.sync_unit_checkpoints p JOIN target r ON r.id=p.run_id WHERE r.provider='meta' AND p.expires_at<=clock_timestamp()) AS meta_expired_checkpoints,
(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE connection_id IN('0c35defe-45fc-4a54-bc79-704df7bca5b1','1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6') AND expires_at>clock_timestamp()) AS active_leases,
(SELECT count(*)::int FROM pg_stat_activity WHERE usename='phase08_runtime' AND state='active') AS runtime_active,
(SELECT count(*)::int FROM pg_stat_activity WHERE usename='phase08_runtime' AND state='idle') AS runtime_idle,
(SELECT count(*)::int FROM pg_stat_activity WHERE usename='phase08_runtime') AS runtime_total;COMMIT;
"@
}
if($MyInvocation.InvocationName -cne '.'){
 $stage='IDENTITY';$context=$null
 try{Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins;if($pins.sourceSha -cne 'f7592804a9763eb228d7c97be00479431700e78b7c57e4544b4c6a863556e4df'){throw 'source'};$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $stage='DEPLOYMENT_READONLY';$graph=Get-Phase08SchedulerGraphState $context $pins
 $stage='DATABASE_READONLY';$rows=@(Invoke-Phase08Management -Action Query -Query (Get-Phase08October16ProgressSql));$stage='STRICT_SAFE_PROJECT';$out=ConvertTo-Phase08October16Progress $rows $graph.deploymentStatus;$out|ConvertTo-Json -Compress -Depth 8
 }catch{@{state='PHASE08_OCTOBER16_PROGRESS_FAILED';stage=$stage;providerRequests=0;appHttpRequests=0;databaseWrites=0;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}finally{$context=$null;$rows=$null;$out=$null}
}
