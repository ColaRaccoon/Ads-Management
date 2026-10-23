# Read-only verification of an immutable-source v11 build using current Singapore config.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$stage='ACTUAL_DEPLOYMENT';$variables=$null;$context=$null;$headers=$null;$response=$null
try {
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/region-sin-build-verified-actual-20261015.json'
 $ids=@{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
 $new='a35d7507-2044-41f5-9f91-fd4838ad0d28';$old='86d5ad6d-eec8-414a-a922-9c6b8c62a245'
 $service=(Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status} activeDeployments{id status}}}' @{e=$ids.e;s=$ids.s}).serviceInstance
 if($service.serviceId -cne $ids.s -or $service.environmentId -cne $ids.e -or $service.startCommand -cne 'node deploy/cloud/phase08-launch.mjs' -or $service.sleepApplication -isnot [bool] -or -not $service.sleepApplication -or $service.latestDeployment.id -cne $new -or $service.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or @($service.activeDeployments).Count -ne 1 -or $service.activeDeployments[0].id -cne $new -or $service.activeDeployments[0].status -cnotin @('SUCCESS','SLEEPING')){throw 'deployment'}
 $variables=(Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' $ids).variables
 $query='query($d:String!){deployment(id:$d){id status meta}}'
 $previous=(Invoke-Phase08SchedulerGraph $query @{d=$old}).deployment
 $current=(Invoke-Phase08SchedulerGraph $query @{d=$new}).deployment
 if($current.meta.imageDigest -isnot [string] -or $current.meta.imageDigest -cnotmatch '^sha256:[a-f0-9]{64}$' -or $current.status -cnotin @('SUCCESS','SLEEPING')){throw 'image'}
 $stage='ONLY_REGION_CHANGED'
 $before=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'region-relocation-material.mjs') @{region='sfo';deploy=$previous.meta.serviceManifest.deploy;variables=$variables}
 $after=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'region-relocation-material.mjs') @{region='sin';deploy=$current.meta.serviceManifest.deploy;variables=$variables}
 if($before.state -cne 'PHASE08_REGION_MATERIAL_VERIFIED' -or $after.state -cne 'PHASE08_REGION_MATERIAL_VERIFIED' -or $after.variablesSha -cne '918fa6dc347fada269c0d6f0cc98de23018bd6f64d2d9149f1735880092b02d8' -or $before.deploySha -cne '216444c00c49daea1e60005d7e1374f6cb39c29b77926e5d5daf95a542ea4722' -or $after.deployWithoutRegionSha -cne '567afab5f1d2bcdc5269190a91725a45006d21ec9af4bde695f3ff11dc9f62a9' -or $before.deployWithoutRegionSha -cne $after.deployWithoutRegionSha -or $after.variableCount -ne 101){throw 'preservation'}
 $stage='IMMUTABLE_SOURCE_BYTES'
 $root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261015-v11'
 $manifest=Get-Content -Raw -LiteralPath (Join-Path $root 'source-content-manifest.json')|ConvertFrom-Json -AsHashtable -DateKind String
 $manifestBytes=[Text.Encoding]::UTF8.GetBytes(($manifest.files|ConvertTo-Json -Depth 10 -Compress))
 if($manifest.sourceContentSha256 -cne '0368163a964e94086ef77ca644a6bf3d0be2ec6cfe12523cb136ec5ac02cd9fa' -or $manifest.files.Count -ne 474 -or $manifest.secretsIncluded -isnot [bool] -or $manifest.secretsIncluded -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($manifestBytes)).ToLowerInvariant() -cne $manifest.sourceContentSha256){throw 'manifest'}
 foreach($file in $manifest.files){if($file.name -isnot [string] -or $file.name -cnotmatch '^[A-Za-z0-9_./-]+$' -or $file.name.Contains('..') -or $file.name.StartsWith('/')){throw 'source-path'};$item=Get-Item -LiteralPath (Join-Path $root $file.name);if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256){throw 'source-bytes'}}
 $stage='PROTECTED_READY_AND_ACTUAL_REGION'
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $headers=@{'x-internal-probe-token'=$context.env.INTERNAL_PROBE_TOKEN;'X-Railway-Debug'='1'}
 $response=Invoke-WebRequest -Uri ($pins.identity.origin+'/backend-api/health/ready') -Headers $headers -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
 $zone=[string]$response.Headers['X-Railway-Upstream-Zone']
 if([int]$response.StatusCode -ne 200 -or $response.Content.Length -gt 8192 -or [string]$response.Headers['Cache-Control'] -notmatch '(?i)(^|[,\s])no-store([,\s]|$)' -or $zone -cnotmatch '^railway/asia-southeast1(?:-(?:eqsg3a|drsin10a))?$'){throw 'region-ready'}
 $body=$response.Content|ConvertFrom-Json -AsHashtable -DateKind String
 if($body.status -cne 'ready' -or $body.releaseId -cne $pins.identity.releaseSha -or $body.runtimeConfigFingerprint -cne $pins.identity.readyFingerprint){throw 'ready'}
 $stage='PINNED_READONLY_SQL';$path=Join-Path $PSScriptRoot 'relocate-v11-singapore.ps1'
 if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne '63c29da0d3f01f5b7e3b1a22a2d95bc059ca73e928d3d978ddba58c67fd8ec7d'){throw 'source'}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
 $nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$sql'},$false))
 if($errors.Count -ne 0 -or $nodes.Count -ne 1 -or $nodes[0].Right -isnot [Management.Automation.Language.CommandExpressionAst] -or $nodes[0].Right.Expression -isnot [Management.Automation.Language.StringConstantExpressionAst]){throw 'literal'}
 $sql=$nodes[0].Right.Expression.SafeGetValue();if($sql -isnot [string] -or -not $sql.StartsWith('BEGIN READ ONLY;')){throw 'readonly'}
 $stage='DATA_AND_HISTORY';$rows=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($rows.Count -ne 1 -or $rows[0].database -cne 'postgres' -or $rows[0].principal -cne 'postgres' -or $rows[0].data_digest -cne '21a798d893a4c2a71778bcf0d287f944' -or $rows[0].ops_digest -cne '5057b489d66a10bcbbb5aa3d27381ebc'){throw 'data'}
 foreach($n in @('stopped','meta_paused','normal_anchors','failed_manual','failed_weekly')){if($rows[0].$n -isnot [bool] -or -not $rows[0].$n){throw 'gate'}}
 foreach($pair in @(@('tables',68),@('jobs',149),@('live_leases',0))){$n=$pair[0];if(($rows[0].$n -isnot [int] -and $rows[0].$n -isnot [long]) -or $rows[0].$n -ne $pair[1]){throw 'count'}}
 $out=@{state='PHASE08_SIN_IMMUTABLE_SOURCE_BUILD_VERIFIED';classification='ACTUAL_SAME_IMMUTABLE_SOURCE_NEW_BUILD_SIN';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$new;originalDeploymentId=$old;sourceSha='0368163a964e94086ef77ca644a6bf3d0be2ec6cfe12523cb136ec5ac02cd9fa';region='sin';upstreamZone=$zone;immutableSourceFilesVerified=474;sameImageVerified=($current.meta.imageDigest -ceq $previous.meta.imageDigest);onlyDeployRegionChanged=$true;all101VariablesPreserved=$true;all68TablesAndHistoryPreserved=$true;replicas=1;cpu=1;memoryBytes=1000000000;sleepApplication=$true;globalStopped=$true;metaPaused=$true;providerRequests=0;databaseWrites=0;operatingChanges=0}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_SIN_DEPLOYMENT_VERIFICATION_FAILED';stage=$stage;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($headers){$headers.Clear()};$variables=$null;$previous=$null;$current=$null;$context=$null;$headers=$null;$response=$null}
