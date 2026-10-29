// Stage10 extracted least-privilege SQL rehearsed through current stage07 HTTP tests.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const runtime = resolve(process.env.LOCALAPPDATA, "UnifiedPerformanceStage02");
const require = createRequire(import.meta.url);
const { Client } = require(resolve(runtime, "node_modules/pg"));
const bin = resolve(runtime, "node_modules/@embedded-postgres/windows-x64/native/bin");
const root = resolve(runtime, `stage10-permissions-${randomUUID()}`), data = resolve(root, "data");
mkdirSync(root, { recursive: true });
const port = 55452, database = "unified_stage07", owner = "unified_stage07_owner";
const config = "unified_stage07_config", viewer = "unified_stage07_viewer", worker = "unified_stage07_worker";
const url = user => `postgresql://${user}@127.0.0.1:${port}/${database}?schema=meta_ads`;
const evidence = { stage: "10-permissions", startedAt: new Date().toISOString(), target: { host: "127.0.0.1", port, database },
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
  for (const role of [config, viewer, worker]) await db.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; GRANT USAGE ON SCHEMA meta_ads TO ${role}`);
  await db.query(readFileSync("scripts/unified-stage10-permissions.sql", "utf8"));
  for (const user of [config, viewer, worker]) {
    const restricted = new Client({ host: "127.0.0.1", port, user, database });
    await restricted.connect();
    try {
      await restricted.query("SELECT id,provider,display_name,currency_code,time_zone FROM meta_ads.source_connections");
      await assert.rejects(restricted.query("SELECT credential_ref FROM meta_ads.source_connections"), /permission denied/);
      await assert.rejects(restricted.query("SELECT external_account_id FROM meta_ads.source_connections"), /permission denied/);
    } finally { await restricted.end(); }
  }
  evidence.checks.push("actual config/viewer/worker metadata-column SELECT allowed; credential_ref and external_account_id SELECT denied");
  await db.query("CREATE TABLE public.stage07_source_orders(id text PRIMARY KEY,payload jsonb); CREATE TABLE public.stage07_credentials(id text,payload jsonb); REVOKE ALL ON public.stage07_source_orders,public.stage07_credentials FROM PUBLIC");
  evidence.checks.push("fresh fixed loopback PG17 identity checked; all migrations applied and second deploy empty", "separate non-owner configuration, read-only viewer and publication worker roles; source and credential access denied");
  const result = child(process.execPath, ["--import", "tsx", "--test", "scripts/unified-management-http.test.ts"], {
    env: { ...process.env, TSX_TSCONFIG_PATH: "apps/api/tsconfig.json", UNIFIED_STAGE07_OWNER_URL: url(owner), UNIFIED_STAGE07_CONFIG_URL: url(config),
      UNIFIED_STAGE07_VIEWER_URL: url(viewer), UNIFIED_STAGE07_WORKER_URL: url(worker), UNIFIED_PERFORMANCE_ENABLED: "true", UNIFIED_REPORT_LEGACY_PLATFORMS: "" }
  });
  assert.match(result.stdout, /pass [1-9]/); assert.match(result.stdout, /skipped 0/);
  writeFileSync(resolve(root, "tests.txt"), result.stdout + result.stderr); evidence.testOutput = result.stdout;
  evidence.checks.push("real Nest HTTP routes, production permission guard/DTO validation and actual restricted PostgreSQL logins exercised; fixture principals replace external authentication only");
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
  writeFileSync("docs/product-performance/research/10-recovery-permissions-result.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}
