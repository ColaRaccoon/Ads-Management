import { MatchSource, Prisma } from "@prisma/client";
import { AdsetNameNormalizer } from "../domain/adset-name-normalizer";
import { AdDailyMetricRow, AdsetAggregateInput } from "./upload-contracts";
import { maxDate, minDate } from "./upload-keys";

export function aggregateAdRows(rows: AdDailyMetricRow[]): AdsetAggregateInput {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const productAttribution = aggregateProductAttribution(rows);
  const spendUsd = sum(rows, (row) => decimalNumber(row.spendUsd));
  const purchaseCount = sum(rows, (row) => row.purchaseCount);
  const reach = sum(rows, (row) => row.reach);
  const impressions = sum(rows, (row) => bigintNumber(row.impressions));
  const linkClicks = sum(rows, (row) => row.linkClicks);
  const shopClicks = sum(rows, (row) => row.shopClicks);
  const clicksAll = sum(rows, (row) => row.clicksAll);
  const landingPageViews = sum(rows, (row) => row.landingPageViews);

  return {
    metaAdsetId: first.metaAdsetRefId,
    metricDate: first.metricDate,
    dateStart: rows.reduce<Date | null>((current, row) => minDate(current, row.dateStart), null) ?? first.dateStart,
    dateEnd: rows.reduce<Date | null>((current, row) => maxDate(current, row.dateEnd), null) ?? first.dateEnd,
    adsetName: last.adsetNameSnapshot,
    adsetNameKey: AdsetNameNormalizer.toKey(last.adsetNameSnapshot),
    deliveryStatus: chooseDeliveryStatus(rows.map((row) => row.adDeliveryStatus)),
    attributionSetting: firstNonNull(rows.map((row) => row.attributionSetting)),
    resultIndicator: firstNonNull(rows.map((row) => row.resultIndicator)),
    purchaseCount,
    reach,
    frequency: ratio(impressions, reach),
    costPerResultUsd: ratio(spendUsd, purchaseCount),
    adsetBudgetLabel: firstNonNull(rows.map((row) => row.adsetBudgetLabel)),
    adsetBudgetType: firstNonNull(rows.map((row) => row.adsetBudgetType)),
    spendUsd,
    endStatus: firstNonNull(rows.map((row) => row.endStatus)),
    impressions,
    cpmUsd: ratio(spendUsd * 1000, impressions),
    linkClicks,
    shopClicks,
    cpcLinkUsd: ratio(spendUsd, linkClicks),
    ctrLinkPct: ratio(linkClicks * 100, impressions),
    clicksAll,
    ctrAllPct: ratio(clicksAll * 100, impressions),
    cpcAllUsd: ratio(spendUsd, clicksAll),
    landingPageViews,
    costPerLandingPageViewUsd: ratio(spendUsd, landingPageViews),
    productId: productAttribution.productId,
    stage: last.stage,
    productMatchSource: productAttribution.productMatchSource,
    stageMatchSource: last.stageMatchSource,
    productMatchRuleId: productAttribution.productMatchRuleId,
    rawRow: {
      source: "meta_ad_daily_metrics",
      metricIds: rows.map((row) => row.id),
      metaCampaignId: first.metaCampaignId,
      metaAdsetId: first.metaAdsetId,
      adCount: rows.length
    }
  };
}

export function aggregateProductAttribution(rows: AdDailyMetricRow[]) {
  if (rows.length === 0 || rows.some((row) => !row.productId)) {
    return unmatchedProductAttribution();
  }

  const productIds = Array.from(new Set(rows.map((row) => row.productId).filter((id): id is string => Boolean(id))));
  if (productIds.length !== 1) {
    return unmatchedProductAttribution();
  }

  const sources = new Set(rows.map((row) => row.productMatchSource).filter((source) => source !== MatchSource.UNMATCHED));
  const productMatchSource =
    sources.size === 1
      ? Array.from(sources)[0]
      : sources.has(MatchSource.MANUAL)
        ? MatchSource.MANUAL
        : sources.has(MatchSource.RULE)
          ? MatchSource.RULE
          : MatchSource.INFERRED;
  const ruleIds = Array.from(new Set(rows.map((row) => row.productMatchRuleId).filter((id): id is string => Boolean(id))));

  return {
    productId: productIds[0],
    productMatchSource,
    productMatchRuleId: productMatchSource === MatchSource.RULE && ruleIds.length === 1 ? ruleIds[0] : null
  };
}

function unmatchedProductAttribution() {
  return {
    productId: null,
    productMatchSource: MatchSource.UNMATCHED,
    productMatchRuleId: null
  };
}

function decimalNumber(value: Prisma.Decimal | number | null): number {
  if (value === null) {
    return 0;
  }
  return typeof value === "number" ? value : value.toNumber();
}

function bigintNumber(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function sum<T>(rows: T[], selector: (row: T) => number) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function ratio(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function firstNonNull<T>(values: Array<T | null>): T | null {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null;
}

function chooseDeliveryStatus(values: Array<string | null>) {
  const normalized = values.filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  if (normalized.includes("active")) {
    return "active";
  }
  if (normalized.includes("inactive")) {
    return "inactive";
  }
  return values.find((value): value is string => Boolean(value)) ?? null;
}
