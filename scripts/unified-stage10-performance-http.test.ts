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
import { ReportQueryDto, RelationshipQueryDto, RebuildInputDto } from "../apps/api/src/unified-performance/report.dto";
import { CONTRACT_VERSION, PLATFORMS, type Platform, type SourceCoverage } from "../apps/api/src/unified-performance/types";
import type { ReportFact } from "../apps/api/src/unified-performance/report-contract";
import { datesIn, parseReportQuery, shiftDate } from "../apps/api/src/unified-performance/report-query";
import { parseRelationshipQuery } from "../apps/api/src/unified-performance/relationship-query";
import { relationshipDays } from "../apps/api/src/unified-performance/relationship-input";
import { calculateRelationships } from "../apps/api/src/unified-performance/domain/relationship-calculation";
import { summarizeReport } from "../apps/api/src/unified-performance/domain/report-calculation";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { CompactReplayPartition } from "./unified-report-replay-capture";

const allowedUrl = (role: string) => `postgresql://unified_stage10perf_${role}@127.0.0.1:55456/unified_stage10perf?schema=meta_ads`;
const actorId = "88888888-8888-4888-8888-888888888888", productName = "정확 금액 <검토제품>";
const browserMode = process.env.UNIFIED_STAGE10PERF_BROWSER === "1";
const scopes: Record<Platform, string> = { META: "88888888-8888-4888-8888-888888888881", GOOGLE: "88888888-8888-4888-8888-888888888882",
  CAFE24: "88888888-8888-4888-8888-888888888883", NAVER: "stage10perf-naver", COUPANG: "LEGACY_COUPANG_SINGLE_UPLOAD" };
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

