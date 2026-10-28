import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import { UnifiedAggregationRepository } from "../apps/api/src/unified-performance/aggregation.repository";
import { completeSourceCoverage } from "../apps/api/src/unified-performance/aggregation.worker";
import { prepareReportBatch } from "../apps/api/src/unified-performance/domain/report-calculation";
import { normalizeAdDay } from "../apps/api/src/unified-performance/adapters/ad-source";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { UnifiedReportRepository } from "../apps/api/src/unified-performance/report.repository";
import { UnifiedReportService } from "../apps/api/src/unified-performance/report.service";
import { CONTRACT_VERSION, type AdapterRequest } from "../apps/api/src/unified-performance/types";
import type { AdapterBatch, SaleFact } from "../apps/api/src/unified-performance/types";
import { resolveProductName } from "../apps/api/src/unified-performance/domain/product-name-resolver";
import { missingCoverage } from "../apps/api/src/unified-performance/report.repository";

const ownerUrl = "postgresql://unified_fixture_owner@127.0.0.1:55451/unified_stage06?schema=meta_ads";
const writerUrl = "postgresql://unified_report_writer@127.0.0.1:55451/unified_stage06?schema=meta_ads";
const apiUrl = "postgresql://unified_report_api@127.0.0.1:55451/unified_stage06?schema=meta_ads";
const scope = "11111111-1111-4111-8111-111111111111", date = "2026-10-26", actor = randomUUID();

