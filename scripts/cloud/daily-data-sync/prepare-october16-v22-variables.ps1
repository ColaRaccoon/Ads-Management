param([ValidateSet('test','normal')][string]$Phase='test',[switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/afternoon-runtime-helpers.ps1"
$stage='APPROVAL';$submitted=$false;$context=$null;$before=$null;$after=$null
try{
 if(-not $ExecuteApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-v22-variables-'+$Phase+'-actual-20261016.json')
 $marker=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-v22-variables-'+$Phase+'-attempt-20261016.json')
 $configuration=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/schedules-october16-v22-'+$Phase+'-20261016.json')
 $source='0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1';$pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 if(($Phase -ceq 'test' -and ($pins.sourceSha -cne 'f7592804a9763eb228d7c97be00479431700e78b7c57e4544b4c6a863556e4df' -or $pins.deploymentId -cne '5b6caf98-f569-4c6e-9086-2401cae2dd7b')) -or ($Phase -ceq 'normal' -and $pins.sourceSha -cne $source)){throw 'old-pins'}
 if([DateTimeOffset]::UtcNow -lt [DateTimeOffset]'2026-10-16T00:00:00Z' -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-16T13:00:00Z' -or ($Phase -ceq 'test' -and [DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-16T04:45:00Z')){throw 'clock'}
 $stage='STOPPED_DATABASE';$db=Get-Phase08AfternoonRuntimeSnapshot;if(-not $db.stopped -or $db.live_leases -ne 0 -or $db.active_jobs -ne 149){throw 'database'}
 $stage='IMMUTABLE_475';$root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261016-meta-history-v22'
 $manifest=[IO.File]::ReadAllText((Join-Path $root 'source-content-manifest.json'))|ConvertFrom-Json -AsHashtable -Depth 15 -DateKind String
 $bytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $manifest.files -Compress -Depth 10))
 if($manifest.sourceContentSha256 -cne $source -or $manifest.files.Count -ne 475 -or $manifest.secretsIncluded -isnot [bool] -or $manifest.secretsIncluded -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $source){throw 'manifest'}
 foreach($file in $manifest.files){if($file.name -isnot [string] -or $file.name -cnotmatch '^[A-Za-z0-9_./-]+$' -or $file.name.Contains('..') -or $file.name.StartsWith('/')){throw 'path'};$item=Get-Item -LiteralPath (Join-Path $root $file.name);if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne $file.size -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256){throw 'file'}}
 $stage='DEFINITIONS';$previous=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-repeat-profile-bridge.mjs" @{action='definitions';phase=$(if($Phase -ceq 'test'){'test'}else{'test'})};$next=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-repeat-profile-bridge.mjs" @{action='definitions';phase=$Phase}
 if($previous.state -cne 'PHASE08_OCTOBER16_DEFINITIONS' -or $next.state -cne 'PHASE08_OCTOBER16_DEFINITIONS' -or @($previous.definitions).Count -ne 3 -or @($next.definitions).Count -ne 3){throw 'definitions'}
 $projection={param($d)@{key=$d.key;connectionId=$d.connectionId;anchorAt=$d.anchorAt;windowMinutes=$d.windowMinutes}}
 $expected=@($previous.definitions|ForEach-Object{& $projection $_});$desired=@($next.definitions|ForEach-Object{& $projection $_})
 $ids=@{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId};$query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}'
 $stage='OLD_LIVE_APP';$graph=Get-Phase08SchedulerGraphState $context $pins;$service=Get-Phase08AfternoonRuntimeService $pins
 if($service.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or @($service.activeDeployments).Count -ne 1 -or $service.activeDeployments[0].id -cne $pins.deploymentId){throw 'runtime'}
 $before=(Invoke-Phase08SchedulerGraph $query $ids).variables;if($before.Count -ne 101 -or $before.PHASE08_SOURCE_CONTENT_SHA256 -cne $pins.sourceSha){throw 'variables'}
 $old=@($before.DAILY_SYNC_SCHEDULES|ConvertFrom-Json -AsHashtable -DateKind String);if($old.Count -ne 3){throw 'old-definitions'}
 foreach($d in $expected){$row=@($old|Where-Object{$_.key -ceq $d.key});if($row.Count -ne 1 -or $row[0].Count -ne 4 -or $row[0].connectionId -cne $d.connectionId -or $row[0].anchorAt -cne $d.anchorAt -or $row[0].windowMinutes -ne $d.windowMinutes){throw 'old-definitions'}}
 $changed=if($Phase -ceq 'test'){@{PHASE08_SOURCE_CONTENT_SHA256=$source}}else{@{DAILY_SYNC_SCHEDULES=(ConvertTo-Json -InputObject $desired -Compress -Depth 10)}}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='OCTOBER16_ISOLATED_VARIABLE_CHANGE_PLANNED';phase=$Phase;sourceSha=$source;observedAt=[DateTimeOffset]::UtcNow.ToString('o');changedVariables=$changed.Count;providerRequests=0} $marker
 $stage='SINGLE_MUTATION';$submitted=$true;$r=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$ids.p;environmentId=$ids.e;serviceId=$ids.s;skipDeploys=$true;variables=$changed}}
 if($r.variableCollectionUpsert -isnot [bool] -or -not $r.variableCollectionUpsert){throw 'unknown'}
 $stage='READBACK';$after=(Invoke-Phase08SchedulerGraph $query $ids).variables;if($after.Count -ne 101){throw 'count'}
 foreach($name in $before.Keys){$wanted=if($changed.ContainsKey($name)){$changed[$name]}else{$before[$name]};if($after[$name] -cne $wanted){throw 'preservation'}}
 $afterDb=Get-Phase08AfternoonRuntimeSnapshot;if(-not $afterDb.stopped -or $afterDb.live_leases -ne 0 -or $afterDb.business_md5 -cne $db.business_md5 -or $afterDb.original_history -cne $db.original_history){throw 'database-changed'}
 $null=Write-Phase08SchedulerPublicEvidence @($next.definitions) $configuration
 $out=@{state='PHASE08_OCTOBER16_VARIABLES_VERIFIED';phase=$Phase;observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$source;changedVariables=$changed.Count;otherVariablesPreserved=(101-$changed.Count);skipDeploys=$true;globalStopped=$true;businessDigestUnchanged=$true;original152Preserved=$true;providerRequests=0;databaseWrites=0;operatingChanges=0;configurationPath=$configuration}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_OCTOBER16_VARIABLES_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$before=$null;$after=$null;$r=$null;$graph=$null;$service=$null}
