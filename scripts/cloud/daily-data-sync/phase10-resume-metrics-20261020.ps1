Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261020'
$load=Get-Content (Join-Path $root 'light-load.json') -Raw|ConvertFrom-Json -AsHashtable -DateKind String
$ready=Get-Content (Join-Path $root 'ready.json') -Raw|ConvertFrom-Json -AsHashtable
if($load.deploymentId -cne $ready.deploymentId -or $load.sourceSha -cne $ready.source -or -not $load.loadStartedAt -or -not $load.loadFinishedAt){throw 'METRICS_LOAD_BINDING'}
$path=Join-Path $root 'railway-load-metrics.json';if(Test-Path $path){throw 'METRICS_ALREADY_READ'}
$start=[DateTimeOffset]::Parse($load.loadStartedAt).AddMinutes(-1).ToString('o');$end=[DateTimeOffset]::Parse($load.loadFinishedAt).AddMinutes(1).ToString('o')
$success=$false;$metrics=@()
try{
 $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!,$from:DateTime!,$to:DateTime!){metrics(projectId:$p,environmentId:$e,serviceId:$s,startDate:$from,endDate:$to,measurements:[CPU_USAGE,MEMORY_USAGE_GB,MEMORY_LIMIT_GB],sampleRateSeconds:5,averagingWindowSeconds:5){measurement values{ts value}}}' @{p=$script:IncidentScope.p;e=$script:IncidentScope.e;s=$script:IncidentScope.s;from=$start;to=$end}
 $metrics=@($r.metrics);$success=$true
}catch{}
$out=@{kind='BOUNDED_CANDIDATE_PLATFORM_METRICS';at=[DateTimeOffset]::UtcNow.ToString('o');deployment=$ready.deploymentId;serviceId=$script:IncidentScope.s;scope='EXACT_ISOLATED_SERVICE_NOT_DEPLOYMENT_DIMENSION';windowStart=$start;windowEnd=$end;loadStart=$load.loadStartedAt;loadEnd=$load.loadFinishedAt;requestedSampleSeconds=5;requestSucceeded=$success;series=$metrics;rawLogsSaved=0;remoteMutations=0;oomMetricAvailable=$false;rssMetricAvailable=$false;limits=@('platform memory usage is not process RSS','service-level window includes one minute around load and may include startup or restoration','empty or delayed series do not prove zero resource use or no OOM','no monthly or mixed-collection extrapolation')}
$f=[IO.File]::Open($path,[IO.FileMode]::CreateNew);try{$f.Write([Text.Encoding]::UTF8.GetBytes(($out|ConvertTo-Json -Depth 12)))}finally{$f.Dispose()}
@{kind=$out.kind;requestSucceeded=$success;series=$metrics.Count;samples=@($metrics|ForEach-Object{$_.values}|ForEach-Object{$_}).Count;rawValuesReturned=0}|ConvertTo-Json -Compress
