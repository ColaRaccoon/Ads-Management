param([Parameter(Mandatory)][ValidateSet('kill','pause','status')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$submitted=$false;$stage='READONLY_IDENTITY';$sql=$null
try {
 Import-Phase08SchedulerChildDefinitions
 if($Mode -ceq 'kill') {
  $identity=Invoke-Phase08Management -Action Query -Query 'BEGIN READ ONLY; SELECT current_database() AS database,current_user AS role; ROLLBACK;'
  if(@($identity).Count -ne 1 -or $identity.database -cne 'postgres' -or $identity.role -cne 'postgres'){throw 'stop-principal'}
  $stage='BUILD';$batch=Invoke-Phase08SchedulerNode @{action='build';mode='kill'}
  if($batch.state -cne 'PHASE08_BATCH_PREPARED' -or $batch.sql -isnot [string]){throw 'stop-plan'}
  $stage='SINGLE_BATCH';$submitted=$true;$sql=$batch.sql;$discard=Invoke-Phase08Management -Action Query -Query $sql;$discard=$null;$sql=$null
  $stage='READBACK';$status=Invoke-Phase08Management -Action Query -Query 'BEGIN READ ONLY; SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton; ROLLBACK;'
  if(@($status).Count -ne 1 -or $status.stopped -isnot [bool] -or -not $status.stopped){throw 'kill-readback'}
  @{state='PHASE08_SCHEDULER_STOP_STATUS_VERIFIED';mode='kill';globalStopped=$true;applicationFlagChanged=$false;inflightHttpCancelled=$false;providerRequests=0;privateValuesReturned=0;retryPerformed=$false}|ConvertTo-Json -Compress
  return
 }
 $before=Get-Phase08SchedulerSnapshot
 if(-not $before.snapshot.installed -or @($before.snapshot.settings).Count -ne 1 -or
   $before.snapshot.settings[0].targetId -cne 'phase08-full-app' -or
   $before.snapshot.settings[0].origin -cne 'https://phase08-daily-data-sync-production.up.railway.app'){throw 'fixed-stop-target'}
 if($Mode -cne 'status') {
  # Stop does not require signing keys or a healthy app. The fixed management
  # endpoint and postgres DB principal still apply. Pause only the known keys.
  $stage='BUILD';$keys=@(@{key='phase08-cafe24'},@{key='phase08-google'},@{key='phase08-meta'})
  $batch=Invoke-Phase08SchedulerNode @{action='build';mode=$Mode;definitions=$(if($Mode -ceq 'pause'){$keys}else{@()})}
  if($batch.state -cne 'PHASE08_BATCH_PREPARED' -or $batch.sql -isnot [string]){throw 'stop-plan'}
  $stage='SINGLE_BATCH';$sql=$batch.sql;$submitted=$true;$discard=Invoke-Phase08Management -Action Query -Query $sql;$discard=$null;$sql=$null
 }
 $stage='READBACK';$after=Get-Phase08SchedulerSnapshot
 if($before.preserved_schema_digest -cne $after.preserved_schema_digest -or $before.other_cron_digest -cne $after.other_cron_digest){throw 'preservation'}
 if($Mode -ceq 'kill' -and $after.snapshot.settings[0].stopped -ne $true){throw 'kill-readback'}
 if($Mode -ceq 'pause') {
  foreach($key in @('phase08-cafe24','phase08-google','phase08-meta')) {
   $rows=@($after.snapshot.schedules|Where-Object {$_.key -ceq $key});if($rows.Count -ne 1 -or $rows[0].paused -ne $true){throw 'pause-readback'}
  }
  if(@($after.snapshot.jobs|Where-Object {$_.active}).Count -gt 0){throw 'pause-jobs-readback'}
 }
 @{state='PHASE08_SCHEDULER_STOP_STATUS_VERIFIED';mode=$Mode;globalStopped=$after.snapshot.settings[0].stopped;
  schedules=$after.snapshot.schedules.Count;pausedSchedules=@($after.snapshot.schedules|Where-Object {$_.paused}).Count;
  jobs=$after.snapshot.jobs.Count;activeJobs=@($after.snapshot.jobs|Where-Object {$_.active}).Count;
  applicationFlagChanged=$false;inflightHttpCancelled=$false;providerRequests=0;privateValuesReturned=0;retryPerformed=$false}|ConvertTo-Json -Compress
} catch {@{state='PHASE08_SCHEDULER_STOP_STATUS_FAILED';mode=$Mode;stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally {$sql=$null;$batch=$null;$discard=$null;$before=$null;$after=$null;$identity=$null;$status=$null}
