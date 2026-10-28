// Fresh PG17 on a fixed loopback target. No supplied URL, cloud credentials or production data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
const runtime = resolve(process.env.LOCALAPPDATA, "UnifiedPerformanceStage02");
const require = createRequire(import.meta.url);
const { Client } = require(resolve(runtime, "node_modules/pg"));
const bin = resolve(runtime, "node_modules/@embedded-postgres/windows-x64/native/bin");
const root = resolve(runtime, `run-${randomUUID()}`), data = resolve(root, "data");
mkdirSync(root, { recursive: true });
const port = 55447, database = "unified_stage02", owner = "unified_owner";
const url = `postgresql://${owner}@127.0.0.1:${port}/${database}?schema=meta_ads`;
const migration = "20261027071504_unified_performance_foundation";
const migrationSql = readFileSync(`apps/api/prisma/migrations/${migration}/migration.sql`, "utf8");
const evidence = { stage: "02", startedAt: new Date().toISOString(), head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  target: { host: "127.0.0.1", port, database, owner }, remoteWrites: 0, realBusinessData: false,
  migration, migrationSha256: createHash("sha256").update(migrationSql).digest("hex"), checks: [], status: "RUNNING" };
const check = (name, detail = {}) => evidence.checks.push({ name, passed: true, ...detail });
const child = (file, args, options = {}) => {
  const result = spawnSync(file, args, { windowsHide: true, encoding: "utf8", timeout: 120000, maxBuffer: 8388608, ...options });
  if (result.status !== 0) throw Object.assign(new Error(`Local child failed: ${file}`), { syntheticOutput: `${result.stdout ?? ""}\n${result.stderr ?? ""}` });
  return result;
};
const prisma = args => child(process.execPath, ["node_modules/prisma/build/index.js", ...args], { env: { ...process.env, DATABASE_URL: url, SHADOW_DATABASE_URL: url.replace(database, database + "_unused_shadow") } });
const connect = async (user = owner, dbName = database) => {
  const client = new Client({ host: "127.0.0.1", port, user, database: dbName });
  await client.connect();
  const identity = (await client.query("SELECT current_database() db,current_user usr,inet_server_addr()::text host,current_setting('server_version_num') version")).rows[0];
  assert.deepEqual({ ...identity, host: identity.host.replace(/\/32$/, ""), version: undefined }, { db: dbName, usr: user, host: "127.0.0.1", version: undefined });
  assert.match(identity.version, /^17/);
  await client.query("SET search_path=meta_ads,public;SET statement_timeout='10s';SET lock_timeout='2s'");
  return client;
};
let db, started = false;
const clients = [];
async function denied(client, sql, code = "42501") {
  let actual;
  try { await client.query(sql); } catch (error) { actual = error.code; }
  assert.equal(actual, code, sql);
}
try {
  child(resolve(bin, "initdb.exe"), ["-D", data, "-U", owner, "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"]);
  child(resolve(bin, "pg_ctl.exe"), ["-D", data, "-l", resolve(root, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -c log_statement=none -c log_min_error_statement=panic`, "-w", "start"], { stdio: "ignore" });
  started = true;
  db = await connect(owner, "postgres");
  await db.query(`CREATE DATABASE ${database}`);
  await db.end(); db = await connect();
  await db.query("CREATE SCHEMA meta_ads");
  check("new isolated PG17 identity validated before feature writes");

  // Apply the untouched baseline with the actual Prisma migration engine.
  const before = resolve(root, "baseline.prisma"), migrationRoot = resolve(root, "migrations");
  writeFileSync(before, execFileSync("git", ["show", "HEAD:apps/api/prisma/schema.prisma"], { encoding: "utf8" }));
  mkdirSync(migrationRoot);
  for (const entry of readdirSync("apps/api/prisma/migrations", { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === migration) continue;
    const directory = resolve(migrationRoot, entry.name); mkdirSync(directory);
    copyFileSync(`apps/api/prisma/migrations/${entry.name}/migration.sql`, resolve(directory, "migration.sql"));
  }
  const baseline = prisma(["migrate", "deploy", "--schema", before]);
  writeFileSync(resolve(root, "baseline-migrations.txt"), baseline.stdout);
  await db.query("INSERT INTO products(id,code,name,display_name,updated_at) VALUES ('00000000-0000-4000-8000-000000000002','unified-sentinel','Synthetic sentinel','Synthetic sentinel',now())");
  const legacyBefore = (await db.query("SELECT count(*)::int n FROM products")).rows[0].n;
  await db.query("BEGIN");
  await db.query(migrationSql);
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='meta_ads' AND tablename LIKE 'unified_%'")).rows[0].n, 8);
  await db.query("ROLLBACK");
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='meta_ads' AND tablename LIKE 'unified_%'")).rows[0].n, 0);
  check("all new DDL rolls back transactionally without changing baseline product");
  const deployed = prisma(["migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"]);
  writeFileSync(resolve(root, "deploy.txt"), deployed.stdout);
  const again = prisma(["migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"]);
  assert.match(again.stdout, /No pending migrations/);
  assert.equal((await db.query("SELECT count(*)::int n FROM products")).rows[0].n, legacyBefore);
  check("Prisma baseline+new migration deploy, repeat deploy has no pending migration, existing product preserved");
  const protections = (await db.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relname LIKE 'unified_%' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity")).rows[0].n;
  assert.equal(protections, 8); check("RLS enabled and forced for all eight feature tables");

  // Synthetic Naver JSONB tables live outside Prisma ownership; no operational PII.
  const sources = ["stores", "order_items", "order_source_signatures", "products", "canonical_sales_units", "ad_campaign_daily_costs", "ad_excel_uploads",
    "sales_unit_cost_settings", "sales_unit_cost_snapshots", "sales_unit_cost_snapshot_entries", "daily_fake_purchases", "order_sync_states"];
  await db.query("CREATE ROLE unified_reader LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;CREATE ROLE unified_writer LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;CREATE ROLE unified_api LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;CREATE ROLE unified_config LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE");
  for (const table of sources) {
    await db.query(`CREATE TABLE public.${table}(id text PRIMARY KEY,payload jsonb NOT NULL);ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;REVOKE ALL ON public.${table} FROM PUBLIC;GRANT SELECT ON public.${table} TO unified_reader;CREATE POLICY isolated_reader ON public.${table} FOR SELECT TO unified_reader USING(true)`);
    await db.query(`INSERT INTO public.${table} VALUES('synthetic','{"storeId":"fixture","paymentDate":"2026-10-26","displayName":"Fixture"}')`);
  }
  await db.query("CREATE INDEX isolated_order_day ON public.order_items ((payload->>'storeId'),(payload->>'paymentDate'));CREATE TABLE public.connector_credentials(id text PRIMARY KEY,payload jsonb);REVOKE ALL ON public.connector_credentials FROM PUBLIC");
  await db.query("GRANT USAGE ON SCHEMA public TO unified_reader;GRANT USAGE ON SCHEMA meta_ads TO unified_writer,unified_api,unified_config;GRANT SELECT ON meta_ads.source_connections TO unified_config");
  await db.query("INSERT INTO app_users(id,name,updated_at) VALUES('00000000-0000-4000-8000-000000000001','Synthetic stage02 actor',now())");
  const configuration = ["unified_products", "unified_rules", "unified_mapping_audits"];
  const aggregates = ["unified_aggregation_runs", "unified_source_publications", "unified_daily_facts", "unified_source_coverage", "unified_product_match_results"];
  for (const table of configuration) {
    await db.query(`GRANT SELECT,INSERT ON ${table} TO unified_config;CREATE POLICY isolated_config_s ON ${table} FOR SELECT TO unified_config USING(true);CREATE POLICY isolated_config_i ON ${table} FOR INSERT TO unified_config WITH CHECK(true)`);
    if (table !== "unified_mapping_audits") await db.query(`GRANT UPDATE ON ${table} TO unified_config;CREATE POLICY isolated_config_u ON ${table} FOR UPDATE TO unified_config USING(true) WITH CHECK(true)`);
  }
  for (const table of aggregates) await db.query(`GRANT SELECT,INSERT,UPDATE ON ${table} TO unified_writer;GRANT SELECT ON ${table} TO unified_api;CREATE POLICY isolated_writer ON ${table} TO unified_writer USING(true) WITH CHECK(true);CREATE POLICY isolated_api ON ${table} FOR SELECT TO unified_api USING(true)`);
  const reader = await connect("unified_reader"), writer = await connect("unified_writer"), api = await connect("unified_api"), config = await connect("unified_config");
  clients.push(reader, writer, api, config);
  const flags = (await db.query("SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname IN ('unified_reader','unified_writer','unified_api','unified_config')")).rows;
  assert.equal(flags.length, 4); assert(flags.every(r => !r.rolsuper && !r.rolbypassrls && !r.rolcreatedb && !r.rolcreaterole));
  const owners = (await db.query("SELECT count(*)::int n FROM pg_tables WHERE tableowner IN ('unified_reader','unified_writer','unified_api','unified_config')")).rows[0].n;
  assert.equal(owners, 0);
  for (const table of sources) {
    assert.equal((await reader.query(`SELECT payload->>'displayName' name FROM public.${table}`)).rows[0].name, "Fixture");
    await denied(reader, `UPDATE public.${table} SET payload='{}'`);
    await denied(reader, `DELETE FROM public.${table}`);
    await denied(reader, `INSERT INTO public.${table} VALUES('forbidden','{}')`);
  }
  await denied(reader, "SELECT * FROM public.connector_credentials");
  await denied(writer, "SELECT * FROM public.order_items");
  await denied(api, "SELECT * FROM public.order_items");
  await denied(config, "SELECT * FROM public.order_items");
  await denied(reader, "SELECT * FROM meta_ads.unified_daily_facts");
  await denied(api, "INSERT INTO unified_products VALUES (gen_random_uuid(),'x','x',true,1,now(),now())");
  await denied(writer, "UPDATE unified_products SET active=false");
  await denied(config, "DELETE FROM unified_mapping_audits");
  check("actual non-owner reader/writer/API/config logins enforce source SELECT/DML/credential and feature write boundaries", { sourceTables: sources.length, runtimeRoles: flags });
  const product = randomUUID();
  await config.query("INSERT INTO unified_products(id,canonical_name,normalized_name,updated_at) VALUES($1,'DB constraint fixture','db constraint fixture',now())", [product]);
  const ruleSql = "INSERT INTO unified_rules(id,kind,product_id,identity_key,payload,valid_from,valid_to,updated_at) VALUES($1,'NAME',$2,$3,'{\"matchType\":\"EXACT\",\"terms\":[\"fixture\"]}','2026-10-20','2026-10-21',now())";
  await config.query(ruleSql, [randomUUID(), product, "a".repeat(64)]);
  let overlapCode;
  try { await config.query(ruleSql, [randomUUID(), product, "a".repeat(64)]); } catch (e) { overlapCode = e.code; }
  assert.equal(overlapCode, "23P01");
  await denied(writer, "INSERT INTO unified_daily_facts(id,run_id,component,fact_key,amount_krw,attribution,payload) VALUES(gen_random_uuid(),gen_random_uuid(),'SALE','overflow',1e24,'DIRECT','{}')", "22003");
  check("database exclusion protects identical inclusive rule ranges; numeric storage rejects overflow");

  const id = randomUUID(), failed = randomUUID(), duplicate = randomUUID();
  const runSql = `INSERT INTO unified_aggregation_runs(id,source_system,platform,scope_key,business_date,status,contract_version,versions,read_snapshot_id,source_watermarks,control_totals,issues,completed_at) VALUES($1,'fixture','CAFE24','shop','2026-10-26',$2::text,'product-performance-v1.1.0','{}','snapshot','{}','[]','[]',CASE WHEN $2::text='READY' THEN now() ELSE null END)`;
  await writer.query(runSql, [id, "READY"]);
  await writer.query("INSERT INTO unified_source_coverage(id,run_id,component,participation,collection_state,zero_confirmed,rows_present,is_estimate,details) VALUES($1,$2,'SALE','INCLUDED','COMPLETE',false,2,false,'{}')", [randomUUID(), id]);
  for (const key of ["sale:order1", "sale:order2"]) await writer.query("INSERT INTO unified_daily_facts(id,run_id,component,fact_key,product_name,amount_krw,attribution,payload) VALUES($1,$2,'SALE',$3,'same product',12.500000,'DIRECT','{}')", [randomUUID(), id, key]);
  await writer.query("INSERT INTO unified_source_publications(source_system,platform,scope_key,business_date,run_id,updated_at) VALUES('fixture','CAFE24','shop','2026-10-26',$1,now())", [id]);
  assert.equal((await api.query("SELECT sum(amount_krw)::text amount FROM unified_daily_facts WHERE run_id=$1", [id])).rows[0].amount, "25.000000");
  await denied(api, `UPDATE unified_daily_facts SET amount_krw=0`);
  await denied(config, `UPDATE unified_daily_facts SET amount_krw=0`);
  await writer.query(runSql, [failed, "FAILED"]);
  let errorCode;
  try { await writer.query("UPDATE unified_source_publications SET run_id=$1", [failed]); } catch (e) { errorCode = e.code; }
  assert.equal(errorCode, "23514");
  await writer.query("BEGIN");
  await writer.query(runSql, [duplicate, "STAGING"]);
  await writer.query("INSERT INTO unified_daily_facts(id,run_id,component,fact_key,amount_krw,attribution,payload) VALUES($1,$2,'SALE','partial',999,'DIRECT','{}')", [randomUUID(), duplicate]);
  await writer.query("ROLLBACK");
  assert.equal((await api.query("SELECT run_id FROM unified_source_publications")).rows[0].run_id, id);
  assert.equal((await api.query("SELECT count(*)::int n FROM unified_daily_facts")).rows[0].n, 2);
  check("same-name distinct orders preserved; failed/rolled-back source revision retains previous publication");
  let fkCode;
  try { await writer.query("UPDATE unified_source_publications SET scope_key='other'"); } catch (e) { fkCode = e.code; }
  assert.equal(fkCode, "23503");
  check("publication composite FK prevents cross-source/scope/day pointer");

  const tests = child(process.execPath, ["--import", "tsx", "--test", "scripts/unified-management-postgres.test.ts"], {
    env: { ...process.env, TSX_TSCONFIG_PATH: "apps/api/tsconfig.json", UNIFIED_TEST_URL: "postgresql://unified_config@127.0.0.1:55447/unified_stage02?schema=meta_ads" }
  });
  writeFileSync(resolve(root, "management-tests.txt"), tests.stdout + tests.stderr);
  check("real config service CRUD, read-only preview, audit rollback, wildcard/date/CAS/concurrency and revision fingerprints");
  evidence.status = "PASS";
} catch (error) {
  evidence.status = "FAIL";
  // Only synthetic, local fixture errors can reach this handler.
  evidence.failure = { message: error.message, code: error.code ?? null };
  if (error.syntheticOutput) writeFileSync(resolve(root, "child-failure.txt"), error.syntheticOutput);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map(c => c.end()));
  await db?.end().catch(() => {});
  if (started) {
    evidence.stopExit = spawnSync(resolve(bin, "pg_ctl.exe"), ["-D", data, "-m", "fast", "-w", "stop"], { windowsHide: true, stdio: "ignore", timeout: 30000 }).status;
    if (evidence.stopExit !== 0) { evidence.status = "FAIL"; process.exitCode = 1; }
  }
  evidence.endedAt = new Date().toISOString(); evidence.localEvidence = root;
  const output = resolve("docs/product-performance/research/02-foundation-postgres-result.json");
  writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}
