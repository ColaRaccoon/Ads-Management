# Definitions only. Root must load incident-common.ps1 and the definitions from
# incident-storage-rotation.ps1 first. This file never performs work on import.
function Write-IndependentIncidentCdnReceipt($Value,[string]$Name){
 if($Name -cnotin @('cdn-purge-attempt-v1','cdn-purge-result-v1')){throw 'CDN_RECEIPT_NAME'}
 $root='C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019/independent'
 $path=Join-Path $root ($Name+'.json');$json=$Value|ConvertTo-Json -Depth 12
 $bytes=[Text.Encoding]::UTF8.GetBytes($json);$file=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
}
function Invoke-IndependentIncidentSentinelCdnPurge {
 $stage='CONTAINMENT';$submitted=$false;$headers=$null;$live=$null;$baseline=$null;$material=$null;$response=$null;$status=$null;$safeCode=$null
 try{
  $live=Get-IncidentState;$gate=Get-IncidentSnapshot;Assert-IncidentContained $gate
  if($gate.runtime_role.login -cne $false -or $gate.runtime_backends -ne 0){throw 'CDN_NOT_HELD'}
  $baseline=Read-IncidentPrivate 'compromised-baseline'
  if($live.variables.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $live.variables.SUPABASE_STORAGE_BUCKET -cne 'meta-ads-phase08-isolated' -or $live.variables.SUPABASE_SECRET_KEY -cne $baseline.variables.SUPABASE_SECRET_KEY -or $live.variables.SUPABASE_SECRET_KEY -cnotmatch '^sb_secret_[A-Za-z0-9_-]+$'){throw 'CDN_KEY_SCOPE'}
  $stage='EXACT_STORAGE_POLICY_AND_OBJECT_BEFORE';$material=Read-IncidentStorageMaterial;$before=Get-IncidentStorageSnapshot
  Assert-IncidentStorageChangedPolicies $material $before;Assert-IncidentStoragePreserved $material.before $before
  if($before.object_count -ne 1){throw 'CDN_EXPECTED_SINGLE_SENTINEL'}
  # The only route is the exact single object documented by Supabase. No bucket,
  # tenant, wildcard, recursion, transformations, object DELETE, or fallback.
  $uri='https://ehnfrrmbkvlsbpvqcvkr.supabase.co/storage/v1/cdn/meta-ads-phase08-isolated/health/readiness-sentinel'
  Write-IndependentIncidentCdnReceipt @{kind='INCIDENT_EXACT_SENTINEL_CDN_PURGE_ATTEMPT';at=[DateTimeOffset]::UtcNow.ToString('o');method='DELETE';scope='SINGLE_ISOLATED_READINESS_SENTINEL_CACHE';bucket='meta-ads-phase08-isolated';object='health/readiness-sentinel';objectDelete=$false;broaderFallbackAllowed=$false;automaticRetryAllowed=$false;secretValuesReturned=0} 'cdn-purge-attempt-v1'
  $stage='ONE_EXACT_CACHE_PURGE';$headers=@{apikey=$live.variables.SUPABASE_SECRET_KEY};$submitted=$true
  $response=Invoke-WebRequest -Uri $uri -Method Delete -Headers $headers -MaximumRedirection 0 -TimeoutSec 20 -SkipHttpErrorCheck
  $status=[int]$response.StatusCode
  if($status -ne 200){
   if($response.Content.Length -le 8192){try{$errorBody=$response.Content|ConvertFrom-Json -AsHashtable -Depth 5;if($errorBody.ContainsKey('code') -and $errorBody.code -cin @('FeatureNotEnabled','AccessDenied','NoSuchBucket','NoSuchKey')){$safeCode=$errorBody.code}}catch{}}
   throw 'CDN_NO_SUCCESS'
  }
  if($response.Content.Length -gt 8192){throw 'CDN_REPLY_BOUND'}
  $reply=$response.Content|ConvertFrom-Json -AsHashtable -Depth 5;if($reply.message -cne 'success'){throw 'CDN_SUCCESS_SHAPE'}
  $response=$null;$headers.Clear();$headers=$null
  $stage='READONLY_PRESERVATION';$after=Get-IncidentStorageSnapshot
  Assert-IncidentStorageChangedPolicies $material $after;Assert-IncidentStoragePreserved $before $after
  if($before.policy_md5 -cne $after.policy_md5){throw 'CDN_POLICY_CHANGED'}
  $afterGate=Get-IncidentSnapshot;Assert-IncidentContained $afterGate
  if((Get-IncidentHash $gate.table_digests) -cne (Get-IncidentHash $afterGate.table_digests) -or $gate.runtime_grants_md5 -cne $afterGate.runtime_grants_md5){throw 'CDN_BUSINESS_CHANGED'}
  $result=@{kind='INCIDENT_EXACT_SENTINEL_CDN_PURGE_QUEUED';at=[DateTimeOffset]::UtcNow.ToString('o');status='QUEUED_NOT_YET_REVOKED';httpStatus=200;purgeRequestCount=1;objectBodyOrMetadataChanges=0;storageObjectsPoliciesGrantsBucketsPreserved=$true;business68TablesPreserved=$true;oldBearerHttpDenialVerified=$false;allEdgeNodesPurgeVerified=$false;browserCacheErasureVerified=$false;propagationMaximumDocumentedSeconds=60;broaderFallbackPerformed=$false;providerRequests=0;rawSecretValuesReturned=0}
  Write-IndependentIncidentCdnReceipt $result 'cdn-purge-result-v1';return $result
 }catch{
  $safe=@{kind='INCIDENT_EXACT_SENTINEL_CDN_PURGE_SAFE_REJECTION';stage=$stage;httpStatus=$status;safeCode=$safeCode;mutationSubmitted=$submitted;outcomeUncertain=$submitted;automaticRetryAllowed=$false;broaderFallbackAllowed=$false;inspectBeforeNextAction=$true;rawErrorSuppressed=$true}
  if($submitted){try{Write-IndependentIncidentCdnReceipt $safe 'cdn-purge-result-v1'}catch{}}
  return $safe
 }finally{if($headers){$headers.Clear()};$headers=$null;$live=$null;$baseline=$null;$material=$null;$response=$null;$errorBody=$null;$reply=$null}
}
