param([Parameter(Mandatory)][ValidateSet('Prepare','Activate','PrepareReadTest','EnableReadTest','AbortBeforeSubmit','Submit','Status','Ready','Restore','RestoreReady','Final')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261020'
$release='177315f2e89ccdf87443086ec9987589efcd934c';$source='bb35f2a9563ce80ff9477fb17eb9db568ca268dd273fff506e8fb76136aac8d2'
$securityDeployment='906da6a9-09cd-411a-981b-833b4640abd6';$securityImage='sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0'
$privateName='resume-20261020-v3';$stage='START';$mutated=$false;$headers=$null
function Save-Resume($Value,[string]$Name){
 $path=Join-Path $root ($Name+'.json');$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 40));$f=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$f.Write($bytes);$f.Flush($true)}finally{$f.Dispose()}
}
function Read-Resume([string]$Name){Get-Content -LiteralPath (Join-Path $root ($Name+'.json')) -Raw|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String}
function Get-ResumeCustom { (Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope).variables }
function Get-ResumeStopped { (Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){latestDeployment{id status deploymentStopped} activeDeployments{id status deploymentStopped}}}' @{e=$script:IncidentScope.e;s=$script:IncidentScope.s}).serviceInstance }
function Get-ResumeResources {
 $r=Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstanceLimits(environmentId:$e,serviceId:$s) serviceInstanceLimitOverride(environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId numReplicas region healthcheckPath healthcheckTimeout overlapSeconds drainingSeconds sleepApplication}}' @{e=$script:IncidentScope.e;s=$script:IncidentScope.s}
 if($r.serviceInstanceLimits.containers.cpu -ne 1 -or $r.serviceInstanceLimits.containers.memoryBytes -ne 1000000000 -or $r.serviceInstance.numReplicas -ne 1 -or $r.serviceInstance.sleepApplication -cne $true){throw 'RESOURCE_BOUNDARY'};return $r
}
function Get-ResumeAuth {
 @(Invoke-Phase08Management -Action Query -Query @'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
DO $g$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' THEN RAISE EXCEPTION 'AUTH_SNAPSHOT_IDENTITY';END IF;END $g$;
SELECT current_database() AS db,current_user AS principal,(SELECT md5(coalesce(jsonb_agg(to_jsonb(x)-'last_login_at'-'updated_at' ORDER BY id)::text,'[]')) FROM phase08_meta_ads.app_users x) AS users_stable,
(SELECT count(*)::int FROM phase08_meta_ads.app_users) AS users_count,
(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'hash',md5(to_jsonb(x)::text)) ORDER BY id),'[]') FROM phase08_meta_ads.app_auth_sessions x) AS sessions,
(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'hash',md5(to_jsonb(x)::text)) ORDER BY id),'[]') FROM phase08_meta_ads.security_audit_events x) AS audits,
(SELECT count(*)::int FROM phase08_meta_ads.app_auth_sessions WHERE revoked_at IS NULL) AS unrevoked;
COMMIT;
'@)[0]
}
function Assert-ResumeHeld($Live,$Snap){
 Assert-IncidentContained $Snap
 if($Live.variables.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false'){throw 'SCHEDULE_HOLD'}
 if($Live.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -and ($Live.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'true' -or $Live.variables.RELEASE_GIT_SHA -cne $release -or $Live.variables.PHASE08_SOURCE_CONTENT_SHA256 -cne $source -or $Mode -cin @('Prepare','PrepareReadTest','Activate'))){throw 'READ_FEATURE_SCOPE'}
 $c=@(Invoke-Phase08Management -Action Query -Query "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT current_database() AS db,current_user AS principal,(SELECT count(*)::int FROM phase08_meta_ads.source_connections) AS connections,(SELECT count(*)::int FROM phase08_meta_ads.source_connections WHERE enabled) AS enabled,(SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints')) AS grants,(SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='phase08_runtime') AS memberships,(SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication FROM pg_roles WHERE rolname='phase08_runtime') AS restricted;COMMIT;")[0]
 if($c.db -cne 'postgres' -or $c.principal -cne 'postgres' -or $c.connections -ne 3 -or $c.enabled -ne 0 -or $c.grants -ne 0 -or $c.memberships -ne 0 -or $c.restricted -cne $true){throw 'PROVIDER_HOLD'}
 foreach($n in @('DAILY_SYNC_CREDENTIAL_KEY_V1','PHASE08_GOOGLE_ADC_JSON_B64','PHASE08_META_RECORD_B64','DAILY_SYNC_META_VAULT_KEY','DAILY_SYNC_CAFE24_CLIENT_SECRET','PHASE08_META_CATALOG_GZIP_B64','PHASE08_META_REPORT_SCHEMA_GZIP_B64')){if($Live.variables.ContainsKey($n)){throw 'RETIRED_ENV_PRESENT'}}
}
function Set-ResumePins($Expected,$Next){
 Assert-IncidentVarsEqual (Get-ResumeCustom) $Expected
 $reply=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$script:IncidentScope.p;environmentId=$script:IncidentScope.e;serviceId=$script:IncidentScope.s;replace=$false;skipDeploys=$true;variables=@{RELEASE_GIT_SHA=$Next.RELEASE_GIT_SHA;PHASE08_SOURCE_CONTENT_SHA256=$Next.PHASE08_SOURCE_CONTENT_SHA256;DAILY_SYNC_FEATURE_ENABLED=$Next.DAILY_SYNC_FEATURE_ENABLED}}}
 if($reply.variableCollectionUpsert -cne $true){throw 'PINS_UNKNOWN'};Assert-IncidentVarsEqual (Get-ResumeCustom) $Next
}
function Test-ResumeReady($Live,[string]$Commit,[string]$Fingerprint){
 $d=$Live.serviceInstance.latestDeployment
 if($d.status -cnotin @('SUCCESS','SLEEPING') -or $d.meta.imageDigest -cnotmatch '^sha256:[a-f0-9]{64}$'){throw 'DEPLOYMENT_NOT_READY'}
 $h=@{'x-internal-probe-token'=$Live.variables.INTERNAL_PROBE_TOKEN}
 try{$r=Invoke-WebRequest -Uri 'https://phase08-daily-data-sync-production.up.railway.app/backend-api/health/ready' -Headers $h -TimeoutSec 60 -MaximumRedirection 0 -SkipHttpErrorCheck;if([int]$r.StatusCode -ne 200){throw 'READY_HTTP'};$b=$r.Content|ConvertFrom-Json -AsHashtable;if($b.status -cne 'ready' -or $b.releaseId -cne $Commit -or $b.runtimeConfigFingerprint -cne $Fingerprint){throw 'READY_TUPLE'};return @{http=200;deploymentId=$d.id;releaseId=$b.releaseId;fingerprint=$Fingerprint;imageDigest=$d.meta.imageDigest}}finally{$h.Clear();$r=$null;$b=$null}
}
try{
 Import-Phase08SchedulerChildDefinitions
 $live=Get-IncidentState;$snap=Get-IncidentSnapshot;Assert-ResumeHeld $live $snap;$resources=Get-ResumeResources
 if((Get-IncidentHash $resources) -cne (Get-IncidentHash (Read-Resume 'railway-resources-before'))){throw 'RESOURCE_CAS'}
 if($Mode -ceq 'Status'){$st=Get-ResumeStopped;@{mode=$Mode;deployment=$st.latestDeployment;unstopped=@($st.activeDeployments|Where-Object{$_.deploymentStopped -cne $true}).Count;source=$live.variables.PHASE08_SOURCE_CONTENT_SHA256;release=$live.variables.RELEASE_GIT_SHA;login=$snap.runtime_role.login;backends=$snap.runtime_backends}|ConvertTo-Json -Depth 8;exit 0}
 if($Mode -ceq 'PrepareReadTest'){
  $stage='PREPARE_READ_ONLY_TEST_SCOPE';$prior=Read-IncidentPrivate 'resume-20261020-v2';$current=Get-ResumeCustom;Assert-IncidentVarsEqual $current $prior.after;$st=Get-ResumeStopped
  if($snap.runtime_role.login -cne $true -or $snap.runtime_backends -ne 0 -or $live.serviceInstance.latestDeployment.id -cne $securityDeployment -or $live.serviceInstance.latestDeployment.meta.imageDigest -cne $securityImage -or $st.latestDeployment.deploymentStopped -cne $true -or @($st.activeDeployments|Where-Object{$_.deploymentStopped -cne $true}).Count -ne 0 -or (Get-IncidentHash $snap.table_digests) -cne (Get-IncidentHash $prior.snapshot.table_digests)){throw 'READ_TEST_PREPARE_CAS'}
  $next=@{};foreach($n in $current.Keys){$next[$n]=$current[$n]};$next.DAILY_SYNC_FEATURE_ENABLED='true';$auth=Get-ResumeAuth
  if($auth.db -cne 'postgres' -or $auth.principal -cne 'postgres' -or $auth.unrevoked -ne 0 -or $auth.users_count -lt 1){throw 'READ_AUTH_BASELINE'}
  $deadline=[DateTimeOffset]::UtcNow.AddMinutes(20).ToString('o')
  Write-IncidentPrivate @{before=$prior.before;testBefore=$current;after=$next;snapshot=$snap;auth=$auth;eligibleSecretRollback=$false;securityDeployment=$securityDeployment;securityImage=$securityImage;testDeadline=$deadline} $privateName
  Save-Resume @{kind='BOUNDED_API_READ_TEST_PLAN';at=[DateTimeOffset]::UtcNow.ToString('o');testDeadline=$deadline;scope=$script:IncidentScope;release=$release;source=$source;featureOnForPublishedReadsOnly=$true;scheduleEnabled=$false;stopped=$true;paused=3;inactiveJobs=149;providerEnabled=0;sensitiveGrants=0;freshBefore68=$true;authPrincipal=$auth.principal;authUsers=$auth.users_count;expectedWrites=@('own login/logout sessions','app_users login/updated timestamp only','rate limits','append-only audit');sharedChanges=0;providerRequests=0;businessWrites=0;normalResume=$false;operatingGo=$false;restore=@('logout','candidate stop','featurefalse and security public pins','exact security image ready','NOLOGIN/backendterminate','exact restored deployment stop','fresh68 stableuser oldsessions oldaudit preserve');supersedes='v2 featurefalse excludes API rows; no local/cloud candidate or auth test executed under v2'} 'bounded-plan-v3'
 }elseif($Mode -ceq 'Prepare'){
  $stage='PREPARE_FRESH_BASELINE';$old=Read-IncidentPrivate 'runtime-merge-v2';$before=Get-ResumeCustom;Assert-IncidentVarsEqual $before $old.after;$st=Get-ResumeStopped
  if($live.serviceInstance.latestDeployment.id -cne $securityDeployment -or $live.serviceInstance.latestDeployment.meta.imageDigest -cne $securityImage -or $st.latestDeployment.deploymentStopped -cne $true -or @($st.activeDeployments|Where-Object{$_.deploymentStopped -cne $true}).Count -ne 0 -or $snap.runtime_role.login -cne $false -or $snap.runtime_backends -ne 0){throw 'BASELINE'}
  $after=@{};foreach($n in $before.Keys){$after[$n]=$before[$n]};$after.RELEASE_GIT_SHA=$release;$after.PHASE08_SOURCE_CONTENT_SHA256=$source
  $auth=Get-ResumeAuth;if($auth.db -cne 'postgres' -or $auth.principal -cne 'postgres' -or $auth.unrevoked -ne 0 -or $auth.users_count -lt 1){throw 'EXISTING_LIVE_SESSION_OR_IDENTITY'}
  Write-IncidentPrivate @{before=$before;after=$after;snapshot=$snap;auth=$auth;eligibleSecretRollback=$false;securityDeployment=$securityDeployment;securityImage=$securityImage} $privateName
  Save-Resume @{kind='BOUNDED_ISOLATED_CANDIDATE_TEST_PLAN';at=[DateTimeOffset]::UtcNow.ToString('o');scope=$script:IncidentScope;release=$release;source=$source;beforeVariablesSha256=(Get-IncidentVariableHash $before);afterVariablesSha256=(Get-IncidentVariableHash $after);snapshot=$snap;authPrincipal=$auth.principal;authUserCount=$auth.users_count;supersedesPlan='bounded-plan.json: auth principal not attested';expectedWrites=@('own app_auth_sessions login/logout','app_users last_login_at/updated_at only','security_rate_limit_buckets','append-only security_audit_events');sharedChanges=0;businessWrites=0;providerRequests=0;normalResume=$false;operatingGo=$false;restore=@('logout','candidate stop','two public pins restore to current security config','redeploy exact security image and ready once','NOLOGIN commit','terminate only phase08_runtime backends','stop exact restored deployment','fresh controls and 68-table comparison');automaticRetry=$false} 'bounded-plan-v2'
 }else{
  $plan=Read-IncidentPrivate $privateName
  if($Mode -ceq 'EnableReadTest'){
   $stage='API_READ_SCOPE_BEFORE_CAS';Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.testBefore;$st=Get-ResumeStopped
   if($snap.runtime_role.login -cne $true -or $snap.runtime_backends -ne 0 -or $live.serviceInstance.latestDeployment.id -cne $securityDeployment -or $st.latestDeployment.deploymentStopped -cne $true -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($plan.testDeadline) -or (Get-IncidentHash $snap.table_digests) -cne (Get-IncidentHash $plan.snapshot.table_digests)){throw 'READ_ENABLE_CAS'}
   $fp=(Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'phase10-resume-fingerprint-20261020.mjs') @{env=$plan.after;imageTag='meta-ads-phase10:20261020-v1'}).fingerprint
   Save-Resume @{kind='BOUNDED_API_READ_ENABLE_ATTEMPT';fingerprint=$fp;testDeadline=$plan.testDeadline;changedNames=@('DAILY_SYNC_FEATURE_ENABLED');secretChanges=0;providerRequests=0;normalResume=$false} 'read-activation-attempt'
   $stage='SINGLE_READ_FEATURE_ENABLE';$mutated=$true;Set-ResumePins $plan.testBefore $plan.after
   Save-Resume @{kind='BOUNDED_ACTIVATED';at=[DateTimeOffset]::UtcNow.ToString('o');fingerprint=$fp;testDeadline=$plan.testDeadline;featureOnForPublishedReadsOnly=$true;scheduleEnabled=$false;sharedChanges=0;secretChanges=0} 'activated-read'
  }elseif($Mode -ceq 'AbortBeforeSubmit'){
   $stage='ABORT_BEFORE_SUBMIT_CAS';if(Test-Path (Join-Path $root 'submitted.json')){throw 'SUBMITTED_USE_RESTORE'}
   Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.after;$st=Get-ResumeStopped
   if($live.serviceInstance.latestDeployment.id -cne $securityDeployment -or $live.serviceInstance.latestDeployment.meta.imageDigest -cne $securityImage -or $st.latestDeployment.deploymentStopped -cne $true -or (Get-ResumeAuth).unrevoked -ne 0){throw 'ABORT_BEFORE_SCOPE'}
   Save-Resume @{kind='BOUNDED_ABORT_BEFORE_UPLOAD_ATTEMPT';sharedChanges=0;deploymentRemainsStopped=$true} 'abort-before-attempt';$mutated=$true
   Set-ResumePins $plan.after $plan.before
   $stage='ABORT_NOLOGIN';$null=Invoke-Phase08Management -Action Query -Query "BEGIN;SET LOCAL lock_timeout='3s';DO `$g`$ BEGIN IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app') OR EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE enabled) OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE NOT paused) OR EXISTS(SELECT 1 FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) THEN RAISE EXCEPTION 'ABORT_HOLD_REQUIRED';END IF;END `$g`$;ALTER ROLE phase08_runtime NOLOGIN;COMMIT;"
   $null=Invoke-Phase08Management -Action Query -Query "DO `$g`$ BEGIN IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='phase08_runtime' AND NOT rolcanlogin) THEN RAISE EXCEPTION 'NOLOGIN_REQUIRED';END IF;PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='phase08_runtime' AND pid<>pg_backend_pid();END `$g`$;"
   $end=Get-IncidentSnapshot;Assert-ResumeHeld (Get-IncidentState) $end;Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.before
   if($end.runtime_role.login -cne $false -or $end.runtime_backends -ne 0 -or (Get-IncidentHash $end.table_digests) -cne (Get-IncidentHash $plan.snapshot.table_digests)){throw 'ABORT_PRESERVATION'}
   Save-Resume @{kind='BOUNDED_ABORT_BEFORE_UPLOAD_HELD';snapshot=$end;sharedChanges=0;all68Unchanged=$true;securityDeployment=$securityDeployment;image=$securityImage} 'abort-before-held'
  }elseif($Mode -ceq 'Activate'){
   $stage='PRE_ACTIVATE_IMAGE';Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.before;$st=Get-ResumeStopped
   if($live.serviceInstance.latestDeployment.id -cne $securityDeployment -or $live.serviceInstance.latestDeployment.meta.imageDigest -cne $securityImage -or $st.latestDeployment.deploymentStopped -cne $true -or @($st.activeDeployments|Where-Object{$_.deploymentStopped -cne $true}).Count -ne 0){throw 'ACTIVATE_DEPLOYMENT_CAS'}
   $fp=(Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'phase10-resume-fingerprint-20261020.mjs') @{env=$plan.after;imageTag='meta-ads-phase10:20261020-v1'}).fingerprint
   if($fp -cnotmatch '^[a-f0-9]{64}$' -or $snap.runtime_role.login -cne $false -or $snap.runtime_backends -ne 0 -or (Get-IncidentHash $snap.table_digests) -cne (Get-IncidentHash $plan.snapshot.table_digests)){throw 'ACTIVATE_BEFORE_CAS'}
   Save-Resume @{kind='BOUNDED_ACTIVATION_ATTEMPT';fingerprint=$fp;sharedChanges=0;changedVariables=@('RELEASE_GIT_SHA','PHASE08_SOURCE_CONTENT_SHA256');newPassword=$false} 'activation-attempt'
   $stage='SCOPED_LOGIN';$mutated=$true
   $null=Invoke-Phase08Management -Action Query -Query "BEGIN;SET LOCAL lock_timeout='3s';DO `$g`$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app') OR EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE enabled) OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE NOT paused) OR EXISTS(SELECT 1 FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='phase08_runtime') OR EXISTS(SELECT 1 FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints')) THEN RAISE EXCEPTION 'RESUME_LOGIN_GUARD';END IF;END `$g`$;ALTER ROLE phase08_runtime LOGIN;COMMIT;"
   $stage='TWO_PUBLIC_PINS';Set-ResumePins $plan.before $plan.after
   Save-Resume @{kind='BOUNDED_ACTIVATED';fingerprint=$fp;at=[DateTimeOffset]::UtcNow.ToString('o');secretChanges=0;sharedChanges=0} 'activated'
  }elseif($Mode -ceq 'Submit'){
   $stage='SUBMIT_BEFORE_CAS';Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.after
   if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($plan.testDeadline)){throw 'READ_TEST_WINDOW_EXPIRED'}
   if($live.serviceInstance.latestDeployment.id -cne $securityDeployment -or $snap.runtime_role.login -cne $true){throw 'SUBMIT_BASELINE'}
   $u='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/upload-20261020-v1';$proof=Read-Resume 'upload'
   if($proof.commit -cne $release -or $proof.sourceContentSha256 -cne $source -or $proof.fileCount -ne 495){throw 'UPLOAD_IDENTITY'}
   foreach($f in $proof.files){$p=Join-Path $u $f.name;if((Get-Item $p).Length -ne $f.size -or (Get-FileHash $p).Hash.ToLowerInvariant() -cne $f.sha256){throw 'UPLOAD_BYTES'}}
   if(@(Get-ChildItem $u -Recurse -Force -File).Count -ne $proof.fileCount){throw 'UPLOAD_EXTRA'}
   Save-Resume @{kind='SINGLE_ISOLATED_UPLOAD_ATTEMPT';scope=$script:IncidentScope;source=$source;release=$release;files=$proof.fileCount;sharedChanges=0;providerRequests=0} 'submit-attempt'
   $stage='SUBMIT_ONCE';$mutated=$true;$discard=& 'C:/Users/seong/AppData/Local/npm-cache/_npx/79fa66f96c8fdacf/node_modules/@railway/cli/bin/railway.exe' up $u --path-as-root --project $script:IncidentScope.p --environment $script:IncidentScope.e --service $script:IncidentScope.s --detach --json --message 'Bounded phase10 validation; providers and schedules remain held' 2>&1;$code=$LASTEXITCODE;$discard=$null;$new=Get-IncidentState
   Save-Resume @{kind='BOUNDED_SUBMITTED';at=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$new.serviceInstance.latestDeployment.id;cliExitCode=$code;retry=$false} 'submitted';if($code -ne 0 -or $new.serviceInstance.latestDeployment.id -ceq $securityDeployment){throw 'UPLOAD_UNKNOWN'}
  }elseif($Mode -ceq 'Ready'){
   $stage='CANDIDATE_READY';Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.after;$submitted=Read-Resume 'submitted';$a=Read-Resume 'activated-read'
   if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($plan.testDeadline)){throw 'READ_TEST_WINDOW_EXPIRED'}
   if($live.serviceInstance.latestDeployment.id -cne $submitted.deploymentId -or $snap.runtime_role.login -cne $true){throw 'READY_ID'}
   $r=Test-ResumeReady $live $release $a.fingerprint;$r.source=$source;$r.kind='BOUNDED_CANDIDATE_READY';Save-Resume $r 'ready'
  }elseif($Mode -ceq 'Restore'){
   $stage='RESTORE_PRECONDITIONS';Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.after;$submitted=Read-Resume 'submitted'
   if($live.serviceInstance.latestDeployment.id -cne $submitted.deploymentId -or (Get-ResumeAuth).unrevoked -ne 0){throw 'RESTORE_SESSION_OR_DEPLOYMENT'}
   if(Test-Path -LiteralPath (Join-Path $root 'light-load.json')){$load=Read-Resume 'light-load';if($load.logoutVerified -cne $true -or $load.sessionMayRemain -cne $false -or $load.deploymentId -cne $submitted.deploymentId -or $load.sourceSha -cne $source -or $load.releaseSha -cne $release){throw 'OWN_LOGOUT_NOT_VERIFIED'}}
   Save-Resume @{kind='BOUNDED_RESTORE_ATTEMPT';candidateDeployment=$submitted.deploymentId;securityImage=$securityImage;secretRollback=$false} 'restore-attempt';$mutated=$true
   $stage='STOP_CANDIDATE';$reply=Invoke-Phase08SchedulerGraph 'mutation($id:String!){deploymentStop(id:$id)}' @{id=$submitted.deploymentId};if($reply.deploymentStop -cne $true){throw 'CANDIDATE_STOP_UNKNOWN'}
   $stage='RESTORE_PUBLIC_PINS';Set-ResumePins $plan.after $plan.before
   $stage='REDEPLOY_EXACT_SECURITY_IMAGE';$reply=Invoke-Phase08SchedulerGraph 'mutation($id:String!){deploymentRedeploy(id:$id,usePreviousImageTag:true){id}}' @{id=$securityDeployment}
   if($reply.deploymentRedeploy.id -cnotmatch '^[a-f0-9-]{36}$'){throw 'RESTORE_UNKNOWN'}
   Save-Resume @{kind='BOUNDED_SECURITY_IMAGE_RESTORED';deploymentId=$reply.deploymentRedeploy.id;expectedImage=$securityImage;secretChanges=0} 'restore-submitted'
  }elseif($Mode -ceq 'RestoreReady'){
   $stage='SECURITY_IMAGE_READY';Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.before;$rs=Read-Resume 'restore-submitted';$old=Get-Content "$script:IncidentEvidence/release-verified-v2.json" -Raw|ConvertFrom-Json -AsHashtable
   if($live.serviceInstance.latestDeployment.id -cne $rs.deploymentId -or $live.serviceInstance.latestDeployment.meta.imageDigest -cne $securityImage){throw 'RESTORE_IMAGE'}
   $r=Test-ResumeReady $live $plan.before.RELEASE_GIT_SHA $old.runtimeConfigFingerprint;$r.kind='RESTORED_SECURITY_READY';Save-Resume $r 'restore-ready'
  }elseif($Mode -ceq 'Final'){
   $stage='FINAL_BEFORE_CAS';$rs=Read-Resume 'restore-ready';Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.before
   if($live.serviceInstance.latestDeployment.id -cne $rs.deploymentId -or $live.serviceInstance.latestDeployment.meta.imageDigest -cne $securityImage){throw 'FINAL_IMAGE'}
   Save-Resume @{kind='BOUNDED_FINAL_HOLD_ATTEMPT';deploymentId=$rs.deploymentId;sharedChanges=0} 'final-attempt';$mutated=$true
   $stage='NOLOGIN_COMMIT';$null=Invoke-Phase08Management -Action Query -Query "BEGIN;SET LOCAL lock_timeout='3s';DO `$g`$ BEGIN IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped) OR EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE enabled) OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE NOT paused) OR EXISTS(SELECT 1 FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) THEN RAISE EXCEPTION 'RESUME_HOLD_GUARD';END IF;END `$g`$;ALTER ROLE phase08_runtime NOLOGIN;COMMIT;"
   $stage='TERMINATE_SCOPED_BACKENDS';$null=Invoke-Phase08Management -Action Query -Query "DO `$g`$ BEGIN IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='phase08_runtime' AND NOT rolcanlogin) THEN RAISE EXCEPTION 'NOLOGIN_REQUIRED';END IF;PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='phase08_runtime' AND pid<>pg_backend_pid();END `$g`$;"
   $stage='STOP_RESTORED_DEPLOYMENT';$reply=Invoke-Phase08SchedulerGraph 'mutation($id:String!){deploymentStop(id:$id)}' @{id=$rs.deploymentId};if($reply.deploymentStop -cne $true){throw 'FINAL_STOP_UNKNOWN'}
   $after=Get-IncidentSnapshot;$cur=Get-IncidentState;Assert-ResumeHeld $cur $after;Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.before;$st=Get-ResumeStopped;$auth=Get-ResumeAuth
   $changed=@();foreach($t in $after.table_digests){$b=@($plan.snapshot.table_digests|Where-Object{$_.table -ceq $t.table});if($b.Count -ne 1 -or $b[0].md5 -cne $t.md5 -or $b[0].rows -ne $t.rows){$changed+=$t.table}}
   $allowed=@('app_users','app_auth_sessions','security_rate_limit_buckets','security_audit_events');$unexpected=@($changed|Where-Object{$_ -cnotin $allowed})
   $sessionChanges=@($plan.auth.sessions|Where-Object{$old=$_;$found=@($auth.sessions|Where-Object{$_.id -ceq $old.id -and $_.hash -ceq $old.hash});$found.Count -ne 1}).Count
   $auditChanges=@($plan.auth.audits|Where-Object{$old=$_;$found=@($auth.audits|Where-Object{$_.id -ceq $old.id -and $_.hash -ceq $old.hash});$found.Count -ne 1}).Count
   $preserved=@{};foreach($name in @('runtime_grants_md5','job_definitions_md5','other_jobs_md5','original152_md5','call_md5','storage_objects_md5')){$preserved[$name]=$after.$name -ceq $plan.snapshot[$name]}
   $pass=$after.runtime_role.login -ceq $false -and $after.runtime_backends -eq 0 -and $st.latestDeployment.deploymentStopped -ceq $true -and @($st.activeDeployments|Where-Object{$_.deploymentStopped -cne $true}).Count -eq 0 -and $unexpected.Count -eq 0 -and $auth.users_stable -ceq $plan.auth.users_stable -and $auth.users_count -eq $plan.auth.users_count -and $auth.unrevoked -eq 0 -and $sessionChanges -eq 0 -and $auditChanges -eq 0 -and @($preserved.Values|Where-Object{$_ -cne $true}).Count -eq 0
   Save-Resume @{kind='BOUNDED_TEST_FINAL_HELD';status=$(if($pass){'PASS_CONTAINMENT_WITH_EXTERNAL_RESIDUALS'}else{'FAIL'});at=[DateTimeOffset]::UtcNow.ToString('o');snapshot=$after;deployment=$st.latestDeployment;unstopped=@($st.activeDeployments|Where-Object{$_.deploymentStopped -cne $true}).Count;changedTables=$changed;unexpected=$unexpected;stableUsersPreserved=($auth.users_stable -ceq $plan.auth.users_stable);oldSessionChanges=$sessionChanges;oldAuditChanges=$auditChanges;unrevoked=$auth.unrevoked;preserved=$preserved;sharedChanges=0;operatingChanges=0;incidentResolved=$false;normalResume=$false} 'final-held';if(-not $pass){throw 'FINAL_PRESERVATION'}
  }
 }
 @{kind='BOUNDED_TEST_ACTION_COMPLETED';mode=$Mode;rawValuesReturned=0;sharedChanges=0}|ConvertTo-Json -Compress
}catch{@{kind='BOUNDED_TEST_SAFE_REJECTION';mode=$Mode;stage=$stage;outcomeUncertain=$mutated;rawErrorSuppressed=$true;automaticRetry=$false}|ConvertTo-Json -Compress;exit 1}
finally{if($headers){$headers.Clear()};$live=$null;$plan=$null;$before=$null;$after=$null;$old=$null;$auth=$null}
