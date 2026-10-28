// Stage04 synthetic integration: new loopback PG17; no supplied DB URL or credentials.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const runtime = resolve(process.env.LOCALAPPDATA, "UnifiedPerformanceStage02");
const require = createRequire(import.meta.url);
const { Client } = require(resolve(runtime, "node_modules/pg"));
const bin = resolve(runtime, "node_modules/@embedded-postgres/windows-x64/native/bin");
const root = resolve(runtime, `stage04-${randomUUID()}`), data = resolve(root, "data");
mkdirSync(root, { recursive: true });
const port = 55449, database = "unified_stage04", owner = "unified_fixture_owner", reader = "unified_source_reader";
const url = user => `postgresql://${user}@127.0.0.1:${port}/${database}?schema=meta_ads`;
const evidence = { stage: "04", startedAt: new Date().toISOString(), target: { host: "127.0.0.1", port, database },
  realBusinessData: false, remoteWrites: 0, status: "RUNNING", checks: [] };
const child = (file, args, options = {}) => {
  const result = spawnSync(file, args, { windowsHide: true, encoding: "utf8", timeout: 180000, maxBuffer: 8388608, ...options });
  if (result.status !== 0) throw Object.assign(new Error("Synthetic local child failed"), { detail: `${result.stdout ?? ""}\n${result.stderr ?? ""}` });
  return result;
};
let db, started = false;
try {
  child(resolve(bin, "initdb.exe"), ["-D", data, "-U", owner, "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"]);
  child(resolve(bin, "pg_ctl.exe"), ["-D", data, "-l", resolve(root, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -c log_statement=none -c log_min_error_statement=panic`, "-w", "start"], { stdio: "ignore" });
  started = true;
  db = new Client({ host: "127.0.0.1", port, user: owner, database: "postgres" });
  await db.connect();
  const identity = (await db.query("SELECT current_database() db,current_user usr,inet_server_addr()::text host,current_setting('server_version_num') version")).rows[0];
  assert.equal(identity.db, "postgres"); assert.equal(identity.usr, owner);
  assert.match(identity.host, /^127\.0\.0\.1(?:\/32)?$/); assert.match(identity.version, /^17/);
  await db.query(`CREATE DATABASE ${database}`); await db.end();
  const migration = child(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"], {
    env: { ...process.env, DATABASE_URL: url(owner), SHADOW_DATABASE_URL: url(owner).replace(database, database + "_unused_shadow") }
  });
  writeFileSync(resolve(root, "migrations.txt"), migration.stdout);
  db = new Client({ host: "127.0.0.1", port, user: owner, database }); await db.connect();
  await db.query(`CREATE ROLE ${reader} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; GRANT USAGE ON SCHEMA meta_ads TO ${reader}`);
  const tables = ["coupang_products", "coupang_product_rules", "coupang_cost_rules", "coupang_sales_fee_rules", "coupang_manual_purchases", "coupang_upload_batches", "coupang_sale_lines", "coupang_ad_metrics", "unified_products", "unified_rules"];
  for (const table of tables) {
    await db.query(`GRANT SELECT ON meta_ads.${table} TO ${reader}`);
    const policy = (await db.query("SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relname=$1", [table])).rows[0];
    if (policy?.relrowsecurity) await db.query(`CREATE POLICY stage04_read ON meta_ads.${table} FOR SELECT TO ${reader} USING (true)`);
  }
  evidence.checks.push("fresh PG17 loopback identity checked before synthetic writes", "all migrations applied", "non-owner source reader SELECT grants; unified configuration RLS read policy");
  const result = child(process.execPath, ["--import", "tsx", "--test", "scripts/unified-coupang-postgres.test.ts"], {
    env: { ...process.env, TSX_TSCONFIG_PATH: "apps/api/tsconfig.json", UNIFIED_STAGE04_FIXTURE_URL: url(owner), UNIFIED_STAGE04_READER_URL: url(reader),
      UNIFIED_PERFORMANCE_ENABLED: "true", DAILY_SYNC_FEATURE_ENABLED: "true" }
  });
  assert.match(result.stdout, /pass [1-9]/); assert.match(result.stdout, /skipped 0/);
  writeFileSync(resolve(root, "tests.txt"), result.stdout);
  evidence.checks.push("actual reader adapter tests pass with skip0"); evidence.testOutput = result.stdout;
  evidence.status = "PASS";
} catch (error) {
  evidence.status = "FAIL"; evidence.error = error.message; evidence.syntheticDetail = error.detail ?? null; process.exitCode = 1;
} finally {
  if (db) await db.end().catch(() => {});
  if (started) {
    const result = spawnSync(resolve(bin, "pg_ctl.exe"), ["-D", data, "-m", "fast", "-w", "stop"], { windowsHide: true, encoding: "utf8", timeout: 30000 });
    evidence.stopExitCode = result.status;
    if (result.status !== 0) { evidence.status = "FAIL"; process.exitCode = 1; }
  }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync("docs/product-performance/research/04-coupang-postgres-result.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}
