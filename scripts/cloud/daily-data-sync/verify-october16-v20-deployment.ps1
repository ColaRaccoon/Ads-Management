param([Parameter(Mandatory)][ValidateSet('initial','restart','normal')][string]$Action,[Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')][string]$DeploymentId,[switch]$FrozenSourceNewBuild)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='IDENTITY';$context=$null;$live=$null;$headers=$null;$response=$null
try{
 Import-Phase08SchedulerChildDefinitions
 if($FrozenSourceNewBuild -and $Action -cne 'initial'){throw 'new-build-action'}
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-v20-deployment-'+$Action+'-actual-20261016.json')
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $source='81b8ba86b22f2019227433f9e0f87ced95d97a44b44ba69d494eec0d664ce537';$previousId=$pins.deploymentId
 if($DeploymentId -ceq $previousId){throw 'new-deployment-required'}
 if($Action -ceq 'initial' -and ($previousId -cne '5f6c56de-47a1-4f34-9194-c7ea1f42a8c6' -or $pins.sourceSha -cne '898bb25b5cc3fca6437d8a284b11e71045cb6e74e073acb848affa0498ae58d9' -or -not $FrozenSourceNewBuild)){throw 'initial-baseline'}
 if($Action -cne 'initial' -and $pins.sourceSha -cne $source){throw 'same-source-required'}
 $ids=@{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}
 $stage='ACTUAL_ACTIVE_DEPLOYMENT';$pins.sourceSha=$source;$pins.deploymentId=$DeploymentId;$graph=Get-Phase08SchedulerGraphState $context $pins
 $live=(Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' $ids).variables
 $data=Invoke-Phase08SchedulerGraph 'query($d:String!,$old:String!){current:deployment(id:$d){id status meta} previous:deployment(id:$old){id meta}}' @{d=$DeploymentId;old=$previousId}
 if($data.current.id -cne $DeploymentId -or $data.previous.id -cne $previousId -or $data.current.meta.imageDigest -isnot [string] -or $data.current.meta.imageDigest -cnotmatch '^sha256:[a-f0-9]{64}$'){throw 'deployment'}
 $sameImage=$data.current.meta.imageDigest -ceq $data.previous.meta.imageDigest
 if(-not $FrozenSourceNewBuild -and -not $sameImage){throw 'image-reuse-not-proven'}
 $stage='FIXED_RESOURCE_AND_REGION';$material=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-v20-region-material.mjs" @{region='sin';deploy=$data.current.meta.serviceManifest.deploy;variables=$live}
 if($material.state -cne 'PHASE08_REGION_MATERIAL_VERIFIED' -or $material.variableCount -ne 101 -or $material.deployWithoutRegionSha -cne '567afab5f1d2bcdc5269190a91725a45006d21ec9af4bde695f3ff11dc9f62a9'){throw 'resource-preservation'}
 $phase=if($Action -ceq 'normal'){'normal'}else{'test'}
 $profile=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-profile-bridge.mjs" @{action='definitions';phase=$phase}
 if($profile.state -cne 'PHASE08_OCTOBER16_DEFINITIONS'){throw 'profile'}
 foreach($d in $profile.definitions){$row=@($graph.appSchedules|Where-Object {$_.key -ceq $d.key});if($row.Count -ne 1 -or $row[0].connectionId -cne $d.connectionId -or $row[0].anchorAt -cne $d.anchorAt -or $row[0].windowMinutes -ne $d.windowMinutes){throw 'app-profile'}}
 $stage='IMMUTABLE_475_FILES';$root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261016-meta-pointer-v20';$manifest=[IO.File]::ReadAllText((Join-Path $root 'source-content-manifest.json'))|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15
 $bytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $manifest.files -Compress -Depth 10))
 if($manifest.sourceContentSha256 -cne $source -or $manifest.files.Count -ne 475 -or $manifest.secretsIncluded -isnot [bool] -or $manifest.secretsIncluded -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $source){throw 'manifest'}
 foreach($f in $manifest.files){if($f.name -isnot [string] -or $f.name -cnotmatch '^[A-Za-z0-9_./-]+$' -or $f.name.Contains('..') -or $f.name.StartsWith('/')){throw 'path'};$item=Get-Item -LiteralPath (Join-Path $root $f.name);if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne $f.size -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'file'}}
 $stage='PROTECTED_READY_ACTUAL_ZONE';$headers=@{'x-internal-probe-token'=$context.env.INTERNAL_PROBE_TOKEN;'X-Railway-Debug'='1'}
 $response=Invoke-WebRequest -Uri ($pins.identity.origin+'/backend-api/health/ready') -Headers $headers -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
 $zone=[string]$response.Headers['X-Railway-Upstream-Zone']
 if([int]$response.StatusCode -ne 200 -or $response.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($response.Content) -gt 8192 -or [string]$response.Headers['Cache-Control'] -notmatch '(?i)(^|[,\s])no-store([,\s]|$)' -or $zone -cnotmatch '^railway/asia-southeast1(?:-(?:eqsg3a|drsin10a))?$'){throw 'ready-zone'}
 $body=$response.Content|ConvertFrom-Json -AsHashtable -DateKind String
 if($body.status -cne 'ready' -or $body.releaseId -cne $pins.identity.releaseSha -or $body.runtimeConfigFingerprint -cne $pins.identity.readyFingerprint){throw 'ready'}
 $stage='DATABASE_CONTROL_READONLY';$rows=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT current_database() AS database,current_user AS principal,(SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) AS stopped,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables,(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%') AS jobs,(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS live_leases;COMMIT;")
 if($rows.Count -ne 1 -or $rows[0].database -cne 'postgres' -or $rows[0].principal -cne 'postgres' -or $rows[0].stopped -isnot [bool] -or -not $rows[0].stopped -or ($rows[0].tables -isnot [int] -and $rows[0].tables -isnot [long]) -or $rows[0].tables -ne 68 -or ($rows[0].jobs -isnot [int] -and $rows[0].jobs -isnot [long]) -or $rows[0].jobs -ne 149){throw 'database'}
 if(($rows[0].live_leases -isnot [int] -and $rows[0].live_leases -isnot [long]) -or $rows[0].live_leases -ne 0){throw 'leases'}
 $out=@{state='PHASE08_OCTOBER16_DEPLOYMENT_VERIFIED';action=$Action;observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$source;deploymentId=$DeploymentId;previousDeploymentId=$previousId;sameImageVerified=$sameImage;frozenSourceNewBuild=[bool]$FrozenSourceNewBuild;immutableFiles=475;region='sin';upstreamZone=$zone;cpu=1;memoryBytes=1000000000;replicas=1;sleepApplication=$true;resourceConfigurationPreserved=$true;globalStopped=$rows[0].stopped;databaseForceRls=68;liveLeasesObserved=$rows[0].live_leases;providerRequests=0;databaseWrites=0;operatingChanges=0}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_OCTOBER16_DEPLOYMENT_VERIFICATION_FAILED';stage=$stage;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($headers){$headers.Clear()};$headers=$null;$context=$null;$live=$null;$response=$null;$data=$null}
