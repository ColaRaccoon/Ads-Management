import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { Prisma, SourceConnection, SourceDataKind, SyncRun } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { parseDateRange } from "../common/date-range";
import { createSourceReadContext, selectCurrentSourceRows } from "../common/source-read-policy";
import { findEffectiveRuleForDate } from "../domain/effective-rule";
import { StorefrontChannel, StorefrontCoverage, StorefrontSummary } from "./storefront.types";
import { readScheduleDefinitions } from "../daily-sync/schedule-definition";

// Do not alter Prisma.Decimal's global configuration used by legacy screens.
// 50 digits cover bounded 50k Decimal(18,4) rows, FX and bigint micros.
export const StorefrontDecimal = Prisma.Decimal.clone({ precision: 50, toExpPos: 100, toExpNeg: -100 });
const D = StorefrontDecimal;
const day = (value: Date) => value.toISOString().slice(0, 10);
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
const sum = (values: Prisma.Decimal[]) => values.reduce((a, b) => a.plus(b), new D(0));
const MAX_ROWS = 50_000;
const kindFor = { CAFE24: "CAFE24_ORDER", META: "META_ADSET", GOOGLE: "GOOGLE_CAMPAIGN" } as const;
type ConnectionRead = Pick<SourceConnection, "id" | "provider" | "displayName" | "externalAccountId" | "currencyCode" |
  "timeZone" | "accessState" | "enabled" | "updatedAt" | "credentialExpiresAt" | "credentialRef"> & {
  latestSuccessAt: Date | null; latestRunId: string | null; latestRunStatus: SyncRun["status"] | null;
  latestRunStartedAt: Date | null; latestRunSafeErrorCode: string | null;
};

// The bounded connection projection and both latest relations share the same
// RR statement; date columns remain native PostgreSQL dates, without JSON casts.
async function readConnections(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<ConnectionRead[]>(Prisma.sql`
    WITH bounded_connections AS MATERIALIZED (SELECT * FROM source_connections ORDER BY id ASC LIMIT 101)
    SELECT c.id,c.provider,c.display_name AS "displayName",c.external_account_id AS "externalAccountId",
      c.currency_code AS "currencyCode",c.time_zone AS "timeZone",c.access_state AS "accessState",c.enabled,
      c.updated_at AS "updatedAt",c.credential_expires_at AS "credentialExpiresAt",c.credential_ref AS "credentialRef",
      (SELECT MAX(v.last_success_at) FROM source_coverage v WHERE v.connection_id=c.id AND v.last_success_at IS NOT NULL) AS "latestSuccessAt",
      r.id AS "latestRunId",r.status AS "latestRunStatus",r.started_at AS "latestRunStartedAt",r.safe_error_code AS "latestRunSafeErrorCode"
    FROM bounded_connections c LEFT JOIN LATERAL (
      SELECT id,status,started_at,safe_error_code FROM sync_runs WHERE connection_id=c.id
      ORDER BY started_at DESC NULLS LAST,id DESC LIMIT 1
    ) r ON true ORDER BY c.id ASC`);
  return rows.map(row => ({ ...row, coverage: row.latestSuccessAt ? [{ lastSuccessAt: row.latestSuccessAt }] : [],
    runs: row.latestRunId ? [{ id: row.latestRunId, status: row.latestRunStatus!, startedAt: row.latestRunStartedAt, safeErrorCode: row.latestRunSafeErrorCode }] : [] }));
}

export function storefrontRange(from: string, to: string) {
  const range = parseDateRange(from, to);
  if ((range.toDate.getTime() - range.fromDate.getTime()) / 86_400_000 >= 92)
    throw new BadRequestException({ code: "STOREFRONT_RANGE_LIMIT", message: "최대 92일을 선택해 주세요." });
  return range;
}

/** Same matched-only, effective-price and 1+1 revenue projection as SalesMetrics.
 * Decimal arithmetic is kept through the public string boundary. No refund/net-sales inference. */
