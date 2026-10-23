param([Parameter(Mandatory)][ValidateSet('outage','collection','normal')][string]$Phase,[switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='APPROVAL';$submitted=$false;$context=$null;$before=$null;$after=$null
try{
 if(-not $ExecuteApproved){throw 'approval'}
 Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-variables-'+$Phase+'-actual-20261015.json')
 $configuration=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/schedules-afternoon-'+$Phase+'-20261015.json')
 $marker=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-variables-'+$Phase+'-attempt-20261015.json')
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $newSha='42c15d089e41db8fb4286209bcf8975eb4c9ec3aa61b23f459aa49bd3024764f'
 if(($Phase -ceq 'outage' -and ($pins.sourceSha -cne 'd1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21' -or $pins.deploymentId -cne '5dac048f-5015-46fa-8ca4-5227352c834c')) -or ($Phase -cne 'outage' -and $pins.sourceSha -cne $newSha)){throw 'pins'}
 $stage='STOPPED_DATABASE';$db=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT current_database() AS database,current_user AS principal,(SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app') AS stopped,(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS leases,(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%') AS jobs;COMMIT;")
 if($db.Count -ne 1 -or $db[0].database -cne 'postgres' -or $db[0].principal -cne 'postgres' -or $db[0].stopped -isnot [bool] -or -not $db[0].stopped -or ($db[0].leases -isnot [int] -and $db[0].leases -isnot [long]) -or $db[0].leases -ne 0 -or ($db[0].jobs -isnot [int] -and $db[0].jobs -isnot [long]) -or $db[0].jobs -ne 149){throw 'database'}
 $stage='IMMUTABLE_SOURCE';$root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261015-meta-unit-v17'
 $manifest=[IO.File]::ReadAllText((Join-Path $root 'source-content-manifest.json'))|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15
 $bytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $manifest.files -Compress -Depth 10))
 if($manifest.sourceContentSha256 -cne $newSha -or $manifest.files.Count -ne 475 -or $manifest.secretsIncluded -isnot [bool] -or $manifest.secretsIncluded -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $newSha){throw 'manifest'}
 foreach($f in $manifest.files){if($f.name -isnot [string] -or $f.name -cnotmatch '^[A-Za-z0-9_./-]+$' -or $f.name.Contains('..') -or $f.name.StartsWith('/')){throw 'path'};$item=Get-Item -LiteralPath (Join-Path $root $f.name);if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne $f.size -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'bytes'}}
 $stage='DEFINITIONS';$next=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-profile-bridge.mjs" @{action='definitions';phase=$Phase}
 $previousPhase=if($Phase -ceq 'outage'){'normal'}elseif($Phase -ceq 'collection'){'outage'}else{'collection'}
 $previous=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-profile-bridge.mjs" @{action='definitions';phase=$previousPhase}
 if($next.state -cne 'PHASE08_AFTERNOON_DEFINITIONS' -or $previous.state -cne 'PHASE08_AFTERNOON_DEFINITIONS' -or @($next.definitions).Count -ne 3 -or @($previous.definitions).Count -ne 3){throw 'definitions'}
 $projection={param($r)@{key=$r.key;connectionId=$r.connectionId;anchorAt=$r.anchorAt;windowMinutes=$r.windowMinutes}}
 $expected=@($previous.definitions|ForEach-Object {& $projection $_});$desired=@($next.definitions|ForEach-Object {& $projection $_})
 $stage='LIVE_VARIABLES';$ids=@{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}
 $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status} activeDeployments{id status}}}'
 $live=Invoke-Phase08SchedulerGraph $query $ids;$svc=$live.serviceInstance;$before=$live.variables
 if($before.Count -ne 101 -or $before.PHASE08_SOURCE_CONTENT_SHA256 -cne $pins.sourceSha -or $svc.serviceId -cne $pins.identity.serviceId -or $svc.environmentId -cne $pins.identity.environmentId -or $svc.startCommand -cne 'node deploy/cloud/phase08-launch.mjs' -or $svc.sleepApplication -isnot [bool] -or -not $svc.sleepApplication -or $svc.latestDeployment.id -cne $pins.deploymentId){throw 'live-identity'}
 if($svc.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or @($svc.activeDeployments).Count -ne 1 -or $svc.activeDeployments[0].id -cne $pins.deploymentId){throw 'active-deployment'}
 if($Phase -ceq 'collection' -and ([DateTimeOffset]::UtcNow -lt [DateTimeOffset]'2026-10-15T06:38:00Z' -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-15T06:59:00Z')){throw 'outage-transition'}
 $old=@($before.DAILY_SYNC_SCHEDULES|ConvertFrom-Json -AsHashtable -DateKind String)
 if($old.Count -ne 3){throw 'loaded'}
 foreach($wanted in $expected){$row=@($old|Where-Object {$_.key -ceq $wanted.key});if($row.Count -ne 1 -or $row[0].Count -ne 4 -or $row[0].connectionId -cne $wanted.connectionId -or $row[0].anchorAt -cne $wanted.anchorAt -or ($row[0].windowMinutes -isnot [int] -and $row[0].windowMinutes -isnot [long]) -or $row[0].windowMinutes -ne $wanted.windowMinutes){throw 'old-definitions'}}
 if($Phase -ceq 'outage' -and [DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-15T05:58:00Z'){throw 'cutoff'}
 $changed=@{DAILY_SYNC_SCHEDULES=(ConvertTo-Json -InputObject $desired -Compress -Depth 10)};if($Phase -ceq 'outage'){$changed.PHASE08_SOURCE_CONTENT_SHA256=$newSha}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='EXPLICIT_TEST_VARIABLE_CHANGE_PLANNED';phase=$Phase;observedAt=[DateTimeOffset]::UtcNow.ToString('o');changedVariables=$changed.Count;providerRequests=0} $marker
 $stage='SINGLE_MUTATION';$submitted=$true;$result=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$ids.p;environmentId=$ids.e;serviceId=$ids.s;variables=$changed;skipDeploys=$true}}
 if($result.variableCollectionUpsert -isnot [bool] -or -not $result.variableCollectionUpsert){throw 'outcome'}
 $stage='READBACK';$after=(Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' $ids).variables
 if($after.Count -ne 101){throw 'count'};foreach($key in $before.Keys){$wanted=if($changed.ContainsKey($key)){$changed[$key]}else{$before[$key]};if($after[$key] -cne $wanted){throw 'preservation'}}
 $null=Write-Phase08SchedulerPublicEvidence @($next.definitions) $configuration
 $out=@{state='PHASE08_AFTERNOON_VARIABLES_VERIFIED';phase=$Phase;sourceSha=$newSha;observedAt=[DateTimeOffset]::UtcNow.ToString('o');changedVariables=$changed.Count;otherVariablesPreserved=(101-$changed.Count);skipDeploys=$true;globalStopped=$true;providerRequests=0;databaseWrites=0;operatingChanges=0;configurationPath=$configuration}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_AFTERNOON_VARIABLES_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$before=$null;$after=$null;$changed=$null;$result=$null;$live=$null;$svc=$null}
