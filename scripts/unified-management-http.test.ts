import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Module, ValidationPipe } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { PrismaClient } from "@prisma/client";
import type { AddressInfo } from "node:net";
import type { Request, Response, NextFunction } from "express";
import { PrismaService } from "../apps/api/src/common/prisma.service";
import { ApiExceptionFilter } from "../apps/api/src/common/api-exception.filter";
import { DangerousJsonKeysPipe } from "../apps/api/src/validation/dangerous-json-keys.pipe";
import { PermissionGuard } from "../apps/api/src/auth/permission.guard";
import type { AuthenticatedRequest } from "../apps/api/src/auth/auth.types";
import type { Permission } from "../apps/api/src/auth/role-permissions";
import { UnifiedProductsController, UnifiedRulesController } from "../apps/api/src/unified-performance/management.controller";
import { UnifiedManagementService } from "../apps/api/src/unified-performance/management.service";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { UnifiedReportController } from "../apps/api/src/unified-performance/report.controller";
import { UnifiedReportService } from "../apps/api/src/unified-performance/report.service";
import { UnifiedReportRepository } from "../apps/api/src/unified-performance/report.repository";
import { UnifiedAggregationRepository } from "../apps/api/src/unified-performance/aggregation.repository";
import { ConfigurationQuery, ProductInput, ProductPreviewInput, RuleInput, RulePreviewInput, UnifiedIdParam, DeleteConfigurationInput } from "../apps/api/src/unified-performance/management.dto";
import { ReportQueryDto, RebuildInputDto } from "../apps/api/src/unified-performance/report.dto";
import { normalizeAdDay } from "../apps/api/src/unified-performance/adapters/ad-source";
import { prepareReportBatch } from "../apps/api/src/unified-performance/domain/report-calculation";
import { CONTRACT_VERSION, type AdapterRequest } from "../apps/api/src/unified-performance/types";

const allowedUrl = (role: string) => `postgresql://unified_stage07_${role}@127.0.0.1:55452/unified_stage07?schema=meta_ads`;
const businessDate = "2026-10-26", actorId = "77777777-7777-4777-8777-777777777777";
const metaScope = "77777777-7777-4777-8777-777777777771", cafeScope = "77777777-7777-4777-8777-777777777772";
const productName = "검토표본 제품", alias = "검토표본 별칭";
const principalPermissions: Record<string, Permission[]> = {
  ADMIN: ["data.read", "products.manage", "mappings.manage", "operations.run"], VIEWER: ["data.read"], OPS: ["data.read", "operations.run"], NONE: []
};

