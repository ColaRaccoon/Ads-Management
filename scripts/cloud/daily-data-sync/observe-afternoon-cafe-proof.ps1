param([switch]$ObserveApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
function ConvertTo-Phase08AfternoonCafeResult($Rows){
 if(@($Rows).Count -ne 1){throw 'proof-rows'};$row=@($Rows)[0]
 $bools=@('verified','identity_verified','scheduled_run_verified','policy_verified','coverage_verified','publish_audit_verified','new_version_creation_required')
 $ints=@('order_count','line_rows','current_versions','coherent_lineage_rows','current_links','new_run_current_versions','retained_prior_owner_rows','stored_order_n00_rows','stored_line_n00_rows','live_leases','remaining_checkpoints','unit_attempts','fetched_rows','policy_version','published_policy_version','provider_requests','database_writes','raw_values_returned');$names=@('state')+$bools+$ints
 $keys=if($row -is [Collections.IDictionary]){@($row.Keys)}else{@($row.PSObject.Properties.Name)}
 if($keys.Count -ne $names.Count -or @($names|Where-Object {$_ -cnotin $keys}).Count -ne 0){throw 'proof-shape'}
 $out=[ordered]@{};foreach($name in $names){$out[$name]=if($row -is [Collections.IDictionary]){$row[$name]}else{$row.$name}}
 if($out.state -isnot [string] -or $out.state -cne 'PHASE08_CAFE_AFTERNOON_READONLY'){throw 'proof-state'}
 foreach($name in $bools){if($out[$name] -isnot [bool]){throw 'proof-bool'}}
 foreach($name in $ints){$limit=if($name.EndsWith('policy_version')){2147483647}else{1000000};if(($out[$name] -isnot [int] -and $out[$name] -isnot [long]) -or $out[$name] -lt 0 -or $out[$name] -gt $limit){throw 'proof-count'}}
 if($out.new_version_creation_required -or $out.provider_requests -ne 0 -or $out.database_writes -ne 0 -or $out.raw_values_returned -ne 0){throw 'proof-constants'}
 if($out.verified -and (@(@('identity_verified','scheduled_run_verified','policy_verified','coverage_verified','publish_audit_verified')|Where-Object {-not $out[$_]}).Count -ne 0 -or $out.live_leases -ne 0 -or $out.remaining_checkpoints -ne 0 -or $out.current_versions -ne $out.line_rows -or $out.coherent_lineage_rows -ne $out.line_rows -or $out.current_links -ne $out.line_rows -or $out.order_count -gt $out.line_rows -or $out.new_run_current_versions -gt $out.current_versions -or $out.retained_prior_owner_rows -gt $out.line_rows -or $out.stored_order_n00_rows -gt $out.current_versions -or $out.stored_line_n00_rows -gt $out.current_versions -or $out.unit_attempts -lt 1 -or $out.unit_attempts -gt 3 -or $out.policy_version -lt 1 -or $out.published_policy_version -lt 1 -or $out.policy_version -notin @($out.published_policy_version,($out.published_policy_version+1)))){throw 'proof-rejected'}
 return $out
}
if($MyInvocation.InvocationName -cne '.'){
 $stage='APPROVAL';$context=$null;$prepared=$null;$rows=$null;$out=$null
 try{
  if(-not $ObserveApproved){throw 'explicit-observe-required'}
  Import-Phase08SchedulerChildDefinitions
  $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-cafe-proof-actual-20261015.json'
  $stage='LOCAL_REVIEWED_IDENTITY';$pins=Get-Phase08SchedulerPins
  if($pins.sourceSha -cne '42c15d089e41db8fb4286209bcf8975eb4c9ec3aa61b23f459aa49bd3024764f'){throw 'source-pin'}
  $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
  $stage='FIXED_READONLY_SQL';$prepared=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-cafe-proof.mjs" @{action='sql'}
  if($prepared.state -cne 'CAFE_AFTERNOON_SQL_PREPARED' -or $prepared.sql -isnot [string] -or $prepared.sql.Length -gt 65536 -or -not $prepared.sql.StartsWith('BEGIN READ ONLY;') -or -not $prepared.sql.EndsWith('COMMIT;')){throw 'sql-boundary'}
  $rows=@(Invoke-Phase08Management -Action Query -Query $prepared.sql);$prepared=$null
  $stage='STRICT_TYPED_RESULT';$out=ConvertTo-Phase08AfternoonCafeResult $rows
  if(-not $out.verified){throw 'not-complete'}
  $out['classification']='ACTUAL_SCHEDULED_CAFE_DAY_POST_PUBLISH_READONLY';$out['scheduledFor']='2026-10-15T06:40:00.000Z';$out['fromDate']='2026-10-14';$out['toDate']='2026-10-14'
  $out['sourceSha']=$pins.sourceSha;$out['deploymentId']=$pins.deploymentId;$out['observedAt']=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');$out['appHttpRequests']=0
  $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 4 -Compress
 }catch{@{state='PHASE08_AFTERNOON_CAFE_PROOF_FAILED';stage=$stage;providerRequests=0;appHttpRequests=0;databaseWrites=0;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
 finally{$context=$null;$prepared=$null;$rows=$null;$out=$null}
}
