Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$context=$null;$live=$null;$stage='IDENTITY'
try{
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $null=Get-Phase08SchedulerGraphState $context $pins
 $reply=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' @{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}
 $live=$reply.variables;$reply=$null
 $output='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/cafe-items-actual-20261015.json'
 if(Test-Path -LiteralPath $output){throw 'existing-summary'}
 $private=Get-Phase08ProtectedPaths;Assert-Phase08PrivatePath -Path $private.Root -Directory
 $stage='ATTEMPT_MARKER';$path=Join-Path $private.Root 'cafe-items-attempt-20261015.json'
 $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes((@{classification='MANUAL_DIAGNOSTIC';day='2026-10-14';startedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 Set-Phase08NewPrivateAcl -Path $path
 $stage='PROTECTED_DIAGNOSTIC'
 $out=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'cafe-items-result.mjs') @{projectRef='ehnfrrmbkvlsbpvqcvkr';databaseUrl=$context.env.DATABASE_URL;env=$live;classification='MANUAL_DIAGNOSTIC'}
 if($out.state -cne 'PHASE08_CAFE_ITEM_RESULT_RETURNED' -or $out.success -isnot [bool]){throw 'probe-result'}
 $stage='SAFE_SUMMARY';$null=Write-Phase08SchedulerPublicEvidence $out $output
 $out|ConvertTo-Json -Compress -Depth 10
 if(-not $out.success){exit 1}
}catch{@{state='PHASE08_CAFE_ITEMS_EXECUTION_FAILED';stage=$stage;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$live=$null;$out=$null}
