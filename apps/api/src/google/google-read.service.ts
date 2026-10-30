import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, SourceDataKind } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { parseDateRange } from "../common/date-range";
import { createSourceReadContext, selectCurrentSourceRows, sourceApiDaysInContext } from "../common/source-read-policy";
import { findEffectiveRuleForDate } from "../domain/effective-rule";
import { assertGoogleEnabled, googleBound, googleConnection } from "./google-access";
import { GoogleQuery } from "./google.dto";
import { calculateGooglePerformance, GoogleSaleLine } from "./google-performance";
import { resolveGoogleSaleConfiguration } from "./google-sale-configuration";
import { createGoogleCampaignMatcher } from "./google-campaign-matcher";
import { toCafe24MatcherRules } from "../daily-sync/cafe24-rule-loader";
import { createGoogleSaleMatcher } from "./google-sale-matcher";

const day = (value: Date) => value.toISOString().slice(0, 10);
const number = (value: Prisma.Decimal | null | undefined) => value == null ? null : value.toNumber();
const D = Prisma.Decimal.clone({ precision: 80 });
const MAX = 50_000;
function grouped<T>(rows: T[], key: (row: T) => string) {
  const result = new Map<string, T[]>();
  for (const row of rows) { const id = key(row); const bucket = result.get(id) ?? []; bucket.push(row); result.set(id, bucket); }
  return result;
}
/** Only already source-selected legacy CSV may use the sole configured shop.
 * Query filters must never turn a multi-shop installation into a guessed owner. */
export function legacyGoogleSaleConnection(line: { connectionId: string | null; source: string },
  allCafe24Connections: readonly { id: string }[]) {
  return line.connectionId ?? (line.source === "CSV" && allCafe24Connections.length === 1
    ? allCafe24Connections[0].id : null);
}
export function googleRange(query: GoogleQuery) {
  if (!!query.from !== !!query.to) throw new BadRequestException("시작일과 종료일을 함께 지정해 주세요.");
  const yesterday = new Date(Date.now() + 9 * 3_600_000 - 86_400_000);
  const range = parseDateRange(query.from ?? day(new Date(yesterday.getTime() - 91 * 86_400_000)), query.to ?? day(yesterday));
  if ((range.toDate.getTime() - range.fromDate.getTime()) / 86_400_000 >= 92)
    throw new BadRequestException({ code: "GOOGLE_RANGE_LIMIT", message: "최대 92일을 선택해 주세요." });
  return range;
}
export type GoogleCoverage = { connectionId: string; provider: string; date: string; selectedSource: string | null;
  complete: boolean; state: string; rowCount: number | null; amount: string | null;
  lastSuccessAt: string | null; lastAttemptAt: string | null; warningCodes: string[] };

@Injectable()
export class GoogleReadService {
  constructor(private readonly prisma: PrismaService) {}

  async options() {
    const enabled = process.env.GOOGLE_PERFORMANCE_ENABLED === "true";
    if (!enabled) return { enabled, connections: [], products: [] };
    const [connections, products] = await Promise.all([
      this.prisma.sourceConnection.findMany({ where: { provider: { in: ["GOOGLE", "CAFE24"] } },
        select: { id: true, provider: true, displayName: true, externalAccountId: true, currencyCode: true, timeZone: true },
        orderBy: { id: "asc" }, take: 101 }),
      this.prisma.product.findMany({ where: { isActive: true }, select: { id: true, displayName: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 10_001 })
    ]);
    googleBound(connections, 100); googleBound(products, 10_000);
    return { enabled, connections, products };
  }

  async report(query: GoogleQuery, mode: "summary" | "profit" | "campaigns" = "summary") {
    assertGoogleEnabled();
    const range = googleRange(query);
    return this.prisma.$transaction(tx => this.read(tx, query, range, mode), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000
    });
  }

