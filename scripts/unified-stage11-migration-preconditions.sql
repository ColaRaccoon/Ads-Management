SELECT jsonb_build_object(
 'extensions',(SELECT jsonb_agg(jsonb_build_object('name',e.extname,'schema',n.nspname,'version',e.extversion)) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname IN ('btree_gist','pgcrypto')),
 'roles',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'super',rolsuper,'bypass',rolbypassrls)),'[]') FROM pg_roles WHERE rolname IN ('meta_ads_unified_report','meta_ads_unified_worker')),
 'unifiedTables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relname LIKE 'unified_%' AND c.relkind='r'),
 'activeJobs',(SELECT coalesce(jsonb_agg(jsonb_build_object('provider',provider,'status',status,'count',count)),'[]') FROM (SELECT c.provider,r.status,count(*)::text count FROM meta_ads.sync_runs r JOIN meta_ads.source_connections c ON c.id=r.connection_id WHERE r.status IN ('QUEUED','RUNNING') GROUP BY c.provider,r.status) s)
) AS preconditions;
