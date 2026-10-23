// Root submits this secret-free read-only plan. No network, provider or database client.
import {checkedDefinitions} from './scheduler-parent-bridge.mjs';
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
export function firstSlotEvidenceSql(definitions) {
 const rows=checkedDefinitions(definitions);
 const desired=rows.map(row=>`(${quote(row.key)},${quote(row.provider)},${quote(row.connectionId)}::uuid,${quote(row.anchorAt)}::timestamptz,${row.windowMinutes})`).join(',');
 return `BEGIN READ ONLY;
SET LOCAL statement_timeout=15000;
DO $guard$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL OR (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads')<>68 THEN RAISE EXCEPTION 'PHASE08_FIRST_SLOT_IDENTITY_REJECTED'; END IF; END $guard$;
WITH desired(key,provider,connection_id,anchor_at,window_minutes) AS (VALUES ${desired})
SELECT d.provider,to_char(d.anchor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "scheduledFor",
 (SELECT count(*) FROM daily_data_sync_ops.attempts a WHERE a.schedule_key=d.key AND a.scheduled_for=d.anchor_at) AS "totalAttempts",
 (SELECT coalesce(json_agg(row_to_json(x)),'[]'::json) FROM (SELECT a.status,CASE WHEN a.safe_code IN ('COMPLETE','APP_INCOMPLETE','HTTP_RETRYABLE','APP_LEASE_BUSY','HTTP_REJECTED','MACHINE_AUTH_REQUIRED','TRANSPORT_FAILED','INVALID_APP_RESPONSE','MISSING_SCHEDULE','INCOMPLETE_SCHEDULE') THEN a.safe_code ELSE 'UNCLASSIFIED' END AS "safeCode",a.http_status AS "httpStatus",count(*) AS count,min(a.elapsed_ms) AS "minimumMs",max(a.elapsed_ms) AS "maximumMs",min(a.attempted_at)::text AS "firstAttemptAt",max(a.attempted_at)::text AS "lastAttemptAt" FROM daily_data_sync_ops.attempts a WHERE a.schedule_key=d.key AND a.scheduled_for=d.anchor_at GROUP BY a.status,a.safe_code,a.http_status ORDER BY a.status,a.safe_code,a.http_status LIMIT 30)x) AS "attemptGroups",
 (SELECT coalesce(json_agg(row_to_json(x)),'[]'::json) FROM (SELECT CASE WHEN j.status IN ('succeeded','failed','running','starting','connecting','sending') THEN j.status ELSE 'UNCLASSIFIED' END AS status,count(*) AS count,min(j.start_time)::text AS "firstStartedAt",max(j.end_time)::text AS "lastFinishedAt" FROM cron.job_run_details j JOIN cron.job c ON c.jobid=j.jobid WHERE (c.jobname='daily-data-sync-08-'||d.key||'-audit' OR c.jobname ~ ('^daily-data-sync-08-'||d.key||'-[0-9]+$')) AND j.start_time>=d.anchor_at-interval '1 minute' AND j.start_time<d.anchor_at+(d.window_minutes+10)*interval '1 minute' GROUP BY j.status ORDER BY j.status LIMIT 10)x) AS "cronGroups",
 (SELECT count(*) FROM phase08_meta_ads.sync_runs r WHERE r.connection_id=d.connection_id AND r.trigger='SCHEDULED' AND r.from_date=(d.anchor_at AT TIME ZONE 'Asia/Seoul')::date-CASE WHEN d.provider='CAFE24' THEN 1 ELSE 7 END AND r.to_date=(d.anchor_at AT TIME ZONE 'Asia/Seoul')::date-1) AS "matchingScheduledRuns",
 (SELECT count(*) FROM phase08_meta_ads.source_coverage v WHERE v.connection_id=d.connection_id AND v.metric_date BETWEEN (d.anchor_at AT TIME ZONE 'Asia/Seoul')::date-CASE WHEN d.provider='CAFE24' THEN 1 ELSE 7 END AND (d.anchor_at AT TIME ZONE 'Asia/Seoul')::date-1) AS "selectedCoverageRows"
FROM desired d ORDER BY d.provider;
ROLLBACK;`;
}
