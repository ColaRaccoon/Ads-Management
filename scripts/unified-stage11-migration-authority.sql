SELECT current_user,
 pg_has_role('postgres','meta_ads_app','MEMBER') postgres_is_app_member,
 pg_has_role('postgres','meta_ads_app','USAGE') postgres_inherits_app,
 has_table_privilege('postgres','meta_ads.app_users','REFERENCES') postgres_appuser_references,
 has_schema_privilege('postgres','meta_ads','CREATE') postgres_schema_create,
 has_schema_privilege('postgres','extensions','USAGE') postgres_extensions_usage,
 (SELECT rolsuper FROM pg_roles WHERE rolname='postgres') postgres_super,
 (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON e.extnamespace=n.oid WHERE extname='btree_gist') btree_gist_schema;
