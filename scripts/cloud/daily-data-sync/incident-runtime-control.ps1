param([Parameter(Mandatory)][ValidateSet('Prepare','Apply','Login','PrepareForward','ApplyForward','Submit','Status','Ready','SyncLocal','VerifyLocalSync')][string]$Mode,[ValidateSet(1,2)][int]$Revision=1)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$commit='515f26250892e47f30ff2de9ab32af21d22d9da9';$source='8d02f3e8dbb6021a1fb5a02174ed4a7af707b904b658e243014cda6d499da3cb'
$planName='runtime-merge-v1';$suffix='';$expectedSubmitBefore='33677c6c-2142-4938-b7f0-95e96f5de86b'
if($Revision -eq 2){$commit='5bda544ec579a15745a93f89ee4fbc69bb7102f5';$source='6d60d1662730508e19af171124310b82693c0687d86efdd76fa0663f367a767e';$planName='runtime-merge-v2';$suffix='-v2';$expectedSubmitBefore='66bd4971-65f0-44f3-9756-f640e0f2ce69'}
$stage='START';$mutation=$false;$headers=$null;$plain=$null;$encrypted=$null;$all=$null
function Assert-IncidentExactCustomEnvironment($Expected){$r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope;Assert-IncidentVarsEqual $r.variables $Expected}
function Write-IncidentRuntimeReceipt($Value,[string]$Name){Write-IncidentReceipt $Value ($Name+$suffix)}
function Read-IncidentLocalContextExact {
 $p=Get-Phase08ProtectedPaths;Assert-Phase08PrivatePath $p.File;$bytes=$null;$plainBytes=$null;$cipher=$null
 try{$bytes=[IO.File]::ReadAllBytes($p.File);$magic=[Text.Encoding]::ASCII.GetBytes('PHASE08-DPAPI-1');if($bytes.Length -gt 1056768 -or $bytes.Length -lt 32){throw 'LOCAL_SIZE'};for($i=0;$i -lt $magic.Length;$i++){if($bytes[$i] -ne $magic[$i]){throw 'LOCAL_MAGIC'}};$cipher=$bytes[$magic.Length..($bytes.Length-1)];$plainBytes=[Security.Cryptography.ProtectedData]::Unprotect($cipher,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);$r=[Text.Encoding]::UTF8.GetString($plainBytes)|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String;if($r.version -ne 1 -or $r.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr'){throw 'LOCAL_BINDING'};return $r.context}finally{foreach($a in @($bytes,$cipher,$plainBytes)){if($a){[Array]::Clear($a)}}}
}
function Assert-IncidentLocalSync($Plan,$Variables){$c=Read-IncidentLocalContextExact;Assert-IncidentVarsEqual $c.env $Variables;if($c.runtimePassword -cne [Uri]::UnescapeDataString(([Uri]$Variables.DATABASE_URL).UserInfo.Split(':',2)[1]) -or $c.ids.storageSubject -cne $Plan.storageSubject -or $c.storageExpiresAt -cne $Plan.storageExpiresAt){throw 'LOCAL_FIELDS_SYNC'}}
try{
 Import-Phase08SchedulerChildDefinitions
 $live=Get-IncidentState;$snap=Get-IncidentSnapshot;Assert-IncidentContained $snap
 if($Mode -ceq 'Status'){@{kind='INCIDENT_RELEASE_STATUS';deploymentId=$live.serviceInstance.latestDeployment.id;status=$live.serviceInstance.latestDeployment.status;active=@($live.serviceInstance.activeDeployments);sourceSha=$live.variables.PHASE08_SOURCE_CONTENT_SHA256;releaseId=$live.variables.RELEASE_GIT_SHA;runtimeLogin=$snap.runtime_role.login;backends=$snap.runtime_backends;stopped=$snap.stopped;paused=$snap.paused;activeJobs=$snap.active_jobs;leases=$snap.live_leases}|ConvertTo-Json -Depth 8;exit 0}
 if($Mode -cin @('PrepareForward','ApplyForward')){
  if($Revision -ne 2 -or $commit -cnotmatch '^[a-f0-9]{40}$' -or $source -cnotmatch '^[a-f0-9]{64}$'){throw 'FORWARD_PIN_REQUIRED'}
  $oldPlan=Read-IncidentPrivate 'runtime-merge-v1';Assert-IncidentExactCustomEnvironment $oldPlan.after
  if($live.serviceInstance.latestDeployment.id -cne $expectedSubmitBefore -or $snap.runtime_role.login -cne $true){throw 'FORWARD_BASELINE'}
  if($Mode -ceq 'PrepareForward'){
   $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope
   $next=@{};foreach($n in $r.variables.Keys){$next[$n]=$r.variables[$n]};$next.RELEASE_GIT_SHA=$commit;$next.PHASE08_SOURCE_CONTENT_SHA256=$source
   Write-IncidentPrivate @{before=$r.variables;after=$next;commit=$commit;source=$source;storageSubject=$oldPlan.storageSubject;storageExpiresAt=$oldPlan.storageExpiresAt;storageReadCacheResidual=$oldPlan.storageReadCacheResidual;eligibleSecretRollback=$false} $planName
   Write-IncidentRuntimeReceipt @{kind='INCIDENT_FORWARD_PREPARED';at=[DateTimeOffset]::UtcNow.ToString('o');changedNames=@('RELEASE_GIT_SHA','PHASE08_SOURCE_CONTENT_SHA256');sourceSha=$source;releaseId=$commit;secretChanges=0} 'forward-prepared'
  }else{
   $plan=Read-IncidentPrivate $planName;Assert-IncidentVarsEqual $plan.before $oldPlan.after
   Write-IncidentRuntimeReceipt @{kind='INCIDENT_FORWARD_CONFIG_PLANNED';at=[DateTimeOffset]::UtcNow.ToString('o');changedNames=@('RELEASE_GIT_SHA','PHASE08_SOURCE_CONTENT_SHA256');secretChanges=0;skipDeploys=$true} 'forward-attempt'
   $stage='FORWARD_TWO_PUBLIC_PINS';$mutation=$true;$reply=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$script:IncidentScope.p;environmentId=$script:IncidentScope.e;serviceId=$script:IncidentScope.s;replace=$false;skipDeploys=$true;variables=@{RELEASE_GIT_SHA=$commit;PHASE08_SOURCE_CONTENT_SHA256=$source}}};if($reply.variableCollectionUpsert -cne $true){throw 'FORWARD_UNKNOWN'};Assert-IncidentExactCustomEnvironment $plan.after
   Write-IncidentRuntimeReceipt @{kind='INCIDENT_FORWARD_CONFIG_VERIFIED';at=[DateTimeOffset]::UtcNow.ToString('o');secretChanges=0;customEnvironmentExactMatch=$true} 'forward-applied'
  }
 }elseif($Mode -ceq 'Prepare'){
  if($Revision -ne 1){throw 'INITIAL_PREPARE_REVISION'}
  $stage='FRESH_CAS_INPUT';$old=Read-IncidentPrivate 'compromised-baseline';Assert-IncidentVarsEqual $live.variables $old.variables
  if($snap.runtime_role.login -cne $false -or $snap.runtime_backends -ne 0){throw 'ROLE_NOT_HELD'}
  $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope
  $before=$r.variables;if($before.Count -ne 89 -or @($before.Keys|Where-Object{$_ -like 'RAILWAY*'}).Count -ne 0){throw 'CUSTOM_VARIABLE_BOUNDARY'}
  foreach($name in $before.Keys){if($before[$name] -cne $live.variables[$name] -or $before[$name] -match '\$\{\{'){throw 'UNEXPECTED_REFERENCE'}}
  $savedMode=$Mode;. "$PSScriptRoot/incident-storage-rotation.ps1";$Mode=$savedMode;$storage=Read-IncidentStorageMaterial
  $storageResidual=$false
  if(-not(Test-Path -LiteralPath "$script:IncidentEvidence/storage/verified.json")){
   $receiptPath="$script:IncidentEvidence/storage/residual-verified.json";if(-not(Test-Path -LiteralPath $receiptPath)){throw 'STORAGE_NOT_VERIFIED'}
   $sr=Get-Content -LiteralPath $receiptPath -Raw|ConvertFrom-Json -AsHashtable -Depth 20
   if($sr.status -cne 'PARTIAL_READ_CACHE_RESIDUAL' -or $sr.readCacheUnresolved -cne $true -or $sr.fullOldBearerRevocationProven -cne $false -or $sr.ownFixtureRemoved -cne $true){throw 'STORAGE_RESIDUAL_BOUNDARY'}
   $storageResidual=$true
  }
  $savedMode=$Mode;. "$PSScriptRoot/incident-crypto-control.ps1";$Mode=$savedMode;$crypto=Read-IncidentCryptoEnvironmentUpdate -Operation '20261019-crypto-rotation-a'
  $fresh=Read-IncidentPrivate 'fresh-core-v2';$after=@{};foreach($name in $before.Keys){$after[$name]=$before[$name]}
  foreach($name in $fresh.changes.Keys){$after[$name]=$fresh.changes[$name]};foreach($name in $crypto.set.Keys){$after[$name]=$crypto.set[$name]}
  $after.SUPABASE_STORAGE_ACCESS_TOKEN=$storage.newToken;$after.SUPABASE_STORAGE_TOKEN_SUBJECT=$storage.newSubject
  $after.DAILY_SYNC_FEATURE_ENABLED='false';$after.DAILY_SYNC_SCHEDULE_ENABLED='false';$after.RELEASE_GIT_SHA=$commit;$after.PHASE08_SOURCE_CONTENT_SHA256=$source
  $remove=@($crypto.remove)+@('PHASE08_GOOGLE_ADC_JSON_B64','PHASE08_META_RECORD_B64','DAILY_SYNC_META_VAULT_KEY','DAILY_SYNC_CAFE24_CLIENT_SECRET','PHASE08_META_CATALOG_GZIP_B64','PHASE08_META_REPORT_SCHEMA_GZIP_B64')
  foreach($name in $remove){[void]$after.Remove($name)}
  if($after.ContainsKey('DAILY_SYNC_CREDENTIAL_KEY_V1') -or $after.SUPABASE_SECRET_KEY -cne $before.SUPABASE_SECRET_KEY){throw 'KEY_BOUNDARY'}
  Write-IncidentPrivate @{before=$before;after=$after;renderedBefore=$live.variables;commit=$commit;source=$source;removedNames=$remove;storageSubject=$storage.newSubject;storageExpiresAt=$storage.expiresAt;storageReadCacheResidual=$storageResidual;eligibleSecretRollback=$false} 'runtime-merge-v1'
  Write-IncidentReceipt @{kind='INCIDENT_RUNTIME_MERGE_PREPARED';at=[DateTimeOffset]::UtcNow.ToString('o');base='FRESH_UNRENDERED_SERVICE_ONLY';oldCustomCount=$before.Count;newCustomCount=$after.Count;removedNames=$remove;sharedSupabaseKeyUnchanged=$true;otherConsumersModified=0;featureEnabled=$false;scheduleEnabled=$false;sourceSha=$source;releaseId=$commit;storageReadCacheResidual=$storageResidual;fullIncidentResolved=$false} 'runtime-prepared'
 }elseif($Mode -ceq 'Apply'){
  if($Revision -ne 1){throw 'INITIAL_APPLY_REVISION'};$plan=Read-IncidentPrivate $planName;Assert-IncidentVarsEqual $live.variables $plan.renderedBefore
  $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope;Assert-IncidentVarsEqual $r.variables $plan.before
  if($snap.runtime_role.login -cne $false -or $snap.runtime_backends -ne 0){throw 'ROLE_NOT_HELD'}
  Write-IncidentReceipt @{kind='INCIDENT_ATOMIC_SCOPED_VARIABLE_REPLACE_PLANNED';at=[DateTimeOffset]::UtcNow.ToString('o');scope=$script:IncidentScope;freshCustomCount=$plan.before.Count;skipDeploys=$true;productionChanges=0} 'runtime-apply-attempt'
  $stage='ONE_ATOMIC_FRESH_VARIABLE_REPLACE';$mutation=$true;$reply=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$script:IncidentScope.p;environmentId=$script:IncidentScope.e;serviceId=$script:IncidentScope.s;replace=$true;skipDeploys=$true;variables=$plan.after}}
  if($reply.variableCollectionUpsert -cne $true){throw 'UNKNOWN_VARIABLE_OUTCOME'}
  $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope;Assert-IncidentVarsEqual $r.variables $plan.after
  $current=Get-IncidentState;if($current.serviceInstance.latestDeployment.id -cne $live.serviceInstance.latestDeployment.id){throw 'UNEXPECTED_DEPLOYMENT'}
  Write-IncidentReceipt @{kind='INCIDENT_RUNTIME_VARIABLES_REPLACED';at=[DateTimeOffset]::UtcNow.ToString('o');scope=$script:IncidentScope;newCustomCount=$r.variables.Count;freshReadExactMatch=$true;oldV1Removed=$true;providerCapsulesRemoved=$true;autoDeploymentCreated=$false;sharedExternalCredentialsChanged=0} 'runtime-applied'
 }elseif($Mode -ceq 'Login'){
  if($Revision -ne 1){throw 'INITIAL_LOGIN_REVISION'};$plan=Read-IncidentPrivate $planName;Assert-IncidentExactCustomEnvironment $plan.after
  if($snap.runtime_role.login -cne $false -or $snap.runtime_backends -ne 0){throw 'ROLE_NOT_HELD'}
  Write-IncidentReceipt @{kind='INCIDENT_REPLACED_PASSWORD_LOGIN_PLANNED';at=[DateTimeOffset]::UtcNow.ToString('o');runtimeRole='phase08_runtime';providerGrantsRemainHeld=$true} 'runtime-login-attempt'
  $stage='SCOPED_LOGIN';$mutation=$true
  $sql="BEGIN;SET LOCAL lock_timeout='3s';DO `$g`$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app') OR EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE enabled) OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE NOT paused) OR EXISTS(SELECT 1 FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='phase08_runtime') OR EXISTS(SELECT 1 FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints')) THEN RAISE EXCEPTION 'INCIDENT_LOGIN_GUARD';END IF;END `$g`$;ALTER ROLE phase08_runtime LOGIN;COMMIT;"
  $null=Invoke-Phase08Management -Action Query -Query $sql;$after=Get-IncidentSnapshot;Assert-IncidentContained $after
  if($after.runtime_role.login -cne $true -or $after.runtime_grants_md5 -cne $snap.runtime_grants_md5 -or (Get-IncidentHash $after.table_digests) -cne (Get-IncidentHash $snap.table_digests)){throw 'LOGIN_PRESERVATION'}
  Write-IncidentReceipt @{kind='INCIDENT_NEW_PASSWORD_LOGIN_ENABLED';at=[DateTimeOffset]::UtcNow.ToString('o');grantsPreserved=$true;businessPreserved=$true;externalProvidersHeld=$true} 'runtime-login'
 }elseif($Mode -ceq 'Submit'){
  $plan=Read-IncidentPrivate $planName;Assert-IncidentExactCustomEnvironment $plan.after
  if($live.serviceInstance.latestDeployment.id -cne $expectedSubmitBefore -or $snap.runtime_role.login -cne $true){throw 'SUBMIT_BASELINE'}
  $upload="C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019/upload-v$Revision";$m=Get-Content "$upload/source-content-manifest.json" -Raw|ConvertFrom-Json -AsHashtable
  if($m.sourceContentSha256 -cne $source){throw 'SOURCE_IDENTITY'};foreach($f in $m.files){$path=Join-Path $upload $f.name;if((Get-Item $path).Length -ne $f.size -or (Get-FileHash $path).Hash.ToLowerInvariant() -cne $f.sha256){throw 'SOURCE_BYTES'}}
  if(@(Get-ChildItem $upload -Recurse -Force -File).Count -ne ($m.files.Count+1)){throw 'EXTRA_UPLOAD_FILES'}
  Write-IncidentRuntimeReceipt @{kind='INCIDENT_ISOLATED_DEPLOYMENT_PLANNED';at=[DateTimeOffset]::UtcNow.ToString('o');scope=$script:IncidentScope;sourceSha=$source;releaseId=$commit;sourceFileCount=$m.files.Count;productionChanges=0;providerRequests=0} 'release-submit-attempt'
  $stage='SINGLE_ISOLATED_UPLOAD';$mutation=$true
  $discard=& 'C:/Users/seong/AppData/Local/npm-cache/_npx/79fa66f96c8fdacf/node_modules/@railway/cli/bin/railway.exe' up $upload --path-as-root --project $script:IncidentScope.p --environment $script:IncidentScope.e --service $script:IncidentScope.s --detach --json --message "Isolated incident credential retirement revision $Revision" 2>&1
  $exit=$LASTEXITCODE;$discard=$null;$current=Get-IncidentState
  Write-IncidentRuntimeReceipt @{kind='INCIDENT_ISOLATED_DEPLOYMENT_SUBMITTED';at=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$current.serviceInstance.latestDeployment.id;status=$current.serviceInstance.latestDeployment.status;cliExitCode=$exit;outcomeUncertain=($exit -ne 0);retryPerformed=$false} 'release-submitted';if($exit -ne 0){throw 'UPLOAD_UNKNOWN'}
 }elseif($Mode -ceq 'Ready'){
  $plan=Read-IncidentPrivate $planName;$raw=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope;Assert-IncidentVarsEqual $raw.variables $plan.after
  $expected=(Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'incident-fingerprint.mjs') @{env=$plan.after;imageTag="meta-ads-incident:20261019-v$Revision"}).fingerprint
  if($live.variables.RELEASE_GIT_SHA -cne $commit -or $live.variables.PHASE08_SOURCE_CONTENT_SHA256 -cne $source -or $live.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $live.variables.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false'){throw 'READY_ENV'}
  $d=$live.serviceInstance.latestDeployment;$active=@($live.serviceInstance.activeDeployments);if($d.status -cnotin @('SUCCESS','SLEEPING') -or $active.Count -ne 1 -or $active[0].id -cne $d.id -or $d.meta.imageDigest -cnotmatch '^sha256:[a-f0-9]{64}$'){throw 'READY_DEPLOYMENT'}
  $headers=@{'x-internal-probe-token'=$live.variables.INTERNAL_PROBE_TOKEN};$stage='NEW_PROBE_READY';$response=Invoke-WebRequest -Uri 'https://phase08-daily-data-sync-production.up.railway.app/backend-api/health/ready' -Headers $headers -MaximumRedirection 0 -TimeoutSec 60 -SkipHttpErrorCheck
  if([int]$response.StatusCode -ne 200){throw 'READY_HTTP'};$body=$response.Content|ConvertFrom-Json -AsHashtable;if($body.status -cne 'ready' -or $body.releaseId -cne $commit -or $body.runtimeConfigFingerprint -cne $expected){throw 'READY_BINDING'}
  $receipt=@{kind='INCIDENT_RELEASE_VERIFIED';at=[DateTimeOffset]::UtcNow.ToString('o');scope=$script:IncidentScope;deploymentId=$d.id;sourceSha=$source;releaseId=$commit;runtimeConfigFingerprint=$body.runtimeConfigFingerprint;imageDigest=$d.meta.imageDigest;readyStatus=200;providerRequests=0;productionChanges=0};Write-IncidentRuntimeReceipt $receipt 'release-verified';$receipt|ConvertTo-Json;exit 0
 }elseif($Mode -ceq 'VerifyLocalSync'){
  $stage='VERIFY_COMMITTED_LOCAL_CONTEXT';$plan=Read-IncidentPrivate $planName;Assert-IncidentExactCustomEnvironment $plan.after
  if(-not(Test-Path "$script:IncidentEvidence/release-verified$suffix.json")){throw 'RELEASE_REQUIRED'};Assert-IncidentLocalSync $plan $live.variables
  $paths=Get-Phase08ProtectedPaths;Assert-Phase08PrivatePath (Join-Path $paths.Root 'runtime-before-incident-20261019.dpapi')
  Write-IncidentRuntimeReceipt @{kind='INCIDENT_ACTIVE_LOCAL_CONTEXT_SYNCED';at=[DateTimeOffset]::UtcNow.ToString('o');freshEnvironmentExactMatch=$true;passwordAndSubjectAndExpirySynced=$true;oldEncryptedBackupQuarantined=$true;eligibleSecretRollback=$false;verificationOnlyAfterCommittedReplace=$true;dateParsing='PRESERVE_LITERAL_STRINGS';productionChanges=0} 'local-synced'
 }elseif($Mode -ceq 'SyncLocal'){
  $plan=Read-IncidentPrivate $planName;Assert-IncidentExactCustomEnvironment $plan.after
  if(-not(Test-Path "$script:IncidentEvidence/release-verified$suffix.json")){throw 'RELEASE_REQUIRED'}
  $context=Read-Phase08ProtectedJson;$paths=Get-Phase08ProtectedPaths;$oldHash=(Get-FileHash $paths.File).Hash
  $context.env=$live.variables;$context.ids.storageSubject=$plan.storageSubject;$context.storageExpiresAt=$plan.storageExpiresAt
  $context.runtimePassword=[Uri]::UnescapeDataString(([Uri]$live.variables.DATABASE_URL).UserInfo.Split(':',2)[1])
  $json=@{version=1;projectRef='ehnfrrmbkvlsbpvqcvkr';context=$context}|ConvertTo-Json -Depth 40 -Compress
  $plain=[Text.Encoding]::UTF8.GetBytes($json);$encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);$magic=[Text.Encoding]::ASCII.GetBytes('PHASE08-DPAPI-1');$all=[byte[]]::new($magic.Length+$encrypted.Length);[Array]::Copy($magic,0,$all,0,$magic.Length);[Array]::Copy($encrypted,0,$all,$magic.Length,$encrypted.Length)
  $temp=Join-Path $paths.Root 'runtime-incident-sync-20261019.dpapi';$backup=Join-Path $paths.Root 'runtime-before-incident-20261019.dpapi';$stream=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($all);$stream.Flush($true)}finally{$stream.Dispose()};Set-Phase08NewPrivateAcl $temp
  if((Get-FileHash $paths.File).Hash -cne $oldHash){throw 'LOCAL_CONTEXT_CAS'};$stage='LOCAL_ATOMIC_REPLACE';$mutation=$true;[IO.File]::Replace($temp,$paths.File,$backup);Set-Phase08NewPrivateAcl $paths.File;Set-Phase08NewPrivateAcl $backup
  Assert-IncidentLocalSync $plan $live.variables
  Write-IncidentRuntimeReceipt @{kind='INCIDENT_ACTIVE_LOCAL_CONTEXT_SYNCED';at=[DateTimeOffset]::UtcNow.ToString('o');freshEnvironmentExactMatch=$true;storageSubjectSynced=$true;oldEncryptedBackupQuarantined=$true;eligibleSecretRollback=$false;productionChanges=0} 'local-synced'
 }
 @{kind='INCIDENT_RUNTIME_ACTION_COMPLETED';mode=$Mode;rawValuesReturned=0;productionChanges=0}|ConvertTo-Json
}catch{@{kind='INCIDENT_RUNTIME_SAFE_REJECTION';mode=$Mode;stage=$stage;outcomeUncertain=$mutation;rawErrorSuppressed=$true;inspectBeforeRetry=$true}|ConvertTo-Json;exit 1}
finally{if($headers){$headers.Clear()};foreach($bytes in @($plain,$encrypted,$all)){if($bytes -is [byte[]]){[Array]::Clear($bytes)}};$plan=$null;$before=$null;$after=$null;$r=$null;$fresh=$null;$storage=$null;$crypto=$null;$context=$null;$live=$null}
