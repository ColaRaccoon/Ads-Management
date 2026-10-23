# Root-only three read-only closed-occurrence requests through DB/Edge/Next/Nest.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$context=$null;$stage='IDENTITY'
try {
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/normal-02-native-status-actual-20261015.json'
 $pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne '0368163a964e94086ef77ca644a6bf3d0be2ec6cfe12523cb136ec5ac02cd9fa' -or $pins.deploymentId -cne '86d5ad6d-eec8-414a-a922-9c6b8c62a245'){throw 'pins'}
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$null=Get-Phase08SchedulerGraphState $context $pins
 $stage='REVIEWED_TEMPLATE';$path=Join-Path $PSScriptRoot 'probe-relay-status.ps1'
 if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'ef1c0cba075603fd2c01abb21280a38d84e610b2e076a68ecda991b729693c73'){throw 'template'}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'template'}
 $nodes=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -ceq '$template'})
 if($nodes.Count -ne 1 -or $nodes[0].Right -isnot [Management.Automation.Language.CommandExpressionAst] -or $nodes[0].Right.Expression -isnot [Management.Automation.Language.StringConstantExpressionAst]){throw 'template'}
 $template=$nodes[0].Right.Expression.SafeGetValue();if($template -isnot [string]){throw 'template'}
 $cases=@(@{provider='CAFE24';key='phase08-cafe24';due='2026-10-14T17:00:00.000Z';days=1;first='2026-10-14'},@{provider='GOOGLE';key='phase08-google';due='2026-10-14T17:01:00.000Z';days=7;first='2026-10-08'},@{provider='META';key='phase08-meta';due='2026-10-14T17:02:00.000Z';days=7;first='2026-10-08'})
 $digestSql=@'
BEGIN READ ONLY;
SELECT (SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) AS stopped,
 (SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS live_leases,
 md5(jsonb_build_object('runs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM phase08_meta_ads.sync_runs x),'units',(SELECT jsonb_agg(to_jsonb(x) ORDER BY run_id,unit_key) FROM phase08_meta_ads.run_units x),'coverage',(SELECT jsonb_agg(to_jsonb(x) ORDER BY connection_id,data_kind,metric_date) FROM phase08_meta_ads.source_coverage x),'attempts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM daily_data_sync_ops.attempts x))::text) AS digest;
COMMIT;
'@
 $stage='READONLY_BASELINE';$before=@(Invoke-Phase08Management -Action Query -Query $digestSql)
 if($before.Count -ne 1 -or $before[0].stopped -isnot [bool] -or -not $before[0].stopped -or ($before[0].live_leases -isnot [int] -and $before[0].live_leases -isnot [long]) -or $before[0].live_leases -ne 0 -or $before[0].digest -cnotmatch '^[a-f0-9]{32}$'){throw 'baseline'}
 $results=@();$stage='CLOSED_STATUS_ONLY'
 foreach($case in $cases){
  $sql=$template.Replace('__KEY__',$case.key).Replace('__DUE__',$case.due).Replace('__FIRST__',$case.first).Replace('__DAYS__',[string]$case.days)
  $rows=@(Invoke-Phase08Management -Action Query -Query $sql)
  if($rows.Count -ne 1 -or $rows[0].code -cne 'VERIFIED' -or ($rows[0].httpStatus -isnot [int] -and $rows[0].httpStatus -isnot [long]) -or $rows[0].httpStatus -ne 200 -or $rows[0].validExpiredSummary -isnot [bool] -or -not $rows[0].validExpiredSummary -or $rows[0].noStore -isnot [bool] -or -not $rows[0].noStore){throw 'status'}
  $results+=@{provider=$case.provider;httpStatus=200;status='EXPIRED';completedUnits=0;totalUnits=$case.days;noStore=$true}
 }
 $stage='READONLY_AFTER';$after=@(Invoke-Phase08Management -Action Query -Query $digestSql)
 if($after.Count -ne 1 -or $after[0].digest -cne $before[0].digest -or $after[0].stopped -isnot [bool] -or -not $after[0].stopped -or ($after[0].live_leases -isnot [int] -and $after[0].live_leases -isnot [long]) -or $after[0].live_leases -ne 0){throw 'preservation'}
 $out=@{state='PHASE08_NORMAL_02_NATIVE_STATUS_VERIFIED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');classification='ACTUAL_DB_EDGE_NEXT_NEST_READ_ONLY_CLOSED_SLOT';results=$results;runUnitCoverageAttemptsPreserved=$true;providerCollectionStarted=$false;regularScheduleSuccess=$false;databaseWrites=0;operatingChanges=0}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 5 -Compress
}catch{@{state='PHASE08_NORMAL_02_NATIVE_STATUS_FAILED';stage=$stage;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$sql=$null;$template=$null}
