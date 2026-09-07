BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
WITH relations AS (
  SELECT c.oid, n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_roles AS r ON r.oid = c.relowner
  WHERE c.relkind IN ('r', 'p') AND r.rolname <> 'patima_app'
    AND ((n.nspname = 'auth' AND c.relname = 'users')
      OR (n.nspname = 'storage' AND c.relname IN ('buckets', 'objects')))
), guard AS MATERIALIZED (
  SELECT pg_catalog.current_setting('transaction_read_only') = 'on'
    AND pg_catalog.current_setting('statement_timeout') = '5s'
    AND pg_catalog.current_setting('lock_timeout') = '1s'
    AND pg_catalog.current_setting('server_version_num') = '170006'
    AND pg_catalog.current_database() = 'postgres'
    AND current_user::text = 'postgres'
    AND (SELECT pg_catalog.count(*) = 3 FROM relations)
    AND NOT EXISTS (
      SELECT 1 FROM relations AS r WHERE pg_catalog.row_security_active(r.oid)
    ) AS ok
), auth_rows AS MATERIALIZED (
  SELECT u.email, u.email_confirmed_at, u.banned_until, u.deleted_at, u.is_anonymous
  FROM auth.users AS u CROSS JOIN guard AS g
  WHERE g.ok
  LIMIT 10001
), auth_normalized AS (
  SELECT a.email_confirmed_at, a.banned_until, a.deleted_at, a.is_anonymous,
    a.email IS NULL OR pg_catalog.btrim(a.email, ' ') = '' AS missing_email,
    CASE WHEN pg_catalog.char_length(pg_catalog.btrim(a.email, ' ')) BETWEEN 1 AND 320
      AND (pg_catalog.btrim(a.email, ' ') COLLATE pg_catalog."C") !~ '[^!-~]'
      AND (pg_catalog.btrim(a.email, ' ') COLLATE pg_catalog."C") ~ '^[^ @]+@[^ @]+[.][^ @]+$'
    THEN pg_catalog.lower(pg_catalog.btrim(a.email, ' ') COLLATE pg_catalog."C")
    ELSE NULL END AS normalized_email
  FROM auth_rows AS a
), duplicate_email_groups AS (
  SELECT pg_catalog.count(*) AS users_in_group
  FROM auth_normalized AS a
  WHERE a.normalized_email IS NOT NULL
  GROUP BY a.normalized_email
  HAVING pg_catalog.count(*) > 1
), bucket_rows AS MATERIALIZED (
  SELECT b.id, b.public, b.file_size_limit, b.allowed_mime_types,
    CASE WHEN b.allowed_mime_types IS NULL THEN 'NULL'
      WHEN pg_catalog.cardinality(b.allowed_mime_types) = 0 THEN 'EMPTY'
      ELSE 'NONEMPTY' END AS mime_array_state,
    COALESCE(pg_catalog.cardinality(b.allowed_mime_types), 0) AS mime_type_count
  FROM storage.buckets AS b CROSS JOIN guard AS g
  WHERE g.ok AND b.id = 'meta-ads-security-step7-dev'
  LIMIT 2
), policies AS (
  SELECT p.polrelid, p.polcmd, p.polroles
  FROM pg_catalog.pg_policy AS p
  JOIN relations AS r ON r.oid = p.polrelid
  CROSS JOIN guard AS g
  WHERE g.ok AND r.nspname = 'storage'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS excluded
      WHERE excluded.rolname = 'patima_app' AND excluded.oid = ANY(p.polroles)
    )
), policy_role_groups AS (
  SELECT r.relname, p.polcmd,
    CASE WHEN expanded.role_oid = 0 THEN 'PUBLIC' ELSE role_label.rolname::text END AS role_name,
    pg_catalog.count(*) AS policy_role_count
  FROM policies AS p
  JOIN relations AS r ON r.oid = p.polrelid
  CROSS JOIN LATERAL pg_catalog.unnest(p.polroles) AS expanded(role_oid)
  LEFT JOIN pg_catalog.pg_roles AS role_label ON role_label.oid = expanded.role_oid
  WHERE expanded.role_oid = 0
    OR (role_label.rolname IS NOT NULL AND role_label.rolname <> 'patima_app')
  GROUP BY r.relname, p.polcmd,
    CASE WHEN expanded.role_oid = 0 THEN 'PUBLIC' ELSE role_label.rolname::text END
)
SELECT CASE
  WHEN NOT (SELECT ok FROM guard)
  THEN pg_catalog.jsonb_build_object('status', 'BLOCKED_READ_ONLY_TARGET_OR_RLS_GUARD')
  WHEN (SELECT pg_catalog.count(*) FROM auth_rows) > 10000
  THEN pg_catalog.jsonb_build_object('status', 'BLOCKED_AUTH_ROW_LIMIT')
  WHEN (SELECT pg_catalog.count(*) FROM bucket_rows) <> 1
  THEN pg_catalog.jsonb_build_object('status', 'BLOCKED_EXACT_BUCKET_ABSENT_OR_NONUNIQUE')
  WHEN EXISTS (
    SELECT 1 FROM bucket_rows AS b
    WHERE b.mime_type_count > 32 OR EXISTS (
      SELECT 1 FROM pg_catalog.unnest(b.allowed_mime_types) AS mime(value)
      WHERE pg_catalog.char_length(mime.value) > 128
    )
  )
  THEN pg_catalog.jsonb_build_object('status', 'BLOCKED_BUCKET_MIME_OUTPUT_LIMIT')
  WHEN (SELECT pg_catalog.count(*) FROM policy_role_groups) > 64
  THEN pg_catalog.jsonb_build_object('status', 'BLOCKED_POLICY_GROUP_LIMIT')
  ELSE pg_catalog.jsonb_build_object(
    'status', 'INVENTORY_ONLY',
    'transaction_read_only', pg_catalog.current_setting('transaction_read_only'),
    'statement_timeout', pg_catalog.current_setting('statement_timeout'),
    'lock_timeout', pg_catalog.current_setting('lock_timeout'),
    'server_version_num', pg_catalog.current_setting('server_version_num'),
    'row_security_filtering_active', false,
    'auth', (
      SELECT pg_catalog.jsonb_build_object(
        'total_users', pg_catalog.count(*),
        'email_confirmed_users', pg_catalog.count(*) FILTER (WHERE a.email_confirmed_at IS NOT NULL),
        'email_unconfirmed_users', pg_catalog.count(*) FILTER (WHERE a.email_confirmed_at IS NULL),
        'deleted_users', pg_catalog.count(*) FILTER (WHERE a.deleted_at IS NOT NULL),
        'currently_banned_users', pg_catalog.count(*) FILTER (
          WHERE a.banned_until > pg_catalog.statement_timestamp()
        ),
        'anonymous_users', pg_catalog.count(*) FILTER (WHERE a.is_anonymous IS TRUE),
        'anonymous_status_null_users', pg_catalog.count(*) FILTER (WHERE a.is_anonymous IS NULL),
        'missing_email_users', pg_catalog.count(*) FILTER (WHERE a.missing_email),
        'invalid_nonempty_email_users', pg_catalog.count(*) FILTER (
          WHERE NOT a.missing_email AND a.normalized_email IS NULL
        ),
        'duplicate_normalized_email_groups', (
          SELECT pg_catalog.count(*) FROM duplicate_email_groups
        ),
        'duplicate_normalized_email_extra_users', (
          SELECT COALESCE(pg_catalog.sum(d.users_in_group - 1), 0)
          FROM duplicate_email_groups AS d
        )
      ) FROM auth_normalized AS a
    ),
    'bucket', (
      SELECT pg_catalog.jsonb_build_object(
        'id', b.id,
        'public', b.public,
        'file_size_limit_bytes', b.file_size_limit,
        'allowed_mime_types', pg_catalog.to_jsonb(b.allowed_mime_types),
        'mime_array_state', b.mime_array_state,
        'mime_type_count', b.mime_type_count,
        'object_count', (
          SELECT pg_catalog.count(*) FROM storage.objects AS o
          WHERE o.bucket_id = 'meta-ads-security-step7-dev'
        )
      ) FROM bucket_rows AS b
    ),
    'other_bucket_count', (
      SELECT pg_catalog.count(*) FROM storage.buckets
      WHERE id <> 'meta-ads-security-step7-dev'
    ),
    'storage_policy_scope',
      'TABLE_WIDE_DIRECT_ROLE_COUNTS_PROTECTED_ITEMS_EXCLUDED_NOT_BUCKET_AUTHORIZATION_TEST',
    'storage_relations', (
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'table', r.relname,
        'rls', r.relrowsecurity,
        'rls_forced', r.relforcerowsecurity,
        'policy_count', (SELECT pg_catalog.count(*) FROM policies AS p WHERE p.polrelid = r.oid)
      ) ORDER BY r.relname)
      FROM relations AS r
      WHERE r.nspname = 'storage'
    ),
    'storage_policy_command_role_groups', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'table', p.relname,
        'command_code', p.polcmd,
        'role', p.role_name,
        'policy_role_count', p.policy_role_count
      ) ORDER BY p.relname, p.polcmd, p.role_name)
      FROM (SELECT relname, polcmd, role_name, policy_role_count
        FROM policy_role_groups ORDER BY relname, polcmd, role_name LIMIT 64) AS p
    ), '[]'::pg_catalog.jsonb),
    'app_user_reference_status', 'NOT_RUN_NO_ALLOWED_PUBLIC_APPUSER_RELATION',
    'storage_policy_effect_status', 'NOT_RUN_TABLE_COUNTS_DO_NOT_PROVE_BUCKET_ACCESS'
  )
END AS inventory_json;
ROLLBACK;
