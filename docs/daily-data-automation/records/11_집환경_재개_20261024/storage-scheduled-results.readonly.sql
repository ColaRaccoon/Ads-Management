-- Observation only: existing Oct24 04:00/04:15/04:20 KST executions.
-- Run only in the normal dashboard for production project iygjmosbelbosfxidqxv.
-- Never call storage_renewal_ops.invoke/audit or read secret/token contents here.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '4s';
SET LOCAL lock_timeout = '1s';
WITH cron_results AS (
  SELECT 'cron'::text AS section, jobid::text AS item, status::text,
         start_time::text AS started_at, end_time::text AS ended_at,
         NULL::text AS expires_at, NULL::text AS readiness_verified
  FROM cron.job_run_details
  WHERE jobid IN (1, 2, 3)
    AND start_time >= '2026-10-23T18:59:00Z'::timestamptz
    AND start_time < '2026-10-23T19:25:00Z'::timestamptz
  ORDER BY start_time
  LIMIT 6
), request_results AS (
  SELECT 'committed-request'::text AS section, mode::text AS item,
         http_status::text || ':' || coalesce(result->>'state', 'NO_STATE') AS status,
         requested_at::text AS started_at, NULL::text AS ended_at,
         result->>'expiresAt' AS expires_at,
         result->>'readinessVerified' AS readiness_verified
  FROM storage_renewal_ops.requests
  WHERE requested_at >= '2026-10-23T18:59:00Z'::timestamptz
    AND requested_at < '2026-10-23T19:25:00Z'::timestamptz
  ORDER BY requested_at
  LIMIT 4
)
SELECT * FROM cron_results
UNION ALL
SELECT * FROM request_results
ORDER BY started_at, section;
COMMIT;
