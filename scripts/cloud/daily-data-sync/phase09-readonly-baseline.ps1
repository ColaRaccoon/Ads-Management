param([string]$OutputPath='C:/Users/seong/AppData/Local/MetaAdsPhase09Evaluation/baseline-20261019.json')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='GRAPH'
try {
  Import-Phase08SchedulerChildDefinitions
  $stage='PINS_READ'
  $pins=Get-Phase08SchedulerPins
  $stage='CONTEXT_READ'
  $context=Read-Phase08ProtectedJson
  Assert-Phase08SchedulerContext $context $pins
  $stage='GRAPH_STATE_READ'
  $state=Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId sleepApplication latestDeployment{id status}}}' @{e=$pins.identity.environmentId;s=$pins.identity.serviceId}
  if($state.serviceInstance.serviceId -cne $pins.identity.serviceId -or $state.serviceInstance.environmentId -cne $pins.identity.environmentId -or $state.serviceInstance.latestDeployment.id -cne $pins.deploymentId){throw 'service-identity'}
  $stage='VARIABLES_READ'
  $raw=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' @{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}
  $vars=$raw.variables
  $graph=@{deploymentStatus=$state.serviceInstance.latestDeployment.status;appSchedules=($vars.DAILY_SYNC_SCHEDULES|ConvertFrom-Json -Depth 12)}
  if($vars.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $vars.SUPABASE_STORAGE_BUCKET -cne 'meta-ads-phase08-isolated' -or $vars.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $vars.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime'){throw 'target'}
  $jwt=$vars.SUPABASE_STORAGE_ACCESS_TOKEN
  $part=$jwt.Split('.')[1].Replace('-','+').Replace('_','/')
  $part=$part.PadRight($part.Length+(4-$part.Length%4)%4,'=')
  $claims=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part))|ConvertFrom-Json
  if($claims.role -cne 'phase08_storage_app'){throw 'storage-role'}
  $expires=[DateTimeOffset]::FromUnixTimeSeconds($claims.exp)
  $stage='STORAGE_READ'
  $headers=@{Authorization=('Bearer '+$jwt);apikey=$vars.SUPABASE_PUBLISHABLE_KEY}
  $storage=Invoke-WebRequest -Uri ($vars.SUPABASE_URL+'/storage/v1/object/authenticated/meta-ads-phase08-isolated/health/readiness-sentinel') -Method Get -Headers $headers -MaximumRedirection 0 -TimeoutSec 25 -SkipHttpErrorCheck
  $storageStatus=[int]$storage.StatusCode
  $storage=$null;$headers.Clear();$headers=$null;$jwt=$null;$claims=$null;$part=$null;$raw=$null;$vars=$null
  $stage='DATABASE_READ'
  $sql=@'
BEGIN READ ONLY;
SET LOCAL statement_timeout=15000;
SELECT current_database() AS database,current_user AS principal,current_setting('transaction_read_only') AS read_only,
 (SELECT count(*)::int FROM pg_tables WHERE schemaname='phase08_meta_ads') AS tables,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS force_rls,
 (SELECT stopped FROM daily_data_sync_ops.settings) AS stopped,
 (SELECT count(*)::int FROM daily_data_sync_ops.schedules WHERE paused) AS paused,
 (SELECT count(*)::int FROM cron.job WHERE active) AS active_jobs,
 (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) AS call_md5,
 (SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS leases,
 (SELECT json_agg(json_build_object('provider',provider::text,'enabled',enabled,'accessState',access_state::text,'credentialExpiresAt',credential_expires_at) ORDER BY provider::text) FROM phase08_meta_ads.source_connections) AS connections,
 (SELECT json_agg(json_build_object('provider',c.provider::text,'from',r.from_date::text,'to',r.to_date::text,'status',r.status::text,'fetched',r.rows_fetched,'published',r.rows_published,'error',r.safe_error_code) ORDER BY c.provider::text,r.started_at DESC) FROM phase08_meta_ads.sync_runs r JOIN phase08_meta_ads.source_connections c ON c.id=r.connection_id WHERE r.started_at>='2026-10-16T04:51:06Z') AS recent_runs;
COMMIT;
'@
  $rows=@(Invoke-Phase08Management -Action Query -Query $sql)
  if($rows.Count -ne 1 -or $rows[0].database -cne 'postgres' -or $rows[0].principal -cne 'postgres' -or $rows[0].read_only -cne 'on' -or $rows[0].tables -ne 68 -or $rows[0].force_rls -ne 68){throw 'database-identity'}
  $out=[ordered]@{state='PHASE09_READONLY_BASELINE';observedAt=[DateTimeOffset]::UtcNow.ToString('o');identity=$pins.identity;deploymentId=$pins.deploymentId;sourceSha=$pins.sourceSha;deploymentStatus=$graph.deploymentStatus;appSchedules=$graph.appSchedules;storageExpiresAt=$expires.ToString('o');storageMinimum24h=($expires -gt [DateTimeOffset]::UtcNow.AddHours(24));storageGetStatus=$storageStatus;database=$rows[0];appHttpRequests=0;providerRequests=0;databaseWrites=0;remoteConfigurationWrites=0}
  $root='C:/Users/seong/AppData/Local/MetaAdsPhase09Evaluation'
  [void][IO.Directory]::CreateDirectory($root)
  if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputPath)) -cne [IO.Path]::GetFullPath($root)){throw 'output'}
  $stream=[IO.File]::Open($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$bytes=[Text.Encoding]::UTF8.GetBytes(($out|ConvertTo-Json -Depth 15));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
  $out|ConvertTo-Json -Depth 15
}catch{@{state='PHASE09_READONLY_BASELINE_REJECTED';stage=$stage;rawErrorSuppressed=$true;providerRequests=0;databaseWrites=0;remoteConfigurationWrites=0}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$raw=$null;$vars=$null;$jwt=$null;$claims=$null;$headers=$null;$storage=$null;$rows=$null}
