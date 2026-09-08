\set ON_ERROR_STOP on
\pset pager off

\connect -reuse-previous=on meta_ads_staging

BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;

DO $verify$
DECLARE
  expected_table_count integer;
  target_role_count integer;
  creator_edge_count integer;
  forbidden_membership_count integer;
  actual_enums text[];
  actual_functions text[];
  actual_triggers text[];
BEGIN
  IF current_database() <> 'meta_ads_staging'
    OR current_user <> 'meta_ads_stg_migration'
    OR session_user <> 'meta_ads_stg_migration' THEN
    RAISE EXCEPTION 'R2A_VERIFY_TARGET_PRINCIPAL_MISMATCH';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'R2A_VERIFY_POSTGRES_MAJOR_MISMATCH';
  END IF;

  SELECT count(*) INTO target_role_count
  FROM pg_roles
  WHERE rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
    AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit = 2;
  IF target_role_count <> 3 THEN
    RAISE EXCEPTION 'R2A_VERIFY_ROLE_ATTRIBUTE_MISMATCH';
  END IF;

  SELECT count(*) INTO creator_edge_count
  FROM pg_auth_members m
  JOIN pg_roles granted_role ON granted_role.oid = m.roleid
  JOIN pg_roles member_role ON member_role.oid = m.member
  WHERE granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
    AND member_role.rolname = 'postgres'
    AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option;
  SELECT count(*) INTO forbidden_membership_count
  FROM pg_auth_members m
  JOIN pg_roles granted_role ON granted_role.oid = m.roleid
  JOIN pg_roles member_role ON member_role.oid = m.member
  WHERE (granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
      OR member_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup'))
    AND NOT (
      granted_role.rolname IN ('meta_ads_stg_runtime', 'meta_ads_stg_migration', 'meta_ads_stg_backup')
      AND member_role.rolname = 'postgres'
      AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option
    );
  IF creator_edge_count <> 3 OR forbidden_membership_count <> 0 THEN
    RAISE EXCEPTION 'R2A_VERIFY_ROLE_MEMBERSHIP_MISMATCH';
  END IF;

  IF pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = 'meta_ads_staging')) <>
      'meta_ads_stg_migration'
    OR pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'public')) <>
      'meta_ads_stg_migration' THEN
    RAISE EXCEPTION 'R2A_VERIFY_OWNER_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('S', 'v', 'm', 'f')
  ) THEN
    RAISE EXCEPTION 'R2A_VERIFY_NON_TABLE_RELATION_PRESENT';
  END IF;

  SELECT array_agg(t.typname ORDER BY t.typname) INTO actual_enums
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typtype = 'e';
  IF actual_enums IS DISTINCT FROM ARRAY[
    'ad_stage', 'app_role', 'cafe24_coupon_scope', 'conflict_policy',
    'coupang_upload_source_type', 'creative_log_action_type', 'creative_parse_status',
    'decision_type', 'exchange_rate_fallback_type', 'invite_status', 'match_source',
    'match_type', 'report_type', 'row_validation_status', 'security_audit_actor_type',
    'security_audit_result', 'storage_tombstone_domain', 'storage_tombstone_state',
    'upload_level', 'upload_status'
  ]::text[] THEN
    RAISE EXCEPTION 'R2A_VERIFY_ENUM_INVENTORY_MISMATCH';
  END IF;

  SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' ORDER BY p.proname)
  INTO actual_functions
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p');
  IF actual_functions IS DISTINCT FROM ARRAY['security_audit_events_append_only()']::text[] THEN
    RAISE EXCEPTION 'R2A_VERIFY_FUNCTION_INVENTORY_MISMATCH';
  END IF;

  SELECT array_agg(t.tgname ORDER BY t.tgname) INTO actual_triggers
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal;
  IF actual_triggers IS DISTINCT FROM ARRAY[
    'security_audit_events_append_only_trigger',
    'security_audit_events_reject_truncate'
  ]::text[] THEN
    RAISE EXCEPTION 'R2A_VERIFY_TRIGGER_INVENTORY_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND pg_get_userbyid(c.relowner) <> 'meta_ads_stg_migration'
  ) OR EXISTS (
    SELECT 1
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
      AND pg_get_userbyid(t.typowner) <> 'meta_ads_stg_migration'
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      AND pg_get_userbyid(p.proowner) <> 'meta_ads_stg_migration'
  ) THEN
    RAISE EXCEPTION 'R2A_VERIFY_OBJECT_OWNER_MISMATCH';
  END IF;

  IF (SELECT count(*) FROM public._prisma_migrations) <> 37
    OR EXISTS (
      SELECT 1 FROM public._prisma_migrations
      WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL OR applied_steps_count <> 1
    ) THEN
    RAISE EXCEPTION 'R2A_VERIFY_MIGRATION_STATE_MISMATCH';
  END IF;
  IF EXISTS (
    WITH expected(name, checksum) AS (VALUES
      ('20260529000000_init', '3c8b88e0713c80de0499fcb90b96411417d2953fbb8f5aba9ac0048295ee4550'),
      ('20260529150000_add_exchange_rates', '9cfd8137dc5b3026f8594d880e8ac60cd44e0270964a14f54f8c604c8fc125b5'),
      ('20260529153000_fix_exchange_rate_unique_index_name', '6f2d6e00afd3efa94ede7612d8b3c8c0753f931cd36f8ccebdf70291e8a11ec9'),
      ('20260529162500_remove_ad_cost_multiplier', '247236f0944c00eb31af52702e353b96645e699ed6e32371baeea799401dc161'),
      ('20260601000000_add_meta_ad_daily_metrics', 'b2db9c46ea0a2c58f31bee02b8f9ec8442716b0d18f3ab4a8cca1b3992c171ec'),
      ('20260604000000_add_creative_change_logs', '1893ad8b49ab2105729c3ecc42c8b166d90678916e432e2bd1d3d9bead0496b0'),
      ('20260608000000_cleanup_orphan_creatives', 'c0a80cafd9674aa0f8032f85b86357205c1f022530041d3c4e3b9a44e2c52975'),
      ('20260610000000_add_product_change_logs', 'e719a298d0cd9f97ba7822a29d12c0c0f26390bce68b2e885c06461f93aa0d0e'),
      ('20260611000000_add_cafe24_sales', '2906da1d95dc3ed81b08b7b7c4bf10e71be9d4c2103af72cba969f227b82d8f6'),
      ('20260611001000_add_cafe24_order_line_current_versions', '01d5f312e22947e1bf413c0ef149fe38ac9fe267309c6b69ca028c6301b9b320'),
      ('20260625000000_add_coupang_module_models', '6648ca79bfa2ff47717d181230c0d2495caa2fd9ed91807f836ae1365b6d649d'),
      ('20260626000000_add_coupang_promotion_prices', 'df97f94cca6d7af5b0cb96114cbf0cf063ab4cc86c3a605eb8b986815bf25abe'),
      ('20260701000000_add_coupang_ad_metric_ad_name', '976ce38bdecde9c7b014875ba3d758ab5e9454779f1d0edbb59c28aa44344579'),
      ('20260703000000_add_coupang_product_groups', '6539fb5413543d4a87e19e72f967c31d268e616b2e1c2a6294b3435dbf9dff91'),
      ('20260709000000_add_coupang_manual_purchases', 'ddcc1055517035b66c6c1574fe017151e61e46e31b3d942289fbf17999d976b7'),
      ('20260710000000_add_coupang_manual_purchase_vat', '5034e828dc6e47cbb8cbe9fcab95787bbd3e9591a6e051f16aaabe0c699efa95'),
      ('20260721000000_add_coupang_manual_purchase_sales_amount', '4f4794d4c4a4dd12d4d3125b10856ce5264a76d2379c21d7d0d3b9871f087d49'),
      ('20260721173000_add_coupang_manual_purchase_product_cost', 'd904e42e12989eeb08014ef9d9d57584bb7abd195929e8c1686be8f732720ef8'),
      ('20260722000000_backfill_coupang_manual_purchase_sales_amount', 'c77a195c247bb8671be62931db7a089fed2a247378123b8ab43f24215d48ce74'),
      ('20260722150000_split_coupang_shipping_fees', '87589cb39f5a14af73f7f752ca1e368ad9503af1fc9a64020d7bed9fd26dd415'),
      ('20260722200000_add_global_coupang_sales_fee_rules', 'da72ac728440b265c34fb726f449337ee022e73d9ee8e1e7f937cf6bfab91586'),
      ('20260723110000_normalize_coupang_cost_rule_history', '89964999bedc69fa6adf475bbc577fb3cb98c338dedeab7ed9b2bd835ac63b37'),
      ('20260724000000_normalize_manual_purchase_accounting', '60190e2d7562571125e775764b8decbb4fc0be43695110047117d857afcd9806'),
      ('20260724010000_remove_coupang_manual_purchase_vat', '91e63ecf70b8e05294bd4dceccefeb27311c86b0880e544b40a024e28961b7d7'),
      ('20260724170000_add_coupang_daily_report_categories', '4d72f0070e853a9ee4f7f43016f39803a5988fea17f817120e5e6a72299a742b'),
      ('20260731000000_add_cafe24_coupon_rules', 'e525c35de525853fd29e0e82a090235da8444a8ee54a85ab9eb7352fbd5aa0ad'),
      ('20260810170000_add_meta_video_play_counts', '541c5f6ba793c281eba3e8e641a4efcf671b4858cede5e2b129970185117c4e0'),
      ('20260820090000_add_meta_add_to_cart_count', '693feb16fbc76524287f09b27c112997a2cecfaa807f5895b56322744b80d64b'),
      ('20260824110000_add_security_auth', '6b867f1d564a5c6c383a13aa6d45448bc872650d80af99c581b7f1cb731a1d9f'),
      ('20260824140000_add_actor_attribution', '6fd63d3541ab1d023ca5beb8982e9009d84dc08571d6e6c139679c62c690e6fd'),
      ('20260825090000_add_user_lifecycle_audit', '780f8bb357263382698fb80058677f41159afe88b2f8db0ca4178f7e1693b21f'),
      ('20260825110000_protect_security_audit_truncate', 'c378bab4bbd506f786434929661463bfa84318d3b95882e5796e3ec7d39c2d63'),
      ('20260825150000_add_distributed_rate_limits', '349c028706866d18a66a22edb81ec6cd1a463ba88870e327e689084af0456d5f'),
      ('20260825170000_minimize_cafe24_coupang_raw_rows', '476827c4c03aa04f765fd22ca7c080cc008407a61134d03e4c94f54684bd81eb'),
      ('20260825210000_add_storage_tombstones', 'b27decf14c9d6dfae19621404b3258a4dc2f867950d9981e9607ae3385ffe4b0'),
      ('20260826010000_add_local_native_auth', '0e4876a6c3fe0f3aa9637b7bbb9577b3acff8cd384ea681d50ed2621fcfed8ea'),
      ('20260826020000_add_local_edge_request_nonces', 'c154a5778e4768b9341ac4f8514815f8c214aef53aeed0eec821c1c2e0c3a94e')
    )
    SELECT 1
    FROM expected e
    FULL JOIN public._prisma_migrations m ON m.migration_name = e.name
    WHERE e.name IS NULL OR m.migration_name IS NULL OR m.checksum <> e.checksum
  ) THEN
    RAISE EXCEPTION 'R2A_VERIFY_MIGRATION_CHAIN_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_database d
    CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
    WHERE d.datname = 'meta_ads_staging' AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
    WHERE n.nspname = 'public' AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(
      c.relacl,
      acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner)
    )) acl
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(t.typacl, acldefault('T', t.typowner))) acl
    WHERE n.nspname = 'public' AND t.typtype = 'e' AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'R2A_VERIFY_PUBLIC_ACL_PRESENT';
  END IF;

  IF (SELECT count(*)
      FROM pg_default_acl d
      WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'meta_ads_stg_migration')
        AND d.defaclnamespace = 0 AND d.defaclobjtype IN ('f', 'T')) <> 2 THEN
    RAISE EXCEPTION 'R2A_VERIFY_DEFAULT_ACL_REQUIRED_REVOKE_MISSING';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
    WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'meta_ads_stg_migration')
      AND acl.grantee <> d.defaclrole
  ) OR EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'meta_ads_stg_migration')
      AND d.defaclnamespace <> 0
  ) OR EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclrole <> (SELECT oid FROM pg_roles WHERE rolname = 'meta_ads_stg_migration')
  ) THEN
    RAISE EXCEPTION 'R2A_VERIFY_DEFAULT_ACL_PRINCIPAL_PRESENT';
  END IF;

  IF NOT has_database_privilege('meta_ads_stg_runtime', 'meta_ads_staging', 'CONNECT')
    OR has_database_privilege('meta_ads_stg_runtime', 'meta_ads_staging', 'CREATE')
    OR has_database_privilege('meta_ads_stg_runtime', 'meta_ads_staging', 'TEMPORARY')
    OR NOT has_database_privilege('meta_ads_stg_backup', 'meta_ads_staging', 'CONNECT')
    OR has_database_privilege('meta_ads_stg_backup', 'meta_ads_staging', 'CREATE')
    OR has_database_privilege('meta_ads_stg_backup', 'meta_ads_staging', 'TEMPORARY') THEN
    RAISE EXCEPTION 'R2A_VERIFY_DATABASE_PRIVILEGE_MISMATCH';
  END IF;
  IF NOT has_schema_privilege('meta_ads_stg_runtime', 'public', 'USAGE')
    OR has_schema_privilege('meta_ads_stg_runtime', 'public', 'CREATE')
    OR NOT has_schema_privilege('meta_ads_stg_backup', 'public', 'USAGE')
    OR has_schema_privilege('meta_ads_stg_backup', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'R2A_VERIFY_SCHEMA_PRIVILEGE_MISMATCH';
  END IF;

  WITH expected(table_name, can_select, can_insert, can_update, can_delete) AS (VALUES
    ('_prisma_migrations', false, false, false, false),
    ('adset_name_aliases', false, false, false, false),
    ('adset_product_histories', true, true, false, false),
    ('adset_stage_histories', true, true, false, false),
    ('app_auth_sessions', true, true, true, false),
    ('app_settings', true, true, true, false),
    ('app_users', true, true, true, false),
    ('cafe24_coupon_rules', true, true, true, true),
    ('cafe24_order_lines', true, true, true, true),
    ('cafe24_product_rules', true, true, true, true),
    ('cafe24_upload_batches', true, true, true, true),
    ('cafe24_upload_row_errors', true, true, false, true),
    ('change_logs', true, true, false, false),
    ('coupang_ad_metrics', true, true, true, true),
    ('coupang_cost_rules', true, true, true, true),
    ('coupang_cost_rules_backup_20260723', false, false, false, false),
    ('coupang_daily_report_categories', true, true, true, false),
    ('coupang_daily_report_category_products', true, true, false, true),
    ('coupang_manual_purchases', true, true, false, true),
    ('coupang_product_groups', true, true, true, false),
    ('coupang_product_rules', true, true, true, true),
    ('coupang_products', true, true, true, true),
    ('coupang_promotion_prices', true, true, true, false),
    ('coupang_sale_lines', true, true, true, true),
    ('coupang_sales_fee_rules', true, true, true, false),
    ('coupang_upload_batches', true, true, true, true),
    ('coupang_upload_row_errors', true, true, false, true),
    ('creative_aliases', true, true, true, true),
    ('creative_change_logs', true, true, false, true),
    ('creative_placements', true, true, true, true),
    ('creatives', true, true, true, true),
    ('decision_logs', true, true, false, false),
    ('decision_runs', true, true, false, false),
    ('exchange_rates', true, true, true, false),
    ('local_account_setup_tokens', false, false, false, false),
    ('local_credentials', false, false, false, false),
    ('local_edge_request_nonces', false, false, false, false),
    ('meta_ad_daily_metrics', true, true, true, true),
    ('meta_ads', true, true, true, false),
    ('meta_adset_daily_metrics', true, true, true, true),
    ('meta_adsets', true, true, true, false),
    ('meta_campaigns', true, true, true, false),
    ('product_change_logs', true, true, false, false),
    ('product_cost_rules', true, true, true, true),
    ('product_cpa_rules', true, true, true, true),
    ('product_match_rules', true, true, true, true),
    ('products', true, true, true, true),
    ('report_exports', true, true, true, false),
    ('security_audit_events', true, true, false, false),
    ('security_rate_limit_buckets', true, true, true, true),
    ('storage_tombstones', true, true, true, false),
    ('upload_batches', true, true, true, true),
    ('upload_row_errors', true, true, false, true),
    ('upload_rows', true, true, true, true)
  ), actual AS (
    SELECT c.relname AS table_name,
      has_table_privilege('meta_ads_stg_runtime', c.oid, 'SELECT') AS can_select,
      has_table_privilege('meta_ads_stg_runtime', c.oid, 'INSERT') AS can_insert,
      has_table_privilege('meta_ads_stg_runtime', c.oid, 'UPDATE') AS can_update,
      has_table_privilege('meta_ads_stg_runtime', c.oid, 'DELETE') AS can_delete,
      has_table_privilege('meta_ads_stg_runtime', c.oid, 'TRUNCATE') AS can_truncate,
      has_table_privilege('meta_ads_stg_runtime', c.oid, 'REFERENCES') AS can_references,
      has_table_privilege('meta_ads_stg_runtime', c.oid, 'TRIGGER') AS can_trigger,
      has_table_privilege('meta_ads_stg_runtime', c.oid, 'MAINTAIN') AS can_maintain
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  )
  SELECT count(*) INTO expected_table_count FROM expected;
  IF expected_table_count <> 54 OR EXISTS (
    WITH expected(table_name, can_select, can_insert, can_update, can_delete) AS (VALUES
      ('_prisma_migrations', false, false, false, false), ('adset_name_aliases', false, false, false, false),
      ('adset_product_histories', true, true, false, false), ('adset_stage_histories', true, true, false, false),
      ('app_auth_sessions', true, true, true, false), ('app_settings', true, true, true, false),
      ('app_users', true, true, true, false), ('cafe24_coupon_rules', true, true, true, true),
      ('cafe24_order_lines', true, true, true, true), ('cafe24_product_rules', true, true, true, true),
      ('cafe24_upload_batches', true, true, true, true), ('cafe24_upload_row_errors', true, true, false, true),
      ('change_logs', true, true, false, false), ('coupang_ad_metrics', true, true, true, true),
      ('coupang_cost_rules', true, true, true, true), ('coupang_cost_rules_backup_20260723', false, false, false, false),
      ('coupang_daily_report_categories', true, true, true, false),
      ('coupang_daily_report_category_products', true, true, false, true),
      ('coupang_manual_purchases', true, true, false, true), ('coupang_product_groups', true, true, true, false),
      ('coupang_product_rules', true, true, true, true), ('coupang_products', true, true, true, true),
      ('coupang_promotion_prices', true, true, true, false), ('coupang_sale_lines', true, true, true, true),
      ('coupang_sales_fee_rules', true, true, true, false), ('coupang_upload_batches', true, true, true, true),
      ('coupang_upload_row_errors', true, true, false, true), ('creative_aliases', true, true, true, true),
      ('creative_change_logs', true, true, false, true), ('creative_placements', true, true, true, true),
      ('creatives', true, true, true, true), ('decision_logs', true, true, false, false),
      ('decision_runs', true, true, false, false), ('exchange_rates', true, true, true, false),
      ('local_account_setup_tokens', false, false, false, false), ('local_credentials', false, false, false, false),
      ('local_edge_request_nonces', false, false, false, false), ('meta_ad_daily_metrics', true, true, true, true),
      ('meta_ads', true, true, true, false), ('meta_adset_daily_metrics', true, true, true, true),
      ('meta_adsets', true, true, true, false), ('meta_campaigns', true, true, true, false),
      ('product_change_logs', true, true, false, false), ('product_cost_rules', true, true, true, true),
      ('product_cpa_rules', true, true, true, true), ('product_match_rules', true, true, true, true),
      ('products', true, true, true, true), ('report_exports', true, true, true, false),
      ('security_audit_events', true, true, false, false),
      ('security_rate_limit_buckets', true, true, true, true),
      ('storage_tombstones', true, true, true, false), ('upload_batches', true, true, true, true),
      ('upload_row_errors', true, true, false, true), ('upload_rows', true, true, true, true)
    ), actual AS (
      SELECT c.relname AS table_name,
        has_table_privilege('meta_ads_stg_runtime', c.oid, 'SELECT') AS can_select,
        has_table_privilege('meta_ads_stg_runtime', c.oid, 'INSERT') AS can_insert,
        has_table_privilege('meta_ads_stg_runtime', c.oid, 'UPDATE') AS can_update,
        has_table_privilege('meta_ads_stg_runtime', c.oid, 'DELETE') AS can_delete,
        has_table_privilege('meta_ads_stg_runtime', c.oid, 'TRUNCATE') AS can_truncate,
        has_table_privilege('meta_ads_stg_runtime', c.oid, 'REFERENCES') AS can_references,
        has_table_privilege('meta_ads_stg_runtime', c.oid, 'TRIGGER') AS can_trigger,
        has_table_privilege('meta_ads_stg_runtime', c.oid, 'MAINTAIN') AS can_maintain
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    )
    SELECT 1 FROM expected e FULL JOIN actual a USING (table_name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL
      OR a.can_select IS DISTINCT FROM e.can_select
      OR a.can_insert IS DISTINCT FROM e.can_insert
      OR a.can_update IS DISTINCT FROM e.can_update
      OR a.can_delete IS DISTINCT FROM e.can_delete
      OR a.can_truncate OR a.can_references OR a.can_trigger OR a.can_maintain
  ) THEN
    RAISE EXCEPTION 'R2A_VERIFY_RUNTIME_TABLE_MATRIX_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND (
        NOT has_table_privilege('meta_ads_stg_backup', c.oid, 'SELECT')
        OR has_table_privilege('meta_ads_stg_backup', c.oid, 'INSERT')
        OR has_table_privilege('meta_ads_stg_backup', c.oid, 'UPDATE')
        OR has_table_privilege('meta_ads_stg_backup', c.oid, 'DELETE')
        OR has_table_privilege('meta_ads_stg_backup', c.oid, 'TRUNCATE')
        OR has_table_privilege('meta_ads_stg_backup', c.oid, 'REFERENCES')
        OR has_table_privilege('meta_ads_stg_backup', c.oid, 'TRIGGER')
        OR has_table_privilege('meta_ads_stg_backup', c.oid, 'MAINTAIN')
      )
  ) THEN
    RAISE EXCEPTION 'R2A_VERIFY_BACKUP_TABLE_MATRIX_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
      AND NOT has_type_privilege('meta_ads_stg_runtime', t.oid, 'USAGE')
  ) OR EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
      AND has_type_privilege('meta_ads_stg_backup', t.oid, 'USAGE')
  ) THEN
    RAISE EXCEPTION 'R2A_VERIFY_ENUM_PRIVILEGE_MISMATCH';
  END IF;

  IF has_function_privilege(
      'meta_ads_stg_runtime', 'public.security_audit_events_append_only()', 'EXECUTE')
    OR has_function_privilege(
      'meta_ads_stg_backup', 'public.security_audit_events_append_only()', 'EXECUTE') THEN
    RAISE EXCEPTION 'R2A_VERIFY_FUNCTION_PRIVILEGE_MISMATCH';
  END IF;

  -- Deliberate residual: base postgres DB still grants PUBLIC CONNECT/TEMPORARY.
  IF NOT has_database_privilege('meta_ads_stg_runtime', 'postgres', 'CONNECT')
    OR NOT has_database_privilege('meta_ads_stg_runtime', 'postgres', 'TEMPORARY')
    OR NOT has_database_privilege('meta_ads_stg_migration', 'postgres', 'CONNECT')
    OR NOT has_database_privilege('meta_ads_stg_migration', 'postgres', 'TEMPORARY')
    OR NOT has_database_privilege('meta_ads_stg_backup', 'postgres', 'CONNECT')
    OR NOT has_database_privilege('meta_ads_stg_backup', 'postgres', 'TEMPORARY') THEN
    RAISE EXCEPTION 'R2A_VERIFY_BASE_PUBLIC_ACL_CHANGED_OR_RESIDUAL_MISSING';
  END IF;
