Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$stage='PRECONDITIONS';$submitted=$false
try{
 $deployment='906da6a9-09cd-411a-981b-833b4640abd6';$source='6d60d1662730508e19af171124310b82693c0687d86efdd76fa0663f367a767e';$release='5bda544ec579a15745a93f89ee4fbc69bb7102f5'
 $auth=Get-Content "$script:IncidentEvidence/auth-verified-v2.json" -Raw|ConvertFrom-Json -AsHashtable -Depth 30
 $authz=Get-Content "$script:IncidentEvidence/authz-verified-v2.json" -Raw|ConvertFrom-Json -AsHashtable -Depth 30
 $ready=Get-Content "$script:IncidentEvidence/release-verified-v2.json" -Raw|ConvertFrom-Json -AsHashtable -Depth 20
 if($auth.status -cne 'PASS' -or $auth.logoutVerified -cne $true -or $auth.sessionMayRemain -cne $false -or $auth.deploymentId -cne $deployment -or $ready.deploymentId -cne $deployment -or $ready.sourceSha -cne $source -or $ready.releaseId -cne $release -or -not(Test-Path "$script:IncidentEvidence/local-synced-v2.json")){throw 'PROOFS_REQUIRED'}
 if($authz.status -cne 'PASS' -or $authz.logoutVerified -cne $true -or $authz.sessionMayRemain -cne $false -or $authz.deploymentId -cne $deployment -or $authz.actualCookieServiceComparison.newMatchesServer -cne $true -or $authz.actualCookieServiceComparison.oldMatchesServer -cne $false){throw 'AUTHZ_PROOF_REQUIRED'}
 $live=Get-IncidentState;$plan=Read-IncidentPrivate 'runtime-merge-v2';$before=Get-IncidentSnapshot;Assert-IncidentContained $before
 $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope;Assert-IncidentVarsEqual $r.variables $plan.after
 $activeBefore=@($live.serviceInstance.activeDeployments)
 if($live.serviceInstance.latestDeployment.id -cne $deployment -or $live.serviceInstance.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or $live.variables.PHASE08_SOURCE_CONTENT_SHA256 -cne $source -or $live.variables.RELEASE_GIT_SHA -cne $release -or $before.runtime_role.login -cne $true -or $activeBefore.Count -ne 1 -or $activeBefore[0].id -cne $deployment){throw 'FINAL_SCOPE'}
 Write-IncidentPrivate @{snapshot=$before;eligibleSecretRollback=$false;at=[DateTimeOffset]::UtcNow.ToString('o')} 'before-final-hold'
 Write-IncidentReceipt @{kind='INCIDENT_FINAL_ISOLATION_PLANNED';at=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$deployment;scope=$script:IncidentScope;steps=@('COMMIT_RUNTIME_NOLOGIN','TERMINATE_SCOPED_BACKENDS','STOP_ONLY_VERIFIED_DEPLOYMENT');dataDeletion=0;sharedCredentialChanges=0} 'final-hold-attempt'
 $sql=@'
BEGIN;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='15s';
DO $g$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app') OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE NOT paused) OR EXISTS(SELECT 1 FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) OR EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE enabled) OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints')) THEN RAISE EXCEPTION 'INCIDENT_FINAL_HOLD_GUARD';END IF;END $g$;
ALTER ROLE phase08_runtime NOLOGIN;COMMIT;
'@
 $stage='COMMIT_SCOPED_NOLOGIN';$submitted=$true;$null=Invoke-Phase08Management -Action Query -Query $sql
 $check=Get-IncidentSnapshot;if($check.runtime_role.login -cne $false){throw 'NOLOGIN_NOT_COMMITTED'}
 $stage='TERMINATE_ONLY_RETIRED_RUNTIME_BACKENDS';$null=Invoke-Phase08Management -Action Query -Query "DO `$g`$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='phase08_runtime' AND NOT rolcanlogin) OR current_user<>'postgres' THEN RAISE EXCEPTION 'INCIDENT_NOLOGIN_REQUIRED';END IF;PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='phase08_runtime' AND pid<>pg_backend_pid();END `$g`$;"
 $stage='STOP_ONLY_VERIFIED_ISOLATED_DEPLOYMENT';$reply=Invoke-Phase08SchedulerGraph 'mutation($id:String!){deploymentStop(id:$id)}' @{id=$deployment};if($reply.deploymentStop -cne $true){throw 'STOP_OUTCOME_UNKNOWN'}
 $after=Get-IncidentSnapshot;Assert-IncidentContained $after
 if($after.runtime_role.login -cne $false -or $after.runtime_backends -ne 0 -or $before.runtime_grants_md5 -cne $after.runtime_grants_md5 -or (Get-IncidentHash $before.table_digests) -cne (Get-IncidentHash $after.table_digests)){throw 'FINAL_PRESERVATION'}
 $current=Get-IncidentState;$active=@($current.serviceInstance.activeDeployments)
 $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope;Assert-IncidentVarsEqual $r.variables $plan.after
 if($current.serviceInstance.latestDeployment.id -cne $deployment -or $current.serviceInstance.latestDeployment.meta.imageDigest -cne $ready.imageDigest){throw 'FINAL_IMAGE_PRESERVATION'}
 $receipt=@{kind='INCIDENT_FINAL_HOLD_APPLIED';at=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$deployment;status=$current.serviceInstance.latestDeployment.status;activeDeployments=@($active|ForEach-Object{@{id=$_.id;status=$_.status}});runtimeLogin=$after.runtime_role.login;runtimeBackends=$after.runtime_backends;liveLeases=$after.live_leases;stopped=$after.stopped;paused=$after.paused;activeJobs=$after.active_jobs;forceRls=$after.force_rls;business68TableDigestsUnchanged=$true;reducedGrantsUnchanged=$true;newImageAndConfigurationPreserved=$true;externalSharedCredentialsChanged=0;productionChanges=0;snapshot=$after};Write-IncidentReceipt $receipt 'final-held';[pscustomobject]$receipt|Select-Object -ExcludeProperty snapshot|ConvertTo-Json -Depth 8
}catch{@{kind='INCIDENT_FINAL_HOLD_SAFE_REJECTION';stage=$stage;outcomeUncertain=$submitted;automaticRetryAllowed=$false;rawErrorSuppressed=$true;inspectBeforeNextAction=$true}|ConvertTo-Json;exit 1}
