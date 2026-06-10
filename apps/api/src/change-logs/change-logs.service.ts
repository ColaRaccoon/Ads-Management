import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { AdStage, CreativeLogActionType, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { asDateOnly, numberFrom, parseDateRange } from "../common/date-range";
import { formatDateOnly } from "../domain/date-number";

const ACTION_TYPES = new Set(["TURN_OFF", "BUDGET_CHANGE", "PROMOTE_STAGE", "DEMOTE_STAGE", "CREATIVE_EXCLUDE", "NOTE"]);
const TARGET_TYPES = new Set(["PRODUCT", "ADSET", "STAGE"]);
const CREATIVE_ACTION_TYPES = new Set([
  "NOTE",
  "TURN_ON",
  "TURN_OFF",
  "KEEP",
  "WATCH",
  "SCALE",
  "REDUCE",
  "CREATIVE_TEST",
  "CREATIVE_EXCLUDE",
  "OTHER"
]);

type MetricRow = Prisma.MetaAdDailyMetricGetPayload<Record<string, never>>;
type AliasRow = Prisma.CreativeAliasGetPayload<Record<string, never>>;
type PlacementRow = Prisma.CreativePlacementGetPayload<Record<string, never>>;
type ProductAdMetricRow = Prisma.MetaAdDailyMetricGetPayload<{
  include: { creative: { select: { displayName: true } } };
}>;
type DateRange = NonNullable<ReturnType<typeof optionalDateRange>>;

@Injectable()
export class ChangeLogsService {
  constructor(private readonly prisma: PrismaService) {}

  list(from?: string, to?: string) {
    const where =
      from && to
        ? { actionDate: { gte: parseDateRange(from, to).fromDate, lte: parseDateRange(from, to).toDate } }
        : undefined;
    return this.prisma.changeLog.findMany({
      where,
      orderBy: [{ actionDate: "desc" }, { createdAt: "desc" }],
      include: { product: true, metaAdset: true, relatedDecision: true }
    });
  }

  create(body: Record<string, unknown>) {
    const actionType = requiredEnum(body.actionType, ACTION_TYPES, "actionType");
    const targetType = requiredEnum(body.targetType, TARGET_TYPES, "targetType");
    return this.prisma.changeLog.create({
      data: {
        actionDate: body.actionDate ? asDateOnly(String(body.actionDate)) : asDateOnly(new Date().toISOString().slice(0, 10)),
        actionType,
        targetType,
        productId: optionalString(body.productId),
        metaAdsetId: optionalString(body.metaAdsetId),
        stageFrom: parseStageOrNull(body.stageFrom),
        stageTo: parseStageOrNull(body.stageTo),
        previousValue: body.previousValue === undefined ? undefined : (body.previousValue as Prisma.InputJsonValue),
        newValue: body.newValue === undefined ? undefined : (body.newValue as Prisma.InputJsonValue),
        reason: requiredString(body.reason, "reason"),
        relatedDecisionId: optionalString(body.relatedDecisionId),
        nextCheckDate: body.nextCheckDate ? asDateOnly(String(body.nextCheckDate)) : null
      }
    });
  }

  async listCreatives(from?: string, to?: string) {
    const range = optionalDateRange(from, to);
    const creatives = await this.prisma.creative.findMany({
      where: visibleCreativeWhere(range),
      include: {
        aliases: true,
        placements: true,
        changeLogs: {
          orderBy: [{ actionDate: "desc" }, { createdAt: "desc" }],
          take: 1
        }
      },
      orderBy: [{ lastSeenOn: "desc" }, { displayName: "asc" }]
    });
    const creativeIds = creatives.map((creative) => creative.id);
    const metrics =
      creativeIds.length > 0
        ? await this.prisma.metaAdDailyMetric.findMany({
            where: {
              creativeId: { in: creativeIds },
              isCurrent: true,
              ...(range ? { metricDate: { gte: range.fromDate, lte: range.toDate } } : {})
            },
            orderBy: [{ metricDate: "desc" }, { campaignNameSnapshot: "asc" }, { adsetNameSnapshot: "asc" }]
          })
        : [];
    const metricsByCreative = groupBy(metrics, (metric) => metric.creativeId ?? "");

    return creatives.map((creative) => {
      const creativeMetrics = metricsByCreative.get(creative.id) ?? [];
      const visibleAliases = filterAliasesByMetrics(creative.aliases, creativeMetrics);
      const visiblePlacements = filterPlacementsByMetrics(creative.placements, creativeMetrics);
      const placementKeys = new Set(visiblePlacements.map((placement) => placementKey(placement)));
      const activePlacementKeys = new Set(
        visiblePlacements.filter((placement) => isActiveStatus(placement.lastStatus)).map((placement) => placementKey(placement))
      );
      const latestLog = creative.changeLogs[0] ?? null;
      return {
        id: creative.id,
        creativeKey: creative.creativeKey,
        displayName: creative.displayName,
        productName: creative.productName,
        materialNo: creative.materialNo,
        firstSeenOn: dateOrNull(minMetricDate(creativeMetrics)),
        lastSeenOn: dateOrNull(maxMetricDate(creativeMetrics)),
        aliasCount: visibleAliases.length,
        placementCount: placementKeys.size,
        activePlacementCount: activePlacementKeys.size,
        settings: uniqueStrings([
          ...visibleAliases.map((alias) => alias.setting),
          ...visiblePlacements.map((placement) => placement.setting)
        ]),
        originalNames: uniqueStrings(visibleAliases.map((alias) => alias.originalName)),
        latestMetrics: aggregateLatestMetrics(creativeMetrics),
        latestLog: latestLog
          ? {
              actionDate: formatDateOnly(latestLog.actionDate),
              actionType: latestLog.actionType,
              reason: latestLog.reason
            }
          : null
      };
    });
  }

  async getCreativeDetail(creativeId: string, from?: string, to?: string) {
    const range = optionalDateRange(from, to);
    const creative = await this.prisma.creative.findFirst({
      where: visibleCreativeWhere(range, creativeId),
      include: {
        aliases: { orderBy: [{ lastSeenOn: "desc" }, { originalName: "asc" }] },
        placements: { orderBy: [{ lastSeenOn: "desc" }, { campaignName: "asc" }, { adsetName: "asc" }] },
        changeLogs: { orderBy: [{ actionDate: "desc" }, { createdAt: "desc" }] }
      }
    });
    if (!creative) {
      throw new NotFoundException({ code: "CREATIVE_NOT_FOUND", message: "creativeId에 해당하는 광고소재를 찾을 수 없습니다." });
    }
    const metrics = await this.prisma.metaAdDailyMetric.findMany({
      where: {
        creativeId,
        isCurrent: true,
        ...(range ? { metricDate: { gte: range.fromDate, lte: range.toDate } } : {})
      },
      orderBy: [{ metricDate: "asc" }, { campaignNameSnapshot: "asc" }, { adsetNameSnapshot: "asc" }]
    });

    return {
      creative: {
        id: creative.id,
        creativeKey: creative.creativeKey,
        displayName: creative.displayName,
        productName: creative.productName,
        materialNo: creative.materialNo,
        firstSeenOn: dateOrNull(minMetricDate(metrics)),
        lastSeenOn: dateOrNull(maxMetricDate(metrics))
      },
      aliases: filterAliasesByMetrics(creative.aliases, metrics).map((alias) => ({
        originalName: alias.originalName,
        dateCode: alias.dateCode,
        setting: alias.setting,
        parseStatus: alias.parseStatus,
        firstSeenOn: dateOrNull(alias.firstSeenOn),
        lastSeenOn: dateOrNull(alias.lastSeenOn)
      })),
      placements: groupedPlacements(filterPlacementsByMetrics(creative.placements, metrics)),
      dailyMetrics: groupedDailyMetrics(metrics),
      logs: creative.changeLogs.map((log) => ({
        id: log.id,
        actionDate: formatDateOnly(log.actionDate),
        actionType: log.actionType,
        reason: log.reason,
        memo: log.memo,
        relatedAdsetIds: jsonStringArray(log.relatedAdsetIds),
        nextCheckDate: dateOrNull(log.nextCheckDate),
        createdAt: log.createdAt.toISOString()
      }))
    };
  }

  async createCreativeLog(creativeId: string, body: Record<string, unknown>) {
    const creative = await this.prisma.creative.findFirst({ where: visibleCreativeWhere(null, creativeId), select: { id: true } });
    if (!creative) {
      throw new NotFoundException({ code: "CREATIVE_NOT_FOUND", message: "creativeId에 해당하는 광고소재를 찾을 수 없습니다." });
    }
    const actionType = body.actionType
      ? (requiredEnum(body.actionType, CREATIVE_ACTION_TYPES, "actionType") as CreativeLogActionType)
      : CreativeLogActionType.NOTE;
    return this.prisma.creativeChangeLog.create({
      data: {
        creativeId,
        actionDate: body.actionDate ? asDateOnly(String(body.actionDate)) : asDateOnly(new Date().toISOString().slice(0, 10)),
        actionType,
        reason: requiredString(body.reason, "reason"),
        memo: optionalString(body.memo),
        relatedAdsetIds: optionalStringArray(body.relatedAdsetIds) as Prisma.InputJsonValue,
        nextCheckDate: body.nextCheckDate ? asDateOnly(String(body.nextCheckDate)) : null
      }
    });
  }

  async listProducts(dateInput?: string) {
    const metricDate = parseSingleDate(dateInput, "date");
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      select: { id: true, name: true, displayName: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
    });
    const productIds = products.map((product) => product.id);
    const grouped =
      productIds.length > 0
        ? await this.prisma.metaAdDailyMetric.groupBy({
            by: ["productId"],
            where: {
              productId: { in: productIds },
              metricDate,
              isCurrent: true
            },
            _sum: { spendUsd: true }
          })
        : [];
    const spendByProductId = new Map(grouped.map((row) => [row.productId, round2(numberFrom(row._sum.spendUsd))]));

    return products.map((product) => ({
      id: product.id,
      productName: displayProductName(product),
      spendUsd: spendByProductId.get(product.id) ?? 0
    }));
  }

  async getProductDetail(productId: string, dateInput?: string) {
    const metricDate = parseSingleDate(dateInput, "date");
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true, displayName: true }
    });
    if (!product) {
      throw new NotFoundException({ code: "PRODUCT_NOT_FOUND", message: "productId에 해당하는 제품을 찾을 수 없습니다." });
    }

    const [selectedMetrics, logs] = await Promise.all([
      this.prisma.metaAdDailyMetric.findMany({
        where: {
          productId,
          metricDate,
          isCurrent: true
        },
        include: { creative: { select: { displayName: true } } },
        orderBy: [{ spendUsd: "desc" }, { adNameSnapshot: "asc" }]
      }),
      this.prisma.productChangeLog.findMany({
        where: { productId },
        orderBy: [{ actionDate: "desc" }, { createdAt: "desc" }]
      })
    ]);
    const adsDate =
      selectedMetrics.length > 0 ? metricDate : await this.findPreviousProductMetricDate(productId, metricDate);
    const adsMetrics =
      selectedMetrics.length > 0 || !adsDate
        ? selectedMetrics
        : await this.prisma.metaAdDailyMetric.findMany({
            where: {
              productId,
              metricDate: adsDate,
              isCurrent: true
            },
            include: { creative: { select: { displayName: true } } },
            orderBy: [{ spendUsd: "desc" }, { adNameSnapshot: "asc" }]
          });
    const ads = groupProductAds(adsMetrics);

    return {
      product: {
        id: product.id,
        name: displayProductName(product)
      },
      date: formatDateOnly(metricDate),
      adsDate: adsDate ? formatDateOnly(adsDate) : formatDateOnly(metricDate),
      isPreviousAdsDate: Boolean(adsDate && formatDateOnly(adsDate) !== formatDateOnly(metricDate)),
      spendUsd: round2(sum(selectedMetrics, (metric) => numberFrom(metric.spendUsd))),
      activeAdCount: ads.active.length,
      inactiveAdCount: ads.inactive.length,
      ads,
      logs: logs.map((log) => ({
        id: log.id,
        actionDate: formatDateOnly(log.actionDate),
        text: log.text,
        createdAt: log.createdAt.toISOString()
      }))
    };
  }

  async createProductLog(productId: string, body: Record<string, unknown>) {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) {
      throw new NotFoundException({ code: "PRODUCT_NOT_FOUND", message: "productId에 해당하는 제품을 찾을 수 없습니다." });
    }
    return this.prisma.productChangeLog.create({
      data: {
        productId,
        actionDate:
          body.actionDate === undefined || body.actionDate === null || String(body.actionDate).trim() === ""
            ? asDateOnly(todayInputValue())
            : parseSingleDate(String(body.actionDate), "actionDate"),
        text: requiredString(body.text, "text")
      }
    });
  }

  private async findPreviousProductMetricDate(productId: string, metricDate: Date) {
    const previousMetric = await this.prisma.metaAdDailyMetric.findFirst({
      where: {
        productId,
        metricDate: { lt: metricDate },
        isCurrent: true
      },
      select: { metricDate: true },
      orderBy: [{ metricDate: "desc" }]
    });
    return previousMetric?.metricDate ?? null;
  }
}

