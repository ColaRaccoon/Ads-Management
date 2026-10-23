Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/run-meta-manual-oct8-v12-r3.ps1"
$script:checks=0
function Assert($x){$script:checks++;if(-not $x){throw 'synthetic-assert'}}
function Reject([scriptblock]$Code){$failed=$false;try{&$Code|Out-Null}catch{$failed=$true};Assert $failed}
$planRaw=& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'run-meta-manual-oct8-v12-r3.ps1') -Mode Plan
$plan=$planRaw|ConvertFrom-Json -AsHashtable;Assert ($LASTEXITCODE -eq 0 -and $plan.state -ceq 'PHASE08_MANUAL_META_PLAN' -and $plan.remoteChanges -eq 0)
Import-Phase08SchedulerChildDefinitions;Assert ($null -ne (Get-Command Invoke-Phase08ConfigurationChild -CommandType Function))
Assert-Phase08ManualMetaV12R3Permissions @{user=@{id='synthetic';role='SUPER_ADMIN'};permissions=@('settings.manage','imports.manage','data.read');authorizationVersion=1}
Reject {Assert-Phase08ManualMetaV12R3Permissions @{user=@{permissions=@('imports.manage','data.read')};authorizationVersion=1}}
$graph=@{featureEnabled=$true;appSchedules=@(@{key='phase08-cafe24';connectionId='0c35defe-45fc-4a54-bc79-704df7bca5b1';anchorAt='2026-10-14T17:00:00.000Z';windowMinutes=110},@{key='phase08-google';connectionId='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900';anchorAt='2026-10-14T17:01:00.000Z';windowMinutes=90},@{key='phase08-meta';connectionId='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6';anchorAt='2026-10-14T17:02:00.000Z';windowMinutes=90})}
Assert-Phase08ManualMetaV12R3Graph $graph
$graph.appSchedules[0].provider='CAFE24';Reject {Assert-Phase08ManualMetaV12R3Graph $graph};$graph.appSchedules[0].Remove('provider')
$dto=Get-Phase08ManualMetaV12R3Dto;Assert ($dto.mode -ceq 'MANUAL' -and $dto.fromDate -ceq '2026-10-08' -and $dto.toDate -ceq '2026-10-08' -and $dto.Count -eq 6)
$r=@{database='postgres';principal='postgres';tables=68;stopped=$true;paused=$true;active_jobs=149;source_ready=$true;policies_ready=$true;active_leases=0;original_expected=$true;prior_manual_expected=$true;prior_sin_expected=$true;frozen_digest=('a'*32);manual_count=0;manual_id=$null;manual_status=$null;manual_scope=$false;manual_units=0;manual_unit_status=$null;user_queue_audits=0;ad_rows=0;adset_rows=0;valid_ad_links=0;valid_adset_links=0;complete_kinds=0;extra='SYNTHETIC_PRIVATE'}
$safe=Assert-Phase08ManualMetaV12R3Snapshot @($r) BEFORE;Assert ($safe.Count -eq 4 -and -not (($safe|ConvertTo-Json -Compress).Contains('PRIVATE')))
foreach($change in @(@{active_leases=1},@{original_expected=$false},@{ad_rows='0'},@{paused='true'},@{manual_count=1})){$bad=$r.Clone();foreach($k in $change.Keys){$bad[$k]=$change[$k]};Reject {Assert-Phase08ManualMetaV12R3Snapshot @($bad) BEFORE}}
$after=$r.Clone();$after.manual_count=1;$after.manual_id='11111111-1111-4111-8111-111111111111';$after.manual_status='SUCCEEDED';$after.manual_scope=$true;$after.manual_units=1;$after.manual_unit_status='SUCCEEDED';$after.user_queue_audits=1;$after.ad_rows=55;$after.adset_rows=13;$after.valid_ad_links=55;$after.valid_adset_links=13;$after.complete_kinds=2
$null=Assert-Phase08ManualMetaV12R3Snapshot @($after) AFTER;$after.valid_ad_links=54;Reject {Assert-Phase08ManualMetaV12R3Snapshot @($after) AFTER}
$context=@{origin='https://phase08-daily-data-sync-production.up.railway.app'};$script:httpCalls=0;$script:bad=$false
function Invoke-WebRequest {param($Uri,$Method,$Headers,$WebSession,$ContentType,$Body,$MaximumRedirection,$TimeoutSec,[switch]$SkipHttpErrorCheck)
 $script:httpCalls++;Assert ($Method -ceq 'Post' -and $MaximumRedirection -eq 0 -and $TimeoutSec -eq 90 -and $SkipHttpErrorCheck)
 $b=$Body|ConvertFrom-Json -AsHashtable
 if($Uri.EndsWith('/sync-runs')){Assert ($b.Count -eq 6 -and $b.mode -ceq 'MANUAL' -and $b.fromDate -ceq $b.toDate);$out=@{id='11111111-1111-4111-8111-111111111111';connectionId=$dto.connectionId;trigger='MANUAL';fromDate='2026-10-08T00:00:00.000Z';toDate='2026-10-08T00:00:00.000Z';status='QUEUED';requestKey=$dto.requestKey};$status=202}else{Assert ($Uri -ceq ($context.origin+'/backend-api/sync-runs/11111111-1111-4111-8111-111111111111/execute-meta') -and $b.Count -eq 0);$out=@{id='11111111-1111-4111-8111-111111111111';status='SUCCEEDED';rowsFetched=68;rowsPublished=68;safeErrorCode=$null};$status=200}
 if($script:bad){$out.status='SYNTHETIC_PRIVATE'}
 return @{StatusCode=$status;Headers=@{'Cache-Control'='no-store, private'};Content=($out|ConvertTo-Json -Compress)}
}
$null=Invoke-Phase08ManualMetaV12R3Http QUEUE '' $context $null @{};$null=Invoke-Phase08ManualMetaV12R3Http EXECUTE '11111111-1111-4111-8111-111111111111' $context $null @{};Assert ($script:httpCalls -eq 2)
$script:bad=$true;Reject {Invoke-Phase08ManualMetaV12R3Http QUEUE '' $context $null @{}};Reject {Invoke-Phase08ManualMetaV12R3Http EXECUTE 'foreign' $context $null @{}};Assert ($script:httpCalls -eq 3)
$sql=Get-Phase08ManualMetaV12R3SnapshotSql '11111111-1111-4111-8111-111111111111';Assert ($sql.StartsWith('BEGIN READ ONLY') -and $sql.Contains("attempts=2") -and $sql.Contains("from_date='2026-10-08' AND to_date='2026-10-14'") -and -not ($sql -cmatch '(?m)^\s*(UPDATE|INSERT|DELETE) '))
@{state='SYNTHETIC_MANUAL_META_HELPER_PASS';checks=$script:checks;network=0;credentials=0;providerRequests=0}|ConvertTo-Json -Compress

