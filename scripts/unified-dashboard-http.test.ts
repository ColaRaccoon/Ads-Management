import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Module, ValidationPipe } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { Prisma, PrismaClient } from "@prisma/client";
import type { AddressInfo } from "node:net";
import type { Request, Response, NextFunction } from "express";
import { PrismaService } from "../apps/api/src/common/prisma.service";
import { ApiExceptionFilter } from "../apps/api/src/common/api-exception.filter";
import { DangerousJsonKeysPipe } from "../apps/api/src/validation/dangerous-json-keys.pipe";
import { PermissionGuard } from "../apps/api/src/auth/permission.guard";
import type { AuthenticatedRequest } from "../apps/api/src/auth/auth.types";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { UnifiedReportController } from "../apps/api/src/unified-performance/report.controller";
import { UnifiedReportService } from "../apps/api/src/unified-performance/report.service";
import { UnifiedReportRepository, missingCoverage } from "../apps/api/src/unified-performance/report.repository";
import { UnifiedAggregationRepository } from "../apps/api/src/unified-performance/aggregation.repository";
import { ReportQueryDto, RebuildInputDto } from "../apps/api/src/unified-performance/report.dto";
import { CONTRACT_VERSION, PLATFORMS, type Platform, type SourceCoverage } from "../apps/api/src/unified-performance/types";
import type { ReportFact } from "../apps/api/src/unified-performance/report-contract";

const allowedUrl = (role: string) => `postgresql://unified_stage08_${role}@127.0.0.1:55453/unified_stage08?schema=meta_ads`;
const actorId = "88888888-8888-4888-8888-888888888888", productName = "정확 금액 <검토제품>";
const browserMode = process.env.UNIFIED_STAGE08_BROWSER === "1";
const scopes: Record<Platform, string> = { META: "88888888-8888-4888-8888-888888888881", GOOGLE: "88888888-8888-4888-8888-888888888882",
  CAFE24: "88888888-8888-4888-8888-888888888883", NAVER: "stage08-naver", COUPANG: "LEGACY_COUPANG_SINGLE_UPLOAD" };
const medium: Partial<Record<Platform, string>> = { META: "META", GOOGLE: "GOOGLE", NAVER: "NAVER_DA", COUPANG: "COUPANG_ADS" };
const marketplace: Partial<Record<Platform, string>> = { CAFE24: "CAFE24", NAVER: "NAVER_SMARTSTORE", COUPANG: "COUPANG" };
type Ledger = { revenue?: string; before?: string; ad?: string; common?: string; shipping?: string };
const current: Record<Platform, Ledger> = {
  META: { ad: "600.100000" }, GOOGLE: { ad: "100.200000" },
  NAVER: { revenue: "2000.654321", before: "1000.654321", ad: "200.300000", common: "100.500000", shipping: "25.600000" },
  COUPANG: { revenue: "3000.000001", before: "1500.000001", ad: "300.400000" },
  CAFE24: { revenue: "1000.123456", before: "500.123456" }
};
const previous: Record<Platform, Ledger> = {
  META: { ad: "400" }, GOOGLE: { ad: "100" }, NAVER: { revenue: "1500", before: "700", ad: "100", common: "80", shipping: "20" },
  COUPANG: { revenue: "2500", before: "1200", ad: "200" }, CAFE24: { revenue: "800", before: "400" }
};
const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new Prisma.Decimal(0));
function expected(platforms: Platform[], ledger: Record<Platform, Ledger>) {
  const rows = platforms.map(platform => ledger[platform]);
  const sale = rows.some(row => row.revenue !== undefined), ads = rows.some(row => row.ad !== undefined);
  const total = (key: keyof Ledger) => sum(rows.flatMap(row => row[key] === undefined ? [] : [row[key]!]));
  return { revenue: sale ? total("revenue").toFixed(6) : null, adSpend: ads ? total("ad").toFixed(6) : null,
    profitBeforeAds: sale ? total("before").toFixed(6) : null,
    estimatedProfit: sale ? total("before").minus(total("ad")).minus(total("common")).plus(total("shipping")).toFixed(6) : null,
    mer: sale && ads && total("ad").gt(0) ? total("revenue").div(total("ad")).toFixed(10) : null };
}

