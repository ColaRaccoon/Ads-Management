param([Parameter(Mandatory)][ValidateSet('resume-test','stop-restart','resume-restart','stop-issue','resume-issue','stop-meta-fix','resume-meta-fix','stop-publish-fix','resume-publish-fix','stop-v20-restart','resume-v20-restart','stop-normalize','resume-normal','resume-repeat','stop-repeat-normalize','stop-repeat-publish-fix','resume-repeat-publish-fix')][string]$Action,[string]$EvidencePath,[switch]$ExecuteApproved,[ValidateSet('A','B')][string]$Submission='A')
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
$stage='APPROVAL';$submitted=$false;$context=$null;$operator=$null;$envelope=$null;$prepared=$null;$rows=$null
try{
 if(-not $ExecuteApproved){throw 'approval'}
 Import-Phase08SchedulerChildDefinitions
 if($Submission -ceq 'B' -and $Action -cnotin @('stop-publish-fix','stop-v20-restart')){throw 'submission-scope'}
 $suffix=if($Submission -ceq 'B'){'-B'}else{''}
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-global-'+$Action+$suffix+'-actual-20261016.json')
 $marker=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-global-'+$Action+$suffix+'-attempt-20261016.json')
 $stage='IDENTITY';$pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$operator=Read-Phase08Operator
 if($Action.StartsWith('resume-')){
  $stage='FRESH_SIGNED_PROOF';$item=Get-Item -LiteralPath $EvidencePath;$path=[IO.Path]::GetFullPath($item.FullName)
  if(-not $path.StartsWith('C:\Users\seong\AppData\Local\MetaAdsPhase08Evaluation\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($path) -cne '.json' -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 65536){throw 'proof-file'}
  $envelope=[IO.File]::ReadAllText($path)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 25
  $proof=Invoke-Phase08SchedulerNode @{action='validate';envelope=$envelope};if($proof.state -cne 'PHASE08_SIGNED_EVIDENCE_VERIFIED'){throw 'proof'}
  $graph=Get-Phase08SchedulerGraphState $context $pins;$null=Get-Phase08SchedulerReady $context $pins
  if(($graph.appSchedules|ConvertTo-Json -Compress -Depth 10) -cne ($proof.payload.appSchedules|ConvertTo-Json -Compress -Depth 10)){throw 'live-definitions'}
 }
 $stage='BUILD';$prepared=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-global-control.mjs" @{action=$Action;actorId=$operator.appId;authId=$operator.authId;envelope=$envelope}
 if($prepared.state -cne 'PHASE08_OCTOBER16_GLOBAL_CONTROL_PREPARED' -or $prepared.sql -isnot [string] -or $prepared.sql.Length -gt 1048576 -or $prepared.globalStopped -isnot [bool] -or $prepared.action -cne $Action){throw 'control-sql'}
 $null=Write-Phase08SchedulerPublicEvidence @{classification='USER_APPROVED_ISOLATED_AFTERNOON_CONTROL_PLANNED';action=$Action;observedAt=[DateTimeOffset]::UtcNow.ToString('o');providerRequests=0} $marker
 $stage='SINGLE_BATCH';$submitted=$true;$rows=@(Invoke-Phase08Management -Action Query -Query $prepared.sql)
 if($rows.Count -ne 1 -or $rows[0].state -cne 'PHASE08_OCTOBER16_GLOBAL_CONTROL_APPLIED' -or $rows[0].global_stopped -isnot [bool] -or $rows[0].global_stopped -ne $prepared.globalStopped -or $rows[0].action -cne $Action){throw 'control-result'}
 foreach($n in @('active_jobs','total_jobs')){if(($rows[0].$n -isnot [int] -and $rows[0].$n -isnot [long]) -or $rows[0].$n -notin @(138,149)){throw 'control-count'}}
 $expectedActive=149
 if($rows[0].total_jobs -ne 149 -or $rows[0].active_jobs -ne $expectedActive){throw 'control-total'}
 $out=@{state='PHASE08_OCTOBER16_GLOBAL_CONTROL_VERIFIED';action=$Action;observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;globalStopped=$rows[0].global_stopped;activeJobs=$rows[0].active_jobs;totalJobs=$rows[0].total_jobs;userAudit=1;businessHistoryPreserved=$true;providerRequests=0;operatingChanges=0;retryPerformed=$false}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_OCTOBER16_GLOBAL_CONTROL_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$operator=$null;$envelope=$null;$prepared=$null;$rows=$null;$out=$null;$proof=$null;$graph=$null}