$region=@{deployment=@{id='11111111-1111-4111-8111-111111111111';status='SUCCESS';meta=@{serviceManifest=@{deploy=@{multiRegionConfig=@{sin=@{numReplicas=[long]1}}}}}}}
Assert-Phase08ManualMetaV12R3RegionValue $region '11111111-1111-4111-8111-111111111111'
$region.deployment.meta.serviceManifest.deploy.multiRegionConfig=@{sfo=@{numReplicas=1}};Reject {Assert-Phase08ManualMetaV12R3RegionValue $region '11111111-1111-4111-8111-111111111111'}
$region.deployment.meta.serviceManifest.deploy.multiRegionConfig=@{sin=@{numReplicas='1'}};Reject {Assert-Phase08ManualMetaV12R3RegionValue $region '11111111-1111-4111-8111-111111111111'}
$region.deployment.meta.serviceManifest.deploy.multiRegionConfig=@{sin=@{numReplicas=1};sfo=@{numReplicas=1}};Reject {Assert-Phase08ManualMetaV12R3RegionValue $region '11111111-1111-4111-8111-111111111111'}
Reject {Assert-Phase08ManualMetaV12R3Region @{deploymentId='11111111-1111-4111-8111-111111111111'}}
Assert ((Get-Phase08ManualMetaV12R3Dto).requestKey -ceq 'phase08-manual-meta-20261008-v12-r3-20261015')
Assert ($sql.Contains('priorManualUnits') -and $sql.Contains('prior_manual_expected'))
@{state='PHASE08_META_SIN_HELPER_SYNTHETIC_PASS';assertions=$script:checks;remoteCalls=0;providerCalls=0}|ConvertTo-Json -Compress
