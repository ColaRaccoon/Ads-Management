# Two fixed read-only successful status requests through DB -> Edge -> Next -> Nest.
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='IDENTITY';$context=$null
try{
 Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-complete-native-status-actual-20261016.json'
 $pins=Get-Phase08SchedulerPins;if($pins.sourceSha -cne '898bb25b5cc3fca6437d8a284b11e71045cb6e74e073acb848affa0498ae58d9'){throw 'source'}
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$graph=Get-Phase08SchedulerGraphState $context $pins
 $stage='REVIEWED_READONLY_TEMPLATE';$path=Join-Path $PSScriptRoot 'probe-relay-status.ps1'
 if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'ef1c0cba075603fd2c01abb21280a38d84e610b2e076a68ecda991b729693c73'){throw 'template-pin'}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
 $nodes=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -ceq '$template'})
 if($errors.Count -ne 0 -or $nodes.Count -ne 1 -or $nodes[0].Right -isnot [Management.Automation.Language.CommandExpressionAst] -or $nodes[0].Right.Expression -isnot [Management.Automation.Language.StringConstantExpressionAst]){throw 'template-literal'}
 $template=$nodes[0].Right.Expression.SafeGetValue()
 $oldStatus="body->>'status' IS DISTINCT FROM 'EXPIRED'";$oldCompleted="body->>'completedUnits' IS DISTINCT FROM '0'";$oldToDate="body->>'toDate' IS DISTINCT FROM '2026-10-14'"
 if($template -isnot [string] -or $template.Split($oldStatus,[StringSplitOptions]::None).Count -ne 2 -or $template.Split($oldCompleted,[StringSplitOptions]::None).Count -ne 2 -or $template.Split($oldToDate,[StringSplitOptions]::None).Count -ne 2){throw 'template-shape'}
 $template=$template.Replace($oldStatus,"body->>'status' IS DISTINCT FROM 'SUCCEEDED'").Replace($oldCompleted,"body->>'completedUnits' IS DISTINCT FROM '__DAYS__'").Replace($oldToDate,"body->>'toDate' IS DISTINCT FROM '2026-10-15'").Replace('validExpiredSummary','validCompleteSummary')
 $cases=@(@{provider='CAFE24';key='phase08-cafe24';due='2026-10-16T01:15:00.000Z';days=1;first='2026-10-15'},@{provider='META';key='phase08-meta';due='2026-10-16T01:20:00.000Z';days=7;first='2026-10-09'})
 foreach($case in $cases){$d=@($graph.appSchedules|Where-Object {$_.key -ceq $case.key});if($d.Count -ne 1 -or $d[0].anchorAt -cne $case.due){throw 'collection-config-required'}}
 $digestSql=@'
BEGIN READ ONLY;
SELECT (SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) AS stopped,
 (SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS live_leases,
 md5(jsonb_build_object('runs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM phase08_meta_ads.sync_runs x),'units',(SELECT jsonb_agg(to_jsonb(x) ORDER BY run_id,unit_key) FROM phase08_meta_ads.run_units x),'coverage',(SELECT jsonb_agg(to_jsonb(x) ORDER BY connection_id,data_kind,metric_date) FROM phase08_meta_ads.source_coverage x),'attempts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM daily_data_sync_ops.attempts x))::text) AS digest;
COMMIT;
'@
 $stage='QUIESCENT_BASELINE';$before=@(Invoke-Phase08Management -Action Query -Query $digestSql)
 if($before.Count -ne 1 -or $before[0].stopped -isnot [bool] -or -not $before[0].stopped -or ($before[0].live_leases -isnot [int] -and $before[0].live_leases -isnot [long]) -or $before[0].live_leases -ne 0 -or $before[0].digest -isnot [string] -or $before[0].digest -cnotmatch '^[a-f0-9]{32}$'){throw 'baseline'}
 $stage='SUCCESS_STATUS_ONLY';$results=@()
 foreach($case in $cases){
  $sql=$template.Replace('__KEY__',$case.key).Replace('__DUE__',$case.due).Replace('__FIRST__',$case.first).Replace('__DAYS__',[string]$case.days)
  $r=@(Invoke-Phase08Management -Action Query -Query $sql)
  if($r.Count -ne 1 -or $r[0].code -cne 'VERIFIED' -or ($r[0].httpStatus -isnot [int] -and $r[0].httpStatus -isnot [long]) -or $r[0].httpStatus -ne 200 -or $r[0].validCompleteSummary -isnot [bool] -or -not $r[0].validCompleteSummary -or $r[0].noStore -isnot [bool] -or -not $r[0].noStore){throw 'status'}
  $results+=@{provider=$case.provider;httpStatus=200;status='SUCCEEDED';completedUnits=$case.days;totalUnits=$case.days;noStore=$true}
 }
 $stage='UNCHANGED_COLLECTION';$after=@(Invoke-Phase08Management -Action Query -Query $digestSql)
 if($after.Count -ne 1 -or $after[0].stopped -isnot [bool] -or -not $after[0].stopped -or ($after[0].live_leases -isnot [int] -and $after[0].live_leases -isnot [long]) -or $after[0].live_leases -ne 0 -or $after[0].digest -cne $before[0].digest){throw 'changed'}
 $out=@{state='PHASE08_OCTOBER16_NATIVE_COMPLETE_STATUS_VERIFIED';classification='ACTUAL_DB_EDGE_NEXT_NEST_READONLY_SUCCESS_STATUS';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;results=$results;runUnitCoverageAttemptsUnchanged=$true;providerRequests=0;collectionDataWrites=0;databaseWritesScope='COLLECTION_DATA_ONLY';transportSecurityWritesExpected=$true;httpRequests=2;operatingChanges=0}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 6 -Compress
}catch{@{state='PHASE08_OCTOBER16_NATIVE_COMPLETE_STATUS_FAILED';stage=$stage;retryPerformed=$false;providerRequests=0;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$template=$null;$sql=$null;$graph=$null}
