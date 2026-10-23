param([Parameter(Mandatory)][ValidateSet('weekly','cafe')][string]$Mode)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
function Assert-Phase08October16Restart($Before,$After,$Receipt,$Pins){
 $source='81b8ba86b22f2019227433f9e0f87ced95d97a44b44ba69d494eec0d664ce537'
 if($Before.sourceSha -cne $source -or $Pins.sourceSha -cne $source -or $Before.mode -cne 'first-before' -or $Before.classification -cne 'OCTOBER16_FIRST_DAY09_COMMITTED_FINGERPRINT' -or $Receipt.state -cne 'PHASE08_OCTOBER16_DEPLOYMENT_VERIFIED' -or $Receipt.action -cne 'restart' -or $Receipt.sourceSha -cne $source -or $Receipt.previousDeploymentId -cne $Before.deploymentId -or $Receipt.deploymentId -cne $Pins.deploymentId -or $Receipt.previousDeploymentId -ceq $Receipt.deploymentId -or $Receipt.region -cne 'sin'){throw 'receipt-binding'}
 foreach($id in @($Receipt.previousDeploymentId,$Receipt.deploymentId)){if($id -isnot [string] -or $id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'receipt-id'}}
 foreach($n in @('sameImageVerified','resourceConfigurationPreserved','globalStopped','sleepApplication')){if($Receipt[$n] -isnot [bool] -or -not $Receipt[$n]){throw 'receipt-bool'}}
 if($Receipt.frozenSourceNewBuild -isnot [bool] -or $Receipt.frozenSourceNewBuild){throw 'new-image'}
 foreach($pair in @(@('immutableFiles',475),@('databaseForceRls',68),@('liveLeasesObserved',0),@('replicas',1),@('cpu',1),@('memoryBytes',1000000000),@('providerRequests',0),@('databaseWrites',0),@('operatingChanges',0))){$n=$pair[0];if(($Receipt[$n] -isnot [int] -and $Receipt[$n] -isnot [long]) -or $Receipt[$n] -ne $pair[1]){throw 'receipt-count'}}
 foreach($r in @($Before,$After)){if($r.state -cne 'PHASE08_META_FIRST_UNIT_READONLY_FINGERPRINT' -or $r.verified -isnot [bool] -or -not $r.verified -or $r.fingerprint -isnot [string] -or $r.fingerprint -cnotmatch '^[a-f0-9]{32}$' -or ($r.unit_attempts -isnot [int] -and $r.unit_attempts -isnot [long]) -or $r.unit_attempts -lt 1 -or $r.unit_attempts -gt 3){throw 'fingerprint'}}
 if($Before.fingerprint -cne $After.fingerprint -or $Before.unit_attempts -ne $After.unit_attempts){throw 'first-day-changed'}
 $a=[DateTimeOffset]::MinValue;$b=$a;if($Before.observedAt -isnot [string] -or $Receipt.observedAt -isnot [string] -or -not [DateTimeOffset]::TryParse($Before.observedAt,[ref]$a) -or -not [DateTimeOffset]::TryParse($Receipt.observedAt,[ref]$b) -or $a -gt $b -or $b -gt [DateTimeOffset]::UtcNow -or $a -lt [DateTimeOffset]'2026-10-16T01:20:00Z'){throw 'chronology'}
}
function Read-Phase08October16Public($Path){$i=Get-Item -LiteralPath $Path;if($i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $i.Length -gt 16384){throw 'file'};return ([IO.File]::ReadAllText($i.FullName)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15)}
$stage='IDENTITY';$context=$null
try{
 Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '81b8ba86b22f2019227433f9e0f87ced95d97a44b44ba69d494eec0d664ce537'){throw 'source'}
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $output=Assert-Phase08SchedulerOutputPath ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-v20-$Mode-proof-actual-20261016.json")
 $stage='FIXED_READONLY';$action=if($Mode -ceq 'weekly'){'weekly-sql'}elseif($Mode -ceq 'cafe'){'cafe-sql'}else{'first-unit-sql'}
 $p=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-proof.mjs" @{action=$action}
 $expected=if($Mode -ceq 'weekly'){'META_WEEKLY_SQL_PREPARED'}elseif($Mode -ceq 'cafe'){'CAFE_AFTERNOON_SQL_PREPARED'}else{'META_FIRST_UNIT_SQL_PREPARED'}
 if($p.state -cne $expected -or $p.sql -isnot [string] -or $p.sql.Length -gt 65536 -or -not $p.sql.StartsWith('BEGIN READ ONLY;') -or -not $p.sql.EndsWith('COMMIT;')){throw 'sql'}
 $rows=@(Invoke-Phase08Management -Action Query -Query $p.sql);$project=if($Mode -ceq 'weekly'){'project-weekly'}elseif($Mode -ceq 'cafe'){'project-cafe'}else{'project-first-unit'}
 $stage='STRICT_PROJECT';$out=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-proof.mjs" @{action=$project;rows=@($rows)}
 $wanted=if($Mode -ceq 'weekly'){'PHASE08_META_AFTERNOON_WEEKLY_READONLY'}elseif($Mode -ceq 'cafe'){'PHASE08_CAFE_AFTERNOON_READONLY'}else{'PHASE08_META_FIRST_UNIT_READONLY_FINGERPRINT'}
 if($out.state -cne $wanted -or $out.verified -isnot [bool] -or -not $out.verified){throw 'not-complete'}
 if($Mode -ceq 'first-after'){
  $stage='SAME_IMAGE_CONTINUITY';$before=Read-Phase08October16Public 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-v20-first-before-proof-actual-20261016.json';$receipt=Read-Phase08October16Public 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-v20-deployment-restart-actual-20261016.json'
  Assert-Phase08October16Restart $before $out $receipt $pins
  $stage='DAY10_ADDITIONAL_SUCCESS';$sql=$p.sql
  foreach($pair in @(@("WHERE u.unit_key='2026-10-09'","WHERE u.unit_key='2026-10-10'"),@("metric_date='2026-10-09'","metric_date='2026-10-10'"),@("r.id::text||':2026-10-09'","r.id::text||':2026-10-10'"))){if(-not $sql.Contains($pair[0])){throw 'next-source'};$sql=$sql.Replace($pair[0],$pair[1])}
  $nextRows=@(Invoke-Phase08Management -Action Query -Query $sql);$next=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-proof.mjs" @{action='project-first-unit';rows=@($nextRows)}
  if($next.verified -isnot [bool] -or -not $next.verified -or $next.state -cne $wanted){throw 'next-not-successful'}
  $out['sameFirstDayFingerprint']=$true;$out['sameSuccessfulUnitAttempts']=$true;$out['sameImageRestartEvidenceVerified']=$true;$out['continuedDay10Succeeded']=$true;$out['previousDeploymentId']=$before.deploymentId
 }
 $out['classification']=if($Mode -ceq 'weekly'){'OCTOBER16_SCHEDULED_WEEKLY_POST_PUBLISH_READONLY'}elseif($Mode -ceq 'cafe'){'OCTOBER16_CAFE_DAY15_POST_PUBLISH_READONLY'}else{'OCTOBER16_FIRST_DAY09_COMMITTED_FINGERPRINT'}
 $out['mode']=$Mode;$out['sourceSha']=$pins.sourceSha;$out['deploymentId']=$pins.deploymentId;$out['observedAt']=[DateTimeOffset]::UtcNow.ToString('o');$out['appHttpRequests']=0
 $null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 6 -Compress
}catch{@{state='PHASE08_OCTOBER16_PROOF_FAILED';stage=$stage;mode=$Mode;providerRequests=0;appHttpRequests=0;databaseWrites=0;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}finally{$context=$null;$rows=$null;$out=$null}
