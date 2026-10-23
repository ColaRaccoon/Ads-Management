param([switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/afternoon-runtime-helpers.ps1"
$stage='APPROVAL';$submitted=$false;$context=$null;$before=$null;$after=$null
try{
 if(-not $ExecuteApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-link-v15-variables-actual-20261015.json'
 $marker=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-link-v15-variables-attempt-20261015.json'
 $pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne 'e83351e69260d94a6aaebb5ff6d109bd38aa0570b3bdbc1f55069d8a3b39d44f' -or $pins.deploymentId -cne '44783a13-1150-4f13-9d7a-88217bd9784a'){throw 'old-pins'}
 if([DateTimeOffset]::UtcNow -lt [DateTimeOffset]'2026-10-15T07:01:00Z' -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-15T08:15:00Z'){throw 'clock'}
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $stage='STOPPED_QUIESCENT_DATABASE';$db=Get-Phase08AfternoonRuntimeSnapshot
 if(-not $db.stopped -or $db.live_leases -ne 0 -or $db.active_jobs -ne 149 -or $db.collection_succeeded_units -ne 1 -or $db.outage_runs -ne 0){throw 'database'}
 $failure=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT count(*)::int AS failed_units FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-15T07:00:00.000Z','sha256'),'hex') AND r.status='ACTION_REQUIRED' AND r.safe_error_code='RECONCILIATION_FAILED' AND r.rows_published=68 AND u.unit_key='2026-10-09' AND u.status='ACTION_REQUIRED' AND u.attempts=1 AND u.fetched_count=0 AND u.published_count=0;ROLLBACK;")
 if($failure.Count -ne 1 -or ($failure[0].failed_units -isnot [int] -and $failure[0].failed_units -isnot [long]) -or $failure[0].failed_units -ne 1){throw 'failure-scope'}
 $stage='FROZEN_475_FILES';$root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261015-meta-link-v15';$sha='436055128dad4b150f6ff4c3a754d1cadc3b9cb784f3d659423df35f33f773ff'
 $manifest=[IO.File]::ReadAllText((Join-Path $root 'source-content-manifest.json'))|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15
 $bytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $manifest.files -Compress -Depth 10))
 if($manifest.sourceContentSha256 -cne $sha -or $manifest.files.Count -ne 475 -or $manifest.secretsIncluded -isnot [bool] -or $manifest.secretsIncluded -or $manifest.sourceComposition -cne 'FROZEN_V14_PLUS_REVIEWED_META_PARENT_LINK_ZERO_PROOF' -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $sha){throw 'manifest'}
 foreach($file in $manifest.files){if($file.name -isnot [string] -or $file.name -cnotmatch '^[A-Za-z0-9_./-]+$' -or $file.name.Contains('..') -or $file.name.StartsWith('/')){throw 'path'};$item=Get-Item -LiteralPath (Join-Path $root $file.name);if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne $file.size -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256){throw 'file'}}
 $stage='EXISTING_APP_AND_COLLECTION';$service=Get-Phase08AfternoonRuntimeService $pins
 if($service.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or @($service.activeDeployments).Count -ne 1 -or $service.activeDeployments[0].id -cne $pins.deploymentId){throw 'active-service'}
 $graph=Get-Phase08SchedulerGraphState $context $pins;$definitions=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-profile-bridge.mjs" @{action='definitions';phase='collection'}
 if($definitions.state -cne 'PHASE08_AFTERNOON_DEFINITIONS'){throw 'definitions'}
 $null=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($definitions.definitions);appSchedules=@($graph.appSchedules);managementSchedules=@()}
 $ids=@{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId};$query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}'
 $before=(Invoke-Phase08SchedulerGraph $query $ids).variables
 if($before.Count -ne 101 -or $before.PHASE08_SOURCE_CONTENT_SHA256 -cne $pins.sourceSha){throw 'variables'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='ISOLATED_META_PARENT_LINK_PROOF_CHANGE_PLANNED';sourceSha=$sha;previousSourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;observedAt=[DateTimeOffset]::UtcNow.ToString('o');changedVariables=1;providerRequests=0} $marker
 $stage='SINGLE_VARIABLE_MUTATION';$submitted=$true
 $reply=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$ids.p;environmentId=$ids.e;serviceId=$ids.s;skipDeploys=$true;variables=@{PHASE08_SOURCE_CONTENT_SHA256=$sha}}}
 if($reply.variableCollectionUpsert -isnot [bool] -or -not $reply.variableCollectionUpsert){throw 'outcome'}
 $stage='READBACK';$after=(Invoke-Phase08SchedulerGraph $query $ids).variables
 if($after.Count -ne 101){throw 'variable-count'};foreach($name in $before.Keys){$expected=if($name -ceq 'PHASE08_SOURCE_CONTENT_SHA256'){$sha}else{$before[$name]};if($after[$name] -cne $expected){throw 'other-variable-changed'}}
 $afterDb=Get-Phase08AfternoonRuntimeSnapshot
 if(-not $afterDb.stopped -or $afterDb.live_leases -ne 0 -or $afterDb.business_md5 -cne $db.business_md5 -or $afterDb.original_history -cne $db.original_history){throw 'database-changed'}
 $out=@{state='PHASE08_META_LINK_V15_VARIABLES_VERIFIED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$sha;previousSourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;files=475;changedVariables=1;other100VariablesPreserved=$true;skipDeploys=$true;globalStopped=$true;businessDigestUnchanged=$true;original152Preserved=$true;providerRequests=0;databaseWrites=0;operatingChanges=0}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_META_LINK_V15_VARIABLES_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$before=$null;$after=$null;$manifest=$null;$reply=$null}
