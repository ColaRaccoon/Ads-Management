param([switch]$ObserveApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
function ConvertTo-Phase08MetaV12ContractResult($Rows){
 if(@($Rows).Count -ne 1){throw 'contract-rows'};$row=@($Rows)[0]
 $bools=@('verified','identity_verified','manual_verified','purchases_required','purchase_v1_semantics','one_measurement','raw_null_basis_verified','totals_and_retained_difference_verified','video_five_null','account_and_ad_value_equality_required','stored_parent_minus_ad_retained')
 $ints=@('ad_rows','adset_rows','derived_ad_rows','derived_adset_rows','valid_links','coverage_kinds','provider_requests','database_writes','raw_values_returned');$names=@('state','semantic_profile')+$bools+$ints
 $keys=if($row -is [Collections.IDictionary]){@($row.Keys)}else{@($row.PSObject.Properties.Name)}
 if($keys.Count -ne $names.Count -or @($names|Where-Object {$_ -cnotin $keys}).Count -ne 0){throw 'contract-shape'}
 $out=[ordered]@{};foreach($name in $names){$out[$name]=if($row -is [Collections.IDictionary]){$row[$name]}else{$row.$name}}
 if($out.state -cne 'PHASE08_META_V12_POST_SUCCESS_READONLY_CONTRACT' -or $out.semantic_profile -cne 'PURCHASE_V1'){throw 'contract-state'}
 foreach($name in $bools){if($out[$name] -isnot [bool]){throw 'contract-bool'}}
 foreach($name in $ints){if(($out[$name] -isnot [int] -and $out[$name] -isnot [long]) -or $out[$name] -lt 0 -or $out[$name] -gt 1000){throw 'contract-count'}}
 if(@($bools|Where-Object {if($_ -ceq 'account_and_ad_value_equality_required'){$out[$_]}else{-not $out[$_]}}).Count -ne 0 -or $out.ad_rows -ne 55 -or $out.adset_rows -ne 13 -or $out.valid_links -ne 68 -or $out.coverage_kinds -ne 2 -or $out.derived_ad_rows -gt 55 -or $out.derived_adset_rows -gt 13 -or $out.provider_requests -ne 0 -or $out.database_writes -ne 0 -or $out.raw_values_returned -ne 0){throw 'contract-rejected'}
 return $out
}
if($MyInvocation.InvocationName -cne '.'){
 $stage='APPROVAL';$context=$null;$prepared=$null;$rows=$null;$out=$null
 try{
  if(-not $ObserveApproved){throw 'explicit-observe-required'}
  Import-Phase08SchedulerChildDefinitions
  $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-v12-post-success-contract-actual-20261015.json'
  $stage='LOCAL_REVIEWED_PIN';$pins=Get-Phase08SchedulerPins
  if($pins.sourceSha -cne 'd1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21' -or $pins.deploymentId -cne '5dac048f-5015-46fa-8ca4-5227352c834c'){throw 'contract-pin'}
  $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
  $stage='READONLY_SQL';$prepared=Invoke-Phase08ConfigurationChild "$PSScriptRoot/meta-v12-post-success-contract.mjs" @{}
  if($prepared.state -cne 'PHASE08_META_V12_CONTRACT_SQL_PREPARED' -or $prepared.sql -isnot [string] -or $prepared.sql.Length -gt 65536 -or -not $prepared.sql.StartsWith('BEGIN READ ONLY;') -or -not $prepared.sql.EndsWith('COMMIT;')){throw 'contract-sql'}
  $rows=@(Invoke-Phase08Management -Action Query -Query $prepared.sql);$prepared=$null;$stage='STRICT_CONTRACT_RESULT';$out=ConvertTo-Phase08MetaV12ContractResult $rows
  $out['classification']='ACTUAL_READONLY_MANUAL_R3_CONTRACT';$out['sourceSha']=$pins.sourceSha;$out['deploymentId']=$pins.deploymentId;$out['observedAt']=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');$out['appHttpRequests']=0;$out['originalWeeklySuccessNotAsserted']=$true
  $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 4 -Compress
 }catch{@{state='PHASE08_META_V12_CONTRACT_OBSERVATION_FAILED';stage=$stage;providerRequests=0;appHttpRequests=0;databaseWrites=0;rawErrorSuppressed=$true;retryPerformed=$false}|ConvertTo-Json -Compress;exit 1}
 finally{$context=$null;$prepared=$null;$rows=$null;$out=$null}
}
