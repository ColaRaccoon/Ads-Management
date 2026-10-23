Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/phase10-independent-incident-inventory.ps1"
. "$PSScriptRoot/incident-crypto-control.ps1"
. "$PSScriptRoot/incident-storage-rotation.ps1"
$stage='INITIALIZE'
try{
 $base=Read-IncidentPrivate 'compromised-baseline';$plan=Read-IncidentPrivate 'runtime-merge-v2'
 $prior=Get-Content (Join-Path $script:IncidentEvidence 'final-held.json') -Raw|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String
 $stage='FRESH_DATABASE_READONLY';$fresh=Get-IncidentSnapshot|ConvertTo-Json -Depth 40|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String;Assert-IncidentContained $fresh
 $heldDiff=@();$initialDiff=@();$inventory=@()
 foreach($t in $fresh.table_digests){
  $p=@($prior.snapshot.table_digests|Where-Object{$_.table -ceq $t.table});$b=@($base.snapshot.table_digests|Where-Object{$_.table -ceq $t.table})
  if($p.Count -ne 1 -or $b.Count -ne 1){throw 'TABLE_IDENTITIES'}
  if($p[0].md5 -cne $t.md5 -or $p[0].rows -ne $t.rows){$heldDiff+=$t.table}
  if($b[0].md5 -cne $t.md5 -or $b[0].rows -ne $t.rows){$initialDiff+=$t.table}
  $inventory+=@{table=$t.table;beforeRows=$b[0].rows;afterRows=$t.rows;beforeMd5=$b[0].md5;afterMd5=$t.md5}
 }
 $allowed=@('source_connections','source_credentials','sync_unit_checkpoints','run_units','security_audit_events','app_auth_sessions','app_users','security_rate_limit_buckets')
 $unexpected=@($initialDiff|Where-Object{$_ -cnotin $allowed})
 $preserved=@{};foreach($k in @('job_definitions_md5','other_jobs_md5','original152_md5','call_md5','storage_objects_md5')){$preserved[$k]=($base.snapshot[$k] -ceq $fresh[$k])}
 $stage='BOUNDED_COUNTS_READONLY'
 $sql=@'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout='15s';
SELECT current_database()='postgres' AND current_user='postgres' AS bound,
(SELECT count(*)::int FROM phase08_meta_ads.source_connections WHERE enabled) AS enabled_providers,
(SELECT count(*)::int FROM phase08_meta_ads.app_auth_sessions WHERE revoked_at IS NULL) AS unrevoked_sessions,
(SELECT count(*)::int FROM phase08_meta_ads.report_exports WHERE status='CREATING') AS creating_reports,
(SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints')) AS held_grants,
(SELECT jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'super',rolsuper,'bypass',rolbypassrls,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication) ORDER BY rolname) FROM pg_roles WHERE rolname IN('phase08_runtime','phase08_storage_app')) AS roles,
(SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN('phase08_runtime','phase08_storage_app')) AS memberships;
COMMIT;
'@
 $counts=@(Invoke-Phase08Management -Action Query -Query $sql);if($counts.Count -ne 1 -or $counts[0].bound -cne $true){throw 'COUNT_SCOPE'};$counts=$counts[0]|ConvertTo-Json -Depth 10|ConvertFrom-Json -AsHashtable -Depth 10
 $stage='STORAGE_READONLY_AND_OFFLINE_POLICY_COMPARE';$material=Read-IncidentStorageMaterial;$storage=Get-IncidentStorageSnapshot;Assert-IncidentStoragePreserved $material.before $storage;Assert-IncidentStorageChangedPolicies $material $storage
 $stage='CRYPTO_READONLY_AND_OFFLINE_OLD_NEW_COMPARE';$op='20261019-crypto-rotation-a';$names=Get-IncidentCryptoNames $op;$cp=Read-IncidentPrivate $names.plan;$keys=Read-IncidentPrivate $names.keys;$inputValue=Get-IncidentCryptoInput $cp $keys $base;$cipher=Get-IncidentCryptoSnapshot;$crypto=Invoke-IncidentCryptoOffline @{operation='VERIFY';input=$inputValue;after=$cipher}
 $stage='MANAGEMENT_GRAPH_STATE_READONLY';$live=Get-IncidentState
 $stage='MANAGEMENT_GRAPH_VARIABLES_READONLY';$raw=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope
 $stage='MANAGEMENT_GRAPH_STOPPED_READONLY';$stop=Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status deploymentStopped} activeDeployments{id status deploymentStopped}}}' @{e=$script:IncidentScope.e;s=$script:IncidentScope.s};$raw.serviceInstance=$stop.serviceInstance
 $stage='MANAGEMENT_CONFIG_CAS';Assert-IncidentVarsEqual $raw.variables $plan.after
 $latest=$raw.serviceInstance.latestDeployment;$active=@($raw.serviceInstance.activeDeployments);$unstopped=@($active|Where-Object{$_.deploymentStopped -cne $true})
 if($latest.id -cne '906da6a9-09cd-411a-981b-833b4640abd6' -or $raw.serviceInstance.serviceId -cne $script:IncidentScope.s -or $raw.serviceInstance.environmentId -cne $script:IncidentScope.e){throw 'GRAPH_SCOPE'}
 $removed=@('DAILY_SYNC_CREDENTIAL_KEY_V1','PHASE08_GOOGLE_ADC_JSON_B64','PHASE08_META_RECORD_B64','DAILY_SYNC_META_VAULT_KEY','DAILY_SYNC_CAFE24_CLIENT_SECRET');$removedAbsent=$true;foreach($n in $removed){if($raw.variables.Contains($n)){$removedAbsent=$false}}
 $stage='FIXED_SHARED_CONSUMERS_METADATA_READONLY'
 $callback=$null;$callbackVerified=$false
 try{$callback=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId}}' @{p=$script:IncidentScope.p;e=$script:IncidentScope.e;s='deaaeaf9-ee5c-42fa-b32f-600c7a90befc'}
  if($callback.serviceInstance.serviceId -ceq 'deaaeaf9-ee5c-42fa-b32f-600c7a90befc' -and $callback.serviceInstance.environmentId -ceq $script:IncidentScope.e){$callbackVerified=$true}
 }catch{$callback=$null}
 $stage='GOOGLE_ORIGINAL_LOCAL_COMPARE';$adc=(Read-IndependentIncidentFile (Join-Path $env:APPDATA 'gcloud/application_default_credentials.json') 65536)|ConvertFrom-Json -AsHashtable -Depth 20
 $oldAdc=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($base.variables.PHASE08_GOOGLE_ADC_JSON_B64))|ConvertFrom-Json -AsHashtable -Depth 20
 $stage='META_ORIGINAL_LOCAL_COMPARE';$mcp=Read-IndependentIncidentMetaToken 'mcp-access-token.dpapi';$inspector=Read-IndependentIncidentMetaToken 'inspector-token.dpapi';$meta=Get-IndependentIncidentMetaEquality $base.variables $mcp $inspector
 $sharing=@{fixedCallbackFreshManagementComparisonVerified=$callbackVerified;fixedCallbackCafeSecretStillEqualsExposed=$(if($callbackVerified){$callback.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET -ceq $base.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET}else{$null});initialActualCallbackComparisonEvidence='shared-scope-v1.json';googleOriginalClientSecretStillEqualsExposed=($adc.source_credentials.client_secret -ceq $oldAdc.source_credentials.client_secret);googleOriginalRefreshTokenStillEqualsExposed=($adc.source_credentials.refresh_token -ceq $oldAdc.source_credentials.refresh_token);metaOffline=$meta;externalProviderRequests=0;operatingSecretsRead=0;consumerCoverageNotExhaustive=$true}
 $roleUnsafe=@($counts.roles|Where-Object{$_.login -or $_.super -or $_.bypass -or $_.createdb -or $_.createrole -or $_.replication})
 $pass=$heldDiff.Count -eq 0 -and $unexpected.Count -eq 0 -and @($preserved.Values|Where-Object{$_ -cne $true}).Count -eq 0 -and $fresh.runtime_role.login -ceq $false -and $fresh.runtime_backends -eq 0 -and $counts.enabled_providers -eq 0 -and $counts.unrevoked_sessions -eq 0 -and $counts.creating_reports -eq 0 -and $counts.held_grants -eq 0 -and $counts.memberships -eq 0 -and $roleUnsafe.Count -eq 0 -and $crypto.verified -ceq $true -and $latest.deploymentStopped -ceq $true -and $unstopped.Count -eq 0 -and $removedAbsent
 $out=@{kind='INCIDENT_INDEPENDENT_FINAL_ACTUAL_READONLY';at=[DateTimeOffset]::UtcNow.ToString('o');status=$(if($pass){'PASS_CONTAINMENT_WITH_EXTERNAL_RESIDUALS'}else{'FAIL'});crossPlatformAtomicSnapshot=$false;appHttpRequests=0;providerRequests=0;remoteMutations=0;rawValuesReturned=0;deployment=@{id=$latest.id;statusMetadata=$latest.status;deploymentStopped=$latest.deploymentStopped;activeMetadataCount=$active.Count;unstoppedDeploymentCount=$unstopped.Count;historyPreserved=$true};database=@{runtimeLogin=$fresh.runtime_role.login;runtimeBackends=$fresh.runtime_backends;forceRls=$fresh.force_rls;liveLeases=$fresh.live_leases;stopped=$fresh.stopped;paused=$fresh.paused;jobs=$fresh.jobs;activeJobs=$fresh.active_jobs;counts=$counts};preserved=$preserved;tablesChangedSinceIncidentBaseline=$initialDiff;unexpectedTablesChanged=$unexpected;tablesChangedSinceFinalHold=$heldDiff;tableHashInventory=$inventory;storage=@{originalObjectCount=$storage.object_count;originalMetadataAndBucketsAndGrantsUnchanged=$true;exactSubjectPolicyChangesVerified=$true;customerBodiesRead=0;fullOldBearerRevocationProven=$false;readCacheUnresolved=$true};crypto=$crypto;configuration=@{exactFreshV2MapMatches=$true;removedProviderAndV1ValuesAbsent=$removedAbsent;sharedSupabaseSecretUnchanged=($raw.variables.SUPABASE_SECRET_KEY -ceq $base.variables.SUPABASE_SECRET_KEY);source=$raw.variables.PHASE08_SOURCE_CONTENT_SHA256;release=$raw.variables.RELEASE_GIT_SHA};externalSharedRevocationVerified=$false;incidentResolved=$false;oldBackupSecretRollbackAllowed=$false}
 $stage='OUTPUT_SECRET_GUARD';$out.sharedSourceComparison=$sharing
 $json=$out|ConvertTo-Json -Depth 20;$secretLiterals=@();$secretNames=@('AUTH_SESSION_HANDLE_SECRET','AUTH_AUTHORIZATION_VERSION_SECRET','AUTH_CSRF_SECRET','INTERNAL_PROBE_TOKEN','DAILY_SYNC_MACHINE_TOKEN','DATABASE_URL','DAILY_SYNC_CREDENTIAL_KEY_V1','DAILY_SYNC_CHECKPOINT_KEY_B64','SUPABASE_SECRET_KEY','SUPABASE_STORAGE_ACCESS_TOKEN','PHASE08_GOOGLE_ADC_JSON_B64','PHASE08_META_RECORD_B64','DAILY_SYNC_META_VAULT_KEY','DAILY_SYNC_CAFE24_CLIENT_SECRET')+@($cp.prepared.environmentUpdate.set.Keys)
 foreach($v in @($base.variables,$raw.variables)){foreach($n in $secretNames){if($v.Contains($n)){$secretLiterals+=[string]$v[$n]}}};Assert-IndependentIncidentOutput $json $secretLiterals
 $path=Join-Path $script:IncidentEvidence 'independent/final-actual-readonly-v1.json';$f=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.Encoding]::UTF8.GetBytes($json);$f.Write($bytes)}finally{$f.Dispose()}
 @{kind=$out.kind;at=$out.at;status=$out.status;deployment=$out.deployment;changedSinceBaseline=$initialDiff;changedSinceHold=$heldDiff;unexpectedChanges=$unexpected;cryptoVerified=$crypto.verified;stopped=$fresh.stopped;runtimeLogin=$fresh.runtime_role.login;runtimeBackends=$fresh.runtime_backends;unrevokedSessions=$counts.unrevoked_sessions;creatingReports=$counts.creating_reports;incidentResolved=$false}|ConvertTo-Json -Depth 8
 if(-not $pass){exit 1}
}catch{@{kind='INCIDENT_INDEPENDENT_FINAL_SAFE_REJECTION';stage=$stage;errorType=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;rawErrorSuppressed=$true;remoteMutations=0}|ConvertTo-Json;exit 1}
finally{$base=$null;$plan=$null;$raw=$null;$live=$null;$material=$null;$storage=$null;$cp=$null;$keys=$null;$inputValue=$null;$cipher=$null;$callback=$null;$adc=$null;$oldAdc=$null;$mcp=$null;$inspector=$null}
