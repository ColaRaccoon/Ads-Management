param([ValidateSet('capture','offline')][string]$Mode='offline',[string]$ArtifactId,[ValidateSet(1,2)][int]$Attempt=1)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/meta-diagnostic-protected.ps1"
Import-Phase08SchedulerChildDefinitions
$context=$null;$live=$null;$key=$null;$stage='IDENTITY'
try {
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $null=Get-Phase08SchedulerGraphState $context $pins
 $result=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' @{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}
 $live=$result.variables;$result=$null
 $stage='CAPTURE_KEY';$key=Read-Phase08MetaDiagnosticKey
 $stage='PROTECTED_DIAGNOSTIC'
 $material=@{projectRef='ehnfrrmbkvlsbpvqcvkr';day='2026-10-08';classification='MANUAL_DIAGNOSTIC';mode=$Mode;env=$live;databaseUrl=$context.env.DATABASE_URL;captureKeyB64=$key}
 if($Mode -ceq 'offline'){
  if($ArtifactId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'artifact'}
  $material.artifactId=$ArtifactId
 }
 $suffix=if($Mode -ceq 'capture'){'capture'}else{'offline-'+$ArtifactId}
 $path='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-failed-day-actual-20261015-'+$suffix+'.json'
 if(Test-Path -LiteralPath $path){throw 'existing-summary'}
 if($Mode -ceq 'capture'){
  $marker=Join-Path (Get-Phase08MetaDiagnosticDirectory) ('capture-attempt-'+$Attempt+'.json')
  if($Attempt -eq 2 -and -not (Test-Path -LiteralPath (Join-Path (Get-Phase08MetaDiagnosticDirectory) 'capture-attempt-1.json'))){throw 'first-attempt-required'}
  $stream=[IO.File]::Open($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$bytes=[Text.Encoding]::UTF8.GetBytes((@{classification='MANUAL_DIAGNOSTIC';day='2026-10-08';startedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  Set-Phase08NewPrivateAcl -Path $marker
 }
 $probe=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'meta-diagnostic-result.mjs') $material
 if($probe.state -cne 'PHASE08_META_DIAGNOSTIC_RESULT_RETURNED' -or $probe.success -isnot [bool]){throw 'probe-result'}
 $out=$probe.result
 if(-not $probe.success){
  $failurePath='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-diagnostic-failure-20261015-attempt-'+$Attempt+'.json'
  $null=Write-Phase08SchedulerPublicEvidence $out $failurePath
  $out|ConvertTo-Json -Compress -Depth 8
  exit 1
 }
 if($out.classification -cne 'MANUAL_DIAGNOSTIC' -or $out.day -cne '2026-10-08' -or $out.mode -cne $Mode -or $out.databaseWrites -ne 0 -or $out.rawValuesReturned -ne 0 -or $out.stage -cnotin @('CAPTURE_SELECTION','LINK_RESIDUAL','PURCHASE_RESIDUAL','NORMALIZE','ACCEPTED')){throw 'safe-result'}
 $stage='PUBLIC_SUMMARY'
 $null=Write-Phase08SchedulerPublicEvidence $out $path
 $out|ConvertTo-Json -Compress -Depth 12
}catch{@{state='PHASE08_META_DIAGNOSTIC_EXECUTION_FAILED';stage=$stage;mode=$Mode;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$live=$null;$key=$null;$material=$null;$out=$null}
