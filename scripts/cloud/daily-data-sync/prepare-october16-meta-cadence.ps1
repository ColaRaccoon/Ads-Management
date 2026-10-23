param([Parameter(Mandatory)][ValidateSet('apply','restore')][string]$Mode,[switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
$stage='APPROVAL';$submitted=$false;$ctx=$null;$operator=$null
try{
 if(-not $ExecuteApproved){throw 'approval'};Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '81b8ba86b22f2019227433f9e0f87ced95d97a44b44ba69d494eec0d664ce537'){throw 'v20-source'}
 $output=Assert-Phase08SchedulerOutputPath ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-meta-cadence-$Mode-actual-20261016.json")
 $marker=Assert-Phase08SchedulerOutputPath ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-meta-cadence-$Mode-attempt-20261016.json")
 $receiptPath='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-v20-deployment-initial-actual-20261016.json'
 $item=Get-Item -LiteralPath $receiptPath;if($item.Length -gt 16384 -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'receipt-file'}
 $receipt=[IO.File]::ReadAllText($receiptPath)|ConvertFrom-Json -AsHashtable -DateKind String
 if($receipt.state -cne 'PHASE08_OCTOBER16_DEPLOYMENT_VERIFIED' -or $receipt.action -cne 'initial' -or $receipt.sourceSha -cne $pins.sourceSha -or $receipt.frozenSourceNewBuild -isnot [bool] -or -not $receipt.frozenSourceNewBuild -or $receipt.region -cne 'sin' -or ($receipt.immutableFiles -isnot [int] -and $receipt.immutableFiles -isnot [long]) -or $receipt.immutableFiles -ne 475){throw 'receipt'}
 if($Mode -ceq 'apply' -and $receipt.deploymentId -cne $pins.deploymentId){throw 'initial-deployment'}
 $ctx=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $ctx $pins;$operator=Read-Phase08Operator
 $stage='LIVE_GRAPH';$graph=Get-Phase08SchedulerGraphState $ctx $pins;if(-not $graph.featureEnabled -or -not $graph.scheduleEnabled){throw 'graph'}
 $stage='BUILD';$p=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-meta-cadence.mjs" @{mode=$Mode;actorId=$operator.appId;authId=$operator.authId}
 if($p.state -cne 'PHASE08_META_CADENCE_PREPARED' -or $p.mode -cne $Mode -or $p.sql -isnot [string] -or $p.sql.Length -gt 32768 -or -not $p.sql.StartsWith('BEGIN ISOLATION LEVEL REPEATABLE READ;') -or -not $p.sql.EndsWith('COMMIT;')){throw 'sql'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='OCTOBER16_META_CADENCE_PLANNED';mode=$Mode;observedAt=[DateTimeOffset]::UtcNow.ToString('o');providerRequests=0} $marker
 $stage='SINGLE_BATCH';$submitted=$true;$rows=@(Invoke-Phase08Management -Action Query -Query $p.sql)
 if($rows.Count -ne 1 -or @($rows[0].PSObject.Properties.Name).Count -ne 5 -or $rows[0].state -cne 'PHASE08_META_CADENCE_APPLIED' -or $rows[0].mode -cne $Mode -or ($rows[0].active_jobs -isnot [int] -and $rows[0].active_jobs -isnot [long]) -or $rows[0].active_jobs -ne 149 -or $rows[0].history_preserved -isnot [bool] -or -not $rows[0].history_preserved -or ($rows[0].provider_requests -isnot [int] -and $rows[0].provider_requests -isnot [long]) -or $rows[0].provider_requests -ne 0){throw 'result'}
 $out=@{state='PHASE08_META_CADENCE_VERIFIED';mode=$Mode;sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;observedAt=[DateTimeOffset]::UtcNow.ToString('o');activeJobs=149;historyPreserved=$true;changedJobCount=1;restoreRequired=($Mode -ceq 'apply');automaticRestore=$false;originalDeadlinePreserved=$true;providerRequests=0;operatingChanges=0}
 $null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_META_CADENCE_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$ctx=$null;$operator=$null;$graph=$null;$receipt=$null;$p=$null;$rows=$null}
