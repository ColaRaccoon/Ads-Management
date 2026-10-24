-- Counts only; no customer rows, account identifiers, tokens or credential refs.
-- Use only the normal dashboard for production project iygjmosbelbosfxidqxv.
-- Point-in-time observations are not a source transition before-image.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '4s';
SET LOCAL lock_timeout = '1s';
SELECT now() AS observed_at, 'source_connections' AS item, count(*) AS total,
       count(*) FILTER (WHERE enabled) AS flagged_count
FROM meta_ads.source_connections
UNION ALL
SELECT now(), 'source_policies', count(*), NULL::bigint FROM meta_ads.source_policies
UNION ALL
SELECT now(), 'sync_runs', count(*), NULL::bigint FROM meta_ads.sync_runs
UNION ALL
SELECT now(), 'sync_leases', count(*), count(*) FILTER (WHERE expires_at > now())
FROM meta_ads.sync_leases
UNION ALL
SELECT now(), 'source_credentials', count(*),
       count(*) FILTER (WHERE refresh_owner IS NOT NULL AND refresh_until > now())
FROM meta_ads.source_credentials
UNION ALL
SELECT now(), 'automatic_source_jobs', count(*), count(*) FILTER (WHERE active)
FROM cron.job WHERE jobname LIKE 'daily-data-sync-prod-%'
UNION ALL
SELECT now(), 'meta_ad_current_csv_cutoff_or_later', count(*),
       count(*) FILTER (WHERE metric_date = DATE '2026-10-23')
FROM meta_ads.meta_ad_daily_metrics
WHERE metric_date >= DATE '2026-10-23' AND source = 'CSV' AND is_current
UNION ALL
SELECT now(), 'meta_adset_current_csv_cutoff_or_later', count(*),
       count(*) FILTER (WHERE metric_date = DATE '2026-10-23')
FROM meta_ads.meta_adset_daily_metrics
WHERE metric_date >= DATE '2026-10-23' AND source = 'CSV' AND is_current
UNION ALL
SELECT now(), 'meta_ad_api_history_cutoff_or_later', count(*), NULL::bigint
FROM meta_ads.meta_ad_daily_metrics
WHERE metric_date >= DATE '2026-10-23' AND source = 'API'
UNION ALL
SELECT now(), 'meta_adset_api_history_cutoff_or_later', count(*), NULL::bigint
FROM meta_ads.meta_adset_daily_metrics
WHERE metric_date >= DATE '2026-10-23' AND source = 'API';
COMMIT;
