import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';

// Invoke in the existing Railway service environment. Never prints environment values.
async function main() {
const projectRef = 'iygjmosbelbosfxidqxv';
const target = new URL(process.env.DATABASE_URL ?? 'invalid:');
if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
  !(target.hostname === `db.${projectRef}.supabase.co` || target.username.endsWith(`.${projectRef}`)) ||
  target.pathname !== '/postgres' || target.searchParams.get('schema') !== 'meta_ads') throw Error('STAGE11_TARGET_MISMATCH');
const client = new PrismaClient();
const evidence: Record<string, unknown> = { stage: 11, observedAt: new Date().toISOString(), projectRef,
  operation: 'READ_ONLY_PREFLIGHT', sourceWrites: 0, schemaWrites: 0, release: process.env.RELEASE_GIT_SHA ?? null,
  flags: Object.fromEntries(['UNIFIED_PERFORMANCE_ENABLED','UNIFIED_NAVER_ALLOWED_STORE_IDS','UNIFIED_AGGREGATION_DATABASE_URL',
    'UNIFIED_REPORT_LEGACY_PLATFORMS','DAILY_SYNC_ENABLED','DAILY_SYNC_FEATURE_ENABLED','DAILY_SYNC_SCHEDULE_ENABLED'].map(key =>
      [key, key.endsWith('DATABASE_URL') ? { configured: !!process.env[key] } : key.endsWith('STORE_IDS') ?
        { configured: !!process.env[key], count: process.env[key]?.split(',').filter(Boolean).length ?? 0 } : process.env[key] ?? null])) };
try {
  const result = await client.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='15s'");
    const identity = await tx.$queryRawUnsafe(`SELECT current_database() db,current_user role,current_setting('transaction_read_only') read_only,
      current_setting('server_version') version,inet_server_addr()::text server,current_setting('search_path') search_path`);
    const roles = await tx.$queryRawUnsafe(`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolbypassrls FROM pg_roles
      WHERE rolname=current_user OR rolname LIKE '%unified%' OR rolname LIKE 'meta_ads_%' ORDER BY rolname`);
    const memberships = await tx.$queryRawUnsafe(`SELECT r.rolname parent,m.rolname member FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid
      JOIN pg_roles m ON m.oid=a.member WHERE m.rolname=current_user OR m.rolname LIKE '%unified%' OR m.rolname LIKE 'meta_ads_%' ORDER BY 1,2`);
    const tables = await tx.$queryRawUnsafe(`SELECT n.nspname schema,c.relname name,pg_get_userbyid(c.relowner) owner,c.relrowsecurity rls,c.relforcerowsecurity force_rls,
      has_table_privilege(current_user,c.oid,'SELECT') can_select,has_table_privilege(current_user,c.oid,'INSERT') can_insert,
      has_table_privilege(current_user,c.oid,'UPDATE') can_update,has_table_privilege(current_user,c.oid,'DELETE') can_delete,
      c.reltuples::text estimated_rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND
      (n.nspname='meta_ads' OR (n.nspname='public' AND c.relname IN ('order_items','stores','connector_credentials','commerce_api_credentials'))) ORDER BY 1,2`);
    const migrationTables = await tx.$queryRawUnsafe<Array<{name:string}>>(`SELECT n.nspname||'.'||c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='_prisma_migrations'`);
    const migrationAccess = migrationTables.some(row => row.name === 'meta_ads._prisma_migrations') ? await tx.$queryRawUnsafe<Array<{allowed:boolean}>>(`SELECT has_table_privilege(current_user,'meta_ads._prisma_migrations','SELECT') allowed`) : [];
    const migrations = migrationAccess[0]?.allowed ? await tx.$queryRawUnsafe(`SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM meta_ads._prisma_migrations ORDER BY migration_name`) : [];
    const connectionPrivileges = await tx.$queryRawUnsafe(`SELECT column_name,has_column_privilege(current_user,'meta_ads.source_connections',column_name,'SELECT') can_select
      FROM information_schema.columns WHERE table_schema='meta_ads' AND table_name='source_connections' ORDER BY ordinal_position`);
    const policies = await tx.$queryRawUnsafe(`SELECT schemaname,tablename,policyname,roles,cmd,qual,with_check FROM pg_policies
      WHERE schemaname='meta_ads' AND (tablename LIKE 'unified_%' OR tablename='source_connections') ORDER BY tablename,policyname`);
    const sourceConnections = await tx.$queryRawUnsafe(`SELECT id,provider,display_name,currency_code,time_zone FROM meta_ads.source_connections ORDER BY provider,id`);
    return { identity, roles, memberships, tables, migrationTables, migrationAccess, migrations, connectionPrivileges, policies, sourceConnections };
  }, { timeout: 30000 });
  Object.assign(evidence, result, { status: 'PASS' });
} catch (error) {
  // Provider diagnostics can contain URLs or SQL data. Persist only a fixed error code.
  evidence.status = 'FAIL'; evidence.errorCode = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'PREFLIGHT_FAILED';
  evidence.databaseErrorCode = (error as {meta?:{code?:string}}).meta?.code ?? null;
  process.exitCode = 1;
} finally {
  await client.$disconnect();
  writeFileSync('docs/product-performance/research/11-preflight-result.json', JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, errorCode: evidence.errorCode, remoteWrites: 0, projectRef }));
}
}
main().catch(() => { console.error('STAGE11_PREFLIGHT_INPUT_FAILED'); process.exitCode = 1; });
