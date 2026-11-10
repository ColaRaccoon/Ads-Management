import { createHash } from "node:crypto";
import { Prisma, SourceDataKind, SourceKind } from "@prisma/client";
import { selectCurrentSourceRows } from "../common/source-read-policy";
import { formatDateOnly } from "../domain/date-number";
import { metaAttributionContextKey } from "../domain/meta-conditional-metrics";
import { creativeRowFinancials } from "../metrics/meta-ad-metric-aggregates";
import { loadCreativeFinancialContext } from "../metrics/meta-ad-metrics-read.service";
import { classifyInfluencerCreative } from "./influencer-matching";

const metricFields = {
  metricDate: true, connectionId: true, source: true, adNameSnapshot: true, campaignNameSnapshot: true,
  spendUsd: true, productId: true, resultIndicator: true, resultCount: true, purchaseCount: true,
  attributionSetting: true, actionReportTime: true, attributionWindows: true
} as const satisfies Prisma.MetaAdDailyMetricSelect;

const collaborationFields = {
  id: true, version: true, influencerKey: true, feeKrw: true, startDate: true, endDate: true
} as const satisfies Prisma.InfluencerCollaborationSelect;

type Collaboration = Prisma.InfluencerCollaborationGetPayload<{ select: typeof collaborationFields }>;
type DailyPerformance = Prisma.InfluencerDailyPerformanceGetPayload<Record<string, never>>;
type Rollup = {
  creativeName: string | null;
  adSpendKrw: Prisma.Decimal | null;
  adMarginKrw: Prisma.Decimal | null;
  dataThrough: Date | null;
};

/** One calendar day and its affected totals publish together on a repeatable-read snapshot. */
export async function projectInfluencerDay(tx: Prisma.TransactionClient, metricDate: Date, now: Date) {
  const candidates = await tx.metaAdDailyMetric.findMany({
    where: { metricDate, isCurrent: true }, select: metricFields
  });
  // Select canonical rows before filtering names so unbound CSV conflicts remain visible.
  const selected = await selectCurrentSourceRows(tx, SourceDataKind.META_AD, candidates, row => row.metricDate);
  const matched = selected.flatMap(row => {
    const creative = classifyInfluencerCreative(row.adNameSnapshot, row.campaignNameSnapshot);
    return creative ? [{ row, ...creative }] : [];
  });
  const context = await loadCreativeFinancialContext(tx, matched.map(item => item.row));
  const grouped = new Map<string, DailyPerformance>();
  for (const { row, influencerKey, creativeName } of matched) {
    const key = JSON.stringify([influencerKey, creativeName]);
    const attributionContext = metaAttributionContextKey(row);
    const { spendKrw, marginKrw } = creativeRowFinancials(row, context);
    const existing = grouped.get(key);
    if (existing) {
      existing.adSpendKrw = addAmount(existing.adSpendKrw, spendKrw);
      existing.adMarginKrw = addAmount(existing.adMarginKrw, marginKrw);
      existing.hasApi ||= row.source === SourceKind.API;
      existing.mixedAttribution ||= existing.attributionContext !== attributionContext;
      if (attributionContext < existing.attributionContext) existing.attributionContext = attributionContext;
    } else {
      grouped.set(key, {
        metricDate, influencerKey, creativeName,
        creativeKey: createHash("sha256").update(creativeName).digest("hex"),
        adSpendKrw: spendKrw === null ? null : new Prisma.Decimal(spendKrw),
        adMarginKrw: marginKrw === null ? null : new Prisma.Decimal(marginKrw),
        hasApi: row.source === SourceKind.API, attributionContext, mixedAttribution: false
      });
    }
  }
  const next = [...grouped.values()].map(row => ({
    ...row, adSpendKrw: row.adSpendKrw?.toDecimalPlaces(6) ?? null,
    adMarginKrw: row.adMarginKrw?.toDecimalPlaces(6) ?? null
  }));
  const previous = await tx.influencerDailyPerformance.findMany({ where: { metricDate } });
  const changedKeys = changedInfluencerKeys(previous, next);
  if (changedKeys.length === 0) return;

  // Replace the affected day, including creatives removed by a correction or deletion.
  await tx.influencerDailyPerformance.deleteMany({ where: { metricDate, influencerKey: { in: changedKeys } } });
  const changed = new Set(changedKeys);
  const replacements = next.filter(row => changed.has(row.influencerKey));
  if (replacements.length) await tx.influencerDailyPerformance.createMany({ data: replacements });

  const collaborations = await tx.influencerCollaboration.findMany({
    where: {
      influencerKey: { in: changedKeys }, startDate: { lte: metricDate },
      OR: [{ endDate: null }, { endDate: { gte: metricDate } }]
    }, select: collaborationFields
  });
  for (const collaboration of collaborations) await saveInfluencerRollup(tx, collaboration, now);
}

