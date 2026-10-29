WITH params AS(SELECT DATE '2026-10-28' AS business_date,'b9a3916d-67ec-4cea-a75e-e07195538249'::uuid AS run_id),
current_ads AS(
 SELECT m.ad_spend_krw,m.spend_product_id IS NOT NULL AS legacy_spend_product_present,
 m.validation_status::text,b.status::text AS batch_status,b.source_type::text AS batch_source_type,
 encode(extensions.digest('['||to_jsonb('COUPANG_ADS'::text)::text||','||to_jsonb('LEGACY_COUPANG_SINGLE_UPLOAD'::text)::text||','||to_jsonb('AD_SPEND'::text)::text||','||to_jsonb(p.business_date::text||':'||m.ad_metric_key)::text||']','sha256'),'hex') AS private_join_hash
 FROM meta_ads.coupang_ad_metrics m JOIN meta_ads.coupang_upload_batches b ON b.id=m.upload_batch_id,params p WHERE m.is_current AND m.metric_date=p.business_date
), selected_ads AS(SELECT * FROM current_ads WHERE validation_status<>'ERROR' AND batch_status='IMPORTED' AND batch_source_type='ADS'),
joined AS(
 SELECT a.ad_spend_krw,a.legacy_spend_product_present,u.match_status,u.product_name IS NOT NULL AS unified_product_present,(u.evidence->>'amountKrw')::numeric AS audit_amount
 FROM selected_ads a LEFT JOIN meta_ads.unified_product_match_results u ON u.source_key=a.private_join_hash AND u.run_id=(SELECT run_id FROM params)
), cohort AS(
 SELECT legacy_spend_product_present,unified_product_present,match_status,count(*) AS rows,sum(ad_spend_krw)::text AS raw_ad_spend,sum(audit_amount)::text AS published_audit_ad_spend
 FROM joined GROUP BY legacy_spend_product_present,unified_product_present,match_status
), published AS(
 SELECT attribution,count(*) AS fact_groups,sum(amount_krw)::text AS ad_spend,sum((payload->>'rowsCount')::int) AS source_rows FROM meta_ads.unified_daily_facts WHERE run_id=(SELECT run_id FROM params) AND component='AD_SPEND' GROUP BY attribution
)
SELECT jsonb_build_object('businessDate',(SELECT business_date FROM params),'runId',(SELECT run_id FROM params),
 'currentRows',(SELECT count(*) FROM current_ads),'selectedRows',(SELECT count(*) FROM selected_ads),
 'selectedRawAdSpend',(SELECT sum(ad_spend_krw)::text FROM selected_ads),
 'legacyLinkedAdSpend',(SELECT sum(ad_spend_krw)::text FROM selected_ads WHERE legacy_spend_product_present),
 'legacyUnlinkedAdSpend',(SELECT sum(ad_spend_krw)::text FROM selected_ads WHERE NOT legacy_spend_product_present),
 'auditMissingRows',(SELECT count(*) FROM joined WHERE match_status IS NULL),
 'auditAmountDifference',(SELECT sum(ad_spend_krw-audit_amount)::text FROM joined),
 'cohorts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY legacy_spend_product_present,unified_product_present,match_status) FROM cohort x),
 'publishedAttribution',(SELECT jsonb_agg(to_jsonb(x) ORDER BY attribution) FROM published x),
 'adCoverage',(SELECT jsonb_build_object('state',collection_state,'rows',rows_present,'mappedRows',details->'mappedRows','unmappedRows',details->'unmappedRows','unallocatedAmount',details->'unallocatedAmount','quality',details->'quality') FROM meta_ads.unified_source_coverage WHERE run_id=(SELECT run_id FROM params) AND component='AD_SPEND'),
 'privacy','Only mapping-cohort counts/amounts and public run identity; raw ad names, row keys, external entity identifiers and source payloads are not returned.',
 'limitation','Legacy linked sum matches the legacy service spendProductId inclusion rule; it is not a newly executed legacy HTTP report.') AS coupang_ad_spend;