test("stage07 real HTTP management, restricted database roles, conflicts, preview, history recovery and queue publication", { skip: !process.env.UNIFIED_STAGE07_CONFIG_URL }, async t => {
  for (const [key, role] of [["OWNER", "owner"], ["CONFIG", "config"], ["VIEWER", "viewer"], ["WORKER", "worker"]])
    assert.equal(process.env[`UNIFIED_STAGE07_${key}_URL`], allowedUrl(role));
  const owner = new PrismaClient({ datasourceUrl: allowedUrl("owner") }), db = new PrismaClient({ datasourceUrl: allowedUrl("config") });
  const viewer = new PrismaClient({ datasourceUrl: allowedUrl("viewer") }), worker = new PrismaClient({ datasourceUrl: allowedUrl("worker") });
  const management = new UnifiedManagementRepository(db as unknown as PrismaService);
  const service = new UnifiedManagementService(management);
  const reports = new UnifiedReportService(new UnifiedReportRepository(management), new UnifiedAggregationRepository(db as unknown as PrismaService));
  // tsx omits the design metadata emitted by the production tsc build; restore those
  // exact constructor/route types so Nest performs the same DI and DTO validation.
  for (const controller of [UnifiedProductsController, UnifiedRulesController]) {
    Reflect.defineMetadata("design:paramtypes", [UnifiedManagementService], controller);
    for (const [method, types] of Object.entries({ list: [ConfigurationQuery], audit: [UnifiedIdParam],
      preview: [controller === UnifiedProductsController ? ProductPreviewInput : RulePreviewInput],
      create: [controller === UnifiedProductsController ? ProductInput : RuleInput, Object],
      update: [UnifiedIdParam, controller === UnifiedProductsController ? ProductInput : RuleInput, Object], remove: [UnifiedIdParam, DeleteConfigurationInput, Object] }))
      Reflect.defineMetadata("design:paramtypes", types, controller.prototype, method);
  }
  Reflect.defineMetadata("design:paramtypes", [UnifiedReportService], UnifiedReportController);
  for (const method of ["options", "summary", "timeseries", "diagnostics"]) Reflect.defineMetadata("design:paramtypes", [ReportQueryDto, Object], UnifiedReportController.prototype, method);
  Reflect.defineMetadata("design:paramtypes", [RebuildInputDto, Object], UnifiedReportController.prototype, "rebuild");
  Reflect.defineMetadata("design:paramtypes", [String, Object], UnifiedReportController.prototype, "job");
  @Module({ controllers: [UnifiedProductsController, UnifiedRulesController, UnifiedReportController], providers: [
    { provide: UnifiedManagementService, useValue: service }, { provide: UnifiedReportService, useValue: reports }
  ] }) class FixtureModule {}
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.setGlobalPrefix("api");
  // The isolated loopback fixture replaces external authentication only. Route permissions, DTOs,
  // controllers, services, transactions, PostgreSQL roles and RLS are production implementations.
  app.use((request: Request, _response: Response, next: NextFunction) => {
    const role = String(request.headers["x-fixture-role"] ?? "NONE");
    if (role !== "ANONYMOUS") (request as AuthenticatedRequest).authenticatedUser = {
      id: actorId, authUserId: actorId, email: null, name: "Synthetic stage07", role: role === "ADMIN" ? "ADMIN" : "USER",
      isActive: true, inviteStatus: "ACTIVE", authzVersion: 1, sessionId: actorId, permissions: principalPermissions[role] ?? []
    };
    next();
  });
  app.useGlobalGuards(new PermissionGuard(new Reflector()));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(new DangerousJsonKeysPipe(), new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transformOptions: { enableImplicitConversion: false }, validationError: { target: false, value: false } }));
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
  const request = async (method: string, path: string, body?: unknown, role = "ADMIN") => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-fixture-role": role }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  let productId = "", ruleId = "", input: Record<string, any>;
  try {
    await owner.appUser.create({ data: { id: actorId, name: "Synthetic stage07 actor" } });
    await owner.sourceConnection.createMany({ data: [
      { id: metaScope, provider: "META", externalAccountId: "fixture-meta", displayName: "검토 광고계정", currencyCode: "KRW", timeZone: "Asia/Seoul" },
      { id: cafeScope, provider: "CAFE24", externalAccountId: "fixture-cafe24", displayName: "검토 판매처", currencyCode: "KRW", timeZone: "Asia/Seoul" }
    ] });

    await t.test("actual config/viewer/worker identities and source/write restrictions", async () => {
      for (const [client, role] of [[db, "config"], [viewer, "viewer"], [worker, "worker"]] as const) {
        const [identity] = await client.$queryRaw<Array<{ db: string; usr: string; host: string; rolsuper: boolean; rolbypassrls: boolean; owns: bigint }>>`
          SELECT current_database() db,current_user usr,inet_server_addr()::text host,rolsuper,rolbypassrls,(SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
        assert.equal(identity.db, "unified_stage07"); assert.equal(identity.usr, `unified_stage07_${role}`); assert.match(identity.host, /^127\.0\.0\.1/);
        assert.equal(identity.rolsuper, false); assert.equal(identity.rolbypassrls, false); assert.equal(identity.owns, 0n);
        await assert.rejects(client.$queryRaw`SELECT * FROM public.stage07_source_orders`, /permission denied/);
        await assert.rejects(client.$queryRaw`SELECT * FROM public.stage07_credentials`, /permission denied/);
      }
      await assert.rejects(viewer.unifiedProduct.create({ data: { canonicalName: "금지", normalizedName: "금지" } }), /permission denied/);
      await assert.rejects(db.unifiedDailyFact.deleteMany({}), /permission denied/);
      await assert.rejects(worker.unifiedProduct.updateMany({ data: { active: false } }), /permission denied/);
      await assert.rejects(db.unifiedMappingAudit.deleteMany({}), /permission denied/);
    });

    await t.test("real permission guard denies unauthenticated/read-only writes; canonical catalog loads", async () => {
      assert.equal((await request("GET", "/unified-products", undefined, "ANONYMOUS")).status, 401);
      assert.equal((await request("GET", "/unified-products", undefined, "NONE")).status, 403);
      assert.equal((await request("POST", "/unified-products", { canonicalName: productName, reason: "등록" }, "VIEWER")).status, 403);
      const result = await request("POST", "/unified-products", { canonicalName: productName, reason: "합성 등록" });
      assert.equal(result.status, 201, JSON.stringify(result.body)); productId = result.body.product.id;
      const catalog = await request("GET", "/unified-products/configuration", undefined, "VIEWER");
      assert.equal(catalog.status, 200); assert.equal(catalog.headers.get("cache-control"), "no-store");
      assert(catalog.body.products.some((p: any) => p.id === productId)); assert(Array.isArray(catalog.body.rules));
      assert.equal(typeof catalog.body.versions.configurationVersion, "string");
      await viewer.unifiedProduct.findUniqueOrThrow({ where: { id: productId } });
    });

    await t.test("name preview is read-only, independent of external IDs, and shows ambiguous/unclassified reasons", async () => {
      input = { kind: "NAME", productId, platform: null, scopeKey: null, payload: { matchType: "EXACT", terms: [alias] }, validFrom: businessDate, validTo: null, active: true, reason: "이름 규칙 등록" };
      const sample = { originalName: alias, originalOption: "", platform: "CAFE24", scopeKey: cafeScope, nameField: "product_name", businessDate };
      const counts = await db.$transaction([db.unifiedRule.count(), db.unifiedMappingAudit.count(), db.unifiedAggregationRun.count()]);
      const preview = await request("POST", "/unified-rules/preview", { ...input, samples: [sample, { ...sample }, { ...sample, originalName: "판별 불가" }] }, "VIEWER");
      assert.equal(preview.status, 201); assert.equal(preview.body.writesPerformed, false);
      assert.equal(preview.body.samples[0].canonicalProductName, productName); assert.equal(preview.body.samples[1].canonicalProductName, productName);
      assert.equal(preview.body.samples[0].nameInputHash, preview.body.samples[1].nameInputHash);
      assert.equal(preview.body.samples[2].matchStatus, "UNMATCHED"); assert(preview.body.samples[2].reasons.length);
      assert.deepEqual(await db.$transaction([db.unifiedRule.count(), db.unifiedMappingAudit.count(), db.unifiedAggregationRun.count()]), counts);
      assert.equal((await request("POST", "/unified-rules/preview", { ...input, samples: [{ ...sample, externalProductId: "new-platform-id" }] })).status, 400);
      assert.equal((await request("POST", "/unified-rules", input, "VIEWER")).status, 403);
      const result = await request("POST", "/unified-rules", input); assert.equal(result.status, 201); ruleId = result.body.rule.id;
      assert.equal((await request("POST", "/unified-rules", input)).status, 409);
      const second = await request("POST", "/unified-products", { canonicalName: "검토표본 둘째", reason: "복수 후보 검증" });
      assert.equal(second.status, 201);
      assert.equal((await request("POST", "/unified-rules", { ...input, payload: { matchType: "CONTAINS", terms: ["세트"] } })).status, 201);
      const ambiguous = await request("POST", "/unified-rules/preview", { ...input, productId: second.body.product.id,
        payload: { matchType: "CONTAINS", terms: ["특별"] }, samples: [{ ...sample, originalName: "세트 특별" }] });
      assert.equal(ambiguous.status, 201); assert.equal(ambiguous.body.samples[0].matchStatus, "AMBIGUOUS");
      assert.equal(ambiguous.body.samples[0].candidateNames.length, 2);
    });

    await t.test("CAS blocks stale preview/save and concurrent changes; audit restores a historical rule", async () => {
      const initialCatalog = (await request("GET", "/unified-products/configuration")).body;
      const conflictPreview = await request("POST", "/unified-rules/preview", { ...input, id: ruleId, expectedVersion: 999 });
      assert.equal(conflictPreview.status, 201); assert.equal(conflictPreview.body.versionConflict, true); assert.equal(conflictPreview.body.canSave, false);
      const race = await Promise.all(["A", "B"].map(tag => request("PATCH", `/unified-rules/${ruleId}`, { ...input, expectedVersion: 1,
        expectedConfigurationVersion: initialCatalog.versions.configurationVersion, payload: { matchType: "EXACT", terms: [alias, `변경 ${tag}`] }, reason: `동시 수정 ${tag}` })));
      assert.deepEqual(race.map(row => row.status).sort(), [200, 409]);
      const current = race.find(row => row.status === 200)!.body.rule;
      assert.equal((await request("PATCH", `/unified-rules/${ruleId}`, { ...input, expectedVersion: current.version, expectedConfigurationVersion: initialCatalog.versions.configurationVersion })).status, 409);
      const history = await request("GET", `/unified-rules/${ruleId}/audit`, undefined, "VIEWER");
      assert.equal(history.status, 200); assert.equal(history.body.length, 2);
      const original = history.body.find((row: any) => row.action === "CREATE").after;
      const restored = await request("PATCH", `/unified-rules/${ruleId}`, { ...input, payload: original.payload, expectedVersion: current.version, reason: "이력 복구" });
      assert.equal(restored.status, 200); assert.equal(restored.body.rule.version, 3); assert.deepEqual(restored.body.rule.payload.terms, [alias]);
      assert.equal((await request("DELETE", `/unified-rules/${ruleId}`, { expectedVersion: 2, reason: "오래된 삭제" })).status, 409);
      const deactivated = await request("DELETE", `/unified-rules/${ruleId}`, { expectedVersion: 3, reason: "일시 종료" }); assert.equal(deactivated.status, 200);
      assert.equal((await request("PATCH", `/unified-rules/${ruleId}`, { ...input, active: true, expectedVersion: 4, reason: "종료 전 상태 복구" })).status, 200);
      const finalHistory = (await request("GET", `/unified-rules/${ruleId}/audit`)).body;
      assert.equal(finalHistory.length, 5); assert(finalHistory.some((row: any) => row.reason === "이력 복구"));
    });

    await t.test("sale unit costs preserve explicit zero/null and allocation validation rejects invalid weights", async () => {
      const unit = await request("POST", "/unified-rules", { ...input, kind: "SALE_UNIT", platform: "CAFE24", scopeKey: cafeScope,
        payload: { saleUnitName: "1+1 세트", optionExact: "선물", unitsPerSaleUnit: "2", quantityBasis: "SALE_UNIT_TOTAL", salePrice: "34900", productCost: "9000", shippingCost: "0", otherCost: null } });
      assert.equal(unit.status, 201); assert.equal(unit.body.rule.payload.shippingCost, "0"); assert.equal(unit.body.rule.payload.otherCost, null);
      const allocation = { ...input, productId: null, kind: "ALLOCATION", platform: "META", scopeKey: metaScope,
        payload: { method: "FIXED_WEIGHTS", component: "AD_SPEND", targets: [{ productName, weight: "0.8" }] } };
      assert.equal((await request("POST", "/unified-rules", allocation)).status, 400);
      assert.equal((await request("POST", "/unified-rules", { ...allocation, payload: { ...allocation.payload, targets: [{ productName, weight: "1" }] } })).status, 201);
    });

    await t.test("impact preview reads published selected scope without writing rules, allocations or jobs", async () => {
      for (const [platform, scopeKey, component, amount, day] of [["META", metaScope, "AD_SPEND", "123.45", businessDate], ["CAFE24", cafeScope, "SALE", "1000", businessDate], ["CAFE24", cafeScope, "COMMON_EXPENSE", "100", "2026-10-27"], ["CAFE24", cafeScope, "SALE", "100", "2026-10-28"]] as const) {
        const run = await owner.unifiedAggregationRun.create({ data: { sourceSystem: platform, platform, scopeKey, businessDate: new Date(day), contractVersion: CONTRACT_VERSION,
          versions: {}, readSnapshotId: "synthetic-published", sourceWatermarks: {}, controlTotals: [], issues: [] } });
        await owner.unifiedDailyFact.create({ data: { runId: run.id, component, factKey: `fixture-${platform}`, productName, amountKrw: amount, attribution: "DIRECT", payload: {
          component, factKey: `fixture-${platform}`, productName, saleUnitName: null, amountKrw: amount,
          profitBeforeAds: component === "SALE" ? "500" : null, completeProfitBeforeAds: component === "SALE" ? "500" : null,
          originalAmount: amount, currency: "KRW", quantity: "1", attribution: "DIRECT", medium: component === "AD_SPEND" ? platform : null,
          marketplace: component === "SALE" ? platform : null, commonKind: null,
          rowsCount: 1, quality: { isEstimate: false, confidence: "SOURCE_REPORTED", issues: [] }, completeAmountKrw: amount
        } } });
        if (day === "2026-10-28") await owner.unifiedDailyFact.create({ data: { runId: run.id, component: "SALE", factKey: "negative-correction", productName,
          saleUnitName: "반품 정정 세트", amountKrw: "-100", attribution: "DIRECT", payload: { component: "SALE", productName, saleUnitName: "반품 정정 세트", amountKrw: "-100", completeAmountKrw: "-100", rowsCount: 1,
            quality: { isEstimate: false, confidence: "SOURCE_REPORTED", issues: [] } } } });
        await owner.unifiedSourceCoverage.create({ data: { runId: run.id, component, participation: "INCLUDED", collectionState: "COMPLETE", zeroConfirmed: false, rowsPresent: 1, isEstimate: false, details: {} } });
        await owner.unifiedAggregationRun.update({ where: { id: run.id }, data: { status: "READY", completedAt: new Date() } });
        await owner.unifiedSourcePublication.create({ data: { sourceSystem: platform, platform, scopeKey, businessDate: new Date(day), runId: run.id } });
        await owner.unifiedAggregationRun.update({ where: { id: run.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
      }
      const counts = await db.$transaction([db.unifiedRule.count(), db.unifiedMappingAudit.count(), db.unifiedAggregationRun.count(), db.unifiedDailyFact.count()]);
      const current = (await db.unifiedRule.findUniqueOrThrow({ where: { id: ruleId } })).version;
      const previewInput = { ...input, id: ruleId, expectedVersion: current, impactFrom: businessDate, impactTo: businessDate, previewPlatforms: ["META", "CAFE24"] };
      const preview = await request("POST", "/unified-rules/preview", previewInput, "VIEWER");
      assert.equal(preview.status, 201); assert.equal(preview.body.impact.basis, "PUBLISHED_SCOPE_REVIEW_TOTALS");
      assert.equal(preview.body.impact.publishedRevenue, "1000.000000"); assert.equal(preview.body.impact.publishedAdSpend, "123.450000");
      assert(preview.body.impact.affectedProducts.includes(productName));
      const adOnly = await request("POST", "/unified-rules/preview", { ...previewInput, previewPlatforms: ["META"] }, "VIEWER");
      assert.equal(adOnly.status, 201); assert.equal(adOnly.body.impact.publishedRevenue, null); assert.equal(adOnly.body.impact.publishedAdSpend, "123.450000");
      const empty = await request("POST", "/unified-rules/preview", { ...previewInput, previewPlatforms: [] }, "VIEWER");
      assert.equal(empty.status, 201); assert.equal(empty.body.impact.publishedRevenue, null); assert.equal(empty.body.impact.publishedAdSpend, null);
      const denominator = await request("POST", "/unified-rules/preview", { ...input, kind: "ALLOCATION", productId: null, platform: "CAFE24", scopeKey: cafeScope,
        payload: { method: "REVENUE_SHARE", component: "SHIPPING_COST", targets: [{ productName, weight: null }] },
        impactFrom: businessDate, impactTo: "2026-10-27", previewPlatforms: ["CAFE24"] }, "VIEWER");
      assert.equal(denominator.status, 201); assert.equal(denominator.body.impact.publishedRevenue, "1000.000000");
      assert.equal(denominator.body.impact.zeroDenominator, true, "A zero-revenue source day cannot be hidden by another day's positive revenue.");
      const corrected = await request("POST", "/unified-rules/preview", { ...input, kind: "ALLOCATION", productId: null, platform: "CAFE24", scopeKey: cafeScope,
        payload: { method: "REVENUE_SHARE", component: "SHIPPING_COST", targets: [{ productName, weight: null }] },
        impactFrom: "2026-10-28", impactTo: "2026-10-28", previewPlatforms: ["CAFE24"] }, "VIEWER");
      assert.equal(corrected.status, 201); assert.equal(corrected.body.impact.publishedRevenue, "0.000000");
      assert.equal(corrected.body.impact.zeroDenominator, true, "Positive and negative sale-unit corrections must be netted per target product.");
      assert.deepEqual(await db.$transaction([db.unifiedRule.count(), db.unifiedMappingAudit.count(), db.unifiedAggregationRun.count(), db.unifiedDailyFact.count()]), counts);
    });

    await t.test("changing rule platform and account previews and saves the union of old/new impact scopes", async () => {
      const scopedInput = { ...input, platform: "META", scopeKey: metaScope, payload: { matchType: "EXACT", terms: ["범위 변경 검토 이름"] } };
      const created = await request("POST", "/unified-rules", scopedInput); assert.equal(created.status, 201);
      const changed = { ...scopedInput, platform: "CAFE24", scopeKey: cafeScope, expectedVersion: created.body.rule.version };
      const preview = await request("POST", "/unified-rules/preview", { ...changed, id: created.body.rule.id, impactFrom: businessDate, impactTo: businessDate, previewPlatforms: ["META", "CAFE24"] });
      assert.equal(preview.status, 201); assert.equal(preview.body.impact.publishedRevenue, "1000.000000"); assert.equal(preview.body.impact.publishedAdSpend, "123.450000");
      const saved = await request("PATCH", `/unified-rules/${created.body.rule.id}`, changed); assert.equal(saved.status, 200);
      assert.deepEqual(saved.body.affectedScope.platforms.sort(), ["CAFE24", "META"]);
      assert.deepEqual(saved.body.affectedScope.scopeKeys.sort(), [metaScope, cafeScope].sort());
      const fresh = await request("POST", "/unified-rules/preview", { ...scopedInput, impactFrom: businessDate, impactTo: businessDate, previewPlatforms: ["META", "CAFE24"] });
      assert.equal(fresh.status, 201); assert.equal(fresh.body.impact.publishedRevenue, null); assert.equal(fresh.body.impact.publishedAdSpend, "123.450000", "New scoped rules must retain their platform/account restriction.");
    });

    await t.test("rebuild real HTTP submission is idempotent, permission checked, and exposes failed/published status", async () => {
      const body = { from: businessDate, to: businessDate, platforms: ["META"], scopeKeys: [metaScope], reason: "규칙 저장 후 영향 범위 재집계", expectedContractVersion: CONTRACT_VERSION, idempotencyKey: "stage07-rebuild" };
      assert.equal((await request("POST", "/unified-performance/rebuild", body, "VIEWER")).status, 403);
      const first = await request("POST", "/unified-performance/rebuild", body), repeated = await request("POST", "/unified-performance/rebuild", body);
      assert.equal(first.status, 202); assert.equal(repeated.status, 202); assert.equal(first.body.jobs.length, 1);
      const jobId = first.body.jobs[0].jobId; assert.equal(repeated.body.jobs[0].jobId, jobId);
      assert.equal((await request("POST", "/unified-performance/rebuild", { ...body, reason: "다른 요청" })).status, 409);
      assert.equal((await request("GET", `/unified-performance/rebuild/${jobId}`, undefined, "VIEWER")).status, 403);
      const queued = await request("GET", `/unified-performance/rebuild/${jobId}`, undefined, "OPS");
      assert.equal(queued.status, 200); assert.equal(queued.body.phase, "QUEUED");
      const repository = new UnifiedAggregationRepository(worker as unknown as PrismaService);
      const claim = await repository.claim(jobId); assert(claim); await repository.fail(claim, "SOURCE_READ_FAILED");
      const failed = await request("GET", `/unified-performance/rebuild/${jobId}`, undefined, "OPS");
      assert.equal(failed.body.status, "FAILED"); assert(failed.body.issues.includes("SOURCE_READ_FAILED"));
      const retry = await request("POST", "/unified-performance/rebuild", { ...body, idempotencyKey: "stage07-rebuild-retry" }); assert.equal(retry.status, 202);
      const retryId = retry.body.jobs[0].jobId, retryClaim = await repository.claim(retryId); assert(retryClaim);
      const runRequest: AdapterRequest = { contractVersion: CONTRACT_VERSION, runId: retryId, readSnapshotId: "synthetic-stage07", from: businessDate, to: businessDate, scopeKeys: [metaScope], platforms: ["META"],
        scopePolicyVersion: "fixture", nameRuleVersion: "fixture", saleUnitRuleVersion: "fixture", allocationRuleVersion: "fixture", calculationVersion: "unified-report-v1", fxVersion: "KRW", sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100 };
      const batch = normalizeAdDay(runRequest, { platform: "META", scopeKey: metaScope, date: businessDate, currency: "USD", timeZone: "Asia/Seoul", selectedSource: "API", complete: true,
        sourceIssues: [], storedCoverage: null, excludedRows: 0, fx: { rate: "1", sourceDate: businessDate, provider: "FIXTURE", fallbackType: "EXACT" },
        rows: [{ id: "fixture-ad", entityKey: "fixture-ad", originalName: productName, amount: "123.45", conversionRevenue: null, source: "API", sourceVersion: "fixture", runOrUploadId: "fixture", observedAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" }],
        configuration: { products: [{ canonicalName: productName, active: true }], nameRules: [] } });
      await repository.stageAndPublish(retryClaim, runRequest, batch, prepareReportBatch(runRequest, batch, []));
      const published = await request("GET", `/unified-performance/rebuild/${retryId}`, undefined, "OPS");
      assert.equal(published.status, 200); assert.equal(published.body.status, "PUBLISHED");
      const serialized = JSON.stringify(published.body); for (const secret of ["leaseToken", "checkpoint", "database", "credential"]) assert(!serialized.includes(secret));
    });
  } finally {
    await app.close(); await Promise.all([owner.$disconnect(), db.$disconnect(), viewer.$disconnect(), worker.$disconnect()]);
  }
});
