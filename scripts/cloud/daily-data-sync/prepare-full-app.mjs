import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_PROJECT_REF = 'ehnfrrmbkvlsbpvqcvkr';
export const APP_SCHEMA = 'phase08_meta_ads';
export const APP_RUNTIME = 'phase08_runtime';
export const APP_MIGRATION = 'phase08_migration';
const ABSENT_ROLES = ['phase08_unprovisioned_prodrt', 'phase08_unprovisioned_prodmig'];
const hash = value => createHash('sha256').update(value).digest('hex');
const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export function transformMigration(source) {
  let sql = source.replace(/^CREATE SCHEMA IF NOT EXISTS "public";\r?\n/m, '');
  // Historical files have their own transaction wrappers. A COMMIT would end our
  // fresh-target transaction and reset SET LOCAL search_path, leaking later DDL.
  // Remove wrappers only outside dollar-quoted function/DO bodies.
  let dollarTag = null;
  sql = sql.split(/\r?\n/).map(line => {
    if (!dollarTag && /^\s*(?:BEGIN|COMMIT)\s*;\s*$/.test(line)) return '-- historical transaction wrapper removed';
    if (!dollarTag && (/^\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i.test(line) ||
        /^\s*(?:SET|RESET)\s+(?:LOCAL\s+|SESSION\s+)?search_path\b/i.test(line)))
      throw new Error('UNEXPECTED_TRANSACTION_CONTROL');
    for (const match of line.matchAll(/\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/g)) {
      if (dollarTag === match[0]) dollarTag = null;
      else if (!dollarTag) dollarTag = match[0];
    }
    return line;
  }).join('\n');
  if (dollarTag) throw new Error('UNTERMINATED_DOLLAR_BODY');
  sql = sql.replaceAll('"meta_ads".', `"${APP_SCHEMA}".`);
  const names = { meta_ads_stg_runtime: APP_RUNTIME, meta_ads_stg_migration: APP_MIGRATION,
    meta_ads_prod_runtime: ABSENT_ROLES[0], meta_ads_prod_migration: ABSENT_ROLES[1] };
  for (const [old, next] of Object.entries(names)) sql = sql.replaceAll(`'${old}'`, `'${next}'`);
  if (/"meta_ads"\.|CREATE SCHEMA|meta_ads_(?:stg|prod)_(?:runtime|migration)'/.test(sql))
    throw new Error('UNSCOPED_MIGRATION_REJECTED');
  return sql;
}
export function assertPreparationIdentity(input) {
  if (input?.projectRef !== APP_PROJECT_REF || input.database !== 'postgres' || input.schema !== APP_SCHEMA ||
      input.runtimeRole !== APP_RUNTIME || input.migrationRole !== APP_MIGRATION || input.existingSchema !== false ||
      input.existingRoles !== false || input.operatingTarget !== false) throw new Error('PHASE08_IDENTITY_REJECTED');
  return Object.freeze({ projectRef: APP_PROJECT_REF, database: 'postgres', schema: APP_SCHEMA,
    runtimeRole: APP_RUNTIME, migrationRole: APP_MIGRATION });
}
function header() {
  return `-- Prepared only for project ${APP_PROJECT_REF}; host/project identity must be checked outside SQL.
-- Never execute against operating project, phase05/06/07 DBs, or an existing application schema.
BEGIN;
SET LOCAL statement_timeout='120s';
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'PHASE08_DATABASE_ADMIN_IDENTITY_REQUIRED';
  END IF;
  IF to_regnamespace('${APP_SCHEMA}') IS NOT NULL OR EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname IN ('${APP_RUNTIME}','${APP_MIGRATION}','${ABSENT_ROLES.join("','")}')
  ) THEN RAISE EXCEPTION 'PHASE08_FRESH_TARGET_REQUIRED'; END IF;
END $$;
CREATE ROLE ${APP_RUNTIME} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ${APP_MIGRATION} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA ${APP_SCHEMA};
REVOKE ALL ON SCHEMA ${APP_SCHEMA} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${APP_SCHEMA} TO ${APP_RUNTIME};
GRANT USAGE,CREATE ON SCHEMA ${APP_SCHEMA} TO ${APP_MIGRATION};
SET LOCAL search_path=${APP_SCHEMA},pg_catalog;
`;
}
function footer() {
  return `
-- All application tables/types/functions are scoped to the fresh schema.
REVOKE ALL ON ALL TABLES IN SCHEMA ${APP_SCHEMA} FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${APP_SCHEMA} FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${APP_SCHEMA} FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${APP_SCHEMA} TO ${APP_RUNTIME};
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${APP_SCHEMA} TO ${APP_RUNTIME};
GRANT ALL ON ALL TABLES IN SCHEMA ${APP_SCHEMA} TO ${APP_MIGRATION};
GRANT ALL ON ALL SEQUENCES IN SCHEMA ${APP_SCHEMA} TO ${APP_MIGRATION};
DO $$ DECLARE row record; role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA ${APP_SCHEMA} FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ${APP_SCHEMA} FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${APP_SCHEMA} FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${APP_SCHEMA} FROM %I',role_name);
    END IF;
  END LOOP;
  FOR row IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='${APP_SCHEMA}' AND c.relkind='r' LOOP
    EXECUTE format('ALTER TABLE ${APP_SCHEMA}.%I ENABLE ROW LEVEL SECURITY',row.relname);
    EXECUTE format('ALTER TABLE ${APP_SCHEMA}.%I FORCE ROW LEVEL SECURITY',row.relname);
    -- Existing sync-table policies already bind these two dedicated roles.
    IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='${APP_SCHEMA}' AND p.tablename=row.relname
      AND '${APP_RUNTIME}'=ANY(p.roles)) THEN
      EXECUTE format('CREATE POLICY %I ON ${APP_SCHEMA}.%I FOR ALL TO ${APP_RUNTIME} USING(true) WITH CHECK(true)',
        'phase08_runtime_'||row.relname,row.relname);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='${APP_SCHEMA}' AND p.tablename=row.relname
      AND '${APP_MIGRATION}'=ANY(p.roles)) THEN
      EXECUTE format('CREATE POLICY %I ON ${APP_SCHEMA}.%I FOR ALL TO ${APP_MIGRATION} USING(true) WITH CHECK(true)',
        'phase08_migration_'||row.relname,row.relname);
    END IF;
  END LOOP;
  FOR row IN SELECT p.oid::regprocedure::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='${APP_SCHEMA}' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=${APP_SCHEMA},pg_catalog',row.name);
  END LOOP;
END $$;
COMMIT;
`;
}
export async function prepareFullApp(input, output, root = repo) {
  const identity = assertPreparationIdentity(input);
  const directory = join(root, 'apps/api/prisma/migrations');
  const names = (await readdir(directory, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort();
  const migrations = [];
  let sql = header();
  for (const name of names) {
    if (!/^\d{14}_[a-z0-9_]+$/.test(name)) throw new Error('UNEXPECTED_MIGRATION_NAME');
    const source = await readFile(join(directory, name, 'migration.sql'), 'utf8');
    const transformed = transformMigration(source);
    migrations.push({ name, sourceSha256: hash(source), preparedSha256: hash(transformed) });
    sql += `\n-- Migration: ${name}\n${transformed}\n`;
  }
  if (!names.includes('20261012170000_scheduled_unit_checkpoints') || migrations.length < 51)
    throw new Error('PHASE08_COMPLETE_SCHEMA_REQUIRED');
  sql += footer();
  const manifest = { version: 1, preparationOnly: true, operatingChanges: 0, schemaInitiallyEmpty: true,
    identity, sqlSha256: hash(sql), migrations,
    caveats: ['Host/project fingerprint must be verified by root immediately before execution.',
      'Dedicated roles remain NOLOGIN until separate protected password provisioning.',
      'No operating/Cafe24/Meta/Google rows or credentials are copied.',
      'This prepared SQL does not register Prisma migration history; later migrate deploy needs an explicit reviewed baseline.',
      'Build source includes existing uncommitted work; record its content manifest as well as HEAD.'] };
  // No secrets are read; this tool has no DB client, HTTP, shell, deploy, or credential operations.
  await mkdir(output, { recursive: false });
  await writeFile(join(output, 'full-app-schema.sql'), sql, { flag: 'wx' });
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { identity, migrations: migrations.length, sqlSha256: manifest.sqlSha256, output: resolve(output), remoteChanges: 0 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [identityPath, output] = process.argv.slice(2);
  if (!identityPath || !output) { console.error('PHASE08_PREPARATION_ARGUMENTS_REQUIRED'); process.exitCode=1; }
  else prepareFullApp(JSON.parse(await readFile(identityPath, 'utf8')), resolve(output)).then(result => console.log(JSON.stringify(result)))
    .catch(() => { console.error('PHASE08_FULL_APP_PREPARATION_FAILED'); process.exitCode=1; });
}
