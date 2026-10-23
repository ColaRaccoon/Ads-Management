param([Parameter(Mandatory)][ValidateSet('Baseline','Contain','Status')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$stage='START';$mutation=$false;$live=$null;$snapshot=$null;$backup=$null
try{
 $stage='LIVE_TARGET';$live=Get-IncidentState;$snapshot=Get-IncidentSnapshot;$d=$live.serviceInstance.latestDeployment
 if($Mode -ceq 'Status'){
  $out=@{kind='INCIDENT_CURRENT_SAFE_STATE';at=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$d.id;status=$d.status;variablesCount=$live.variables.Count;stopped=$snapshot.stopped;paused=$snapshot.paused;activeJobs=$snapshot.active_jobs;runtimeLogin=$snapshot.runtime_role.login;runtimeBackends=$snapshot.runtime_backends;leases=$snapshot.live_leases;forceRls=$snapshot.force_rls;providerRequests=0;productionChanges=0}
  $out|ConvertTo-Json;exit 0
 }
 if($d.id -cne '33677c6c-2142-4938-b7f0-95e96f5de86b' -or $d.status -cnotin @('SUCCESS','SLEEPING') -or $live.variables.PHASE08_SOURCE_CONTENT_SHA256 -cne '0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1' -or $live.variables.RELEASE_GIT_SHA -cne '9e9a1f82bb02346575565b031a43e17e13758dc8' -or $live.variables.Count -ne 101 -or $snapshot.live_leases -ne 0){throw 'INCIDENT_INITIAL_STATE'}
 if($Mode -ceq 'Baseline'){
  if($snapshot.stopped -cne $false -or $snapshot.paused -ne 0 -or $snapshot.active_jobs -ne 149 -or $snapshot.runtime_role.login -cne $true){throw 'INCIDENT_BASELINE_STATE'}
  Write-IncidentPrivate @{version=1;scope=$script:IncidentScope;variables=$live.variables;snapshot=$snapshot;deploymentId=$d.id;imageDigest=$d.meta.imageDigest;deployConfig=$d.meta.serviceManifest.deploy;createdAt=[DateTimeOffset]::UtcNow.ToString('o');eligibleAsSecretRollback=$false} 'compromised-baseline'
  Write-IncidentReceipt @{kind='INCIDENT_BASELINE_RECORDED';at=[DateTimeOffset]::UtcNow.ToString('o');scope=$script:IncidentScope;deploymentId=$d.id;imageDigest=$d.meta.imageDigest;variablesCount=$live.variables.Count;variableDigest=(Get-IncidentVariableHash $live.variables);snapshot=$snapshot;protectedReference=(Join-Path $script:IncidentPrivate 'compromised-baseline.dpapi');secretRollbackAllowed=$false;rawValuesReturned=0;providerRequests=0;productionChanges=0} 'baseline'
 }else{
  $backup=Read-IncidentPrivate 'compromised-baseline';Assert-IncidentVarsEqual $live.variables $backup.variables
  if($snapshot.stopped -cne $false -or $snapshot.active_jobs -ne 149 -or $snapshot.paused -ne 0 -or $snapshot.runtime_role.login -cne $true -or (Get-IncidentHash $snapshot.table_digests) -cne (Get-IncidentHash $backup.snapshot.table_digests) -or $snapshot.job_definitions_md5 -cne $backup.snapshot.job_definitions_md5){throw 'INCIDENT_CONTAIN_BEFORE_CHANGED'}
  Write-IncidentReceipt @{kind='INCIDENT_CONTAIN_PLANNED';at=[DateTimeOffset]::UtcNow.ToString('o');changes=@('isolated STOPtrue','149 isolated cron inactive','three isolated schedules paused','phase08_runtime NOLOGIN','retire only phase08_runtime sessions');preserveDefinitionDigest=$snapshot.job_definitions_md5;preserveOtherCronDigest=$snapshot.other_jobs_md5;businessRowsChanged=0} 'contain-attempt'
  $sql=@'
BEGIN;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='20s';
SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));
DO $guard$ BEGIN
IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
OR (SELECT count(*) FROM daily_data_sync_ops.settings)<>1 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND NOT stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
OR (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3 OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE paused)
OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%')<>149 OR EXISTS(SELECT 1 FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND NOT active)
OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp())
OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='phase08_runtime' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole)
THEN RAISE EXCEPTION 'INCIDENT_CONTAIN_GUARD';END IF;END $guard$;
UPDATE daily_data_sync_ops.settings SET stopped=true WHERE singleton AND NOT stopped;
UPDATE daily_data_sync_ops.schedules SET paused=true WHERE NOT paused;
DO $jobs$ DECLARE j record;BEGIN FOR j IN SELECT jobid FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active LOOP PERFORM cron.alter_job(j.jobid,active:=false);END LOOP;END $jobs$;
ALTER ROLE phase08_runtime NOLOGIN;
COMMIT;
'@
  $stage='CONTAIN_SINGLE_TRANSACTION';$mutation=$true;$null=Invoke-Phase08Management -Action Query -Query $sql
  $stage='COMMITTED_NOLOGIN_CHECK';$gate=Get-IncidentSnapshot;Assert-IncidentContained $gate
  if($gate.runtime_role.login -cne $false){throw 'INCIDENT_NOLOGIN_NOT_COMMITTED'}
  $stage='RETIRE_EXACT_RUNTIME_SESSIONS'
  $null=Invoke-Phase08Management -Action Query -Query "DO `$retire`$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='phase08_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) THEN RAISE EXCEPTION 'INCIDENT_RETIRE_GUARD';END IF;PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='phase08_runtime' AND pid<>pg_backend_pid();END `$retire`$;"
  $after=Get-IncidentSnapshot;Assert-IncidentContained $after
  if($after.runtime_role.login -cne $false -or $after.runtime_backends -ne 0 -or (Get-IncidentHash $after.table_digests) -cne (Get-IncidentHash $snapshot.table_digests) -or $after.job_definitions_md5 -cne $snapshot.job_definitions_md5 -or $after.other_jobs_md5 -cne $snapshot.other_jobs_md5 -or $after.storage_objects_md5 -cne $snapshot.storage_objects_md5 -or $after.runtime_grants_md5 -cne $snapshot.runtime_grants_md5 -or $after.call_md5 -cne $snapshot.call_md5 -or $after.original152_md5 -cne $snapshot.original152_md5){throw 'INCIDENT_CONTAIN_PRESERVATION'}
  Write-IncidentReceipt @{kind='INCIDENT_CONTAIN_VERIFIED';at=[DateTimeOffset]::UtcNow.ToString('o');snapshot=$after;businessRowsUnchanged=$true;jobDefinitionsUnchanged=$true;otherCronUnchanged=$true;storageObjectsUnchanged=$true;runtimeGrantsUnchanged=$true;sharedCredentialsRevoked=$false;providerRequests=0;productionChanges=0} 'contained'
 }
 @{kind='INCIDENT_ACTION_COMPLETED';mode=$Mode;at=[DateTimeOffset]::UtcNow.ToString('o');rawValuesReturned=0;productionChanges=0}|ConvertTo-Json
}catch{@{kind='INCIDENT_ACTION_SAFE_REJECTION';mode=$Mode;stage=$stage;outcomeUncertain=$mutation;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally{$live=$null;$snapshot=$null;$backup=$null;$after=$null;$sql=$null}
