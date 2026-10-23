# Read-only verification of an immutable-source v11 build using current Singapore config.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$stage='ACTUAL_DEPLOYMENT';$variables=$null;$context=$null;$headers=$null;$response=$null
try {
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-v12-sin-build-verified-actual-20261015-v2.json'
 $ids=@{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
 $new='5dac048f-5015-46fa-8ca4-5227352c834c';$old='a35d7507-2044-41f5-9f91-fd4838ad0d28'
 $service=(Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status} activeDeployments{id status}}}' @{e=$ids.e;s=$ids.s}).serviceInstance
 if($service.serviceId -cne $ids.s -or $service.environmentId -cne $ids.e -or $service.startCommand -cne 'node deploy/cloud/phase08-launch.mjs' -or $service.sleepApplication -isnot [bool] -or -not $service.sleepApplication -or $service.latestDeployment.id -cne $new -or $service.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or @($service.activeDeployments).Count -ne 1 -or $service.activeDeployments[0].id -cne $new -or $service.activeDeployments[0].status -cnotin @('SUCCESS','SLEEPING')){throw 'deployment'}
 $variables=(Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' $ids).variables
 $query='query($d:String!){deployment(id:$d){id status meta}}'
 $previous=(Invoke-Phase08SchedulerGraph $query @{d=$old}).deployment
 $current=(Invoke-Phase08SchedulerGraph $query @{d=$new}).deployment
 if($current.meta.imageDigest -isnot [string] -or $current.meta.imageDigest -cnotmatch '^sha256:[a-f0-9]{64}$' -or $current.status -cnotin @('SUCCESS','SLEEPING')){throw 'image'}
 $stage='ONLY_REGION_CHANGED'
 $before=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'region-v12-material.mjs') @{region='sin';deploy=$previous.meta.serviceManifest.deploy;variables=$variables}
 $after=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'region-v12-material.mjs') @{region='sin';deploy=$current.meta.serviceManifest.deploy;variables=$variables}
 if($before.state -cne 'PHASE08_REGION_MATERIAL_VERIFIED' -or $after.state -cne 'PHASE08_REGION_MATERIAL_VERIFIED' -or $after.deployWithoutRegionSha -cne '567afab5f1d2bcdc5269190a91725a45006d21ec9af4bde695f3ff11dc9f62a9' -or $before.deployWithoutRegionSha -cne $after.deployWithoutRegionSha -or $after.variableCount -ne 101){throw 'preservation'}
 $stage='IMMUTABLE_SOURCE_BYTES'
 $root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261015-meta-v12'
 $manifest=Get-Content -Raw -LiteralPath (Join-Path $root 'source-content-manifest.json')|ConvertFrom-Json -AsHashtable -DateKind String
 $manifestBytes=[Text.Encoding]::UTF8.GetBytes(($manifest.files|ConvertTo-Json -Depth 10 -Compress))
 if($manifest.sourceContentSha256 -cne 'd1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21' -or $manifest.files.Count -ne 475 -or $manifest.secretsIncluded -isnot [bool] -or $manifest.secretsIncluded -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($manifestBytes)).ToLowerInvariant() -cne $manifest.sourceContentSha256){throw 'manifest'}
 foreach($file in $manifest.files){if($file.name -isnot [string] -or $file.name -cnotmatch '^[A-Za-z0-9_./-]+$' -or $file.name.Contains('..') -or $file.name.StartsWith('/')){throw 'source-path'};$item=Get-Item -LiteralPath (Join-Path $root $file.name);if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256){throw 'source-bytes'}}
 $stage='PROTECTED_READY_AND_ACTUAL_REGION'
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $headers=@{'x-internal-probe-token'=$context.env.INTERNAL_PROBE_TOKEN;'X-Railway-Debug'='1'}
 $response=Invoke-WebRequest -Uri ($pins.identity.origin+'/backend-api/health/ready') -Headers $headers -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
 $zone=[string]$response.Headers['X-Railway-Upstream-Zone']
 if([int]$response.StatusCode -ne 200 -or $response.Content.Length -gt 8192 -or [string]$response.Headers['Cache-Control'] -notmatch '(?i)(^|[,\s])no-store([,\s]|$)' -or $zone -cnotmatch '^railway/asia-southeast1(?:-(?:eqsg3a|drsin10a))?$'){throw 'region-ready'}
 $body=$response.Content|ConvertFrom-Json -AsHashtable -DateKind String
 if($body.status -cne 'ready' -or $body.releaseId -cne $pins.identity.releaseSha -or $body.runtimeConfigFingerprint -cne $pins.identity.readyFingerprint){throw 'ready'}
 $rows=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT current_database() AS database,current_user AS principal,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables,(SELECT count(*)=1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app') AS stopped,(SELECT count(*)=1 FROM daily_data_sync_ops.schedules WHERE key='phase08-meta' AND paused AND anchor_at='2026-10-14T17:02:00Z') AS paused,(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS leases,(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS jobs,(SELECT count(*)::int FROM phase08_meta_ads.sync_runs WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND trigger='MANUAL' AND request_key IN('phase08-manual-meta-20261008-v11-20261015','phase08-manual-meta-20261008-v11-sin-20261015') AND status='FAILED' AND attempt_count=1 AND rows_published=0) AS failed_manuals;COMMIT;")
 if($rows.Count -ne 1 -or $rows[0].database -cne 'postgres' -or $rows[0].principal -cne 'postgres' -or $rows[0].stopped -isnot [bool] -or -not $rows[0].stopped -or $rows[0].paused -isnot [bool] -or -not $rows[0].paused){throw 'database'}
 foreach($pair in @(@('tables',68),@('leases',0),@('jobs',149),@('failed_manuals',2))){$n=$pair[0];if(($rows[0].$n -isnot [int] -and $rows[0].$n -isnot [long]) -or $rows[0].$n -ne $pair[1]){throw 'database-count'}}
 $out=@{state='PHASE08_META_V12_SIN_BUILD_VERIFIED';classification='ACTUAL_V12_BUILD_SIN';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$new;originalDeploymentId=$old;sourceSha='d1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21';region='sin';upstreamZone=$zone;immutableSourceFilesVerified=475;sameImageVerified=($current.meta.imageDigest -ceq $previous.meta.imageDigest);deployConfigurationPreserved=$true;other100VariablesPreservedByPriorPrepareEvidence=$true;replicas=1;cpu=1;memoryBytes=1000000000;sleepApplication=$true;globalStopped=$true;metaPaused=$true;providerRequests=0;databaseWrites=0;operatingChanges=0}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_SIN_DEPLOYMENT_VERIFICATION_FAILED';stage=$stage;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($headers){$headers.Clear()};$variables=$null;$previous=$null;$current=$null;$context=$null;$headers=$null;$response=$null}
