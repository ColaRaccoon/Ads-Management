import { createHash } from "node:crypto";
import { Prisma, SourceDataKind, SourceKind } from "@prisma/client";
import { selectCurrentSourceRows } from "../common/source-read-policy";
import { formatDateOnly } from "../domain/date-number";
import { metaAttributionContextKey } from "../domain/meta-conditional-metrics";
import { creativeRowFinancials } from "../metrics/meta-ad-metric-aggregates";
import { loadCreativeFinancialContext } from "../metrics/meta-ad-metrics-read.service";
import { classifyInfluencerCreative, materialNumberKey, numberedCreative } from "./influencer-matching";

const metricFields = {
  metricDate: true, connectionId: true, source: true, adNameSnapshot: true, campaignNameSnapshot: true,
  spendUsd: true, impressions: true, productId: true, creativeId: true, resultIndicator: true, resultCount: true, purchaseCount: true,
  attributionSetting: true, actionReportTime: true, attributionWindows: true
} as const satisfies Prisma.MetaAdDailyMetricSelect;

const collaborationFields = {
  id: true, version: true, influencerKey: true, feeKrw: true, startDate: true, endDate: true,
  needsBackfill: true, numberingRequired: true, numberReservations: { select: { numberKey: true } }
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
    const legacy = classifyInfluencerCreative(row.adNameSnapshot, row.campaignNameSnapshot);
    const material = row.productId ? numberedCreative(row.adNameSnapshot) : null;
    const numberKey = material ? materialNumberKey(row.productId!, material.number) : null;
    return [
      ...(legacy ? [{ row, scope: "NICKNAME", numberKey, ...legacy }] : []),
      ...(material && numberKey ? [{ row, scope: "MATERIAL", numberKey: null, influencerKey: numberKey, creativeName: material.creativeName }] : [])
    ];
  });
  const context = await loadCreativeFinancialContext(tx, matched.map(item => item.row));
  const grouped = new Map<string, DailyPerformance>();
  for (const { row, scope, influencerKey, creativeName, numberKey } of matched) {
    const identity = JSON.stringify([creativeName, row.creativeId, numberKey]);
    const key = JSON.stringify([scope, influencerKey, identity]);
    const delivered = row.spendUsd.gt(0) || row.impressions > 0n;
    const attributionContext = metaAttributionContextKey(row);
    const { spendKrw, marginKrw } = creativeRowFinancials(row, context);
    const existing = grouped.get(key);
    if (existing) {
      existing.adSpendKrw = addAmount(existing.adSpendKrw, spendKrw);
      existing.adMarginKrw = addAmount(existing.adMarginKrw, marginKrw);
      existing.hasApi ||= row.source === SourceKind.API;
      existing.delivered ||= delivered;
      existing.mixedAttribution ||= existing.attributionContext !== attributionContext;
      if (attributionContext < existing.attributionContext) existing.attributionContext = attributionContext;
    } else {
      grouped.set(key, {
        metricDate, scope, influencerKey, creativeName, numberKey, sourceCreativeId: row.creativeId, delivered,
        creativeKey: createHash("sha256").update(identity).digest("hex"),
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
  const changes = changedScopes(previous, next);
  if (changes.size === 0) return;

  // Replace the affected day, including creatives removed by a correction or deletion.
  const legacyKeys = [...(changes.get("NICKNAME") ?? [])];
  const numberedKeys = [...(changes.get("MATERIAL") ?? [])];
  await tx.influencerDailyPerformance.deleteMany({
    where: { metricDate, OR: [{ scope: "NICKNAME", influencerKey: { in: legacyKeys } }, { scope: "MATERIAL", influencerKey: { in: numberedKeys } }] }
  });
  const replacements = next.filter(row => changes.get(row.scope)?.has(row.influencerKey));
  if (replacements.length) await tx.influencerDailyPerformance.createMany({ data: replacements });

  const collaborations = await tx.influencerCollaboration.findMany({
    where: {
      deletedAt: null,
      startDate: { lte: metricDate },
      AND: [
        { OR: [{ endDate: null }, { endDate: { gte: metricDate } }] },
        { OR: [
          { numberingRequired: false, influencerKey: { in: legacyKeys } },
          { numberingRequired: true, numberReservations: { some: { numberKey: { in: numberedKeys } } } }
        ] }
      ]
    }, select: collaborationFields
  });
  for (const collaboration of collaborations) {
    await saveInfluencerRollup(tx, collaboration, now, collaboration.needsBackfill ? undefined : metricDate);
  }
}

export async function backfillInfluencerCollaboration(tx: Prisma.TransactionClient, id: string, now: Date) {
  const collaboration = await tx.influencerCollaboration.findFirst({
    where: { id, deletedAt: null, needsBackfill: true }, select: collaborationFields
  });
  if (collaboration) await saveInfluencerRollup(tx, collaboration, now);
}

const spendTotal = Prisma.sql`CASE WHEN bool_or(ad_spend_krw IS NULL) THEN NULL ELSE coalesce(sum(ad_spend_krw), 0) END`;
const marginTotal = Prisma.sql`CASE WHEN bool_or(ad_margin_krw IS NULL)
  OR (bool_or(has_api) AND (bool_or(mixed_attribution) OR min(attribution_context COLLATE "C") <> max(attribution_context COLLATE "C")))
  THEN NULL ELSE coalesce(sum(ad_margin_krw), 0) END`;

function matchesCollaboration(collaboration: Collaboration) {
  const keys = collaboration.numberReservations.map(reservation => reservation.numberKey);
  const scope = collaboration.numberingRequired
    ? keys.length ? Prisma.sql`scope = 'MATERIAL' AND influencer_key IN (${Prisma.join(keys)})` : Prisma.sql`false`
    : Prisma.sql`scope = 'NICKNAME' AND influencer_key = ${collaboration.influencerKey}
      AND NOT EXISTS (
        SELECT 1 FROM influencer_number_reservations r
        JOIN influencer_collaborations owner ON owner.id = r.collaboration_id
        WHERE r.number_key = influencer_daily_performances.number_key
          AND owner.start_date <= influencer_daily_performances.metric_date
          AND (owner.end_date IS NULL OR owner.end_date >= influencer_daily_performances.metric_date)
      )`;
  return Prisma.sql`${scope}
    AND metric_date >= ${formatDateOnly(collaboration.startDate)}::date
    ${collaboration.endDate ? Prisma.sql`AND metric_date <= ${formatDateOnly(collaboration.endDate)}::date` : Prisma.empty}`;
}

async function saveInfluencerRollup(tx: Prisma.TransactionClient, collaboration: Collaboration, now: Date, metricDate?: Date) {
  // Only the compact daily projection is read here. GET requests read the resulting saved snapshot.
  const rows = await tx.$queryRaw<Rollup[]>`
    SELECT creative_name AS "creativeName",
      ${spendTotal} AS "adSpendKrw",
      ${marginTotal} AS "adMarginKrw",
      max(metric_date) AS "dataThrough"
    FROM influencer_daily_performances
    WHERE ${matchesCollaboration(collaboration)}
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
  await tx.influencerCollaborationDay.deleteMany({ where: { collaborationId: collaboration.id, ...(metricDate ? { metricDate } : {}) } });
  await tx.$executeRaw`
    INSERT INTO influencer_collaboration_days (collaboration_id, metric_date, ad_spend_krw, ad_margin_krw, creative_count)
    SELECT ${collaboration.id}::uuid, metric_date, ${spendTotal}, ${marginTotal}, count(DISTINCT creative_name)::int
    FROM influencer_daily_performances
    WHERE ${matchesCollaboration(collaboration)} AND delivered
      ${metricDate ? Prisma.sql`AND metric_date = ${formatDateOnly(metricDate)}::date` : Prisma.empty}
    GROUP BY metric_date`;
}

function addAmount(total: Prisma.Decimal | null, amount: number | null) {
  return amount === null ? null : total?.plus(amount) ?? null;
}

function changedScopes(previous: DailyPerformance[], next: DailyPerformance[]) {
  const identity = (row: DailyPerformance) => JSON.stringify([row.scope, row.influencerKey, row.creativeKey]);
  const index = new Map(previous.map(row => [identity(row), row]));
  const changed = new Map<string, Set<string>>();
  const mark = (row: DailyPerformance) => {
    const keys = changed.get(row.scope) ?? new Set<string>();
    keys.add(row.influencerKey);
    changed.set(row.scope, keys);
  };
  for (const row of next) {
    const key = identity(row);
    const old = index.get(key);
    if (!old || !sameAmount(row.adSpendKrw, old.adSpendKrw) || !sameAmount(row.adMarginKrw, old.adMarginKrw) ||
        row.hasApi !== old.hasApi || row.delivered !== old.delivered ||
        row.mixedAttribution !== old.mixedAttribution || row.attributionContext !== old.attributionContext) {
      mark(row);
    }
    index.delete(key);
  }
  for (const row of index.values()) mark(row);
  return changed;
}

function sameAmount(left: Prisma.Decimal | null, right: Prisma.Decimal | null) {
  return left === null ? right === null : right !== null && left.eq(right);
}