test("stage08 dashboard real HTTP aggregates and precise read-only display inputs", { skip: !process.env.UNIFIED_STAGE08_VIEWER_URL }, async t => {
  assert.equal(process.env.UNIFIED_STAGE08_OWNER_URL, allowedUrl("owner"));
  assert.equal(process.env.UNIFIED_STAGE08_VIEWER_URL, allowedUrl("viewer"));
  const owner = new PrismaClient({ datasourceUrl: allowedUrl("owner") }), viewer = new PrismaClient({ datasourceUrl: allowedUrl("viewer") });
  const repository = new UnifiedReportRepository(new UnifiedManagementRepository(viewer as unknown as PrismaService));
  const reports = new UnifiedReportService(repository, new UnifiedAggregationRepository(viewer as unknown as PrismaService));
  Reflect.defineMetadata("design:paramtypes", [UnifiedReportService], UnifiedReportController);
  for (const method of ["options", "summary", "timeseries", "diagnostics"]) Reflect.defineMetadata("design:paramtypes", [ReportQueryDto, Object], UnifiedReportController.prototype, method);
  Reflect.defineMetadata("design:paramtypes", [RebuildInputDto, Object], UnifiedReportController.prototype, "rebuild");
  Reflect.defineMetadata("design:paramtypes", [String, Object], UnifiedReportController.prototype, "job");
  @Module({ controllers: [UnifiedReportController], providers: [{ provide: UnifiedReportService, useValue: reports }] }) class FixtureModule {}
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.setGlobalPrefix("api");
  let releaseBrowser: (() => void) | undefined;
  if (browserMode) {
    app.enableCors({ origin: /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/, credentials: true });
    app.use((request: Request, response: Response, next: NextFunction) => {
      if (request.path === "/api/auth/me") return response.json({ user: { id: actorId, username: "stage08-synthetic-viewer", email: null,
        name: "합성 표본 · 읽기 전용 검증", role: "USER", isActive: true, inviteStatus: "ACTIVE" }, permissions: ["data.read"], authorizationVersion: "synthetic-stage08-v1" });
      if (request.path === "/api/auth/refresh") return response.json({});
      if (request.path === "/api/__stage08/health") return response.json({ synthetic: true, ready: Boolean(releaseBrowser), readOnly: true });
      if (request.path === "/api/__stage08/stop" && request.method === "POST") { response.json({ stopping: true }); releaseBrowser?.(); return; }
      next();
    });
  }
  app.use((request: Request, _response: Response, next: NextFunction) => {
    const role = String(request.headers["x-fixture-role"] ?? "VIEWER");
    if (role !== "ANONYMOUS") (request as AuthenticatedRequest).authenticatedUser = {
      id: actorId, authUserId: actorId, email: null, name: "Synthetic stage08", role: "USER", isActive: true,
      inviteStatus: "ACTIVE", authzVersion: 1, sessionId: actorId, permissions: role === "VIEWER" ? ["data.read"] : []
    };
    next();
  });
  app.useGlobalGuards(new PermissionGuard(new Reflector())); app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(new DangerousJsonKeysPipe(), new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transformOptions: { enableImplicitConversion: false }, validationError: { target: false, value: false } }));
  await app.listen(browserMode ? 4198 : 0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/unified-performance/`;
  const query = { from: "2026-10-26", to: "2026-10-26", compareFrom: "2026-10-19", compareTo: "2026-10-19", productName };
  const get = async (path: string, input: Record<string, unknown> = query, role = "VIEWER") => {
    const params = new URLSearchParams(Object.entries(input).map(([key, value]) => [key, Array.isArray(value) ? JSON.stringify(value) : String(value)]));
    const response = await fetch(base + path + "?" + params, { headers: { "x-fixture-role": role } });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  async function seed(platform: Platform, date: string, ledger: Ledger, zero = false, missingCost = false) {
    const quality = { isEstimate: platform === "NAVER", confidence: platform === "NAVER" ? "ESTIMATED" : "SOURCE_REPORTED", issues: platform === "NAVER" ? ["NAVER_ESTIMATED"] : [] };
    const run = await owner.unifiedAggregationRun.create({ data: { sourceSystem: platform, platform, scopeKey: scopes[platform], businessDate: new Date(date),
      contractVersion: CONTRACT_VERSION, versions: { scopePolicyVersion: "fixture", nameRuleVersion: "fixture", saleUnitRuleVersion: "fixture", allocationRuleVersion: "fixture",
        calculationVersion: "unified-report-v1", fxVersion: "KRW" }, readSnapshotId: "synthetic-stage08", sourceWatermarks: {}, controlTotals: [], issues: [] } });
    const facts: ReportFact[] = [];
    const fact = (component: ReportFact["component"], amount: string, extra: Partial<ReportFact>) => facts.push({ component, factKey: `${platform}-${component}`, productName,
      saleUnitName: component === "SALE" ? "단품" : null, amountKrw: amount, completeAmountKrw: amount, profitBeforeAds: null, completeProfitBeforeAds: null,
      originalAmount: amount, currency: "KRW", quantity: "1", attribution: "DIRECT", medium: null, marketplace: null, commonKind: null,
      rowsCount: 1, quality: quality as ReportFact["quality"], ...extra });
    if (!zero) {
      if (ledger.revenue !== undefined) fact("SALE", ledger.revenue, { profitBeforeAds: missingCost ? null : ledger.before!, completeProfitBeforeAds: missingCost ? null : ledger.before!, marketplace: marketplace[platform]! });
      if (ledger.ad !== undefined) fact("AD_SPEND", ledger.ad, { medium: medium[platform]! });
      if (ledger.common !== undefined) fact("COMMON_EXPENSE", ledger.common, { commonKind: "SHIPPING_COST" });
      if (ledger.shipping !== undefined) fact("SHIPPING_INCOME", ledger.shipping, { commonKind: "SHIPPING_INCOME" });
    }
    for (const row of facts) await owner.unifiedDailyFact.create({ data: { runId: run.id, component: row.component, factKey: row.factKey, productName, saleUnitName: row.saleUnitName,
      amountKrw: row.amountKrw, originalAmount: row.originalAmount, currency: row.currency, quantity: row.quantity, attribution: row.attribution, payload: row as unknown as Prisma.InputJsonValue } });
    for (const initial of missingCoverage({ platform, scopeKey: scopes[platform], label: "검토 범위" }, date)) {
      const notApplicable = initial.component === "COMMON_EXPENSE" && platform !== "NAVER";
      const coverage: SourceCoverage = { ...initial, participation: notApplicable ? "NOT_APPLICABLE" : "INCLUDED", collectionState: zero ? "COMPLETE" : missingCost && initial.component === "DIRECT_COST" ? "PARTIAL" : platform === "NAVER" ? "PARTIAL" : "COMPLETE",
        rowsPresent: zero ? 0 : 1, zeroConfirmed: zero, sourceAsOf: `${date}T12:00:00.000Z`, lastSuccessAt: `${date}T12:00:00.000Z`, calculatedAt: `${date}T13:00:00.000Z`,
        selectedSource: "SYNTHETIC", mappedRows: zero ? 0 : 1, unmappedRows: 0, missingCostRows: missingCost && initial.component === "DIRECT_COST" ? 1 : 0,
        quality: { ...quality, confidence: quality.confidence as SourceCoverage["quality"]["confidence"], issues: missingCost ? ["COST_MISSING"] : quality.issues } };
      await owner.unifiedSourceCoverage.create({ data: { runId: run.id, component: initial.component, participation: coverage.participation, collectionState: coverage.collectionState,
        rowsPresent: coverage.rowsPresent, zeroConfirmed: coverage.zeroConfirmed, sourceAsOf: new Date(coverage.sourceAsOf!), isEstimate: quality.isEstimate, details: coverage as unknown as Prisma.InputJsonValue } });
    }
    await owner.unifiedAggregationRun.update({ where: { id: run.id }, data: { status: "READY", completedAt: new Date() } });
    await owner.unifiedSourcePublication.create({ data: { sourceSystem: platform, platform, scopeKey: scopes[platform], businessDate: new Date(date), runId: run.id } });
    await owner.unifiedAggregationRun.update({ where: { id: run.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
  }
  try {
    await owner.unifiedProduct.create({ data: { canonicalName: productName, normalizedName: productName } });
    await owner.sourceConnection.createMany({ data: (["META", "GOOGLE", "CAFE24"] as const).map(provider => ({ id: scopes[provider], provider, externalAccountId: `stage08-${provider}`, displayName: `검토 ${provider}`, currencyCode: "KRW", timeZone: "Asia/Seoul" })) });
    for (const platform of PLATFORMS) {
      await seed(platform, "2026-10-26", current[platform]); await seed(platform, "2026-10-19", previous[platform]);
      await seed(platform, "2026-10-25", {}, true);
      if (platform !== "NAVER") await seed(platform, "2026-10-24", current[platform]);
    }
    await seed("CAFE24", "2026-10-22", { revenue: "77", before: "0" }, false, true);
    await seed("CAFE24", "2026-10-18", { revenue: "1000", before: "-500" });
    await seed("CAFE24", "2026-10-17", { revenue: "200", before: "100" });
    const counts = () => owner.$transaction([owner.unifiedAggregationRun.count(), owner.unifiedDailyFact.count(), owner.unifiedSourceCoverage.count(), owner.unifiedRule.count()]);
    const beforeCounts = await counts();
    await t.test("read-only role, real guards, exact canonical name, authorized scopes and API errors", async () => {
      const [identity] = await viewer.$queryRaw<Array<{ db: string; usr: string; rolsuper: boolean; rolbypassrls: boolean; owns: bigint }>>`SELECT current_database() db,current_user usr,rolsuper,rolbypassrls,(SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
      assert.equal(identity.db, "unified_stage08"); assert.equal(identity.usr, "unified_stage08_viewer");
      assert.equal(identity.rolsuper, false); assert.equal(identity.rolbypassrls, false); assert.equal(identity.owns, 0n);
      await assert.rejects(viewer.$queryRaw`SELECT * FROM public.stage08_source_orders`, /permission denied/);
      await assert.rejects(viewer.$queryRaw`SELECT * FROM public.stage08_credentials`, /permission denied/);
      await assert.rejects(viewer.unifiedDailyFact.deleteMany({}), /permission denied/);
      assert.equal((await get("summary", query, "ANONYMOUS")).status, 401);
      assert.equal((await get("summary", query, "NONE")).status, 403);
      assert.equal((await get("summary", { ...query, productName: productName + " 비등록" })).status, 404);
      assert.equal((await get("summary", { ...query, platforms: ["UNKNOWN"] })).status, 400);
      assert.equal((await get("summary", { ...query, scopeKeys: ["unregistered"] })).status, 403);
      const options = await get("options"); assert.equal(options.status, 200); assert.equal(options.headers.get("cache-control"), "no-store");
      assert(options.body.products.some((row: any) => row.productName === productName)); assert.equal(options.body.scopes.length, 5);
    });
    await t.test("all 32 platform selections preserve precise sales, costs, profits, medium shares and comparison", async () => {
      const hashes = new Set<string>();
      for (let mask = 0; mask < 32; mask++) {
        const selected = PLATFORMS.filter((_, index) => mask & (1 << index));
        const result = await get("summary", { ...query, platforms: selected }); assert.equal(result.status, 200, JSON.stringify(result.body));
        const data = result.body, target = expected([...selected], current), baseline = expected([...selected], previous);
        assert.deepEqual(data.knownTotals, target, `mask ${mask}`); assert.deepEqual(data.completeTotals, target, `complete ${mask}`);
        assert.deepEqual(data.selectedPlatforms, selected); assert.deepEqual(data.selection.selectedPlatforms, selected); hashes.add(data.selection.selectionHash);
        assert.equal(data.items[0].productName, productName); assert.deepEqual(data.items[0].knownTotals, target);
        for (const key of Object.keys(target)) {
          assert.equal(data.comparison.known[key].current, target[key as keyof typeof target]);
          assert.equal(data.comparison.known[key].previous, baseline[key as keyof typeof baseline]);
        }
        for (const row of data.byMedium) {
          const platform = selected.find(key => medium[key] === row.medium)!; assert(platform);
          const amount = current[platform].ad!; assert.equal(new Prisma.Decimal(row.adSpend).toFixed(6), new Prisma.Decimal(amount).toFixed(6));
          assert.equal(row.share, new Prisma.Decimal(amount).div(target.adSpend!).mul(100).toFixed(10));
        }
        for (const row of data.comparison.previousByMarketplace) {
          const platform = selected.find(key => marketplace[key] === row.marketplace)!; assert(platform);
          assert.equal(new Prisma.Decimal(row.revenue).toFixed(6), new Prisma.Decimal(previous[platform].revenue!).toFixed(6));
        }
        assert(data.coverage.every((row: any) => selected.includes(row.platform)));
        assert.equal(data.isEstimate, selected.includes("NAVER"));
        const series = await get("timeseries", { ...query, platforms: selected }); assert.equal(series.status, 200);
        assert.equal(series.body.snapshotHash, data.snapshotHash); assert.equal(series.body.selection.selectionHash, data.selection.selectionHash);
        assert.deepEqual(series.body.items[0].knownTotals, target); assert.deepEqual(series.body.items[0].completeTotals, target);
        if (!selected.length) assert.equal(data.metricAvailability.state, "EMPTY_SELECTION");
        if (selected.length && selected.every(platform => ["META", "GOOGLE"].includes(platform))) assert.equal(data.metricAvailability.state, "AD_ONLY");
        if (selected.length === 1 && selected[0] === "CAFE24") assert.equal(data.metricAvailability.state, "SALE_ONLY");
      }
      assert.equal(hashes.size, 32);
      const again = await get("summary", { ...query, platforms: [...PLATFORMS] }); assert.equal(again.body.knownTotals.estimatedProfit, "1724.877778");
      const naver = await get("summary", { ...query, platforms: ["NAVER"] }); assert.equal(naver.body.completeTotals.estimatedProfit, "725.454321");
      const missingNaverInput = { ...query, from: "2026-10-24", to: "2026-10-24" };
      const withMissingNaver = await get("summary", missingNaverInput); assert.equal(withMissingNaver.body.completeTotals.revenue, null);
      const withoutNaver = await get("summary", { ...missingNaverInput, platforms: PLATFORMS.filter(platform => platform !== "NAVER") });
      assert.deepEqual(withoutNaver.body.completeTotals, expected(PLATFORMS.filter(platform => platform !== "NAVER"), current));
      assert(!withoutNaver.body.coverage.some((row: any) => row.platform === "NAVER"));
    });
    await t.test("zero, physically missing dates, missing costs, zero-base and profit transitions remain distinct", async () => {
      const selection = { ...query, platforms: ["CAFE24"] };
      const zero = (await get("summary", { ...selection, from: "2026-10-25", to: "2026-10-25" })).body;
      assert.equal(zero.completeTotals.revenue, "0.000000"); assert(zero.coverage.some((row: any) => row.zeroConfirmed));
      const missing = (await get("summary", { ...selection, from: "2026-10-27", to: "2026-10-27" })).body;
      assert.equal(missing.knownTotals.revenue, null); assert.equal(missing.completeTotals.revenue, null); assert(missing.warnings.includes("INCOMPLETE_COVERAGE"));
      const costs = (await get("summary", { ...selection, from: "2026-10-22", to: "2026-10-22" })).body;
      assert.equal(costs.completeTotals.revenue, "77.000000"); assert.equal(costs.completeTotals.estimatedProfit, null); assert.equal(costs.knownTotals.estimatedProfit, null);
      assert(costs.coverage.some((row: any) => row.missingCostRows === 1));
      const zeroBase = (await get("summary", { ...query, platforms: ["META"], compareFrom: "2026-10-25", compareTo: "2026-10-25" })).body;
      assert.equal(zeroBase.comparison.known.adSpend.reason, "ZERO_BASE"); assert.equal(zeroBase.comparison.known.adSpend.changePct, null);
      const profit = (await get("summary", { ...selection, compareFrom: "2026-10-18", compareTo: "2026-10-18" })).body;
      assert.equal(profit.comparison.known.estimatedProfit.previous, "-500.000000"); assert.equal(profit.comparison.known.estimatedProfit.reason, "NON_POSITIVE_PROFIT_BASE");
      const loss = (await get("summary", { ...selection, from: "2026-10-18", to: "2026-10-18", compareFrom: "2026-10-17", compareTo: "2026-10-17" })).body;
      assert.equal(loss.comparison.known.estimatedProfit.change, "-600.000000"); assert.equal(loss.comparison.known.estimatedProfit.changePct, null);
    });
    await t.test("day/week/month, partial periods and unequal comparison use server bucket ranges", async () => {
      const input = { ...query, from: "2026-10-25", to: "2026-10-27", platforms: ["CAFE24"] };
      const daily = (await get("timeseries", { ...input, grain: "day" })).body;
      assert.deepEqual(daily.items.map((row: any) => row.knownTotals.revenue), ["0.000000", "1000.123456", null]);
      assert.equal(daily.comparison.currentDays, 3); assert.equal(daily.comparison.previousDays, 1); assert.equal(daily.comparison.unequalPeriods, true);
      const weekly = (await get("timeseries", { ...input, grain: "week" })).body;
      assert.deepEqual(weekly.items.map((row: any) => [row.date, row.bucketFrom, row.bucketTo, row.partial]), [["2026-10-19", "2026-10-25", "2026-10-25", true], ["2026-10-26", "2026-10-26", "2026-10-27", true]]);
      const monthly = (await get("timeseries", { ...input, grain: "month" })).body;
      assert.equal(monthly.items[0].date, "2026-10-01"); assert.equal(monthly.items[0].bucketFrom, input.from); assert.equal(monthly.items[0].bucketTo, input.to);
      assert.equal(monthly.items[0].partial, true); assert.equal(monthly.items[0].knownTotals.revenue, "1000.123456"); assert.equal(monthly.items[0].completeTotals.revenue, null);
    });
    await t.test("all timeseries and diagnostic pages preserve selection/snapshot and refuse foreign cursors", async () => {
      const input = { ...query, from: "2026-07-01", to: "2026-10-26", platforms: ["CAFE24"], limit: 100 };
      for (const path of ["timeseries", "diagnostics"]) {
        let result = await get(path, input); assert.equal(result.status, 200); assert(result.body.total > 100);
        const first = result.body, items = [...first.items]; let cursor = first.nextCursor;
        assert.equal((await get(path, { ...input, platforms: ["META"], cursor })).status, 409);
        while (cursor) {
          result = await get(path, { ...input, cursor }); assert.equal(result.status, 200);
          assert.equal(result.body.selection.selectionHash, first.selection.selectionHash); assert.equal(result.body.snapshotHash, first.snapshotHash);
          items.push(...result.body.items); cursor = result.body.nextCursor;
        }
        assert.equal(items.length, first.total); assert.equal(new Set(items.map((row: any) => path === "timeseries" ? row.date : `${row.platform}|${row.scopeKey}|${row.date}|${row.component}`)).size, first.total);
      }
      const emptyScope = await get("summary", { ...query, platforms: ["CAFE24"], scopeKeys: [] });
      assert.equal(emptyScope.status, 200); assert.equal(emptyScope.body.knownTotals.revenue, null); assert.equal(emptyScope.body.selection.scopeKeys.length, 0);
      assert.deepEqual(await counts(), beforeCounts, "Every dashboard GET remains read-only.");
    });
    await t.test("production dashboard loader renders exact API card/table/tooltip values across 32 selections", async () => {
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/unified-dashboard-web-check.tsx"], {
        windowsHide: true, timeout: 60000, env: { ...process.env, TSX_TSCONFIG_PATH: "apps/web/tsconfig.storefront-test.json", UNIFIED_STAGE08_HTTP_BASE: base.replace(/\/unified-performance\/$/, "") }
      });
      assert.match(result.stdout, /"status":"PASS"/); assert.match(result.stdout, /"selections":32/);
      assert.deepEqual(await counts(), beforeCounts);
    });
    if (browserMode) await new Promise<void>(resolve => {
      releaseBrowser = resolve;
      console.log("STAGE08_BROWSER_READY http://127.0.0.1:4198/api synthetic-viewer read-only; POST /api/__stage08/stop to cleanly release HTTP and PG");
    });
  } finally { await app.close(); await Promise.all([owner.$disconnect(), viewer.$disconnect()]); }
});
