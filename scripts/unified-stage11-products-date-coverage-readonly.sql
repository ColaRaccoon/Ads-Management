WITH current_facts AS (
 SELECT f.product_name,r.platform,r.scope_key,r.business_date FROM meta_ads.unified_source_publications p
 JOIN meta_ads.unified_aggregation_runs r ON r.id=p.run_id AND r.status='PUBLISHED'
 JOIN meta_ads.unified_daily_facts f ON f.run_id=r.id WHERE f.product_name IS NOT NULL
), coverage AS (
 SELECT u.canonical_name,min(f.business_date) first_date,max(f.business_date) last_date,count(DISTINCT f.business_date) published_days,
 count(DISTINCT (f.platform,f.scope_key,f.business_date)) source_days
 FROM meta_ads.unified_products u LEFT JOIN current_facts f ON f.product_name=u.canonical_name WHERE u.active GROUP BY u.canonical_name
) SELECT jsonb_build_object('products',(SELECT jsonb_agg(to_jsonb(c) ORDER BY canonical_name) FROM coverage c),'activeProducts',(SELECT count(*) FROM coverage),'withPublishedFacts',(SELECT count(*) FROM coverage WHERE published_days>0),'privacy','Product names and date counts only; current published runs, no customer fields') coverage;
