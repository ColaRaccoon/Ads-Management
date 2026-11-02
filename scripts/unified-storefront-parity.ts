import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { databaseUrlWithConnectionLimit, type PrismaService } from "../apps/api/src/common/prisma.service";
import { parseDateRange } from "../apps/api/src/common/date-range";
import { SalesMetricsService } from "../apps/api/src/sales/sales-metrics.service";
import { GoogleReadService } from "../apps/api/src/google/google-read.service";
import { aggregationAdapterRequest, aggregationWorkerDatabaseUrl, completeSourceCoverage } from "../apps/api/src/unified-performance/aggregation.worker";
import { assertReconciliationRole } from "../apps/api/src/unified-performance/reconciliation-entrypoint";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { UnifiedReportRepository } from "../apps/api/src/unified-performance/report.repository";
import { prepareReportBatch, scopePolicyComponents, summarizeReport } from "../apps/api/src/unified-performance/domain/report-calculation";
import { PLATFORM_COMPONENTS } from "../apps/api/src/unified-performance/domain/platform-selection";
import { parseReportQuery } from "../apps/api/src/unified-performance/report-query";
import type { PublishedReportFact } from "../apps/api/src/unified-performance/report-contract";
import type { AdapterBatch, Platform, SaleFact, SourceCoverage } from "../apps/api/src/unified-performance/types";
import { Cafe24PerformanceAdapter } from "../apps/api/src/unified-performance/adapters/cafe24.adapter";
import { MetaPerformanceAdapter } from "../apps/api/src/unified-performance/adapters/meta.adapter";
import { GooglePerformanceAdapter } from "../apps/api/src/unified-performance/adapters/google.adapter";

// Explicit maintenance diagnostic only. No queue, writes, publication, raw rows,
// source IDs, product names, order numbers, credentials or error text are emitted.
// Native and unified use their existing distinct runtime roles. Each transaction
// is read-only/repeatable-read; the output records their separate observation times.
const target = join(tmpdir(), "unified-storefront-parity-result.json");
let phase = "SETUP";
type NativeLine = Prisma.Cafe24OrderLineGetPayload<{ include: { product: true; matchRule: true } }>;
type NativeCost = Prisma.ProductCostRuleGetPayload<Record<string, never>>;
type NativeSubtotal = { revenueKrw: number; grossCostKrw: number; quantity: number; missingCostRule: boolean };
type NativeBridge = {
  cafe24SalesLines(range: ReturnType<typeof parseDateRange>): Promise<{ salesLines: NativeLine[] }>;
  aggregateSales(lines: NativeLine[], costs: Map<string, NativeCost[]>, date: Date,
    coupons: Map<string, never>): Map<string, NativeSubtotal>;
};
const D = Prisma.Decimal.clone({ precision: 80 });
const sum = (values: readonly (string | number | null | undefined)[]) => {
  const known = values.filter((value): value is string | number => value != null);
  return known.length ? known.reduce<Prisma.Decimal>((total, value) => total.plus(value), new D(0)).toFixed(6) : null;
};
const difference = (a: string | number | null | undefined, b: string | number | null | undefined) =>
  a == null || b == null ? null : new D(a).minus(b).toFixed(6);
const matched = (line: NativeLine) => Boolean(line.productId && line.product?.isActive !== false && line.product);
const youtube = (line: { productName: string }) => line.productName.includes("[유튜브]");
const sourceKey = (line: NativeLine) => JSON.stringify([line.connectionId ?? "LEGACY_UNBOUND", `${line.source}:${line.orderLineKey}`]);
const saleKey = (sale: SaleFact) => JSON.stringify([sale.ref.scopeKey, sale.ref.sourceRecordKey]);
const issues = (values: readonly string[]) => [...new Set(values.filter(value => /^[A-Z][A-Z0-9_:.-]{0,127}$/.test(value)))].sort();

