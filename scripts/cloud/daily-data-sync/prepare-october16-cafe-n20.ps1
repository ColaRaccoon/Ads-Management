param([switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/afternoon-runtime-helpers.ps1"
function Get-October16N20Digest($Vars){
 if($Vars -isnot [Collections.IDictionary] -or $Vars.Count -ne 101){throw 'variables'}
 $names=[string[]]@($Vars.Keys|Where-Object {$_ -cne 'DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES'});[Array]::Sort($names,[StringComparer]::Ordinal);$o=[ordered]@{}
 foreach($n in $names){if($Vars[$n] -isnot [string]){throw 'type'};$o[$n]=$Vars[$n]}
 $b=[Text.Encoding]::UTF8.GetBytes(($o|ConvertTo-Json -Depth 20 -Compress));try{return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant()}finally{[Array]::Clear($b)}
}
$stage='APPROVAL';$submitted=$false;$ctx=$null;$vars=$null;$after=$null
try{
 if(-not $ExecuteApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-cafe-n20-variables-actual-20261016.json'
 if($pins.sourceSha -cne 'f1b78cdbdb2a7bd7c6c86da5891c8725181297c4f1b431893bb44042d4ff9b09' -or $pins.deploymentId -cne 'af7a6921-3307-4cf0-9f17-053c21ce3ff4' -or [DateTimeOffset]::UtcNow -lt [DateTimeOffset]'2026-10-16T01:20:00Z' -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-16T02:30:00Z'){throw 'scope'}
 $ctx=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $ctx $pins;$null=Get-Phase08SchedulerGraphState $ctx $pins
 $scope=@{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId};$q='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}'
 $stage='QUIESCENT_BASELINE';$before=Get-Phase08AfternoonRuntimeSnapshot
 if($before.stopped -isnot [bool] -or -not $before.stopped -or $before.live_leases -ne 0 -or $before.active_jobs -ne 149 -or $before.total_jobs -ne 149 -or $before.tables -ne 68 -or $before.original_history -cne 'c044e6c4249188e410d31aacf57422dc'){throw 'database'}
 $vars=(Invoke-Phase08SchedulerGraph $q $scope).variables
 $old='["C40","C48","E00","N00","N30","N40","R00","R30","R40"]';$new='["C40","C48","E00","N00","N20","N30","N40","R00","R30","R40"]'
 if($vars.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES -cne $old -or $vars.PHASE08_SOURCE_CONTENT_SHA256 -cne $pins.sourceSha){throw 'previous'};$hash=Get-October16N20Digest $vars
 $stage='MARKER';$null=Write-Phase08SchedulerPublicEvidence @{classification='ISOLATED_N20_STATUS_EVIDENCE_PREPARED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');changedVariableCount=1;skipDeploys=$true;providerRequests=0} 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-cafe-n20-attempt-20261016.json'
 $stage='SINGLE_MUTATION';$submitted=$true
 $r=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$scope.p;environmentId=$scope.e;serviceId=$scope.s;skipDeploys=$true;variables=@{DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES=$new}}}
 if($r.variableCollectionUpsert -isnot [bool] -or -not $r.variableCollectionUpsert){throw 'uncertain'}
 $stage='READBACK';$after=(Invoke-Phase08SchedulerGraph $q $scope).variables
 if($after.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES -cne $new -or (Get-October16N20Digest $after) -cne $hash){throw 'preservation'}
 $checked=Get-Phase08AfternoonRuntimeSnapshot
 if($checked.business_md5 -cne $before.business_md5 -or $checked.original_history -cne $before.original_history -or $checked.stopped -isnot [bool] -or -not $checked.stopped -or $checked.live_leases -ne 0){throw 'history'}
 $out=@{state='PHASE08_CAFE_N20_CONFIGURATION_VERIFIED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;changedVariableCount=1;otherVariableCount=100;otherVariablesPreserved=$true;allBusinessPreserved=$true;original152Preserved=$true;skipDeploys=$true;newStatus='N20';approvedStatuses=10;providerRequests=0;databaseWrites=0;operatingChanges=0;deploymentStarted=$false;retryPerformed=$false}
 $null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_CAFE_N20_CONFIGURATION_FAILED';stage=$stage;outcomeUncertain=$submitted;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$ctx=$null;$vars=$null;$after=$null;$r=$null}
