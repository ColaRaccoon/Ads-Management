# Root-only one source-digest variable; preserve the active Singapore configuration.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$stage='IDENTITY';$context=$null;$before=$null;$after=$null;$mutationStarted=$false
try {
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-v12-configuration-actual-20261015.json'
 $pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '0368163a964e94086ef77ca644a6bf3d0be2ec6cfe12523cb136ec5ac02cd9fa' -or $pins.deploymentId -cne 'a35d7507-2044-41f5-9f91-fd4838ad0d28'){throw 'pins'}
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$null=Get-Phase08SchedulerGraphState $context $pins;$null=Get-Phase08SchedulerReady $context $pins
 $ids=@{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}
 $deployment=(Invoke-Phase08SchedulerGraph 'query($d:String!){deployment(id:$d){id meta}}' @{d=$pins.deploymentId}).deployment
 $region=$deployment.meta.serviceManifest.deploy.multiRegionConfig
 if($deployment.id -cne $pins.deploymentId -or $region -isnot [Collections.IDictionary] -or $region.Count -ne 1 -or -not $region.Contains('sin') -or $region.sin -isnot [Collections.IDictionary] -or $region.sin.Count -ne 1 -or ($region.sin.numReplicas -isnot [int] -and $region.sin.numReplicas -isnot [long]) -or $region.sin.numReplicas -ne 1){throw 'region'}
 $stage='QUIESCENT_DATABASE'
 $rows=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT current_database() AS database,current_user AS principal,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables,(SELECT count(*)=1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app') AS stopped,(SELECT count(*)=1 FROM daily_data_sync_ops.schedules WHERE key='phase08-meta' AND paused AND anchor_at='2026-10-14T17:02:00Z') AS paused,(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS leases,(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS jobs,(SELECT count(*)::int FROM phase08_meta_ads.sync_runs WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND trigger='MANUAL' AND request_key IN('phase08-manual-meta-20261008-v11-20261015','phase08-manual-meta-20261008-v11-sin-20261015') AND status='FAILED' AND attempt_count=1 AND rows_published=0) AS failed_manuals;COMMIT;")
 if($rows.Count -ne 1 -or $rows[0].database -cne 'postgres' -or $rows[0].principal -cne 'postgres' -or $rows[0].stopped -isnot [bool] -or -not $rows[0].stopped -or $rows[0].paused -isnot [bool] -or -not $rows[0].paused){throw 'database'}
 foreach($pair in @(@('tables',68),@('leases',0),@('jobs',149),@('failed_manuals',2))){$n=$pair[0];if(($rows[0].$n -isnot [int] -and $rows[0].$n -isnot [long]) -or $rows[0].$n -ne $pair[1]){throw 'database-count'}}
 $stage='FROZEN_SOURCE'
 $manifest=Get-Content -Raw -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261015-meta-v12/source-content-manifest.json'|ConvertFrom-Json -AsHashtable -DateKind String
 $sha='d1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21'
 $bytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $manifest.files -Depth 10 -Compress))
 if($manifest.sourceContentSha256 -cne $sha -or $manifest.files.Count -ne 475 -or $manifest.secretsIncluded -isnot [bool] -or $manifest.secretsIncluded -or $manifest.sourceComposition -cne 'FROZEN_V11_PLUS_REVIEWED_META_PRELOAD_PAIR' -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $sha){throw 'manifest'}
 $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}'
 $before=(Invoke-Phase08SchedulerGraph $query $ids).variables
 if($before.PHASE08_SOURCE_CONTENT_SHA256 -cne $pins.sourceSha -or $before.Count -ne 101){throw 'source'}
 $stage='ONE_SOURCE_VARIABLE';$mutationStarted=$true
 $result=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$ids.p;environmentId=$ids.e;serviceId=$ids.s;skipDeploys=$true;variables=@{PHASE08_SOURCE_CONTENT_SHA256=$sha}}}
 if($result.variableCollectionUpsert -isnot [bool] -or -not $result.variableCollectionUpsert){throw 'outcome'}
 $stage='READBACK';$after=(Invoke-Phase08SchedulerGraph $query $ids).variables
 if($after.Count -ne $before.Count){throw 'count'}
 foreach($name in $before.Keys){$expected=if($name -ceq 'PHASE08_SOURCE_CONTENT_SHA256'){$sha}else{$before[$name]};if($after[$name] -cne $expected){throw 'preservation'}}
 $out=@{state='PHASE08_META_V12_SOURCE_PREPARED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$sha;files=475;changedVariables=1;other100VariablesPreserved=$true;skipDeploys=$true;region='sin';globalStopped=$true;metaPaused=$true;providerRequests=0;databaseWrites=0;operatingChanges=0}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_META_V12_PREPARE_FAILED';stage=$stage;outcomeUncertain=$mutationStarted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$before=$null;$after=$null;$deployment=$null;$result=$null}