test("stage06 actual writer/API roles enforce atomic immutable publication, idempotency and recovery", { skip: !process.env.UNIFIED_STAGE06_WRITER_URL }, async () => {
  assert.equal(process.env.UNIFIED_STAGE06_FIXTURE_URL, ownerUrl);
  assert.equal(process.env.UNIFIED_STAGE06_WRITER_URL, writerUrl);
  assert.equal(process.env.UNIFIED_STAGE06_API_URL, apiUrl);
  const owner = new PrismaClient({ datasourceUrl: ownerUrl }), writer = new PrismaClient({ datasourceUrl: writerUrl }), api = new PrismaClient({ datasourceUrl: apiUrl });
  const repository = new UnifiedAggregationRepository(writer as unknown as PrismaService);
  const apiQueue = new UnifiedAggregationRepository(api as unknown as PrismaService);
  const reports = new UnifiedReportService(new UnifiedReportRepository(new UnifiedManagementRepository(api as unknown as PrismaService)), apiQueue);
  const reportActor = { id: actor, permissions: ["data.read" as const] };
  const reportQuery = { from: date, to: date, compareFrom: date, compareTo: date, platforms: ["META"], scopeKeys: [scope] };
  try {
    for (const [client, user] of [[owner, "unified_fixture_owner"], [writer, "unified_report_writer"], [api, "unified_report_api"]] as const) {
      const [identity] = await client.$queryRaw<Array<{ db: string; usr: string; host: string }>>`SELECT current_database() db,current_user usr,inet_server_addr()::text host`;
      assert.equal(identity.db, "unified_stage06"); assert.equal(identity.usr, user); assert.match(identity.host, /^127\.0\.0\.1/);
    }
    for (const client of [writer, api]) {
      const [role] = await client.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; owns: bigint }>>`SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,(SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
      assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false); assert.equal(role.rolcreatedb, false); assert.equal(role.rolcreaterole, false); assert.equal(role.owns, 0n);
      await assert.rejects(client.$queryRaw`SELECT * FROM public.stage06_orders`, /permission denied/);
      await assert.rejects(client.$queryRaw`SELECT * FROM public.stage06_credentials`, /permission denied/);
      await assert.rejects(client.$executeRaw`INSERT INTO public.stage06_orders VALUES ('forbidden','{}')`, /permission denied/);
      await assert.rejects(client.$executeRaw`UPDATE public.stage06_orders SET payload='{}'`, /permission denied/);
      await assert.rejects(client.$executeRaw`DELETE FROM public.stage06_orders`, /permission denied/);
    }
    await assert.rejects(api.unifiedAggregationRun.create({ data: { sourceSystem: "META", platform: "META", scopeKey: scope,
      businessDate: new Date(date), contractVersion: CONTRACT_VERSION, versions: {}, readSnapshotId: "denied", sourceWatermarks: {}, controlTotals: [], issues: [] } }), /row-level security|permission denied/);
    await owner.sourceConnection.create({ data: { id: scope, provider: "META", externalAccountId: "private-account-fixture", displayName: "표본 광고계정", currencyCode: "USD", timeZone: "Asia/Seoul" } });
    const product = await owner.unifiedProduct.create({ data: { canonicalName: "보안표본", normalizedName: "보안표본" } });

    const partition = { platform: "META" as const, scopeKey: scope, date };
    const enqueue = (key: string, reason = "independent stage06 fixture") => repository.enqueue([partition], actor, reason, key);
    const firstJobs = await enqueue("first-key"), repeatedJobs = await enqueue("first-key");
    assert.equal(firstJobs.jobs.length, 1); assert.equal(repeatedJobs.jobs[0].jobId, firstJobs.jobs[0].jobId);
    await assert.rejects(enqueue("first-key", "changed payload with same key"));
    const runId = firstJobs.jobs[0].jobId;
    const race = await Promise.all([repository.claim(runId), repository.claim(runId)]);
    assert.equal(race.filter(Boolean).length, 1);
    const claim = race.find(Boolean)!;
    assert.equal(claim.previousRunId, null);
    const request = (id: string): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: id, readSnapshotId: `fixture:${id}`,
      from: date, to: date, scopeKeys: [scope], platforms: ["META"], scopePolicyVersion: "scope-v1", nameRuleVersion: "name-v1",
      saleUnitRuleVersion: "sale-v1", allocationRuleVersion: "allocation-v1", calculationVersion: "unified-report-v1", fxVersion: "KRW",
      sourcePolicySnapshot: { participationOverrides: { 보안표본: ["AD_SPEND"] } }, sourceWatermarks: {}, cursor: null, limit: 100 });
    const batch = (id: string, amount: string | null) => normalizeAdDay(request(id), {
      platform: "META", date, scopeKey: scope, currency: "USD", timeZone: "Asia/Seoul", selectedSource: "API", complete: true,
      sourceIssues: [], storedCoverage: null, excludedRows: 0, fx: { rate: "1", sourceDate: date, provider: "FIXTURE", fallbackType: "EXACT" },
      rows: amount === null ? [] : [{ id: `source-row:${id}`, entityKey: "same-ad", originalName: "보안표본", source: "API", sourceVersion: "fixture-v1",
        runOrUploadId: "private-source-run", observedAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", amount, conversionRevenue: "999999" }],
      configuration: { products: [{ canonicalName: "보안표본", active: true }], nameRules: [] }
    });
    const publish = async (selectedClaim: NonNullable<Awaited<ReturnType<typeof repository.claim>>>, amount: string | null) => {
      const input = batch(selectedClaim.runId, amount);
      await repository.stageAndPublish(selectedClaim, request(selectedClaim.runId), input, prepareReportBatch(request(selectedClaim.runId), input, []));
    };
    await publish(claim, "100");
    const pointer = () => api.unifiedSourcePublication.findUniqueOrThrow({ where: { sourceSystem_platform_scopeKey_businessDate: {
      sourceSystem: "META", platform: "META", scopeKey: scope, businessDate: new Date(date) } } });
    assert.equal((await pointer()).runId, runId);
    const firstFacts = await api.unifiedDailyFact.findMany({ where: { runId } });
    assert.equal(firstFacts.length, 1); assert.equal(firstFacts[0].amountKrw?.toFixed(), "100");
    const publishedVersion = (await api.unifiedAggregationRun.findUniqueOrThrow({ where: { id: runId } })).versions as { participationOverrides?: unknown };
    assert.deepEqual(publishedVersion.participationOverrides, { 보안표본: ["AD_SPEND"] });
    const serialized = JSON.stringify(firstFacts[0].payload);
    assert(!serialized.includes("sourceRecordKey")); assert(!serialized.includes("originalName")); assert(!serialized.includes("private-source-run"));
    const firstReport = await reports.read("summary", reportQuery, reportActor);
    assert.equal(firstReport.knownTotals.adSpend, "100.000000"); assert.equal(firstReport.knownTotals.revenue, null);
    assert.equal(firstReport.completeTotals.adSpend, "100.000000");
    // Editing current policy must not change an immutable published result until the requested rebuild publishes.
    await owner.unifiedRule.create({ data: { kind: "SCOPE_POLICY", productId: product.id, platform: "CAFE24", identityKey: "a".repeat(64),
      validFrom: new Date("2026-01-01"), payload: { components: ["SALE", "DIRECT_COST"] } } });
    const pinnedProductReport = await reports.read("summary", { ...reportQuery, productName: "보안표본" }, reportActor);
    assert.equal(pinnedProductReport.knownTotals.adSpend, "100.000000");
    const publicReport = JSON.stringify(firstReport);
    for (const forbidden of ["private-account-fixture", "sourceRecordKey", "originalName", "private-source-run", "leaseToken", "credentialRef"])
      assert(!publicReport.includes(forbidden), forbidden);
    const options = await reports.read("options", reportQuery, reportActor);
    assert("products" in options && options.products.some(product => product.productName === "보안표본"));
    assert("scopes" in options && options.scopes.some(item => item.platform === "META" && item.scopeKey === scope));
    const series = await reports.read("timeseries", { ...reportQuery, grain: "month" }, reportActor);
    assert("items" in series); assert.equal(series.items.length, 1);
    assert.equal(series.items[0].knownTotals.adSpend, "100.000000");
    assert.equal(series.items[0].partial, true);
    const diagnostics = await reports.read("diagnostics", reportQuery, reportActor);
    assert("items" in diagnostics && diagnostics.items.length === 1);
    assert.equal(diagnostics.items[0].component, "AD_SPEND");
    await assert.rejects(reports.read("summary", reportQuery, { id: actor, permissions: [] }), /권한/);
    await assert.rejects(reports.read("summary", { ...reportQuery, scopeKeys: ["forbidden-account"] }, reportActor), /허용되지/);
    const noPlatforms = await reports.read("summary", { ...reportQuery, platforms: [], scopeKeys: [] }, reportActor);
    assert.equal(noPlatforms.knownTotals.adSpend, null); assert.equal(noPlatforms.coverage.length, 0);
    await assert.rejects(reports.rebuild({ ...reportQuery, expectedContractVersion: CONTRACT_VERSION, reason: "denied" }, reportActor), /권한/);
    try { await publish(claim, "100"); } catch { /* Rejecting an already consumed claim is also idempotent. */ }
    assert.equal(await api.unifiedDailyFact.count({ where: { runId } }), 1);
    await assert.rejects(writer.unifiedDailyFact.update({ where: { id: firstFacts[0].id }, data: { amountKrw: "999" } }), /immutable/);
    await assert.rejects(writer.unifiedDailyFact.delete({ where: { id: firstFacts[0].id } }), /immutable/);
    await assert.rejects(writer.unifiedSourceCoverage.updateMany({ where: { runId }, data: { rowsPresent: 999 } }), /immutable/);
    await assert.rejects(writer.unifiedAggregationRun.update({ where: { id: runId }, data: { status: "STAGING" } }), /immutable/);
    await assert.rejects(api.unifiedDailyFact.update({ where: { id: firstFacts[0].id }, data: { amountKrw: "0" } }), /permission denied/);

    const failedId = (await enqueue("failed-key")).jobs[0].jobId, failedClaim = (await repository.claim(failedId))!;
    assert.equal(failedClaim.previousRunId, runId); assert.equal(await repository.fail(failedClaim, "SOURCE_READ_FAILED"), true);
    assert.equal((await pointer()).runId, runId); assert.equal((await api.unifiedAggregationRun.findUniqueOrThrow({ where: { id: failedId } })).status, "FAILED");
    const staleReport = await reports.read("summary", reportQuery, reportActor);
    assert.equal(staleReport.knownTotals.adSpend, "100.000000");
    assert(staleReport.coverage.some(row => row.collectionState === "STALE" && row.issues.includes("LATEST_REBUILD_FAILED")));

    const invalidId = (await enqueue("invalid-batch-key")).jobs[0].jobId, invalidClaim = (await repository.claim(invalidId))!;
    const invalidInput = batch(invalidId, "200"); invalidInput.coverage = [];
    await assert.rejects(repository.stageAndPublish(invalidClaim, request(invalidId), invalidInput, prepareReportBatch(request(invalidId), invalidInput, [])));
    assert.equal((await pointer()).runId, runId); assert.equal(await api.unifiedDailyFact.count({ where: { runId: invalidId } }), 0);
    await repository.fail(invalidClaim, "VALIDATION_FAILED");

    const corruptedId = (await enqueue("corrupted-compact-key")).jobs[0].jobId, corruptedClaim = (await repository.claim(corruptedId))!;
    const sourceInput = batch(corruptedId, "200"), corruptedFacts = prepareReportBatch(request(corruptedId), sourceInput, []);
    corruptedFacts[0].amountKrw = "999";
    await assert.rejects(repository.stageAndPublish(corruptedClaim, request(corruptedId), sourceInput, corruptedFacts), /CONSERVATION|CONSERV/);
    assert.equal((await pointer()).runId, runId); assert.equal(await api.unifiedDailyFact.count({ where: { runId: corruptedId } }), 0);
    await repository.fail(corruptedClaim, "REPORT_CONSERVATION_FAILED");

    const leaseId = (await enqueue("expired-lease-key")).jobs[0].jobId, oldClaim = (await repository.claim(leaseId))!;
    await owner.unifiedAggregationRun.update({ where: { id: leaseId }, data: { leaseExpiresAt: new Date("2000-01-01T00:00:00Z") } });
    const recovered = (await repository.claim(leaseId))!; assert(recovered); assert.notEqual(recovered.token, oldClaim.token);
    assert.equal(await repository.heartbeat(oldClaim), false);
    await assert.rejects(publish(oldClaim, "500")); assert.equal((await pointer()).runId, runId);
    await publish(recovered, "120"); assert.equal((await pointer()).runId, leaseId);

    // A reader pins a publication and facts in one read-only repeatable-read snapshot.
    const zeroId = (await enqueue("zero-correction-key")).jobs[0].jobId, zeroClaim = (await repository.claim(zeroId))!;
    await api.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const before = await tx.unifiedSourcePublication.findFirstOrThrow({ where: { platform: "META", scopeKey: scope } });
      assert.equal(before.runId, leaseId);
      await publish(zeroClaim, null);
      const pinned = await tx.unifiedSourcePublication.findFirstOrThrow({ where: { platform: "META", scopeKey: scope } });
      assert.equal(pinned.runId, leaseId);
      assert.equal((await tx.unifiedDailyFact.findFirstOrThrow({ where: { runId: pinned.runId } })).amountKrw?.toFixed(), "120");
      const [settings] = await tx.$queryRaw<Array<{ ro: string; isolation: string }>>`SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation`;
      assert.equal(settings.ro, "on"); assert.equal(settings.isolation, "repeatable read");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
    assert.equal((await pointer()).runId, zeroId);
    assert.equal(await api.unifiedDailyFact.count({ where: { runId: zeroId } }), 0);
    assert.equal((await api.unifiedSourceCoverage.findFirstOrThrow({ where: { runId: zeroId } })).zeroConfirmed, true);
    assert.equal(await api.unifiedDailyFact.count({ where: { runId } }), 1);
    assert.equal((await pointer()).revision, 3);
    const jobs = await repository.readJobs([runId, failedId, zeroId]);
    const publicJobs = JSON.stringify(jobs);
    assert(!publicJobs.includes("leaseToken")); assert(!publicJobs.includes("readSnapshotId")); assert(!publicJobs.includes("sourceWatermarks"));
    const operator = { id: actor, permissions: ["operations.run" as const] };
    const queued = await reports.rebuild({ from: "2026-10-25", to: "2026-10-25", platforms: ["META"], scopeKeys: [scope],
      expectedContractVersion: CONTRACT_VERSION, reason: "API queue role integration", idempotencyKey: "actual-api-submit" }, operator);
    assert.equal(queued.status, "QUEUED"); assert.equal(queued.execution, "ASYNC_WORKER"); assert.equal(queued.jobs.length, 1);
    assert.equal(queued.jobs[0].status, "STAGING");
    assert.equal((await reports.job(queued.jobs[0].jobId, operator)).status, "STAGING");
    await assert.rejects(api.unifiedAggregationRun.update({ where: { id: queued.jobs[0].jobId }, data: { attempts: 999 } }), /permission denied/);
    await assert.rejects(api.unifiedSourcePublication.updateMany({ data: { revision: 999 } }), /permission denied/);
    await assert.rejects(api.unifiedAggregationRun.create({ data: { sourceSystem: "META", platform: "META", scopeKey: scope,
      businessDate: new Date(date), status: "READY", completedAt: new Date(), requestedBy: actor, reason: "cannot publish via API",
      contractVersion: CONTRACT_VERSION, versions: {}, readSnapshotId: "denied-ready", sourceWatermarks: {}, controlTotals: [], issues: [], checkpoint: { phase: "QUEUED" } } }), /row-level security/);
    const readyId = (await repository.enqueue([{ ...partition, date: "2026-10-24" }], actor, "READY immutability fixture", "ready-fixture")).jobs[0].jobId;
    await writer.unifiedAggregationRun.update({ where: { id: readyId }, data: { status: "READY", completedAt: new Date() } });
    await assert.rejects(writer.unifiedAggregationRun.update({ where: { id: readyId }, data: { status: "STAGING" } }), /ready unified run can only publish/);
    await assert.rejects(writer.unifiedDailyFact.create({ data: { runId: readyId, component: "AD_SPEND", factKey: "cannot-add-ready-fact", amountKrw: "1", attribution: "DIRECT", payload: {} } }), /immutable/);
    await assert.rejects(writer.unifiedAggregationRun.delete({ where: { id: readyId } }), /immutable/);
  } finally { await Promise.all([owner.$disconnect(), writer.$disconnect(), api.$disconnect()]); }
});

test("stage06 full-day replacement preserves cost/name history, lineage and deletion without duplicating totals", { skip: !process.env.UNIFIED_STAGE06_WRITER_URL }, async () => {
  assert.equal(process.env.UNIFIED_STAGE06_FIXTURE_URL, ownerUrl); assert.equal(process.env.UNIFIED_STAGE06_WRITER_URL, writerUrl); assert.equal(process.env.UNIFIED_STAGE06_API_URL, apiUrl);
  const owner = new PrismaClient({ datasourceUrl: ownerUrl }), writer = new PrismaClient({ datasourceUrl: writerUrl }), api = new PrismaClient({ datasourceUrl: apiUrl });
  const repository = new UnifiedAggregationRepository(writer as unknown as PrismaService);
  const reportRepository = new UnifiedReportRepository(new UnifiedManagementRepository(api as unknown as PrismaService));
  const reports = new UnifiedReportService(reportRepository, new UnifiedAggregationRepository(api as unknown as PrismaService));
  const cafeScope = "22222222-2222-4222-8222-222222222222", date = "2026-10-23";
  const productA = "보안표본", productB = "재분류표본", originalName = "과거 원천상품 이름";
  const actorRead = { id: actor, permissions: ["data.read" as const] };
  const lookup = { from: date, to: date, compareFrom: date, compareTo: date, platforms: ["CAFE24"], scopeKeys: [cafeScope] };
  const observedAt = "2026-10-28T00:00:00Z", oldRunIds: string[] = [];
  try {
    await owner.sourceConnection.create({ data: { id: cafeScope, provider: "CAFE24", externalAccountId: "private-cafe-account", displayName: "표본 판매계정", currencyCode: "KRW", timeZone: "Asia/Seoul" } });
    await owner.unifiedProduct.create({ data: { canonicalName: productB, normalizedName: productB } });
    for (const [revision, revenue, cost, target] of [[1, "200", "60", productA], [2, "200", "70", productA], [3, "200", "70", productB], [4, "250", "70", productB], [5, null, null, productB]] as const) {
      const jobId = (await repository.enqueue([{ platform: "CAFE24", scopeKey: cafeScope, date }], actor, `fixture source/cost/name revision ${revision}`, `cafe-revision-${revision}`)).jobs[0].jobId;
      const claim = (await repository.claim(jobId))!; assert(claim);
      const request: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: jobId, readSnapshotId: `cafe:${revision}`, from: date, to: date,
        scopeKeys: [cafeScope], platforms: ["CAFE24"], scopePolicyVersion: "scope-cafe-v1", nameRuleVersion: revision >= 3 ? "names-v2" : "names-v1",
        saleUnitRuleVersion: revision >= 2 ? "cost-v2" : "cost-v1", allocationRuleVersion: "unallocated-v1", calculationVersion: "unified-report-v1", fxVersion: "KRW",
        sourcePolicySnapshot: { participationOverrides: { [productA]: ["SALE", "DIRECT_COST"], [productB]: ["SALE", "DIRECT_COST"] } }, sourceWatermarks: {}, cursor: null, limit: 100 };
      const name = resolveProductName({ originalName, originalOption: "단품", saleUnitName: "단품", nameField: "product_name", platform: "CAFE24", scopeKey: cafeScope, businessDate: date },
        [{ canonicalName: productA }, { canonicalName: productB }], [{ id: "cafe-name-rule", canonicalProductName: target, matchType: "EXACT", terms: [originalName],
          platform: "CAFE24", scopeKey: cafeScope, validFrom: "2026-01-01", saleUnitName: "단품" }], request.nameRuleVersion);
      assert.equal(name.canonicalProductName, target);
      const profit = revenue === null ? null : new Prisma.Decimal(revenue).minus(cost!).toFixed();
      const sale: SaleFact | null = revenue === null ? null : { ref: { sourceSystem: "CAFE24_ORDER", platform: "CAFE24", schema: "meta_ads", table: "cafe24_orders",
          scopeKey: cafeScope, recordKind: "ORDER_LINE", sourceRecordKey: "private-same-order-line", selectedSource: "API", sourceVersion: `source-v${revision}`,
          uploadOrRunId: "private-source-job", payloadHash: "a".repeat(64), providerUpdatedAt: observedAt, observedAt, businessDate: date, dateBasis: "ORDER_DATE", sourceTimeZone: "Asia/Seoul" },
        name, productName: target, marketplace: "CAFE24", saleUnitName: "단품", optionName: "단품", orderedQuantity: "1", calculationQuantity: "1", unitsPerSaleUnit: "1", physicalQuantity: "1", quantityBasis: "SALE_UNIT_TOTAL",
        operatingRevenue: revenue, revenueBasis: "REGISTERED_SALE_PRICE", collectedPaymentAmount: null, paymentGrain: "ORDER", paymentAllocationStatus: "UNALLOCATED",
        discountTreatment: "NONE", refundTreatment: "NONE", productCost: cost, platformFee: "0", directShippingCost: "0", returnCost: "0", otherDirectCost: "0", vatExpense: "0", discountNotYetIncluded: "0", manualVendorFee: "0",
        costRuleRef: "cafe-cost-rule", costEffectiveFrom: "2026-01-01", costEffectiveTo: null, costBasisVersion: request.saleUnitRuleVersion, taxPolicyVersion: "fixture-zero-vat", feeBasis: "FIXTURE", feePresenceMask: "0", shippingBasis: "DIRECT", dateBasis: "ORDER_DATE",
        costComponents: [{ kind: "PRODUCT_COST", sourceExpenseKey: "private-same-order-line:cost", amount: cost, includedInRevenue: false, applied: true }], profitBeforeAds: profit,
        quality: { isEstimate: false, confidence: "SOURCE_REPORTED", issues: [] } };
      const count = sale ? 1 : 0;
      const raw: AdapterBatch = { sales: sale ? [sale] : [], adSpends: [], commonExpenses: [], sourceFingerprint: `source-cost-name-revision-${revision}`, nextCursor: null,
        coverage: missingCoverage({ platform: "CAFE24", scopeKey: cafeScope, label: "판매표본" }, date).filter(c => c.component !== "COMMON_EXPENSE").map(c => ({ ...c,
          collectionState: "COMPLETE", rowsPresent: count, zeroConfirmed: count === 0, mappedRows: count, selectedSource: "API", sourceVersion: `source-v${revision}`,
          sourceAsOf: observedAt, collectedAt: observedAt, calculatedAt: observedAt, lastSuccessAt: observedAt, nameRuleVersion: request.nameRuleVersion, costRuleVersion: request.saleUnitRuleVersion,
          quality: { isEstimate: false, confidence: "SOURCE_REPORTED", issues: [] } })),
        sourceControlTotals: [{ sourceSystem: "CAFE24_ORDER", platform: "CAFE24", scopeKey: cafeScope, date, measure: "OPERATING_REVENUE", currency: "KRW", selectedRows: count,
          selectedAmount: revenue ?? "0", assignedAmount: revenue ?? "0", unmatchedAmount: "0", unallocatedAmount: "0", excludedNonSaleAmount: "0", excludedByPolicyRows: 0, roundingAdjustment: "0", difference: "0" }] };
      const batch = completeSourceCoverage(claim, raw);
      await repository.stageAndPublish(claim, request, batch, prepareReportBatch(request, batch, []));
      const result = await reports.read("summary", lookup, actorRead);
      assert.equal(result.knownTotals.revenue, `${revenue ?? "0"}.000000`); assert.equal(result.completeTotals.revenue, `${revenue ?? "0"}.000000`);
      assert.equal(result.knownTotals.profitBeforeAds, `${profit ?? "0"}.000000`);
      const pointer = await api.unifiedSourcePublication.findUniqueOrThrow({ where: { sourceSystem_platform_scopeKey_businessDate: { sourceSystem: "CAFE24", platform: "CAFE24", scopeKey: cafeScope, businessDate: new Date(date) } } });
      assert.equal(pointer.runId, jobId); assert.equal(pointer.revision, revision);
      const audit = await api.unifiedProductMatchResult.findMany({ where: { runId: jobId } });
      assert.equal(audit.length, count);
      if (sale) {
        assert.match(audit[0].sourceKey, /^[a-f0-9]{64}$/); assert.equal(audit[0].productName, target); assert.equal(audit[0].ruleVersion, request.nameRuleVersion);
        const privateAudit = JSON.stringify(audit[0].evidence);
        assert(!privateAudit.includes(originalName)); assert(!privateAudit.includes("private-same-order-line")); assert(!privateAudit.includes("private-source-job"));
        assert(!privateAudit.includes("originalName")); assert(!privateAudit.includes("sourceRecordKey"));
        await assert.rejects(writer.unifiedProductMatchResult.update({ where: { id: audit[0].id }, data: { matchStatus: "UNMATCHED" } }), /immutable/);
      }
      if (revision === 3) {
        const oldName = await reports.read("summary", { ...lookup, productName: productA }, actorRead), newName = await reports.read("summary", { ...lookup, productName: productB }, actorRead);
        assert.equal(oldName.knownTotals.revenue, "0.000000"); assert.equal(newName.knownTotals.revenue, "200.000000");
      }
      for (const previousId of oldRunIds) {
        const previousRun = await api.unifiedAggregationRun.findUniqueOrThrow({ where: { id: previousId } }); assert.equal(previousRun.status, "PUBLISHED");
        const oldFact = await api.unifiedDailyFact.findFirstOrThrow({ where: { runId: previousId } });
        assert.equal(oldFact.amountKrw?.toFixed(), previousId === oldRunIds[3] ? "250" : "200");
      }
      oldRunIds.push(jobId);
    }
  } finally { await Promise.all([owner.$disconnect(), writer.$disconnect(), api.$disconnect()]); }
});