function parseSingleDate(value: string | undefined, field: string) {
  if (!value || value.trim() === "") {
    return asDateOnly(todayInputValue());
  }
  const text = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new BadRequestException({ code: "INVALID_DATE", message: `${field} 값은 YYYY-MM-DD 형식이어야 합니다.` });
  }
  return asDateOnly(text);
}

function todayInputValue() {
  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  return today.toISOString().slice(0, 10);
}

function displayProductName(product: { name: string; displayName: string }) {
  return product.displayName || product.name;
}

function groupProductAds(metrics: ProductAdMetricRow[]) {
  const groups = new Map<
    string,
    {
      id: string;
      creativeName: string;
      campaignName: string;
      spendUsd: number;
      statuses: Array<string | null>;
    }
  >();

  for (const metric of metrics) {
    const id = metric.metaAdRefId;
    const current = groups.get(id);
    const spendUsd = numberFrom(metric.spendUsd);
    if (!current) {
      groups.set(id, {
        id,
        creativeName: metric.creative?.displayName ?? metric.adNameSnapshot,
        campaignName: metric.campaignNameSnapshot,
        spendUsd,
        statuses: [metric.adDeliveryStatus]
      });
      continue;
    }
    current.spendUsd += spendUsd;
    current.statuses.push(metric.adDeliveryStatus);
  }

  const ads = Array.from(groups.values())
    .map((ad) => ({
      id: ad.id,
      creativeName: ad.creativeName,
      campaignName: ad.campaignName,
      spendUsd: round2(ad.spendUsd),
      active: ad.statuses.some((status) => isActiveStatus(status))
    }))
    .sort((a, b) => b.spendUsd - a.spendUsd || a.creativeName.localeCompare(b.creativeName, "ko"));

  return {
    active: ads.filter((ad) => ad.active).map(({ active, ...ad }) => ad),
    inactive: ads.filter((ad) => !ad.active).map(({ active, ...ad }) => ad)
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException({ code: "FIELD_REQUIRED", message: `${field} 값이 필요합니다.` });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  return String(value).trim();
}

function optionalStringArray(value: unknown): string[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((item) => String(item)));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.startsWith("[")) {
      try {
        return optionalStringArray(JSON.parse(trimmed));
      } catch {
        return [trimmed];
      }
    }
    return [trimmed];
  }
  return [];
}

