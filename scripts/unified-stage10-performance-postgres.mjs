// A fresh, explicitly fixed loopback database; never consumes a configured operational URL.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const runtime = resolve(process.env.LOCALAPPDATA, "UnifiedPerformanceStage02");
const require = createRequire(import.meta.url);
const { Client } = require(resolve(runtime, "node_modules/pg"));
const bin = resolve(runtime, "node_modules/@embedded-postgres/windows-x64/native/bin");
const root = resolve(runtime, `stage10perf-${randomUUID()}`), data = resolve(root, "data");
mkdirSync(root, { recursive: true });
const port = 55456, database = "unified_stage10perf", owner = "unified_stage10perf_owner", viewer = "unified_stage10perf_viewer";
const browserMode = process.env.UNIFIED_STAGE10PERF_BROWSER === "1";
const url = user => `postgresql://${user}@127.0.0.1:${port}/${database}?schema=meta_ads`;
const evidence = { stage: "10", startedAt: new Date().toISOString(), target: { host: "127.0.0.1", port, database },
  realBusinessData: false, remoteWrites: 0, status: "RUNNING", checks: [],
  purpose: "stage10 isolated HTTP performance; no operational URL", remoteConfigWrites: 0 };
const child = (file, args, options = {}) => {
  const result = spawnSync(file, args, { windowsHide: true, encoding: "utf8", timeout: 240000, maxBuffer: 8388608, ...options });
  if (result.status !== 0) throw Object.assign(new Error("Synthetic local child failed"), { detail: `${result.stdout ?? ""}\n${result.stderr ?? ""}` });
  return result;
};
let db, started = false;
try {
  child(resolve(bin, "initdb.exe"), ["-D", data, "-U", owner, "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"]);
  child(resolve(bin, "pg_ctl.exe"), ["-D", data, "-l", resolve(root, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -c log_statement=none -c log_min_error_statement=panic`, "-w", "start"], { stdio: "ignore" });
  started = true;
  db = new Client({ host: "127.0.0.1", port, user: owner, database: "postgres" }); await db.connect();
  const identity = (await db.query("SELECT current_database() db,current_user usr,inet_server_addr()::text host,current_setting('server_version_num') version")).rows[0];
  assert.equal(identity.db, "postgres"); assert.equal(identity.usr, owner);
  assert.match(identity.host, /^127\.0\.0\.1(?:\/32)?$/); assert.match(identity.version, /^17/);
  await db.query(`CREATE DATABASE ${database}`); await db.end();
  const migrate = () => child(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"], {
    env: { ...process.env, DATABASE_URL: url(owner), SHADOW_DATABASE_URL: url(owner).replace(database, database + "_unused_shadow") }
  });
  writeFileSync(resolve(root, "migrations.txt"), migrate().stdout);
  assert.match(migrate().stdout, /No pending migrations/);
  db = new Client({ host: "127.0.0.1", port, user: owner, database }); await db.connect();
  await db.query(`CREATE ROLE ${viewer} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; GRANT USAGE ON SCHEMA meta_ads TO ${viewer}`);
  for (const table of ["unified_products", "unified_rules", "unified_aggregation_runs", "unified_source_publications", "unified_daily_facts", "unified_source_coverage"]) {
    await db.query(`GRANT SELECT ON meta_ads.${table} TO ${viewer}; CREATE POLICY stage10perf_viewer ON meta_ads.${table} FOR SELECT TO ${viewer} USING (true)`);
  }
  await db.query(`GRANT SELECT ON meta_ads.source_connections TO ${viewer}`);
  const sourceRls = (await db.query("SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relname='source_connections'")).rows[0];
  if (sourceRls?.relrowsecurity) await db.query(`CREATE POLICY stage10perf_connection ON meta_ads.source_connections FOR SELECT TO ${viewer} USING (true)`);
  await db.query("CREATE TABLE public.stage10perf_source_orders(id text PRIMARY KEY,payload jsonb); CREATE TABLE public.stage10perf_credentials(id text,payload jsonb); REVOKE ALL ON public.stage10perf_source_orders,public.stage10perf_credentials FROM PUBLIC");
  evidence.checks.push("fresh fixed loopback PG17 identity checked; all migrations applied and second deploy empty", "actual non-owner read-only viewer role; raw source, credentials and aggregate writes denied");
  const testEnvironment = { ...process.env, TSX_TSCONFIG_PATH: "apps/api/tsconfig.json", UNIFIED_STAGE10PERF_OWNER_URL: url(owner),
      UNIFIED_STAGE10PERF_VIEWER_URL: url(viewer), UNIFIED_PERFORMANCE_ENABLED: "true", UNIFIED_REPORT_LEGACY_PLATFORMS: "",
      UNIFIED_NAVER_ALLOWED_STORE_IDS: "stage10perf-naver" };
  const result = browserMode ? await new Promise((resolveResult, reject) => {
    const active = spawn(process.execPath, ["--import", "tsx", "--test", "scripts/unified-stage10-performance-http.test.ts"], { windowsHide: true, env: testEnvironment });
    let stdout = "", stderr = "";
    active.stdout.on("data", data => { const value = data.toString(); stdout += value; process.stdout.write(value); });
    active.stderr.on("data", data => { const value = data.toString(); stderr += value; process.stderr.write(value); });
    // Ctrl+C requests graceful release of the synthetic HTTP hold, then the normal finally stops PG.
    const stop = () => { void fetch("http://127.0.0.1:4199/api/__stage10perf/stop", { method: "POST" }).catch(() => {}); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    active.on("error", reject);
    active.on("close", code => {
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      if (code === 0) resolveResult({ stdout, stderr });
      else reject(Object.assign(new Error("Synthetic browser fixture failed"), { detail: stdout + stderr }));
    });
  }) : child(process.execPath, ["--import", "tsx", "--test", "scripts/unified-stage10-performance-http.test.ts"], { env: testEnvironment });
  assert.match(result.stdout, /pass [1-9]/); assert.match(result.stdout, process.env.UNIFIED_STAGE10PERF_QUICK === "1" ? /skipped 1/ : /skipped 0/);
  writeFileSync(resolve(root, "tests.txt"), result.stdout + result.stderr); evidence.testOutput = result.stdout;
  evidence.checks.push("real Nest HTTP permission guard, DTO validation, report repository/service and PostgreSQL reads; only authentication principal is a loopback fixture", "32 platform selections, exact daily input reconciliation, lag direction and paired sample counts, omitted Naver dates and missing product costs exercised", process.env.UNIFIED_STAGE10PERF_QUICK === "1" ? "366-day four-page cursor regression; performance subtest intentionally skipped" : "performance measurement includes sequential and concurrent requests, memory, connections, query plans and timeout recovery");
  evidence.status = "PASS";
} catch (error) {
  evidence.status = "FAIL"; evidence.error = error.message; evidence.syntheticDetail = error.detail ?? null; process.exitCode = 1;
} finally {
  if (db) await db.end().catch(() => {});
  if (started) {
    evidence.stopExitCode = spawnSync(resolve(bin, "pg_ctl.exe"), ["-D", data, "-m", "fast", "-w", "stop"], { windowsHide: true, encoding: "utf8", timeout: 30000 }).status;
    if (evidence.stopExitCode !== 0) { evidence.status = "FAIL"; process.exitCode = 1; }
  }
  evidence.finishedAt = new Date().toISOString(); evidence.localEvidence = root;
  writeFileSync(`docs/product-performance/research/10-performance-${process.env.UNIFIED_STAGE10PERF_QUICK === "1" ? "pagination" : "postgres"}-result.json`, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}