// Delegate existing services' nested transaction callbacks into this transaction.
// Read-only is set before any service/adapter is constructed or invoked.
function transactionFacade(tx: Prisma.TransactionClient): PrismaService {
  return new Proxy(tx, { get(object, property) {
    if (property === "$transaction") return <T>(work: (client: Prisma.TransactionClient) => Promise<T>) => work(tx);
    const value = Reflect.get(object, property);
    return typeof value === "function" ? value.bind(object) : value;
  } }) as unknown as PrismaService;
}
async function readOnly<T>(client: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return client.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '30000ms'`;
    return work(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10000, timeout: 180000 });
}
function saleAggregate(sales: readonly SaleFact[]) {
  const component = (kind: string) => sum(sales.flatMap(sale => sale.costComponents.filter(row => row.kind === kind).map(row => row.amount)));
  return { rows: sales.length, knownRevenueRows: sales.filter(row => row.operatingRevenue !== null).length,
    knownProfitRows: sales.filter(row => row.profitBeforeAds !== null).length,
    netRevenue: sum(sales.map(row => row.operatingRevenue)), registeredGross: component("REGISTERED_GROSS_BEFORE_COUPON"),
    sourceGross: component("SOURCE_LIST_PRICE_GROSS_REFERENCE"), coupon: component("COUPON"),
    productCost: sum(sales.map(row => row.productCost)), shipping: sum(sales.map(row => row.directShippingCost)),
    otherCost: sum(sales.map(row => row.otherDirectCost)), vat: sum(sales.map(row => row.vatExpense)),
    profitBeforeAds: sum(sales.map(row => row.profitBeforeAds)), issueCodes: issues(sales.flatMap(row => row.quality.issues)) };
}

export async function runStorefrontParity(args = process.argv.slice(2)) {
  if (args.length > 1 || args.some(value => !/^--date=\d{4}-\d{2}-\d{2}$/.test(value))) throw Error("INVALID_PARITY_ARGUMENTS");
  const date = args[0]?.slice(7) ?? "2026-11-01", range = parseDateRange(date, date);
  if (range.from !== date || range.to !== date) throw Error("INVALID_PARITY_DATE");
  if (!["true", "false"].includes(process.env.DAILY_SYNC_FEATURE_ENABLED ?? "") || process.env.GOOGLE_PERFORMANCE_ENABLED !== "true")
    throw Error("PARITY_SOURCE_POLICY_REQUIRED");
  const nativeUrl = process.env.DATABASE_URL;
  if (!nativeUrl || decodeURIComponent(new URL(nativeUrl).username).split(".")[0] !== "meta_ads_prod_runtime") throw Error("PARITY_NATIVE_ROLE_REQUIRED");
  const nativeClient = new PrismaClient({ datasourceUrl: databaseUrlWithConnectionLimit(nativeUrl, "1") });
  const workerClient = new PrismaClient({ datasourceUrl: databaseUrlWithConnectionLimit(aggregationWorkerDatabaseUrl(), "1") });
  try {
    phase = "NATIVE_READ";
    const native = await readOnly(nativeClient, async tx => {
      const [role] = await tx.$queryRaw<Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT current_user role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      if (!role || role.role !== "meta_ads_prod_runtime" || role.rolsuper || role.rolbypassrls) throw Error("PARITY_NATIVE_ROLE_REQUIRED");
      const facade = transactionFacade(tx), service = new SalesMetricsService(facade);
      const bridge = service as unknown as NativeBridge;
      const result = await service.productPerformance({ from: date, to: date });
      const selected = await bridge.cafe24SalesLines(range);
      const costs = await tx.productCostRule.findMany({ where: { productId: { in: [...new Set(selected.salesLines.flatMap(line => line.productId ? [line.productId] : []))] } },
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }] });
      const groupedCosts = new Map<string, NativeCost[]>();
      for (const cost of costs) groupedCosts.set(cost.productId, [...groupedCosts.get(cost.productId) ?? [], cost]);
      const subtotal = (lines: NativeLine[]) => {
        const rows = [...bridge.aggregateSales(lines, groupedCosts, range.fromDate, new Map<string, never>()).values()];
        return { rows: lines.length, matchedRows: lines.filter(matched).length, quantity: sum(rows.map(row => row.quantity)),
          sourceListGross: sum(lines.map(line => line.salePriceKrw.mul(line.quantity).toFixed())),
          revenue: sum(rows.map(row => row.revenueKrw)), grossCost: sum(rows.map(row => row.grossCostKrw)),
          missingCostProducts: rows.filter(row => row.missingCostRule).length };
      };
      const google = await new GoogleReadService(facade).report({ from: date, to: date, page: 1, pageSize: 100 }, "profit");
      return { observedAt: new Date().toISOString(), result, google, lines: selected.salesLines, subtotal,
        all: subtotal(selected.salesLines), youtube: subtotal(selected.salesLines.filter(youtube)),
        youtubeUnmatched: subtotal(selected.salesLines.filter(line => youtube(line) && !matched(line))),
        nonYoutube: subtotal(selected.salesLines.filter(line => !youtube(line))) };
    });
    // Native subtotal is pure and only uses the already-loaded source/config rows.
    phase = "UNIFIED_READ";
    const unified = await readOnly(workerClient, async tx => {
      const [role] = await tx.$queryRaw<Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; owns: bigint }>>`
        SELECT current_user role,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,
          (SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
      assertReconciliationRole(role);
      const facade = transactionFacade(tx), management = new UnifiedManagementRepository(facade), repository = new UnifiedReportRepository(management);
      const platforms: Platform[] = ["CAFE24", "META", "GOOGLE"], scopes = await repository.access(platforms), config = await management.snapshot(tx);
      const adapters = { CAFE24: new Cafe24PerformanceAdapter(facade, management), META: new MetaPerformanceAdapter(facade, management), GOOGLE: new GooglePerformanceAdapter(facade, management) };
      const facts: PublishedReportFact[] = [], coverage: SourceCoverage[] = [], sales: SaleFact[] = [], batches: AdapterBatch[] = [];
      for (const scope of scopes) {
        if (scope.platform !== "CAFE24" && scope.platform !== "META" && scope.platform !== "GOOGLE") continue;
        const claim = { ...scope, date, runId: randomUUID(), token: "readonly-parity", previousRunId: null };
        const request = aggregationAdapterRequest(claim, config.versions);
        request.sourcePolicySnapshot.participationOverrides = Object.fromEntries(config.products.filter(product => config.rules.some(rule =>
          rule.kind === "SCOPE_POLICY" && rule.active && rule.productId === product.id)).map(product => [product.canonicalName,
            scopePolicyComponents(config.rules, product.id, scope.platform, scope.scopeKey, date, PLATFORM_COMPONENTS[scope.platform])]));
        const batch = completeSourceCoverage(claim, await adapters[scope.platform].read(request));
        batches.push(batch); sales.push(...batch.sales); coverage.push(...batch.coverage);
        facts.push(...prepareReportBatch(request, batch, config.rules).map(fact => ({ ...fact, platform: scope.platform, scopeKey: scope.scopeKey, date })));
      }
      const published = await repository.snapshot(parseReportQuery({ from: date, to: date, compareFrom: date, compareTo: date, platforms, grain: "day" }));
      const publishedFacts = published.facts.filter(row => row.date === date), publishedCoverage = published.coverage.filter(row => row.date === date);
      return { observedAt: new Date().toISOString(), sales, publishedFacts, recomputedFacts: facts, recomputed: summarizeReport(facts, coverage, { platforms }),
        published: summarizeReport(publishedFacts, publishedCoverage, { platforms }),
        sourceQuality: platforms.map(platform => ({ platform, scopes: scopes.filter(scope => scope.platform === platform).length,
          issueCodes: issues(batches.flatMap(batch => batch.coverage.filter(row => row.platform === platform).flatMap(row => row.quality.issues))) })) };
    });
    const totals = {
      revenue: sum(native.result.rows.map(row => row.revenueKrw)), coupon: sum(native.result.rows.map(row => row.couponDeductionKrw)),
      ads: sum(native.result.rows.map(row => row.adSpendKrw)), grossCost: sum(native.result.rows.map(row => row.grossCostKrw)),
      totalCost: sum(native.result.rows.map(row => row.totalCostKrw)), margin: sum(native.result.rows.map(row => row.marginKrw)),
      incompleteMarginProducts: native.result.rows.filter(row => row.marginKrw === null).length,
      unmatchedAdSpend: native.result.summary.adUnmatchedSpendKrw };
    const nativeLineByKey = new Map(native.lines.map(line => [sourceKey(line), line]));
    const saleLines = (predicate: (line: NativeLine | undefined) => boolean) => unified.sales.filter(sale => predicate(nativeLineByKey.get(saleKey(sale))));
    const productIds = [...new Set([...native.result.rows.map(row => row.productId), ...native.lines.flatMap(line => line.productId ? [line.productId] : [])])].sort();
    const products = productIds.map((productId, index) => {
      const lines = native.lines.filter(line => line.productId === productId), nativeResult = native.result.rows.find(row => row.productId === productId);
      const sourceKeys = new Set(lines.map(sourceKey)), sales = unified.sales.filter(sale => sourceKeys.has(saleKey(sale)));
      const own = saleAggregate(sales);
      return { productOrdinal: index + 1, active: lines.some(matched), native: { ...native.subtotal(lines),
        coupon: nativeResult?.couponDeductionKrw ?? null, adSpend: nativeResult?.adSpendKrw ?? null, margin: nativeResult?.marginKrw ?? null },
        nativeYoutubeRows: lines.filter(youtube).length, unified: own,
        nativeGrossMinusUnifiedRegisteredGross: difference(nativeResult?.revenueKrw, own.registeredGross),
        nativeBeforeAds: nativeResult?.marginKrw == null || nativeResult.adSpendKrw === null ? null : sum([nativeResult.marginKrw, nativeResult.adSpendKrw]),
        unifiedMappedElsewhereRows: sales.filter(sale => lines[0]?.product?.displayName && sale.productName !== lines[0].product.displayName).length };
    });
    const unifiedBefore = unified.published.knownTotals.profitBeforeAds;
    const nativeBefore = totals.margin === null || totals.ads === null ? null : sum([totals.margin, totals.ads]);
    const googleAds = unified.published.byMedium.find(row => row.medium === "GOOGLE")?.adSpend ?? null;
    const nativeProductAds = [...native.result.rows.map(row => ({ channel: "META", name: row.product?.displayName ?? null, ads: row.adSpendKrw, profit: row.marginKrw })),
      ...native.google.products.map(row => ({ channel: "GOOGLE", name: row.productName, ads: row.adSpendKrw, profit: row.marginKrw }))];
    const adProductParity = nativeProductAds.map((row, index) => {
      const storedAds = sum(unified.recomputedFacts.filter(fact => fact.component === "AD_SPEND" && fact.medium === row.channel && fact.productName === row.name).map(fact => fact.amountKrw));
      const storedBefore = sum(unified.recomputedFacts.filter(fact => fact.component === "STOREFRONT_RESULT" && fact.rowsCount > 0 && fact.medium === row.channel && fact.productName === row.name).map(fact => fact.profitBeforeAds));
      const storedProfit = difference(storedBefore, storedAds ?? "0");
      return { ordinal: index + 1, channel: row.channel, nativeAds: row.ads, unifiedAds: storedAds,
        difference: difference(row.ads, storedAds ?? "0"), nativeProfit: row.profit, unifiedProfit: storedProfit,
        profitDifference: difference(row.profit, storedProfit) };
    });
    const output = { status: "COMPLETE", readOnly: true, date, nativeObservedAt: native.observedAt, unifiedObservedAt: unified.observedAt, adProductParity,
      separateRepeatableReadSnapshots: true, sourcePolicyEnabled: process.env.DAILY_SYNC_FEATURE_ENABLED === "true",
      native: { totals, all: native.all, youtube: native.youtube, youtubeUnmatched: native.youtubeUnmatched, nonYoutube: native.nonYoutube,
        google: { summary: { revenue: native.google.summary.revenueKrw, knownRevenue: native.google.summary.knownRevenueKrw,
          grossCost: native.google.summary.grossCostKrw, coupon: native.google.summary.couponDeductionKrw,
          ads: native.google.summary.adSpendKrw, knownAds: native.google.summary.knownAdSpendKrw,
          margin: native.google.summary.marginKrw, calculatedMargin: native.google.summary.calculatedMarginKrw,
          complete: native.google.summary.complete, lineCount: native.google.summary.lineCount },
          productCount: native.google.pagination.total, returnedProducts: native.google.products.length,
          warningCodes: native.google.completeness.warningCodes, unmappedYoutubeRows: native.google.unmappedSales.length } },
      unified: { allSales: saleAggregate(unified.sales), nativeMatchedSales: saleAggregate(saleLines(line => Boolean(line && matched(line)))),
        nativeUnmatchedSales: saleAggregate(saleLines(line => Boolean(line && !matched(line)))),
        youtube: saleAggregate(saleLines(line => Boolean(line && youtube(line)))),
        notInNativeSelection: saleAggregate(saleLines(line => !line)),
        published: { knownTotals: unified.published.knownTotals, completeTotals: unified.published.completeTotals,
          byMarketplace: unified.published.byMarketplace, byMedium: unified.published.byMedium,
          scopeBalances: unified.published.scopeBalances, issues: unified.published.issues },
        recomputed: { knownTotals: unified.recomputed.knownTotals, completeTotals: unified.recomputed.completeTotals,
          byMarketplace: unified.recomputed.byMarketplace }, sourceQuality: unified.sourceQuality },
      differences: { nativeMarginMinusPublishedUnified: difference(totals.margin, unified.published.knownTotals.estimatedProfit),
        nativeBeforeAdsMinusPublishedUnified: difference(nativeBefore, unifiedBefore), googleAds,
        nativeNetRevenueMinusPublishedUnified: difference(difference(totals.revenue, totals.coupon), unified.published.knownTotals.revenue) }, products };
    writeFileSync(target, JSON.stringify(output, null, 2) + "\n");
    return { status: output.status, date, products: products.length, readOnly: true };
  } finally { await nativeClient.$disconnect(); await workerClient.$disconnect(); }
}

if (require.main === module) runStorefrontParity().then(result => process.stdout.write(JSON.stringify(result) + "\n")).catch(error => {
  const databaseCode = typeof error?.code === "string" && /^P\d{4}$/.test(error.code) ? error.code : undefined;
  writeFileSync(target, JSON.stringify({ status: "PARITY_DIAGNOSTIC_FAILED", phase, readOnly: true, ...(databaseCode ? { databaseCode } : {}) }) + "\n");
  process.stderr.write("PARITY_DIAGNOSTIC_FAILED\n"); process.exitCode = 1;
});