function requiredEnum(value: unknown, allowed: Set<string>, field: string) {
  const text = requiredString(value, field).toUpperCase();
  if (!allowed.has(text)) {
    throw new BadRequestException({ code: "INVALID_ENUM", message: `${field} 값이 올바르지 않습니다.` });
  }
  return text;
}

function parseStageOrNull(value: unknown): AdStage | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const text = String(value).toUpperCase();
  if (text in AdStage) {
    return AdStage[text as keyof typeof AdStage];
  }
  throw new BadRequestException({ code: "INVALID_STAGE", message: "stage 값이 올바르지 않습니다." });
}

function optionalDateRange(from?: string, to?: string) {
  if (!from && !to) {
    return null;
  }
  return parseDateRange(from, to);
}

function visibleCreativeWhere(range: DateRange | null, creativeId?: string): Prisma.CreativeWhereInput {
  return {
    ...(creativeId ? { id: creativeId } : {}),
    isActive: true,
    adDailyMetrics: {
      some: currentMetricWhere(range)
    }
  };
}

function currentMetricWhere(range: DateRange | null): Prisma.MetaAdDailyMetricWhereInput {
  return {
    isCurrent: true,
    ...(range ? { metricDate: { gte: range.fromDate, lte: range.toDate } } : {})
  };
}

