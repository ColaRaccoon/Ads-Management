Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
. "$PSScriptRoot/incident-storage-rotation.ps1"
$destination='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261020/storage-readonly-recheck-v2.json'
$before=$null;$beforeStorage=$null;$live=$null;$material=$null;$context=$null;$raw=$null;$stage='START';$started=$false
$proof=@{kind='PHASE10_STORAGE_READONLY_RECHECK';status='FAIL';at=[DateTimeOffset]::UtcNow.ToString('o');fixedSentinelOnly=$true;customerObjectBodyReads=0;storageMutations=0;sharedCredentialChanges=0;purgeRequests=0;providerCalls=0;rawSecretsReturned=0;fullOldBearerRevocationProven=$false}
function Assert-ReadcheckStopped {
 $s=Get-IncidentState;$snapshot=Get-IncidentSnapshot;Assert-IncidentContained $snapshot
 $d=(Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){latestDeployment{id deploymentStopped} activeDeployments{id deploymentStopped}}}' @{e=$script:IncidentScope.e;s=$script:IncidentScope.s}).serviceInstance
 if($s.serviceInstance.latestDeployment.id -cne '39c6b738-6d2f-4111-a97b-37f017b39886' -or $s.serviceInstance.latestDeployment.meta.imageDigest -cne 'sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0' -or $d.latestDeployment.id -cne $s.serviceInstance.latestDeployment.id -or $d.latestDeployment.deploymentStopped -cne $true -or @($d.activeDeployments|Where-Object{$_.deploymentStopped -cne $true}).Count -ne 0 -or $s.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $s.variables.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false' -or $snapshot.runtime_role.login -cne $false -or $snapshot.runtime_backends -ne 0){throw 'READCHECK_STOPPED_TARGET'}
 $s=$null;return $snapshot
}
function Get-ReadcheckClassification($Diagnostic){
 $oldBare=@($Diagnostic.checks|Where-Object{$_.name -ceq 'old_bare_native_fetch'})[0]
 $newBare=@($Diagnostic.checks|Where-Object{$_.name -ceq 'new_bare_native_fetch'})[0]
 $oldUnique=@($Diagnostic.checks|Where-Object{$_.name -ceq 'old_no_cache_unique_query'})[0]
 $newUnique=@($Diagnostic.checks|Where-Object{$_.name -ceq 'new_no_cache_unique_query'})[0]
 $positive=$newBare.status -eq 200 -and $newUnique.status -eq 200 -and $newBare.contentMatchesExpectedSentinel -ceq $true -and $newUnique.contentMatchesExpectedSentinel -ceq $true
 $bareDenied=$oldBare.status -cin @(400,401,403,404);$uniqueDenied=$oldUnique.status -cin @(400,401,403,404)
 $oldRead=$oldBare.status -eq 200
 $status=if($positive -and $uniqueDenied -and $oldRead){'READ_CACHE_RESIDUAL_STILL_PRESENT'}
 elseif($positive -and $uniqueDenied -and $bareDenied){'NO_CACHED_RESIDUAL_OBSERVED_AT_THIS_URL'}
 elseif($oldRead){'OLD_BEARER_READ_ALLOWED_ORIGIN_DENIAL_UNPROVEN'}else{'INCONCLUSIVE_HTTP'}
 return @{status=$status;positiveNewSentinelReads=$positive;oldBareExplicitlyDenied=$bareDenied;oldUniqueExplicitlyDenied=$uniqueDenied;positiveOldSentinelReadObserved=$oldRead}
}
try {
 if(Test-Path -LiteralPath $destination){throw 'EVIDENCE_ALREADY_EXISTS'}
  if((Get-FileHash "$PSScriptRoot/incident-storage-cache-probe.ps1").Hash.ToLowerInvariant() -cne '979319256b95f083be93b82e120f926d36c15e8ebaac4df9088fb1dc075a5d71' -or (Get-FileHash "$PSScriptRoot/incident-storage-cache-probe.mjs").Hash.ToLowerInvariant() -cne '17b97a0fc50febf1affa58b66b5b56832f0622c0a40845080f5f1407f5b2031a'){throw 'PROBE_SOURCE_CHANGED'}
 $stage='FRESH_BEFORE';$before=Assert-ReadcheckStopped;$beforeStorage=Get-IncidentStorageSnapshot;$started=$true
 $live=Get-IncidentState;$material=Read-IncidentStorageMaterial;$context=Read-Phase08ProtectedJson
 if($live.variables.SUPABASE_STORAGE_ACCESS_TOKEN -cne $material.newToken -or $live.variables.SUPABASE_STORAGE_TOKEN_SUBJECT -cne $material.newSubject -or $context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $context.env.SUPABASE_URL -cne $live.variables.SUPABASE_URL -or $context.env.SUPABASE_STORAGE_BUCKET -cne $live.variables.SUPABASE_STORAGE_BUCKET -or $context.env.SUPABASE_PUBLISHABLE_KEY -cne $live.variables.SUPABASE_PUBLISHABLE_KEY){throw 'CURRENT_STORAGE_BINDING'}
 $proof.probePsSha256=(Get-FileHash "$PSScriptRoot/incident-storage-cache-probe.ps1").Hash.ToLowerInvariant()
 $proof.probeJsSha256=(Get-FileHash "$PSScriptRoot/incident-storage-cache-probe.mjs").Hash.ToLowerInvariant()
 $material=$null;$context=$null;$live=$null;$stage='FIXED_FOUR_GET_ONLY'
 $raw=(& "$PSScriptRoot/incident-storage-cache-probe.ps1"|Out-String);$diagnostic=$raw|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String;$raw=$null
 if($diagnostic.kind -cne 'INCIDENT_STORAGE_NATIVE_CACHE_DIAGNOSTIC' -or $diagnostic.checks.Count -ne 4 -or $diagnostic.mutationRequests -ne 0 -or $diagnostic.customerObjectBodyReads -ne 0 -or $diagnostic.rawSecretsReturned -ne 0 -or $diagnostic.fullOldBearerRevocationProven -cne $false){throw 'DIAGNOSTIC_SHAPE'}
 $names=@('old_bare_native_fetch','new_bare_native_fetch','old_no_cache_unique_query','new_no_cache_unique_query')
 foreach($name in $names){$c=@($diagnostic.checks|Where-Object{$_.name -ceq $name});if($c.Count -ne 1 -or $c[0].status -lt 100 -or $c[0].status -gt 599 -or ($c[0].status -eq 200 -and $c[0].contentMatchesExpectedSentinel -cne $true)){throw 'SENTINEL_ONLY_RESULT'}}
 $proof.diagnostic=$diagnostic;$classification=Get-ReadcheckClassification $diagnostic;foreach($name in $classification.Keys){$proof[$name]=$classification[$name]}
 $proof.globalCacheRevocationNotProven=$true;$proof.fourGetRequests=$true;$proof.originalCacheUrlUnchanged=$true
} catch {$proof.safeFailureStage=$stage;$proof.rawExceptionSuppressed=$true}
finally {
 if($started){
  try {$after=Assert-ReadcheckStopped;$afterStorage=Get-IncidentStorageSnapshot;Assert-IncidentStoragePreserved $beforeStorage $afterStorage
   $proof.all68Preserved=(Get-IncidentHash $before.table_digests) -ceq (Get-IncidentHash $after.table_digests)
   $proof.storagePoliciesUnchanged=$beforeStorage.policy_md5 -ceq $afterStorage.policy_md5
   $proof.storageMetadataUnchanged=$true;$proof.finalStoppedNoLoginBackend0=$true
   if(-not $proof.all68Preserved -or -not $proof.storagePoliciesUnchanged){$proof.status='FAIL_PRESERVATION'}
  }catch{$proof.status='FAIL_PRESERVATION';$proof.finalSafeErrorSuppressed=$true}
  $f=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$f.Write([Text.Encoding]::UTF8.GetBytes(($proof|ConvertTo-Json -Depth 25)))}finally{$f.Dispose()}
 }
 $before=$null;$beforeStorage=$null;$after=$null;$afterStorage=$null;$live=$null;$material=$null;$context=$null;$raw=$null;$diagnostic=$null
}
@{kind=$proof.kind;status=$proof.status;all68Preserved=$(if($proof.ContainsKey('all68Preserved')){$proof.all68Preserved}else{$false});rawSecretsReturned=0;storageMutations=0;sharedCredentialChanges=0;evidence=$destination}|ConvertTo-Json -Compress
if($proof.status -cin @('FAIL','FAIL_PRESERVATION','INCONCLUSIVE_HTTP')){exit 1}