  private async read(tx: Prisma.TransactionClient, query: GoogleQuery, range: ReturnType<typeof googleRange>, mode: string) {
    if (query.connectionId) await googleConnection(tx, query.connectionId, "GOOGLE");
    if (query.cafe24ConnectionId) await googleConnection(tx, query.cafe24ConnectionId, "CAFE24");
    if (query.productId && !await tx.product.findFirst({ where: { id: query.productId, isActive: true }, select: { id: true } }))
      throw new NotFoundException("활성 상품을 찾을 수 없습니다.");
    const connections = await tx.sourceConnection.findMany({ where: { OR: [
      { provider: "GOOGLE", ...(query.connectionId ? { id: query.connectionId } : {}) },
      { provider: "CAFE24", ...(query.cafe24ConnectionId ? { id: query.cafe24ConnectionId } : {}) }
    ] }, select: { id: true, provider: true, displayName: true, externalAccountId: true, currencyCode: true, timeZone: true }, take: 101 });
    googleBound(connections, 100);
    const ids = connections.map(c => c.id), googleIds = connections.filter(c => c.provider === "GOOGLE").map(c => c.id);
    const dateWhere = { gte: range.fromDate, lte: range.toDate };
    const [coverageRows, policies, adCandidates, batches, rates, costs, saleRules, products, couponRules] = await Promise.all([
      tx.sourceCoverage.findMany({ where: { connectionId: { in: ids }, metricDate: dateWhere }, take: MAX + 1 }),
      // Keep all policies in the context: unbound legacy CSV rows must not evade another account's primary source.
      tx.sourcePolicy.findMany({ where: { dataKind: { in: ["GOOGLE_CAMPAIGN", "CAFE24_ORDER"] }, fromDate: { lte: range.toDate },
        OR: [{ toDate: null }, { toDate: { gt: range.fromDate } }] }, take: 10_001 }),
      tx.googleCampaignDailyCost.findMany({ where: { connectionId: { in: googleIds }, isCurrent: true, metricDate: dateWhere },
        orderBy: [{ metricDate: "asc" }, { id: "asc" }], take: MAX + 1 }),
      tx.cafe24UploadBatch.findMany({ where: { status: { in: ["IMPORTED", "PARTIAL"] },
        OR: [{ orderStart: null }, { orderEnd: null }, { orderStart: { lte: range.toDate }, orderEnd: { gte: range.fromDate } }] },
        select: { id: true, rowCount: true, _count: { select: { rows: true } } }, take: 10_001 }),
      tx.exchangeRate.findMany({ where: { rateDate: dateWhere, quoteCurrency: "KRW", provider: "KOREA_EXIM" }, take: MAX + 1 }),
      tx.productCostRule.findMany({ where: { effectiveFrom: { lte: range.toDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: range.fromDate } }] },
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: 10_001 }),
      tx.cafe24ProductRule.findMany({ where: { isActive: true, product: { is: { isActive: true } }, validFrom: { lte: range.toDate },
        OR: [{ validTo: null }, { validTo: { gte: range.fromDate } }] },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }], take: 10_001 }),
      tx.product.findMany({ where: { isActive: true }, select: { id: true, displayName: true, name: true }, take: 10_001 }),
      tx.cafe24CouponRule.findMany({ where: { isActive: true, validFrom: { lte: range.toDate }, OR: [{ validTo: null }, { validTo: { gte: range.fromDate } }] },
        orderBy: [{ priority: "asc" }, { validFrom: "desc" }, { createdAt: "desc" }], take: 10_001 })
    ]);
    [coverageRows, adCandidates, rates].forEach(r => googleBound(r));
    [policies, batches, costs, saleRules, products, couponRules].forEach(r => googleBound(r, 10_000));
    const cafeCandidates = await tx.cafe24OrderLine.findMany({ where: { isCurrent: true, orderDate: dateWhere,
      ...(query.cafe24ConnectionId ? { connectionId: query.cafe24ConnectionId } : {}), validationStatus: { not: "ERROR" },
      OR: [{ source: "CSV", uploadBatchId: { in: batches.filter(b => b.rowCount === b._count.rows).map(b => b.id) } },
        { source: "API", uploadBatchId: null, connectionId: { in: connections.filter(c => c.provider === "CAFE24").map(c => c.id) } }]
    }, include: { product: true, matchRule: true }, orderBy: [{ orderDate: "asc" }, { id: "asc" }], take: MAX + 1 });
    googleBound(cafeCandidates);
    const context = createSourceReadContext(tx, range.fromDate, range.toDate, policies, coverageRows);
    const failedKinds = new Set<string>();
    const select = async <T extends { source: "CSV" | "API"; connectionId: string | null }>(kind: SourceDataKind, rows: T[], dateOf: (r: T) => Date | null) => {
      try { return await selectCurrentSourceRows(tx, kind, rows, dateOf, context); }
      catch (error) { if (!(error instanceof ConflictException)) throw error; failedKinds.add(kind); return [] as T[]; }
    };
    const [selectedAds, cafe] = await Promise.all([select("GOOGLE_CAMPAIGN", adCandidates, r => r.metricDate),
      select("CAFE24_ORDER", cafeCandidates, r => r.orderDate)]);
    const adsByDay = grouped(selectedAds, r => `${r.connectionId}:${day(r.metricDate)}`);
    const cafeByDay = grouped(cafe, r => `${r.connectionId}:${r.orderDate ? day(r.orderDate) : ""}`);
    const policiesByKind = grouped(policies, r => `${r.connectionId}:${r.dataKind}`);
    const coverageByDay = new Map(coverageRows.map(r => [`${r.connectionId}:${r.dataKind}:${day(r.metricDate)}`, r]));
    const runIds = [...new Set(coverageRows.filter(c => c.dataKind === "GOOGLE_CAMPAIGN" && c.lastSuccessRunId).map(c => c.lastSuccessRunId!))];
    const units = runIds.length ? await tx.runUnit.findMany({ where: { runId: { in: runIds }, status: "SUCCEEDED" },
      include: { run: { select: { connectionId: true } } }, take: MAX + 1 }) : [];
    googleBound(units);
    const unitsByDay = grouped(units, r => `${r.run.connectionId}:${r.runId}:${r.unitKey}`);
    const links = selectedAds.length ? await tx.sourceRecordLink.findMany({ where: {
      connectionId: { in: googleIds }, dataKind: "GOOGLE_CAMPAIGN", source: "API", recordTable: "google_campaign_daily_costs",
      recordId: { in: selectedAds.map(r => r.id) }, isCurrent: true
    }, take: MAX + 1 }) : [];
    googleBound(links);
    const linked = new Map(links.map(link => [link.recordId, link]));
    const feature = process.env.DAILY_SYNC_FEATURE_ENABLED === "true";
    const cafeApiDays = feature ? await sourceApiDaysInContext(tx, "CAFE24_ORDER", range.fromDate, range.toDate, context) : new Set<string>();
    const dates: string[] = [];
    for (let t = range.fromDate.getTime(); t <= range.toDate.getTime(); t += 86_400_000) dates.push(day(new Date(t)));
    const coverage: GoogleCoverage[] = [];
    const validGoogleDays = new Set<string>();
    for (const c of connections) for (const date of dates) {
      const kind = c.provider === "GOOGLE" ? "GOOGLE_CAMPAIGN" : "CAFE24_ORDER";
      const ps = (policiesByKind.get(`${c.id}:${kind}`) ?? []).filter(p => day(p.fromDate) <= date && (!p.toDate || date < day(p.toDate)));
      const source = feature ? ps.length === 1 ? ps[0].primarySource : null : "CSV";
      const stored = coverageByDay.get(`${c.id}:${kind}:${date}`);
      const rows = c.provider === "GOOGLE" ? adsByDay.get(`${c.id}:${date}`) ?? [] : cafeByDay.get(`${c.id}:${date}`) ?? [];
      let complete = source === "CSV" ? rows.length > 0 : source === "API" && !!stored?.lastSuccessRunId && !!stored.lastSuccessAt && stored.source === source && stored.rowCount === rows.length;
      if (source === "API" && c.provider === "GOOGLE" && complete) {
        const ads = adsByDay.get(`${c.id}:${date}`) ?? [];
        const matches = unitsByDay.get(`${c.id}:${stored!.lastSuccessRunId}:${date}`) ?? [];
        // An unchanged D-7 reread advances coverage but preserves each fact's original run/version.
        complete = ads.every(r => { const link = linked.get(r.id); return link?.connectionId === r.connectionId &&
          link.version === r.version && link.syncRunId === r.syncRunId; }) && stored!.totalAmount !== null &&
          ads.reduce((sum, r) => sum.plus(r.costMicros.toString()), new D(0)).div(1_000_000).equals(stored!.totalAmount!) &&
          matches.length === 1 && matches[0].publishedCount === stored!.rowCount;
      }
      if (source === "API" && c.provider === "CAFE24") complete &&= cafeApiDays.has(`${c.id}:${new Date(date).getTime()}`);
      complete &&= !failedKinds.has(kind);
      if (complete && c.provider === "GOOGLE") validGoogleDays.add(`${c.id}:${date}`);
      coverage.push({ connectionId: c.id, provider: c.provider, date, selectedSource: source, complete,
        state: stored?.source === source ? stored.state : rows.length ? "COMPLETE_NONZERO" : "NOT_COLLECTED",
        rowCount: stored?.source === source ? stored.rowCount : rows.length || null,
        amount: stored?.source === source ? stored.totalAmount?.toString() ?? null : null,
        lastSuccessAt: stored?.source === source ? stored.lastSuccessAt?.toISOString() ?? null : null,
        lastAttemptAt: stored?.lastAttemptAt?.toISOString() ?? null,
        warningCodes: [...(stored?.warningCodes ?? []), ...(failedKinds.has(kind) || !source ? ["SOURCE_SELECTION_REQUIRED"] : [])] });
    }
    const allDays = dates.map(date => ({ date,
      googleComplete: coverage.some(c => c.provider === "GOOGLE" && c.date === date) && coverage.filter(c => c.provider === "GOOGLE" && c.date === date).every(c => c.complete),
      cafe24Complete: coverage.some(c => c.provider === "CAFE24" && c.date === date) ? coverage.filter(c => c.provider === "CAFE24" && c.date === date).every(c => c.complete)
        : cafe.some(c => c.orderDate && day(c.orderDate) === date) }));
    // Default to the latest contiguous, mutually verified window (up to 30 days).
    let activeDays = allDays;
    if (!query.from) {
      let end = -1;
      allDays.forEach((d, index) => { if (d.googleComplete && d.cafe24Complete) end = index; });
      let start = end;
      while (start > 0 && end - start < 29 && allDays[start - 1].googleComplete && allDays[start - 1].cafe24Complete) start--;
      activeDays = end >= 0 ? allDays.slice(start, end + 1) : allDays.slice(-1);
    }
    const activeDates = new Set(activeDays.map(d => d.date));
    const selectedCafe = cafe.filter(c => c.orderDate && activeDates.has(day(c.orderDate)));
    const selectedIds = new Set(selectedCafe.map(c => c.id));
    const csvBatchIds = [...new Set(selectedCafe.flatMap(c => c.uploadBatchId ? [c.uploadBatchId] : []))];
    const siblings = csvBatchIds.length ? await tx.cafe24OrderLine.findMany({ where: { uploadBatchId: { in: csvBatchIds },
      OR: [{ isCurrent: true }, { validationStatus: "ERROR" }] }, include: { product: true, matchRule: true }, take: MAX + 1 }) : [];
    googleBound(siblings);
    const orderKey = (r: { source: string; connectionId: string | null; uploadBatchId: string | null; orderNo: string }) => `${r.source}:${r.uploadBatchId ?? r.connectionId}:${r.orderNo}`;
    const selectedOrders = new Set(selectedCafe.map(orderKey));
    const contextLines = [...selectedCafe, ...siblings.filter(r => !selectedIds.has(r.id) && selectedOrders.has(orderKey(r)))];
    const activeProducts = new Map(products.map(p => [p.id, p.displayName]));
    const matchSale = createGoogleSaleMatcher(toCafe24MatcherRules(saleRules), products);
    const saleRulesById = new Map(saleRules.map(rule => [rule.id, rule]));
    const costsByProduct = grouped(costs, c => c.productId);
    const connectionsById = new Map(connections.map(c => [c.id, c]));
    const ratesByDay = new Map(rates.map(r => [`${day(r.rateDate)}:${r.baseCurrency}`, r]));
    const salesLines: GoogleSaleLine[] = contextLines.map(line => {
      const date = line.orderDate ? day(line.orderDate) : activeDays[0].date;
      // Resolve at read time so existing unmatched sales and later common-setting edits
      // take effect without rewriting source facts or creating Google-only overrides.
      const sharedMatch = line.productName.includes("[유튜브]") ? matchSale(line) : null;
      const mapped = sharedMatch ? sharedMatch.productId : line.productId;
      const productId = mapped && activeProducts.has(mapped) ? mapped : null;
      const rule = productId ? findEffectiveRuleForDate(costsByProduct.get(productId) ?? [], new Date(date)) : null;
      const match = sharedMatch ? saleRulesById.get(sharedMatch.matchRuleId ?? "") ?? null
        : productId === line.productId ? line.matchRule : null;
      const configuration = resolveGoogleSaleConfiguration(line.quantity.toNumber(), rule, match);
      const ps = (policiesByKind.get(`${line.connectionId}:CAFE24_ORDER`) ?? []).filter(p => p.primarySource === "API" && day(p.fromDate) <= date && (!p.toDate || date < day(p.toDate)));
      const apiBasis = ps.length === 1 && ps[0].couponInputSource === "API_ACTUAL_PRODUCT_PLUS_SHIPPING";
      return { id: line.id, orderNo: `${line.source}:${line.connectionId ?? "legacy"}:${line.orderNo}`, connectionId: line.connectionId, date, productId, productName: line.productName,
        ...configuration, collectedSalePriceKrw: line.salePriceKrw.toNumber(), includeInSales: selectedIds.has(line.id),
        couponInput: { orderDate: line.orderDate, paymentMethod: line.paymentMethod, source: line.source, providerCouponSignal: line.providerCouponSignal,
          totalOrderInputSource: line.source === "CSV" ? "CSV_TOTAL_ORDER" : apiBasis ? "API_ACTUAL_PRODUCT_PLUS_SHIPPING" : "UNKNOWN",
          totalOrderKrw: line.source === "CSV" ? number(line.totalOrderKrw) : apiBasis && line.actualOrderPriceKrw && line.actualShippingFeeKrw
            ? line.actualOrderPriceKrw.plus(line.actualShippingFeeKrw).toNumber() : null,
          totalPaidKrw: number(line.totalPaidKrw), productId, salePriceKrw: line.salePriceKrw.toNumber(), quantity: line.quantity.toNumber(), isValid: line.validationStatus !== "ERROR" } };
    });
    const matchCampaign = createGoogleCampaignMatcher(products);
    const adMetrics = selectedAds.filter(a => activeDates.has(day(a.metricDate)) && validGoogleDays.has(`${a.connectionId}:${day(a.metricDate)}`)).map(a => {
      const connection = connectionsById.get(a.connectionId)!;
      const date = day(a.metricDate);
      const match = matchCampaign(a.campaignName);
      const rate = ratesByDay.get(`${date}:${connection.currencyCode}`);
      return { id: a.id, date, connectionId: a.connectionId, customerId: connection.externalAccountId,
        campaignId: a.campaignId, campaignName: a.campaignName, currencyCode: connection.currencyCode,
        timeZone: connection.timeZone, costMicros: a.costMicros.toString(), impressions: Number(a.impressions), clicks: Number(a.clicks),
        productId: match.productId, warningCodes: match.warningCodes,
        exchangeRateKrw: rate?.rate.toString() ?? null };
    });
    const warnings: string[] = [];
    if (connections.some(c => c.provider === "GOOGLE" && c.timeZone !== "Asia/Seoul")) warnings.push("TIME_ZONE_MISMATCH");
    if (connections.some(c => c.provider === "CAFE24" && c.timeZone !== "Asia/Seoul")) warnings.push("CAFE24_TIME_ZONE_MISMATCH");
    if (connections.some(c => c.provider === "CAFE24" && c.currencyCode !== "KRW")) warnings.push("CAFE24_CURRENCY_MISMATCH");
    if (failedKinds.size) warnings.push("SOURCE_SELECTION_REQUIRED");
    const result = calculateGooglePerformance({ salesLines, adMetrics, days: activeDays, warnings, productId: query.productId,
      couponRules: couponRules.map(r => ({ ...r, discountKrw: r.discountKrw.toNumber() })) });
    const page = query.page ?? 1, pageSize = query.pageSize ?? 50;
    const paged = <T>(rows: T[]) => rows.slice((page - 1) * pageSize, page * pageSize);
    const namedProducts = result.products.map(p => ({ ...p, productName: p.productId ? activeProducts.get(p.productId) ?? null : null }));
    const cafeById = new Map(selectedCafe.map(c => [c.id, c]));
    return { ...result, unmappedSales: result.unmappedSales.map(row => { const original = cafeById.get(row.id);
      return { ...row, productNo: original?.productNo ?? null, optionName: original?.optionName ?? null }; }),
      range: { from: activeDays[0].date, to: activeDays[activeDays.length - 1].date },
      products: paged(namedProducts), campaigns: paged(result.campaigns),
      daily: result.daily.map(p => ({ ...p, productName: p.productId ? activeProducts.get(p.productId) ?? null : null })),
      coverage: coverage.filter(c => activeDates.has(c.date)),
      pagination: { page, pageSize, total: mode === "campaigns" ? result.campaigns.length : result.products.length },
      notices: ["설정 판매가와 기존 비용 규칙 기준입니다. 실제 결제액 또는 Google 클릭 전환 매출이 아닙니다.",
        "Meta와 Google의 매출·마진을 합산하면 중복될 수 있습니다.", "취소·반품은 기존 수집 필터 범위이며 실제 환불액을 별도 차감하지 않습니다."] };
  }
}
