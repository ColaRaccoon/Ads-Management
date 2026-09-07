BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
WITH relations AS (
  SELECT c.oid, n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
  WHERE c.relkind IN ('r', 'p') AND r.rolname <> 'patima_app'
    AND (n.nspname = 'public' OR (n.nspname = 'auth' AND c.relname = 'users')
      OR (n.nspname = 'storage' AND c.relname IN ('buckets', 'objects')))
), columns AS (
  SELECT c.oid, c.nspname, c.relname, a.attnum, a.attname, t.typname, a.attnotnull
  FROM relations c JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  WHERE a.attnum > 0 AND NOT a.attisdropped AND (c.nspname = 'public'
    OR (c.nspname = 'auth' AND a.attname IN ('id','email','email_confirmed_at','banned_until','deleted_at','is_anonymous'))
    OR (c.nspname = 'storage' AND c.relname = 'buckets' AND a.attname IN ('id','public','file_size_limit','allowed_mime_types'))
    OR (c.nspname = 'storage' AND c.relname = 'objects' AND a.attname IN ('id','bucket_id','name')))
), enums AS (
  SELECT t.typname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_catalog.pg_roles r ON r.oid = t.typowner
  WHERE n.nspname = 'public' AND t.typtype = 'e' AND r.rolname <> 'patima_app'
)
SELECT CASE WHEN pg_catalog.current_setting('transaction_read_only') <> 'on'
  OR current_user::text = 'patima_app'
THEN pg_catalog.jsonb_build_object('status', 'BLOCKED_READ_ONLY_OR_PRINCIPAL')
ELSE pg_catalog.jsonb_build_object(
  'transaction_read_only', pg_catalog.current_setting('transaction_read_only'),
  'statement_timeout', pg_catalog.current_setting('statement_timeout'),
  'lock_timeout', pg_catalog.current_setting('lock_timeout'),
  'server_version', pg_catalog.current_setting('server_version'),
  'server_version_num', pg_catalog.current_setting('server_version_num'),
  'database', pg_catalog.current_database(), 'current_user', current_user::text,
  'scope', 'CATALOG_ONLY_PROTECTED_OWNERSHIP_EXCLUDED',
  'relation_count', (SELECT pg_catalog.count(*) FROM relations),
  'column_count', (SELECT pg_catalog.count(*) FROM columns),
  'enum_count', (SELECT pg_catalog.count(*) FROM enums),
  'truncated', (SELECT pg_catalog.count(*) > 256 FROM relations)
    OR (SELECT pg_catalog.count(*) > 2048 FROM columns)
    OR (SELECT pg_catalog.count(*) > 128 FROM enums),
  'relations', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'schema', c.nspname, 'table', c.relname, 'rls', c.relrowsecurity,
    'rls_forced', c.relforcerowsecurity,
    'columns', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', a.attname, 'type', a.typname, 'not_null', a.attnotnull
    ) ORDER BY a.attnum)
    FROM (SELECT oid, attnum, attname, typname, attnotnull FROM columns
      ORDER BY nspname, relname, attnum LIMIT 2048) a WHERE a.oid = c.oid)
  ) ORDER BY c.nspname, c.relname)
  FROM (SELECT oid, nspname, relname, relrowsecurity, relforcerowsecurity
    FROM relations ORDER BY nspname, relname LIMIT 256) c
  ), '[]'::pg_catalog.jsonb),
  'public_enums', COALESCE((SELECT pg_catalog.jsonb_agg(t.typname ORDER BY t.typname)
    FROM (SELECT typname FROM enums ORDER BY typname LIMIT 128) t
  ), '[]'::pg_catalog.jsonb)
) END AS inventory_json;
ROLLBACK;
