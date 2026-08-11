import { BadRequestException, Injectable } from "@nestjs/common";
import { AdStage, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { dateRangeDays, parseDateRange } from "../common/date-range";
import { formatDateOnly, toDateOnly } from "../domain/date-number";
import { CreativeNameParser } from "../domain/creative-name-parser";
import { PeriodMetricCalculator } from "../domain/period-metric-calculator";
import { adDeliveryStatusWhere, isUuid, parseDeliveryStatusFilter } from "./metric-filters";
import {
  aggregateAdDailyRows,
  aggregateCreativeDailyRows,
  firstNonNull,
  groupBy,
  singleUniqueNonEmpty,
  summarizeDeliveryStatus,
  summarizeParseStatus,
  uniqueNonEmpty
} from "./meta-ad-metric-aggregates";
import {
  AdDailyMetricRow,
  AdMetricQuery,
  CampaignMetricQuery,
  CostRule,
  CreativeFinancialContext,
  CreativeMetricQuery,
  ExchangeRateRow
} from "./metric-types";

@Injectable()
export class MetaAdMetricsReadService {
  private readonly periodCalculator = new PeriodMetricCalculator();
  private readonly creativeNameParser = new CreativeNameParser();

  constructor(private readonly prisma: PrismaService) {}

  async campaignMetrics(query: CampaignMetricQuery) {
    const metrics = await this.currentAdMetrics(query);
    const groups = groupBy(metrics, (row) => row.metaCampaignId);
    return Array.from(groups.entries()).map(([metaCampaignId, rows]) => {
      const aggregate = aggregateAdDailyRows(this.periodCalculator, rows);
      const last = rows[rows.length - 1];
      return {
        metaCampaignId,
        campaignName: last.campaignNameSnapshot,
        adsetCount: new Set(rows.map((row) => row.metaAdsetId)).size,
        adCount: new Set(rows.map((row) => `${row.metaAdsetId}:${row.adIdentityKey}`)).size,
        deliveryStatus: summarizeDeliveryStatus(rows.map((row) => row.adDeliveryStatus)),
        stage: last.stage,
        totals: aggregate.totals,
        dataDays: aggregate.dataDays
      };
    });
  }

  async adMetrics(query: AdMetricQuery) {
    const metrics = await this.currentAdMetrics(query);
    const groups = groupBy(metrics, (row) => `${row.metaCampaignId}:${row.metaAdsetId}:${row.adIdentityKey}`);
    return Array.from(groups.entries()).map(([, rows]) => {
      const aggregate = aggregateAdDailyRows(this.periodCalculator, rows);
      const first = rows[0];
      const last = rows[rows.length - 1];
      return {
        metaAdRefId: last.metaAdRefId,
        metaCampaignId: last.metaCampaignId,
        campaignName: last.campaignNameSnapshot,
        metaAdsetId: last.metaAdsetId,
        metaAdsetRefId: last.metaAdsetRefId,
        adsetName: last.adsetNameSnapshot,
        metaAdId: last.metaAdId,
        syntheticAdKey: last.syntheticAdKey,
        adIdentityKey: last.adIdentityKey,
        adName: last.adNameSnapshot,
        productId: last.productId,
        stage: last.stage,
        deliveryStatus: summarizeDeliveryStatus(rows.map((row) => row.adDeliveryStatus)),
        totals: aggregate.totals,
        dataDays: aggregate.dataDays,
        firstSeenOn: formatDateOnly(first.metricDate),
        lastSeenOn: formatDateOnly(last.metricDate)
      };
    });
  }

  async creativeMetrics(query: CreativeMetricQuery) {
    const metrics = await this.currentAdMetrics(query);
    const financialContext = await this.creativeFinancialContext(metrics);
    const parsedMetrics = metrics.map((row) => ({
      row,
      parsedName: this.creativeNameParser.parse(row.adNameSnapshot)
    }));
    const groups = groupBy(parsedMetrics, (item) => item.parsedName.creativeKey);
    const lifetimesByCreativeKey = await this.creativeLifetimes(Array.from(groups.keys()));
    const normalizedQuery = query.q?.trim().toLowerCase() ?? "";

    return Array.from(groups.entries())
      .map(([creativeKey, items]) => {
        const rows = items.map((item) => item.row);
        const aggregate = aggregateCreativeDailyRows(this.periodCalculator, rows, financialContext);
        const first = rows[0];
        const last = rows[rows.length - 1];
        const lastParsedName = items[items.length - 1].parsedName;
        const dateCodes = uniqueNonEmpty(items.map((item) => item.parsedName.dateCode)).sort();
        const settings = uniqueNonEmpty(items.map((item) => item.parsedName.setting));
        const originalAdNames = uniqueNonEmpty(rows.map((row) => row.adNameSnapshot));
        const lifetime = lifetimesByCreativeKey.get(creativeKey);
        const firstSeenOn = lifetime?.firstSeenOn ?? first.metricDate;
        const lastSeenOn = lifetime?.lastSeenOn ?? last.metricDate;

        return {
          creativeId: firstNonNull(rows.map((row) => row.creativeId)),
          creativeIds: uniqueNonEmpty(rows.map((row) => row.creativeId)),
          creativeKey,
          displayName: lastParsedName.displayName,
          productName: lastParsedName.productName,
          productId: singleUniqueNonEmpty(rows.map((row) => row.productId)),
          materialNo: lastParsedName.materialNo,
          dateCodes,
          settings,
          parseStatus: summarizeParseStatus(items.map((item) => item.parsedName.parseStatus)),
          originalAdNames,
          campaignCount: new Set(rows.map((row) => row.metaCampaignId)).size,
          adsetCount: new Set(rows.map((row) => `${row.metaCampaignId}:${row.metaAdsetId}`)).size,
          adCount: new Set(rows.map((row) => `${row.metaCampaignId}:${row.metaAdsetId}:${row.adIdentityKey}`)).size,
          deliveryStatus: summarizeDeliveryStatus(rows.map((row) => row.adDeliveryStatus)),
          totals: aggregate.totals,
          dataDays: dateRangeDays(formatDateOnly(firstSeenOn), formatDateOnly(lastSeenOn)) || aggregate.dataDays,
          firstSeenOn: formatDateOnly(firstSeenOn),
          lastSeenOn: formatDateOnly(lastSeenOn)
        };
      })
      .filter((row) => {
        if (!normalizedQuery) {
          return true;
        }
        return [
          row.creativeKey,
          row.displayName,
          row.productName,
          row.materialNo,
          ...row.dateCodes,
          ...row.originalAdNames
        ]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .sort((a, b) => b.totals.spendUsd - a.totals.spendUsd);
  }

  async compareAdsByName(adName: string | undefined, from?: string, to?: string, deliveryStatus?: string) {
    if (!adName?.trim()) {
      throw new BadRequestException({ code: "AD_NAME_REQUIRED", message: "adName 값이 필요합니다." });
    }
    return this.adMetrics({ from, to, deliveryStatus }).then((rows) =>
      rows.filter((row) => row.adName === adName.trim()).sort((a, b) => b.totals.spendUsd - a.totals.spendUsd)
    );
  }

  async adsForAdset(metaAdsetId: string, from?: string, to?: string, deliveryStatusInput?: string) {
    const range = parseDateRange(from, to);
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const metrics = await this.prisma.metaAdDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: range.fromDate, lte: range.toDate },
        ...adDeliveryStatusWhere(deliveryStatus),
        ...(isUuid(metaAdsetId) ? { OR: [{ metaAdsetRefId: metaAdsetId }, { metaAdsetId }] } : { metaAdsetId })
      },
      orderBy: [{ metricDate: "asc" }, { adNameSnapshot: "asc" }]
    });
    const groups = groupBy(metrics, (row) => `${row.metaCampaignId}:${row.metaAdsetId}:${row.adIdentityKey}`);
    return Array.from(groups.values()).map((rows) => {
      const aggregate = aggregateAdDailyRows(this.periodCalculator, rows);
      const last = rows[rows.length - 1];
      return {
        metaAdRefId: last.metaAdRefId,
        metaAdId: last.metaAdId,
        syntheticAdKey: last.syntheticAdKey,
        adIdentityKey: last.adIdentityKey,
        adName: last.adNameSnapshot,
        deliveryStatus: summarizeDeliveryStatus(rows.map((row) => row.adDeliveryStatus)),
        totals: aggregate.totals,
        dataDays: aggregate.dataDays
      };
    });
  }

  async adsetsForCampaign(metaCampaignId: string, from?: string, to?: string, deliveryStatusInput?: string) {
    const range = parseDateRange(from, to);
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const metrics = await this.prisma.metaAdDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: range.fromDate, lte: range.toDate },
        ...adDeliveryStatusWhere(deliveryStatus),
        ...(isUuid(metaCampaignId) ? { OR: [{ campaignRefId: metaCampaignId }, { metaCampaignId }] } : { metaCampaignId })
      },
      orderBy: [{ metricDate: "asc" }, { adsetNameSnapshot: "asc" }]
    });
    const groups = groupBy(metrics, (row) => `${row.metaCampaignId}:${row.metaAdsetId}`);
    return Array.from(groups.values()).map((rows) => {
      const aggregate = aggregateAdDailyRows(this.periodCalculator, rows);
      const last = rows[rows.length - 1];
      return {
        metaAdsetRefId: last.metaAdsetRefId,
        metaAdsetId: last.metaAdsetId,
        adsetName: last.adsetNameSnapshot,
        adCount: new Set(rows.map((row) => row.adIdentityKey)).size,
        deliveryStatus: summarizeDeliveryStatus(rows.map((row) => row.adDeliveryStatus)),
        totals: aggregate.totals,
        dataDays: aggregate.dataDays
      };
    });
  }

  async currentAdMetrics(query: AdMetricQuery) {
    const range = parseDateRange(query.from, query.to);
    const deliveryStatus = parseDeliveryStatusFilter(query.deliveryStatus);
    const and: Prisma.MetaAdDailyMetricWhereInput[] = [];
    if (query.campaignId) {
      and.push(
        isUuid(query.campaignId)
          ? { OR: [{ campaignRefId: query.campaignId }, { metaCampaignId: query.campaignId }] }
          : { metaCampaignId: query.campaignId }
      );
    }
    if (query.adsetId) {
      and.push(
        isUuid(query.adsetId)
          ? { OR: [{ metaAdsetRefId: query.adsetId }, { metaAdsetId: query.adsetId }] }
          : { metaAdsetId: query.adsetId }
      );
    }
    return this.prisma.metaAdDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: range.fromDate, lte: range.toDate },
        ...adDeliveryStatusWhere(deliveryStatus),
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.stage ? { stage: query.stage as AdStage } : {}),
        ...(and.length > 0 ? { AND: and } : {})
      },
      orderBy: [{ metricDate: "asc" }, { campaignNameSnapshot: "asc" }, { adsetNameSnapshot: "asc" }, { adNameSnapshot: "asc" }]
    });
  }

  async creativeLifetimes(creativeKeys: string[]) {
    if (creativeKeys.length === 0) {
      return new Map<string, { firstSeenOn: Date | null; lastSeenOn: Date | null }>();
    }

    const creatives = await this.prisma.creative.findMany({
      where: { platform: "META", creativeKey: { in: creativeKeys } },
      select: { creativeKey: true, firstSeenOn: true, lastSeenOn: true }
    });
    return new Map(creatives.map((creative) => [creative.creativeKey, creative]));
  }

  async creativeFinancialContext(metrics: AdDailyMetricRow[]): Promise<CreativeFinancialContext> {
    if (metrics.length === 0) {
      return { costRulesByProductId: new Map(), exchangeRateByDate: new Map() };
    }

    const productIds = Array.from(new Set(metrics.map((metric) => metric.productId).filter(Boolean))) as string[];
    const metricDates = Array.from(new Set(metrics.map((metric) => formatDateOnly(metric.metricDate))));
    const rateDates = metricDates.map((date) => toDateOnly(date)).filter((date): date is Date => Boolean(date));
    const costRulesPromise =
      productIds.length > 0
        ? this.prisma.productCostRule.findMany({
            where: { productId: { in: productIds } },
            orderBy: { effectiveFrom: "desc" }
          })
        : Promise.resolve([] as CostRule[]);
    const exchangeRatesPromise =
      rateDates.length > 0
        ? this.prisma.exchangeRate.findMany({
            where: {
              baseCurrency: "USD",
              quoteCurrency: "KRW",
              provider: "KOREA_EXIM",
              rateDate: { in: rateDates }
            }
          })
        : Promise.resolve([] as ExchangeRateRow[]);
    const [costRules, exchangeRates] = await Promise.all([costRulesPromise, exchangeRatesPromise]);

    return {
      costRulesByProductId: groupBy(costRules, (rule) => rule.productId),
      exchangeRateByDate: new Map(exchangeRates.map((rate) => [formatDateOnly(rate.rateDate), rate]))
    };
  }
}
