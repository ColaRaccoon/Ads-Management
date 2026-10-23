Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/phase10-independent-incident-inventory.ps1"
$stage='PRIVATE_BEFORE';$old=$null;$rows=$null;$fresh=$null
try{
 $old=Read-IncidentPrivate 'provider-hold-before';$recorded=[IO.File]::ReadAllText((Join-Path $script:IncidentEvidence 'provider-held.json'))|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String
 $stage='FRESH_READONLY';$fresh=(Get-IncidentSnapshot|ConvertTo-Json -Depth 40|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String);Assert-IncidentContained $fresh
 $sql="BEGIN READ ONLY;SET LOCAL statement_timeout=5000;SELECT CASE WHEN (SELECT count(*) FROM phase08_meta_ads.source_connections)=3 THEN (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM phase08_meta_ads.source_connections c) ELSE NULL END AS connections,(SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('cafe24_observed_order_revisions','cafe24_observed_day_checkpoints','source_credentials','sync_unit_checkpoints')) AS remaining_grants;COMMIT;"
 $rows=@((Invoke-Phase08Management -Action Query -Query $sql)|ConvertTo-Json -Depth 40|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String)
 if($rows.Count -ne 1 -or $rows[0].connections.Count -ne 3){throw 'CONNECTION_SHAPE'}
 $stage='SOURCE_FIELD_COMPARISON';$changed=[Collections.Generic.HashSet[string]]::new();$others=$true;$enabledBefore=0;$disabledAfter=0;$timestampValid=$true
 foreach($before in $old.metadata.connections){
  $matches=@($rows[0].connections|Where-Object {$_.id -ceq $before.id});if($matches.Count -ne 1){throw 'IDENTITY_SET'};$after=$matches[0]
  if((@($before.Keys|Sort-Object) -join ',') -cne (@($after.Keys|Sort-Object) -join ',')){throw 'FIELD_SET'}
  if($before.enabled -ceq $true){$enabledBefore++};if($after.enabled -ceq $false){$disabledAfter++}
  foreach($field in $before.Keys){
   if((Get-IncidentHash $before[$field]) -cne (Get-IncidentHash $after[$field])){[void]$changed.Add($field);if($field -cnotin @('enabled','updated_at')){$others=$false}}
  }
  $beforeAt=[DateTimeOffset]::Parse([string]$before.updated_at);$afterAt=[DateTimeOffset]::Parse([string]$after.updated_at)
  if($afterAt -lt $beforeAt -or $afterAt -gt [DateTimeOffset]::UtcNow.AddSeconds(30)){$timestampValid=$false}
 }
 $freshDiff=@();foreach($prior in $recorded.snapshot.table_digests){$match=@($fresh.table_digests|Where-Object{$_.table -ceq $prior.table});if($match.Count -ne 1 -or $match[0].rows -ne $prior.rows -or $match[0].md5 -cne $prior.md5){$freshDiff+=$prior.table}}
 $duringHoldDiff=@();foreach($prior in $old.snapshot.table_digests){$match=@($recorded.snapshot.table_digests|Where-Object{$_.table -ceq $prior.table});if($match.Count -ne 1 -or $match[0].rows -ne $prior.rows -or $match[0].md5 -cne $prior.md5){$duringHoldDiff+=$prior.table}}
 $preserve=@{};foreach($key in @('job_definitions_md5','other_jobs_md5','original152_md5','call_md5','storage_objects_md5')){$preserve[$key]=($old.snapshot[$key] -ceq $recorded.snapshot[$key] -and $recorded.snapshot[$key] -ceq $fresh[$key])}
 $pass=$others -and $timestampValid -and $enabledBefore -eq 3 -and $disabledAfter -eq 3 -and $rows[0].remaining_grants -eq 0 -and $fresh.runtime_role.login -ceq $false -and $fresh.runtime_backends -eq 0 -and $freshDiff.Count -eq 0 -and $duringHoldDiff.Count -eq 1 -and $duringHoldDiff[0] -ceq 'source_connections' -and @($preserve.Values|Where-Object{$_ -cne $true}).Count -eq 0
 $out=@{kind='INCIDENT_INDEPENDENT_PROVIDER_HOLD_ACTUAL';at=[DateTimeOffset]::UtcNow.ToString('o');status=$(if($pass){'PASS'}else{'FAIL'});enabledBefore=$enabledBefore;disabledAfter=$disabledAfter;sourceConnectionChangedFields=@($changed|Sort-Object);otherConnectionFieldsUnchanged=$others;updatedTimestampMonotonicAndBounded=$timestampValid;runtimeHeldTableGrants=$rows[0].remaining_grants;tableChangesDuringHold=$duringHoldDiff;freshDifferencesSinceRootHoldReceipt=$freshDiff;preserved=$preserve;runtimeLogin=$fresh.runtime_role.login;runtimeBackends=$fresh.runtime_backends;stopped=$fresh.stopped;paused=$fresh.paused;jobs=$fresh.jobs;activeJobs=$fresh.active_jobs;liveLeases=$fresh.live_leases;rawSecretsReturned=0;businessRowsOutput=0;remoteMutations=0;providerRequests=0}
 $json=$out|ConvertTo-Json -Depth 8;Assert-IndependentIncidentOutput $json @();$path=Join-Path $script:IncidentEvidence 'independent/provider-hold-v1.json';$f=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.Encoding]::UTF8.GetBytes($json);$f.Write($bytes)}finally{$f.Dispose()};$json;if(-not $pass){exit 1}
}catch{@{kind='INCIDENT_INDEPENDENT_PROVIDER_HOLD_SAFE_REJECTION';stage=$stage;errorType=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$old=$null;$rows=$null;$fresh=$null;$recorded=$null}
