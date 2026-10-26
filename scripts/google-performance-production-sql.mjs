// Offline generator only. It never opens a DB connection or reads credentials.
// The caller must pin the authenticated management request to the production project.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = ['20261026120000_google_performance_mappings', '20261026130000_google_sale_configuration'];
const tables = new Set(['products', 'product_cost_rules', 'product_match_rules', 'product_cpa_rules',
  'adset_product_histories', 'adset_stage_histories', 'cafe24_product_rules', 'cafe24_coupon_rules',
  'coupang_products', 'coupang_product_groups', 'coupang_product_rules', 'coupang_cost_rules',
  'coupang_sales_fee_rules', 'coupang_manual_purchases', 'coupang_promotion_prices',
  'source_policies', 'source_connections', '_prisma_migrations',
  'daily_data_sync_prod_ops.schedules', 'daily_data_sync_prod_ops.settings', 'cron.job']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const qualified = name => name.split('.').length === 1 ? `meta_ads."${name}"`
  : name.split('.').map(part => `"${part}"`).join('.');
const membership = `(SELECT jsonb_agg(jsonb_build_object('grantor',grantor::regrole::text,'admin',admin_option,'inherit',inherit_option,'set',set_option) ORDER BY grantor)
  FROM pg_auth_members WHERE roleid='meta_ads_app'::regrole AND member='postgres'::regrole)`;

function fingerprint(name, excludeNew = false) {
  const where = excludeNew && name === '_prisma_migrations'
    ? ` WHERE t.migration_name NOT IN (${names.map(literal).join(',')})` : '';
  return `(SELECT jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(h,',' ORDER BY h),'')))
    FROM (SELECT md5(to_jsonb(t)::text) h FROM ${qualified(name)} t${where}) x)`;
}

export function buildGooglePerformanceProductionSql(baseline) {
  if (!baseline || typeof baseline.fingerprints !== 'object' || !baseline.fingerprints) throw Error('BASELINE_REQUIRED');
  const entries = Object.entries(baseline.fingerprints);
  if (entries.length !== tables.size || entries.some(([name, value]) => !tables.has(name) || !value ||
    !Number.isSafeInteger(value.count) || value.count < 0 || !/^[a-f0-9]{32}$/.test(value.hash)))
    throw Error('EXACT_21_CONFIG_FINGERPRINTS_REQUIRED');
  const member = baseline.membership;
  if (!Array.isArray(member) || member.length !== 1 || member[0].grantor !== 'supabase_admin' ||
    member[0].admin !== true || member[0].inherit !== false || member[0].set !== false || Object.keys(member[0]).length !== 4)
    throw Error('EXISTING_ADMIN_MEMBERSHIP_REQUIRED');
  if (baseline.fingerprints._prisma_migrations.count < 53) throw Error('LEDGER_BASELINE_REQUIRED');
  const migrations = names.map(name => {
    const bytes = readFileSync(resolve(root, 'apps/api/prisma/migrations', name, 'migration.sql'));
    const sql = bytes.toString('utf8');
    if (!Buffer.from(sql, 'utf8').equals(bytes) || sql.includes('\0')) throw Error('MIGRATION_ENCODING');
    return { name, checksum: hash(bytes), byteLength: bytes.length, id: randomUUID(), sql };
  });
  const assertFingerprints = (after) => entries.map(([name, value]) =>
    `IF ${fingerprint(name, after)} IS DISTINCT FROM ${literal(JSON.stringify(value))}::jsonb THEN RAISE EXCEPTION 'GOOGLE_PRESERVATION_FAILED: ${name}'; END IF;`).join('\n');
  const expectedMembership = literal(JSON.stringify(member));
  const sql = `-- Exact production target: iygjmosbelbosfxidqxv / postgres / meta_ads.
-- Preserve this generated file and its receipt. Do not regenerate/retry after an unknown commit outcome.
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path=meta_ads,pg_catalog,extensions;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
SET LOCAL transaction_timeout='15s';
DO $google_preflight$
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR session_user<>'postgres'
   OR current_schema()<>'meta_ads' OR current_setting('server_version_num')::integer < 170000
   OR to_regnamespace('extensions') IS NULL
   OR to_regclass('meta_ads.google_performance_mappings') IS NOT NULL
   OR to_regclass('meta_ads.google_mapping_audits') IS NOT NULL
   OR EXISTS(SELECT 1 FROM pg_extension WHERE extname='btree_gist')
   OR pg_has_role('postgres','meta_ads_app','SET')
   OR NOT has_schema_privilege('meta_ads_app','meta_ads','CREATE')
   OR ${membership} IS DISTINCT FROM ${expectedMembership}::jsonb
 THEN RAISE EXCEPTION 'GOOGLE_PRODUCTION_PRECONDITION_FAILED'; END IF;
 IF (SELECT count(*) FROM meta_ads._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>53
   OR EXISTS(SELECT 1 FROM meta_ads._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL)
   OR EXISTS(SELECT 1 FROM meta_ads._prisma_migrations WHERE migration_name IN (${names.map(literal).join(',')}))
 THEN RAISE EXCEPTION 'GOOGLE_LEDGER_PRECONDITION_FAILED'; END IF;
 ${assertFingerprints(false)}
END $google_preflight$;
-- Trusted extension installation is performed by the existing management principal.
CREATE EXTENSION btree_gist WITH SCHEMA extensions;
-- This is a new grant by postgres itself; the existing supabase_admin grant is untouched.
GRANT meta_ads_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
SET LOCAL ROLE meta_ads_app;
LOCK TABLE meta_ads._prisma_migrations IN SHARE ROW EXCLUSIVE MODE;
DO $google_owner_check$
BEGIN
 IF current_user<>'meta_ads_app' THEN RAISE EXCEPTION 'GOOGLE_OWNER_REQUIRED'; END IF;
 IF ${fingerprint('_prisma_migrations')} IS DISTINCT FROM ${literal(JSON.stringify(baseline.fingerprints._prisma_migrations))}::jsonb
 THEN RAISE EXCEPTION 'GOOGLE_LEDGER_LOCK_BASELINE_FAILED'; END IF;
END $google_owner_check$;
${migrations.map(m => `-- BEGIN exact migration ${m.name}; source SHA256 ${m.checksum}; ${m.byteLength} bytes
${m.sql}
-- END exact migration ${m.name}
INSERT INTO meta_ads._prisma_migrations(id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count)
 VALUES(${literal(m.id)},${literal(m.checksum)},clock_timestamp(),${literal(m.name)},NULL,NULL,transaction_timestamp(),1);`).join('\n')}
DO $google_owner_postflight$
BEGIN
 IF (SELECT count(*) FROM meta_ads._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>55
 THEN RAISE EXCEPTION 'GOOGLE_LEDGER_POSTCONDITION_FAILED'; END IF;
 ${migrations.map(m => `IF NOT EXISTS(SELECT 1 FROM meta_ads._prisma_migrations WHERE id=${literal(m.id)} AND migration_name=${literal(m.name)} AND checksum=${literal(m.checksum)} AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1) THEN RAISE EXCEPTION 'GOOGLE_NEW_LEDGER_MISMATCH'; END IF;`).join('\n')}
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='meta_ads' AND c.relname IN ('google_performance_mappings','google_mapping_audits')
     AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity AND c.relowner='meta_ads_app'::regrole)<>2
 THEN RAISE EXCEPTION 'GOOGLE_TABLE_PROTECTION_FAILED'; END IF;
END $google_owner_postflight$;
RESET ROLE;
REVOKE meta_ads_app FROM postgres GRANTED BY postgres;
DO $google_membership_postflight$
BEGIN
 IF current_user<>'postgres' OR pg_has_role('postgres','meta_ads_app','SET')
   OR ${membership} IS DISTINCT FROM ${expectedMembership}::jsonb
   OR NOT EXISTS(SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='btree_gist' AND n.nspname='extensions')
 THEN RAISE EXCEPTION 'GOOGLE_MEMBERSHIP_RESTORE_FAILED'; END IF;
 IF NOT has_table_privilege('meta_ads_prod_runtime','meta_ads.google_performance_mappings','SELECT')
   OR NOT has_table_privilege('meta_ads_prod_runtime','meta_ads.google_performance_mappings','INSERT')
   OR NOT has_table_privilege('meta_ads_prod_runtime','meta_ads.google_performance_mappings','UPDATE')
   OR has_table_privilege('meta_ads_prod_runtime','meta_ads.google_performance_mappings','DELETE')
   OR NOT has_table_privilege('meta_ads_prod_runtime','meta_ads.google_mapping_audits','SELECT')
   OR NOT has_table_privilege('meta_ads_prod_runtime','meta_ads.google_mapping_audits','INSERT')
   OR has_table_privilege('meta_ads_prod_runtime','meta_ads.google_mapping_audits','UPDATE,DELETE')
   OR EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE r.rolname IN ('anon','authenticated','service_role') AND n.nspname='meta_ads'
       AND c.relname IN ('google_performance_mappings','google_mapping_audits')
       AND has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE'))
 THEN RAISE EXCEPTION 'GOOGLE_RUNTIME_ACCESS_FAILED'; END IF;
 ${assertFingerprints(true)}
END $google_membership_postflight$;
COMMIT;
`;
  return { sql, sqlSha256: hash(Buffer.from(sql, 'utf8')),
    migrations: migrations.map(({ sql: _sql, ...metadata }) => metadata), preservedTables: entries.map(([name]) => name) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [baselinePath, outputPath] = process.argv.slice(2);
  if (!baselinePath || !outputPath) throw Error('Usage: node scripts/google-performance-production-sql.mjs baseline.json output.sql');
  const result = buildGooglePerformanceProductionSql(JSON.parse(readFileSync(baselinePath, 'utf8')));
  writeFileSync(outputPath, result.sql, { flag: 'wx', encoding: 'utf8' });
  console.log(JSON.stringify({ kind: 'GOOGLE_PRODUCTION_SQL_PREPARED_OFFLINE', projectRef: 'iygjmosbelbosfxidqxv',
    sqlSha256: result.sqlSha256, migrations: result.migrations, preservedTables: result.preservedTables, databaseRequests: 0 }));
}