END
$verify$;

SELECT pg_catalog.jsonb_build_object(
  'status', 'CATALOG_VERIFY_PASS_WITH_BASE_DB_RESIDUAL',
  'database', current_database(),
  'server_version_num', current_setting('server_version_num'),
  'table_count', (
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ),
  'enum_count', (
    SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
  ),
  'function_count', (
    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
  ),
  'user_trigger_count', (
    SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ),
  'migration_count', (SELECT count(*) FROM public._prisma_migrations),
  'runtime_table_count_with_any_dml', (
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND (
        has_table_privilege('meta_ads_stg_runtime', c.oid, 'SELECT')
        OR has_table_privilege('meta_ads_stg_runtime', c.oid, 'INSERT')
        OR has_table_privilege('meta_ads_stg_runtime', c.oid, 'UPDATE')
        OR has_table_privilege('meta_ads_stg_runtime', c.oid, 'DELETE')
      )
  ),
  'backup_select_table_count', (
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND has_table_privilege('meta_ads_stg_backup', c.oid, 'SELECT')
  ),
  'base_postgres_residual', pg_catalog.jsonb_build_object(
    'scope', 'INHERITED_PUBLIC_NOT_FULL_ISOLATION',
    'runtime_connect', has_database_privilege('meta_ads_stg_runtime', 'postgres', 'CONNECT'),
    'runtime_temporary', has_database_privilege('meta_ads_stg_runtime', 'postgres', 'TEMPORARY'),
    'migration_connect', has_database_privilege('meta_ads_stg_migration', 'postgres', 'CONNECT'),
    'migration_temporary', has_database_privilege('meta_ads_stg_migration', 'postgres', 'TEMPORARY'),
    'backup_connect', has_database_privilege('meta_ads_stg_backup', 'postgres', 'CONNECT'),
    'backup_temporary', has_database_privilege('meta_ads_stg_backup', 'postgres', 'TEMPORARY')
  ),
  'actual_credential_connection_tests', 'OUTSIDE_THIS_CATALOG_QUERY',
  'provider_runtime_pooler_test', 'NOT_RUN'
) AS verify_json;

ROLLBACK;