test("stage10perf relationships real HTTP paired samples and read-only selected inputs", { skip: !process.env.UNIFIED_STAGE10PERF_VIEWER_URL }, async t => {
  assert.equal(process.env.UNIFIED_STAGE10PERF_OWNER_URL, allowedUrl("owner"));
  assert.equal(process.env.UNIFIED_STAGE10PERF_VIEWER_URL, allowedUrl("viewer"));
  const owner = new PrismaClient({ datasourceUrl: allowedUrl("owner") }), viewer = new PrismaClient({ datasourceUrl: allowedUrl("viewer") });
  const repository = new UnifiedReportRepository(new UnifiedManagementRepository(viewer as unknown as PrismaService));
  const reports = new UnifiedReportService(repository, new UnifiedAggregationRepository(viewer as unknown as PrismaService));
  Reflect.defineMetadata("design:paramtypes", [UnifiedReportService], UnifiedReportController);
  for (const method of ["options", "summary", "timeseries", "diagnostics"]) Reflect.defineMetadata("design:paramtypes", [ReportQueryDto, Object], UnifiedReportController.prototype, method);
  Reflect.defineMetadata("design:paramtypes", [RelationshipQueryDto, Object], UnifiedReportController.prototype, "relationships");
  Reflect.defineMetadata("design:paramtypes", [RebuildInputDto, Object], UnifiedReportController.prototype, "rebuild");
  Reflect.defineMetadata("design:paramtypes", [String, Object], UnifiedReportController.prototype, "job");
  @Module({ controllers: [UnifiedReportController], providers: [{ provide: UnifiedReportService, useValue: reports }] }) class FixtureModule {}
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.setGlobalPrefix("api");
  let releaseBrowser: (() => void) | undefined;
  if (browserMode) {
    app.enableCors({ origin: /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/, credentials: true });
    app.use((request: Request, response: Response, next: NextFunction) => {
      if (request.path === "/api/auth/me") return response.json({ user: { id: actorId, username: "stage10perf-synthetic-viewer", email: null,
        name: "합성 표본 · 읽기 전용 검증", role: "USER", isActive: true, inviteStatus: "ACTIVE" }, permissions: ["data.read"], authorizationVersion: "synthetic-stage10perf-v1" });
      if (request.path === "/api/auth/refresh") return response.json({});
      if (request.path === "/api/__stage10perf/health") return response.json({ synthetic: true, ready: Boolean(releaseBrowser), readOnly: true });
      if (request.path === "/api/__stage10perf/stop" && request.method === "POST") { response.json({ stopping: true }); releaseBrowser?.(); return; }
      next();
    });
  }
  app.use((request: Request, _response: Response, next: NextFunction) => {
    const role = String(request.headers["x-fixture-role"] ?? "VIEWER");
    if (role !== "ANONYMOUS") (request as AuthenticatedRequest).authenticatedUser = {
      id: actorId, authUserId: actorId, email: null, name: "Synthetic stage10perf", role: "USER", isActive: true,
      inviteStatus: "ACTIVE", authzVersion: 1, sessionId: actorId, permissions: role === "VIEWER" ? ["data.read"] : []
    };
    next();
  });
  app.useGlobalGuards(new PermissionGuard(new Reflector())); app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(new DangerousJsonKeysPipe(), new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transformOptions: { enableImplicitConversion: false }, validationError: { target: false, value: false } }));
  await app.listen(browserMode ? 4199 : 0, "127.0.0.1");
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
        calculationVersion: "unified-report-v1", fxVersion: "KRW" }, readSnapshotId: "synthetic-stage10perf", sourceWatermarks: {}, controlTotals: [], issues: [] } });
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
    await owner.sourceConnection.createMany({ data: (["META", "GOOGLE", "CAFE24"] as const).map(provider => ({ id: scopes[provider], provider, externalAccountId: `stage10perf-${provider}`, displayName: `검토 ${provider}`, currencyCode: "KRW", timeZone: "Asia/Seoul" })) });
    const from = "2026-07-01", to = "2026-09-28", lookback = shiftDate(from, -14);
    const dayIndex = (date: string) => Math.round((Date.parse(date) - Date.parse(lookback)) / 86400000);
    const adAt = (index: number) => String(((index * 37 + index * index * 11) % 113 + 10) * 100) + ".123456";
    const ledgerAt = (platform: Platform, date: string): Ledger => {
      const index = dayIndex(date), ad = adAt(index), revenue = new Prisma.Decimal(adAt(index - 3)).mul(2).plus("10000.654321").toFixed(6);
      if (platform === "META") return { ad };
      if (platform === "GOOGLE") return { ad: "100.200000" };
      if (platform === "CAFE24") return { revenue, before: new Prisma.Decimal(revenue).minus("5000").toFixed(6) };
      if (platform === "COUPANG") return { revenue: "3000.000001", before: "1500.000001", ad: "300.400000" };
      return { revenue: "2000.654321", before: "1000.654321", ad: "200.300000", common: "100.500000", shipping: "25.600000" };
    };
    const missingNaver = new Set(["2026-07-10", "2026-08-20"]), missingCostDate = "2026-07-20";
    for (const date of datesIn(lookback, to)) for (const platform of PLATFORMS) {
      if (platform === "NAVER" && missingNaver.has(date)) continue;
      await seed(platform, date, ledgerAt(platform, date), false, platform === "CAFE24" && date === missingCostDate);
    }
    const input = { from, to, compareFrom: "2026-06-01", compareTo: "2026-06-01", productName };
    const counts = () => owner.$transaction([owner.unifiedAggregationRun.count(), owner.unifiedDailyFact.count(), owner.unifiedSourceCoverage.count(), owner.unifiedRule.count()]);
    const beforeCounts = await counts();
    await t.test("actual viewer role, guard/DTO/scope failures and no source privileges", async () => {
      const [identity] = await viewer.$queryRaw<Array<{ db: string; usr: string; rolsuper: boolean; rolbypassrls: boolean; owns: bigint }>>`SELECT current_database() db,current_user usr,rolsuper,rolbypassrls,(SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
      assert.equal(identity.db, "unified_stage10perf"); assert.equal(identity.usr, "unified_stage10perf_viewer");
      assert.equal(identity.rolsuper, false); assert.equal(identity.rolbypassrls, false); assert.equal(identity.owns, 0n);
      await assert.rejects(viewer.$queryRaw`SELECT * FROM public.stage10perf_source_orders`, /permission denied/);
      await assert.rejects(viewer.$queryRaw`SELECT * FROM public.stage10perf_credentials`, /permission denied/);
      await assert.rejects(viewer.unifiedDailyFact.deleteMany({}), /permission denied/);
      assert.equal((await get("relationships", input, "ANONYMOUS")).status, 401);
      assert.equal((await get("relationships", input, "NONE")).status, 403);
      assert.equal((await get("relationships", { ...input, productName: productName + " unknown" })).status, 404);
      for (const extra of [{ platforms: ["UNKNOWN"] }, { analysisMedia: ["UNKNOWN"] }, { analysisMedia: ["NAVER_DA"], platforms: ["META"] }, { changeDate: "2026-06-30" }, { changeDate: "2026-02-30" }, { analysisMedia: "invalid" }, { cursor: "anything" }])
        assert.equal((await get("relationships", { ...input, ...extra })).status, 400, JSON.stringify(extra));
      assert.equal((await get("relationships", { ...input, scopeKeys: ["unregistered"] })).status, 403);
    });
    await t.test("all 32 platform selections: exact daily values, samples, estimates and baseline KPI hashes", async () => {
      for (let mask = 0; mask < 32; mask++) {
        const platforms = PLATFORMS.filter((_, index) => mask & (1 << index));
        const response = await get("relationships", { ...input, platforms });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.headers.get("cache-control"), "no-store");
        const data = response.body, analysis = data.analysis;
        const summary = await get("summary", { ...input, platforms }); assert.equal(summary.status, 200);
        assert.equal(data.baseSnapshotHash, summary.body.snapshotHash, `base snapshot mask ${mask}`);
        assert.equal(data.selection.selectionHash, summary.body.selection.selectionHash);
        assert.deepEqual(data.knownTotals, summary.body.knownTotals); assert.deepEqual(data.completeTotals, summary.body.completeTotals);
        assert.deepEqual(analysis.availableMedia, platforms.flatMap(platform => medium[platform] ? [medium[platform]] : []).sort((a,b) => ["META","GOOGLE","NAVER_DA","COUPANG_ADS"].indexOf(a!) - ["META","GOOGLE","NAVER_DA","COUPANG_ADS"].indexOf(b!)));
        assert.equal(analysis.daily.length, 90); assert.equal(analysis.lags.length, 10); assert.equal(analysis.lookbackFrom, lookback);
        for (const row of analysis.daily) {
          const ledgers = Object.fromEntries(PLATFORMS.map(platform => [platform, ledgerAt(platform, row.date)])) as Record<Platform, Ledger>;
          const target = expected([...platforms], ledgers), naverMissing = platforms.includes("NAVER") && missingNaver.has(row.date);
          assert.equal(row.revenue, naverMissing ? null : target.revenue, `revenue ${mask}/${row.date}`);
          assert.equal(row.adSpend, naverMissing ? null : target.adSpend, `ads ${mask}/${row.date}`);
          assert.equal(row.profitBeforeAds, naverMissing || platforms.includes("CAFE24") && row.date === missingCostDate ? null : target.profitBeforeAds);
          assert.equal(row.isEstimate, platforms.includes("NAVER"));
          assert.equal(row.otherAdSpend, "0.000000");
        }
        for (const lag of analysis.lags) {
          const sale = platforms.some(platform => ["CAFE24", "NAVER", "COUPANG"].includes(platform));
          const ads = platforms.some(platform => platform !== "CAFE24");
          const expectedDates = datesIn(from, to).filter(date => sale && ads &&
            !(platforms.includes("NAVER") && (missingNaver.has(date) || missingNaver.has(shiftDate(date, -lag.lagDays)))) &&
            !(lag.metric === "profitBeforeAds" && platforms.includes("CAFE24") && date === missingCostDate));
          assert.equal(lag.usedDays, expectedDates.length, `paired ${mask}/${lag.lagDays}/${lag.metric}`);
          assert.equal(lag.excludedDays, 90 - expectedDates.length);
          assert.deepEqual(lag.pairs.map((pair: any) => pair.outcomeDate), expectedDates);
          for (const pair of lag.pairs) assert.equal(pair.adDate, shiftDate(pair.outcomeDate, -lag.lagDays));
        }
        if (!platforms.includes("NAVER")) assert(!data.warnings.some((value: string) => value.includes("NAVER")));
      }
    });
    await t.test("known lag3 relationship, independent media choice, missing outcome cost and constant series", async () => {
      const selected = { ...input, platforms: ["META", "GOOGLE", "CAFE24"] };
      const result = await get("relationships", { ...selected, analysisMedia: ["META"], changeDate: "2026-08-15" });
      assert.equal(result.status, 200); const a = result.body.analysis;
      const lag3 = a.lags.find((row: any) => row.lagDays === 3 && row.metric === "revenue");
      assert.equal(lag3.coefficient, "1.0000000000"); assert.equal(lag3.usedDays, 90);
      const profit3 = a.lags.find((row: any) => row.lagDays === 3 && row.metric === "profitBeforeAds");
      assert.equal(profit3.usedDays, 89); assert.equal(profit3.coefficient, "1.0000000000");
      assert(a.daily.every((row: any) => row.otherAdSpend === "100.200000"));
      assert.equal(a.daily[0].movingAverage7.adSpend, sum(datesIn(shiftDate(from,-6),from).map(date => adAt(dayIndex(date)))).div(7).toFixed(6));
      for (const window of a.beforeAfter) {
        assert.equal(window.before.to, "2026-08-14"); assert.equal(window.after.from, "2026-08-15");
        assert.equal(window.before.metrics.adSpend.usedDays, window.windowDays); assert.equal(window.after.metrics.adSpend.usedDays, window.windowDays);
        assert.equal(window.before.metrics.otherAdSpend.mean, "100.2000000000");
      }
      const alternate = await get("relationships", { ...selected, analysisMedia: ["GOOGLE"] });
      assert.deepEqual(alternate.body.knownTotals, result.body.knownTotals); assert.deepEqual(alternate.body.completeTotals, result.body.completeTotals);
      assert(alternate.body.analysis.lags.every((row: any) => row.coefficient === null && row.reasons.includes("CONSTANT_AD_SPEND")));
      const short = await get("relationships", { ...selected, from: "2026-09-01", analysisMedia: ["META"] });
      assert(short.body.analysis.lags.every((row: any) => row.coefficient === null && row.reasons.includes("INSUFFICIENT_PAIRS")));
      const empty = await get("relationships", { ...selected, analysisMedia: [] });
      assert(empty.body.analysis.daily.every((row: any) => row.adSpend === null));
      const limited = await get("relationships", { ...input, platforms: ["META", "CAFE24"], scopeKeys: [scopes.META] });
      assert.equal(limited.status, 200); assert(limited.body.analysis.daily.every((row: any) => row.revenue === null));
      const scoped = await get("relationships", { ...input, platforms: ["META", "GOOGLE", "CAFE24"], scopeKeys: [scopes.META, scopes.CAFE24] });
      assert.equal(scoped.status, 200);
      for (const row of scoped.body.analysis.daily) {
        assert.equal(row.adSpend, adAt(dayIndex(row.date)), "selected Google without an included scope is not a missing ad day");
        assert.equal(row.revenue, ledgerAt("CAFE24", row.date).revenue);
      }
      const scopedSummary = await get("summary", { ...input, platforms: ["META", "GOOGLE", "CAFE24"], scopeKeys: [scopes.META, scopes.CAFE24] });
      assert.equal(scoped.body.baseSnapshotHash, scopedSummary.body.snapshotHash);
      assert.deepEqual(scoped.body.completeTotals, scopedSummary.body.completeTotals);
      assert.deepEqual(await counts(), beforeCounts, "all GET paths remain read-only");
    });


    await t.test("stage10 366 daily buckets retain every cursor page after scoped pagination", async () => {
      const dailyInput = {...input, from:shiftDate(to,-365), platforms:["META","CAFE24"], grain:"day", limit:100};
      let result = await get("timeseries",dailyInput); assert.equal(result.status,200);
      const first=result.body, rows=[...first.items]; let cursor=first.nextCursor, pages=1;
      assert.equal(first.total,366); assert.equal(rows.length,100);
      while(cursor) {
        result=await get("timeseries",{...dailyInput,cursor}); assert.equal(result.status,200);
        assert.equal(result.body.snapshotHash,first.snapshotHash);
        assert.equal(result.body.selection.selectionHash,first.selection.selectionHash);
        rows.push(...result.body.items); cursor=result.body.nextCursor; pages++;
      }
      assert.equal(pages,4); assert.equal(rows.length,366);
      assert.deepEqual(rows.map((row:any)=>row.date),datesIn(dailyInput.from,to));
      assert(rows.every((row:any)=>row.bucketFrom===row.date&&row.bucketTo===row.date));
      for(const row of rows) if(row.date>=lookback) {
        assert.equal(row.knownTotals.revenue,ledgerAt("CAFE24",row.date).revenue);
        assert.equal(row.knownTotals.adSpend,ledgerAt("META",row.date).ad);
      }
      const changed=await get("timeseries",{...dailyInput,platforms:["META"],cursor:first.nextCursor});
      assert.equal(changed.status,409);
    });
    await t.test("stage10 HTTP p95, RSS, connection load, execution plans and timeout recovery", {skip:process.env.UNIFIED_STAGE10PERF_QUICK === "1"}, async () => {
      const observations: any = { synthetic: true, remoteWrites: 0, date: new Date().toISOString(), samples: [],
        fixture: { dates: "2026-06-17..2026-09-28 (104 days, 2 Naver dates absent)", range366Density: "sparse; dense 366-day domain evidence is separate", publications: await owner.unifiedSourcePublication.count(), facts: await owner.unifiedDailyFact.count(), coverage: await owner.unifiedSourceCoverage.count() },
        memoryBefore: process.memoryUsage(), memoryPeakSampled: process.memoryUsage(), connectionPeakSampled: 0, plans: {} };
      let sampling: Promise<void> = Promise.resolve();
      const sample = async () => {
        const usage = process.memoryUsage();
        if (usage.rss > observations.memoryPeakSampled.rss) observations.memoryPeakSampled = usage;
        const rows = await owner.$queryRaw<Array<{ connections: bigint }>>`SELECT count(*) connections FROM pg_stat_activity WHERE datname=current_database()`;
        observations.connectionPeakSampled = Math.max(observations.connectionPeakSampled, Number(rows[0].connections));
      };
      const interval = setInterval(() => { sampling = sampling.then(sample); }, 20);
      const distribution = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return {
        count: values.length, p50Ms: sorted[Math.ceil(sorted.length * .50)-1], p95Ms: sorted[Math.ceil(sorted.length * .95)-1], maxMs: sorted.at(-1), valuesMs: values }; };
      const timed = async (endpoint: string, days: number) => {
        const start = performance.now();
        const result = await get(endpoint, { ...input, from: shiftDate(to, -(days-1)), to, compareFrom: shiftDate(to, -(2*days-1)), compareTo: shiftDate(to, -days),
          platforms: ["META","GOOGLE","CAFE24","COUPANG","NAVER"] });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return performance.now()-start;
      };
      try {
        for (const days of [1,7,30,90,366]) for (const endpoint of ["summary","timeseries","diagnostics","relationships"]) {
          await timed(endpoint, days); // warm-up excluded
          const values: number[] = [];
          for (let repeat=0;repeat<10;repeat++) values.push(await timed(endpoint,days));
          observations.samples.push({ endpoint, days, concurrency: 1, ...distribution(values) });
        }
        for (const days of [30,366]) for (const endpoint of ["summary","relationships"]) {
          const values: number[] = [];
          for (let batch=0;batch<5;batch++) values.push(...await Promise.all(Array.from({length:4}, () => timed(endpoint,days))));
          observations.samples.push({endpoint, days, concurrency:4, ...distribution(values)});
        }
        const planQueries: Record<string,string> = {
          publication: "SELECT p.*,r.status FROM meta_ads.unified_source_publications p JOIN meta_ads.unified_aggregation_runs r ON r.id=p.run_id WHERE p.platform='META' AND p.scope_key='88888888-8888-4888-8888-888888888881' AND p.business_date BETWEEN '2026-07-01' AND '2026-09-28' ORDER BY p.platform,p.scope_key,p.business_date,p.source_system",
          facts: "SELECT * FROM meta_ads.unified_daily_facts WHERE run_id IN (SELECT run_id FROM meta_ads.unified_source_publications WHERE business_date BETWEEN '2026-07-01' AND '2026-09-28') AND product_name='정확 금액 <검토제품>' LIMIT 100001",
          coverage: "SELECT * FROM meta_ads.unified_source_coverage WHERE run_id IN (SELECT run_id FROM meta_ads.unified_source_publications WHERE business_date BETWEEN '2026-07-01' AND '2026-09-28') LIMIT 80001",
          failure: "SELECT id,platform,scope_key,business_date FROM meta_ads.unified_aggregation_runs WHERE platform='META' AND scope_key='88888888-8888-4888-8888-888888888881' AND business_date BETWEEN '2026-07-01' AND '2026-09-28' AND (status='FAILED' OR (status='STAGING' AND attempts>0 AND lease_expires_at<=now())) ORDER BY started_at DESC LIMIT 20001"
        };
        await owner.$executeRawUnsafe('ANALYZE');
        for (const [key,sql] of Object.entries(planQueries)) observations.plans[key] = await viewer.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql);
        observations.planScope = "Fixed representative SELECT shapes with EXPLAIN ANALYZE BUFFERS; not exact Prisma emitted SQL. Owner ANALYZE, plans execute as non-owner viewer.";
        observations.serverSettings = await owner.$queryRaw`SELECT name,setting,unit FROM pg_settings WHERE name IN ('max_connections','statement_timeout','lock_timeout','idle_in_transaction_session_timeout','shared_buffers')`;
        const timeoutStart = performance.now();
        await assert.rejects(viewer.$transaction(async tx => {
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout='50ms'");
          await tx.$queryRawUnsafe("SELECT pg_sleep(0.2)::text");
        }), /statement timeout/);
        observations.statementTimeout = { configuredMs:50, elapsedMs:performance.now()-timeoutStart, recovered: (await get('summary',input)).status===200 };
        assert(observations.statementTimeout.recovered);
        observations.memoryAfter=process.memoryUsage();
        observations.goalMs=2000;
        observations.slowCases=observations.samples.filter((row:any)=>row.p95Ms>2000).map((row:any)=>({endpoint:row.endpoint,days:row.days,concurrency:row.concurrency,p95Ms:row.p95Ms}));
      } finally {
        clearInterval(interval); await sampling; await sample();
        writeFileSync('docs/product-performance/research/10-performance-metrics.json', JSON.stringify(observations,null,2)+'\n');
      }
    });
    if (browserMode) await new Promise<void>(resolve => {
      releaseBrowser = resolve;
      console.log("STAGE10PERF_BROWSER_READY http://127.0.0.1:4199/api synthetic-viewer read-only; POST /api/__stage10perf/stop to release HTTP and PG");
    });
  } finally { await app.close(); await Promise.all([owner.$disconnect(), viewer.$disconnect()]); }
});
