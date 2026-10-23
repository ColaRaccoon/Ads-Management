param([Parameter(Mandatory)][ValidateSet('before','after')][string]$Phase)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='IDENTITY';$ctx=$null
try{
 Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '81b8ba86b22f2019227433f9e0f87ced95d97a44b44ba69d494eec0d664ce537'){throw 'source'}
 $ctx=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $ctx $pins
 $output=Assert-Phase08SchedulerOutputPath ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-v20-first-two-$Phase-actual-20261016.json")
 $days=@();foreach($day in @('2026-10-09','2026-10-10')){
  $p=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-v20-restart-proof.mjs" @{action='sql';day=$day};if($p.state -cne 'META_FIRST_UNIT_SQL_PREPARED' -or $p.sql -isnot [string] -or -not $p.sql.StartsWith('BEGIN READ ONLY;') -or -not $p.sql.EndsWith('COMMIT;')){throw 'sql'}
  $rows=@(Invoke-Phase08Management -Action Query -Query $p.sql);$r=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-v20-restart-proof.mjs" @{action='project';rows=@($rows)}
  if($r.state -cne 'PHASE08_META_FIRST_UNIT_READONLY_FINGERPRINT' -or $r.verified -isnot [bool] -or -not $r.verified -or ($day -ceq '2026-10-09' -and $r.unit_attempts -ne 2) -or ($day -ceq '2026-10-10' -and $r.unit_attempts -notin @(2,3))){throw 'day-proof'}
  $days+=@{day=$day;fingerprint=$r.fingerprint;attempts=$r.unit_attempts;adRows=$r.current_ad_rows;adsetRows=$r.current_adset_rows}
 }
 $q="BEGIN READ ONLY; SELECT (SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) AS stopped,EXISTS(SELECT 1 FROM phase08_meta_ads.run_units u JOIN phase08_meta_ads.sync_runs r ON r.id=u.run_id WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.request_key='schedule:phase08-meta:'||encode(extensions.digest('2026-10-16T01:20:00.000Z','sha256'),'hex') AND u.unit_key='2026-10-11' AND u.status='SUCCEEDED' AND u.attempts BETWEEN 1 AND 3 AND u.completed_at IS NOT NULL) AS next_succeeded; COMMIT;"
 $state=@(Invoke-Phase08Management -Action Query -Query $q);if($state.Count -ne 1 -or $state[0].stopped -isnot [bool] -or $state[0].next_succeeded -isnot [bool]){throw 'status'}
 if($Phase -ceq 'before' -and (-not $state[0].stopped -or $state[0].next_succeeded)){throw 'before-next-day'}
 if($Phase -ceq 'after'){
  $stage='RESTART_CONTINUITY';$base='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/'
  $files=@();foreach($name in @('october16-v20-first-two-before-actual-20261016.json','october16-v20-deployment-restart-actual-20261016.json')){$i=Get-Item -LiteralPath ($base+$name);if($i.PSIsContainer -or $i.Length -gt 16384 -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'file'};$files+=([IO.File]::ReadAllText($i.FullName)|ConvertFrom-Json -AsHashtable -DateKind String)}
  $before=$files[0];$receipt=$files[1]
  if($before.state -cne 'PHASE08_V20_FIRST_TWO_PROOF' -or $before.phase -cne 'before' -or $before.sourceSha -cne $pins.sourceSha -or $before.verified -isnot [bool] -or -not $before.verified -or $receipt.state -cne 'PHASE08_OCTOBER16_DEPLOYMENT_VERIFIED' -or $receipt.action -cne 'restart' -or $receipt.sourceSha -cne $pins.sourceSha -or $receipt.previousDeploymentId -cne $before.deploymentId -or $receipt.deploymentId -cne $pins.deploymentId -or $receipt.previousDeploymentId -ceq $receipt.deploymentId -or $receipt.sameImageVerified -isnot [bool] -or -not $receipt.sameImageVerified -or $receipt.frozenSourceNewBuild -isnot [bool] -or $receipt.frozenSourceNewBuild -or -not $state[0].next_succeeded){throw 'continuity'}
  if(@($before.days).Count -ne 2){throw 'days'};for($n=0;$n -lt 2;$n++){foreach($key in @('day','fingerprint','attempts','adRows','adsetRows')){if($before.days[$n][$key] -cne $days[$n][$key]){throw 'changed'}}}
  $a=[DateTimeOffset]::Parse($before.observedAt);$b=[DateTimeOffset]::Parse($receipt.observedAt);if($a -gt $b -or $b -gt [DateTimeOffset]::UtcNow){throw 'chronology'}
 }
 $out=@{state='PHASE08_V20_FIRST_TWO_PROOF';verified=$true;phase=$Phase;sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;observedAt=[DateTimeOffset]::UtcNow.ToString('o');days=$days;sameImageContinuationVerified=($Phase -ceq 'after');nextDaySucceeded=$state[0].next_succeeded;providerRequests=0;databaseWrites=0;appHttpRequests=0;rawValuesReturned=0}
 $null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 10 -Compress
}catch{@{state='PHASE08_V20_FIRST_TWO_FAILED';stage=$stage;rawErrorSuppressed=$true;providerRequests=0;databaseWrites=0}|ConvertTo-Json -Compress;exit 1}
finally{$ctx=$null;$rows=$null;$days=$null;$files=$null}
