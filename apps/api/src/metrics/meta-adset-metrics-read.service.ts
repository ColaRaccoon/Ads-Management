import { Injectable } from "@nestjs/common";
import { AdStage, DecisionType, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { parseDateRange } from "../common/date-range";
import { formatDateOnly } from "../domain/date-number";
import { deliveryStatusWhere, isUuid, parseDeliveryStatusFilter } from "./metric-filters";
import { groupBy, divideOrNull } from "./meta-ad-metric-aggregates";
import { summarizeRuleStatus } from "./meta-adset-metric-aggregates";
import { MetaAdsetMetricDecorationService } from "./meta-adset-metric-decoration.service";
import { AdsetMetricQuery } from "./metric-types";

@Injectable()
export class MetaAdsetMetricsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly decorationService: MetaAdsetMetricDecorationService
  ) {}

  async productMetrics(from?: string, to?: string, deliveryStatusInput?: string) {
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    const range = parseDateRange(from, to);
    const decorated = (await this.decorationService.decoratedMetrics(range.fromDate, range.toDate, deliveryStatus)).filter(
      (row) => row.metric.productId
    );
    const groups = groupBy(decorated, (row) => row.metric.productId ?? "unmatched");

    return Array.from(groups.entries()).map(([productId, rows]) => {
      const aggregate = this.decorationService.aggregate(rows);
      const first = rows[0];
      const thresholds = first.thresholds;
      return {
        productId,
        product: first.metric.product,
        totals: aggregate.totals,
        averages: {
          dailySpendKrw: divideOrNull(aggregate.totals.spendKrw, aggregate.dataDays),
          dailyPurchaseCount: divideOrNull(aggregate.totals.purchaseCount, aggregate.dataDays),
          dailyMarginKrw: divideOrNull(aggregate.totals.marginKrw, aggregate.dataDays)
        },
        dataDays: aggregate.dataDays,
        thresholds,
        targetCpaKrw: thresholds?.targetCpaKrw ?? null,
        breakEvenCpaKrw: thresholds?.breakEvenCpaKrw ?? null,
        watchCpaKrw: thresholds?.watchCpaKrw ?? null,
        stopCpaKrw: thresholds?.stopCpaKrw ?? null,
        ruleStatus: summarizeRuleStatus(rows)
      };
    });
  }

  async adsetMetrics(query: AdsetMetricQuery) {
    const range = parseDateRange(query.from, query.to);
    const deliveryStatus = parseDeliveryStatusFilter(query.deliveryStatus);
    const where: Prisma.MetaAdsetDailyMetricWhereInput = {
      isCurrent: true,
      metricDate: { gte: range.fromDate, lte: range.toDate },
      ...deliveryStatusWhere(deliveryStatus),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.stage ? { stage: query.stage as AdStage } : {}),
      ...(query.campaignId
        ? {
            metaAdset: isUuid(query.campaignId)
              ? { campaignRefId: query.campaignId }
              : { campaign: { externalCampaignId: query.campaignId } }
          }
        : {})
    };
    const metrics = await this.prisma.metaAdsetDailyMetric.findMany({
      where,
      include: { product: true, metaAdset: true },
      orderBy: [{ metricDate: "asc" }, { adsetName: "asc" }]
    });
    const decorated = await this.decorationService.decorate(metrics);
    const groups = groupBy(decorated, (row) => row.metric.metaAdsetId);
    const rows = Array.from(groups.entries()).map(([metaAdsetId, items]) => {
      const aggregate = this.decorationService.aggregate(items);
      const first = items[0];
      const last = items[items.length - 1];
      return {
        metaAdsetId,
        adsetName: last.metric.adsetName,
        product: last.metric.product,
        stage: last.metric.stage,
        deliveryStatus: last.metric.deliveryStatus,
        totals: aggregate.totals,
        dataDays: aggregate.dataDays,
        thresholds: last.thresholds,
        ruleStatus: summarizeRuleStatus(items),
        cpaDeltaVsPreviousDay: null,
        firstSeenOn: first.metric.metaAdset.firstSeenOn ? formatDateOnly(first.metric.metaAdset.firstSeenOn) : null,
        lastSeenOn: last.metric.metaAdset.lastSeenOn ? formatDateOnly(last.metric.metaAdset.lastSeenOn) : null
      };
    });

    if (!query.decision) {
      return rows;
    }

    const decisionLogs = await this.prisma.decisionLog.findMany({
      where: {
        periodStart: range.fromDate,
        periodEnd: range.toDate,
        decision: query.decision as DecisionType,
        metaAdsetId: { in: rows.map((row) => row.metaAdsetId) }
      }
    });
    const allowed = new Set(decisionLogs.map((log) => log.metaAdsetId));
    return rows.filter((row) => allowed.has(row.metaAdsetId));
  }

  async unmatchedMetrics(from?: string, to?: string, deliveryStatusInput?: string) {
    const range = parseDateRange(from, to);
    const deliveryStatus = parseDeliveryStatusFilter(deliveryStatusInput);
    return this.prisma.metaAdsetDailyMetric.findMany({
      where: {
        isCurrent: true,
        metricDate: { gte: range.fromDate, lte: range.toDate },
        ...deliveryStatusWhere(deliveryStatus),
        productId: null
      },
      orderBy: [{ metricDate: "desc" }, { adsetName: "asc" }],
      include: { metaAdset: true }
    });
  }
}