export async function backfillInfluencerCollaboration(tx: Prisma.TransactionClient, id: string, now: Date) {
  const collaboration = await tx.influencerCollaboration.findFirst({
    where: { id, needsBackfill: true }, select: collaborationFields
  });
  if (collaboration) await saveInfluencerRollup(tx, collaboration, now);
}

async function saveInfluencerRollup(tx: Prisma.TransactionClient, collaboration: Collaboration, now: Date) {
  // Only the compact daily projection is read here. GET requests read the resulting saved snapshot.
  const rows = await tx.$queryRaw<Rollup[]>`
    SELECT creative_name AS "creativeName",
      CASE WHEN bool_or(ad_spend_krw IS NULL) THEN NULL ELSE coalesce(sum(ad_spend_krw), 0) END AS "adSpendKrw",
      CASE WHEN bool_or(ad_margin_krw IS NULL)
        OR (bool_or(has_api) AND (bool_or(mixed_attribution) OR min(attribution_context COLLATE "C") <> max(attribution_context COLLATE "C")))
        THEN NULL ELSE coalesce(sum(ad_margin_krw), 0) END AS "adMarginKrw",
      max(metric_date) AS "dataThrough"
    FROM influencer_daily_performances
    WHERE influencer_key = ${collaboration.influencerKey}
      AND metric_date >= ${formatDateOnly(collaboration.startDate)}::date
      ${collaboration.endDate ? Prisma.sql`AND metric_date <= ${formatDateOnly(collaboration.endDate)}::date` : Prisma.empty}
    GROUP BY GROUPING SETS ((creative_name), ())
    ORDER BY creative_name COLLATE "C" NULLS FIRST`;
  const [total, ...creatives] = rows;
  const creativeTotals = creatives.map(row => ({
    creativeName: row.creativeName!,
    adSpendKrw: row.adSpendKrw?.toNumber() ?? null,
    adMarginKrw: row.adMarginKrw?.toNumber() ?? null,
    dataThrough: formatDateOnly(row.dataThrough!)
  }));
  const updated = await tx.influencerCollaboration.updateMany({
    where: { id: collaboration.id, version: collaboration.version },
    data: {
      adSpendKrw: total.adSpendKrw,
      adMarginKrw: total.adMarginKrw,
      netPerformanceKrw: total.adMarginKrw?.minus(collaboration.feeKrw) ?? null,
      dataThrough: total.dataThrough,
      aggregatedAt: now,
      creativeCount: creativeTotals.length,
      creativeTotals,
      needsBackfill: false,
      lastJobAt: now
    }
  });
  if (updated.count !== 1) throw new Error("INFLUENCER_COLLABORATION_CHANGED");
}

function addAmount(total: Prisma.Decimal | null, amount: number | null) {
  return amount === null ? null : total?.plus(amount) ?? null;
}

function changedInfluencerKeys(previous: DailyPerformance[], next: DailyPerformance[]) {
  const index = new Map(previous.map(row => [JSON.stringify([row.influencerKey, row.creativeName]), row]));
  const changed = new Set<string>();
  for (const row of next) {
    const key = JSON.stringify([row.influencerKey, row.creativeName]);
    const old = index.get(key);
    if (!old || !sameAmount(row.adSpendKrw, old.adSpendKrw) || !sameAmount(row.adMarginKrw, old.adMarginKrw) ||
        row.hasApi !== old.hasApi || row.mixedAttribution !== old.mixedAttribution || row.attributionContext !== old.attributionContext) {
      changed.add(row.influencerKey);
    }
    index.delete(key);
  }
  for (const row of index.values()) changed.add(row.influencerKey);
  return [...changed];
}

function sameAmount(left: Prisma.Decimal | null, right: Prisma.Decimal | null) {
  return left === null ? right === null : right !== null && left.eq(right);
}