function filterAliasesByMetrics(aliases: AliasRow[], metrics: MetricRow[]) {
  const originalNames = new Set(metrics.map((metric) => metric.adNameSnapshot.trim()));
  return aliases.filter((alias) => originalNames.has(alias.originalName));
}

function filterPlacementsByMetrics(placements: PlacementRow[], metrics: MetricRow[]) {
  const placementKeys = new Set(metrics.map((metric) => metricOriginalPlacementKey(metric)));
  return placements.filter((placement) => placementKeys.has(originalPlacementKey(placement)));
}

function groupedPlacements(placements: PlacementRow[]) {
  const groups = new Map<
    string,
    {
      campaignName: string;
      metaCampaignId: string;
      adsetName: string;
      metaAdsetId: string;
      originalAdNames: string[];
      settings: string[];
      firstSeenOn: Date | null;
      lastSeenOn: Date | null;
      lastStatus: string | null;
    }
  >();

  for (const placement of placements) {
    const key = placementKey(placement);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        campaignName: placement.campaignName,
        metaCampaignId: placement.metaCampaignId,
        adsetName: placement.adsetName,
        metaAdsetId: placement.metaAdsetId,
        originalAdNames: [placement.originalAdName],
        settings: uniqueStrings([placement.setting]),
        firstSeenOn: placement.firstSeenOn,
        lastSeenOn: placement.lastSeenOn,
        lastStatus: placement.lastStatus
      });
      continue;
    }
    current.originalAdNames = uniqueStrings([...current.originalAdNames, placement.originalAdName]);
    current.settings = uniqueStrings([...current.settings, placement.setting]);
    current.firstSeenOn = minDate(current.firstSeenOn, placement.firstSeenOn);
    current.lastSeenOn = maxDate(current.lastSeenOn, placement.lastSeenOn);
    current.lastStatus = chooseDeliveryStatus([current.lastStatus, placement.lastStatus]);
    if (placement.lastSeenOn && current.lastSeenOn && placement.lastSeenOn >= current.lastSeenOn) {
      current.campaignName = placement.campaignName;
      current.adsetName = placement.adsetName;
    }
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    firstSeenOn: dateOrNull(group.firstSeenOn),
    lastSeenOn: dateOrNull(group.lastSeenOn)
  }));
}

