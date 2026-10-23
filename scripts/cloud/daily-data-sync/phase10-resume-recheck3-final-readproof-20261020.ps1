Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v3'
$release='971bf5ffaec0abd8869c9b8568e0193a9fbfaff9';$source='6f909c45723e80c390e4a2b07085044285a856c07657b8132f0240c99a3368a3';$Mode='FinalReadProof'
$securityImage='sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0'
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
try {
 Import-Phase08SchedulerChildDefinitions
 $plan=Read-IncidentPrivate 'performance-recheck-20261020-v3'
 $rs=Read-Resume 'restore-ready'
 $initial=Read-Resume 'final-held'
 if($initial.status -cne 'FAIL' -or $rs.deploymentId -cne '58aebafe-e551-4316-a962-7bbe7ffe5f5b'){throw 'INITIAL_PROOF_IDENTITY'}
 $stage='LIVE_STATE';$live=Get-IncidentState;$stage='SNAPSHOT';$snap=Get-IncidentSnapshot;Assert-ResumeHeld $live $snap
 $stage='CUSTOM_VARIABLE_CAS';Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.before
 $stage='RESOURCES'
 if((Get-IncidentHash (Get-ResumeResources)) -cne (Get-IncidentHash (Read-Resume 'railway-resources-before'))){throw 'RESOURCE_CAS'}
 if($live.serviceInstance.latestDeployment.id -cne $rs.deploymentId -or $live.serviceInstance.latestDeployment.meta.imageDigest -cne $securityImage){throw 'RESTORED_IMAGE_IDENTITY'}
   $after=Get-IncidentSnapshot;$cur=Get-IncidentState;Assert-ResumeHeld $cur $after;Assert-IncidentVarsEqual (Get-ResumeCustom) $plan.before;$st=Get-ResumeStopped;$auth=Get-ResumeAuth
   if($cur.serviceInstance.latestDeployment.id -cne $rs.deploymentId -or $cur.serviceInstance.latestDeployment.meta.imageDigest -cne $securityImage -or $st.latestDeployment.id -cne $rs.deploymentId){@{kind='READONLY_PUBLIC_DEPLOYMENT_IDENTITY_MISMATCH';expected=$rs.deploymentId;current=$cur.serviceInstance.latestDeployment.id;image=$cur.serviceInstance.latestDeployment.meta.imageDigest;stoppedView=$st.latestDeployment.id;stopped=$st.latestDeployment.deploymentStopped}|ConvertTo-Json -Compress;throw 'FINAL_FRESH_IMAGE_IDENTITY'}
   $changed=@();foreach($t in $after.table_digests){$b=@($plan.snapshot.table_digests|Where-Object{$_.table -ceq $t.table});if($b.Count -ne 1 -or $b[0].md5 -cne $t.md5 -or $b[0].rows -ne $t.rows){$changed+=$t.table}}
   $allowed=@('app_users','app_auth_sessions','security_rate_limit_buckets','security_audit_events');$unexpected=@($changed|Where-Object{$_ -cnotin $allowed})
   $sessionChanges=@($plan.auth.sessions|Where-Object{$old=$_;$found=@($auth.sessions|Where-Object{$_.id -ceq $old.id -and $_.hash -ceq $old.hash});$found.Count -ne 1}).Count
   $auditChanges=@($plan.auth.audits|Where-Object{$old=$_;$found=@($auth.audits|Where-Object{$_.id -ceq $old.id -and $_.hash -ceq $old.hash});$found.Count -ne 1}).Count
   $preserved=@{};foreach($name in @('runtime_grants_md5','job_definitions_md5','other_jobs_md5','original152_md5','call_md5','storage_objects_md5')){$preserved[$name]=$after.$name -ceq $plan.snapshot[$name]}
   $pass=$after.runtime_role.login -ceq $false -and $after.runtime_backends -eq 0 -and $st.latestDeployment.deploymentStopped -ceq $true -and @($st.activeDeployments|Where-Object{$_.deploymentStopped -cne $true}).Count -eq 0 -and $unexpected.Count -eq 0 -and $auth.users_stable -ceq $plan.auth.users_stable -and $auth.users_count -eq $plan.auth.users_count -and $auth.unrevoked -eq 0 -and $sessionChanges -eq 0 -and $auditChanges -eq 0 -and @($preserved.Values|Where-Object{$_ -cne $true}).Count -eq 0
   Save-Resume @{kind='BOUNDED_TEST_FINAL_HELD';finalStopReconciledReadOnly=$true;initialFinalProof='final-held.json';noMutationRetried=$true;status=$(if($pass){'PASS_CONTAINMENT_WITH_EXTERNAL_RESIDUALS'}else{'FAIL'});at=[DateTimeOffset]::UtcNow.ToString('o');snapshot=$after;deployment=$st.latestDeployment;unstopped=@($st.activeDeployments|Where-Object{$_.deploymentStopped -cne $true}).Count;changedTables=$changed;unexpected=$unexpected;stableUsersPreserved=($auth.users_stable -ceq $plan.auth.users_stable);oldSessionChanges=$sessionChanges;oldAuditChanges=$auditChanges;unrevoked=$auth.unrevoked;preserved=$preserved;sharedChanges=0;operatingChanges=0;incidentResolved=$false;normalResume=$false} 'final-stop-reconciled';if(-not $pass){throw 'FINAL_PRESERVATION'}
 @{kind='READ_ONLY_FINAL_RECONCILIATION';status='PASS';mutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress
}catch{@{kind='READ_ONLY_FINAL_RECONCILIATION';status='FAIL';stage=$stage;file=[IO.Path]::GetFileName($_.InvocationInfo.ScriptName);line=$_.InvocationInfo.ScriptLineNumber;errorType=$_.Exception.GetType().Name;errorId=$_.FullyQualifiedErrorId;rawErrorSuppressed=$true;mutations=0;automaticRetry=$false}|ConvertTo-Json -Depth 4 -Compress;exit 1}
finally{$live=$null;$plan=$null;$after=$null;$auth=$null}
