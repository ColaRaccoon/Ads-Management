# Synthetic graph responses only. This script performs no HTTP or protected reads.
. "$PSScriptRoot/scheduler-live-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$pins=Invoke-Phase08SchedulerNode @{action='pins'}
$catalog=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"한글":"full"}'))
$ctx=[pscustomobject]@{env=[pscustomobject]@{PHASE08_ACTIVATED='false';DAILY_SYNC_CAFE24_SCHEDULED_BOOTSTRAP_ENABLED='false';INTERNAL_PROBE_TOKEN='SYNTHETIC_ONLY';PHASE08_META_CATALOG_JSON_B64=$catalog;PHASE08_META_REPORT_SCHEMA_JSON_B64=$catalog}}
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'scheduler-live-helpers.ps1'))
$line=($source -split "`n"|Where-Object {$_ -match '^ \$reviewed=@'})
$reviewed=Invoke-Expression ($line.Trim().Replace('$reviewed=',''))
$vars=@{};foreach($key in $reviewed.Keys){$vars[$key]=$reviewed[$key]}
$vars.PHASE08_SOURCE_CONTENT_SHA256=$pins.sourceSha;$vars.PHASE08_VERIFIED_ORIGIN=$pins.identity.origin
$vars.DAILY_SYNC_FEATURE_ENABLED='true';$vars.DAILY_SYNC_SCHEDULE_ENABLED='false';$vars.DAILY_SYNC_SCHEDULES='[]'
$vars.DAILY_SYNC_ALLOWED_ACCOUNTS='["GOOGLE/1391592099/default","META/2138525300002203/default","CAFE24/didadi0729/shop1"]'
$vars.INTERNAL_PROBE_TOKEN='SYNTHETIC_ONLY';$vars.PHASE08_META_CATALOG_JSON_B64=$catalog;$vars.PHASE08_META_REPORT_SCHEMA_JSON_B64=$catalog
$fixture=@{variables=$vars;project=@{id=$pins.identity.projectId;services=@{edges=@(@{node=@{id=$pins.identity.serviceId}})}};serviceInstance=@{serviceId=$pins.identity.serviceId;environmentId=$pins.identity.environmentId;startCommand='node deploy/cloud/phase08-launch.mjs';sleepApplication=$true;latestDeployment=@{id=$pins.deploymentId;status='SUCCESS'};activeDeployments=@(@{id=$pins.deploymentId;status='SUCCESS'})}}
function Invoke-Phase08SchedulerGraph {return $fixture}
$result=Get-Phase08SchedulerGraphState $ctx $pins
if($result.appSchedules.Count -ne 0 -or $result.scheduleEnabled){throw 'empty-array'}
$count=1
foreach($test in @('CAFE','METADATA','IMMUTABLE','SERVICE')) {
 $clone=$fixture|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json -AsHashtable -DateKind String
 $original=$fixture;$fixture=$clone
 switch($test){'CAFE'{$fixture.variables.DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED='false'}'METADATA'{$fixture.variables.PHASE08_META_CATALOG_JSON_B64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{}'))}'IMMUTABLE'{$fixture.variables.INTERNAL_PROBE_TOKEN='SYNTHETIC_FOREIGN'}'SERVICE'{$fixture.serviceInstance.serviceId='foreign'}}
 $rejected=$false;try{$null=Get-Phase08SchedulerGraphState $ctx $pins}catch{$rejected=$true};$fixture=$original
 if(-not $rejected){throw 'boundary-not-rejected'};$count++
}
@{state='PHASE08_SCHEDULER_GRAPH_SYNTHETIC_PASS';cases=$count;networkCalls=0;protectedReads=0}|ConvertTo-Json -Compress
