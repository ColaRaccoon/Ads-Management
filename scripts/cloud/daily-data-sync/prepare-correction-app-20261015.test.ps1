Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/prepare-correction-app-20261015.ps1"
$context=[pscustomobject]@{projectRef='ehnfrrmbkvlsbpvqcvkr';serviceId='4b30daa8-9333-46b7-ad89-cfd64ff5266c';origin='https://phase08-daily-data-sync-production.up.railway.app'}
$pins=@{sourceSha='ee9b9bdf8b6a5c67b2e7f12f678dba63004a82126c1d4086da2bf6fcccd4c25d';deploymentId='e71e73ea-838f-45d3-a19d-32033d3d7391'}
$defs=@(@{key='phase08-cafe24';connectionId='0c35defe-45fc-4a54-bc79-704df7bca5b1';anchorAt='2026-10-15T01:00:00.000Z';windowMinutes=110},@{key='phase08-google';connectionId='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900';anchorAt='2026-10-15T01:01:00.000Z';windowMinutes=90},@{key='phase08-meta';connectionId='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6';anchorAt='2026-10-15T01:02:00.000Z';windowMinutes=90})
$initial=@{SUPABASE_DATABASE_PROJECT_REF='ehnfrrmbkvlsbpvqcvkr';SUPABASE_DATABASE_SCHEMA='phase08_meta_ads';SUPABASE_DATABASE_RUNTIME_USER='phase08_runtime';RUNTIME_API_TARGET_ID='phase08-full-app';PHASE08_VERIFIED_ORIGIN=$context.origin;PHASE08_ACTIVATED='true';DAILY_SYNC_FEATURE_ENABLED='true';DAILY_SYNC_SCHEDULE_ENABLED='true';PHASE08_SOURCE_CONTENT_SHA256=$pins.sourceSha;DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES='["C40","C48","E00","N30","N40","R00","R30","R40"]';DAILY_SYNC_ALLOWED_ACCOUNTS='["GOOGLE/1391592099/default","META/2138525300002203/default","CAFE24/didadi0729/shop1"]';DAILY_SYNC_SCHEDULES=($defs|ConvertTo-Json -Depth 10 -Compress);PRIVATE='SYNTHETIC_PRIVATE_NOT_OUTPUT'}
$script:changes=0;$script:tamper=$false;$script:vars=$initial.Clone()
$railway={param($query,$variables)
 if($query.StartsWith('mutation')){if($variables.input.serviceId -cne $context.serviceId -or $variables.input.skipDeploys -isnot [bool] -or -not $variables.input.skipDeploys -or $variables.input.ContainsKey('replace') -or $variables.input.variables.Count -ne 2){throw 'mutation-scope'};$script:changes++;foreach($key in $variables.input.variables.Keys){$script:vars[$key]=$variables.input.variables[$key]};if($script:tamper){$script:vars.PRIVATE='SYNTHETIC_CHANGED'};return @{variableCollectionUpsert=$true}}
 return @{variables=$script:vars.Clone();serviceInstance=@{serviceId=$context.serviceId;environmentId='d261a432-a6a4-4031-b8ea-c619ac263cc3';startCommand='node deploy/cloud/phase08-launch.mjs';sleepApplication=$true;latestDeployment=@{id=$pins.deploymentId;status='SUCCESS'};activeDeployments=@(@{id=$pins.deploymentId;status='SUCCESS'})}}
}
$good=Invoke-Phase08CorrectionApp Prepare $context $pins $railway
if($script:changes -ne 1 -or $good.changedVariableCount -ne 2 -or -not $good.otherVariablesPreserved -or $good.deploymentStarted -or -not $good.requiresReviewedCliUp -or ($good|ConvertTo-Json -Compress).Contains('PRIVATE')){throw 'prepare'}
$status=Invoke-Phase08CorrectionApp Status $context $pins $railway;if($script:changes -ne 1 -or $status.changedVariableCount -ne 0){throw 'status'}
$rejected=$false;try{$null=Invoke-Phase08CorrectionApp Prepare $context $pins $railway}catch{$rejected=$true};if(-not $rejected -or $script:changes -ne 1){throw 'duplicate'}
$script:vars=$initial.Clone();$script:vars.SUPABASE_DATABASE_SCHEMA='FOREIGN';$rejected=$false;try{$null=Invoke-Phase08CorrectionApp Prepare $context $pins $railway}catch{$rejected=$true};if(-not $rejected -or $script:changes -ne 1){throw 'foreign'}
$script:vars=$initial.Clone();$script:tamper=$true;$rejected=$false;try{$null=Invoke-Phase08CorrectionApp Prepare $context $pins $railway}catch{$rejected=$true};if(-not $rejected -or $script:changes -ne 2){throw 'preservation'}
@{state='PHASE08_CORRECTION_CONFIGURATION_SYNTHETIC_PASS';cases=5;actualNetwork=0;protectedReads=0}|ConvertTo-Json -Compress
