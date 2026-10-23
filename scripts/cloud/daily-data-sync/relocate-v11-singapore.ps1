# One isolated config change and, if needed, one redeploy of the same v11 image.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$stage='IDENTITY';$context=$null;$variables=$null;$mutations=0
try {
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/region-sin-request-actual-20261015.json'
 $pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '0368163a964e94086ef77ca644a6bf3d0be2ec6cfe12523cb136ec5ac02cd9fa' -or $pins.deploymentId -cne '86d5ad6d-eec8-414a-a922-9c6b8c62a245'){throw 'pins'}
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$null=Get-Phase08SchedulerGraphState $context $pins
 $ids=@{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}
 $regions=(Invoke-Phase08SchedulerGraph 'query($p:String!){regions(projectId:$p){id name region location country}}' @{p=$ids.p}).regions
 if(@($regions|Where-Object {$_.id -ceq 'sin' -and $_.region -ceq 'Singapore' -and $_.country -ceq 'Singapore'}).Count -lt 1){throw 'available-region'}
 $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}'
 $variables=(Invoke-Phase08SchedulerGraph $query $ids).variables
 $deployment=(Invoke-Phase08SchedulerGraph 'query($d:String!){deployment(id:$d){id status meta}}' @{d=$pins.deploymentId}).deployment
 if($deployment.id -cne $pins.deploymentId -or $deployment.status -cnotin @('SUCCESS','SLEEPING') -or $deployment.meta.imageDigest -isnot [string] -or $deployment.meta.imageDigest -cnotmatch '^sha256:[a-f0-9]{64}$'){throw 'deployment'}
 $material=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'region-relocation-material.mjs') @{region='sfo';deploy=$deployment.meta.serviceManifest.deploy;variables=$variables}
 if($material.state -cne 'PHASE08_REGION_MATERIAL_VERIFIED'){throw 'material'}
 $stage='QUIESCENT_BASELINE'
 $sql=@'
BEGIN READ ONLY;
DO $snapshot$ DECLARE row record; item text; value text:=''; BEGIN
 FOR row IN SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
  EXECUTE format('SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'''' ORDER BY md5(to_jsonb(t)::text)),'''')) FROM phase08_meta_ads.%I t',row.tablename) INTO item;
  value:=value||row.tablename||':'||item||';';
 END LOOP;PERFORM set_config('daily_data_sync.region_data_digest',md5(value),true);
