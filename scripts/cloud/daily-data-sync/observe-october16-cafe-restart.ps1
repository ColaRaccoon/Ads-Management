param([Parameter(Mandatory)][ValidateSet('before','after')][string]$Phase)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='IDENTITY';$context=$null
try{
 Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '898bb25b5cc3fca6437d8a284b11e71045cb6e74e073acb848affa0498ae58d9'){throw 'source'}
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$context=$null
 $sql=@'
BEGIN READ ONLY;SET LOCAL statement_timeout=15000;
WITH target AS(SELECT * FROM phase08_meta_ads.sync_runs WHERE connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1' AND trigger='SCHEDULED' AND actor_user_id IS NULL AND from_date='2026-10-15' AND to_date='2026-10-15' AND request_key='schedule:phase08-cafe24:'||encode(sha256(convert_to('2026-10-16T01:15:00.000Z','UTF8')),'hex'))
SELECT current_database()='postgres' AND current_user='postgres' AND current_setting('transaction_read_only')='on' AS identity,
(SELECT count(*)::int FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app') AS stopped,
(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS leases,
(SELECT count(*)::int FROM target) AS runs,
(SELECT count(*)::int FROM phase08_meta_ads.sync_unit_checkpoints p JOIN target r ON r.id=p.run_id WHERE p.expires_at>clock_timestamp()) AS checkpoints,
md5(jsonb_build_object('run',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM target r),'unit',(SELECT jsonb_agg(to_jsonb(u) ORDER BY u.run_id,u.unit_key) FROM phase08_meta_ads.run_units u JOIN target r ON r.id=u.run_id),'checkpoint',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.run_id,p.unit_key) FROM phase08_meta_ads.sync_unit_checkpoints p JOIN target r ON r.id=p.run_id))::text) AS digest;
COMMIT;
'@
 $stage='FIXED_READONLY';$rows=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($rows.Count -ne 1){throw 'rows'};$r=$rows[0]
 if(@($r.PSObject.Properties.Name).Count -ne 6 -or $r.identity -isnot [bool] -or -not $r.identity -or $r.digest -isnot [string] -or $r.digest -cnotmatch '^[a-f0-9]{32}$'){throw 'shape'}
 foreach($p in @(@('stopped',1),@('leases',0),@('runs',1),@('checkpoints',1))){$n=$p[0];if(($r.$n -isnot [int] -and $r.$n -isnot [long]) -or $r.$n -ne $p[1]){throw 'count'}}
 if($Phase -ceq 'after'){
  $stage='SAME_IMAGE_BINDING';$before=Get-Content -Raw -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-cafe-restart-before-actual-20261016.json'|ConvertFrom-Json -AsHashtable -DateKind String -Depth 8
  $receipt=Get-Content -Raw -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-v19-deployment-restart-actual-20261016.json'|ConvertFrom-Json -AsHashtable -DateKind String -Depth 8
  if($before.state -cne 'PHASE08_CAFE_RESTART_CHECKPOINT_OBSERVED' -or $before.phase -cne 'before' -or $before.sourceSha -cne $pins.sourceSha -or $before.digest -cne $r.digest -or $before.deploymentId -ceq $pins.deploymentId -or $receipt.state -cne 'PHASE08_OCTOBER16_DEPLOYMENT_VERIFIED' -or $receipt.sourceSha -cne $pins.sourceSha -or $receipt.action -cne 'restart' -or $receipt.sameImageVerified -isnot [bool] -or -not $receipt.sameImageVerified -or $receipt.previousDeploymentId -cne $before.deploymentId -or $receipt.deploymentId -cne $pins.deploymentId){throw 'continuity'}
 }
 $out=@{state='PHASE08_CAFE_RESTART_CHECKPOINT_OBSERVED';phase=$Phase;observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;digest=$r.digest;checkpointCount=1;expiredCheckpointCount=0;globalStopped=$true;activeLeases=0;checkpointPreservedAcrossVerifiedRestart=($Phase -ceq 'after');appHttpRequests=0;providerRequests=0;databaseWrites=0}
 $null=Write-Phase08SchedulerPublicEvidence $out ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-cafe-restart-$Phase-actual-20261016.json");$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_CAFE_RESTART_CHECKPOINT_FAILED';stage=$stage;rawErrorSuppressed=$true;appHttpRequests=0;providerRequests=0;databaseWrites=0}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$rows=$null}