export function legacyRevenue(line: {
  productId: string | null; product: { isActive: boolean } | null;
  quantity: Prisma.Decimal; salePriceKrw: Prisma.Decimal;
  matchRule: { displayName: string; optionIncludeKeywords: unknown; productNameAliases: unknown;
    salePriceKrwOverride: Prisma.Decimal | null } | null;
}, cost: { salePriceKrw: Prisma.Decimal } | null) {
  if (!line.productId || !line.product || !line.product.isActive) return null;
  const rule = line.matchRule;
  const strings = (value: unknown) => Array.isArray(value) ? value.map(String).map(s => s.trim()) : [];
  const keywords = strings(rule?.optionIncludeKeywords);
  const bundle = [rule?.displayName ?? "", ...keywords, ...strings(rule?.productNameAliases)]
    .some(s => s.replace(/\s+/g, "").toLowerCase().includes("1+1")) || keywords.includes("+");
  const price = rule?.salePriceKrwOverride ?? cost?.salePriceKrw ?? line.salePriceKrw;
  const multiplier = !cost && rule?.salePriceKrwOverride == null && bundle ? 2 : 1;
  return new D(price.toString()).times(line.quantity.toString()).times(multiplier);
}

@Injectable()
export class StorefrontReadService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(from: string, to: string): Promise<StorefrontSummary> {
    const range = storefrontRange(from, to);
    // A single consistent read snapshot, with no provider calls, rate acquisition,
    // scheduler dispatch, persisted cache or timer attached to this screen.
    return this.prisma.$transaction(tx => this.read(tx, range), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000
    });
  }

  private async read(tx: Prisma.TransactionClient, range: ReturnType<typeof storefrontRange>): Promise<StorefrontSummary> {
    const dates: string[] = [];
    for (let t = range.fromDate.getTime(); t <= range.toDate.getTime(); t += 86_400_000) dates.push(day(new Date(t)));
    const dateWhere = { gte: range.fromDate, lte: range.toDate };
    const [connections, coverageRows, policies, googleCandidates, metaCandidates, batches, rates, costs] = await Promise.all([
      readConnections(tx),
      tx.sourceCoverage.findMany({ where: { metricDate: dateWhere }, take: MAX_ROWS + 1,
        include: { lastAttemptRun: { select: { status: true } } } }),
      tx.sourcePolicy.findMany({ where: { fromDate: { lte: range.toDate }, OR: [{ toDate: null }, { toDate: { gt: range.fromDate } }] }, take: 10_001,
        select: { connectionId: true, dataKind: true, primarySource: true, fromDate: true, toDate: true } }),
      tx.googleCampaignDailyCost.findMany({ where: { isCurrent: true, metricDate: dateWhere }, take: MAX_ROWS + 1,
        orderBy: [{ metricDate: "asc" }, { campaignId: "asc" }] }),
      tx.metaAdsetDailyMetric.findMany({ where: { isCurrent: true, metricDate: dateWhere }, take: MAX_ROWS + 1,
        select: { id: true, source: true, connectionId: true, metricDate: true, spendUsd: true,
          productId: true, product: { select: { isActive: true, displayName: true } }, createdAt: true } }),
      tx.cafe24UploadBatch.findMany({ where: { status: { in: ["IMPORTED", "PARTIAL"] },
        OR: [{ orderStart: null }, { orderEnd: null }, { orderStart: { lte: range.toDate }, orderEnd: { gte: range.fromDate } }] },
        select: { id: true, rowCount: true, _count: { select: { rows: true } } }, take: 10_001 }),
      tx.exchangeRate.findMany({ where: { rateDate: dateWhere, baseCurrency: "USD", quoteCurrency: "KRW", provider: "KOREA_EXIM" },
        select: { rateDate: true, rate: true, sourceDate: true, provider: true, fallbackType: true, fetchedAt: true } }),
      tx.productCostRule.findMany({ where: { effectiveFrom: { lte: range.toDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: range.fromDate } }] },
        take: 10_001, orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }] })
    ]);
    if (connections.length > 100 || policies.length > 10_000 || batches.length > 10_000 || costs.length > 10_000 ||
        [googleCandidates, metaCandidates, coverageRows].some(rows => rows.length > MAX_ROWS)) this.boundExceeded();
    const cafeCandidates = await tx.cafe24OrderLine.findMany({ where: { isCurrent: true, orderDate: dateWhere,
      validationStatus: { not: "ERROR" }, OR: [
        { source: "CSV", uploadBatchId: { in: batches.filter(b => b.rowCount === b._count.rows).map(b => b.id) } },
        { source: "API", uploadBatchId: null }
      ] }, take: MAX_ROWS + 1, select: { id: true, source: true, connectionId: true, orderDate: true,
        productId: true, quantity: true, salePriceKrw: true, createdAt: true,
        product: { select: { isActive: true } }, matchRule: { select: { displayName: true,
          optionIncludeKeywords: true, productNameAliases: true, salePriceKrwOverride: true } } } });
    if (cafeCandidates.length > MAX_ROWS) this.boundExceeded();
    const sourceContext = createSourceReadContext(tx, range.fromDate, range.toDate, policies, coverageRows);
    const warningCodes = new Set<string>(["CAFE24_LEGACY_MATCHED_REVENUE", "GOOGLE_COMMON_UNALLOCATED", "PAST_CHANGES_REQUIRE_MANUAL_DAY_RERUN"]);
    if (process.env.DAILY_SYNC_FEATURE_ENABLED !== "true") warningCodes.add("DAILY_SYNC_DISABLED");
    if (process.env.DAILY_SYNC_SCHEDULE_ENABLED !== "true") warningCodes.add("DAILY_SYNC_SCHEDULE_DISABLED");
    const selectedErrors = new Set<string>();
    const select = async <T extends { source: "CSV" | "API"; connectionId: string | null }>(kind: SourceDataKind, rows: T[], date: (row: T) => Date | null) => {
      try { return await selectCurrentSourceRows(tx, kind, rows, date, sourceContext); }
      catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        selectedErrors.add(kind); warningCodes.add("SOURCE_SELECTION_REQUIRED"); return [] as T[];
      }
    };
    const [selectedGoogle, meta, cafe] = await Promise.all([
      select("GOOGLE_CAMPAIGN", googleCandidates, r => r.metricDate),
      select("META_ADSET", metaCandidates, r => r.metricDate),
      select("CAFE24_ORDER", cafeCandidates, r => r.orderDate)
    ]);
    let google = selectedGoogle;
    const googleRuns = [...new Set(coverageRows.filter(r => r.dataKind === "GOOGLE_CAMPAIGN" && r.lastSuccessRunId).map(r => r.lastSuccessRunId!))];
    const googleUnits = googleRuns.length ? await tx.runUnit.findMany({ where: { runId: { in: googleRuns }, status: "SUCCEEDED" },
      take: MAX_ROWS + 1, select: { runId: true, unitKey: true, publishedCount: true, run: { select: { connectionId: true } } } }) : [];
    if (googleUnits.length > MAX_ROWS) this.boundExceeded();
    const invalidGoogleDays = new Set<string>();
    const feature = process.env.DAILY_SYNC_FEATURE_ENABLED === "true";
    const coverage: StorefrontCoverage[] = [];
    for (const c of connections) for (const date of dates) {
      const kind = kindFor[c.provider];
      const p = policies.filter(p => p.connectionId === c.id && p.dataKind === kind && day(p.fromDate) <= date && (!p.toDate || date < day(p.toDate)));
      const source = feature ? p.length === 1 ? p[0].primarySource : null : "CSV";
      const stored = coverageRows.find(r => r.connectionId === c.id && r.dataKind === kind && day(r.metricDate) === date);
      const rows = c.provider === "GOOGLE" ? google.filter(r => r.connectionId === c.id && day(r.metricDate) === date)
        : c.provider === "META" ? meta.filter(r => r.connectionId === c.id && day(r.metricDate) === date)
        : cafe.filter(r => r.connectionId === c.id && r.orderDate && day(r.orderDate) === date);
      let complete = source === "API" ? !!stored?.lastSuccessRunId && !!stored.lastSuccessAt && stored.source === source && stored.rowCount === rows.length
        : source === "CSV" && rows.length > 0;
      // API zero days still pass the canonical read guard, even without rows.
      if (complete && source === "API" && rows.length === 0 && c.provider !== "GOOGLE") {
        const probe = await select(kind, [{ source: "API" as const, connectionId: c.id, metricDate: new Date(date) }], r => r.metricDate);
        complete = probe.length === 1;
      }
      if (complete && source === "API" && c.provider === "GOOGLE") {
        const g = google.filter(r => r.connectionId === c.id && day(r.metricDate) === date);
        complete = g.every(r => r.syncRunId === stored!.lastSuccessRunId) && stored!.totalAmount != null &&
          sum(g.map(r => new D(r.costMicros.toString()).div(1_000_000))).equals(stored!.totalAmount!);
        const units = googleUnits.filter(u => u.runId === stored!.lastSuccessRunId && u.unitKey === date && u.run.connectionId === c.id);
        complete &&= units.length === 1 && units[0].publishedCount === stored!.rowCount;
      }
      complete &&= !selectedErrors.has(kind);
      if (c.provider === "GOOGLE" && source === "API" && !complete) invalidGoogleDays.add(`${c.id}:${date}`);
      const stale = stored?.lastSuccessAt ? Date.now() - stored.lastSuccessAt.getTime() > (c.provider === "CAFE24" ? 2 : 8) * 86_400_000 : false;
      const selectedStored = stored?.source === source ? stored : null;
      const warnings = [...(selectedStored?.warningCodes ?? []), ...(stale ? ["STALE_DATA"] : []),
        ...(selectedErrors.has(kind) || feature && (p.length > 1 || !source && (!!stored?.lastSuccessRunId || rows.length > 0))
          ? ["SOURCE_SELECTION_REQUIRED"] : [])];
      coverage.push({ connectionId: c.id, provider: c.provider, account: c.externalAccountId, dataKind: kind, date,
        currency: c.currencyCode, timeZone: c.timeZone, selectedSource: source,
        state: selectedStored?.state ?? (rows.length ? "COMPLETE_NONZERO" : "NOT_COLLECTED"), complete,
        lastAttemptAt: iso(stored?.lastAttemptAt), lastSuccessAt: iso(selectedStored?.lastSuccessAt),
        lastAttemptStatus: stored?.lastAttemptRun?.status ?? null, lastSuccessRunId: selectedStored?.lastSuccessRunId ?? null,
        rowCount: selectedStored?.rowCount ?? (rows.length || null), amount: selectedStored?.totalAmount?.toString() ?? null, warningCodes: warnings });
    }
    // A current row without a bound successful publish is not known spend.
    google = google.filter(r => !invalidGoogleDays.has(`${r.connectionId}:${day(r.metricDate)}`));
    const rateByDate = new Map(rates.map(r => [day(r.rateDate), r]));
    const usedLegacyRates = new Map<string, StorefrontSummary["exchangeRates"][number]>();
    const costFor = (productId: string | null, date: Date) => findEffectiveRuleForDate(costs.filter(c => c.productId === productId), date);
    const currencyCompatible = (provider: string, currency: string) => connections.filter(c => c.provider === provider)
      .every(c => c.currencyCode === currency && c.timeZone === "Asia/Seoul");
    const singleCurrency = (provider: string) => new Set(connections.filter(c => c.provider === provider).map(c => c.currencyCode)).size <= 1;
    if (["META", "GOOGLE", "CAFE24"].some(provider => !singleCurrency(provider))) warningCodes.add("MIXED_ACCOUNT_CURRENCIES");
    const completeDay = (provider: "CAFE24" | "META" | "GOOGLE", date: string, count: number) => {
      if (selectedErrors.has(kindFor[provider])) return false;
      const scoped = coverage.filter(c => c.provider === provider && c.date === date);
      return scoped.length ? scoped.every(c => c.complete) : count > 0;
    };
    let missingFx = false;
    const daily = dates.map(date => {
      const m = meta.filter(r => day(r.metricDate) === date), g = google.filter(r => day(r.metricDate) === date);
      const c = cafe.filter(r => r.orderDate && day(r.orderDate) === date);
      const mc = completeDay("META", date, m.length), gc = completeDay("GOOGLE", date, g.length), cc = completeDay("CAFE24", date, c.length);
      const usd = singleCurrency("META") && (m.length || mc) ? sum(m.map(r => r.spendUsd)) : null;
      let krw = new D(0), fxMissingDay = false;
      for (const row of m) {
        const stored = rateByDate.get(date);
        const legacy = row.product?.isActive ? costFor(row.productId, row.metricDate) : null;
        const rate = stored?.rate ?? (legacy?.fxRateKrwPerUsd.gt(0) ? legacy.fxRateKrwPerUsd : null);
        if (rate && rate.gt(0)) {
          krw = krw.plus(new D(row.spendUsd.toString()).times(rate.toString()));
          if (!stored && legacy && row.productId) {
            warningCodes.add("LEGACY_PRODUCT_FX_FALLBACK");
            usedLegacyRates.set(`${date}:${row.productId}:${legacy.id}`, { date, rate: rate.toString(),
              sourceDate: day(legacy.effectiveFrom), effectiveTo: legacy.effectiveTo ? day(legacy.effectiveTo) : null,
              provider: "PRODUCT_COST_RULE", fallbackType: "LEGACY_PRODUCT_RULE", fetchedAt: legacy.updatedAt.toISOString(), productId: row.productId,
              productDisplayName: row.product?.displayName });
          }
        } else if (row.spendUsd.gt(0)) fxMissingDay = true;
      }
      missingFx ||= fxMissingDay;
      const metaKrw = usd == null || fxMissingDay || !currencyCompatible("META", "USD") ? null : krw;
      const googleSpend = singleCurrency("GOOGLE") && (g.length || gc) ? sum(g.map(r => new D(r.costMicros.toString()).div(1_000_000))) : null;
      const googleKrw = currencyCompatible("GOOGLE", "KRW") ? googleSpend : null;
      const revenues = c.map(r => legacyRevenue(r, costFor(r.productId, r.orderDate!)));
      if (revenues.some(r => r == null)) warningCodes.add("CAFE24_PRODUCT_MAPPING_INCOMPLETE");
      const revenue = c.length || cc ? sum(revenues.filter((r): r is Prisma.Decimal => r != null)) : null;
      const known = metaKrw != null || googleKrw != null ? (metaKrw ?? new D(0)).plus(googleKrw ?? new D(0)) : null;
      const complete = mc && gc && !fxMissingDay && currencyCompatible("META", "USD") && currencyCompatible("GOOGLE", "KRW");
      return { date, revenueKrw: currencyCompatible("CAFE24", "KRW") ? revenue?.toString() ?? null : null,
        metaSpendUsd: usd?.toString() ?? null, metaSpendKrw: metaKrw?.toString() ?? null,
        googleSpend: googleSpend?.toString() ?? null, googleSpendKrw: googleKrw?.toString() ?? null,
        knownSpendKrw: known?.toString() ?? null, totalSpendKrw: complete ? known?.toString() ?? null : null, complete: complete && cc };
    });
    if (missingFx) warningCodes.add("MISSING_EXCHANGE_RATE");
    const incompatible = !currencyCompatible("META", "USD") || !currencyCompatible("GOOGLE", "KRW") || !currencyCompatible("CAFE24", "KRW");
    if (incompatible) warningCodes.add("INCOMPATIBLE_SCOPE");
    const sumField = (field: "revenueKrw" | "metaSpendUsd" | "metaSpendKrw" | "googleSpend" | "googleSpendKrw" | "knownSpendKrw" | "totalSpendKrw", strict = false) =>
      strict && daily.some(r => r[field] == null) || daily.every(r => r[field] == null) ? null : sum(daily.flatMap(r => r[field] == null ? [] : [new D(r[field]!)] )).toString();
    const channels: StorefrontChannel[] = (["CAFE24", "META", "GOOGLE"] as const).map(provider => {
      const account = connections.filter(c => c.provider === provider);
      const field = provider === "CAFE24" ? "revenueKrw" : provider === "META" ? "metaSpendUsd" : "googleSpend";
      const missingDates = dates.filter(date => !completeDay(provider, date, provider === "CAFE24" ? cafe.filter(r => r.orderDate && day(r.orderDate) === date).length : provider === "META" ? meta.filter(r => day(r.metricDate) === date).length : google.filter(r => day(r.metricDate) === date).length));
      const amount = sumField(field);
      const connected = account.some(c => c.accessState === "READY" && !!c.credentialRef &&
        (!c.credentialExpiresAt || c.credentialExpiresAt.getTime() > Date.now()));
      const failures = coverage.some(c => c.provider === provider && ["FAILED", "PARTIAL"].includes(c.state));
      const stale = coverage.some(c => c.provider === provider && c.warningCodes.includes("STALE_DATA"));
      return { provider, amount, currency: account.length ? [...new Set(account.map(c => c.currencyCode))].join("/") : provider === "META" ? "USD" : "KRW",
        spendKrw: provider === "CAFE24" ? null : sumField(provider === "META" ? "metaSpendKrw" : "googleSpendKrw", true),
        complete: missingDates.length === 0, state: failures ? "PARTIAL" : stale ? "STALE" : missingDates.length ? account.length ? amount != null ? "PARTIAL" : connected ? "NOT_COLLECTED" : "NOT_CONNECTED" : amount != null ? "CSV" : "NOT_CONNECTED" : amount === "0" ? "COMPLETE_ZERO" : "COMPLETE_NONZERO",
        missingDates, warningCodes: [...new Set([...coverage.filter(c => c.provider === provider).flatMap(c => c.warningCodes),
          ...(!singleCurrency(provider) ? ["MIXED_ACCOUNT_CURRENCIES"] : [])])] };
    });
    channels.push({ provider: "KAKAO", amount: null, currency: "KRW", spendKrw: null, complete: false, state: "NOT_CONNECTED", missingDates: dates, warningCodes: ["KAKAO_NOT_CONNECTED"] });
    warningCodes.add("KAKAO_NOT_CONNECTED");
    // An unconnected channel is unknown spend. Known totals remain useful, but
    // cannot become the denominator of an apparently complete overall MER.
    const complete = channels.every(c => c.complete) && !missingFx && !incompatible;
    const spend = complete ? sumField("totalSpendKrw", true) : null, revenue = sumField("revenueKrw", true);
    const successes = coverage.flatMap(c => c.lastSuccessAt ? [c.lastSuccessAt] : []).sort();
    return { from: range.from, to: range.to, asOf: successes.at(-1) ?? null, complete,
      missingSources: channels.filter(c => !c.complete).map(c => c.provider),
      missingDates: [...new Set(channels.flatMap(c => c.missingDates))].sort(),
      currencyStatus: incompatible ? "INCOMPATIBLE_SCOPE" : missingFx ? "MISSING_EXCHANGE_RATE" : "ALIGNED",
      totals: { revenueKrw: revenue, knownSpendKrw: sumField("knownSpendKrw"), totalSpendKrw: spend,
        mer: complete && revenue != null && spend != null && new D(spend).gt(0) ? new D(revenue).div(spend).toString() : null },
      channels, daily: daily.map(r => ({ ...r, complete: false, totalSpendKrw: null })), googleCampaigns: google.map(r => ({ connectionId: r.connectionId, date: day(r.metricDate),
        campaignId: r.campaignId, campaignName: r.campaignName, channelType: r.channelType, costMicros: r.costMicros.toString(),
        amount: new D(r.costMicros.toString()).div(1_000_000).toString(), currency: connections.find(c => c.id === r.connectionId)?.currencyCode ?? "UNKNOWN",
        impressions: r.impressions.toString(), clicks: r.clicks.toString(), fetchedAt: r.fetchedAt.toISOString() })), coverage,
      connections: connections.map(c => {
        const metaDaily = c.provider === "META" && readScheduleDefinitions().some(d => d.connectionId === c.id && d.kind === "META_DAILY");
        const googleOffsets = c.provider === "GOOGLE" ? readScheduleDefinitions().filter(d => d.connectionId === c.id &&
          (d.kind === "GOOGLE_DAILY" || d.kind === "GOOGLE_RECHECK_D7")).map(d => d.kind === "GOOGLE_RECHECK_D7" ? 7 : 1).sort((a,b) => a-b) : [];
        const daily = c.provider === "CAFE24" || metaDaily || googleOffsets.length > 0;
        const scoped = coverage.filter(r => r.connectionId === c.id), last = iso(c.coverage[0]?.lastSuccessAt);
        const run = c.runs[0];
        return { id: c.id, provider: c.provider, displayName: c.displayName, externalAccountId: c.externalAccountId,
          currencyCode: c.currencyCode, timeZone: c.timeZone, accessState: c.accessState, enabled: c.enabled,
          updatedAt: c.updatedAt.toISOString(), credentialExpiresAt: iso(c.credentialExpiresAt),
          reconnectRequired: c.accessState !== "READY" || !c.credentialRef || !!c.credentialExpiresAt && c.credentialExpiresAt.getTime() <= Date.now(),
          cadenceDays: daily ? 1 : 7,
          ...(googleOffsets.length ? { dailyCollectionOffsets: googleOffsets } : {}),
          ...(metaDaily ? { weeklyRecheckCadenceDays: 7 } : {}), latestAttempt: run ? { id: run.id, status: run.status,
            at: iso(run.startedAt), safeErrorCode: run.safeErrorCode } : null,
          lastSuccessAt: last, completedDates: scoped.filter(r => r.complete).map(r => r.date),
          stale: last ? Date.now() - Date.parse(last) > (daily ? 2 : 8) * 86_400_000 : false };
      }), exchangeRates: [...rates.map(r => ({ date: day(r.rateDate), rate: r.rate.toString(), sourceDate: day(r.sourceDate),
        provider: r.provider, fallbackType: r.fallbackType, fetchedAt: r.fetchedAt.toISOString() })), ...usedLegacyRates.values()], warningCodes: [...warningCodes] };
  }
  private boundExceeded(): never {
    throw new BadRequestException({ code: "STOREFRONT_ROW_LIMIT", message: "조회량이 많습니다. 기간을 줄여 주세요." });
  }
}
