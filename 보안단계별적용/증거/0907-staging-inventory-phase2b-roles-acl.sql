BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
WITH protected AS (
  SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = 'patima_app'
), roles AS (
  SELECT r.oid, r.rolname, r.rolcanlogin, r.rolsuper, r.rolinherit, r.rolcreatedb,
    r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolconnlimit
  FROM pg_catalog.pg_roles AS r
  WHERE r.rolname <> 'patima_app'
), namespaces AS (
  SELECT n.oid, n.nspname, n.nspowner, n.nspacl
  FROM pg_catalog.pg_namespace AS n
  JOIN roles AS owner_role ON owner_role.oid = n.nspowner
  WHERE n.nspname IN ('public', 'auth', 'storage')
), relations AS (
  SELECT c.oid, n.nspname, c.relname, c.relowner, c.relacl
  FROM pg_catalog.pg_class AS c
  JOIN namespaces AS n ON n.oid = c.relnamespace
  JOIN roles AS owner_role ON owner_role.oid = c.relowner
  WHERE c.relkind IN ('r', 'p')
    AND (n.nspname = 'public'
      OR (n.nspname = 'auth' AND c.relname = 'users')
      OR (n.nspname = 'storage' AND c.relname IN ('buckets', 'objects')))
), guard AS MATERIALIZED (
  SELECT pg_catalog.current_setting('transaction_read_only') = 'on'
    AND pg_catalog.current_setting('statement_timeout') = '5s'
    AND pg_catalog.current_setting('lock_timeout') = '1s'
    AND pg_catalog.current_setting('server_version_num') = '170006'
    AND pg_catalog.current_database() = 'postgres'
    AND current_user::text = 'postgres'
    AND (SELECT pg_catalog.count(*) = 3 FROM namespaces)
    AND (SELECT pg_catalog.count(*) = 3 FROM relations)
    AND NOT EXISTS (SELECT 1 FROM relations AS r WHERE r.nspname = 'public') AS ok
), memberships AS (
  SELECT granted.rolname AS granted_role, member_role.rolname AS member_role,
    grantor_role.rolname AS grantor_role, m.admin_option, m.inherit_option, m.set_option
  FROM pg_catalog.pg_auth_members AS m
  JOIN roles AS granted ON granted.oid = m.roleid
  JOIN roles AS member_role ON member_role.oid = m.member
  JOIN roles AS grantor_role ON grantor_role.oid = m.grantor
), object_acl_source AS (
  SELECT 'DATABASE'::text AS object_kind, d.datname::text AS object_name,
    'CURRENT_DATABASE'::text AS namespace_scope, d.datdba AS owner_oid,
    CASE WHEN d.datacl IS NULL THEN 'SYSTEM_BASELINE_FOR_NULL_OBJECT_ACL'
      ELSE 'EXPLICIT_OBJECT_ACL' END AS acl_origin,
    COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba)) AS acl
  FROM pg_catalog.pg_database AS d
  JOIN roles AS owner_role ON owner_role.oid = d.datdba
  WHERE d.datname = pg_catalog.current_database()
  UNION ALL
  SELECT 'SCHEMA', n.nspname::text, n.nspname::text, n.nspowner,
    CASE WHEN n.nspacl IS NULL THEN 'SYSTEM_BASELINE_FOR_NULL_OBJECT_ACL'
      ELSE 'EXPLICIT_OBJECT_ACL' END,
    COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))
  FROM namespaces AS n
  UNION ALL
  SELECT 'TABLE', r.relname::text, r.nspname::text, r.relowner,
    CASE WHEN r.relacl IS NULL THEN 'SYSTEM_BASELINE_FOR_NULL_OBJECT_ACL'
      ELSE 'EXPLICIT_OBJECT_ACL' END,
    COALESCE(r.relacl, pg_catalog.acldefault('r', r.relowner))
  FROM relations AS r
), object_acls AS (
  SELECT s.object_kind, s.object_name, s.namespace_scope, s.owner_oid, s.acl_origin, s.acl
  FROM object_acl_source AS s
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(s.acl) AS x
    JOIN protected AS p ON p.oid = x.grantor OR p.oid = x.grantee
  )
), default_acl_source AS (
  SELECT 'FUTURE_DEFAULT_' || d.defaclobjtype::text AS object_kind,
    'FUTURE_CREATED_OBJECTS'::text AS object_name,
    CASE WHEN d.defaclnamespace = 0 THEN 'GLOBAL' ELSE n.nspname::text END AS namespace_scope,
    d.defaclrole AS owner_oid, 'EXPLICIT_FUTURE_DEFAULT_RECORD'::text AS acl_origin,
    d.defaclacl AS acl
  FROM pg_catalog.pg_default_acl AS d
  JOIN roles AS owner_role ON owner_role.oid = d.defaclrole
  LEFT JOIN namespaces AS n ON n.oid = d.defaclnamespace
  WHERE d.defaclnamespace = 0 OR n.oid IS NOT NULL
), default_acls AS (
  SELECT s.object_kind, s.object_name, s.namespace_scope, s.owner_oid, s.acl_origin, s.acl
  FROM default_acl_source AS s
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(s.acl) AS x
    JOIN protected AS p ON p.oid = x.grantor OR p.oid = x.grantee
  )
), all_acls AS (
  SELECT object_kind, object_name, namespace_scope, owner_oid, acl_origin, acl FROM object_acls
  UNION ALL
  SELECT object_kind, object_name, namespace_scope, owner_oid, acl_origin, acl FROM default_acls
), acl_entries AS (
  SELECT a.object_kind, a.object_name, a.namespace_scope, a.acl_origin,
    owner_role.rolname AS owner_role, grantor_role.rolname AS grantor_role,
    CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE grantee_role.rolname::text END AS grantee_role,
    x.privilege_type, x.is_grantable,
    grantor_role.oid IS NULL OR (x.grantee <> 0 AND grantee_role.oid IS NULL) AS unresolved_principal
  FROM all_acls AS a
  JOIN roles AS owner_role ON owner_role.oid = a.owner_oid
  CROSS JOIN LATERAL pg_catalog.aclexplode(a.acl) AS x
  LEFT JOIN roles AS grantor_role ON grantor_role.oid = x.grantor
  LEFT JOIN roles AS grantee_role ON grantee_role.oid = x.grantee
), acl_groups AS (
  SELECT e.object_kind, e.object_name, e.namespace_scope, e.acl_origin, e.owner_role,
    e.grantor_role, e.grantee_role, e.privilege_type, e.is_grantable,
    pg_catalog.count(*) AS acl_entry_count
  FROM acl_entries AS e
  GROUP BY e.object_kind, e.object_name, e.namespace_scope, e.acl_origin, e.owner_role,
    e.grantor_role, e.grantee_role, e.privilege_type, e.is_grantable
)
SELECT CASE
  WHEN (SELECT ok FROM guard) IS DISTINCT FROM TRUE
  THEN pg_catalog.jsonb_build_object('status', 'BLOCKED_READ_ONLY_OR_PHASE1_CATALOG_DRIFT')
  WHEN (SELECT pg_catalog.count(*) FROM roles) > 128
    OR (SELECT pg_catalog.count(*) FROM memberships) > 512
    OR (SELECT pg_catalog.count(*) FROM object_acls) > 128
    OR (SELECT pg_catalog.count(*) FROM default_acls) > 256
    OR (SELECT pg_catalog.count(*) FROM acl_groups) > 1024
  THEN pg_catalog.jsonb_build_object('status', 'BLOCKED_CATALOG_OUTPUT_LIMIT')
  WHEN EXISTS (SELECT 1 FROM default_acl_source AS s WHERE s.acl IS NULL)
    OR EXISTS (SELECT 1 FROM acl_entries AS e WHERE e.unresolved_principal)
  THEN pg_catalog.jsonb_build_object('status', 'BLOCKED_ACL_NULL_OR_UNRESOLVED_PRINCIPAL')
  ELSE pg_catalog.jsonb_build_object(
    'status', 'SCOPED_CATALOG_INVENTORY_ONLY',
    'transaction_read_only', pg_catalog.current_setting('transaction_read_only'),
    'statement_timeout', pg_catalog.current_setting('statement_timeout'),
    'lock_timeout', pg_catalog.current_setting('lock_timeout'),
    'server_version_num', pg_catalog.current_setting('server_version_num'),
    'database', pg_catalog.current_database(),
    'current_user', current_user::text,
    'protected_items_excluded', true,
    'effective_privileges_evaluated', false,
    'null_acl_semantics', 'OBJECT_NULL_USES_SYSTEM_BASELINE_NOT_EMPTY_OR_EFFECTIVE_PRIVILEGES',
    'default_acl_semantics',
      'RECORDS_AFFECT_FUTURE_OBJECTS_NOT_CURRENT_GRANTS_OR_MERGED_EFFECTIVE_DEFAULTS',
    'role_count', (SELECT pg_catalog.count(*) FROM roles),
    'direct_membership_count', (SELECT pg_catalog.count(*) FROM memberships),
    'acl_object_count', (SELECT pg_catalog.count(*) FROM object_acls),
    'future_default_record_count', (SELECT pg_catalog.count(*) FROM default_acls),
    'roles', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name', r.rolname,
        'can_login', r.rolcanlogin,
        'superuser', r.rolsuper,
        'inherit', r.rolinherit,
        'create_db', r.rolcreatedb,
        'create_role', r.rolcreaterole,
        'replication', r.rolreplication,
        'bypass_rls', r.rolbypassrls,
        'connection_limit', r.rolconnlimit
      ) ORDER BY r.rolname)
      FROM (SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreatedb, rolcreaterole,
        rolreplication, rolbypassrls, rolconnlimit FROM roles ORDER BY rolname LIMIT 128) AS r
    ), '[]'::pg_catalog.jsonb),
    'direct_memberships', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'granted_role', m.granted_role,
        'member_role', m.member_role,
        'grantor_role', m.grantor_role,
        'admin_option', m.admin_option,
        'inherit_option', m.inherit_option,
        'set_option', m.set_option
      ) ORDER BY m.granted_role, m.member_role, m.grantor_role)
      FROM (SELECT granted_role, member_role, grantor_role, admin_option, inherit_option, set_option
        FROM memberships ORDER BY granted_role, member_role, grantor_role LIMIT 512) AS m
    ), '[]'::pg_catalog.jsonb),
    'acl_groups', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'object_kind', a.object_kind,
        'object_name', a.object_name,
        'namespace_scope', a.namespace_scope,
        'acl_origin', a.acl_origin,
        'owner_role', a.owner_role,
        'grantor_role', a.grantor_role,
        'grantee_role', a.grantee_role,
        'privilege', a.privilege_type,
        'grantable', a.is_grantable,
        'acl_entry_count', a.acl_entry_count
      ) ORDER BY a.object_kind, a.namespace_scope, a.object_name, a.owner_role,
        a.grantee_role, a.grantor_role, a.privilege_type, a.is_grantable)
      FROM (SELECT object_kind, object_name, namespace_scope, acl_origin, owner_role,
        grantor_role, grantee_role, privilege_type, is_grantable, acl_entry_count
        FROM acl_groups ORDER BY object_kind, namespace_scope, object_name, owner_role,
          grantee_role, grantor_role, privilege_type, is_grantable LIMIT 1024) AS a
    ), '[]'::pg_catalog.jsonb)
  )
END AS inventory_json;
ROLLBACK;
