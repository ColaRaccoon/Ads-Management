param([ValidateSet('Prepare','Status')][string]$Mode='Prepare',[string]$OutputPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
function Get-Phase08CorrectionDigest($Variables){
 if($Variables -isnot [Collections.IDictionary]){throw 'variables-type'}
 $names=[string[]]@($Variables.Keys|Where-Object {$_ -cnotin @('PHASE08_SOURCE_CONTENT_SHA256','DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES')});[Array]::Sort($names,[StringComparer]::Ordinal)
 $ordered=[ordered]@{};$bytes=0
 foreach($key in $names){if($Variables[$key] -isnot [string]){throw 'variables-type'};$ordered[$key]=$Variables[$key];$bytes+=[Text.Encoding]::UTF8.GetByteCount($Variables[$key])}
 $buffer=[Text.Encoding]::UTF8.GetBytes(($ordered|ConvertTo-Json -Depth 30 -Compress));try{$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($buffer)).ToLowerInvariant()}finally{[Array]::Clear($buffer)}
 return @{sha256=$hash;variables=$names.Count;valueBytes=$bytes}
}
function Assert-Phase08CorrectionManifest {
 $root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261015-v9';$path=Join-Path $root 'source-content-manifest.json';$file=Get-Item -LiteralPath $path
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 1048576){throw 'manifest-file'}
 $manifest=[IO.File]::ReadAllText($path)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 20
 if($manifest.sourceContentSha256 -cne 'a986132a8f70757ca67ae93b54ce378926166da30ec9817378f206062e214097' -or $manifest.files.Count -ne 472 -or $manifest.secretsIncluded -isnot [bool] -or $manifest.secretsIncluded){throw 'manifest'}
 $manifestBytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $manifest.files -Depth 10 -Compress));try{$actualSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($manifestBytes)).ToLowerInvariant()}finally{[Array]::Clear($manifestBytes)};if($actualSha -cne $manifest.sourceContentSha256){throw 'manifest-fingerprint'}
 foreach($entry in $manifest.files){$target=[IO.Path]::GetFullPath((Join-Path $root $entry.name));if(-not $target.StartsWith([IO.Path]::GetFullPath($root)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'manifest-path'};$item=Get-Item -LiteralPath $target;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne $entry.size -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256){throw 'manifest-bytes'}}
 return @{sourceSha=$manifest.sourceContentSha256;files=472;secretsIncluded=$false}
}
function Invoke-Phase08CorrectionApp([string]$Mode,$Context,$Pins,[scriptblock]$Railway){
 $before=$null;$after=$null;$values=$null
 try{
  $old='ee9b9bdf8b6a5c67b2e7f12f678dba63004a82126c1d4086da2bf6fcccd4c25d';$new='a986132a8f70757ca67ae93b54ce378926166da30ec9817378f206062e214097';$oldStatuses='["C40","C48","E00","N30","N40","R00","R30","R40"]';$newStatuses='["C40","C48","E00","N00","N30","N40","R00","R30","R40"]'
  if($Mode -cnotin @('Prepare','Status') -or $Context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $Context.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or $Context.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app' -or $Pins.sourceSha -cnotin @($old,$new) -or ($Mode -ceq 'Prepare' -and ($Pins.sourceSha -cne $old -or $Pins.deploymentId -cne 'e71e73ea-838f-45d3-a19d-32033d3d7391'))){throw 'pins'}
  $scope=@{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s=$Context.serviceId}
  $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status} activeDeployments{id status}}}'
  $assert={param($data,$expectedSource,$expectedStatuses)
   $svc=$data.serviceInstance;$vars=$data.variables
   if($vars -isnot [Collections.IDictionary] -or $svc.serviceId -cne $scope.s -or $svc.environmentId -cne $scope.e -or $svc.startCommand -cne 'node deploy/cloud/phase08-launch.mjs' -or $svc.sleepApplication -isnot [bool] -or -not $svc.sleepApplication -or $svc.latestDeployment.id -cne $Pins.deploymentId -or $svc.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or @($svc.activeDeployments).Count -ne 1 -or $svc.activeDeployments[0].id -cne $Pins.deploymentId -or $svc.activeDeployments[0].status -cnotin @('SUCCESS','SLEEPING') -or
    $vars.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr' -or $vars.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $vars.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or $vars.RUNTIME_API_TARGET_ID -cne 'phase08-full-app' -or $vars.PHASE08_VERIFIED_ORIGIN -cne $Context.origin -or $vars.PHASE08_ACTIVATED -cne 'true' -or $vars.DAILY_SYNC_FEATURE_ENABLED -cne 'true' -or $vars.DAILY_SYNC_SCHEDULE_ENABLED -cne 'true' -or $vars.PHASE08_SOURCE_CONTENT_SHA256 -cne $expectedSource -or $vars.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES -cne $expectedStatuses -or $vars.DAILY_SYNC_ALLOWED_ACCOUNTS -cne '["GOOGLE/1391592099/default","META/2138525300002203/default","CAFE24/didadi0729/shop1"]'){throw 'current-identity'}
   $defs=$vars.DAILY_SYNC_SCHEDULES|ConvertFrom-Json -AsHashtable -DateKind String -Depth 10 -NoEnumerate
   if($defs -isnot [array] -or $defs.Count -ne 3){throw 'loaded'}
   $expected=@(@('phase08-cafe24','0c35defe-45fc-4a54-bc79-704df7bca5b1','2026-10-15T01:00:00.000Z',110),@('phase08-google','b9ebee4b-5d4e-4eae-92b9-9facfbf3c900','2026-10-15T01:01:00.000Z',90),@('phase08-meta','1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6','2026-10-15T01:02:00.000Z',90))
   foreach($row in $expected){if(@($defs|Where-Object {$_.key -ceq $row[0] -and $_.connectionId -ceq $row[1] -and $_.anchorAt -ceq $row[2] -and ($_.windowMinutes -is [int] -or $_.windowMinutes -is [long]) -and $_.windowMinutes -eq $row[3]}).Count -ne 1){throw 'loaded'}}
  }
  $before=&$Railway $query $scope
  &$assert $before $(if($Mode -ceq 'Prepare'){$old}else{$new}) $(if($Mode -ceq 'Prepare'){$oldStatuses}else{$newStatuses})
  $digest=Get-Phase08CorrectionDigest $before.variables
  if($Mode -ceq 'Prepare'){
   $values=@{PHASE08_SOURCE_CONTENT_SHA256=$new;DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES=$newStatuses}
   $result=&$Railway 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$scope.p;environmentId=$scope.e;serviceId=$scope.s;skipDeploys=$true;variables=$values}}
   if($result.variableCollectionUpsert -isnot [bool] -or -not $result.variableCollectionUpsert){throw 'uncertain-no-retry'}
   $after=&$Railway $query $scope
  }else{$after=$before}
  &$assert $after $new $newStatuses
  $checked=Get-Phase08CorrectionDigest $after.variables
  if($before.variables.Count -ne $after.variables.Count -or $digest.sha256 -cne $checked.sha256 -or $digest.valueBytes -ne $checked.valueBytes -or $digest.variables -ne $checked.variables){throw 'preservation'}
  return @{state='PHASE08_CORRECTION_CONFIGURATION_PREPARED';mode=$Mode;sourceSha=$new;files=472;secretsIncluded=$false;changedVariableCount=if($Mode -ceq 'Prepare'){2}else{0};otherVariableCount=$checked.variables;otherVariableBytes=$checked.valueBytes;otherVariablesPreserved=$true;deploymentStarted=$false;requiresReviewedCliUp=($Mode -ceq 'Prepare');providerRequests=0;operatingChanges=0}
 }finally{if($values){$values.Clear()};$before=$null;$after=$null;$values=$null;$result=$null}
}
if($MyInvocation.InvocationName -cne '.'){
 $stage='MANIFEST';$context=$null
 try{
  $manifest=Assert-Phase08CorrectionManifest;$path=Assert-Phase08SchedulerOutputPath $OutputPath;Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
  if($Mode -ceq 'Prepare'){$stage='V8_IMMUTABLE';$null=Get-Phase08SchedulerGraphState $context $pins}
  $stage='CONFIGURATION';$summary=Invoke-Phase08CorrectionApp $Mode $context $pins {param($query,$variables)Invoke-Phase08SchedulerGraph $query $variables}
  $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $summary $path
  $summary|ConvertTo-Json -Compress
 }catch{@{state='PHASE08_CORRECTION_CONFIGURATION_FAILED';stage=$stage;outcomeUncertain=($stage -ceq 'CONFIGURATION');rawErrorSuppressed=$true;retryPerformed=$false}|ConvertTo-Json -Compress;exit 1}
 finally{$context=$null;$summary=$null;$manifest=$null}
}
