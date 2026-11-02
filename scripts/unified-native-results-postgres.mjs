// Fresh synthetic PG17 only. Never consumes production connection variables.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);
const runtime = resolve(process.env.LOCALAPPDATA, "UnifiedPerformanceStage02");
const { Client } = require(resolve(runtime, "node_modules/pg"));
const { PrismaClient } = require("@prisma/client");
const bin = resolve(runtime, "node_modules/@embedded-postgres/windows-x64/native/bin");
const root = resolve(runtime, `native-results-${randomUUID()}`), data = resolve(root, "data");
const database = "unified_native_results", owner = "native_fixture_owner", worker = "native_fixture_worker";
const migrationName = "20261102071000_native_storefront_results";
const migrationFile = resolve("apps/api/prisma/migrations", migrationName, "migration.sql");
const evidenceFile = join(tmpdir(), "unified-native-results-postgres-result.json");
const evidence = { status: "RUNNING", realBusinessData: false, remoteWrites: 0, migration: migrationName,
  migrationSha256: createHash("sha256").update(readFileSync(migrationFile)).digest("hex"), startedAt: new Date().toISOString(), checks: [] };
const child = (file, args, options = {}) => {
  const result = spawnSync(file, args, { windowsHide: true, encoding: "utf8", timeout: 180000, maxBuffer: 8388608, ...options });
  if (result.status !== 0) throw Object.assign(new Error("LOCAL_FIXTURE_CHILD_FAILED"), { detail: `${result.stdout ?? ""}\n${result.stderr ?? ""}` });
  return result;
};
const port = await new Promise((done, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => {
  const address = server.address(); server.close(error => error ? reject(error) : done(address.port));
}); });
const url = user => `postgresql://${user}@127.0.0.1:${port}/${database}?schema=meta_ads&connection_limit=1`;
evidence.target = { host: "127.0.0.1", port, database };
mkdirSync(root, { recursive: true });
let db, prisma, started = false;
try {
  child(resolve(bin, "initdb.exe"), ["-D", data, "-U", owner, "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"]);
  child(resolve(bin, "pg_ctl.exe"), ["-D", data, "-l", resolve(root, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -c log_statement=none -c log_min_error_statement=panic`, "-w", "start"], { stdio: "ignore" });
  started = true;
  db = new Client({ host: "127.0.0.1", port, user: owner, database: "postgres" }); await db.connect();
  const identity = (await db.query("SELECT current_user role,current_database() db,inet_server_addr()::text host,current_setting('server_version_num') version")).rows[0];
  assert.equal(identity.role, owner); assert.equal(identity.db, "postgres"); assert.match(identity.host, /^127\.0\.0\.1/); assert.match(identity.version, /^17/);
  await db.query(`CREATE DATABASE ${database}`); await db.end();
  const migrationEnv = { ...process.env, DATABASE_URL: url(owner), SHADOW_DATABASE_URL: url(owner).replace(database, `${database}_unused_shadow`) };
  const deployArgs = ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"];
  const deployment = child(process.execPath, deployArgs, { env: migrationEnv });
  assert.match(child(process.execPath, deployArgs, { env: migrationEnv }).stdout, /No pending migrations/);
  writeFileSync(resolve(root, "migrations.txt"), deployment.stdout);
  db = new Client({ host: "127.0.0.1", port, user: owner, database }); await db.connect();
  await db.query("SET search_path TO meta_ads,public");
  const migrated = (await db.query("SELECT checksum,finished_at,rolled_back_at FROM meta_ads._prisma_migrations WHERE migration_name=$1", [migrationName])).rows;
  assert.equal(migrated.length, 1); assert.ok(migrated[0].finished_at); assert.equal(migrated[0].rolled_back_at, null);
  assert.equal(migrated[0].checksum, evidence.migrationSha256);
  evidence.checks.push("fresh PG17 loopback identity verified; complete migration history applied; repeat deploy no pending migrations; exact new migration checksum matches");

  const partitionScope = randomUUID(), oldRun = randomUUID(), stagingRun = randomUUID(), date = "2026-11-01";
  const insertRun = id => db.query(`INSERT INTO unified_aggregation_runs(id,source_system,platform,scope_key,business_date,contract_version,versions,read_snapshot_id,source_watermarks,control_totals,issues)
    VALUES($1,'CAFE24','CAFE24',$2,$3,'product-performance-v1.1.0','{}','fixture','{}','[]','[]')`, [id, partitionScope, date]);
  await insertRun(oldRun); await insertRun(stagingRun);
  const insertFact = (run, component, attribution = "DIRECT", key = randomUUID(), payload = {}) => db.query(`INSERT INTO unified_daily_facts(id,run_id,component,fact_key,attribution,amount_krw,payload)
    VALUES($1,$2,$3,$4,$5,1,$6)`, [randomUUID(), run, component, key, attribution, JSON.stringify(payload)]);
  for (const component of ["SALE", "AD_SPEND", "COMMON_EXPENSE", "SHIPPING_INCOME"]) await insertFact(oldRun, component);
  await db.query(`INSERT INTO unified_source_coverage(id,run_id,component,participation,collection_state,zero_confirmed,rows_present,is_estimate,details)
    VALUES($1,$2,'SALE','INCLUDED','COMPLETE',false,1,false,'{}')`, [randomUUID(), oldRun]);
  await db.query("UPDATE unified_aggregation_runs SET status='READY',completed_at=now() WHERE id=$1", [oldRun]);
  await db.query(`INSERT INTO unified_source_publications(source_system,platform,scope_key,business_date,run_id,updated_at)
    VALUES('CAFE24','CAFE24',$1,$2,$3,now())`, [partitionScope, date, oldRun]);
  await db.query("UPDATE unified_aggregation_runs SET status='PUBLISHED',published_at=now() WHERE id=$1", [oldRun]);
  const oldSnapshot = (await db.query("SELECT to_jsonb(f) value FROM unified_daily_facts f WHERE run_id=$1 ORDER BY component", [oldRun])).rows;
  for (const [component, attribution, key, payload] of [["INVALID", "DIRECT", "key", {}], ["STOREFRONT_RESULT", "INVALID", "key", {}],
    ["STOREFRONT_RESULT", "DIRECT", " ", {}], ["STOREFRONT_RESULT", "DIRECT", "key", []]]) {
    await assert.rejects(insertFact(stagingRun, component, attribution, key, payload), error => error.code === "23514");
  }
  await insertFact(stagingRun, "STOREFRONT_RESULT", "DIRECT", "unique-native");
  await assert.rejects(insertFact(stagingRun, "STOREFRONT_RESULT", "DIRECT", "unique-native"), error => error.code === "23505");
  evidence.checks.push("all four legacy fact components remain valid/publishable; native component accepted; invalid component/attribution/blank-key/non-object JSON rejected; duplicate run/component/fact-key rejected");

  await db.query(`CREATE ROLE ${worker} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; GRANT USAGE ON SCHEMA meta_ads TO ${worker}`);
  for (const table of ["unified_aggregation_runs", "unified_daily_facts", "unified_source_coverage", "unified_product_match_results", "unified_source_publications"]) {
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON meta_ads.${table} TO ${worker}; CREATE POLICY native_fixture ON meta_ads.${table} TO ${worker} USING (true) WITH CHECK (true)`);
  }
  const { UnifiedAggregationRepository, assertReportConservation } = require(resolve("apps/api/dist/unified-performance/aggregation.repository.js"));
  const { normalizeCafe24Snapshot } = require(resolve("apps/api/dist/unified-performance/adapters/cafe24.adapter.js"));
  const { completeSourceCoverage } = require(resolve("apps/api/dist/unified-performance/aggregation.worker.js"));
  const { managementVersions } = require(resolve("apps/api/dist/unified-performance/management.repository.js"));
  const { prepareReportBatch, summarizeReport } = require(resolve("apps/api/dist/unified-performance/domain/report-calculation.js"));
  prisma = new PrismaClient({ datasourceUrl: url(worker) });
  const [workerIdentity] = await prisma.$queryRaw`SELECT current_user role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  assert.equal(workerIdentity.role, worker); assert.equal(workerIdentity.rolsuper, false); assert.equal(workerIdentity.rolbypassrls, false);
  const repository = new UnifiedAggregationRepository(prisma);
  const queued = await repository.enqueue([{ platform: "CAFE24", scopeKey: partitionScope, date }], null, "synthetic native migration fixture", "native-fixture");
  const claim = await repository.claim(queued.jobs[0].jobId); assert.ok(claim); assert.equal(claim.previousRunId, oldRun);
  const config = { products: [], rules: [], versions: managementVersions([], []) };
  const request = { contractVersion: "product-performance-v1.1.0", runId: claim.runId, readSnapshotId: randomUUID(),
    from: date, to: date, scopeKeys: [partitionScope], platforms: ["CAFE24"], ...config.versions,
    calculationVersion: "native-fixture-v1", fxVersion: "fx", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 };
  const batch = completeSourceCoverage(claim, normalizeCafe24Snapshot(request, { configuration: config, scopeKey: partitionScope,
    currency: "KRW", timeZone: "Asia/Seoul", date, observedAt: "2026-11-02T00:00:00Z", lines: [], unitRules: [], couponRules: [],
    selectedSource: "API", complete: true, collectedAt: "2026-11-02T00:00:00Z", sourceVersion: "fixture", couponInputSource: null,
    sourceIssues: [], excludedByPolicyRows: 0 }));
  batch.nativeStorefrontResults = { calculationVersion: "native-fixture-v1", sourceFingerprint: "native-fixture", issues: [], rows: [
    { channel: "META", productName: "synthetic", revenue: "100", grossCost: "40", coupon: "10", adSpend: "20", profitBeforeAds: "50", estimatedProfit: "30", quantity: "1", complete: true, issues: [] },
    { channel: "YOUTUBE", productName: "synthetic", revenue: "20", grossCost: "10", coupon: "0", adSpend: "15", profitBeforeAds: "10", estimatedProfit: "-5", quantity: "1", complete: true, issues: [] }
  ] };
  const facts = prepareReportBatch(request, batch), nativeFact = facts.find(row => row.component === "STOREFRONT_RESULT" && row.rowsCount > 0);
  assert.ok(nativeFact); assertReportConservation(batch, facts);
  const corrupted = facts.map(row => row === nativeFact ? { ...row, profitBeforeAds: "999" } : row);
  await assert.rejects(repository.stageAndPublish(claim, request, batch, corrupted), /AGGREGATION_REPORT_CONSERVATION_FAILED/);
  assert.equal(await prisma.unifiedDailyFact.count({ where: { runId: claim.runId } }), 0);
  await repository.stageAndPublish(claim, request, batch, facts);
  const stored = await prisma.unifiedDailyFact.findMany({ where: { runId: claim.runId } });
  assert.equal(stored.filter(row => row.component === "STOREFRONT_RESULT").length, 4);
  assert.equal((await prisma.unifiedAggregationRun.findUniqueOrThrow({ where: { id: claim.runId } })).status, "PUBLISHED");
  const pointer = await prisma.unifiedSourcePublication.findFirstOrThrow({ where: { scopeKey: partitionScope } });
  assert.equal(pointer.runId, claim.runId); assert.equal(pointer.revision, 2);
  const persisted = stored.map(row => ({ ...row.payload, platform: "CAFE24", scopeKey: partitionScope, date }));
  const summary = summarizeReport(persisted, batch.coverage, { platforms: ["CAFE24"] });
  assert.equal(summary.knownTotals.revenue, "120.000000"); assert.equal(summary.knownTotals.profitBeforeAds, "60.000000");
  assert.equal(stored.find(row => row.payload.persistedNetProfit === "-5.000000")?.payload.persistedAdSpend, "15.000000");
  evidence.checks.push("actual non-owner repository enqueue/claim/stageAndPublish accepts native results plus null adoption markers; altered native profit fails conservation before any insert; atomic revision2 published; stored reader returns revenue120/beforeAds60 and negative audit-5 intact");

  const before = (await db.query("SELECT to_jsonb(f) value FROM unified_daily_facts f WHERE run_id=$1 ORDER BY fact_key", [claim.runId])).rows;
  await assert.rejects(db.query("UPDATE unified_daily_facts SET amount_krw=999 WHERE run_id=$1", [claim.runId]), error => error.code === "23514");
  await assert.rejects(db.query("DELETE FROM unified_daily_facts WHERE run_id=$1", [claim.runId]), error => error.code === "23514");
  await assert.rejects(insertFact(claim.runId, "STOREFRONT_RESULT"), error => error.code === "23514");
  await assert.rejects(db.query("UPDATE unified_aggregation_runs SET status='FAILED' WHERE id=$1", [claim.runId]), error => error.code === "23514");
  await assert.rejects(db.query("DELETE FROM unified_aggregation_runs WHERE id=$1", [claim.runId]), error => error.code === "23514");
  assert.deepEqual((await db.query("SELECT to_jsonb(f) value FROM unified_daily_facts f WHERE run_id=$1 ORDER BY fact_key", [claim.runId])).rows, before);
  assert.deepEqual((await db.query("SELECT to_jsonb(f) value FROM unified_daily_facts f WHERE run_id=$1 ORDER BY component", [oldRun])).rows, oldSnapshot);
  const flags = (await db.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='meta_ads.unified_daily_facts'::regclass")).rows[0];
  assert.equal(flags.relrowsecurity, true); assert.equal(flags.relforcerowsecurity, true);
  evidence.checks.push("actual immutable-child/run triggers reject published fact insert/update/delete and run update/delete; old/new published facts remain byte-for-byte equal; ENABLE/FORCE RLS remain set");
  evidence.status = "PASS";
} catch (error) { evidence.status = "FAIL"; evidence.error = error.message; evidence.syntheticDetail = error.detail ?? null; process.exitCode = 1; }
finally {
  if (prisma) await prisma.$disconnect();
  if (db) await db.end().catch(() => {});
  if (started) { const stopped = spawnSync(resolve(bin, "pg_ctl.exe"), ["-D", data, "-m", "fast", "-w", "stop"], { windowsHide: true, encoding: "utf8", timeout: 30000 });
    evidence.stopExitCode = stopped.status; if (stopped.status !== 0) { evidence.status = "FAIL"; process.exitCode = 1; } }
  evidence.finishedAt = new Date().toISOString(); writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
}
