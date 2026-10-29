WITH targets(platform,scope_id,data_kind) AS (VALUES ('META','2155a401-bd86-4111-9280-3c95ed207546'::uuid,'META_ADSET'),('GOOGLE','21b811a6-b9d7-44f5-8167-ce40198947b5'::uuid,'GOOGLE_CAMPAIGN')),
params AS (SELECT DATE '2026-10-28' AS business_date),
meta_lineage AS (
 SELECT count(DISTINCT m.id) AS raw_rows,count(DISTINCT m.meta_adset_id) AS distinct_entities,count(r.id) AS links,
 count(r.id) FILTER(WHERE r.version=m.import_version) AS valid_version_links,
 count(DISTINCT m.id) FILTER(WHERE r.version=m.import_version) AS valid_linked_rows
 FROM meta_ads.meta_adset_daily_metrics m LEFT JOIN meta_ads.source_record_links r ON r.record_id=m.id AND r.connection_id=m.connection_id AND r.data_kind::text='META_ADSET' AND r.source::text='API' AND r.record_table='meta_adset_daily_metrics' AND r.is_current,params p
 WHERE m.is_current AND m.source::text='API' AND m.connection_id=(SELECT scope_id FROM targets WHERE platform='META') AND m.metric_date=p.business_date
), google_lineage AS (
 SELECT count(DISTINCT g.id) AS raw_rows,count(DISTINCT g.campaign_id) AS distinct_entities,count(r.id) AS links,
 count(r.id) FILTER(WHERE r.version=g.version AND r.sync_run_id=g.sync_run_id) AS valid_version_and_run_links,
 count(DISTINCT g.id) FILTER(WHERE r.version=g.version AND r.sync_run_id=g.sync_run_id) AS valid_linked_rows
 FROM meta_ads.google_campaign_daily_costs g LEFT JOIN meta_ads.source_record_links r ON r.record_id=g.id AND r.connection_id=g.connection_id AND r.data_kind::text='GOOGLE_CAMPAIGN' AND r.source::text='API' AND r.record_table='google_campaign_daily_costs' AND r.is_current,params p
 WHERE g.is_current AND g.source::text='API' AND g.connection_id=(SELECT scope_id FROM targets WHERE platform='GOOGLE') AND g.metric_date=p.business_date
), google_amount AS (
 SELECT count(*) AS rows,sum(g.cost_micros)/1000000::numeric AS raw_krw FROM meta_ads.google_campaign_daily_costs g,params p WHERE g.is_current AND g.source::text='API' AND g.connection_id=(SELECT scope_id FROM targets WHERE platform='GOOGLE') AND g.metric_date=p.business_date
), policy AS (
 SELECT t.platform,count(s.id) AS applicable_policies,jsonb_agg(jsonb_build_object('source',s.primary_source,'from',s.from_date,'to',s.to_date)) FILTER(WHERE s.id IS NOT NULL) AS policy
 FROM targets t CROSS JOIN params p LEFT JOIN meta_ads.source_policies s ON s.connection_id=t.scope_id AND s.data_kind::text=t.data_kind AND s.from_date<=p.business_date AND(s.to_date IS NULL OR s.to_date>p.business_date) GROUP BY t.platform
), receipts AS (
 SELECT t.platform,c.source::text,c.state::text,c.row_count,c.total_amount::text,c.last_success_at,c.warning_codes,
 (SELECT count(*) FROM meta_ads.run_units u JOIN meta_ads.sync_runs r ON r.id=u.run_id WHERE u.run_id=c.last_success_run_id AND u.status::text='SUCCEEDED' AND r.connection_id=t.scope_id AND u.unit_key=p.business_date::text) AS succeeded_day_units,
 (SELECT min(u.published_count) FROM meta_ads.run_units u JOIN meta_ads.sync_runs r ON r.id=u.run_id WHERE u.run_id=c.last_success_run_id AND u.status::text='SUCCEEDED' AND r.connection_id=t.scope_id AND u.unit_key=p.business_date::text) AS published_count,
 CASE WHEN t.platform='GOOGLE' THEN c.total_amount=(SELECT raw_krw FROM google_amount) ELSE NULL END AS raw_google_amount_matches
 FROM targets t CROSS JOIN params p LEFT JOIN meta_ads.source_coverage c ON c.connection_id=t.scope_id AND c.data_kind::text=t.data_kind AND c.metric_date=p.business_date
), relevant_connections AS (
 SELECT t.platform,c.provider::text,c.currency_code,c.time_zone FROM targets t JOIN meta_ads.source_connections c ON c.id=t.scope_id
), permission_columns(table_name,columns) AS (VALUES
 ('source_connections',ARRAY['id','provider','currency_code','time_zone']::text[]),
 ('sync_runs',ARRAY['id','connection_id']::text[]),
 ('products',ARRAY['id','display_name','is_active']::text[]),
 ('meta_adset_daily_metrics',ARRAY['id','meta_adset_id','adset_name','connection_id','source','import_version','source_revision','upload_batch_id','sync_run_id','metric_date','spend_usd','purchase_value_usd','created_at','updated_at','is_current']::text[]),
 ('google_campaign_daily_costs',ARRAY['id','campaign_id','campaign_name','connection_id','source','version','sync_run_id','metric_date','cost_micros','conversion_value','fetched_at','is_current']::text[]),
 ('exchange_rates',ARRAY['rate','source_date','provider','fallback_type','rate_date','base_currency','quote_currency']::text[])
), privileges AS (
 SELECT table_name,has_schema_privilege('meta_ads_unified_worker','meta_ads','USAGE') AS schema_usage,
 ARRAY(SELECT col FROM unnest(columns) col WHERE NOT has_column_privilege('meta_ads_unified_worker','meta_ads.'||table_name,col,'SELECT')) AS missing_select_columns
 FROM permission_columns
)
SELECT jsonb_build_object('businessDate',(SELECT business_date FROM params),'connections',(SELECT jsonb_agg(to_jsonb(x)) FROM relevant_connections x),
 'metaCurrentApiLineage',(SELECT to_jsonb(x) FROM meta_lineage x),'googleCurrentApiLineage',(SELECT to_jsonb(x) FROM google_lineage x),
 'googleCurrentApiAmount',(SELECT to_jsonb(x) FROM google_amount x),'policies',(SELECT jsonb_agg(to_jsonb(x)) FROM policy x),
 'coverageAndReceipts',(SELECT jsonb_agg(to_jsonb(x)) FROM receipts x),'workerExplicitProjectionPrivileges',(SELECT jsonb_agg(to_jsonb(x)) FROM privileges x),
 'workerRawEnumUsage',(SELECT jsonb_agg(jsonb_build_object('type',t.typname,'usage',has_type_privilege('meta_ads_unified_worker',t.oid,'USAGE'))) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='meta_ads' AND t.typname IN('SourceKind','SourceDataKind','RunUnitStatus')),
 'workerExchangeRateIdHasSelect',has_column_privilege('meta_ads_unified_worker','meta_ads.exchange_rates','id','SELECT'),
 'privacy','No raw campaign/adset names, entity identifiers, provider responses, source payloads or credentials returned.',
 'limitation','Management read-only evidence plus role privilege metadata does not reproduce an actual worker connection or its interactive transaction timeout.') AS ad_lineage;
