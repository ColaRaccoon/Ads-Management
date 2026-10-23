Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/meta-diagnostic-protected.ps1"
function ConvertTo-Phase08SafeRollbackResult($Value,[bool]$Success){
 if($Value -isnot [Collections.IDictionary]){throw 'result-object'}
 $diag='^META_PUBLISH_(?:PRISMA_P(?:1000|1001|1002|1008|1011|1017|2000|2002|2003|2009|2010|2021|2022|2023|2024|2028|2034)|PRISMA_VALIDATION|OTHER|PROVIDER|HTTP)$'
 if($Success){
  $fields=@('state','classification','day','transactionTimeoutMs','elapsedMs','writerQueryCount','probeRunCreated','callbackEntered','callbackCompleted','diagnosticCode','rollbackVerified','originalAttemptsChanged','providerRequests','committedWrites','normalPublishEvidence','foundationPublishFencingExecuted','coveragePublicationExecuted','pausedMetaExternallyAttested','rawValuesReturned')
  if($Value.Count -ne $fields.Count -or @($fields|Where-Object{-not $Value.Contains($_)}).Count -ne 0 -or $Value.state -cne 'PHASE08_META_WRITER_ROLLBACK_DIAGNOSTIC' -or $Value.classification -cne 'MANUAL_DIAGNOSTIC_TRANSIENT_WRITES_ROLLED_BACK' -or $Value.day -cne '2026-10-08' -or ($null -ne $Value.diagnosticCode -and ($Value.diagnosticCode -isnot [string] -or $Value.diagnosticCode -cnotmatch $diag))){throw 'result-shape'}
  foreach($n in @('transactionTimeoutMs','elapsedMs','writerQueryCount','providerRequests','committedWrites','rawValuesReturned')){if(($Value[$n] -isnot [int] -and $Value[$n] -isnot [long]) -or $Value[$n] -lt 0 -or $Value[$n] -gt 55000){throw 'result-number'}}
  if($Value.transactionTimeoutMs -ne 5000 -or $Value.providerRequests -ne 0 -or $Value.committedWrites -ne 0 -or $Value.rawValuesReturned -ne 0){throw 'result-boundary'}
  foreach($n in @('probeRunCreated','callbackEntered','callbackCompleted','rollbackVerified','originalAttemptsChanged','normalPublishEvidence','foundationPublishFencingExecuted','coveragePublicationExecuted','pausedMetaExternallyAttested')){if($Value[$n] -isnot [bool]){throw 'result-boolean'}}
  if(-not $Value.rollbackVerified -or -not $Value.pausedMetaExternallyAttested -or $Value.originalAttemptsChanged -or $Value.normalPublishEvidence -or $Value.foundationPublishFencingExecuted -or $Value.coveragePublicationExecuted){throw 'result-evidence'}
 }else{
  $fields=@('state','stage','rollbackVerified','providerRequests','inspectBeforeRetry','rawErrorSuppressed');if($Value.Contains('diagnosticCode')){$fields+=@('diagnosticCode')}
  if($Value.Count -ne $fields.Count -or @($fields|Where-Object{-not $Value.Contains($_)}).Count -ne 0 -or $Value.state -cne 'PHASE08_META_WRITER_ROLLBACK_FAILED' -or $Value.stage -isnot [string] -or $Value.stage -cnotin @('INPUT','CAPTURE','BASELINE','WRITER_VALIDATE','WRITER_TRANSACTION','VERIFY_ROLLBACK','HARD_TIMEOUT') -or ($Value.Contains('diagnosticCode') -and ($Value.diagnosticCode -isnot [string] -or $Value.diagnosticCode -cnotmatch $diag)) -or $Value.rollbackVerified -isnot [bool] -or $Value.rollbackVerified -or ($Value.providerRequests -isnot [int] -and $Value.providerRequests -isnot [long]) -or $Value.providerRequests -ne 0 -or $Value.inspectBeforeRetry -isnot [bool] -or -not $Value.inspectBeforeRetry -or $Value.rawErrorSuppressed -isnot [bool] -or -not $Value.rawErrorSuppressed){throw 'failure-shape'}
 }
 $result=[ordered]@{};foreach($n in $fields){$result[$n]=$Value[$n]};return $result
}
if($MyInvocation.InvocationName -cne '.') {
$stage='IDENTITY';$context=$null;$live=$null;$key=$null
try {
 Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-writer-batch-rollback-actual-20261015.json'
 $attemptPath=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-writer-batch-rollback-attempt-20261015.json'
 $pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '9b6fa647a8ebe56d3598aafa069400e2c880a8fda37a531f03d1e55b9ef5e409' -or $pins.deploymentId -cne '56ed1723-ba91-4cdd-a335-f0e241cc180c'){throw 'source'}
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$null=Get-Phase08SchedulerGraphState $context $pins
 $stage='WRITER_SOURCE_BYTES'
 $snapshot='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261015-v11'
 $manifest=([IO.File]::ReadAllText((Join-Path $snapshot 'source-content-manifest.json'))|ConvertFrom-Json -AsHashtable -DateKind String -Depth 12)
 if($manifest.sourceContentSha256 -cne '0368163a964e94086ef77ca644a6bf3d0be2ec6cfe12523cb136ec5ac02cd9fa' -or $manifest.files.Count -ne 474 -or $manifest.secretsIncluded -isnot [bool] -or $manifest.secretsIncluded){throw 'candidate-manifest'}
 $bytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $manifest.files -Depth 10 -Compress));try{$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()}finally{[Array]::Clear($bytes)}
 if($hash -cne $manifest.sourceContentSha256){throw 'candidate-digest'}

 foreach($name in @('apps/api/src/daily-sync/meta-day-batch.ts','apps/api/src/daily-sync/meta-failure-diagnostic.ts','apps/api/src/daily-sync/canonical-api-writer.service.ts','apps/api/src/uploads/meta-entity-writer.service.ts','apps/api/src/uploads/meta-metric-version.service.ts','apps/api/src/mappings/mappings.service.ts')){
   $entries=@($manifest.files|Where-Object {$_.name -ceq $name});if($entries.Count -ne 1 -or (Get-FileHash -LiteralPath (Join-Path $snapshot $name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entries[0].sha256){throw 'candidate-bytes'}
  if((Get-FileHash -LiteralPath (Join-Path $snapshot $name) -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath (Join-Path (Resolve-Path "$PSScriptRoot/../../..").Path $name) -Algorithm SHA256).Hash){throw 'writer-source'}
 }
 $live=(Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' @{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}).variables
 $key=Read-Phase08MetaDiagnosticKey
 $stage='FRESH_PAUSE'
 $rows=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT key,paused,provider,connection_id::text AS connection,anchor_at='2026-10-15T01:02:00Z'::timestamptz AS expected_anchor FROM daily_data_sync_ops.schedules WHERE key='phase08-meta';COMMIT;")
 if($rows.Count -ne 1 -or $rows[0].paused -isnot [bool] -or -not $rows[0].paused -or $rows[0].provider -cne 'META' -or $rows[0].connection -cne '1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' -or $rows[0].expected_anchor -isnot [bool] -or -not $rows[0].expected_anchor){throw 'pause'}
 $pausedAt=[DateTimeOffset]::UtcNow.ToString('o')
 $stage='ATTEMPT_MARKER';$null=Write-Phase08SchedulerPublicEvidence @{classification='MANUAL_DIAGNOSTIC_TRANSIENT_WRITES_ROLLBACK_PLANNED';startedAt=$pausedAt;sourceSha=$pins.sourceSha;operatingChanges=0} $attemptPath
 $stage='SINGLE_ROLLBACK_PROBE'
 $probe=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'meta-writer-rollback-result.mjs') @{projectRef='ehnfrrmbkvlsbpvqcvkr';mode='ROLLBACK_WRITER_DIAGNOSTIC';classification='MANUAL_DIAGNOSTIC';day='2026-10-08';artifactId='35428d2c-70e3-4eb3-a752-a189c232a0a2';captureKeyB64=$key;databaseUrl=$context.env.DATABASE_URL;env=$live;pausedMetaVerified=$true;pausedObservedAt=$pausedAt}
 if($probe.state -cne 'PHASE08_META_ROLLBACK_RESULT_RETURNED' -or $probe.success -isnot [bool]){throw 'result'}
 $out=ConvertTo-Phase08SafeRollbackResult $probe.result $probe.success
 $out['candidateSourceSha']='0368163a964e94086ef77ca644a6bf3d0be2ec6cfe12523cb136ec5ac02cd9fa';$out['candidateWriter']='API_META_BOUNDED_BATCH';$out['liveSourceSha']=$pins.sourceSha
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 5 -Compress
 if(-not $probe.success){exit 1}
}catch{@{state='PHASE08_META_ROLLBACK_EXECUTION_FAILED';stage=$stage;outcomeUncertain=($stage -cin @('SINGLE_ROLLBACK_PROBE','PUBLIC_EVIDENCE'));inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$live=$null;$key=$null;$probe=$null;$out=$null}

}
