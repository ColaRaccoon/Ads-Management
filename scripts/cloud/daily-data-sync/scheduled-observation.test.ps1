Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/scheduled-observation-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$pins=Invoke-Phase08SchedulerNode @{action='pins'}
$context=[pscustomobject]@{projectRef=$pins.identity.projectRef;serviceId=$pins.identity.serviceId;origin=$pins.identity.origin;env=[pscustomobject]@{SUPABASE_DATABASE_SCHEMA='phase08_meta_ads';SUPABASE_DATABASE_RUNTIME_USER='phase08_runtime';RUNTIME_API_TARGET_ID='phase08-full-app';DAILY_SYNC_MACHINE_TOKEN='SYNTHETIC_TOKEN_ONLY_1234567890';INTERNAL_PROBE_TOKEN='SYNTHETIC_PROBE_ONLY_1234567890'}}
$future=[DateTimeOffset]::UtcNow.AddDays(2).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$defs=@(@{key='phase08-cafe24';anchorAt=$future},@{key='phase08-google';anchorAt=$future},@{key='phase08-meta';anchorAt=$future})
$body=@{scheduleKey='phase08-cafe24';scheduledFor=$future};$script:httpCalls=0;$script:noStore=$true;$script:responseBody='{"code":"RUN_LIMIT_EXCEEDED"}'
function Invoke-WebRequest {
 param($Uri,$Method,$Headers,$ContentType,$Body,$MaximumRedirection,$TimeoutSec,[switch]$SkipHttpErrorCheck)
 if($Uri -cne ($pins.identity.origin+'/backend-api/internal/daily-sync/status') -or $MaximumRedirection -ne 0 -or $TimeoutSec -ne 45){throw 'fixed-request'}
 $script:httpCalls++;return [pscustomobject]@{StatusCode=400;Content=$script:responseBody;Headers=@{'Cache-Control'=if($script:noStore){'no-store, private'}else{'public'}}}
}
function TryProbe {Invoke-Phase08FutureHttp $context $pins $defs '/backend-api/internal/daily-sync/status' @{} $body 400 'RUN_LIMIT_EXCEEDED'}
$okay=TryProbe;if($okay.code -cne 'RUN_LIMIT_EXCEEDED'){throw 'future-http'}
$cases=1
foreach($bad in @('near','bodypast','path','cache','token','base64')) {
 $savedDefs=$defs;$savedBody=$body;$savedContent=$script:responseBody
 switch($bad){'near'{$defs=@(@{anchorAt=[DateTimeOffset]::UtcNow.ToString('o')},$defs[1],$defs[2])}'bodypast'{$body=@{scheduleKey='phase08-cafe24';scheduledFor='2020-01-01T00:00:00.000Z'}}'cache'{$script:noStore=$false}'token'{$script:responseBody='{"code":"RUN_LIMIT_EXCEEDED","extra":"'+$context.env.DAILY_SYNC_MACHINE_TOKEN+'"}'}'base64'{$script:responseBody='{"code":"RUN_LIMIT_EXCEEDED","extra":"'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($context.env.INTERNAL_PROBE_TOKEN))+'"}'}}
 $rejected=$false;try{if($bad -ceq 'path'){$null=Invoke-Phase08FutureHttp $context $pins $defs '/backend-api/foreign' @{} $body 400 'RUN_LIMIT_EXCEEDED'}else{$null=TryProbe}}catch{$rejected=$true}
 if(-not $rejected){throw 'boundary-not-rejected'};$cases++;$defs=$savedDefs;$body=$savedBody;$script:responseBody=$savedContent;$script:noStore=$true
}
function Invoke-Phase08Management {return [pscustomobject]$script:countFixture}
$script:countFixture=@{runs=0;units=0;coverage=0;leases=0;checkpoints=0;attempts=0};$null=Get-Phase08ProbeCounts;$cases++
foreach($bad in @('0',$false,1)){$script:countFixture.runs=$bad;$rejected=$false;try{$null=Get-Phase08ProbeCounts}catch{$rejected=$true};if(-not $rejected){throw 'counts-type'};$cases++}
foreach($file in @('scheduled-observation-helpers.ps1','probe-scheduled-http.ps1','observe-scheduler.ps1')){$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$t,[ref]$e);if($e.Count){throw 'syntax'}}
@{state='PHASE08_SCHEDULED_PROBE_SYNTHETIC_PASS';cases=$cases;actualNetworkCalls=0;actualProtectedReads=0}|ConvertTo-Json -Compress

