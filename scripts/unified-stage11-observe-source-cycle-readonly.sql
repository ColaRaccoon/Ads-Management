WITH
-- Future observation only. Never invokes a collector, changes cron, or exposes its command/token.
p AS (
 SELECT DATE '2026-10-29' AS business_date,
 TIMESTAMPTZ '2026-10-29 17:00:00+00' AS window_start,
 TIMESTAMPTZ '2026-10-29 19:00:00+00' AS window_end,
 'be140e7e-3994-406e-94ff-b50dfc7ac7b2'::uuid AS cafe24_scope
), scheduled AS (
 SELECT r.id,r.trigger::text,r.status::text,r.from_date,r.to_date,r.started_at,r.finished_at,
 r.rows_fetched,r.rows_published,r.safe_error_code
 FROM meta_ads.sync_runs r,p
 WHERE r.connection_id=p.cafe24_scope AND r.trigger::text='SCHEDULED'
 AND r.started_at>=p.window_start AND r.from_date<=p.business_date AND r.to_date>=p.business_date
 ORDER BY r.started_at DESC LIMIT 10
), ticks AS (
 SELECT d.jobid,d.status,d.start_time,d.end_time
 FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid,p
 WHERE j.jobname='daily-data-sync-prod-tick' AND d.start_time>=p.window_start
 ORDER BY d.start_time DESC LIMIT 10
), source_day AS (
 SELECT count(*) AS current_rows,count(*) FILTER(WHERE l.validation_status::text<>'ERROR') AS nonerror_rows,
 sum(l.sale_price_krw*l.quantity)::text AS source_list_gross,
 max(coalesce(l.provider_updated_at,l.created_at)) AS source_as_of
 FROM meta_ads.cafe24_order_lines l,p
 WHERE l.connection_id=p.cafe24_scope AND l.is_current AND l.order_date=p.business_date
), publications AS (
 SELECT s.run_id,s.revision,r.status::text,r.published_at,
 (SELECT max(c.details->>'sourceAsOf') FROM meta_ads.unified_source_coverage c WHERE c.run_id=s.run_id) AS source_as_of
 FROM meta_ads.unified_source_publications s JOIN meta_ads.unified_aggregation_runs r ON r.id=s.run_id,p
 WHERE s.platform::text='CAFE24' AND s.scope_key=p.cafe24_scope::text AND s.business_date=p.business_date
)
SELECT jsonb_build_object(
 'observedAt',now(),'businessDate',p.business_date,'expectedWindowStart',p.window_start,'expectedWindowEnd',p.window_end,
 'futureWindowPending',now()<p.window_start,'windowFinished',now()>=p.window_end,
 'collectorWasInvokedByThisQuery',false,'databaseWrites',0,
 'cronSettings',(SELECT coalesce(jsonb_agg(jsonb_build_object('jobId',jobid,'jobName',jobname,'schedule',schedule,'active',active)),'[]'::jsonb) FROM cron.job WHERE jobname='daily-data-sync-prod-tick'),
 'scheduledTicks',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM ticks t),
 'scheduledCafe24Runs',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) FROM scheduled s),
 'storedSourceDay',(SELECT to_jsonb(s) FROM source_day s),
 'unifiedPublication',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) FROM publications s),
 'limitation','Cron tick success alone is not source success. Verify scheduled collector completion, source lineage, then the separately executed unified publication; do not describe a manual collector as the scheduled cycle.'
) AS observation FROM p;
