// Stage10 recovery rehearsal reuses the stage06 runtime-role regression in a fresh local PG17 cluster.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

const runtime = resolve(process.env.LOCALAPPDATA, "UnifiedPerformanceStage02");
const require = createRequire(import.meta.url);
const { Client } = require(resolve(runtime, "node_modules/pg"));
const bin = resolve(runtime, "node_modules/@embedded-postgres/windows-x64/native/bin");
const root = resolve(runtime, `stage10-recovery-${randomUUID()}`), data = resolve(root, "data");
mkdirSync(root, { recursive: true });
const port = 55451, database = "unified_stage06", owner = "unified_fixture_owner";
const writer = "unified_report_writer", api = "unified_report_api";
const url = user => `postgresql://${user}@127.0.0.1:${port}/${database}?schema=meta_ads`;
const evidence = { stage: "10-recovery", startedAt: new Date().toISOString(), target: { host: "127.0.0.1", port, database },
  realBusinessData: false, remoteWrites: 0, status: "RUNNING", checks: [] };
const child = (file, args, options = {}) => {
  const result = spawnSync(file, args, { windowsHide: true, encoding: "utf8", timeout: 180000, maxBuffer: 8388608, ...options });
  if (result.status !== 0) throw Object.assign(new Error("Synthetic local child failed"), { detail: `${file}: status=${result.status} error=${result.error?.message ?? "none"}\n${result.stdout ?? ""}\n${result.stderr ?? ""}` });
  return result;
};
let db, started = false, restoredStarted = false;
const restoredData = resolve(root, "restored-data"), restoredPort = 55458;
try {
  child(resolve(bin, "initdb.exe"), ["-D", data, "-U", owner, "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"]);
  child(resolve(bin, "pg_ctl.exe"), ["-D", data, "-l", resolve(root, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -c log_statement=none -c log_min_error_statement=panic`, "-w", "start"], { stdio: "ignore" });
  started = true;
  db = new Client({ host: "127.0.0.1", port, user: owner, database: "postgres" }); await db.connect();
  const identity = (await db.query("SELECT current_database() db,current_user usr,inet_server_addr()::text host,current_setting('server_version_num') version")).rows[0];
  assert.equal(identity.db, "postgres"); assert.equal(identity.usr, owner);
  assert.match(identity.host, /^127\.0\.0\.1(?:\/32)?$/); assert.match(identity.version, /^17/);
  await db.query(`CREATE DATABASE ${database}`); await db.end();
  const migration = child(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"], {
    env: { ...process.env, DATABASE_URL: url(owner), SHADOW_DATABASE_URL: url(owner).replace(database, database + "_unused_shadow") }
  });
  writeFileSync(resolve(root, "migrations.txt"), migration.stdout);
  const again = child(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"], {
    env: { ...process.env, DATABASE_URL: url(owner), SHADOW_DATABASE_URL: url(owner).replace(database, database + "_unused_shadow") }
  });
  assert.match(again.stdout, /No pending migrations/);
  db = new Client({ host: "127.0.0.1", port, user: owner, database }); await db.connect();
  await db.query(`CREATE ROLE ${writer} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; CREATE ROLE ${api} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; GRANT USAGE ON SCHEMA meta_ads TO ${writer},${api}`);
  const aggregates = ["unified_aggregation_runs", "unified_source_publications", "unified_daily_facts", "unified_source_coverage", "unified_product_match_results"];
  for (const table of aggregates) {
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON meta_ads.${table} TO ${writer}; GRANT SELECT ON meta_ads.${table} TO ${api}`);
    await db.query(`CREATE POLICY stage06_writer ON meta_ads.${table} TO ${writer} USING (true) WITH CHECK (true); CREATE POLICY stage06_api ON meta_ads.${table} FOR SELECT TO ${api} USING (true)`);
  }
  // Operators submit queue rows through the web connection; only the worker can update/publish.
  await db.query(`GRANT INSERT ON meta_ads.unified_aggregation_runs TO ${api};
    CREATE POLICY stage06_queue_submit ON meta_ads.unified_aggregation_runs FOR INSERT TO ${api} WITH CHECK (
      status='STAGING' AND lease_token IS NULL AND lease_expires_at IS NULL AND attempts=0
      AND completed_at IS NULL AND published_at IS NULL AND source_fingerprint IS NULL
      AND requested_by IS NOT NULL AND reason IS NOT NULL AND btrim(reason)<>''
      AND versions='{}'::jsonb AND control_totals='[]'::jsonb AND issues='[]'::jsonb
      AND checkpoint->>'phase'='QUEUED')`);
  for (const table of ["unified_products", "unified_rules"]) {
    await db.query(`GRANT SELECT ON meta_ads.${table} TO ${writer},${api}; CREATE POLICY stage06_config_read ON meta_ads.${table} FOR SELECT TO ${writer},${api} USING (true)`);
  }
  await db.query(`GRANT SELECT ON meta_ads.source_connections TO ${writer},${api}`);
  const sourceConnectionRls = (await db.query("SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relname='source_connections'")).rows[0];
  if (sourceConnectionRls?.relrowsecurity) await db.query(`CREATE POLICY stage06_connection_read ON meta_ads.source_connections FOR SELECT TO ${writer},${api} USING (true)`);
  await db.query("CREATE TABLE public.stage06_orders(id text PRIMARY KEY,payload jsonb NOT NULL); REVOKE ALL ON public.stage06_orders FROM PUBLIC");
  await db.query("CREATE TABLE public.stage06_credentials(id text,payload jsonb); REVOKE ALL ON public.stage06_credentials FROM PUBLIC");
  evidence.checks.push("fresh PG17 loopback identity checked before synthetic writes", "all migrations applied and repeated deploy has no pending migration", "actual non-owner writer/API logins with separate source-denied permissions");
  const result = child(process.execPath, ["--import", "tsx", "--test", "scripts/unified-report-postgres.test.ts"], {
    env: { ...process.env, TSX_TSCONFIG_PATH: "apps/api/tsconfig.json", UNIFIED_STAGE06_FIXTURE_URL: url(owner), UNIFIED_STAGE06_WRITER_URL: url(writer), UNIFIED_STAGE06_API_URL: url(api),
      UNIFIED_PERFORMANCE_ENABLED: "true", UNIFIED_NAVER_ALLOWED_STORE_IDS: "11111111-1111-4111-8111-111111111111" }
  });
  assert.match(result.stdout, /pass [1-9]/); assert.match(result.stdout, /skipped 0/);
  writeFileSync(resolve(root, "tests.txt"), result.stdout);
  evidence.checks.push("actual publication/recovery/read-role tests pass with skip0"); evidence.testOutput = result.stdout;
  const planRole = new Client({ host: "127.0.0.1", port, user: writer, database });
  await planRole.connect();
  try {
    await planRole.query("SET search_path TO meta_ads");
    const queryPlans = {};
    queryPlans.claimCandidates = (await planRole.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM meta_ads.unified_aggregation_runs WHERE status='STAGING' AND (lease_expires_at IS NULL OR lease_expires_at <= now()) ORDER BY started_at,id LIMIT 50")).rows;
    await planRole.query("BEGIN");
    try {
      queryPlans.publicationCas = (await planRole.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) UPDATE meta_ads.unified_source_publications SET revision=revision+1 WHERE source_system='META' AND platform='META' AND scope_key='11111111-1111-4111-8111-111111111111' AND business_date='2026-10-26' AND run_id=(SELECT run_id FROM meta_ads.unified_source_publications WHERE platform='META' LIMIT 1)")).rows;
    } finally { await planRole.query("ROLLBACK"); }
    evidence.aggregationPlans = { role: writer, fixtureRuns: (await planRole.query("SELECT count(*)::int n FROM meta_ads.unified_aggregation_runs")).rows[0].n, publicationMutationRolledBack: true, queryPlans };
  } finally { await planRole.end(); }
  // Preserve the additive schema and every published historical revision. Recovery is
  // deliberately into a separate cluster; operational rollback never deletes history.
  const snapshot = async client => {
    const tables = ["_prisma_migrations", "unified_products", "unified_rules", ...aggregates];
    const output = {};
    for (const table of tables) {
      const schema = "meta_ads";
      const { rows } = await client.query(`SELECT to_jsonb(t) row FROM ${schema}.${table} t ORDER BY to_jsonb(t)::text`);
      output[table] = { rows: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
    }
    return output;
  };
  const before = await snapshot(db);
  await db.end(); db = null;
  child(resolve(bin, "pg_ctl.exe"), ["-D", data, "-m", "fast", "-w", "stop"]);
  started = false;
  // Embedded PG ships no pg_dump. A clean-stop physical backup is valid on
  // the identical PG17 binary; this is not a cross-version logical restore.
  assert.equal(restoredData.startsWith(root + "\\"), true);
  cpSync(data, restoredData, { recursive: true, errorOnExist: true, force: false });
  child(resolve(bin, "pg_ctl.exe"), ["-D", data, "-l", resolve(root, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -c log_statement=none -c log_min_error_statement=panic`, "-w", "start"], { stdio: "ignore" });
  started = true;
  child(resolve(bin, "pg_ctl.exe"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  started = false;
  child(resolve(bin, "pg_ctl.exe"), ["-D", data, "-l", resolve(root, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -c log_statement=none -c log_min_error_statement=panic`, "-w", "start"], { stdio: "ignore" });
  started = true;
  db = new Client({ host: "127.0.0.1", port, user: owner, database }); await db.connect();
  assert.deepEqual(await snapshot(db), before);
  child(resolve(bin, "pg_ctl.exe"), ["-D", restoredData, "-l", resolve(root, "restored-postgres.log"), "-o", `-h 127.0.0.1 -p ${restoredPort} -c log_statement=none -c log_min_error_statement=panic`, "-w", "start"], { stdio: "ignore" });
  restoredStarted = true;
  const restored = new Client({ host: "127.0.0.1", port: restoredPort, user: owner, database });
  await restored.connect();
  try {
    assert.deepEqual(await snapshot(restored), before);
    evidence.recoverySnapshot = before;
    evidence.migrations = (await restored.query("SELECT migration_name,checksum,finished_at IS NOT NULL applied FROM meta_ads._prisma_migrations ORDER BY migration_name")).rows;
  } finally { await restored.end(); }
  for (const user of [writer, api]) {
    const restoredRole = new Client({ host: "127.0.0.1", port: restoredPort, user, database });
    await restoredRole.connect();
    try {
      const identity = (await restoredRole.query("SELECT current_database() db,current_user usr,inet_server_addr()::text host")).rows[0];
      assert.equal(identity.db, database); assert.equal(identity.usr, user); assert.match(identity.host, /^127\.0\.0\.1/);
      assert.equal((await restoredRole.query("SELECT count(*)::int n FROM meta_ads.unified_source_publications")).rows[0].n, before.unified_source_publications.rows);
      await assert.rejects(restoredRole.query("SELECT * FROM public.stage06_credentials"), /permission denied/);
      await assert.rejects(restoredRole.query("INSERT INTO public.stage06_orders VALUES ('forbidden','{}')"), /permission denied/);
      if (user === api) await assert.rejects(restoredRole.query("UPDATE meta_ads.unified_source_publications SET revision=999"), /permission denied/);
    } finally { await restoredRole.end(); }
  }
  evidence.checks.push("clean-stop physical PG17 backup copied only within the isolated synthetic workspace", "immediate PostgreSQL stop/start WAL recovery preserves all publication/history hashes", "separate restored cluster preserves complete migrations/configuration/publication/facts/coverage/audit hashes", "restored writer/API login read grants and source/credential/write denials remain enforced");
  evidence.recovery = { backupFormat: "clean-stop physical PG17", restoredPort, crashStop: "immediate", originalDatabasePreserved: true, productionRolesVerified: false, backupContainsSyntheticDataOnly: true, logicalPgDumpRestoreVerified: false };
  evidence.status = "PASS";
} catch (error) {
  evidence.status = "FAIL"; evidence.error = error.message; evidence.syntheticDetail = error.detail ?? null; process.exitCode = 1;
} finally {
  if (db) await db.end().catch(() => {});
  if (restoredStarted) {
    const result = spawnSync(resolve(bin, "pg_ctl.exe"), ["-D", restoredData, "-m", "fast", "-w", "stop"], { windowsHide: true, encoding: "utf8", timeout: 30000 });
    evidence.restoredStopExitCode = result.status;
    if (result.status !== 0) { evidence.status = "FAIL"; process.exitCode = 1; }
  }
  if (started) {
    const result = spawnSync(resolve(bin, "pg_ctl.exe"), ["-D", data, "-m", "fast", "-w", "stop"], { windowsHide: true, encoding: "utf8", timeout: 30000 });
    evidence.stopExitCode = result.status;
    if (result.status !== 0) { evidence.status = "FAIL"; process.exitCode = 1; }
  }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync("docs/product-performance/research/10-recovery-postgres-result.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}
