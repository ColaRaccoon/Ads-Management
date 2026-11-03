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
const root = resolve(runtime, `native-finals-${randomUUID()}`), data = resolve(root, "data");
const database = "unified_native_finals", owner = "native_fixture_owner", worker = "meta_ads_unified_worker", reader = "meta_ads_unified_report";
const migrationName = "20261103085000_native_final_results";
const migrationFile = resolve("apps/api/prisma/migrations", migrationName, "migration.sql");
const evidenceFile = join(tmpdir(), "unified-native-finals-postgres-result.json");
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
let db, prisma, ownerPrisma, readerPrisma, started = false;
try {
  child(resolve(bin, "initdb.exe"), ["-D", data, "-U", owner, "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"]);
  child(resolve(bin, "pg_ctl.exe"), ["-D", data, "-l", resolve(root, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -c log_statement=none -c log_min_error_statement=panic`, "-w", "start"], { stdio: "ignore" });
  started = true;
  db = new Client({ host: "127.0.0.1", port, user: owner, database: "postgres" }); await db.connect();
  const identity = (await db.query("SELECT current_user role,current_database() db,inet_server_addr()::text host,current_setting('server_version_num') version")).rows[0];
  assert.equal(identity.role, owner); assert.equal(identity.db, "postgres"); assert.match(identity.host, /^127\.0\.0\.1/); assert.match(identity.version, /^17/);
  await db.query(`CREATE DATABASE ${database}`);
  await db.query(`CREATE ROLE ${worker} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    CREATE ROLE ${reader} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  await db.end();
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

  const reconciliationMigration = "20261103090000_unified_reconciliation_checks";
  const reconciliationHash = createHash("sha256").update(readFileSync(resolve("apps/api/prisma/migrations", reconciliationMigration, "migration.sql"))).digest("hex");
  assert.equal((await db.query("SELECT checksum FROM meta_ads._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL", [reconciliationMigration])).rows[0].checksum, reconciliationHash);
  evidence.reconciliationMigrationSha256 = reconciliationHash;
  await db.query(`GRANT USAGE ON SCHEMA meta_ads TO ${worker},${reader}`);
  const ledgerTables = ["unified_aggregation_runs", "unified_daily_facts", "unified_source_coverage", "unified_product_match_results", "unified_source_publications"];
  for (const table of ledgerTables) {
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON meta_ads.${table} TO ${worker};
      CREATE POLICY native_final_worker ON meta_ads.${table} TO ${worker} USING (true) WITH CHECK (true)`);
    if (table !== "unified_product_match_results") await db.query(`GRANT SELECT ON meta_ads.${table} TO ${reader};
      CREATE POLICY native_final_report ON meta_ads.${table} FOR SELECT TO ${reader} USING (true)`);
  }
  for (const table of ["unified_products", "unified_rules"]) {
    await db.query(`GRANT SELECT ON meta_ads.${table} TO ${worker},${reader};
      CREATE POLICY native_final_config ON meta_ads.${table} FOR SELECT TO ${worker},${reader} USING (true)`);
  }
  const sourceTables = ["coupang_products", "coupang_product_rules", "coupang_cost_rules", "coupang_sales_fee_rules",
    "coupang_manual_purchases", "coupang_upload_batches", "coupang_sale_lines", "coupang_ad_metrics", "coupang_promotion_prices"];
  const baselineGrants = readFileSync("scripts/unified-stage11-reconcile-roles.sql", "utf8");
  for (const table of sourceTables) {
    await db.query(`ALTER TABLE meta_ads.${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE meta_ads.${table} FORCE ROW LEVEL SECURITY`);
    if (table === "coupang_promotion_prices") continue;
    const grant = [...baselineGrants.matchAll(/GRANT SELECT \([^;]+ON TABLE "meta_ads"\."([^\"]+)" TO meta_ads_unified_worker;/g)].find(match => match[1] === table);
    assert.ok(grant, `missing baseline column grant: ${table}`); await db.query(grant[0]);
    await db.query(`CREATE POLICY unified_stage11_worker_source_select ON meta_ads.${table} FOR SELECT TO ${worker} USING (true)`);
  }
  await db.query(readFileSync("scripts/unified-native-finals-source-grants.sql", "utf8"));
  evidence.checks.push("actual least-privilege Coupang baseline plus 29-column delta and promotion RLS policy installed; source tables ENABLE/FORCE RLS");

  const { UnifiedAggregationRepository } = require(resolve("apps/api/dist/unified-performance/aggregation.repository.js"));
  const { UnifiedAggregationWorker, aggregationAdapterRequest, assertSourceExecutionSucceeded, completeSourceCoverage } = require(resolve("apps/api/dist/unified-performance/aggregation.worker.js"));
  const { UnifiedManagementRepository } = require(resolve("apps/api/dist/unified-performance/management.repository.js"));
  const { UnifiedReportRepository } = require(resolve("apps/api/dist/unified-performance/report.repository.js"));
  const { parseReportQuery } = require(resolve("apps/api/dist/unified-performance/report-query.js"));
  const { prepareReportBatch } = require(resolve("apps/api/dist/unified-performance/domain/report-calculation.js"));
  const { summarizeNativeResults } = require(resolve("apps/api/dist/unified-performance/domain/stored-result-projection.js"));
  const { readCoupangDay } = require(resolve("apps/api/dist/unified-performance/adapters/coupang.adapter.js"));
  const { readCoupangNativeDailyResults } = require(resolve("apps/api/dist/coupang/coupang-native-results.js"));
  const { ExactDecimal, quantizeMoney } = require(resolve("apps/api/dist/unified-performance/domain/decimal.js"));
  ownerPrisma = new PrismaClient({ datasourceUrl: url(owner) });
  prisma = new PrismaClient({ datasourceUrl: url(worker), log: [{ emit: "event", level: "query" }] });
  prisma.$on("query", event => {
    if (event.query.includes("coupang_promotion_prices")) evidence.lastPromotionQuery = event.query;
  });
  readerPrisma = new PrismaClient({ datasourceUrl: url(reader) });
  for (const client of [prisma, readerPrisma]) {
    const [identity] = await client.$queryRaw`SELECT current_user role,rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user`;
    assert.ok([worker, reader].includes(identity.role)); assert.equal(identity.rolsuper, false); assert.equal(identity.rolbypassrls, false); assert.equal(identity.rolinherit, false);
  }
  const scopeKey = "LEGACY_COUPANG_SINGLE_UPLOAD", date = "2026-11-01", at = new Date(date), importedAt = new Date("2026-11-02T00:00:00Z");
  const product = await ownerPrisma.coupangProduct.create({ data: { standardName: "synthetic-complete", displayName: "synthetic-complete" } });
  const incomplete = await ownerPrisma.coupangProduct.create({ data: { standardName: "synthetic-missing-cost", displayName: "synthetic-missing-cost" } });
  const cost = await ownerPrisma.coupangCostRule.create({ data: { coupangProductId: product.id, effectiveFrom: at,
    salePriceKrw: "1100", productCostKrw: "100", sellerShippingFeeKrw: "10", hanaroShippingFeeKrw: "0" } });
  await ownerPrisma.coupangSalesFeeRule.create({ data: { effectiveFrom: at, salesFeeRate: "0.1" } });
  const saleBatch = await ownerPrisma.coupangUploadBatch.create({ data: { sourceType: "SALES", originalFilename: "synthetic-native.xlsx",
    fileHashSha256: createHash("sha256").update("native-final-sales").digest("hex"), columnSchema: {}, status: "IMPORTED", importedAt } });
  const adBatch = await ownerPrisma.coupangUploadBatch.create({ data: { sourceType: "ADS", originalFilename: "synthetic-native-ads.xlsx",
    fileHashSha256: createHash("sha256").update("native-final-ads").digest("hex"), columnSchema: {}, status: "IMPORTED", importedAt } });
  for (const [index, target, sales, net, qty, ad] of [[1, product, "2200", "2091", "2", "100"], [2, incomplete, "3300", "3300", "1", "700"]]) {
    await ownerPrisma.coupangSaleLine.create({ data: { uploadBatchId: saleBatch.id, rowNumber: index, sourceRowHash: createHash("sha256").update(`sale-${index}`).digest("hex"),
      saleLineKey: `sale-${index}`, saleDate: at, productName: target.displayName, optionName: "", saleMethod: "판매자배송",
      salesKrw: sales, netSalesKrw: net, cancelAmountKrw: index === 1 ? "109" : "0", salesQuantity: qty, orderCount: Number(qty), coupangProductId: target.id } });
    await ownerPrisma.coupangAdMetric.create({ data: { uploadBatchId: adBatch.id, rowNumber: index, sourceRowHash: createHash("sha256").update(`ad-${index}`).digest("hex"),
      adMetricKey: `ad-${index}`, metricDate: at, adExecutionProductName: target.displayName, conversionProductName: target.displayName,
      spendProductId: target.id, conversionProductId: target.id, adSpendKrw: ad, totalConversionSales1dKrw: "999999" } });
  }
  await ownerPrisma.coupangManualPurchase.create({ data: { purchaseDate: at, coupangProductId: product.id, productDisplayName: product.displayName,
    quantity: 1, salesAmountKrw: "1100", baseSalePriceKrw: "1100", productCostKrw: "0", vendorFeePerUnitKrw: "15", vendorFeeTotalKrw: "15",
    coupangSalesFeeKrw: "0", salesFeeRateApplied: "0", shippingCostKrw: "0", totalCostKrw: "15" } });

  const management = new UnifiedManagementRepository(prisma), repository = new UnifiedAggregationRepository(prisma);
  const ownerNative = await readCoupangNativeDailyResults(ownerPrisma, date);
  const workerNative = await management.read(tx => readCoupangNativeDailyResults(tx, date));
  assert.deepEqual(workerNative, ownerNative);
  assert.equal(workerNative[0].revenue.complete, "5500"); assert.equal(workerNative[0].adSpend.complete, "800");
  assert.equal(workerNative[0].netProfit.complete, null);
  assert.ok(workerNative[0].netProfit.known.split(".")[1].length > 6, "fixture must exercise exact native sub-micro-won precision");
  await assert.rejects(prisma.$queryRawUnsafe("SELECT raw_row FROM meta_ads.coupang_sale_lines"), /permission denied/);
  await assert.rejects(prisma.$executeRawUnsafe("UPDATE meta_ads.coupang_sale_lines SET sales_krw=0"), /permission denied/);
  await assert.rejects(readerPrisma.$queryRawUnsafe("SELECT sales_krw FROM meta_ads.coupang_sale_lines"), /permission denied/);
  evidence.checks.push("real worker RR source read equals owner native calculator, including >6-digit native profit and partial known subtotal; raw JSON/source DML/report-role source reads denied");

  const publish = async idempotencyKey => {
    const queued = await repository.enqueue([{ platform: "COUPANG", scopeKey, date }], null, "synthetic native final fixture", idempotencyKey);
    const claim = await repository.claim(queued.jobs[0].jobId); assert.ok(claim);
    const config = await management.snapshot(), request = aggregationAdapterRequest(claim, config.versions);
    const batch = completeSourceCoverage(claim, await management.read(tx => readCoupangDay(tx, management, request)));
    assertSourceExecutionSucceeded(batch);
    const facts = prepareReportBatch(request, batch);
    const nativeFact = facts.find(row => row.component === "NATIVE_RESULT"); assert.ok(nativeFact);
    const corrupt = facts.map(row => row === nativeFact ? { ...row, nativeResult: { ...row.nativeResult, netProfit: { known: "999", complete: "999" } } } : row);
    await assert.rejects(repository.stageAndPublish(claim, request, batch, corrupt), /NATIVE_RESULT_COPY_MISMATCH/);
    assert.equal(await prisma.unifiedDailyFact.count({ where: { runId: claim.runId } }), 0);
    await repository.stageAndPublish(claim, request, batch, facts);
    const stored = await prisma.unifiedDailyFact.findMany({ where: { runId: claim.runId, component: "NATIVE_RESULT" }, orderBy: { factKey: "asc" } });
    const byKey = rows => [...rows].sort((a, b) => a.productKey.localeCompare(b.productKey));
    assert.deepEqual(byKey(stored.map(row => row.payload.nativeResult)), byKey(batch.nativeResults));
    return { claim, batch, stored };
  };
  const first = await publish("native-final-first");
  const oldSnapshot = (await db.query("SELECT to_jsonb(f) value FROM unified_daily_facts f WHERE run_id=$1 ORDER BY fact_key", [first.claim.runId])).rows;
  await ownerPrisma.coupangCostRule.update({ where: { id: cost.id }, data: { productCostKrw: "101" } });
  const second = await publish("native-final-second");
  assert.notEqual(first.batch.sourceFingerprint, second.batch.sourceFingerprint);
  assert.equal(new ExactDecimal(first.batch.nativeResults[0].netProfit.known).minus(second.batch.nativeResults[0].netProfit.known).toFixed(), "1");
  const pointer = await prisma.unifiedSourcePublication.findFirstOrThrow({ where: { scopeKey } });
  assert.equal(pointer.runId, second.claim.runId); assert.equal(pointer.revision, 2);
  evidence.checks.push("real repository verifies native JSON copy before insert, preserves exact decimal strings in JSONB, publishes corrected cost revision2 atomically, leaves original facts immutable");

  const report = new UnifiedReportRepository(new UnifiedManagementRepository(readerPrisma));
  const query = parseReportQuery({ from: date, to: date, compareFrom: date, compareTo: date, platforms: ["COUPANG"], scopeKeys: [scopeKey] });
  const snapshot = await report.snapshot(query);
  const summary = summarizeNativeResults(snapshot.facts, snapshot.coverage, { platforms: ["COUPANG"] });
  const storedSummary = second.batch.nativeResults.find(row => row.kind === "SUMMARY");
  assert.equal(summary.knownTotals.revenue, "5500.000000"); assert.equal(summary.knownTotals.adSpend, "800.000000");
  assert.equal(summary.completeTotals.estimatedProfit, null);
  assert.equal(summary.knownTotals.estimatedProfit, quantizeMoney(new ExactDecimal(storedSummary.netProfit.known)));
  assert.equal(summary.byMarketplace[0].display.estimatedProfit.state, "PARTIAL");
  const productSummary = summarizeNativeResults(snapshot.facts, snapshot.coverage, { platforms: ["COUPANG"], productName: product.displayName });
  assert.equal(productSummary.completeTotals.revenue, "2200.000000");
  assert.equal(productSummary.completeTotals.estimatedProfit, summary.knownTotals.estimatedProfit);
  const sourceCountBefore = await ownerPrisma.coupangSaleLine.count();
  // A report connection with no source rights must continue serving only the published frame.
  await report.snapshot(query);
  assert.equal(await ownerPrisma.coupangSaleLine.count(), sourceCountBefore);
  evidence.checks.push("actual report-only role loads the published snapshot with no source grants; pure projection preserves gross5500/ad800/partial native profit, product complete margin and no double ad subtraction");

  const before = (await db.query("SELECT to_jsonb(f) value FROM unified_daily_facts f WHERE run_id=$1 ORDER BY fact_key", [second.claim.runId])).rows;
  await assert.rejects(db.query("UPDATE unified_daily_facts SET amount_krw=999 WHERE run_id=$1", [second.claim.runId]), error => error.code === "23514");
  await assert.rejects(db.query("DELETE FROM unified_daily_facts WHERE run_id=$1", [second.claim.runId]), error => error.code === "23514");
  await assert.rejects(db.query("INSERT INTO unified_daily_facts(id,run_id,component,fact_key,attribution,payload) VALUES($1,$2,'NATIVE_RESULT','late','DIRECT','{}')", [randomUUID(), second.claim.runId]), error => error.code === "23514");
  await assert.rejects(db.query("UPDATE unified_aggregation_runs SET status='FAILED' WHERE id=$1", [second.claim.runId]), error => error.code === "23514");
  await assert.rejects(db.query("DELETE FROM unified_aggregation_runs WHERE id=$1", [second.claim.runId]), error => error.code === "23514");
  assert.deepEqual((await db.query("SELECT to_jsonb(f) value FROM unified_daily_facts f WHERE run_id=$1 ORDER BY fact_key", [first.claim.runId])).rows, oldSnapshot);
  assert.deepEqual((await db.query("SELECT to_jsonb(f) value FROM unified_daily_facts f WHERE run_id=$1 ORDER BY fact_key", [second.claim.runId])).rows, before);

  // Deliberately deny one native-only column: worker must retain the old publication, not replace it with nulls.
  await db.query(`REVOKE SELECT(promotion_price_krw) ON meta_ads.coupang_promotion_prices FROM ${worker}`);
  const queuedFailure = await repository.enqueue([{ platform: "COUPANG", scopeKey, date }], null, "synthetic denied native read", "native-final-failure");
  const originalFlag = process.env.UNIFIED_PERFORMANCE_ENABLED; process.env.UNIFIED_PERFORMANCE_ENABLED = "true";
  try {
    const adapters = { COUPANG: { platform: "COUPANG", read: request => management.read(tx => readCoupangDay(tx, management, request)) } };
    const outcome = await new UnifiedAggregationWorker(repository, management, adapters).runOne(queuedFailure.jobs[0].jobId);
    assert.equal(outcome.status, "FAILED");
  } finally { if (originalFlag === undefined) delete process.env.UNIFIED_PERFORMANCE_ENABLED; else process.env.UNIFIED_PERFORMANCE_ENABLED = originalFlag; }
  assert.equal((await prisma.unifiedSourcePublication.findFirstOrThrow({ where: { scopeKey } })).runId, second.claim.runId);
  assert.equal(await prisma.unifiedDailyFact.count({ where: { runId: queuedFailure.jobs[0].jobId } }), 0);
  assert.deepEqual((await prisma.unifiedAggregationRun.findUniqueOrThrow({ where: { id: queuedFailure.jobs[0].jobId } })).issues, ["SOURCE_EXECUTION_FAILED"]);
  const stale = await report.snapshot(query);
  assert.equal(summarizeNativeResults(stale.facts, stale.coverage, { platforms: ["COUPANG"] }).knownTotals.estimatedProfit, summary.knownTotals.estimatedProfit);
  evidence.checks.push("real immutable triggers reject published fact insert/update/delete and run update/delete; actual denied native SELECT fails rebuild with zero staged facts and preserves revision2 and its displayed values");

  await prisma.$executeRawUnsafe("INSERT INTO meta_ads.unified_reconciliation_checks(platform,scope_key,business_date,last_checked_at,last_outcome) VALUES('COUPANG','fixture',DATE '2026-11-01',now(),'UNCHANGED')");
  await prisma.$executeRawUnsafe("UPDATE meta_ads.unified_reconciliation_checks SET last_outcome='FAILED' WHERE scope_key='fixture'");
  assert.equal((await prisma.$queryRawUnsafe("SELECT last_outcome FROM meta_ads.unified_reconciliation_checks WHERE scope_key='fixture'"))[0].last_outcome, "FAILED");
  await assert.rejects(prisma.$executeRawUnsafe("DELETE FROM meta_ads.unified_reconciliation_checks"), /permission denied/);
  await assert.rejects(readerPrisma.$queryRawUnsafe("SELECT * FROM meta_ads.unified_reconciliation_checks"), /permission denied/);
  for (const [platform, scope, outcome] of [["INVALID", "x", "UNCHANGED"], ["COUPANG", " ", "UNCHANGED"], ["COUPANG", "x", "INVALID"]])
    await assert.rejects(db.query("INSERT INTO unified_reconciliation_checks(platform,scope_key,business_date,last_checked_at,last_outcome) VALUES($1,$2,DATE '2026-11-01',now(),$3)", [platform, scope, outcome]), error => error.code === "23514");
  for (const table of ["unified_daily_facts", "unified_reconciliation_checks", ...sourceTables]) {
    const flags = (await db.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass", [`meta_ads.${table}`])).rows[0];
    assert.equal(flags.relrowsecurity, true); assert.equal(flags.relforcerowsecurity, true);
  }
  evidence.checks.push("new reconciliation migration checksum and constraints verified; real worker SELECT/INSERT/UPDATE allowed and DELETE denied; report role denied; ledger/scheduler/source FORCE RLS retained");
  evidence.status = "PASS";
} catch (error) { evidence.status = "FAIL"; evidence.error = error.message; evidence.syntheticDetail = error.detail ?? error.stack ?? null; process.exitCode = 1; }
finally {
  for (const client of [prisma, ownerPrisma, readerPrisma]) if (client) await client.$disconnect();
  if (db) await db.end().catch(() => {});
  if (started) { const stopped = spawnSync(resolve(bin, "pg_ctl.exe"), ["-D", data, "-m", "fast", "-w", "stop"], { windowsHide: true, encoding: "utf8", timeout: 30000 });
    evidence.stopExitCode = stopped.status; if (stopped.status !== 0) { evidence.status = "FAIL"; process.exitCode = 1; } }
  evidence.finishedAt = new Date().toISOString(); writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
}