END $snapshot$;
SELECT current_database() AS database,current_user AS principal,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables,
 (SELECT count(*)=1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app') AS stopped,
 (SELECT count(*)=1 FROM daily_data_sync_ops.schedules WHERE key='phase08-meta' AND paused AND anchor_at='2026-10-14T17:02:00Z') AS meta_paused,
 (SELECT count(*)=3 FROM daily_data_sync_ops.schedules WHERE (key='phase08-cafe24' AND anchor_at='2026-10-14T17:00:00Z' AND cadence_days=1 AND window_minutes=110) OR (key='phase08-google' AND anchor_at='2026-10-14T17:01:00Z' AND cadence_days=7 AND window_minutes=90) OR (key='phase08-meta' AND anchor_at='2026-10-14T17:02:00Z' AND cadence_days=7 AND window_minutes=90)) AS normal_anchors,
 (SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS live_leases,
 (SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS jobs,
 (SELECT count(*)=1 FROM phase08_meta_ads.sync_runs WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND trigger='MANUAL' AND request_key='phase08-manual-meta-20261008-v11-20261015' AND status='FAILED' AND attempt_count=1 AND rows_published=0) AS failed_manual,
 (SELECT count(*)=1 FROM phase08_meta_ads.sync_runs r WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND trigger='SCHEDULED' AND request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-15T01:02:00.000Z','sha256'),'hex') AND status='FAILED' AND rows_published=0 AND (SELECT count(*) FROM phase08_meta_ads.run_units u WHERE u.run_id=r.id)=7 AND EXISTS(SELECT 1 FROM phase08_meta_ads.run_units u WHERE u.run_id=r.id AND unit_key='2026-10-08' AND status='FAILED' AND attempts=2) AND (SELECT count(*) FROM phase08_meta_ads.run_units u WHERE u.run_id=r.id AND unit_key<>'2026-10-08' AND status='QUEUED' AND attempts=0)=6) AS failed_weekly,
 current_setting('daily_data_sync.region_data_digest') AS data_digest,
 md5(jsonb_build_object('settings',(SELECT jsonb_agg(to_jsonb(x)) FROM daily_data_sync_ops.settings x),'schedules',(SELECT jsonb_agg(to_jsonb(x) ORDER BY key) FROM daily_data_sync_ops.schedules x),'jobs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY jobid) FROM cron.job x),'attempts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM daily_data_sync_ops.attempts x))::text) AS ops_digest;
COMMIT;
'@
 function Assert-RegionQuiescent($Rows){
  if(@($Rows).Count -ne 1){throw 'baseline'};$r=@($Rows)[0]
  if($r.database -cne 'postgres' -or $r.principal -cne 'postgres'){throw 'baseline'}
  foreach($n in @('stopped','meta_paused','normal_anchors','failed_manual','failed_weekly')){if($r.$n -isnot [bool] -or -not $r.$n){throw 'baseline'}}
  foreach($pair in @(@('tables',68),@('jobs',149),@('live_leases',0))){$n=$pair[0];if(($r.$n -isnot [int] -and $r.$n -isnot [long]) -or $r.$n -ne $pair[1]){throw 'baseline'}}
  foreach($n in @('data_digest','ops_digest')){if($r.$n -isnot [string] -or $r.$n -cnotmatch '^[a-f0-9]{32}$'){throw 'digest'}}
  return $r
 }
 $before=Assert-RegionQuiescent @(Invoke-Phase08Management -Action Query -Query $sql)
 $stage='ONE_REGION_CHANGE';$mutations=1
 $changed=Invoke-Phase08SchedulerGraph 'mutation($environmentId:String,$serviceId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(environmentId:$environmentId,serviceId:$serviceId,input:$input)}' @{environmentId=$ids.e;serviceId=$ids.s;input=@{multiRegionConfig=@{sin=@{numReplicas=1}}}}
 if($changed.serviceInstanceUpdate -isnot [bool] -or -not $changed.serviceInstanceUpdate){throw 'mutation'}
 $stage='STATE_AFTER_CONFIG'
 foreach($delay in @(0,2,5,10)){
  if($delay){Start-Sleep -Seconds $delay}
  $service=(Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){latestDeployment{id status} activeDeployments{id status}}}' @{e=$ids.e;s=$ids.s}).serviceInstance
  if($service.latestDeployment.id -cne $pins.deploymentId){break}
  if(@($service.activeDeployments).Count -ne 1 -or $service.activeDeployments[0].id -cne $pins.deploymentId){throw 'concurrent-deployment'}
 }
 if($service.latestDeployment.id -ceq $pins.deploymentId){
  if(@($service.activeDeployments).Count -ne 1 -or $service.activeDeployments[0].id -cne $pins.deploymentId){throw 'concurrent-deployment'}
  $stage='SAME_IMAGE_REDEPLOY';$mutations=2
  $next=(Invoke-Phase08SchedulerGraph 'mutation($d:String!){deploymentRedeploy(id:$d,usePreviousImageTag:true){id status}}' @{d=$pins.deploymentId}).deploymentRedeploy
 }else{$next=$service.latestDeployment}
 if($next.id -isnot [string] -or $next.id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or $next.id -ceq $pins.deploymentId){throw 'new-deployment'}
 $stage='PRESERVATION_READBACK'
 $afterVariables=(Invoke-Phase08SchedulerGraph $query $ids).variables
 $afterMaterial=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'region-relocation-material.mjs') @{region='sfo';deploy=$deployment.meta.serviceManifest.deploy;variables=$afterVariables}
 $after=Assert-RegionQuiescent @(Invoke-Phase08Management -Action Query -Query $sql)
 if($afterMaterial.variablesSha -cne $material.variablesSha -or $after.data_digest -cne $before.data_digest -or $after.ops_digest -cne $before.ops_digest){throw 'preservation'}
 $out=@{state='PHASE08_SIN_RELOCATION_REQUESTED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');fromRegion='sfo';toRegion='sin';originalDeploymentId=$pins.deploymentId;newDeploymentId=$next.id;sourceSha=$pins.sourceSha;imageDigest=$deployment.meta.imageDigest;variablesSha=$material.variablesSha;variableCount=$material.variableCount;deployWithoutRegionSha=$material.deployWithoutRegionSha;originalDeploySha=$material.deploySha;dataDigest=$before.data_digest;opsDigest=$before.ops_digest;replicas=1;cpu=1;memoryBytes=1000000000;sleepApplication=$true;globalStopped=$true;metaPaused=$true;providerRequests=0;databaseWrites=0;operatingChanges=0;actualDeploymentSuccess=$false;configurationMutations=$mutations}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_SIN_RELOCATION_REQUEST_FAILED';stage=$stage;outcomeUncertain=($mutations -gt 0);configurationMutations=$mutations;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$variables=$null;$afterVariables=$null;$deployment=$null}
