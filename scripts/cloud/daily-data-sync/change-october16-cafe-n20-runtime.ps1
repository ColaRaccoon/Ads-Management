param([switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/afternoon-runtime-helpers.ps1"
$stage='APPROVAL';$ctx=$null;$submitted=$false
try{
 if(-not $ExecuteApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-cafe-n20-runtime-actual-20261016.json'
 $marker=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-cafe-n20-runtime-attempt-20261016.json'
 if($pins.sourceSha -cne 'f1b78cdbdb2a7bd7c6c86da5891c8725181297c4f1b431893bb44042d4ff9b09' -or $pins.deploymentId -cne 'af7a6921-3307-4cf0-9f17-053c21ce3ff4' -or [DateTimeOffset]::UtcNow -lt [DateTimeOffset]'2026-10-16T01:20:00Z' -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-16T02:15:00Z'){throw 'scope'}
 $ctx=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $ctx $pins
 $stage='ACTUAL_VARIABLE_EVIDENCE';$receipt=Get-Content -Raw -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-cafe-n20-variables-actual-20261016.json'|ConvertFrom-Json -AsHashtable -DateKind String -Depth 8
 if($receipt.state -cne 'PHASE08_CAFE_N20_CONFIGURATION_VERIFIED' -or $receipt.sourceSha -cne $pins.sourceSha -or $receipt.deploymentId -cne $pins.deploymentId -or $receipt.newStatus -cne 'N20' -or $receipt.changedVariableCount -ne 1){throw 'receipt'}
 if($receipt.changedVariableCount -isnot [int] -and $receipt.changedVariableCount -isnot [long]){throw 'receipt-count'}
 foreach($n in @('otherVariablesPreserved','allBusinessPreserved','original152Preserved','skipDeploys')){if($receipt[$n] -isnot [bool] -or -not $receipt[$n]){throw 'receipt-bool'}}
 $stage='STOP_LEASE_AND_CHECKPOINT';$s=Get-Phase08AfternoonRuntimeSnapshot
 if($s.stopped -isnot [bool] -or -not $s.stopped -or $s.live_leases -ne 0 -or $s.total_jobs -ne 149 -or $s.active_jobs -ne 149 -or $s.tables -ne 68){throw 'snapshot'}
 $before=Get-Content -Raw -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-cafe-n20-restart-before-actual-20261016.json'|ConvertFrom-Json -AsHashtable -DateKind String -Depth 8
 if($before.state -cne 'PHASE08_CAFE_RESTART_CHECKPOINT_OBSERVED' -or $before.phase -cne 'before' -or $before.sourceSha -cne $pins.sourceSha -or $before.deploymentId -cne $pins.deploymentId -or $before.checkpointCount -ne 1 -or $before.expiredCheckpointCount -ne 0 -or $before.digest -isnot [string] -or $before.digest -cnotmatch '^[a-f0-9]{32}$'){throw 'checkpoint'}
 foreach($n in @('checkpointCount','expiredCheckpointCount')){if($before[$n] -isnot [int] -and $before[$n] -isnot [long]){throw 'checkpoint-count'}}
 $null=Get-Phase08SchedulerGraphState $ctx $pins;$service=Get-Phase08AfternoonRuntimeService $pins
 if($service.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or @($service.activeDeployments).Count -ne 1 -or $service.activeDeployments[0].id -cne $pins.deploymentId -or $service.latestDeployment.canRedeploy -isnot [bool] -or -not $service.latestDeployment.canRedeploy){throw 'service'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='OCTOBER16_CAFE_N20_SAME_IMAGE_REDEPLOY_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');providerRequests=0} $marker
 $stage='SINGLE_MUTATION';if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-16T02:15:00Z'){throw 'clock'};$submitted=$true;$r=Invoke-Phase08SchedulerGraph 'mutation($id:String!){deploymentRedeploy(id:$id,usePreviousImageTag:true){id}}' @{id=$pins.deploymentId};$id=$r.deploymentRedeploy.id
 if($id -isnot [string] -or $id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $id -ceq $pins.deploymentId){throw 'result'}
 $out=@{state='PHASE08_CAFE_N20_RUNTIME_OPERATION_SUBMITTED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;previousDeploymentId=$pins.deploymentId;deploymentId=$id;actualCompletionVerified=$false;mutationCalls=1;providerRequestsByController=0;databaseWrites=0;operatingChanges=0;retryPerformed=$false}
 $null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_CAFE_N20_RUNTIME_OPERATION_FAILED';stage=$stage;outcomeUncertain=$submitted;retryPerformed=$false;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$ctx=$null;$r=$null}
