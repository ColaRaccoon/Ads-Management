param([Parameter(Mandatory)][ValidateSet('first-before','first-after','weekly')][string]$Mode)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
function Assert-Phase08FirstDayRestartContinuity($Before,$After,$Restart,$Pins){
 $initial='653a3679-11f5-42d1-9eab-aa5c1db71654';$restarted='44783a13-1150-4f13-9d7a-88217bd9784a';$source='e83351e69260d94a6aaebb5ff6d109bd38aa0570b3bdbc1f55069d8a3b39d44f';$current='42c15d089e41db8fb4286209bcf8975eb4c9ec3aa61b23f459aa49bd3024764f';$fingerprint='62991def834850f2a043c426909ce169'
 if($Before.sourceSha -isnot [string] -or $Before.deploymentId -isnot [string] -or $Before.mode -isnot [string] -or $Before.classification -isnot [string] -or $Pins.sourceSha -cne $current -or $Pins.deploymentId -isnot [string] -or $Pins.deploymentId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or $Pins.deploymentId -cin @($initial,$restarted) -or $Before.sourceSha -cne $source -or $Before.deploymentId -cne $initial -or $Before.mode -cne 'first-before' -or $Before.classification -cne 'ACTUAL_COMMITTED_FIRST_DAY_READONLY_FINGERPRINT'){throw 'first-source-transition'}
 foreach($value in @($Before,$After)){if($value.state -isnot [string] -or $value.state -cne 'PHASE08_META_FIRST_UNIT_READONLY_FINGERPRINT' -or $value.verified -isnot [bool] -or -not $value.verified -or $value.fingerprint -isnot [string] -or $value.fingerprint -cne $fingerprint -or ($value.unit_attempts -isnot [int] -and $value.unit_attempts -isnot [long]) -or $value.unit_attempts -ne 2){throw 'first-unit-changed'}}
 if(@(@('state','action','sourceSha','previousDeploymentId','deploymentId','region')|Where-Object{$Restart[$_] -isnot [string]}).Count -ne 0 -or $Restart.state -cne 'PHASE08_AFTERNOON_DEPLOYMENT_VERIFIED' -or $Restart.action -cne 'restart' -or $Restart.sourceSha -cne $source -or $Restart.previousDeploymentId -cne $initial -or $Restart.deploymentId -cne $restarted -or $Restart.region -cne 'sin'){throw 'restart-receipt'}
 foreach($name in @('sameImageVerified','resourceConfigurationPreserved','globalStopped','sleepApplication')){if($Restart[$name] -isnot [bool] -or -not $Restart[$name]){throw 'restart-bool'}}
 if($Restart.frozenSourceNewBuild -isnot [bool] -or $Restart.frozenSourceNewBuild){throw 'restart-new-image'}
 foreach($pair in @(@('immutableFiles',475),@('databaseForceRls',68),@('liveLeasesObserved',0),@('replicas',1),@('cpu',1),@('memoryBytes',1000000000),@('providerRequests',0),@('databaseWrites',0),@('operatingChanges',0))){$name=$pair[0];if(($Restart[$name] -isnot [int] -and $Restart[$name] -isnot [long]) -or $Restart[$name] -ne $pair[1]){throw 'restart-count'}}
 $beforeAt=[DateTimeOffset]::MinValue;$restartAt=[DateTimeOffset]::MinValue;if($Before.observedAt -isnot [string] -or $Restart.observedAt -isnot [string] -or -not [DateTimeOffset]::TryParse($Before.observedAt,[ref]$beforeAt) -or -not [DateTimeOffset]::TryParse($Restart.observedAt,[ref]$restartAt) -or $beforeAt -gt $restartAt -or $restartAt -gt [DateTimeOffset]::UtcNow){throw 'restart-order'}
}
$stage='IDENTITY'
try{
 Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '42c15d089e41db8fb4286209bcf8975eb4c9ec3aa61b23f459aa49bd3024764f'){throw 'source'}
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-meta-'+$Mode+'-actual-20261015.json')
 $stage='FIXED_READONLY_SQL';$action=if($Mode -ceq 'weekly'){'weekly-sql'}else{'first-unit-sql'}
 $prepared=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-meta-weekly-proof.mjs" @{action=$action}
 $expectedState=if($Mode -ceq 'weekly'){'META_WEEKLY_SQL_PREPARED'}else{'META_FIRST_UNIT_SQL_PREPARED'}
 if($prepared.state -cne $expectedState -or $prepared.sql -isnot [string] -or $prepared.sql.Length -gt 65536 -or -not $prepared.sql.StartsWith('BEGIN READ ONLY;') -or -not $prepared.sql.EndsWith('COMMIT;')){throw 'sql'}
 $rows=@(Invoke-Phase08Management -Action Query -Query $prepared.sql)
 $stage='STRICT_PROJECT';$project=if($Mode -ceq 'weekly'){'project-weekly'}else{'project-first-unit'}
 $out=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-meta-weekly-proof.mjs" @{action=$project;rows=@($rows)}
 $wanted=if($Mode -ceq 'weekly'){'PHASE08_META_AFTERNOON_WEEKLY_READONLY'}else{'PHASE08_META_FIRST_UNIT_READONLY_FINGERPRINT'}
 if($out.state -cne $wanted -or $out.verified -isnot [bool] -or -not $out.verified){throw 'not-complete'}
 if($Mode -ceq 'first-after'){
  $stage='UNCHANGED_COMMITTED_FIRST_DAY';$item=Get-Item -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-meta-first-before-actual-20261015.json'
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 16384){throw 'before-file'}
  $before=[IO.File]::ReadAllText($item.FullName)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 12
  $restartItem=Get-Item -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-deployment-restart-actual-20261015.json';if($restartItem.PSIsContainer -or ($restartItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $restartItem.Length -gt 16384){throw 'restart-file'}
  $restart=[IO.File]::ReadAllText($restartItem.FullName)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 12
  Assert-Phase08FirstDayRestartContinuity $before $out $restart $pins
  $stage='CONTINUED_DAY09_SUCCEEDED';$continuedSql=$prepared.sql
  foreach($pair in @(@("WHERE u.unit_key='2026-10-08'","WHERE u.unit_key='2026-10-09'"),@("metric_date='2026-10-08'","metric_date='2026-10-09'"),@("r.id::text||':2026-10-08'","r.id::text||':2026-10-09'"))){if(-not $continuedSql.Contains($pair[0])){throw 'continued-sql'};$continuedSql=$continuedSql.Replace($pair[0],$pair[1])}
  $continuedRows=@(Invoke-Phase08Management -Action Query -Query $continuedSql);$continued=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-meta-weekly-proof.mjs" @{action='project-first-unit';rows=@($continuedRows)}
  if($continued.state -cne $wanted -or $continued.verified -isnot [bool] -or -not $continued.verified){throw 'continued-day-not-successful'}
  $out['sameFirstDayFingerprint']=$true;$out['sameSuccessfulUnitAttempts']=$true
  $out['sameImageRestartEvidenceVerified']=$true;$out['additionalCorrectiveDeploymentAfterRestart']=$true;$out['currentDeploymentSameImageClaimed']=$false;$out['continuedDay09Succeeded']=$true;$out['initialSuccessSourceSha']=$before.sourceSha;$out['initialSuccessDeploymentId']=$before.deploymentId;$out['sameImageRestartDeploymentId']=$restart.deploymentId
 }
 $out['classification']=if($Mode -ceq 'weekly'){'ACTUAL_SCHEDULED_WEEKLY_SEVEN_DAY_POST_PUBLISH_READONLY'}else{'ACTUAL_COMMITTED_FIRST_DAY_READONLY_FINGERPRINT'}
 $out['observedAt']=[DateTimeOffset]::UtcNow.ToString('o');$out['sourceSha']=$pins.sourceSha;$out['deploymentId']=$pins.deploymentId;$out['appHttpRequests']=0;$out['mode']=$Mode
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 6 -Compress
}catch{@{state='PHASE08_AFTERNOON_META_PROOF_FAILED';stage=$stage;mode=$Mode;providerRequests=0;appHttpRequests=0;databaseWrites=0;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
