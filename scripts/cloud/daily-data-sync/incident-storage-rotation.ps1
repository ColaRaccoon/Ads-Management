param([ValidateSet('Prepare','Apply','Verify','VerifyCachedReadResidual','Inspect','Cleanup')][string]$Mode,
 [string]$ExpectedDeploymentId='33677c6c-2142-4938-b7f0-95e96f5de86b',
 [string]$ExpectedSourceSha='0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1',
 [string]$CacheDiagnosticPath,[string]$CacheDiagnosticSha256)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. 'C:/Users/seong/Desktop/workspace/Meta-Ads-Performance-security-rbac/보안단계별적용/증거/0908-staging-db-roles/phase2-secret-lib.ps1'
$script:IncidentStorageRoot='C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019/storage'
$script:IncidentStoragePrivate=Join-Path $script:IncidentStorageRoot 'incident-storage-material.dpapi'
$script:IncidentStorageEntropy=[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase10/IncidentStorage/20261019/v1')
$script:IncidentStorageChangedFields=@()
$script:IncidentStorageProbe=@{}
function Write-IncidentStorageReceipt($Value,[string]$Name){
 $path=Join-Path $script:IncidentStorageRoot ($Name+'.json');$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 15));$f=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$f.Write($bytes)}finally{$f.Dispose()}
}
function Save-IncidentStorageMaterial($Value){
 $plain=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Compress -Depth 40));$sealed=$null
 try{$sealed=[Security.Cryptography.ProtectedData]::Protect($plain,$script:IncidentStorageEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);$f=[IO.File]::Open($script:IncidentStoragePrivate,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$f.Write($sealed)}finally{$f.Dispose()};Set-Phase08NewPrivateAcl $script:IncidentStoragePrivate}finally{[Array]::Clear($plain);if($sealed){[Array]::Clear($sealed)}}
}
function Read-IncidentStorageMaterial {
 Assert-Phase08PrivatePath $script:IncidentStoragePrivate;$cipher=[IO.File]::ReadAllBytes($script:IncidentStoragePrivate);$plain=$null
 try{$plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$script:IncidentStorageEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);return ([Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String)}finally{[Array]::Clear($cipher);if($plain){[Array]::Clear($plain)}}
}
function Invoke-IncidentStorageOffline($InputValue){
 $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.ArgumentList.Add("$PSScriptRoot/incident-storage-rotation.mjs")
 $psi.Environment.Clear();foreach($k in @('PATH','SystemRoot','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($k)){$psi.Environment[$k]=[Environment]::GetEnvironmentVariable($k)}}
 $child=[Diagnostics.Process]::new();$child.StartInfo=$psi;$wire=$null;$raw=$null
 try{$null=$child.Start();$out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync();$wire=$InputValue|ConvertTo-Json -Compress -Depth 40;$child.StandardInput.Write($wire);$child.StandardInput.Close();if(-not $child.WaitForExit(20000)){$child.Kill($true);throw 'OFFLINE_TIMEOUT'};$raw=$out.GetAwaiter().GetResult();$null=$err.GetAwaiter().GetResult();if($child.ExitCode -ne 0 -or $raw.Length -gt 2000000){throw 'OFFLINE_REJECTED'};return ($raw|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String)}finally{$wire=$null;$raw=$null;$InputValue=$null;$child.Dispose()}
}
function Get-IncidentStorageSnapshot {
 # Management's /read-only route uses a different principal. The reviewed SQL
 # explicitly opens BEGIN READ ONLY; Query preserves the required postgres identity.
 $sql=(Invoke-IncidentStorageOffline @{operation='snapshot'}).sql;$rows=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($rows.Count -ne 1){throw 'SNAPSHOT_ROW_COUNT'}
 if($rows[0].database -cne 'postgres'){throw 'SNAPSHOT_DATABASE_IDENTITY'}
 if($rows[0].principal -cne 'postgres'){throw 'SNAPSHOT_PRINCIPAL_IDENTITY'}
 if($rows[0].object_count -gt 1000){throw 'SNAPSHOT_OBJECT_LIMIT'}
 # Management returns PSCustomObject; normalize in memory before dictionary CAS.
 return ($rows[0]|ConvertTo-Json -Depth 40 -Compress|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String)
}
function Assert-IncidentStorageOwnFixtureStillPresent($Material){
 if($Material.fixtureKey -cnotmatch '^uploads/incident-storage-[a-f0-9]{32}$'){throw 'FIXTURE_SCOPE_REJECTED'}
 $key=$Material.fixtureKey
 $sql=@"
BEGIN READ ONLY;SET LOCAL statement_timeout='20s';
SELECT current_database()='postgres' AND current_user='postgres' AS identity_bound,
(SELECT count(*) FROM storage.objects WHERE bucket_id='meta-ads-phase08-isolated' AND name='$key') AS own_rows,
(SELECT count(*) FROM storage.objects WHERE bucket_id='meta-ads-phase08-isolated' AND name<>'$key') AS original_rows,
(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id)::text,'')) FROM storage.objects x WHERE bucket_id='meta-ads-phase08-isolated' AND name<>'$key') AS original_md5;
COMMIT;
"@
 $rows=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($rows.Count -ne 1 -or $rows[0].identity_bound -cne $true -or $rows[0].own_rows -ne 1 -or $rows[0].original_rows -ne $Material.before.object_count -or $rows[0].original_md5 -cne $Material.before.objects_md5){throw 'OLD_DELETE_EFFECT_NOT_DENIED'}
}
function Get-IncidentStorageLive {
 $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId sleepApplication latestDeployment{id status meta}}}' @{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
 $v=$r.variables;$i=$r.serviceInstance
 if($ExpectedDeploymentId -cne '33677c6c-2142-4938-b7f0-95e96f5de86b' -or $ExpectedSourceSha -cne '0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1' -or $i.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or $i.environmentId -cne 'd261a432-a6a4-4031-b8ea-c619ac263cc3' -or $i.sleepApplication -cne $true -or $i.latestDeployment.id -cne $ExpectedDeploymentId -or $i.latestDeployment.status -cne 'SLEEPING' -or $v.PHASE08_SOURCE_CONTENT_SHA256 -cne $ExpectedSourceSha){throw 'LIVE_BINDING_REJECTED'}
 return $r
}
function Invoke-IncidentStorageRequest($Context,[string]$Token,[string]$Method,[string]$Key,[byte[]]$Body,[ValidateSet('Object','Info')][string]$RouteKind='Object',[switch]$NoCache){
 if($Context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $Context.env.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $Context.env.SUPABASE_STORAGE_BUCKET -cne 'meta-ads-phase08-isolated' -or $Key -match '(^/|\.\.|[\x00-\x1f?#])' -or $Key.Length -gt 1024){throw 'REQUEST_SCOPE_REJECTED'}
 if(($RouteKind -ceq 'Info' -or $NoCache) -and ($Method -cne 'Get' -or $Key -cne 'health/readiness-sentinel')){throw 'REQUEST_SCOPE_REJECTED'}
 $encoded=(@($Key.Split('/')|ForEach-Object {[Uri]::EscapeDataString($_)}) -join '/');$route=if($RouteKind -ceq 'Info'){'object/info/authenticated'}elseif($Method -ceq 'Get'){'object/authenticated'}else{'object'};$headers=@{apikey=$Context.env.SUPABASE_PUBLISHABLE_KEY;Authorization=('Bearer '+$Token)};if($NoCache){$headers['Cache-Control']='no-cache, no-store';$headers.Pragma='no-cache'};$response=$null
 try{$suffix=if($Method -ceq 'Delete'){''}else{'/'+$encoded};$query=if($NoCache){'?incident='+[Guid]::NewGuid().ToString('N')}else{''};$params=@{Uri=($Context.env.SUPABASE_URL+'/storage/v1/'+$route+'/'+$Context.env.SUPABASE_STORAGE_BUCKET+$suffix+$query);Method=$Method;Headers=$headers;MaximumRedirection=0;TimeoutSec=30;SkipHttpErrorCheck=$true};if($Method -ceq 'Delete'){$params.Body=@{prefixes=@($Key)}|ConvertTo-Json -Compress;$params.ContentType='application/json'}elseif($null -ne $Body){$params.Body=$Body;$params.ContentType='application/octet-stream'};$response=Invoke-WebRequest @params;$bytes=[byte[]]@();if($Method -ceq 'Get' -and [int]$response.StatusCode -eq 200 -and $RouteKind -ceq 'Object'){$bytes=$response.RawContentStream.ToArray()};if($bytes.Length -gt 52428800){throw 'BODY_LIMIT'};return @{status=[int]$response.StatusCode;sha256=if($Method -ceq 'Get' -and [int]$response.StatusCode -eq 200 -and $RouteKind -ceq 'Object'){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([byte[]]$bytes)).ToLowerInvariant()}else{$null};bytes=$bytes.Length}}catch{throw 'STORAGE_HTTP_FAILED'}finally{$headers.Clear();$response=$null;$Body=$null}
}
function Assert-IncidentStoragePreserved($Before,$After){
 if($Before -isnot [Collections.IDictionary] -or $After -isnot [Collections.IDictionary]){throw 'PRESERVATION_INPUT_SHAPE'}
 foreach($k in @('objects_md5','object_count','buckets_md5','grants_md5','unrelated_policy_md5')){if($Before[$k] -cne $After[$k]){
  if($k -ceq 'objects_md5' -and $Before.object_field_md5 -is [Collections.IDictionary] -and $After.object_field_md5 -is [Collections.IDictionary]){$script:IncidentStorageChangedFields=@(@($Before.object_field_md5.Keys)+@($After.object_field_md5.Keys)|Sort-Object -Unique|Where-Object {$_ -cmatch '^[a-z_]{1,64}$' -and $Before.object_field_md5[$_] -cne $After.object_field_md5[$_]})}
  throw ('PRESERVATION_'+$k.ToUpperInvariant())
 }}
}
function Assert-IncidentStorageChangedPolicies($Material,$After){$null=Invoke-IncidentStorageOffline @{operation='verifyPolicyChange';before=$Material.before.policies;after=$After.policies;oldSubject=$Material.oldSubject;newSubject=$Material.newSubject}}
if($MyInvocation.InvocationName -eq '.'){return}
$stage='INITIALIZE';$submitted=$false;$material=$null;$context=$null
try{
 if(-not $Mode){throw 'MODE_REQUIRED'}
 if(-not (Test-Path -LiteralPath $script:IncidentStorageRoot)){[void][IO.Directory]::CreateDirectory($script:IncidentStorageRoot);Set-Phase08NewPrivateAcl $script:IncidentStorageRoot -Directory};Assert-Phase08PrivatePath $script:IncidentStorageRoot -Directory
 Import-Phase08SchedulerChildDefinitions
 $context=Read-Phase08ProtectedJson
 if($context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $context.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c'){throw 'CONTEXT_REJECTED'}
 if($Mode -ceq 'Prepare'){
  $stage='PREPARE_LIVE';if(Test-Path -LiteralPath $script:IncidentStoragePrivate){throw 'ALREADY_PREPARED'};$live=Get-IncidentStorageLive;$v=$live.variables;if($v.Count -ne 101 -or $v.SUPABASE_STORAGE_ACCESS_TOKEN -cne $context.env.SUPABASE_STORAGE_ACCESS_TOKEN -or $v.SUPABASE_STORAGE_TOKEN_SUBJECT -cne $context.env.SUPABASE_STORAGE_TOKEN_SUBJECT){throw 'INITIAL_VARIABLES_REJECTED'}
  $stage='PREPARE_SNAPSHOT';$before=Get-IncidentStorageSnapshot
  $stage='PREPARE_CRYPTO';$keyPath=Join-Path $env:APPDATA 'MetaAdsSecurity/staging-app-runtime/signing-key.dpapi';Assert-R2ANotReparsePoint $keyPath;Assert-R2AUserSystemOnlyAcl $keyPath;$jwk=(Unprotect-R2APlaintextSecret ([IO.File]::ReadAllText($keyPath)))|ConvertFrom-Json -AsHashtable
  $jwks=Invoke-RestMethod -Uri ($context.env.SUPABASE_URL+'/auth/v1/.well-known/jwks.json') -MaximumRedirection 0 -TimeoutSec 20
  $projection=@{};foreach($k in @('SUPABASE_URL','SUPABASE_DATABASE_PROJECT_REF','SUPABASE_DATABASE_SCHEMA','SUPABASE_DATABASE_RUNTIME_USER','SUPABASE_STORAGE_BUCKET','SUPABASE_STORAGE_TOKEN_ROLE','SUPABASE_STORAGE_TOKEN_SUBJECT','SUPABASE_STORAGE_ACCESS_TOKEN')){$projection[$k]=$v[$k]}
  $material=Invoke-IncidentStorageOffline @{operation='prepare';env=$projection;jwk=$jwk;publicJwks=$jwks;policies=$before.policies};$jwk=$null;$projection=$null
  # Customer upload/report contents are never fetched. Only the existing health sentinel is read.
  $stage='PREPARE_SENTINEL';
  $old=Invoke-IncidentStorageRequest $context $material.oldToken Get 'health/readiness-sentinel' $null;$new=Invoke-IncidentStorageRequest $context $material.newToken Get 'health/readiness-sentinel' $null;if($old.status -ne 200 -or $new.status -notin @(400,401,403,404)){throw 'BEFORE_SUBJECT_BOUNDARY_REJECTED'}
  $stage='PREPARE_READ_PRESERVATION';$afterReads=Get-IncidentStorageSnapshot;Assert-IncidentStoragePreserved $before $afterReads;if($before.policy_md5 -cne $afterReads.policy_md5){throw 'PREPARE_POLICY_CHANGED'}
  $material.before=$before;$material.sentinelHash=$old.sha256;$material.sentinelBytes=$old.bytes;$material.fixtureKey='uploads/incident-storage-'+[Guid]::NewGuid().ToString('N');$material.expectedDeploymentId=$ExpectedDeploymentId;$material.expectedSourceSha=$ExpectedSourceSha;$material.preparedAt=[DateTimeOffset]::UtcNow.ToString('o');Save-IncidentStorageMaterial $material
  $receipt=@{kind='INCIDENT_STORAGE_PREPARED';status='PASS';objectCount=$before.object_count;originalObjectsMetadataCaptured=$true;customerObjectBodyReads=0;sentinelHashCaptured=$true;oldReadStatus=$old.status;newBeforeReadStatus=$new.status;newSubjectDistinct=$true;roleBucketPrefixesPreserved=$true;sharedSigningKeyRotated=$false;apiKeysRotated=$false;remoteMutations=0;materialFile='incident-storage-material.dpapi';rawErrorSuppressed=$true};Write-IncidentStorageReceipt $receipt 'prepared';$receipt|ConvertTo-Json;exit 0
 }
 $material=Read-IncidentStorageMaterial
 if($material.expectedDeploymentId -cne $ExpectedDeploymentId -or $material.expectedSourceSha -cne $ExpectedSourceSha -or $material.fixtureKey -cnotmatch '^uploads/incident-storage-[a-f0-9]{32}$'){throw 'MATERIAL_BINDING_REJECTED'}
 if($Mode -ceq 'Apply'){
  $stage='APPLY_LIVE';$live=Get-IncidentStorageLive;if($live.variables.SUPABASE_STORAGE_ACCESS_TOKEN -cne $material.oldToken -or $live.variables.SUPABASE_STORAGE_TOKEN_SUBJECT -cne $material.oldSubject){throw 'LIVE_TOKEN_CAS_REJECTED'}
  $stage='APPLY_SNAPSHOT';$now=Get-IncidentStorageSnapshot;Assert-IncidentStoragePreserved $material.before $now;if($now.policy_md5 -cne $material.before.policy_md5){throw 'POLICY_CAS_REJECTED'}
  $sql=(Invoke-IncidentStorageOffline @{operation='sql';oldSubject=$material.oldSubject;newSubject=$material.newSubject;policies=$material.before.policies;policyMd5=$material.before.policy_md5;objectsMd5=$material.before.objects_md5;bucketsMd5=$material.before.buckets_md5;grantsMd5=$material.before.grants_md5}).sql
  Write-IncidentStorageReceipt @{kind='INCIDENT_STORAGE_APPLY_BEGUN';at=[DateTimeOffset]::UtcNow.ToString('o');retryMutation=$false} 'apply-begun';$stage='APPLY_TRANSACTION';$submitted=$true;$discard=Invoke-Phase08Management -Action Query -Query $sql;$discard=$null;$sql=$null
  $after=Get-IncidentStorageSnapshot;Assert-IncidentStoragePreserved $material.before $after;Assert-IncidentStorageChangedPolicies $material $after
  $receipt=@{kind='INCIDENT_STORAGE_POLICY_APPLIED';status='PASS';subjectPoliciesChanged=6;roleGrantsBucketsObjectsPreserved=$true;sharedSigningKeyRotated=$false;apiKeysRotated=$false;environmentWrites=0;rawErrorSuppressed=$true};Write-IncidentStorageReceipt $receipt 'applied';$receipt|ConvertTo-Json;exit 0
 }
 $stage='INSPECT_CURRENT';$after=Get-IncidentStorageSnapshot;Assert-IncidentStorageChangedPolicies $material $after
 if($Mode -ceq 'Inspect'){$receipt=@{kind='INCIDENT_STORAGE_INSPECT';newSubjectPolicyBound=$true;originalObjectSnapshotMatches=($after.objects_md5 -ceq $material.before.objects_md5);objectCount=$after.object_count;rawErrorSuppressed=$true};$receipt|ConvertTo-Json;exit 0}
 if($Mode -ceq 'Cleanup'){
  $stage='CLEANUP_OWN_FIXTURE';$r=Invoke-IncidentStorageRequest $context $material.newToken Delete $material.fixtureKey $null;$after=Get-IncidentStorageSnapshot;Assert-IncidentStoragePreserved $material.before $after;$receipt=@{kind='INCIDENT_STORAGE_CLEANUP';ownFixtureDeleteStatus=$r.status;originalObjectsPreserved=$true;rawErrorSuppressed=$true};Write-IncidentStorageReceipt $receipt ('cleanup-'+[Guid]::NewGuid().ToString('N'));$receipt|ConvertTo-Json;exit 0
 }
 Assert-IncidentStoragePreserved $material.before $after
 $stage='VERIFY_SENTINEL';$checks=@();$r=Invoke-IncidentStorageRequest $context $material.newToken Get 'health/readiness-sentinel' $null;$script:IncidentStorageProbe=@{httpStatus=$r.status;hashMatches=($r.sha256 -ceq $material.sentinelHash);lengthMatches=($r.bytes -eq $material.sentinelBytes)}
 if($r.status -ne 200){throw 'VERIFY_SENTINEL_STATUS'};if($r.sha256 -cne $material.sentinelHash){throw 'VERIFY_SENTINEL_HASH'};if($r.bytes -ne $material.sentinelBytes){throw 'VERIFY_SENTINEL_LENGTH'};$checks+=@{name='new_sentinel_read';status=$r.status}
 $residualMode=$Mode -ceq 'VerifyCachedReadResidual'
 if($residualMode){
  $stage='RESIDUAL_EVIDENCE_BINDING';$cachePath=[IO.Path]::GetFullPath($CacheDiagnosticPath);$cacheBase=[IO.Path]::GetFullPath($script:IncidentStorageRoot)+[IO.Path]::DirectorySeparatorChar
  if(-not $cachePath.StartsWith($cacheBase,[StringComparison]::OrdinalIgnoreCase) -or $CacheDiagnosticSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'CACHE_DIAGNOSTIC_BINDING'};$cacheInfo=Get-Item -LiteralPath $cachePath;if($cacheInfo.Length -gt 262144 -or ($cacheInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-FileHash -LiteralPath $cachePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $CacheDiagnosticSha256){throw 'CACHE_DIAGNOSTIC_BINDING'}
  $cache=[IO.File]::ReadAllText($cachePath)|ConvertFrom-Json -AsHashtable -Depth 15 -DateKind String
  if($cache.kind -cne 'INCIDENT_STORAGE_NATIVE_CACHE_DIAGNOSTIC' -or $cache.oldBareReadStillAllowed -cne $true -or $cache.cacheBustedOldDenied -cne $true -or $cache.fullOldBearerRevocationProven -cne $false -or $cache.oldTokenHashMatchesPrepared -cne $true -or $cache.newTokenHashMatchesPrepared -cne $true){throw 'CACHE_DIAGNOSTIC_BINDING'}
 }
 $stage='VERIFY_RETIRED_SENTINEL';$r=Invoke-IncidentStorageRequest $context $material.oldToken Get 'health/readiness-sentinel' $null;$script:IncidentStorageProbe.retiredReadStatus=$r.status
 if(-not $residualMode -and $r.status -notin @(400,401,403,404)){throw 'OLD_READ_NOT_REVOKED'}
 if($residualMode -and $r.status -ne 200){throw 'RESIDUAL_EXPECTED_BARE_CACHE_200'};$checks+=@{name=$(if($residualMode){'retired_read_cached_residual_not_pass'}else{'retired_read'});status=$r.status}
 if($residualMode){
  $stage='VERIFY_ORIGIN_INFO_OLD';$r=Invoke-IncidentStorageRequest $context $material.oldToken Get 'health/readiness-sentinel' $null -RouteKind Info -NoCache;if($r.status -notin @(400,401,403,404)){throw 'OLD_ORIGIN_INFO_NOT_DENIED'};$checks+=@{name='retired_origin_info';status=$r.status}
  $stage='VERIFY_ORIGIN_INFO_NEW';$r=Invoke-IncidentStorageRequest $context $material.newToken Get 'health/readiness-sentinel' $null -RouteKind Info -NoCache;if($r.status -ne 200){throw 'NEW_ORIGIN_INFO_NOT_ALLOWED'};$checks+=@{name='new_origin_info';status=$r.status}
 }
 # A POST with unknown result is never retried. Cleanup is separately callable.
 $stage='VERIFY_BEGIN_GUARD';Write-IncidentStorageReceipt @{kind='INCIDENT_STORAGE_VERIFY_BEGUN';at=[DateTimeOffset]::UtcNow.ToString('o');retryMutation=$false;cachedReadResidualMode=$residualMode} $(if($residualMode){'verify-residual-begun'}else{'verify-begun'})
 $stage='VERIFY_OLD_INSERT';$body=[Text.Encoding]::ASCII.GetBytes('incident-storage-scope-v1');$submitted=$true;$r=Invoke-IncidentStorageRequest $context $material.oldToken Post $material.fixtureKey $body;if($r.status -notin @(400,401,403,404)){throw 'OLD_INSERT_NOT_REVOKED'};$checks+=@{name='retired_insert';status=$r.status}
 $stage='VERIFY_NEW_INSERT';$r=Invoke-IncidentStorageRequest $context $material.newToken Post $material.fixtureKey $body;if($r.status -notin @(200,201)){throw 'NEW_INSERT_REJECTED'};$checks+=@{name='new_insert';status=$r.status}
 $stage='VERIFY_FIXTURE';$r=Invoke-IncidentStorageRequest $context $material.newToken Get $material.fixtureKey $null;$expectedHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($body)).ToLowerInvariant();if($r.status -ne 200 -or $r.sha256 -cne $expectedHash){throw 'NEW_READ_REJECTED'};$checks+=@{name='new_read';status=$r.status}
 foreach($pair in @(@('old_update',$material.oldToken,'Put'),@('new_update',$material.newToken,'Put'),@('retired_delete',$material.oldToken,'Delete'))){$r=Invoke-IncidentStorageRequest $context $pair[1] $pair[2] $material.fixtureKey $(if($pair[2] -ceq 'Put'){$body}else{$null});$deniedStatuses=if($pair[2] -ceq 'Delete'){@(200,400,401,403,404)}else{@(400,401,403,404)};if($r.status -notin $deniedStatuses){throw 'DENIED_OPERATION_NOT_REJECTED'};$checks+=@{name=$pair[0];status=$r.status;noOriginalObjectTargeted=$true}}
 $r=Invoke-IncidentStorageRequest $context $material.newToken Get $material.fixtureKey $null;if($r.status -ne 200 -or $r.sha256 -cne $expectedHash){throw 'DENIED_MUTATION_CHANGED_FIXTURE'}
 $stage='VERIFY_OLD_DELETE_DATABASE_EFFECT';Assert-IncidentStorageOwnFixtureStillPresent $material;$checks+=@{name='retired_delete_database_noop_and_originals_preserved';ownFixtureRows=1;originalRowsAndHashMatched=$true}
 $stage='VERIFY_NEW_DELETE';$r=Invoke-IncidentStorageRequest $context $material.newToken Delete $material.fixtureKey $null;if($r.status -notin @(200,204)){throw 'NEW_DELETE_REJECTED'};$checks+=@{name='new_delete';status=$r.status}
 $after=Get-IncidentStorageSnapshot;Assert-IncidentStoragePreserved $material.before $after
 $receipt=@{kind='INCIDENT_STORAGE_VERIFIED';status=$(if($residualMode){'PARTIAL_READ_CACHE_RESIDUAL'}else{'PASS'});checks=$checks;oldBearerActuallyRejected=(-not $residualMode);fullOldBearerRevocationProven=(-not $residualMode);readCacheUnresolved=$residualMode;originInfoOldDenied=$residualMode;nativeCacheDiagnosticSha256=$(if($residualMode){$CacheDiagnosticSha256}else{$null});newCreateReadDeleteAllowed=$true;newUpdateStillDenied=$true;oldDeleteDatabaseNoopVerified=$true;existingObjectCount=$after.object_count;sentinelContentHashMatched=$true;customerObjectBodyReads=0;originalObjectsMetadataMatched=$true;originalObjectBodyHashesVerified=$false;ownFixtureRemoved=$true;sharedSigningKeyRotated=$false;apiKeysRotated=$false;environmentWrites=0;rawErrorSuppressed=$true};Write-IncidentStorageReceipt $receipt $(if($residualMode){'residual-verified'}else{'verified'});$receipt|ConvertTo-Json -Depth 8
}catch{$knownCode=if($_.Exception.Message -cin @('SNAPSHOT_ROW_COUNT','SNAPSHOT_DATABASE_IDENTITY','SNAPSHOT_PRINCIPAL_IDENTITY','SNAPSHOT_OBJECT_LIMIT','PHASE08_MANAGEMENT_QUERY_FAILED','OFFLINE_REJECTED','PRESERVATION_INPUT_SHAPE','PRESERVATION_OBJECTS_MD5','PRESERVATION_OBJECT_COUNT','PRESERVATION_BUCKETS_MD5','PRESERVATION_GRANTS_MD5','PRESERVATION_UNRELATED_POLICY_MD5','STORAGE_HTTP_FAILED','VERIFY_SENTINEL_STATUS','VERIFY_SENTINEL_HASH','VERIFY_SENTINEL_LENGTH','OLD_READ_NOT_REVOKED')){$_.Exception.Message}else{'REJECTED'};$errorClass=if($_.FullyQualifiedErrorId -cin @('CannotIndex','PropertyNotFoundStrict','InvokeMethodOnNull','MethodNotFound')){$_.FullyQualifiedErrorId}else{'SANITIZED'};$receipt=@{kind='INCIDENT_STORAGE_REJECTED';mode=$Mode;stage=$stage;safeCode=$knownCode;safeErrorClass=$errorClass;safeErrorCategory=[string]$_.CategoryInfo.Category;safeScriptLine=[int]$_.InvocationInfo.ScriptLineNumber;probe=$script:IncidentStorageProbe;changedObjectColumnNames=@($script:IncidentStorageChangedFields);preparedMaterialExists=(Test-Path -LiteralPath $script:IncidentStoragePrivate);verifyMutationMarkerExists=(Test-Path -LiteralPath (Join-Path $script:IncidentStorageRoot 'verify-begun.json'));outcomeUncertain=$submitted;retryMutation=$false;rawErrorSuppressed=$true};try{Write-IncidentStorageReceipt $receipt ('rejected-'+[Guid]::NewGuid().ToString('N'))}catch{};$receipt|ConvertTo-Json;exit 1}finally{$material=$null;$context=$null;$jwk=$null;$live=$null;$v=$null;$body=$null}
