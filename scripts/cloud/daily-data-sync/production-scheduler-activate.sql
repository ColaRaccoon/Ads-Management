-- Replace REVIEWED_RELEASE_SHA with the verified 40-character running release.
-- This action enables only the new private scheduler. It never performs a fetch.
BEGIN;
DO $guard$ BEGIN
  IF current_user<>'postgres' OR current_database()<>'postgres'
    OR 'REVIEWED_RELEASE_SHA' !~ '^[a-f0-9]{40}$'
    OR (SELECT count(*) FROM daily_data_sync_prod_ops.settings WHERE singleton AND stopped AND activated_at IS NULL)<>1
    OR (SELECT count(*) FROM daily_data_sync_prod_ops.schedules WHERE paused)<>3
    OR (SELECT min(anchor_at) FROM daily_data_sync_prod_ops.schedules)<=clock_timestamp()+interval '30 minutes'
    OR (SELECT count(*) FROM vault.secrets WHERE name='daily_data_sync_prod_machine')<>1
    OR (SELECT count(*) FROM cron.job WHERE jobname='daily-data-sync-prod-tick' AND NOT active
      AND schedule='* 17,18 * * *' AND command='SELECT daily_data_sync_prod_ops.tick();' AND username='postgres' AND database='postgres')<>1
    OR (SELECT count(*) FROM cron.job WHERE active AND ((jobname='storage-renewal-daily' AND schedule='0 19 * * *')
      OR (jobname='storage-renewal-verify' AND schedule='15 19 * * *')
      OR (jobname='storage-renewal-audit' AND schedule='20 19 * * *')))<>3
    THEN RAISE EXCEPTION 'PRODUCTION_SCHEDULE_ACTIVATION_GUARD'; END IF;
END $guard$;
UPDATE daily_data_sync_prod_ops.schedules SET paused=false;
UPDATE daily_data_sync_prod_ops.settings SET stopped=false,activated_release='REVIEWED_RELEASE_SHA',activated_at=clock_timestamp() WHERE singleton;
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='daily-data-sync-prod-tick'),active:=true);
SELECT daily_data_sync_prod_ops.tick() AS before_first_occurrence;
COMMIT;
