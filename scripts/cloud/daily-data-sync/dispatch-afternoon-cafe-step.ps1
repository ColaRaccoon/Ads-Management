param([Parameter(Mandatory)][ValidateRange(1,40)][int]$Step)
# One explicitly invoked operator step, never a loop, timer, new occurrence or range.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
Import-Phase08SchedulerChildDefinitions
$Provider='CAFE24';$stage='REVIEWED_APP';$context=$null;$operator=$null
try {
 $path=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/operator-afternoon-dispatch-20261015-'+$Provider+'-'+$Step+'.json')
 $pins=Get-Phase08SchedulerPins
 $expectedSource='42c15d089e41db8fb4286209bcf8975eb4c9ec3aa61b23f459aa49bd3024764f'
 if($pins.sourceSha -cne $expectedSource){throw 'source'}
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$null=Get-Phase08SchedulerGraphState $context $pins
 $operator=Read-Phase08Operator
 $key='phase08-cafe24';$connection='0c35defe-45fc-4a54-bc79-704df7bca5b1';$due='2026-10-15T06:40:00.000Z';$end='2026-10-15T08:30:00.000Z';$from='2026-10-14';$days=1
 if($operator.appId -cnotmatch '^[a-f0-9-]{36}$' -or $operator.authId -cnotmatch '^[a-f0-9-]{36}$'){throw 'actor'}
 $actor=$operator.appId;$auth=$operator.authId;$account='didadi0729';$shop='shop1';$currency='KRW';$window=110;$cadence=1
 $sql=@"
BEGIN;SET LOCAL statement_timeout=90000;SET LOCAL lock_timeout=2000;
DO `$guard`$ DECLARE r phase08_meta_ads.sync_runs;BEGIN
 IF clock_timestamp()>=timestamptz '$end'-interval '10 seconds' OR current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
 OR clock_timestamp()<timestamptz '2026-10-15T07:40:00Z' OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND NOT stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app') OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relforcerowsecurity AND c.relrowsecurity)<>68
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.app_users WHERE id='$actor' AND auth_user_id='$auth' AND role='SUPER_ADMIN' AND is_active AND invite_status='ACTIVE')
 OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id='$auth' AND email_confirmed_at IS NOT NULL AND role='authenticated')
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id='$connection' AND provider='$Provider' AND external_account_id='$account' AND shop_key='$shop' AND currency_code='$currency' AND time_zone='Asia/Seoul' AND enabled AND access_state='READY')
 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key='$key' AND connection_id='$connection' AND provider='$Provider' AND anchor_at='$due' AND cadence_days=$cadence AND window_minutes=$window AND NOT paused)
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'OPERATOR_DISPATCH_SCOPE';END IF;
 SELECT * INTO STRICT r FROM phase08_meta_ads.sync_runs WHERE connection_id='$connection' AND trigger='SCHEDULED' AND request_key='schedule:${key}:'||encode(extensions.digest('$due','sha256'),'hex') AND from_date='$from' AND to_date='2026-10-14';
 IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.security_audit_events WHERE action='SYNC_CAFE24_EXPLICIT_REPLAY_FIXTURE' AND actor_user_id='$actor' AND actor_type='USER' AND result='REQUESTED' AND target_type='SYNC_RUN' AND target_id=r.id::text AND after_json->>'fixtureOnly'='true' AND after_json->>'requestKey'=r.request_key) THEN RAISE EXCEPTION 'OPERATOR_DISPATCH_APPROVAL';END IF;
 IF r.status NOT IN ('QUEUED','PARTIAL','RUNNING','FAILED') OR r.request_key<>'schedule:${key}:'||encode(extensions.digest('$due','sha256'),'hex') OR (SELECT count(*) FROM phase08_meta_ads.run_units WHERE run_id=r.id)<>$days THEN RAISE EXCEPTION 'OPERATOR_DISPATCH_RUN';END IF;
 IF EXISTS(SELECT 1 FROM phase08_meta_ads.security_audit_events WHERE action='SYNC_SCHEDULE_OPERATOR_STEP' AND target_id=r.id::text AND after_json->>'scheduledFor'='$due' AND after_json->>'step'='$Step') THEN RAISE EXCEPTION 'OPERATOR_DISPATCH_DUPLICATE';END IF;
 INSERT INTO phase08_meta_ads.security_audit_events(id,actor_user_id,actor_type,action,target_type,target_id,result,after_json)
 VALUES(gen_random_uuid(),'$actor','USER','SYNC_SCHEDULE_OPERATOR_STEP','SYNC_RUN',r.id::text,'REQUESTED',jsonb_build_object('scheduleKey','$key','scheduledFor','$due','step',$Step,'originalDeadlineAt','$end','classification','OPERATOR_DISPATCH_SAME_SCHEDULED_OCCURRENCE'));
END `$guard`$;
SELECT daily_data_sync_ops.call('$key',false) AS status;
COMMIT;
"@
 $stage='SINGLE_DISPATCH';$watch=[Diagnostics.Stopwatch]::StartNew()
 $reply=@(Invoke-Phase08Management -Action Query -Query $sql -TimeoutSeconds 95);$watch.Stop()
 if($reply.Count -ne 1 -or $reply[0].status -isnot [string] -or $reply[0].status -cnotin @('PARTIAL','RUNNING','SUCCEEDED','FAILED','DELAYED','ACTION_REQUIRED','BUSY','TERMINAL','ATTEMPTS_EXHAUSTED','EXPIRED')){throw 'result'}
 $out=@{state='PHASE08_OPERATOR_STEP_RETURNED';classification='OPERATOR_DISPATCH_SAME_SCHEDULED_OCCURRENCE';automaticCronEvidence=$false;provider=$Provider;step=$Step;status=$reply[0].status;elapsedMs=$watch.ElapsedMilliseconds;observedAt=[DateTimeOffset]::UtcNow.ToString('o');selectedDatesPreserved=$true;deadlineAt=$end;operatingChanges=0;rawValuesReturned=0}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $path;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_OPERATOR_STEP_FAILED';provider=$Provider;step=$Step;stage=$stage;outcomeUncertain=($stage -cin @('SINGLE_DISPATCH','PUBLIC_EVIDENCE'));inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$operator=$null;$sql=$null;$reply=$null}
