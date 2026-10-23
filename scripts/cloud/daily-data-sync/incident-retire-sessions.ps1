Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$submitted=$false
try{
 $before=Get-IncidentSnapshot;Assert-IncidentContained $before
 if($before.runtime_role.login -cne $false -or $before.runtime_backends -ne 0){throw 'SESSION_CONTAINMENT'}
 Write-IncidentReceipt @{kind='INCIDENT_LOCAL_SESSION_RETIREMENT_PLANNED';at=[DateTimeOffset]::UtcNow.ToString('o');scope='phase08_meta_ads.app_auth_sessions';externalAuthSessionsChanged=0;businessRowsDeleted=0} 'sessions-retire-attempt'
 $sql=@'
BEGIN;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='15s';
DO $g$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='phase08_runtime' AND rolcanlogin) OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='phase08_runtime') OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app') THEN RAISE EXCEPTION 'INCIDENT_SESSION_GUARD';END IF;END $g$;
WITH changed AS (UPDATE phase08_meta_ads.app_auth_sessions SET revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE revoked_at IS NULL RETURNING id) SELECT count(*)::int AS retired_count FROM changed;
COMMIT;
'@
 $submitted=$true;$reply=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($reply.Count -ne 1 -or $reply[0].retired_count -lt 0){throw 'SESSION_OUTCOME'}
 $after=Get-IncidentSnapshot;Assert-IncidentContained $after
 foreach($t in $before.table_digests){if($t.table -ceq 'app_auth_sessions'){continue};$n=@($after.table_digests|Where-Object{$_.table -ceq $t.table});if($n.Count -ne 1 -or $n[0].rows -ne $t.rows -or $n[0].md5 -cne $t.md5){throw 'SESSION_PRESERVATION'}}
 $r=@(Invoke-Phase08Management -Action Query -Query 'BEGIN READ ONLY;SELECT count(*)::int AS active FROM phase08_meta_ads.app_auth_sessions WHERE revoked_at IS NULL;COMMIT;');if($r.Count -ne 1 -or $r[0].active -ne 0){throw 'SESSION_REMAINS'}
 $receipt=@{kind='INCIDENT_LOCAL_SESSIONS_RETIRED';at=[DateTimeOffset]::UtcNow.ToString('o');retiredCount=$reply[0].retired_count;activeLocalSessions=0;other67TablesUnchanged=$true;externalAuthSessionsChanged=0;businessRowsDeleted=0;productionChanges=0};Write-IncidentReceipt $receipt 'sessions-retired';$receipt|ConvertTo-Json
}catch{@{kind='INCIDENT_LOCAL_SESSIONS_SAFE_REJECTION';outcomeUncertain=$submitted;rawErrorSuppressed=$true;automaticRetryAllowed=$false}|ConvertTo-Json;exit 1}
