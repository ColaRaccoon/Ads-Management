SELECT n.nspname AS schema_name,pg_get_userbyid(n.nspowner) AS owner,
 has_schema_privilege('postgres',n.oid,'USAGE WITH GRANT OPTION') AS postgres_usage_grant,
 has_schema_privilege('meta_ads_app',n.oid,'USAGE WITH GRANT OPTION') AS app_usage_grant,
 has_schema_privilege('meta_ads_app',n.oid,'USAGE') AS app_usage
FROM pg_namespace n WHERE n.nspname IN ('meta_ads','public','extensions') ORDER BY n.nspname;
