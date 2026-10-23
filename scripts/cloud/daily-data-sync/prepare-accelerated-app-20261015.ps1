# Root-only user-approved isolated test, preserving every other live variable.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$context=$null;$live=$null;$before=$null;$after=$null
try {
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson
 Assert-Phase08SchedulerContext $context $pins
 $null=Get-Phase08SchedulerGraphState $context $pins
 if($pins.sourceSha -cne 'b361da10cf16c0955ca0dc8c51bff195f289d6e8c7aae934f81f030b42a68e81' -or $pins.deploymentId -cne 'b41e222d-8a18-47c9-81cc-e26132796cf8'){throw 'old-pins'}
 $ids=@{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}
 $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}'
 $before=(Invoke-Phase08SchedulerGraph $query $ids).variables
 $definitions=@($before.DAILY_SYNC_SCHEDULES|ConvertFrom-Json -AsHashtable -DateKind String)
 if($definitions.Count -ne 3){throw 'definitions'}
 $old=@('2026-10-14T17:00:00.000Z','2026-10-14T17:01:00.000Z','2026-10-14T17:02:00.000Z')
 $new=@('2026-10-15T01:00:00.000Z','2026-10-15T01:01:00.000Z','2026-10-15T01:02:00.000Z')
 $keys=@('phase08-cafe24','phase08-google','phase08-meta')
 $public=@()
 for($i=0;$i -lt 3;$i++){
  $row=@($definitions|Where-Object{$_.key -ceq $keys[$i]});if($row.Count -ne 1 -or $row[0].anchorAt -cne $old[$i]){throw 'old-anchor'}
  $row[0].anchorAt=$new[$i]
  $provider=@('CAFE24','GOOGLE','META')[$i]
  $public+=@{key=$row[0].key;connectionId=$row[0].connectionId;provider=$provider;timeZone='Asia/Seoul';anchorAt=$row[0].anchorAt;windowMinutes=$row[0].windowMinutes;targetId='phase08-full-app'}
 }
 $manifest=Get-Content -Raw -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261015-v8/source-content-manifest.json'|ConvertFrom-Json
 if($manifest.sourceContentSha256 -cne 'ee9b9bdf8b6a5c67b2e7f12f678dba63004a82126c1d4086da2bf6fcccd4c25d' -or $manifest.files.Count -ne 472 -or $manifest.secretsIncluded -ne $false){throw 'manifest'}
 if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-15T00:57:00Z'){throw 'deployment-cutoff'}
 $changed=@{PHASE08_SOURCE_CONTENT_SHA256=$manifest.sourceContentSha256;DAILY_SYNC_SCHEDULES=(ConvertTo-Json -InputObject $definitions -Compress -Depth 10)}
 $result=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$ids.p;environmentId=$ids.e;serviceId=$ids.s;variables=$changed;skipDeploys=$true}}
 if($result.variableCollectionUpsert -ne $true){throw 'mutation-outcome'}
 $after=(Invoke-Phase08SchedulerGraph $query $ids).variables
 if($after.Count -ne $before.Count){throw 'variable-count'}
 foreach($key in $before.Keys){$expected=if($changed.ContainsKey($key)){$changed[$key]}else{$before[$key]};if($after[$key] -cne $expected){throw 'preservation'}}
 $output='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/schedules-20261015-10am-v8.json'
 $null=Write-Phase08SchedulerPublicEvidence $public $output
 @{state='PHASE08_ACCELERATED_APP_VARIABLES_PREPARED';sourceSha=$manifest.sourceContentSha256;changedVariables=2;otherVariablesPreserved=$true;configurationPath=$output;operatingChanges=0;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json -Compress
}catch{@{state='PHASE08_ACCELERATED_APP_PREPARE_FAILED';inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$live=$null;$before=$null;$after=$null;$changed=$null;$result=$null}
