Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$stage='IDENTITY';$context=$null;$before=$null;$after=$null
try {
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/normal-02-v11-configuration-actual-20261015.json'
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 if($pins.sourceSha -cne '9b6fa647a8ebe56d3598aafa069400e2c880a8fda37a531f03d1e55b9ef5e409' -or $pins.deploymentId -cne '56ed1723-ba91-4cdd-a335-f0e241cc180c'){throw 'pins'}
 $null=Get-Phase08SchedulerGraphState $context $pins
 $stage='DATABASE_GUARD'
 $guard=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT (SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton AND target_id='phase08-full-app') AS stopped,(SELECT count(*) FROM daily_data_sync_ops.schedules WHERE paused AND key='phase08-meta')::int AS paused,(SELECT count(*) FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp())::int AS leases,(SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) AS hash;COMMIT;")
 if($guard.Count -ne 1 -or $guard[0].stopped -isnot [bool] -or -not $guard[0].stopped -or ($guard[0].paused -isnot [int] -and $guard[0].paused -isnot [long]) -or $guard[0].paused -ne 1 -or ($guard[0].leases -isnot [int] -and $guard[0].leases -isnot [long]) -or $guard[0].leases -ne 0 -or $guard[0].hash -cne '0f11e36961a628ab665302b950d0b9aa'){throw 'database'}
 $normal=Read-Phase08SchedulerDefinitions 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/schedules-20261015-normal-02-v11.json'
 $snapshot=Get-Phase08SchedulerSnapshot
 $expected=@($normal.definitions|ForEach-Object {@{key=$_.key;connectionId=$_.connectionId;anchorAt=$_.anchorAt;windowMinutes=$_.windowMinutes}})
 $ids=@{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}
 $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}'
 $before=(Invoke-Phase08SchedulerGraph $query $ids).variables
 $old=@($before.DAILY_SYNC_SCHEDULES|ConvertFrom-Json -AsHashtable -DateKind String)
 $management=@($snapshot.snapshot.schedules|ForEach-Object {@{key=$_.key;connectionId=$_.connectionId;provider=$_.provider;anchorAt=$_.anchorAt;windowMinutes=$_.windowMinutes;cadenceDays=$_.cadenceDays}})
 $loaded=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($normal.definitions);appSchedules=$expected;managementSchedules=$management}
 if($loaded.state -cne 'PHASE08_LOADED_DEFINITIONS_VERIFIED' -or $old.Count -ne 3){throw 'definitions'}
 if(@($old.key|Sort-Object -Unique).Count -ne 3){throw 'old-definitions'}
 foreach($row in $old){$wanted=@($expected|Where-Object {$_.key -ceq $row.key});$index=@('phase08-cafe24','phase08-google','phase08-meta').IndexOf($row.key);if($row.Count -ne 4 -or $wanted.Count -ne 1 -or $index -lt 0 -or $row.anchorAt -cne ('2026-10-15T01:0'+$index+':00.000Z') -or $row.connectionId -cne $wanted[0].connectionId -or ($row.windowMinutes -isnot [int] -and $row.windowMinutes -isnot [long]) -or $row.windowMinutes -ne $wanted[0].windowMinutes){throw 'old-definitions'}}
 $manifest=Get-Content -Raw -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261015-v11/source-content-manifest.json'|ConvertFrom-Json -AsHashtable -DateKind String
 if($manifest.sourceContentSha256 -cne '0368163a964e94086ef77ca644a6bf3d0be2ec6cfe12523cb136ec5ac02cd9fa' -or $manifest.files.Count -ne 474 -or $manifest.secretsIncluded -isnot [bool] -or $manifest.secretsIncluded){throw 'manifest'}
 $changed=@{PHASE08_SOURCE_CONTENT_SHA256=$manifest.sourceContentSha256;DAILY_SYNC_SCHEDULES=(ConvertTo-Json -InputObject $expected -Compress -Depth 8)}
 $stage='VARIABLES_TWO_ONLY'
 $reply=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$ids.p;environmentId=$ids.e;serviceId=$ids.s;variables=$changed;skipDeploys=$true}}
 if($reply.variableCollectionUpsert -isnot [bool] -or -not $reply.variableCollectionUpsert){throw 'outcome'}
 $stage='READBACK';$after=(Invoke-Phase08SchedulerGraph $query $ids).variables
 if($after.Count -ne $before.Count){throw 'count'}
 foreach($name in $before.Keys){$value=if($changed.ContainsKey($name)){$changed[$name]}else{$before[$name]};if($after[$name] -cne $value){throw 'preservation'}}
 $public=@{state='PHASE08_NORMAL_02_V11_VARIABLES_PREPARED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$manifest.sourceContentSha256;changedVariables=2;otherVariablesPreserved=($before.Count-2);skipDeploys=$true;globalStopped=$true;providerRequests=0;operatingChanges=0}
 $null=Write-Phase08SchedulerPublicEvidence $public $output;$public|ConvertTo-Json -Compress
}catch{@{state='PHASE08_NORMAL_02_V11_PREPARE_FAILED';stage=$stage;outcomeUncertain=($stage -cin @('VARIABLES_TWO_ONLY','READBACK','PUBLIC_EVIDENCE'));retryPerformed=$false;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$before=$null;$after=$null;$changed=$null;$reply=$null}