function groupedDailyMetrics(metrics: MetricRow[]) {
  const groups = groupBy(metrics, (metric) => formatDateOnly(metric.metricDate));
  return Array.from(groups.entries())
    .map(([metricDate, rows]) => ({
      metricDate,
      spendUsd: round2(sum(rows, (row) => numberFrom(row.spendUsd))),
      purchaseCount: sum(rows, (row) => row.purchaseCount),
      impressions: sum(rows, (row) => numberFrom(row.impressions)),
      linkClicks: sum(rows, (row) => row.linkClicks),
      landingPageViews: sum(rows, (row) => row.landingPageViews),
      statuses: uniqueStrings(rows.map((row) => row.adDeliveryStatus))
    }))
    .sort((a, b) => b.metricDate.localeCompare(a.metricDate));
}

function aggregateLatestMetrics(metrics: MetricRow[]) {
  const latestDate = metrics.reduce<Date | null>((current, metric) => maxDate(current, metric.metricDate), null);
  const rows = latestDate ? metrics.filter((metric) => formatDateOnly(metric.metricDate) === formatDateOnly(latestDate)) : [];
  return {
    metricDate: dateOrNull(latestDate),
    spendUsd: round2(sum(rows, (row) => numberFrom(row.spendUsd))),
    purchaseCount: sum(rows, (row) => row.purchaseCount),
    impressions: sum(rows, (row) => numberFrom(row.impressions)),
    linkClicks: sum(rows, (row) => row.linkClicks),
    landingPageViews: sum(rows, (row) => row.landingPageViews),
    statuses: uniqueStrings(rows.map((row) => row.adDeliveryStatus))
  };
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? uniqueStrings(value.map((item) => String(item))) : [];
}

function placementKey(placement: Pick<PlacementRow, "metaCampaignId" | "metaAdsetId">) {
  return `${placement.metaCampaignId}:${placement.metaAdsetId}`;
}

function originalPlacementKey(placement: Pick<PlacementRow, "metaCampaignId" | "metaAdsetId" | "originalAdName">) {
  return `${placement.metaCampaignId}:${placement.metaAdsetId}:${placement.originalAdName}`;
}

function metricOriginalPlacementKey(metric: Pick<MetricRow, "metaCampaignId" | "metaAdsetId" | "adNameSnapshot">) {
  return `${metric.metaCampaignId}:${metric.metaAdsetId}:${metric.adNameSnapshot}`;
}

function isActiveStatus(status: string | null) {
  return status?.toLowerCase() === "active";
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

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function sum<T>(rows: T[], selector: (row: T) => number) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function minDate(current: Date | null, next: Date | null) {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return current < next ? current : next;
}

function maxDate(current: Date | null, next: Date | null) {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return current > next ? current : next;
}

function dateOrNull(value: Date | null) {
  return value ? formatDateOnly(value) : null;
}

function minMetricDate(metrics: MetricRow[]) {
  return metrics.reduce<Date | null>((current, metric) => minDate(current, metric.metricDate), null);
}

function maxMetricDate(metrics: MetricRow[]) {
  return metrics.reduce<Date | null>((current, metric) => maxDate(current, metric.metricDate), null);
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
